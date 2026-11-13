// Cryptographic primitives used by SimpleX protocols (Simplex.Messaging.Crypto), built on audited
// pure-JS libraries (@noble/*) so the same code runs in browsers and in Node for tests.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { ed448, x448 } from '@noble/curves/ed448.js';
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { sha3_256 as nobleSha3_256, sha3_384 as nobleSha3_384 } from '@noble/hashes/sha3.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { md5 as nobleMd5 } from '@noble/hashes/legacy.js';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { gcm } from '@noble/ciphers/aes.js';
import { concat, equal, randomBytes, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError, pad, unPad } from '../util/encoding';

export const sha256 = (b: Bytes): Bytes => nobleSha256(b);
export const sha512 = (b: Bytes): Bytes => nobleSha512(b);
export const sha3_256 = (b: Bytes): Bytes => nobleSha3_256(b);
export const sha3_384 = (b: Bytes): Bytes => nobleSha3_384(b);
export const md5 = (b: Bytes): Bytes => nobleMd5(b);
export const hmacSha256 = (key: Bytes, msg: Bytes): Bytes => hmac(nobleSha256, key, msg);

/** HKDF-SHA512 with the argument order of Simplex.Messaging.Crypto.hkdf */
export function hkdf(salt: Bytes, ikm: Bytes, info: Bytes | string, n: number): Bytes {
  const i = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  return nobleHkdf(nobleSha512, ikm, salt, i, n);
}

// ---- keys

export type DhAlg = 'x25519' | 'x448';
export type SignAlg = 'ed25519' | 'ed448';
export type KeyAlg = DhAlg | SignAlg;

export interface PublicKey<A extends KeyAlg = KeyAlg> {
  alg: A;
  key: Bytes;
}

export interface PrivateKey<A extends KeyAlg = KeyAlg> {
  alg: A;
  key: Bytes;
}

export interface KeyPair<A extends KeyAlg = KeyAlg> {
  pub: PublicKey<A>;
  priv: PrivateKey<A>;
}

// SubjectPublicKeyInfo DER prefixes (RFC 8410)
const SPKI: Record<KeyAlg, Bytes> = {
  ed25519: Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00),
  x25519: Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00),
  ed448: Uint8Array.of(0x30, 0x43, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x71, 0x03, 0x3a, 0x00),
  x448: Uint8Array.of(0x30, 0x42, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6f, 0x03, 0x39, 0x00),
};
const KEY_LEN: Record<KeyAlg, number> = { ed25519: 32, x25519: 32, ed448: 57, x448: 56 };

export function encodePubKey(k: PublicKey): Bytes {
  if (k.key.length !== KEY_LEN[k.alg]) throw new Error(`bad ${k.alg} key length`);
  return concat(SPKI[k.alg], k.key);
}

export function decodePubKey(der: Bytes): PublicKey {
  for (const alg of Object.keys(SPKI) as KeyAlg[]) {
    const p = SPKI[alg];
    if (der.length === p.length + KEY_LEN[alg] && equal(der.subarray(0, p.length), p)) {
      return { alg, key: der.slice(p.length) };
    }
  }
  throw new ParseError('unknown public key encoding');
}

export function decodePubKeyOf<A extends KeyAlg>(der: Bytes, ...algs: A[]): PublicKey<A> {
  const k = decodePubKey(der);
  if (!(algs as KeyAlg[]).includes(k.alg)) throw new ParseError(`unexpected key algorithm ${k.alg}`);
  return k as PublicKey<A>;
}

/** smpEncode of a public key: shortString of its X509 encoding */
export function encPubKey(e: Encoder, k: PublicKey): Encoder {
  return e.bytes(encodePubKey(k));
}

export function decPubKey<A extends KeyAlg>(d: Decoder, ...algs: A[]): PublicKey<A> {
  return decodePubKeyOf(d.bytes(), ...algs);
}

export function generateKeyPair<A extends KeyAlg>(alg: A): KeyPair<A> {
  let priv: Bytes;
  let pub: Bytes;
  switch (alg) {
    case 'x25519':
      priv = randomBytes(32);
      pub = x25519.getPublicKey(priv);
      break;
    case 'x448':
      priv = randomBytes(56);
      pub = x448.getPublicKey(priv);
      break;
    case 'ed25519':
      priv = randomBytes(32);
      pub = ed25519.getPublicKey(priv);
      break;
    case 'ed448':
      priv = randomBytes(57);
      pub = ed448.getPublicKey(priv);
      break;
    default:
      throw new Error('unknown algorithm');
  }
  return { pub: { alg, key: pub }, priv: { alg, key: priv } };
}

export function publicKey<A extends KeyAlg>(pk: PrivateKey<A>): PublicKey<A> {
  const k = pk.key;
  switch (pk.alg) {
    case 'x25519':
      return { alg: pk.alg, key: x25519.getPublicKey(k) };
    case 'x448':
      return { alg: pk.alg, key: x448.getPublicKey(k) };
    case 'ed25519':
      return { alg: pk.alg, key: ed25519.getPublicKey(k) };
    case 'ed448':
      return { alg: pk.alg, key: ed448.getPublicKey(k) };
  }
  throw new Error('unknown algorithm');
}

export function dh(pub: PublicKey<DhAlg>, priv: PrivateKey<DhAlg>): Bytes {
  if (pub.alg !== priv.alg) throw new Error('DH key algorithms differ');
  const s = pub.alg === 'x25519' ? x25519.getSharedSecret(priv.key, pub.key) : x448.getSharedSecret(priv.key, pub.key);
  if (s.every((x) => x === 0)) throw new Error('DH: zero shared secret');
  return s;
}

export function sign(pk: PrivateKey<SignAlg>, msg: Bytes): Bytes {
  return pk.alg === 'ed25519' ? ed25519.sign(msg, pk.key) : ed448.sign(msg, pk.key);
}

export function verify(k: PublicKey<SignAlg>, sig: Bytes, msg: Bytes): boolean {
  try {
    if (k.alg === 'ed25519') return sig.length === 64 && ed25519.verify(sig, msg, k.key);
    return sig.length === 114 && ed448.verify(sig, msg, k.key);
  } catch {
    return false;
  }
}

// ---- NaCl-style boxes, exactly as Simplex.Messaging.Crypto.cryptoBox:
// XSalsa20 keyed with HSalsa20(secret, 0^16), Poly1305 tag prepended to the ciphertext.

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function u32le(b: Bytes): Uint32Array {
  const out = new Uint32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24)) >>> 0;
  return out;
}

function u8le(w: Uint32Array): Bytes {
  const out = new Uint8Array(w.length * 4);
  for (let i = 0; i < w.length; i++) {
    out[i * 4] = w[i] & 0xff;
    out[i * 4 + 1] = (w[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (w[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (w[i] >>> 24) & 0xff;
  }
  return out;
}

/** the XSalsa20 key of the boxes: SimpleX passes both DH secrets and symmetric keys through HSalsa20 */
export function secretBoxKey(secret: Bytes): Bytes {
  if (secret.length !== 32) throw new Error('box key must be 32 bytes');
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32le(secret), new Uint32Array(4), out);
  return u8le(out);
}

/** tag || ciphertext */
export function cryptoBox(secret: Bytes, nonce: Bytes, msg: Bytes): Bytes {
  return xsalsa20poly1305(secretBoxKey(secret), nonce).encrypt(msg);
}

export function cryptoBoxOpen(secret: Bytes, nonce: Bytes, packet: Bytes): Bytes {
  if (packet.length < 16) throw new CryptoError('box: packet too short');
  try {
    return xsalsa20poly1305(secretBoxKey(secret), nonce).decrypt(packet);
  } catch {
    throw new CryptoError('box: decryption failed');
  }
}

export class CryptoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CryptoError';
  }
}

/** cbEncrypt / sbEncrypt: pad, then box */
export function cbEncrypt(secret: Bytes, nonce: Bytes, msg: Bytes, paddedLen: number): Bytes {
  return cryptoBox(secret, nonce, pad(msg, paddedLen));
}

/** cbDecrypt / sbDecrypt: unbox, then unpad */
export function cbDecrypt(secret: Bytes, nonce: Bytes, packet: Bytes): Bytes {
  if (secret.every((x) => x === 0)) throw new CryptoError('box: zero secret');
  return unPad(cryptoBoxOpen(secret, nonce, packet));
}

/** CbAuthenticator: crypto_box over sha512 of the authorized part (80 bytes) */
export function cbAuthenticate(serverPub: PublicKey<'x25519'>, priv: PrivateKey<'x25519'>, nonce: Bytes, msg: Bytes): Bytes {
  return cryptoBox(dh(serverPub, priv), nonce, sha512(msg));
}

export function randomNonce(): Bytes {
  return randomBytes(24);
}

export function xorNonce(prefix: Bytes, nonce: Bytes): Bytes {
  const out = nonce.slice();
  for (let i = 0; i < prefix.length && i < out.length; i++) out[i] ^= prefix[i];
  return out;
}

// ---- secret box chain (transport block encryption, v11+)

export interface SbChainKey {
  ck: Bytes;
}

export function sbcInit(salt: Bytes, secret: Bytes): [Bytes, Bytes] {
  const out = hkdf(salt, secret, 'SimpleXSbChainInit', 64);
  return [out.slice(0, 32), out.slice(32)];
}

/** returns [secretBoxKey, nonce, nextChainKey] */
export function sbcHkdf(ck: Bytes): [Bytes, Bytes, Bytes] {
  const out = hkdf(new Uint8Array(0), ck, 'SimpleXSbChain', 88);
  return [out.slice(32, 64), out.slice(64, 88), out.slice(0, 32)];
}

// ---- AES-256-GCM with 16-byte IVs (double ratchet)

export function encryptAEAD(key: Bytes, iv: Bytes, paddedLen: number, ad: Bytes, msg: Bytes): { tag: Bytes; body: Bytes } {
  const ct = gcm(key, iv, ad).encrypt(pad(msg, paddedLen));
  return { body: ct.subarray(0, ct.length - 16), tag: ct.subarray(ct.length - 16) };
}

export function decryptAEAD(key: Bytes, iv: Bytes, ad: Bytes, body: Bytes, tag: Bytes): Bytes {
  let pt: Bytes;
  try {
    pt = gcm(key, iv, ad).decrypt(concat(body, tag));
  } catch {
    throw new CryptoError('AES decrypt error');
  }
  return unPad(pt);
}

export function encryptAESNoPad(key: Bytes, iv12: Bytes, msg: Bytes, ad: Bytes = new Uint8Array(0)): { tag: Bytes; body: Bytes } {
  const ct = gcm(key, iv12, ad).encrypt(msg);
  return { body: ct.subarray(0, ct.length - 16), tag: ct.subarray(ct.length - 16) };
}

export function decryptAESNoPad(key: Bytes, iv12: Bytes, body: Bytes, tag: Bytes, ad: Bytes = new Uint8Array(0)): Bytes {
  try {
    return gcm(key, iv12, ad).decrypt(concat(body, tag));
  } catch {
    throw new CryptoError('AES decrypt error');
  }
}
