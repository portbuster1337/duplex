// A small HTTP/2 client (RFC 9113) with HPACK (RFC 7541), for XFTP: file servers speak HTTP/2 with
// prior knowledge over TLS, and their self-signed certificates and session binding need the page's own
// TLS (tls13.ts). Requests and responses are buffered; no server push, priorities or trailers.
import { ascii, concat, type Bytes } from '../util/bytes';
import { BufferedReader, StreamClosedError, type Stream } from './stream';
import { HUFFMAN_CODES, STATIC_TABLE } from './hpack-tables';

export class Http2Error extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'Http2Error';
  }
}

// ---- HPACK

/** node n has children at [2n] and [2n+1]: 0 - none, > 0 - node, < 0 - symbol -(s + 1) */
let huffTree: Int32Array | undefined;

function huffmanTree(): Int32Array {
  if (huffTree) return huffTree;
  const tree = new Int32Array(2 * 300);
  let nodes = 1;
  HUFFMAN_CODES.split(',').forEach((entry, sym) => {
    const [hex, bits] = entry.split(':');
    const code = parseInt(hex, 16);
    let n = 0;
    for (let i = Number(bits) - 1; i >= 0; i--) {
      const slot = 2 * n + ((code >>> i) & 1);
      if (i === 0) tree[slot] = -(sym + 1);
      else {
        if (tree[slot] === 0) tree[slot] = nodes++;
        n = tree[slot];
      }
    }
  });
  return (huffTree = tree);
}

const latin1 = (b: Bytes): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

export function huffmanDecode(b: Bytes): string {
  const tree = huffmanTree();
  let out = '';
  let n = 0;
  let depth = 0;
  let ones = true;
  for (const byte of b) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      const next = tree[2 * n + bit];
      if (next < 0) {
        if (next === -257) throw new Http2Error('HPACK: EOS in a string');
        out += String.fromCharCode(-next - 1);
        n = 0;
        depth = 0;
        ones = true;
      } else if (next === 0) throw new Http2Error('HPACK: bad Huffman code');
      else {
        n = next;
        depth++;
        ones &&= bit === 1;
      }
    }
  }
  if (depth > 7 || !ones) throw new Http2Error('HPACK: bad Huffman padding');
  return out;
}

class HpackReader {
  pos = 0;
  constructor(readonly b: Bytes) {}
  int(prefix: number): number {
    if (this.pos >= this.b.length) throw new Http2Error('HPACK: truncated');
    const max = (1 << prefix) - 1;
    let v = this.b[this.pos++] & max;
    if (v < max) return v;
    for (let m = 0; ; m += 7) {
      if (this.pos >= this.b.length || m > 28) throw new Http2Error('HPACK: bad integer');
      const x = this.b[this.pos++];
      v += (x & 127) * 2 ** m;
      if (!(x & 128)) return v;
    }
  }
  str(): string {
    const huffman = this.pos < this.b.length && this.b[this.pos] & 0x80;
    const len = this.int(7);
    if (this.pos + len > this.b.length) throw new Http2Error('HPACK: truncated string');
    const s = this.b.subarray(this.pos, (this.pos += len));
    return huffman ? huffmanDecode(s) : latin1(s);
  }
}

export type Headers = Array<[string, string]>;

export class HpackDecoder {
  private table: Headers = [];
  private size = 0;
  constructor(
    private maxSize = 4096,
    private readonly limit = 4096,
  ) {}

  private entry(i: number): [string, string] {
    const e = i <= STATIC_TABLE.length ? STATIC_TABLE[i - 1] : this.table[i - STATIC_TABLE.length - 1];
    if (i === 0 || !e) throw new Http2Error('HPACK: bad index');
    return [e[0], e[1]];
  }

  private evict(): void {
    while (this.size > this.maxSize) {
      const [n, v] = this.table.pop()!;
      this.size -= n.length + v.length + 32;
    }
  }

  decode(block: Bytes): Headers {
    const r = new HpackReader(block);
    const out: Headers = [];
    while (r.pos < block.length) {
      const b = block[r.pos];
      if (b & 0x80) out.push(this.entry(r.int(7)));
      else if (b & 0x40) {
        const i = r.int(6);
        const h: [string, string] = [i ? this.entry(i)[0] : r.str(), r.str()];
        out.push(h);
        this.table.unshift(h);
        this.size += h[0].length + h[1].length + 32;
        this.evict();
      } else if (b & 0x20) {
        const s = r.int(5);
        if (s > this.limit) throw new Http2Error('HPACK: table size above the limit');
        this.maxSize = s;
        this.evict();
      } else {
        const i = r.int(4);
        out.push([i ? this.entry(i)[0] : r.str(), r.str()]);
      }
    }
    return out;
  }
}

function hpackInt(v: number, prefix: number, flags: number): number[] {
  const max = (1 << prefix) - 1;
  if (v < max) return [flags | v];
  const out = [flags | max];
  for (v -= max; v >= 128; v = Math.floor(v / 128)) out.push((v % 128) + 128);
  out.push(v);
  return out;
}

/** literal header fields without indexing and without Huffman coding */
export function hpackEncode(headers: Headers): Bytes {
  const out: number[] = [];
  for (const [n, v] of headers) {
    out.push(0);
    for (const s of [n, v]) {
      out.push(...hpackInt(s.length, 7, 0));
      for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ---- frames

const DATA = 0;
const HEADERS = 1;
const RST_STREAM = 3;
const SETTINGS = 4;
const PUSH_PROMISE = 5;
const PING = 6;
const GOAWAY = 7;
const WINDOW_UPDATE = 8;
const CONTINUATION = 9;

const END_STREAM = 1;
const ACK = 1;
const END_HEADERS = 4;
const PADDED = 8;
const PRIORITY = 0x20;

const SETTINGS_ENABLE_PUSH = 2;
const SETTINGS_INITIAL_WINDOW_SIZE = 4;
const SETTINGS_MAX_FRAME_SIZE = 5;

const PREFACE = ascii('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
const MAX_FRAME = 16384;
const STREAM_WINDOW = 4 << 20;
const CONN_WINDOW = 16 << 20;
/** received bytes are acknowledged with WINDOW_UPDATE in steps of this size */
const UPDATE_STEP = 1 << 20;

const u32 = (n: number): Bytes => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const readU32 = (b: Bytes, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function frame(type: number, flags: number, id: number, payload: Bytes = new Uint8Array(0)): Bytes {
  const f = new Uint8Array(9 + payload.length);
  f[0] = payload.length >>> 16;
  f[1] = (payload.length >>> 8) & 0xff;
  f[2] = payload.length & 0xff;
  f[3] = type;
  f[4] = flags;
  f.set(u32(id & 0x7fffffff), 5);
  f.set(payload, 9);
  return f;
}

/** strips the padding of DATA and HEADERS frames */
function unpadded(flags: number, p: Bytes): Bytes {
  if (!(flags & PADDED)) return p;
  if (!p.length || p[0] >= p.length) throw new Http2Error('bad frame padding');
  return p.subarray(1, p.length - p[0]);
}

export interface Http2Response {
  status: number;
  headers: Headers;
  body: Bytes;
}

interface PendingStream {
  id: number;
  status?: number;
  headers: Headers;
  body: Bytes[];
  bodyLength: number;
  maxBody: number;
  sent: number;
  sendWindow: number;
  unacked: number;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (sent: number, received: number) => void;
  cleanup?: () => void;
  resolve: (r: Http2Response) => void;
  reject: (e: Error) => void;
}

export interface RequestOptions {
  headers?: Headers;
  timeout?: number;
  /** the response body is refused above this size */
  maxBody?: number;
  /** cancels the request (the stream is reset) */
  signal?: AbortSignal;
  /** the request body bytes sent and the response body bytes received so far */
  onProgress?: (sent: number, received: number) => void;
}

const abortError = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Http2Error('the request was cancelled'));

export class Http2Connection {
  private reader: BufferedReader;
  private streams = new Map<number, PendingStream>();
  private nextId = 1;
  private connSendWindow = 65535;
  private peerInitialWindow = 65535;
  private peerMaxFrame = MAX_FRAME;
  private connUnacked = 0;
  private hpack = new HpackDecoder();
  private headerBlock: { id: number; parts: Bytes[]; endStream: boolean } | undefined;
  private windowWaiters: Array<() => void> = [];
  private closedErr: Error | undefined;
  private goingAway = false;
  onClose: ((err: Error) => void) | undefined;

  constructor(
    private transport: Stream,
    readonly authority: string,
  ) {
    this.reader = new BufferedReader(transport);
    const settings = concat(...[[SETTINGS_ENABLE_PUSH, 0], [SETTINGS_INITIAL_WINDOW_SIZE, STREAM_WINDOW]].map(([k, v]) => concat(Uint8Array.of(0, k), u32(v))));
    this.write(concat(PREFACE, frame(SETTINGS, 0, 0, settings), frame(WINDOW_UPDATE, 0, 0, u32(CONN_WINDOW - 65535))));
    void this.readLoop();
  }

  get isClosed(): boolean {
    return this.closedErr !== undefined || this.goingAway;
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  private write(b: Bytes): void {
    if (this.closedErr) throw this.closedErr;
    this.transport.write(b);
  }

  private wake(): void {
    for (const w of this.windowWaiters.splice(0)) w();
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const h = await this.reader.readExact(9);
        const len = (h[0] << 16) | (h[1] << 8) | h[2];
        const type = h[3];
        const flags = h[4];
        const id = readU32(h, 5) & 0x7fffffff;
        if (len > MAX_FRAME) throw new Http2Error('frame too large');
        const p = len ? (await this.reader.readExact(len)).slice() : new Uint8Array(0);
        this.onFrame(type, flags, id, p);
      }
    } catch (e) {
      this.shutdown(e instanceof StreamClosedError ? new Http2Error('connection closed') : (e as Error));
    }
  }

  private onFrame(type: number, flags: number, id: number, p: Bytes): void {
    if (this.headerBlock && type !== CONTINUATION) throw new Http2Error('expected CONTINUATION');
    switch (type) {
      case DATA: {
        this.connUnacked += p.length;
        if (this.connUnacked >= UPDATE_STEP) {
          this.write(frame(WINDOW_UPDATE, 0, 0, u32(this.connUnacked)));
          this.connUnacked = 0;
        }
        const s = this.streams.get(id);
        if (!s) return;
        const data = unpadded(flags, p);
        s.bodyLength += data.length;
        if (s.bodyLength > s.maxBody) return this.fail(s, new Http2Error('response too large'), true);
        if (data.length) {
          s.body.push(data);
          s.onProgress?.(s.sent, s.bodyLength);
        }
        if (flags & END_STREAM) return this.finish(s);
        s.unacked += p.length;
        if (s.unacked >= UPDATE_STEP) {
          this.write(frame(WINDOW_UPDATE, 0, id, u32(s.unacked)));
          s.unacked = 0;
        }
        return;
      }
      case HEADERS: {
        let b = unpadded(flags, p);
        if (flags & PRIORITY) b = b.subarray(5);
        this.headerBlock = { id, parts: [b], endStream: !!(flags & END_STREAM) };
        if (flags & END_HEADERS) this.endHeaders();
        return;
      }
      case CONTINUATION:
        if (!this.headerBlock || this.headerBlock.id !== id) throw new Http2Error('unexpected CONTINUATION');
        this.headerBlock.parts.push(p);
        if (flags & END_HEADERS) this.endHeaders();
        return;
      case RST_STREAM: {
        const s = this.streams.get(id);
        if (s) this.fail(s, new Http2Error(`the server reset the request (${p.length >= 4 ? readU32(p, 0) : '?'})`), false);
        return;
      }
      case SETTINGS:
        if (flags & ACK) return;
        for (let i = 0; i + 6 <= p.length; i += 6) {
          const k = (p[i] << 8) | p[i + 1];
          const v = readU32(p, i + 2);
          if (k === SETTINGS_INITIAL_WINDOW_SIZE) {
            for (const s of this.streams.values()) s.sendWindow += v - this.peerInitialWindow;
            this.peerInitialWindow = v;
          } else if (k === SETTINGS_MAX_FRAME_SIZE) this.peerMaxFrame = Math.max(MAX_FRAME, Math.min(v, 1 << 24));
        }
        this.write(frame(SETTINGS, ACK, 0));
        this.wake();
        return;
      case PING:
        if (!(flags & ACK)) this.write(frame(PING, ACK, 0, p));
        return;
      case GOAWAY: {
        const last = readU32(p, 0) & 0x7fffffff;
        this.goingAway = true;
        for (const s of [...this.streams.values()]) if (s.id > last) this.fail(s, new Http2Error('the server is closing the connection'), false);
        if (!this.streams.size) this.shutdown(new Http2Error('the server closed the connection'));
        return;
      }
      case WINDOW_UPDATE: {
        const inc = readU32(p, 0) & 0x7fffffff;
        if (id === 0) this.connSendWindow += inc;
        else {
          const s = this.streams.get(id);
          if (s) s.sendWindow += inc;
        }
        this.wake();
        return;
      }
      case PUSH_PROMISE:
        throw new Http2Error('unexpected server push');
    }
  }

  private endHeaders(): void {
    const { id, parts, endStream } = this.headerBlock!;
    this.headerBlock = undefined;
    // decoded even for unknown streams, to keep the HPACK table in sync
    const headers = this.hpack.decode(parts.length === 1 ? parts[0] : concat(...parts));
    const s = this.streams.get(id);
    if (!s) return;
    if (s.status === undefined) {
      const status = Number(headers.find(([k]) => k === ':status')?.[1]);
      if (!(status >= 100 && status < 200)) {
        s.status = status;
        s.headers = headers;
      }
    }
    if (endStream) this.finish(s);
  }

  private finish(s: PendingStream): void {
    this.streams.delete(s.id);
    clearTimeout(s.timer);
    s.cleanup?.();
    if (s.status === undefined || Number.isNaN(s.status)) s.reject(new Http2Error('response without status'));
    else s.resolve({ status: s.status, headers: s.headers, body: s.body.length === 1 ? s.body[0] : concat(...s.body) });
    this.afterStream();
  }

  private fail(s: PendingStream, e: Error, reset: boolean): void {
    if (!this.streams.delete(s.id)) return;
    clearTimeout(s.timer);
    s.cleanup?.();
    if (reset && !this.closedErr) this.write(frame(RST_STREAM, 0, s.id, u32(8)));
    s.reject(e);
    this.wake();
    this.afterStream();
  }

  private afterStream(): void {
    if (this.goingAway && !this.streams.size) this.shutdown(new Http2Error('the server closed the connection'));
  }

  private shutdown(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    for (const s of this.streams.values()) {
      clearTimeout(s.timer);
      s.cleanup?.();
      s.reject(err);
    }
    this.streams.clear();
    this.wake();
    this.transport.close();
    this.onClose?.(err);
  }

  close(): void {
    if (!this.closedErr) {
      try {
        this.write(frame(GOAWAY, 0, 0, concat(u32(0), u32(0))));
      } catch {
        // already closed
      }
    }
    this.shutdown(new Http2Error('connection closed'));
  }

  /** a POST request */
  request(path: string, body: Bytes | undefined, opts: RequestOptions = {}): Promise<Http2Response> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    if (this.goingAway) return Promise.reject(new Http2Error('the connection is closing'));
    if (opts.signal?.aborted) return Promise.reject(abortError(opts.signal));
    const id = this.nextId;
    this.nextId += 2;
    return new Promise<Http2Response>((resolve, reject) => {
      const s: PendingStream = {
        id,
        headers: [],
        body: [],
        bodyLength: 0,
        maxBody: opts.maxBody ?? 8 << 20,
        sent: 0,
        sendWindow: this.peerInitialWindow,
        unacked: 0,
        timer: setTimeout(() => this.fail(s, new Http2Error('the request timed out'), true), opts.timeout ?? 60000),
        onProgress: opts.onProgress,
        resolve,
        reject,
      };
      this.streams.set(id, s);
      const signal = opts.signal;
      if (signal) {
        const onAbort = () => this.fail(s, abortError(signal), true);
        signal.addEventListener('abort', onAbort, { once: true });
        s.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      const headers: Headers = [
        [':method', 'POST'],
        [':scheme', 'https'],
        [':authority', this.authority],
        [':path', path],
        ...(body?.length ? ([['content-length', String(body.length)]] as Headers) : []),
        ...(opts.headers ?? []),
      ];
      try {
        this.write(frame(HEADERS, END_HEADERS | (body?.length ? 0 : END_STREAM), id, hpackEncode(headers)));
      } catch (e) {
        this.fail(s, e as Error, false);
        return;
      }
      if (body?.length) this.sendBody(s, body).catch((e) => this.fail(s, e as Error, true));
    });
  }

  private async sendBody(s: PendingStream, body: Bytes): Promise<void> {
    for (let off = 0; off < body.length; ) {
      if (this.closedErr) throw this.closedErr;
      if (!this.streams.has(s.id)) return;
      const n = Math.min(body.length - off, this.peerMaxFrame, this.connSendWindow, s.sendWindow);
      if (n <= 0) {
        await new Promise<void>((r) => this.windowWaiters.push(r));
        continue;
      }
      this.write(frame(DATA, off + n === body.length ? END_STREAM : 0, s.id, body.subarray(off, off + n)));
      off += n;
      this.connSendWindow -= n;
      s.sendWindow -= n;
      s.sent = off;
      s.onProgress?.(s.sent, s.bodyLength);
    }
  }
}
