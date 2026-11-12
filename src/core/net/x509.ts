// Minimal DER reader and X.509 certificate parsing: just enough to verify the self-signed
// certificate chains of SimpleX servers (Ed25519/Ed448 keys and signatures).
import { equal, type Bytes } from '../util/bytes';
import { decodePubKey, verify, type PublicKey, type SignAlg } from '../crypto/crypto';

export class DerError extends Error {}

export interface DerElement {
  tag: number;
  /** full encoding, including tag and length */
  raw: Bytes;
  /** contents */
  value: Bytes;
}

export function derRead(buf: Bytes, pos = 0): { el: DerElement; next: number } {
  if (pos + 2 > buf.length) throw new DerError('DER: truncated');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError('DER: unsupported length');
    if (pos + 2 + n > buf.length) throw new DerError('DER: truncated');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    hdr += n;
  }
  const end = pos + hdr + len;
  if (end > buf.length) throw new DerError('DER: truncated value');
  return { el: { tag, raw: buf.subarray(pos, end), value: buf.subarray(pos + hdr, end) }, next: end };
}

export function derChildren(el: DerElement): DerElement[] {
  const out: DerElement[] = [];
  let p = 0;
  while (p < el.value.length) {
    const { el: c, next } = derRead(el.value, p);
    out.push(c);
    p = next;
  }
  return out;
}

export function derParse(buf: Bytes): DerElement {
  const { el, next } = derRead(buf);
  if (next !== buf.length) throw new DerError('DER: trailing bytes');
  return el;
}

const OID_ED25519 = Uint8Array.of(0x2b, 0x65, 0x70);
const OID_ED448 = Uint8Array.of(0x2b, 0x65, 0x71);

function sigAlgOf(algId: DerElement): SignAlg {
  const [oid] = derChildren(algId);
  if (!oid || oid.tag !== 0x06) throw new DerError('X509: bad AlgorithmIdentifier');
  if (equal(oid.value, OID_ED25519)) return 'ed25519';
  if (equal(oid.value, OID_ED448)) return 'ed448';
  throw new DerError('X509: unsupported signature algorithm');
}

function bitString(el: DerElement): Bytes {
  if (el.tag !== 0x03 || el.value.length < 1 || el.value[0] !== 0) throw new DerError('X509: bad BIT STRING');
  return el.value.subarray(1);
}

export interface Certificate {
  raw: Bytes;
  tbs: Bytes;
  sigAlg: SignAlg;
  signature: Bytes;
  publicKey: PublicKey;
  notBefore?: Date;
  notAfter?: Date;
}

function parseTime(el: DerElement): Date | undefined {
  const s = new TextDecoder().decode(el.value);
  let m: RegExpMatchArray | null;
  if (el.tag === 0x17 && (m = s.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/))) {
    const y = Number(m[1]);
    return new Date(Date.UTC(y < 50 ? 2000 + y : 1900 + y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  }
  if (el.tag === 0x18 && (m = s.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/))) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  }
  return undefined;
}

export function parseCertificate(der: Bytes): Certificate {
  const cert = derParse(der);
  if (cert.tag !== 0x30) throw new DerError('X509: expected SEQUENCE');
  const [tbsEl, algEl, sigEl] = derChildren(cert);
  if (!tbsEl || !algEl || !sigEl) throw new DerError('X509: bad certificate');
  const tbs = derChildren(tbsEl);
  let i = 0;
  if (tbs[i]?.tag === 0xa0) i++; // version
  i++; // serialNumber
  i++; // signature AlgorithmIdentifier
  i++; // issuer
  const validity = tbs[i++];
  i++; // subject
  const spki = tbs[i];
  if (!spki || spki.tag !== 0x30) throw new DerError('X509: no SubjectPublicKeyInfo');
  let notBefore: Date | undefined;
  let notAfter: Date | undefined;
  if (validity?.tag === 0x30) {
    const [nb, na] = derChildren(validity);
    if (nb) notBefore = parseTime(nb);
    if (na) notAfter = parseTime(na);
  }
  return {
    raw: der,
    tbs: tbsEl.raw,
    sigAlg: sigAlgOf(algEl),
    signature: bitString(sigEl),
    publicKey: decodePubKey(spki.raw),
    notBefore,
    notAfter,
  };
}

export function signKeyOf(cert: Certificate): PublicKey<SignAlg> {
  const k = cert.publicKey;
  if (k.alg !== 'ed25519' && k.alg !== 'ed448') throw new DerError('X509: certificate key cannot sign');
  return k as PublicKey<SignAlg>;
}

/** checks that `cert` is signed by `issuer` */
export function signedBy(cert: Certificate, issuer: Certificate): boolean {
  const k = issuer.publicKey;
  if (k.alg !== cert.sigAlg) return false;
  return verify(k as PublicKey<SignAlg>, cert.signature, cert.tbs);
}

/**
 * X.509 SignedExact object (as produced by Simplex.Messaging.Crypto.signX509), used by servers to sign
 * their session DH keys: SEQUENCE { object, AlgorithmIdentifier, BIT STRING signature }.
 */
export interface SignedObject {
  object: Bytes;
  sigAlg: SignAlg;
  signature: Bytes;
}

export function parseSignedObject(der: Bytes): SignedObject {
  const el = derParse(der);
  if (el.tag !== 0x30) throw new DerError('SignedExact: expected SEQUENCE');
  const [obj, alg, sig] = derChildren(el);
  if (!obj || !alg || !sig) throw new DerError('SignedExact: bad structure');
  return { object: obj.raw, sigAlg: sigAlgOf(alg), signature: bitString(sig) };
}

/** the public key inside a signed object: either the SPKI itself or a SEQUENCE wrapping it */
export function signedObjectPubKey(obj: Bytes): PublicKey {
  try {
    return decodePubKey(obj);
  } catch {
    const el = derParse(obj);
    const [inner] = derChildren(el);
    if (!inner) throw new DerError('SignedExact: no key');
    return decodePubKey(inner.raw);
  }
}

export function verifySignedObject(so: SignedObject, key: PublicKey<SignAlg>): boolean {
  return key.alg === so.sigAlg && verify(key, so.signature, so.object);
}
