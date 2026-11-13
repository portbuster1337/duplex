// Double ratchet with header encryption, as in Simplex.Messaging.Crypto.Ratchet (e2e version 3):
// X448 DH keys, HKDF-SHA512, AES-256-GCM with 16-byte IVs, padded headers and bodies.
// With post-quantum encryption, each ratchet step also exchanges an sntrup761 key and ciphertext, and
// the KEM secret is added to the DH secret (the PQ double ratchet of SimpleX, e2e version 3).
import { concat, b64url, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';
import { decPubKey, decryptAEAD, dh, encPubKey, encryptAEAD, generateKeyPair, hkdf, publicKey, CryptoError, type PrivateKey, type PublicKey } from './crypto';
import { decVR, encVR, type VersionRange } from '../util/version';
import { sntrup761Dec, sntrup761Enc, sntrup761Keypair, type KemKeyPair } from './sntrup761';

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

/** the private part of the KEM parameters: a proposed key, or an accepted one with the encapsulation */
export type PrivKem = { tag: 'P'; kp: KemKeyPair } | { tag: 'A'; ct: Bytes; ss: Bytes; kp: KemKeyPair };

export interface E2EPrivParams {
  pk1: X448Priv;
  pk2: X448Priv;
  kem?: PrivKem;
}

/** whether to propose a KEM key, or accept a received one (UseKEM) */
export type UseKem = { tag: 'propose' } | { tag: 'accept'; key: Bytes };

export function generateE2EParams(version: number, useKem?: UseKem): { priv: E2EPrivParams; params: E2EParams } {
  const a = generateKeyPair('x448');
  const b = generateKeyPair('x448');
  const priv: E2EPrivParams = { pk1: a.priv, pk2: b.priv };
  const params: E2EParams = { version, k1: a.pub, k2: b.pub };
  if (useKem) {
    const kp = sntrup761Keypair();
    if (useKem.tag === 'propose') {
      priv.kem = { tag: 'P', kp };
      params.kem = { tag: 'P', key: kp.pub };
    } else {
      const { ct, ss } = sntrup761Enc(useKem.key);
      priv.kem = { tag: 'A', ct, ss, kp };
      params.kem = { tag: 'A', ct, key: kp.pub };
    }
  }
  return { priv, params };
}

/** replyKEM_: the joining party accepts a proposed KEM key, or proposes its own */
export function replyKem(received: KemParams | undefined, pqSupport: boolean): UseKem | undefined {
  if (!pqSupport) return undefined;
  return received?.tag === 'P' ? { tag: 'accept', key: received.key } : { tag: 'propose' };
}

/** a KEM exchange: the received key, the shared secret and the ciphertext sent with it */
export interface KemAccepted {
  pqRr: Bytes;
  pqRss: Bytes;
  pqRct: Bytes;
}

export interface RatchetInitParams {
  assocData: Bytes;
  vcPQ: Bytes;
  ratchetKey: Bytes;
  sndHK: Bytes;
  rcvNextHK: Bytes;
  kemAccepted?: KemAccepted;
}

function hkdf3(salt: Bytes, ikm: Bytes, info: string): [Bytes, Bytes, Bytes] {
  const out = hkdf(salt, ikm, info, 96);
  return [out.slice(0, 32), out.slice(32, 64), out.slice(64, 96)];
}

function pqX3dh(sk1: X448Pub, rk1: X448Pub, dh1: Bytes, dh2: Bytes, dh3: Bytes, kemAccepted?: KemAccepted): RatchetInitParams {
  const assocData = concat(sk1.key, rk1.key);
  // the KEM shared secret is added to the DH secrets (hybrid key agreement)
  const dhs = concat(dh1, dh2, dh3, kemAccepted?.pqRss ?? new Uint8Array(0));
  const salt = new Uint8Array(64);
  const [hk, nhk, sk] = hkdf3(salt, dhs, 'SimpleXX3DH');
  const vcPQ = hkdf(salt, dhs, 'SimpleXVerifyCode', 32);
  return { assocData, vcPQ, ratchetKey: sk, sndHK: hk, rcvNextHK: nhk, kemAccepted };
}

/** used by the party joining the connection, with its own params and the received ones; also returns its KEM key pair */
export function pqX3dhSnd(own: E2EPrivParams, rcv: E2EParams): { init: RatchetInitParams; pqRs?: KemKeyPair } {
  let kemAccepted: KemAccepted | undefined;
  let pqRs: KemKeyPair | undefined;
  if (own.kem?.tag === 'A') {
    if (rcv.kem?.tag !== 'P') throw new RatchetError('KEM', 'ratchet: bad KEM state');
    kemAccepted = { pqRr: rcv.kem.key, pqRss: own.kem.ss, pqRct: own.kem.ct };
    pqRs = own.kem.kp;
  } else if (own.kem?.tag === 'P') pqRs = own.kem.kp;
  const init = pqX3dh(publicKey(own.pk1), rcv.k1, dh(rcv.k1, own.pk2), dh(rcv.k2, own.pk1), dh(rcv.k2, own.pk2), kemAccepted);
  return { init, pqRs };
}

/** used by the party that created the connection, after receiving the reply; also returns its KEM key pair if the reply accepted it */
export function pqX3dhRcv(own: E2EPrivParams, snd: E2EParams): { init: RatchetInitParams; pqRs?: KemKeyPair } {
  let kemAccepted: KemAccepted | undefined;
  let pqRs: KemKeyPair | undefined;
  // a proposal in the reply is answered on the first ratchet step
  if (snd.kem?.tag === 'A') {
    if (own.kem?.tag !== 'P') throw new RatchetError('KEM', 'ratchet: bad KEM state');
    kemAccepted = { pqRr: snd.kem.key, pqRss: sntrup761Dec(snd.kem.ct, own.kem.kp.priv), pqRct: snd.kem.ct };
    pqRs = own.kem.kp;
  }
  const init = pqX3dh(snd.k1, publicKey(own.pk1), dh(snd.k2, own.pk1), dh(snd.k1, own.pk2), dh(snd.k2, own.pk2), kemAccepted);
  return { init, pqRs };
}

export interface RatchetKem {
  pqRs: KemKeyPair;
  kems?: KemAccepted;
}

export interface Ratchet {
  version: { current: number; maxSupported: number };
  ad: Bytes;
  vcPQ?: Bytes;
  dhRs: X448Priv;
  kem?: RatchetKem;
  /** whether large (PQ) headers are used when sending; it can only be enabled */
  supportKEM: boolean;
  /** KEM is used from the next ratchet step */
  enableKEM?: boolean;
  /** the current sending and receiving ratchets use KEM secrets (post-quantum encryption) */
  sndKEM?: boolean;
  rcvKEM?: boolean;
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

function rootKdf(rk: Bytes, k: X448Pub, pk: X448Priv, kemSecret?: Bytes): [Bytes, Bytes, Bytes] {
  const dhOut = dh(k, pk);
  return hkdf3(rk, kemSecret ? concat(dhOut, kemSecret) : dhOut, 'SimpleXRootRatchet');
}

function chainKdf(ck: Bytes): { ck: Bytes; mk: Bytes; iv: Bytes; ehIV: Bytes } {
  const [ck2, mk, ivs] = hkdf3(new Uint8Array(0), ck, 'SimpleXChainRatchet');
  return { ck: ck2, mk, iv: ivs.slice(0, 16), ehIV: ivs.slice(16, 32) };
}

export function initSndRatchet(versions: { current: number; maxSupported: number }, dhRr: X448Pub, dhRs: X448Priv, p: RatchetInitParams, pqRs?: KemKeyPair): Ratchet {
  const [rk, cks, nhks] = rootKdf(p.ratchetKey, dhRr, dhRs, p.kemAccepted?.pqRss);
  return {
    version: versions,
    ad: p.assocData,
    vcPQ: p.vcPQ,
    dhRs,
    kem: pqRs ? { pqRs, kems: p.kemAccepted } : undefined,
    supportKEM: !!pqRs,
    enableKEM: !!pqRs,
    sndKEM: !!p.kemAccepted,
    rcvKEM: false,
    rk,
    snd: { dhRr, cks, hks: p.sndHK },
    ns: 0,
    nr: 0,
    pn: 0,
    nhks,
    nhkr: p.rcvNextHK,
  };
}

export function initRcvRatchet(versions: { current: number; maxSupported: number }, dhRs: X448Priv, p: RatchetInitParams, pqRs?: KemKeyPair, pqSupport = false): Ratchet {
  return {
    version: versions,
    ad: p.assocData,
    vcPQ: p.vcPQ,
    dhRs,
    kem: pqRs ? { pqRs, kems: p.kemAccepted } : undefined,
    supportKEM: pqSupport,
    enableKEM: pqSupport,
    sndKEM: false,
    rcvKEM: false,
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

/** the KEM parameters in message headers: our key, with the ciphertext for the peer's key once accepted */
function kemHeaderParams(k: RatchetKem): KemParams {
  return k.kems ? { tag: 'A', ct: k.kems.pqRct, key: k.pqRs.pub } : { tag: 'P', key: k.pqRs.pub };
}

/**
 * encrypts a message, returning the encoded EncRatchetMessage and the updated ratchet. pqEnc turns
 * post-quantum encryption on or off from the next ratchet step (undefined keeps it as it is).
 */
export function ratchetEncrypt(rc: Ratchet, msg: Bytes, paddedLen: number, maxE2EVersion = E2E_VERSIONS.max, pqEnc?: boolean): { enc: Bytes; rc: Ratchet } {
  if (!rc.snd) throw new CryptoError('ratchet: no sending chain');
  const { ck, mk, iv, ehIV } = chainKdf(rc.snd.cks);
  const v = Math.max(E2E_VERSIONS.min, rc.version.current);
  const enableKEM = pqEnc ?? !!rc.enableKEM;
  // large headers, once used, stay
  const supportKEM = rc.supportKEM || enableKEM;
  const maxSupported = Math.max(maxE2EVersion, v);
  const header = encodeMsgHeader({ maxVersion: maxSupported, dhRs: publicKey(rc.dhRs), kem: rc.kem ? kemHeaderParams(rc.kem) : undefined, pn: rc.pn, ns: rc.ns });
  const eh = encryptAEAD(rc.snd.hks, ehIV, supportKEM ? PADDED_HEADER_LEN_PQ : PADDED_HEADER_LEN, rc.ad, header);
  const emHeader = new Encoder().word16(v).raw(ehIV).raw(eh.tag).large(eh.body).finish();
  const em = encryptAEAD(mk, iv, paddedLen, concat(rc.ad, emHeader), msg);
  const enc = new Encoder().large(emHeader).raw(em.tag).raw(em.body).finish();
  return {
    enc,
    rc: {
      ...rc,
      snd: { ...rc.snd, cks: ck },
      ns: rc.ns + 1,
      supportKEM,
      enableKEM,
      version: { ...rc.version, maxSupported },
      kem: pqEnc === false && rc.kem ? { pqRs: rc.kem.pqRs } : rc.kem,
    },
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

/** the KEM part of a ratchet step: the secrets for the receiving and the sending ratchets, and the new KEM state */
function pqRatchetStep(rc: Ratchet, hkem: KemParams | undefined): { kemSS?: Bytes; kemSS2?: Bytes; kem?: RatchetKem } {
  const pqEnc = !!rc.enableKEM;
  // no KEM in the header, but this side enabled it: a new key is proposed
  if (!hkem) return !rc.kem && pqEnc ? { kem: { pqRs: sntrup761Keypair() } } : {};
  let kemSS: Bytes | undefined;
  if (hkem.tag === 'A') {
    if (!rc.kem) throw new RatchetError('KEM', 'ratchet: bad KEM state');
    kemSS = sntrup761Dec(hkem.ct, rc.kem.pqRs.priv);
  }
  if (!pqEnc) return { kemSS };
  const { ct, ss } = sntrup761Enc(hkem.key);
  return { kemSS, kemSS2: ss, kem: { pqRs: sntrup761Keypair(), kems: { pqRr: hkem.key, pqRss: ss, pqRct: ct } } };
}

function ratchetStep(rc: Ratchet, h: MsgHeader): Ratchet {
  const { kemSS, kemSS2, kem } = pqRatchetStep(rc, h.kem);
  const dhRs2 = generateKeyPair('x448').priv;
  const [rk1, ckr, nhkr] = rootKdf(rc.rk, h.dhRs, rc.dhRs, kemSS);
  const [rk2, cks, nhks] = rootKdf(rk1, h.dhRs, dhRs2, kemSS2);
  const sndKEM = !!kemSS2;
  const rcvKEM = !!kemSS;
  const enableKEM = sndKEM || rcvKEM || !!kem;
  return {
    ...rc,
    dhRs: dhRs2,
    kem,
    supportKEM: rc.supportKEM || enableKEM,
    enableKEM,
    sndKEM,
    rcvKEM,
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
