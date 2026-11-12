// Byte stream abstraction used by the transports (Wisp tunnel, TCP in tests, TLS on top of either).
import { concat, type Bytes } from '../util/bytes';

export interface Stream {
  /** next chunk of data, or null at end of stream */
  read(): Promise<Bytes | null>;
  write(data: Bytes): void;
  close(): void;
}

export class StreamClosedError extends Error {
  constructor(msg = 'connection closed') {
    super(msg);
    this.name = 'StreamClosedError';
  }
}

/** A queue of incoming chunks with a single async reader. */
export class ChunkQueue {
  private chunks: Bytes[] = [];
  private waiters: Array<{ resolve: (b: Bytes | null) => void; reject: (e: Error) => void }> = [];
  private ended = false;
  private error: Error | undefined;

  push(b: Bytes): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w.resolve(b);
    else this.chunks.push(b);
  }

  end(err?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = err;
    for (const w of this.waiters.splice(0)) err ? w.reject(err) : w.resolve(null);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  read(): Promise<Bytes | null> {
    const c = this.chunks.shift();
    if (c) return Promise.resolve(c);
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve(null);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/** Reads exact byte counts from a stream. */
export class BufferedReader {
  private buf: Bytes = new Uint8Array(0);
  constructor(private s: { read(): Promise<Bytes | null> }) {}

  async readExact(n: number): Promise<Bytes> {
    while (this.buf.length < n) {
      const c = await this.s.read();
      if (c === null) throw new StreamClosedError();
      this.buf = this.buf.length ? concat(this.buf, c) : c;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

export function timeout<T>(p: Promise<T>, ms: number, msg = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
