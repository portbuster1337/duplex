// XFTP, the SimpleX file transfer protocol (Simplex.FileTransfer.Protocol and Transport): files are
// encrypted, split into chunks of fixed sizes, and each chunk is stored on a file server with
// authorized commands. A command is a padded 16 KB block, sent as an HTTP/2 POST request with the chunk
// data after the block; responses have the same form.
import { equal, fromAscii, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError, pad, unPad } from '../util/encoding';
import { decPubKey, encPubKey, type PublicKey } from '../crypto/crypto';
import { decVR, type VersionRange } from '../util/version';

export const XFTP_BLOCK_SIZE = 16384;
/** 1 - initial, 2 - authorized commands, 3 - blocked files, 4 - storage time and server information */
export const XFTP_VERSIONS: VersionRange = { min: 1, max: 4 };
export const STORAGE_TIME_XFTP_VERSION = 4;

export const KB = 1024;
export const MB = 1024 * KB;
export const GB = 1024 * MB;
export const CHUNK_SIZES = [64 * KB, 256 * KB, MB, 4 * MB];
/** the limit of the apps for files without badges */
export const MAX_FILE_SIZE = GB;
/** the size of the file length before the file header, and of the authentication tag */
export const FILE_SIZE_LEN = 8;
export const AUTH_TAG_LEN = 16;

export class XFTPError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(detail ? `XFTP error ${code} ${detail}` : `XFTP error ${code}`);
    this.name = 'XFTPError';
  }

  /** the file was deleted by the sender or expired on the server */
  get gone(): boolean {
    return this.code === 'AUTH' || this.code === 'NO_FILE' || this.code === 'BLOCKED';
  }
}

export type FileCommand =
  | { tag: 'FNEW'; sndKey: PublicKey; size: number; digest: Bytes; rcvKeys: PublicKey[]; basicAuth?: string; storageHours?: number }
  | { tag: 'FADD'; rcvKeys: PublicKey[] }
  | { tag: 'FPUT' }
  | { tag: 'FDEL' }
  | { tag: 'FGET'; dhKey: PublicKey<'x25519'> }
  | { tag: 'FACK' }
  | { tag: 'PING' };

export function encodeFileCommand(v: number, c: FileCommand): Bytes {
  const e = new Encoder();
  switch (c.tag) {
    case 'FNEW':
      e.str('FNEW ');
      // FileInfo: sender key, chunk size, chunk digest
      encPubKey(e, c.sndKey).word32(c.size).bytes(c.digest);
      e.list(c.rcvKeys, (e, k) => encPubKey(e, k));
      e.maybe(c.basicAuth, (e, a) => e.text(a));
      if (v >= STORAGE_TIME_XFTP_VERSION) e.maybe(c.storageHours, (e, h) => e.word32(h));
      break;
    case 'FADD':
      e.str('FADD ').list(c.rcvKeys, (e, k) => encPubKey(e, k));
      break;
    case 'FGET':
      encPubKey(e.str('FGET '), c.dhKey);
      break;
    default:
      e.str(c.tag);
  }
  return e.finish();
}

export type FileResponse =
  | { tag: 'SIDS'; sndId: Bytes; rcvIds: Bytes[]; expiresAt?: number }
  | { tag: 'RIDS'; rcvIds: Bytes[] }
  | { tag: 'FILE'; dhKey: PublicKey<'x25519'>; nonce: Bytes }
  | { tag: 'OK' }
  | { tag: 'PONG' }
  | { tag: 'ERR'; err: XFTPError };

export function parseFileResponse(v: number, b: Bytes): FileResponse {
  const d = new Decoder(b);
  const tag = d.tag();
  switch (tag) {
    case 'SIDS': {
      const sndId = d.bytes();
      const rcvIds = d.nonEmpty((d) => d.bytes());
      let expiresAt: number | undefined;
      if (v >= STORAGE_TIME_XFTP_VERSION && !d.atEnd()) {
        expiresAt = d.maybe((d) => {
          d.expectChar('T');
          return d.int64n();
        });
      }
      return { tag, sndId, rcvIds, expiresAt };
    }
    case 'RIDS':
      return { tag, rcvIds: d.nonEmpty((d) => d.bytes()) };
    case 'FILE':
      return { tag, dhKey: decPubKey(d, 'x25519'), nonce: d.take(24) };
    case 'OK':
    case 'PONG':
      return { tag };
    case 'ERR': {
      const s = fromAscii(d.rest());
      const i = s.indexOf(' ');
      return { tag, err: i < 0 ? new XFTPError(s) : new XFTPError(s.slice(0, i), s.slice(i + 1)) };
    }
  }
  throw new ParseError(`unknown XFTP response ${tag}`);
}

/**
 * A command as a padded block: one transmission in a batch, with the session ID (XFTP does not imply
 * it), an empty correlation ID and the signature of the sender or recipient key.
 */
export function encodeTransmission(sessionId: Bytes, entityId: Bytes, command: Bytes, sign?: (signed: Bytes) => Bytes): Bytes {
  const signed = new Encoder().bytes(sessionId).bytes(new Uint8Array(0)).bytes(entityId).raw(command).finish();
  const t = new Encoder()
    .bytes(sign ? sign(signed) : new Uint8Array(0))
    .raw(signed)
    .finish();
  return pad(new Encoder().byte(1).large(t).finish(), XFTP_BLOCK_SIZE);
}

/** errors of the handshake layer are sent as a padded error name instead of a transmission */
function handshakeError(b: Bytes): XFTPError | undefined {
  if (b.length === 0 || b.length > 20) return undefined;
  const s = fromAscii(b);
  return /^[A-Z_]+$/.test(s) ? new XFTPError(s) : undefined;
}

export function decodeTransmission(sessionId: Bytes, block: Bytes): { entityId: Bytes; command: Bytes } {
  if (block.length !== XFTP_BLOCK_SIZE) throw new XFTPError('BLOCK', 'bad response size');
  const b = unPad(block);
  const he = handshakeError(b);
  if (he) throw he;
  const d = new Decoder(b);
  if (d.byte() !== 1) throw new XFTPError('BLOCK', 'expected one transmission');
  const t = new Decoder(d.large());
  t.bytes(); // responses are not signed
  if (!equal(t.bytes(), sessionId)) throw new XFTPError('SESSION');
  t.bytes(); // correlation ID
  const entityId = t.bytes();
  return { entityId, command: t.rest() };
}

export interface ServerHandshake {
  versions: VersionRange;
  sessionId: Bytes;
  certChain: Bytes[];
  /** the server's X25519 key signed with its TLS key */
  signedKey: Bytes;
}

export function decodeServerHandshake(block: Bytes): ServerHandshake {
  if (block.length !== XFTP_BLOCK_SIZE) throw new XFTPError('HANDSHAKE', 'bad handshake size');
  const b = unPad(block);
  const he = handshakeError(b);
  if (he) throw he;
  const d = new Decoder(b);
  const versions = decVR(d);
  const sessionId = d.bytes();
  const certChain = d.nonEmpty((d) => d.large());
  const signedKey = d.large();
  // the identity proof of the web handshake and the server information follow, not used here
  return { versions, sessionId, certChain, signedKey };
}

export function encodeClientHandshake(v: number, keyHash: Bytes): Bytes {
  const e = new Encoder().word16(v).bytes(keyHash);
  if (v >= STORAGE_TIME_XFTP_VERSION) e.char('0'); // no entitlement proof
  return pad(e.finish(), XFTP_BLOCK_SIZE);
}

// ---- chunks and sizes

/** prepareChunkSizes of Simplex.FileTransfer.Client: chunk sizes for an encrypted file of this size */
export function prepareChunkSizes(payloadSize: number): number[] {
  const size34 = (s: number) => Math.floor((s * 3) / 4);
  const [c0, c1, c2, c3] = CHUNK_SIZES;
  const [small, big] = payloadSize > size34(c3) ? [c2, c3] : payloadSize > size34(c2) ? [c1, c2] : [c0, c1];
  const out: number[] = [];
  let size = payloadSize;
  while (size > 0) {
    if (size >= big) {
      const n = Math.floor(size / big);
      for (let i = 0; i < n; i++) out.push(big);
      size -= n * big;
    } else if (size > size34(big)) {
      out.push(big);
      size = 0;
    } else {
      const n = Math.ceil(size / small);
      for (let i = 0; i < n; i++) out.push(small);
      size = 0;
    }
  }
  return out;
}

/** FileSize strEncode: bytes, or kb/mb/gb when the size is a multiple */
export function strFileSize(n: number): string {
  if (n % KB) return String(n);
  if ((n / KB) % KB) return `${n / KB}kb`;
  if ((n / MB) % KB) return `${n / MB}mb`;
  return `${n / GB}gb`;
}

export function parseFileSize(s: string): number {
  const m = s.match(/^(\d+)(kb|mb|gb)?$/);
  if (!m) throw new ParseError(`bad file size ${s}`);
  const n = Number(m[1]) * (m[2] === 'gb' ? GB : m[2] === 'mb' ? MB : m[2] === 'kb' ? KB : 1);
  if (!Number.isSafeInteger(n)) throw new ParseError(`bad file size ${s}`);
  return n;
}
