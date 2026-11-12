// Wisp v1 client (https://github.com/MercuryWorkshop/wisp-protocol): TCP streams multiplexed over one
// WebSocket. Browsers cannot open TCP connections, so the page asks a Wisp relay to connect to the
// server and passes bytes; TLS runs end-to-end inside the stream, so the relay only sees ciphertext.
import { concat, utf8, type Bytes } from '../util/bytes';
import { ChunkQueue, StreamClosedError, type Stream } from './stream';

const PKT_CONNECT = 1;
const PKT_DATA = 2;
const PKT_CONTINUE = 3;
const PKT_CLOSE = 4;

const CLOSE_REASONS: Record<number, string> = {
  1: 'unknown error',
  2: 'closed',
  3: 'network error',
  0x41: 'invalid connection info',
  0x42: 'host unreachable',
  0x43: 'connection timed out',
  0x44: 'connection refused',
  0x47: 'relay timed out waiting for data',
  0x48: 'destination blocked by the relay',
  0x49: 'connection throttled by the relay',
  0x81: 'client error',
};

function packet(type: number, streamId: number, payload: Bytes): Bytes {
  const p = new Uint8Array(5 + payload.length);
  p[0] = type;
  new DataView(p.buffer).setUint32(1, streamId, true);
  p.set(payload, 5);
  return p;
}

class WispStream implements Stream {
  readonly incoming = new ChunkQueue();
  buffer: number;
  private pending: Bytes[] = [];
  closed = false;
  closeReason: number | undefined;
  private opened: () => void = () => {};
  readonly ready: Promise<void>;
  private gotData = false;

  constructor(
    private conn: WispConnection,
    readonly id: number,
    initialBuffer: number,
  ) {
    this.buffer = initialBuffer;
    this.ready = new Promise((resolve) => (this.opened = resolve));
  }

  onData(b: Bytes): void {
    if (!this.gotData) {
      this.gotData = true;
      this.opened();
    }
    this.incoming.push(b);
  }

  onContinue(n: number): void {
    this.buffer = n;
    this.flush();
  }

  onClose(reason: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const err = reason === 2 ? undefined : new StreamClosedError(`relay closed the connection: ${CLOSE_REASONS[reason] ?? 'reason ' + reason}`);
    this.incoming.end(err);
    this.opened();
  }

  private flush(): void {
    while (this.pending.length && this.buffer > 0) {
      this.buffer--;
      this.conn.send(packet(PKT_DATA, this.id, this.pending.shift()!));
    }
  }

  read(): Promise<Bytes | null> {
    return this.incoming.read();
  }

  write(data: Bytes): void {
    if (this.closed) throw new StreamClosedError();
    // Wisp counts packets, so large writes are split to keep packets reasonably sized
    for (let off = 0; off < data.length; off += 65536) this.pending.push(data.slice(off, off + 65536));
    this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    this.conn.send(packet(PKT_CLOSE, this.id, Uint8Array.of(2)));
    this.conn.forget(this.id);
  }
}

export class WispConnection {
  private ws: WebSocket;
  private streams = new Map<number, WispStream>();
  private nextId = 1;
  private initialBuffer = 0;
  private openPromise: Promise<void>;
  private closedErr: Error | undefined;
  onClose: ((err?: Error) => void) | undefined;

  constructor(readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.onmessage = (ev) => {
        const b = new Uint8Array(ev.data as ArrayBuffer);
        if (b.length < 5) return;
        const type = b[0];
        const id = new DataView(b.buffer, b.byteOffset).getUint32(1, true);
        const payload = b.subarray(5);
        if (id === 0 && type === PKT_CONTINUE) {
          this.initialBuffer = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          resolve();
          return;
        }
        const s = this.streams.get(id);
        if (!s) return;
        if (type === PKT_DATA) s.onData(payload.slice());
        else if (type === PKT_CONTINUE && payload.length >= 4) s.onContinue(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true));
        else if (type === PKT_CLOSE) {
          s.onClose(payload[0] ?? 1);
          this.streams.delete(id);
        }
      };
      this.ws.onerror = () => {
        const e = new Error(`cannot connect to relay ${url}`);
        reject(e);
        this.shutdown(e);
      };
      this.ws.onclose = () => {
        const e = new Error(`relay ${url} disconnected`);
        reject(e);
        this.shutdown(e);
      };
    });
    this.openPromise.catch(() => {});
  }

  private shutdown(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    for (const s of this.streams.values()) s.onClose(3);
    this.streams.clear();
    this.onClose?.(err);
  }

  get isClosed(): boolean {
    return this.closedErr !== undefined;
  }

  ready(): Promise<void> {
    return this.openPromise;
  }

  send(p: Bytes): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(p);
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  /** opens a TCP stream to host:port through the relay */
  async connect(host: string, port: number): Promise<Stream> {
    await this.openPromise;
    if (this.closedErr) throw this.closedErr;
    const id = this.nextId++;
    const s = new WispStream(this, id, this.initialBuffer);
    this.streams.set(id, s);
    const payload = concat(Uint8Array.of(1, port & 0xff, port >> 8), utf8(host));
    this.send(packet(PKT_CONNECT, id, payload));
    return s;
  }

  close(): void {
    this.ws.close();
    this.shutdown(new Error('relay connection closed'));
  }
}
