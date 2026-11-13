// Streaming NaCl secret box, as Simplex.Messaging.Crypto.Lazy (sbInit / sbEncryptChunk / sbAuth): the
// XSalsa20 key stream continues across chunks and Poly1305 covers the whole ciphertext, so large files
// can be encrypted piece by piece. The key (a symmetric key or a DH secret) goes through HSalsa20 first,
// like the boxes of crypto.ts, so a message encrypted in one chunk is a box with the tag at the end.
import { xsalsa20 } from '@noble/ciphers/salsa.js';
import { Poly1305 } from '@noble/ciphers/_poly1305.js';
import { equal, type Bytes } from '../util/bytes';
import { CryptoError, secretBoxKey } from './crypto';

export const AUTH_TAG_SIZE = 16;

export class SbState {
  private key: Bytes;
  /** position in the key stream; the first 32 bytes are the Poly1305 key */
  private pos = 32;
  private mac: Poly1305;
  private done = false;

  constructor(
    secret: Bytes,
    private nonce: Bytes,
  ) {
    if (nonce.length !== 24) throw new CryptoError('secret box: nonce must be 24 bytes');
    this.key = secretBoxKey(secret);
    this.mac = new Poly1305(xsalsa20(this.key, nonce, new Uint8Array(32)));
  }

  private xor(data: Bytes): Bytes {
    if (this.done) throw new CryptoError('secret box: already finished');
    const out = new Uint8Array(data.length);
    let off = 0;
    const skip = this.pos % 64;
    if (skip && data.length) {
      // the rest of a partly used block
      const n = Math.min(64 - skip, data.length);
      const ks = xsalsa20(this.key, this.nonce, new Uint8Array(skip + n), undefined, Math.floor(this.pos / 64));
      for (let i = 0; i < n; i++) out[i] = data[i] ^ ks[skip + i];
      off = n;
    }
    if (off < data.length) xsalsa20(this.key, this.nonce, data.subarray(off), out.subarray(off), (this.pos + off) / 64);
    this.pos += data.length;
    return out;
  }

  encrypt(plain: Bytes): Bytes {
    const c = this.xor(plain);
    this.mac.update(c);
    return c;
  }

  decrypt(cipher: Bytes): Bytes {
    this.mac.update(cipher);
    return this.xor(cipher);
  }

  /** the authentication tag of everything processed */
  tag(): Bytes {
    this.done = true;
    return this.mac.digest();
  }

  /** checks the tag in constant time */
  verify(tag: Bytes): boolean {
    return tag.length === AUTH_TAG_SIZE && equal(this.tag(), tag);
  }
}

/** encrypts in one piece and appends the tag (sbEncryptTailTagNoPad) */
export function sbEncryptTailTag(secret: Bytes, nonce: Bytes, plain: Bytes): Bytes {
  const s = new SbState(secret, nonce);
  const c = s.encrypt(plain);
  const out = new Uint8Array(c.length + AUTH_TAG_SIZE);
  out.set(c);
  out.set(s.tag(), c.length);
  return out;
}

/** decrypts a ciphertext with the tag at the end (sbDecryptTailTagNoPad) */
export function sbDecryptTailTag(secret: Bytes, nonce: Bytes, packet: Bytes): Bytes {
  if (packet.length < AUTH_TAG_SIZE) throw new CryptoError('secret box: packet too short');
  const s = new SbState(secret, nonce);
  const p = s.decrypt(packet.subarray(0, packet.length - AUTH_TAG_SIZE));
  if (!s.verify(packet.subarray(packet.length - AUTH_TAG_SIZE))) throw new CryptoError('secret box: authentication failed');
  return p;
}
