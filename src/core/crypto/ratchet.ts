// Double ratchet with header encryption, as in Simplex.Messaging.Crypto.Ratchet (e2e version 3):
// X448 DH keys, HKDF-SHA512, AES-256-GCM with 16-byte IVs, padded headers and bodies.
// Post-quantum KEM parameters are parsed, and this side does not propose or accept KEM.
import { concat, b64url, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';
import { decPubKey, decryptAEAD, dh, encPubKey, encryptAEAD, generateKeyPair, hkdf, publicKey, CryptoError, type PrivateKey, type PublicKey } from './crypto';
import { decVR, encVR, type VersionRange } from '../util/version';

export const E2E_VERSIONS: VersionRange = { min: 3, max: 3 };
export const PADDED_HEADER_LEN_PQ = 2310;
export const PADDED_HEADER_LEN = 88;
const MAX_SKIP = 512;
export const MAX_SKIPPED_KEYS = 2000;

export type X448Pub = PublicKey<'x448'>;
export type X448Priv = PrivateKey<'x448'>;

export type KemParams = { tag: 'P'; key: Bytes } | { tag: 'A'; ct: Bytes; key: Bytes };

export function encKem(e: Encoder, k: KemParams): Encoder {
  if (k.tag === 'P') return e.char('P').large(k.key);
  return e.char('A').large(k.ct).large(k.key);
}

export function decKem(d: Decoder): KemParams {
  const c = d.char();
  if (c === 'P') return { tag: 'P', key: d.large() };
  if (c === 'A') return { tag: 'A', ct: d.large(), key: d.large() };
  throw new ParseError('bad ratchet KEM params');
}

/** E2ERatchetParams: version, two X448 keys, optional KEM */
export interface E2EParams {
  version: number;
  k1: X448Pub;
  k2: X448Pub;
  kem?: KemParams;
}

/** E2ERatchetParamsUri: version range instead of a version */
export interface E2EParamsUri {
  versions: VersionRange;
  k1: X448Pub;
  k2: X448Pub;
  kem?: KemParams;
}

export function encE2EParams(e: Encoder, p: E2EParams): Encoder {
  e.word16(p.version);
  encPubKey(e, p.k1);
  encPubKey(e, p.k2);
  return e.maybe(p.kem, encKem);
}

export function decE2EParams(d: Decoder): E2EParams {
  const version = d.word16();
  const k1 = decPubKey(d, 'x448');
  const k2 = decPubKey(d, 'x448');
  const kem = d.maybe(decKem);
  return { version, k1, k2, kem };
}

export function encE2EParamsUri(e: Encoder, p: E2EParamsUri): Encoder {
  encVR(e, p.versions);
  encPubKey(e, p.k1);
  encPubKey(e, p.k2);
  return e.maybe(p.kem, encKem);
}

export function decE2EParamsUri(d: Decoder): E2EParamsUri {
  const versions = decVR(d);
  const k1 = decPubKey(d, 'x448');
  const k2 = decPubKey(d, 'x448');
  const kem = d.maybe(decKem);
  return { versions, k1, k2, kem };
}

export interface E2EPrivParams {
  pk1: X448Priv;
  pk2: X448Priv;
}

export function generateE2EParams(version: number): { priv: E2EPrivParams; params: E2EParams } {
  const a = generateKeyPair('x448');
  const b = generateKeyPair('x448');
  return { priv: { pk1: a.priv, pk2: b.priv }, params: { version, k1: a.pub, k2: b.pub } };
}

export interface RatchetInitParams {
  assocData: Bytes;
  vcPQ: Bytes;
  ratchetKey: Bytes;
  sndHK: Bytes;
  rcvNextHK: Bytes;
}

function hkdf3(salt: Bytes, ikm: Bytes, info: string): [Bytes, Bytes, Bytes] {
  const out = hkdf(salt, ikm, info, 96);
  return [out.slice(0, 32), out.slice(32, 64), out.slice(64, 96)];
}

function pqX3dh(sk1: X448Pub, rk1: X448Pub, dh1: Bytes, dh2: Bytes, dh3: Bytes): RatchetInitParams {
  const assocData = concat(sk1.key, rk1.key);
  const dhs = concat(dh1, dh2, dh3);
  const salt = new Uint8Array(64);
  const [hk, nhk, sk] = hkdf3(salt, dhs, 'SimpleXX3DH');
  const vcPQ = hkdf(salt, dhs, 'SimpleXVerifyCode', 32);
  return { assocData, vcPQ, ratchetKey: sk, sndHK: hk, rcvNextHK: nhk };
}

/** used by the party joining the connection, with its own params and the received ones */
export function pqX3dhSnd(own: E2EPrivParams, rcv: E2EParams): RatchetInitParams {
  return pqX3dh(publicKey(own.pk1), rcv.k1, dh(rcv.k1, own.pk2), dh(rcv.k2, own.pk1), dh(rcv.k2, own.pk2));
}

/** used by the party that created the connection, after receiving the reply */
export function pqX3dhRcv(own: E2EPrivParams, snd: E2EParams): RatchetInitParams {
  return pqX3dh(snd.k1, publicKey(own.pk1), dh(snd.k2, own.pk1), dh(snd.k1, own.pk2), dh(snd.k2, own.pk2));
}

export interface Ratchet {
  version: { current: number; maxSupported: number };
  ad: Bytes;
  vcPQ?: Bytes;
  dhRs: X448Priv;
  /** whether large (PQ) headers are used when sending; always false on this side */
  supportKEM: boolean;
  rk: Bytes;
  snd?: { dhRr: X448Pub; cks: Bytes; hks: Bytes };
  rcv?: { ckr: Bytes; hkr: Bytes };
  ns: number;
  nr: number;
  pn: number;
  nhks: Bytes;
  nhkr: Bytes;
}

/** skipped message keys: header key (base64) -> message number -> [key, iv] */
export type SkippedKeys = Record<string, { hk: Bytes; keys: Record<number, [Bytes, Bytes]> }>;

function rootKdf(rk: Bytes, k: X448Pub, pk: X448Priv): [Bytes, Bytes, Bytes] {
  return hkdf3(rk, dh(k, pk), 'SimpleXRootRatchet');
}

function chainKdf(ck: Bytes): { ck: Bytes; mk: Bytes; iv: Bytes; ehIV: Bytes } {
  const [ck2, mk, ivs] = hkdf3(new Uint8Array(0), ck, 'SimpleXChainRatchet');
  return { ck: ck2, mk, iv: ivs.slice(0, 16), ehIV: ivs.slice(16, 32) };
}

export function initSndRatchet(versions: { current: number; maxSupported: number }, dhRr: X448Pub, dhRs: X448Priv, p: RatchetInitParams): Ratchet {
  const [rk, cks, nhks] = rootKdf(p.ratchetKey, dhRr, dhRs);
  return {
    version: versions,
    ad: p.assocData,
    vcPQ: p.vcPQ,
    dhRs,
    supportKEM: false,
    rk,
    snd: { dhRr, cks, hks: p.sndHK },
    ns: 0,
    nr: 0,
    pn: 0,
    nhks,
    nhkr: p.rcvNextHK,
  };
}

export function initRcvRatchet(versions: { current: number; maxSupported: number }, dhRs: X448Priv, p: RatchetInitParams): Ratchet {
  return {
    version: versions,
    ad: p.assocData,
    vcPQ: p.vcPQ,
    dhRs,
    supportKEM: false,
    rk: p.ratchetKey,
    ns: 0,
    nr: 0,
    pn: 0,
    nhks: p.rcvNextHK,
    nhkr: p.sndHK,
  };
}

interface MsgHeader {
  maxVersion: number;
  dhRs: X448Pub;
  kem?: KemParams;
  pn: number;
  ns: number;
}

function encodeMsgHeader(h: MsgHeader): Bytes {
  const e = new Encoder().word16(h.maxVersion);
  encPubKey(e, h.dhRs);
  e.maybe(h.kem, encKem);
  return e.word32(h.pn).word32(h.ns).finish();
}

function parseMsgHeader(b: Bytes, legacy: boolean): MsgHeader {
  const d = new Decoder(b);
  const maxVersion = d.word16();
  const dhRs = decPubKey(d, 'x448');
  const kem = legacy ? undefined : d.maybe(decKem);
  const pn = d.word32();
  const ns = d.word32();
  return { maxVersion, dhRs, kem, pn, ns };
}

/** versionedLengthP: 2-byte length when the first byte is < 32, otherwise a 1-byte length */
function versionedLength(d: Decoder): { legacy: boolean; body: Bytes } {
  return d.peek() < 32 ? { legacy: false, body: d.large() } : { legacy: true, body: d.bytes() };
}

interface EncMessageHeader {
  version: number;
  iv: Bytes;
  tag: Bytes;
  body: Bytes;
  legacy: boolean;
}

function parseEncHeader(b: Bytes): EncMessageHeader {
  const d = new Decoder(b);
  const version = d.word16();
  const iv = d.take(16);
  const tag = d.take(16);
  const { legacy, body } = versionedLength(d);
  return { version, iv, tag, body, legacy };
}

function parseEncMessage(b: Bytes): { header: Bytes; tag: Bytes; body: Bytes } {
  const d = new Decoder(b);
  const { body: header } = versionedLength(d);
  const tag = d.take(16);
  return { header, tag, body: d.rest() };
}

/** encrypts a message, returning the encoded EncRatchetMessage and the updated ratchet */
export function ratchetEncrypt(rc: Ratchet, msg: Bytes, paddedLen: number, maxE2EVersion = E2E_VERSIONS.max): { enc: Bytes; rc: Ratchet } {
  if (!rc.snd) throw new CryptoError('ratchet: no sending chain');
  const { ck, mk, iv, ehIV } = chainKdf(rc.snd.cks);
  const v = Math.max(E2E_VERSIONS.min, rc.version.current);
  const maxSupported = Math.max(maxE2EVersion, v);
  const header = encodeMsgHeader({ maxVersion: maxSupported, dhRs: publicKey(rc.dhRs), pn: rc.pn, ns: rc.ns });
  const eh = encryptAEAD(rc.snd.hks, ehIV, rc.supportKEM ? PADDED_HEADER_LEN_PQ : PADDED_HEADER_LEN, rc.ad, header);
  const emHeader = new Encoder().word16(v).raw(ehIV).raw(eh.tag).large(eh.body).finish();
  const em = encryptAEAD(mk, iv, paddedLen, concat(rc.ad, emHeader), msg);
  const enc = new Encoder().large(emHeader).raw(em.tag).raw(em.body).finish();
  return {
    enc,
    rc: { ...rc, snd: { ...rc.snd, cks: ck }, ns: rc.ns + 1, version: { ...rc.version, maxSupported } },
  };
}

export class RatchetError extends CryptoError {
  constructor(
    readonly code: 'HEADER' | 'EARLIER' | 'DUPLICATE' | 'TOO_MANY_SKIPPED' | 'STATE' | 'KEM' | 'DECRYPT',
    msg: string,
  ) {
    super(msg);
  }
}

function tryDecryptHeader(hk: Bytes, ad: Bytes, eh: EncMessageHeader): MsgHeader | undefined {
  let h: Bytes;
  try {
    h = decryptAEAD(hk, eh.iv, ad, eh.body, eh.tag);
  } catch {
    return undefined;
  }
  return parseMsgHeader(h, eh.legacy);
}

function decryptBody(mk: Bytes, iv: Bytes, ad: Bytes, emHeader: Bytes, tag: Bytes, body: Bytes): Bytes {
  try {
    return decryptAEAD(mk, iv, concat(ad, emHeader), body, tag);
  } catch {
    throw new RatchetError('DECRYPT', 'ratchet: message decryption failed');
  }
}

export interface DecryptResult {
  msg: Bytes;
  rc: Ratchet;
  skipped: SkippedKeys;
}

function addSkipped(sk: SkippedKeys, hk: Bytes, keys: Record<number, [Bytes, Bytes]>): SkippedKeys {
  if (!Object.keys(keys).length) return sk;
  const id = b64url(hk);
  const prev = sk[id]?.keys ?? {};
  return { ...sk, [id]: { hk, keys: { ...prev, ...keys } } };
}

function skipMessageKeys(rc: Ratchet, untilN: number): { rc: Ratchet; hk?: Bytes; keys: Record<number, [Bytes, Bytes]> } {
  if (!rc.rcv) return { rc, keys: {} };
  const nr = rc.nr;
  if (nr > untilN + 1) throw new RatchetError('EARLIER', `ratchet: earlier message (${nr - untilN - 1})`);
  if (nr === untilN + 1) throw new RatchetError('DUPLICATE', 'ratchet: duplicate message');
  if (nr + MAX_SKIP < untilN) throw new RatchetError('TOO_MANY_SKIPPED', `ratchet: too many skipped messages (${untilN + 1 - nr})`);
  if (nr === untilN) return { rc, keys: {} };
  let ck = rc.rcv.ckr;
  const keys: Record<number, [Bytes, Bytes]> = {};
  let n = nr;
  while (n < untilN) {
    const r = chainKdf(ck);
    keys[n] = [r.mk, r.iv];
    ck = r.ck;
    n++;
  }
  return { rc: { ...rc, rcv: { ...rc.rcv, ckr: ck }, nr: n }, hk: rc.rcv.hkr, keys };
}

export function ratchetDecrypt(rc0: Ratchet, skipped0: SkippedKeys, msg: Bytes): DecryptResult {
  const em = parseEncMessage(msg);
  const eh = parseEncHeader(em.header);
  let skipped = skipped0;
  // try skipped message keys first
  for (const [id, { hk, keys }] of Object.entries(skipped0)) {
    const h = tryDecryptHeader(hk, rc0.ad, eh);
    if (!h) continue;
    const k = keys[h.ns];
    if (k) {
      const out = decryptBody(k[0], k[1], rc0.ad, em.header, em.tag, em.body);
      const rest = { ...keys };
      delete rest[h.ns];
      skipped = { ...skipped0 };
      if (Object.keys(rest).length) skipped[id] = { hk, keys: rest };
      else delete skipped[id];
      return { msg: out, rc: rc0, skipped };
    }
    // the header key matched, but there is no skipped key for this message number
    const same = rc0.rcv && equalKey(rc0.rcv.hkr, hk);
    if (same) return decryptRcMessage(rc0, skipped, h, false, em);
    if (equalKey(rc0.nhkr, hk)) return decryptRcMessage(rc0, skipped, h, true, em);
    throw new RatchetError('HEADER', 'ratchet: header decryption failed');
  }
  if (rc0.rcv) {
    const h = tryDecryptHeader(rc0.rcv.hkr, rc0.ad, eh);
    if (h) return decryptRcMessage(rc0, skipped, h, false, em);
  }
  const h = tryDecryptHeader(rc0.nhkr, rc0.ad, eh);
  if (!h) throw new RatchetError('HEADER', 'ratchet: header decryption failed');
  return decryptRcMessage(rc0, skipped, h, true, em);
}

function equalKey(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function decryptRcMessage(rc0: Ratchet, skipped0: SkippedKeys, h: MsgHeader, advance: boolean, em: { header: Bytes; tag: Bytes; body: Bytes }): DecryptResult {
  let rc = rc0;
  if (h.maxVersion > rc.version.current) {
    rc = { ...rc, version: { ...rc.version, current: Math.max(rc.version.current, Math.min(h.maxVersion, rc.version.maxSupported)) } };
  }
  let skipped = skipped0;
  if (advance) {
    const s1 = skipMessageKeys(rc, h.pn);
    if (s1.hk) skipped = addSkipped(skipped, s1.hk, s1.keys);
    rc = ratchetStep(s1.rc, h);
  }
  const s2 = skipMessageKeys(rc, h.ns);
  if (s2.hk) skipped = addSkipped(skipped, s2.hk, s2.keys);
  rc = s2.rc;
  if (!rc.rcv) throw new RatchetError('STATE', 'ratchet: no receiving chain');
  const { ck, mk, iv } = chainKdf(rc.rcv.ckr);
  const out = decryptBody(mk, iv, rc.ad, em.header, em.tag, em.body);
  return { msg: out, rc: { ...rc, rcv: { ...rc.rcv, ckr: ck }, nr: rc.nr + 1 }, skipped };
}

function ratchetStep(rc: Ratchet, h: MsgHeader): Ratchet {
  if (h.kem?.tag === 'A') throw new RatchetError('KEM', 'ratchet: unexpected KEM ciphertext');
  const dhRs2 = generateKeyPair('x448').priv;
  const [rk1, ckr, nhkr] = rootKdf(rc.rk, h.dhRs, rc.dhRs);
  const [rk2, cks, nhks] = rootKdf(rk1, h.dhRs, dhRs2);
  return {
    ...rc,
    dhRs: dhRs2,
    rk: rk2,
    snd: { dhRr: h.dhRs, cks, hks: rc.nhks },
    rcv: { ckr, hkr: rc.nhkr },
    pn: rc.ns,
    ns: 0,
    nr: 0,
    nhks,
    nhkr,
  };
}

/** total number of stored skipped keys */
export function skippedCount(sk: SkippedKeys): number {
  let n = 0;
  for (const v of Object.values(sk)) n += Object.keys(v.keys).length;
  return n;
}
