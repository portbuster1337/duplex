// End-to-end encryption of call media frames, as in the call pages of the SimpleX Chat apps: each
// encoded frame is encrypted with AES-256-GCM and a random 12-byte IV appended to it; the first bytes
// stay plain so that the browser can still see the frame type (VP8: 10 bytes of key frames, 3 of
// delta frames; Opus: the TOC byte).
const PLAIN_PREFIX: Record<string, number> = { key: 10, delta: 3, empty: 1 };
const IV_LENGTH = 12;

export type TransformOperation = 'encrypt' | 'decrypt';

interface EncodedFrame {
  type?: string;
  data: ArrayBuffer;
}

export function decodeKey(aesKey: string): Promise<CryptoKey> {
  const b64 = aesKey.replace(/-/g, '+').replace(/_/g, '/');
  const raw = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function concat(...bs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

export function frameTransform(operation: TransformOperation, key: CryptoKey): (frame: EncodedFrame, controller: TransformStreamDefaultController<EncodedFrame>) => Promise<void> {
  return async (frame, controller) => {
    const data = new Uint8Array(frame.data);
    const n = PLAIN_PREFIX[frame.type ?? ''] ?? 1;
    try {
      if (operation === 'encrypt') {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const plain = data.subarray(n);
        const ct = plain.length ? new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)) : new Uint8Array(0);
        frame.data = concat(data.subarray(0, n), ct, iv).buffer as ArrayBuffer;
      } else {
        const ct = data.subarray(n, data.length - IV_LENGTH);
        const iv = data.subarray(data.length - IV_LENGTH);
        const plain = ct.length ? new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)) : new Uint8Array(0);
        frame.data = concat(data.subarray(0, n), plain).buffer as ArrayBuffer;
      }
      controller.enqueue(frame);
    } catch {
      // a frame that cannot be decrypted is dropped
    }
  };
}

export async function pipeTransform(operation: TransformOperation, aesKey: string, readable: ReadableStream<EncodedFrame>, writable: WritableStream<EncodedFrame>): Promise<void> {
  const key = await decodeKey(aesKey);
  await readable.pipeThrough(new TransformStream({ transform: frameTransform(operation, key) })).pipeTo(writable);
}
