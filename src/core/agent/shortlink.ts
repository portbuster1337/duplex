// Short connection links (Simplex.Messaging.Crypto.ShortLink and ConnShortLink in Agent.Protocol):
// the connection request and user data are stored encrypted on the router, the link contains the key.
import { b64urlNoPad, equal, fromB64, randomBytes, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';
import { cbDecrypt, cbEncrypt, decPubKey, encPubKey, encodePubKey, hkdf, sha3_256, sign, verify, type KeyPair, type PrivateKey, type PublicKey } from '../crypto/crypto';
import { decE2EParamsUri, encE2EParamsUri, type E2EParamsUri } from '../crypto/ratchet';
import { decServer, encServer, type ProtocolServer } from '../smp/server';
import { decVR, encVR, type VersionRange } from '../util/version';
import { renderQuery, parseQuery, queryParam, decConnReqBinary, encConnReqBinary, type ConnectionRequest } from './protocol';
import type { QueueLinkData } from '../smp/protocol';
import { PRESET_SMP_SERVERS } from './presets';

const FIXED_DATA_PADDED_LENGTH = 2008;
const USER_DATA_PADDED_LENGTH = 13784;

export type ContactType = 'A' | 'C' | 'G' | 'R';

export type ShortLink =
  | { mode: 'invitation'; scheme: 'simplex' | 'server'; server: ProtocolServer; linkId: Bytes; linkKey: Bytes }
  | { mode: 'contact'; scheme: 'simplex' | 'server'; type: ContactType; server: ProtocolServer; linkKey: Bytes };

export function isShortLink(s: string): boolean {
  return /^(simplex:|https:\/\/[^/]+)\/[iacgr]#/.test(s.trim());
}

export function parseShortLink(s0: string): ShortLink {
  const s = s0.trim();
  const m = s.match(/^(simplex:|https:\/\/([^/?#]+))\/([iacgrIACGR])\/?#([^?]*)(?:\?(.*))?$/);
  if (!m) throw new ParseError('not a SimpleX short link');
  const scheme = m[1] === 'simplex:' ? 'simplex' : 'server';
  const hostInAuthority = m[2];
  const t = m[3];
  const frag = m[4];
  const q = parseQuery(m[5] ?? '');
  const hosts: string[] = [];
  if (hostInAuthority) hosts.push(hostInAuthority);
  const h = queryParam(q, 'h');
  if (h) hosts.push(...h.split(',').filter(Boolean));
  if (!hosts.length) throw new ParseError('short link without server');
  const port = queryParam(q, 'p') ?? '';
  const c = queryParam(q, 'c');
  let server: ProtocolServer = { scheme: 'smp', hosts, port, keyHash: c ? fromB64(c) : new Uint8Array(0) };
  server = restoreServer(server);
  if (t === 'i' || t === 'I') {
    const [lnkId, key] = frag.split('/');
    if (!lnkId || !key) throw new ParseError('bad invitation short link');
    return { mode: 'invitation', scheme, server, linkId: fromB64(lnkId), linkKey: fromB64(key) };
  }
  return { mode: 'contact', scheme, type: t.toUpperCase() as ContactType, server, linkKey: fromB64(frag) };
}

/** short links to preset routers omit the port and fingerprint */
function restoreServer(srv: ProtocolServer): ProtocolServer {
  if (srv.keyHash.length || srv.port) return srv;
  const p = PRESET_SMP_SERVERS.find((s) => s.hosts[0] === srv.hosts[0]);
  return p ?? srv;
}

function isPresetServer(srv: ProtocolServer): boolean {
  const p = PRESET_SMP_SERVERS.find((s) => s.hosts[0] === srv.hosts[0]);
  if (!p) return false;
  return srv.hosts.every((h) => p.hosts.includes(h)) && (srv.port === p.port || (!p.port && (srv.port === '443' || srv.port === '5223'))) && equal(srv.keyHash, p.keyHash);
}

export function strShortLink(l: ShortLink, short = true): string {
  const srv = l.server;
  const shorten = short && isPresetServer(srv);
  const hosts = shorten ? [srv.hosts[0]] : srv.hosts;
  const [authority, paramHosts] = l.scheme === 'simplex' ? ['simplex:', hosts] : [`https://${hosts[0]}`, hosts.slice(1)];
  const type = l.mode === 'invitation' ? 'i' : l.type.toLowerCase();
  const frag = l.mode === 'invitation' ? `${b64urlNoPad(l.linkId)}/${b64urlNoPad(l.linkKey)}` : b64urlNoPad(l.linkKey);
  const q: Array<[string, string]> = [];
  if (paramHosts.length) q.push(['h', paramHosts.join(',')]);
  if (!shorten) {
    if (srv.port) q.push(['p', srv.port]);
    if (srv.keyHash.length) q.push(['c', b64urlNoPad(srv.keyHash)]);
  }
  const qs = q.length ? '?' + renderQuery(q) : '';
  return `${authority}/${type}#${frag}${qs}`;
}

export function contactShortLinkKdf(linkKey: Bytes): { linkId: Bytes; key: Bytes } {
  const out = hkdf(new Uint8Array(0), linkKey, 'SimpleXContactLink', 56);
  return { linkId: out.slice(0, 24), key: out.slice(24) };
}

export function invShortLinkKdf(linkKey: Bytes): Bytes {
  return hkdf(new Uint8Array(0), linkKey, 'SimpleXInvLink', 32);
}

// ---- link data

export interface FixedLinkData {
  agentVersions: VersionRange;
  rootKey: PublicKey<'ed25519'>;
  connReq: ConnectionRequest;
  linkEntityId?: Bytes;
}

export interface OwnerAuth {
  ownerId: Bytes;
  ownerKey: PublicKey<'ed25519'>;
  sig: Bytes;
}

export interface UserContactData {
  direct: boolean;
  owners: OwnerAuth[];
  relays: ShortLink[];
  userData: Bytes;
  ratchetKeys?: { keyId: Bytes; e2e: E2EParamsUri };
}

export type ConnLinkData = { mode: 'invitation'; agentVersions: VersionRange; userData: Bytes } | { mode: 'contact'; agentVersions: VersionRange; data: UserContactData };

function encUserLinkData(e: Encoder, b: Bytes): Encoder {
  return b.length <= 254 ? e.bytes(b) : e.byte(255).large(b);
}

function decUserLinkData(d: Decoder): Bytes {
  if (d.peek() === 255) {
    d.byte();
    return d.large();
  }
  return d.bytes();
}

export function encShortLinkBinary(e: Encoder, l: ShortLink): Encoder {
  if (l.mode === 'invitation') return encServer(e.char('I'), l.server).bytes(l.linkId).bytes(l.linkKey);
  return encServer(e.char('C').char(l.type), l.server).bytes(l.linkKey);
}

function decShortLinkBinary(d: Decoder): ShortLink {
  const m = d.char();
  if (m === 'I') {
    const server = decServer(d);
    return { mode: 'invitation', scheme: 'server', server, linkId: d.bytes(), linkKey: d.bytes() };
  }
  if (m === 'C') {
    const type = d.char() as ContactType;
    if (!'ACGR'.includes(type)) throw new ParseError('bad contact type');
    const server = decServer(d);
    return { mode: 'contact', scheme: 'server', type, server, linkKey: d.bytes() };
  }
  throw new ParseError('bad short link');
}

export function encodeFixedData(fd: FixedLinkData): Bytes {
  const e = new Encoder();
  encVR(e, fd.agentVersions);
  encPubKey(e, fd.rootKey);
  encConnReqBinary(e, fd.connReq);
  if (fd.linkEntityId) e.bytes(fd.linkEntityId);
  return e.finish();
}

function decodeFixedData(b: Bytes): FixedLinkData {
  const d = new Decoder(b);
  const agentVersions = decVR(d);
  const rootKey = decPubKey(d, 'ed25519');
  const connReq = decConnReqBinary(d);
  let linkEntityId: Bytes | undefined;
  if (!d.atEnd()) {
    const id = d.optional((d) => d.bytes());
    if (id && id.length) linkEntityId = id;
  }
  return { agentVersions, rootKey, connReq, linkEntityId };
}

export function encodeLinkData(ld: ConnLinkData): Bytes {
  const e = new Encoder();
  if (ld.mode === 'invitation') {
    encVR(e.char('I'), ld.agentVersions);
    encUserLinkData(e, ld.userData);
  } else {
    encVR(e.char('C'), ld.agentVersions);
    const cd = ld.data;
    e.bool(cd.direct);
    e.list(cd.owners, (e, o) => {
      const inner = new Encoder().bytes(o.ownerId);
      encPubKey(inner, o.ownerKey);
      inner.bytes(o.sig);
      e.bytes(inner.finish());
    });
    e.list(cd.relays, encShortLinkBinary);
    encUserLinkData(e, cd.userData);
    e.maybe(cd.ratchetKeys, (e, rk) => encE2EParamsUri(e.bytes(rk.keyId), rk.e2e));
  }
  return e.finish();
}

function decodeLinkData(b: Bytes): ConnLinkData {
  const d = new Decoder(b);
  const m = d.char();
  const agentVersions = decVR(d);
  if (m === 'I') return { mode: 'invitation', agentVersions, userData: decUserLinkData(d) };
  if (m !== 'C') throw new ParseError('bad link data');
  const direct = d.bool();
  const owners = d.list((d) => {
    const inner = new Decoder(d.bytes());
    const ownerId = inner.bytes();
    const ownerKey = decPubKey(inner, 'ed25519');
    const sig = inner.bytes();
    return { ownerId, ownerKey, sig };
  });
  const relays = d.list(decShortLinkBinary);
  const userData = decUserLinkData(d);
  let ratchetKeys: UserContactData['ratchetKeys'];
  if (!d.atEnd()) ratchetKeys = d.optional((d) => d.maybe((d) => ({ keyId: d.bytes(), e2e: decE2EParamsUri(d) })));
  return { mode: 'contact', agentVersions, data: { direct, owners, relays, userData, ratchetKeys } };
}

function encodeSign(pk: PrivateKey<'ed25519'>, s: Bytes): Bytes {
  return new Encoder().bytes(sign(pk, s)).raw(s).finish();
}

export function encodeSignLinkData(root: KeyPair<'ed25519'>, fd: FixedLinkData, ld: ConnLinkData): { linkKey: Bytes; fixed: Bytes; user: Bytes } {
  const f = encodeFixedData(fd);
  return { linkKey: sha3_256(f), fixed: encodeSign(root.priv, f), user: encodeSign(root.priv, encodeLinkData(ld)) };
}

function encryptData(key: Bytes, s: Bytes, len: number): Bytes {
  const nonce = randomBytes(24);
  return new Encoder().raw(nonce).raw(cbEncrypt(key, nonce, s, len)).finish();
}

export function encryptLinkData(key: Bytes, fixed: Bytes, user: Bytes): QueueLinkData {
  return { fixedData: encryptData(key, fixed, FIXED_DATA_PADDED_LENGTH), userData: encryptData(key, user, USER_DATA_PADDED_LENGTH) };
}

export function encryptUserData(key: Bytes, user: Bytes): Bytes {
  return encryptData(key, user, USER_DATA_PADDED_LENGTH);
}

function decryptData(key: Bytes, b: Bytes): { sig: Bytes; data: Bytes } {
  const d = new Decoder(b);
  const nonce = d.take(24);
  const plain = cbDecrypt(key, nonce, d.rest());
  const pd = new Decoder(plain);
  const sig = pd.bytes();
  return { sig, data: pd.rest() };
}

export class LinkError extends Error {}

export function decryptLinkData(linkKey: Bytes, key: Bytes, ld: QueueLinkData): { fixed: FixedLinkData; user: ConnLinkData } {
  const f = decryptData(key, ld.fixedData);
  const u = decryptData(key, ld.userData);
  if (!equal(sha3_256(f.data), linkKey)) throw new LinkError('link data hash');
  const fixed = decodeFixedData(f.data);
  if (!verify(fixed.rootKey, f.sig, f.data)) throw new LinkError('link data signature');
  const user = decodeLinkData(u.data);
  const signedBy = (k: PublicKey<'ed25519'>) => verify(k, u.sig, u.data);
  if (user.mode === 'invitation') {
    if (!signedBy(fixed.rootKey)) throw new LinkError('user data signature');
  } else {
    validateOwners(fixed.rootKey, user.data.owners);
    if (!signedBy(fixed.rootKey) && !user.data.owners.some((o) => signedBy(o.ownerKey))) throw new LinkError('user data signature');
  }
  return { fixed, user };
}

function validateOwners(rootKey: PublicKey<'ed25519'>, owners: OwnerAuth[]): void {
  const prev: OwnerAuth[] = [];
  for (const o of owners) {
    if (equal(o.ownerKey.key, rootKey.key)) throw new LinkError('owner key matches root key');
    if (prev.some((p) => equal(p.ownerId, o.ownerId) || equal(p.ownerKey.key, o.ownerKey.key))) throw new LinkError('duplicate owner');
    const msg = new Uint8Array([...o.ownerId, ...encodePubKey(o.ownerKey)]);
    if (!verify(rootKey, o.sig, msg) && !prev.some((p) => verify(p.ownerKey, o.sig, msg))) throw new LinkError('invalid owner authorization');
    prev.push(o);
  }
}
