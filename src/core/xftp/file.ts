// File encryption and transfer (Simplex.FileTransfer.Crypto and Agent). A file is encrypted as one
// secret-box stream: its length (Int64), a header with its name, the content and '#' padding up to the
// sum of the chunk sizes, then the tag. The encrypted file is cut into chunks; each chunk is stored on
// a file server with a sender key (to upload and delete it) and a recipient key (to download it), and
// it is encrypted again for the transfer with a key agreed for each download.
import { sha512 } from '@noble/hashes/sha2.js';
import { concat, equal, fromUtf8Lossy, randomBytes, utf8, type Bytes } from '../util/bytes';
import { Decoder, Encoder } from '../util/encoding';
import { dh, generateKeyPair, sha256 } from '../crypto/crypto';
import { SbState } from '../crypto/sbstream';
import type { ProtocolServer } from '../smp/server';
import { isAbort, type XFTPPool } from './client';
import type { FileChunk, FileDescription } from './description';
import { AUTH_TAG_LEN, FILE_SIZE_LEN, prepareChunkSizes, XFTPError } from './protocol';

export interface FileSource {
  size: number;
  read(offset: number, length: number): Promise<Bytes>;
}

export function blobSource(b: Blob): FileSource {
  return { size: b.size, read: async (o, l) => new Uint8Array(await b.slice(o, o + l).arrayBuffer()) };
}

export function bytesSource(b: Bytes): FileSource {
  return { size: b.length, read: async (o, l) => b.subarray(o, o + l) };
}

export interface TransferOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** a file name that fits the header (a string of up to 255 bytes), keeping the extension */
export function fitFileName(name: string): string {
  const n = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim() || 'file';
  if (utf8(n).length <= 255) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
  let base = [...n.slice(0, n.length - ext.length)];
  while (utf8(base.join('') + ext).length > 255) base = base.slice(0, -1);
  return base.join('') + ext;
}

export function encodeFileHeader(name: string): Bytes {
  return new Encoder()
    .text(fitFileName(name))
    .maybe(undefined, (e, x: string) => e.text(x))
    .finish();
}

/** resolves after ms, or rejects when the signal aborts */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** errors after which uploading the chunk again (as a new chunk) may work */
function uploadRetriable(e: unknown): boolean {
  if (isAbort(e)) return false;
  return !(e instanceof XFTPError) || ['SESSION', 'HANDSHAKE', 'TIMEOUT', 'HTTP', 'FILE_IO', 'INTERNAL', 'BLOCK'].includes(e.code);
}

export interface UploadedFile {
  /** for the recipient */
  rcv: FileDescription;
  /** for the sender, to delete the file from the servers */
  snd: FileDescription;
  /** when the server deletes the file, in seconds since the epoch (XFTP v4) */
  expiresAt?: number;
}

/**
 * encrypts and uploads a file, one chunk after another; all chunks are stored on one server. When it
 * fails or is cancelled, the chunks uploaded so far are deleted from the server.
 */
export async function uploadFile(pool: XFTPPool, server: ProtocolServer, src: FileSource, name: string, opts: TransferOptions & { basicAuth?: string } = {}): Promise<UploadedFile> {
  const { signal } = opts;
  const hdr = encodeFileHeader(name);
  const fileSize = hdr.length + src.size;
  const chunkSizes = prepareChunkSizes(fileSize + FILE_SIZE_LEN + AUTH_TAG_LEN);
  const encSize = chunkSizes.reduce((a, b) => a + b, 0);
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const sb = new SbState(key, nonce);
  const fileDigest = sha512.create();
  const prefix = concat(new Encoder().int64(fileSize).finish(), hdr);
  let pos = 0;
  const readPlain = async (n: number): Promise<Bytes> => {
    const out = new Uint8Array(n);
    for (let o = 0; o < n; ) {
      if (pos < prefix.length) {
        const k = Math.min(n - o, prefix.length - pos);
        out.set(prefix.subarray(pos, pos + k), o);
        o += k;
        pos += k;
      } else if (pos < prefix.length + src.size) {
        const off = pos - prefix.length;
        const k = Math.min(n - o, src.size - off);
        const b = await src.read(off, k);
        if (b.length !== k) throw new Error('the file changed while it was sent');
        out.set(b, o);
        o += k;
        pos += k;
      } else {
        out.fill(0x23, o);
        pos += n - o;
        o = n;
      }
    }
    return out;
  };
  const rcvChunks: FileChunk[] = [];
  const sndChunks: FileChunk[] = [];
  let expiresAt: number | undefined;
  let done = 0;
  opts.onProgress?.(0, encSize);
  try {
    for (let i = 0; i < chunkSizes.length; i++) {
      signal?.throwIfAborted();
      const chunkSize = chunkSizes[i];
      const enc = i === chunkSizes.length - 1 ? concat(sb.encrypt(await readPlain(chunkSize - AUTH_TAG_LEN)), sb.tag()) : sb.encrypt(await readPlain(chunkSize));
      fileDigest.update(enc);
      const digest = sha256(enc);
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        const snd = generateKeyPair('ed25519');
        const rcv = generateKeyPair('ed25519');
        let sndId: Bytes | undefined;
        try {
          const { resp } = await pool.with(server, (c) => c.command(snd.priv, new Uint8Array(0), { tag: 'FNEW', sndKey: snd.pub, size: chunkSize, digest, rcvKeys: [rcv.pub], basicAuth: opts.basicAuth }, undefined, { signal }));
          if (resp.tag !== 'SIDS') throw new XFTPError('RESPONSE', resp.tag);
          sndId = resp.sndId;
          if (resp.expiresAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, resp.expiresAt);
          // not sent again on a new connection: a failed upload is repeated as a new chunk
          await pool.with(server, (c) => c.command(snd.priv, resp.sndId, { tag: 'FPUT' }, enc, { signal, onProgress: (b) => opts.onProgress?.(done + Math.min(b, chunkSize), encSize) }), { retry: false });
          const chunkNo = i + 1;
          rcvChunks.push({ chunkNo, chunkSize, digest, replicas: [{ server, replicaId: resp.rcvIds[0], replicaKey: rcv.priv }] });
          sndChunks.push({ chunkNo, chunkSize, digest, replicas: [{ server, replicaId: resp.sndId, replicaKey: snd.priv }] });
          break;
        } catch (e) {
          if (sndId) {
            const id = sndId;
            void pool.with(server, (c) => c.command(snd.priv, id, { tag: 'FDEL' })).catch(() => {});
          }
          if (attempt >= 3 || !uploadRetriable(e)) throw e;
          await sleep(2000 * attempt, signal);
        }
      }
      done += chunkSize;
      opts.onProgress?.(done, encSize);
    }
  } catch (e) {
    // the chunks would only expire otherwise
    if (sndChunks.length) void deleteUploadedFile(pool, { party: 'sender', size: 0, digest: new Uint8Array(0), key, nonce, chunkSize: chunkSizes[0], chunks: sndChunks }).catch(() => {});
    throw e;
  }
  const common = { size: encSize, digest: fileDigest.digest(), key, nonce, chunkSize: chunkSizes[0] };
  return { rcv: { party: 'recipient', ...common, chunks: rcvChunks }, snd: { party: 'sender', ...common, chunks: sndChunks }, expiresAt };
}

/** downloads a chunk from one of its replicas, removing the transfer encryption and checking its digest */
async function fetchChunk(pool: XFTPPool, ch: FileChunk, signal: AbortSignal | undefined, onProgress: (bytes: number) => void): Promise<Bytes> {
  let err: unknown = new XFTPError('NO_FILE', 'the chunk has no replicas');
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const r of ch.replicas) {
      signal?.throwIfAborted();
      try {
        return await pool.with(r.server, async (c) => {
          const k = generateKeyPair('x25519');
          const { resp, body } = await c.command(r.replicaKey, r.replicaId, { tag: 'FGET', dhKey: k.pub }, undefined, { expectBody: ch.chunkSize + AUTH_TAG_LEN, signal, onProgress });
          if (resp.tag !== 'FILE') throw new XFTPError('RESPONSE', resp.tag);
          if (body.length !== ch.chunkSize + AUTH_TAG_LEN) throw new XFTPError('SIZE', 'the chunk has a different size');
          const s = new SbState(dh(resp.dhKey, k.priv), resp.nonce);
          const plain = s.decrypt(body.subarray(0, ch.chunkSize));
          if (!s.verify(body.subarray(ch.chunkSize))) throw new XFTPError('CRYPTO', 'chunk authentication failed');
          if (!equal(sha256(plain), ch.digest)) throw new XFTPError('DIGEST', 'the chunk is different from its description');
          return plain;
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        err = e;
      }
    }
    // a deleted or expired file does not come back
    if (err instanceof XFTPError && (err.gone || err.code === 'DIGEST' || err.code === 'SIZE')) break;
    if (attempt < 2) await sleep(3000, signal);
  }
  throw err;
}

export interface DownloadedFile {
  /** the name in the encrypted file header */
  name: string;
  size: number;
}

/**
 * downloads and decrypts a file, passing the content to write as it arrives. Each chunk is checked
 * against the digest in the description, and the whole file against its tag and digest at the end:
 * if this fails, the caller must discard what was written.
 */
export async function downloadFile(pool: XFTPPool, fd: FileDescription, write: (piece: Bytes) => Promise<void>, opts: TransferOptions & { maxSize?: number } = {}): Promise<DownloadedFile> {
  if (fd.party !== 'recipient') throw new XFTPError('DESCRIPTION', 'not a recipient description');
  if (fd.redirect) throw new XFTPError('DESCRIPTION', 'file links are not supported');
  if (!fd.chunks.length) throw new XFTPError('DESCRIPTION', 'the file has no chunks');
  const sb = new SbState(fd.key, fd.nonce);
  const fileDigest = sha512.create();
  let header: { name: string; contentLen: number } | undefined;
  let pending: Bytes = new Uint8Array(0);
  let written = 0;
  let tag: Bytes = new Uint8Array(0);
  let done = 0;
  const emit = async (plain: Bytes) => {
    let data = plain;
    if (!header) {
      pending = concat(pending, plain);
      if (pending.length < Math.min(1024, fd.size - AUTH_TAG_LEN)) return;
      const d = new Decoder(pending);
      const len = d.int64n();
      const name = fromUtf8Lossy(d.bytes());
      d.maybe((d) => d.bytes());
      const contentLen = len - (d.pos - FILE_SIZE_LEN);
      if (contentLen < 0 || len > fd.size - FILE_SIZE_LEN - AUTH_TAG_LEN) throw new XFTPError('CRYPTO', 'bad file length');
      if (opts.maxSize !== undefined && contentLen > opts.maxSize) throw new XFTPError('SIZE', 'the file is larger than declared');
      header = { name, contentLen };
      data = pending.subarray(d.pos);
      pending = new Uint8Array(0);
    }
    const n = Math.min(data.length, header.contentLen - written);
    if (n > 0) {
      await write(data.subarray(0, n));
      written += n;
    }
  };
  opts.onProgress?.(0, fd.size);
  for (const ch of fd.chunks) {
    opts.signal?.throwIfAborted();
    const enc = await fetchChunk(pool, ch, opts.signal, (b) => opts.onProgress?.(done + Math.min(b, ch.chunkSize), fd.size));
    fileDigest.update(enc);
    if (ch.chunkNo === fd.chunks.length) {
      if (enc.length < AUTH_TAG_LEN) throw new XFTPError('SIZE', 'the last chunk is too small');
      tag = enc.slice(enc.length - AUTH_TAG_LEN);
      await emit(sb.decrypt(enc.subarray(0, enc.length - AUTH_TAG_LEN)));
    } else await emit(sb.decrypt(enc));
    done += ch.chunkSize;
    opts.onProgress?.(done, fd.size);
  }
  if (!sb.verify(tag)) throw new XFTPError('CRYPTO', 'file authentication failed');
  if (!equal(fileDigest.digest(), fd.digest)) throw new XFTPError('DIGEST', 'the file is different from its description');
  if (!header || written !== header.contentLen) throw new XFTPError('SIZE', 'the file is incomplete');
  return { name: header.name, size: written };
}

/** deletes the chunks of a sent file from the servers (they also expire after about 2 days) */
export async function deleteUploadedFile(pool: XFTPPool, snd: FileDescription): Promise<void> {
  for (const ch of snd.chunks) {
    for (const r of ch.replicas) {
      try {
        await pool.with(r.server, (c) => c.command(r.replicaKey, r.replicaId, { tag: 'FDEL' }));
      } catch (e) {
        if (!(e instanceof XFTPError && e.gone)) throw e;
      }
    }
  }
}
