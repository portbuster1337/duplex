// SMP agent protocol encodings (Simplex.Messaging.Agent.Protocol): queue addresses, connection
// links, agent message envelopes and agent messages.
import { b64url, b64urlNoPad, fromB64, fromUtf8, fromUtf8Lossy, utf8, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';
import { decPubKey, decodePubKeyOf, encodePubKey, encPubKey, type PublicKey } from '../crypto/crypto';
import { decE2EParams, decE2EParamsUri, encE2EParams, encE2EParamsUri, type E2EParams, type E2EParamsUri, type KemParams } from '../crypto/ratchet';
import { decServer, encServer, parseServer, serverString, type ProtocolServer } from '../smp/server';
import { decVR, encVR, parseVR, strVR, type VersionRange } from '../util/version';
import type { QueueMode } from '../smp/protocol';

export const AGENT_VERSIONS: VersionRange = { min: 6, max: 7 };
export const RATCHET_ON_CONF_AGENT_VERSION = 7;
export const SMP_CLIENT_VERSIONS: VersionRange = { min: 1, max: 4 };
export const SHORT_LINKS_SMP_CLIENT_VERSION = 4;
export const SND_AUTH_KEY_SMP_CLIENT_VERSION = 3;
export const SRV_HOSTNAMES_SMP_CLIENT_VERSION = 2;

export const E2E_ENC_CONN_INFO_LENGTH = 14832;
export const E2E_ENC_AGENT_MSG_LENGTH = 15840;
/** with post-quantum encryption the ratchet headers are larger, so less is left for the content */
export const E2E_ENC_CONN_INFO_LENGTH_PQ = 11106;
export const E2E_ENC_AGENT_MSG_LENGTH_PQ = 13618;

// ---- query strings (http-types renderSimpleQuery / parseSimpleQuery)

function urlEncode(s: string): string {
  let out = '';
  for (const b of utf8(s)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function urlDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%' && i + 2 < s.length + 0 && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else if (c === '+') bytes.push(0x20);
    else for (const b of utf8(c)) bytes.push(b);
  }
  return fromUtf8Lossy(Uint8Array.from(bytes));
}

export type Query = Array<[string, string]>;

export function renderQuery(q: Query, escape = true): string {
  return q.map(([k, v]) => (escape ? `${urlEncode(k)}=${urlEncode(v)}` : `${k}=${v}`)).join('&');
}

export function parseQuery(s: string): Query {
  if (s.startsWith('?')) s = s.slice(1);
  if (!s) return [];
  return s
    .split(/[&;]/)
    .filter((p) => p.length)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [urlDecode(p), ''] : [urlDecode(p.slice(0, i)), urlDecode(p.slice(i + 1))];
    });
}

export function queryParam(q: Query, name: string): string | undefined {
  return q.find(([k]) => k === name)?.[1];
}

// ---- SMP queue addresses

export interface QueueAddress {
  server: ProtocolServer;
  senderId: Bytes;
  dhPublicKey: PublicKey<'x25519'>;
  queueMode?: QueueMode;
}

/** SMPQueueUri: queue address with SMP client version range */
export interface QueueUri {
  versions: VersionRange;
  addr: QueueAddress;
}

/** SMPQueueInfo: queue address with the agreed SMP client version */
export interface QueueInfo {
  version: number;
  addr: QueueAddress;
}

const EXTRA_SMP_HOSTS: Record<string, string> = {
  'smp4.simplex.im': 'o5vmywmrnaxalvz6wi3zicyftgio6psuvyniis6gco6bp6ekl4cqj4id.onion',
  'smp5.simplex.im': 'jjbyvoemxysm7qxap7m5d5m35jzv5qq6gnlv7s4rsn7tdwwmuqciwpid.onion',
  'smp6.simplex.im': 'bylepyau3ty4czmn77q4fglvperknl4bi2eb2fdy2bh4jxtf32kf73yd.onion',
  'smp8.simplex.im': 'beccx4yfxxbvyhqypaavemqurytl6hozr47wfc7uuecacjqdvwpw2xid.onion',
  'smp9.simplex.im': 'jssqzccmrcws6bhmn77vgmhfjmhwlyr3u7puw4erkyoosywgl67slqqd.onion',
  'smp10.simplex.im': 'rb2pbttocvnbrngnwziclp2f4ckjq65kebafws6g4hy22cdaiv5dwjqd.onion',
};

function updateServerHosts(srv: ProtocolServer): ProtocolServer {
  if (srv.hosts.length === 1 && EXTRA_SMP_HOSTS[srv.hosts[0]]) return { ...srv, hosts: [srv.hosts[0], EXTRA_SMP_HOSTS[srv.hosts[0]]] };
  return srv;
}

function encQueueModeTail(e: Encoder, minV: number, maxV: number, mode: QueueMode | undefined): void {
  const sndSecure = mode === 'M';
  if (minV >= SHORT_LINKS_SMP_CLIENT_VERSION) {
    if (mode) e.char(mode);
  } else if (minV >= SND_AUTH_KEY_SMP_CLIENT_VERSION || (maxV >= SND_AUTH_KEY_SMP_CLIENT_VERSION && sndSecure)) {
    e.bool(sndSecure);
  }
}

function decQueueModeTail(d: Decoder): QueueMode | undefined {
  if (d.atEnd()) return undefined;
  const c = String.fromCharCode(d.peek());
  if (c === 'M' || c === 'C') {
    d.pos++;
    return c;
  }
  if (c === 'T' || c === 'F') {
    d.pos++;
    return c === 'T' ? 'M' : 'C';
  }
  return undefined;
}

export function encQueueUri(e: Encoder, q: QueueUri): Encoder {
  encVR(e, q.versions);
  encServer(e, q.addr.server).bytes(q.addr.senderId);
  encPubKey(e, q.addr.dhPublicKey);
  encQueueModeTail(e, q.versions.min, q.versions.max, q.addr.queueMode);
  return e;
}

export function decQueueUri(d: Decoder): QueueUri {
  const versions = decVR(d);
  const server = decServer(d);
  const senderId = d.bytes();
  const dhPublicKey = decPubKey(d, 'x25519');
  const queueMode = decQueueModeTail(d);
  return { versions, addr: { server, senderId, dhPublicKey, queueMode } };
}

export function encQueueInfo(e: Encoder, q: QueueInfo): Encoder {
  const v = q.version;
  if (v > 1) {
    e.word16(v);
    encServer(e, q.addr.server).bytes(q.addr.senderId);
    encPubKey(e, q.addr.dhPublicKey);
    if (v >= SHORT_LINKS_SMP_CLIENT_VERSION) {
      if (q.addr.queueMode) e.char(q.addr.queueMode);
    } else if (v >= SND_AUTH_KEY_SMP_CLIENT_VERSION && q.addr.queueMode === 'M') e.bool(true);
    return e;
  }
  e.word16(v).bytes(utf8(q.addr.server.hosts[0])).bytes(utf8(q.addr.server.port)).bytes(q.addr.server.keyHash).bytes(q.addr.senderId);
  return encPubKey(e, q.addr.dhPublicKey);
}

export function decQueueInfo(d: Decoder): QueueInfo {
  const version = d.word16();
  let server: ProtocolServer;
  if (version > 1) server = decServer(d);
  else {
    const host = fromUtf8(d.bytes());
    const port = fromUtf8(d.bytes());
    const keyHash = d.bytes();
    server = updateServerHosts({ scheme: 'smp', hosts: [host], port, keyHash });
  }
  const senderId = d.bytes();
  const dhPublicKey = decPubKey(d, 'x25519');
  const queueMode = decQueueModeTail(d);
  return { version, addr: { server, senderId, dhPublicKey, queueMode } };
}

export function strQueueUri(q: QueueUri): string {
  const { addr, versions } = q;
  const params: Query = [
    ['v', strVR(versions)],
    ['dh', b64url(encodePubKey(addr.dhPublicKey))],
  ];
  if (addr.queueMode === 'M') params.push(['q', 'm']);
  else if (addr.queueMode === 'C') params.push(['q', 'c']);
  if (addr.queueMode === 'M' && versions.min < SHORT_LINKS_SMP_CLIENT_VERSION) params.push(['k', 's']);
  if (versions.min >= SRV_HOSTNAMES_SMP_CLIENT_VERSION) {
    return `${serverString(addr.server)}/${b64url(addr.senderId)}#/?${renderQuery(params)}`;
  }
  const srv = { ...addr.server, hosts: [addr.server.hosts[0]] };
  const extra = addr.server.hosts.slice(1);
  if (extra.length) params.push(['srv', extra.join(',')]);
  return `${serverString(srv)}/${b64url(addr.senderId)}#/?${renderQuery(params)}`;
}

export function parseQueueUri(s: string): QueueUri {
  const m = s.match(/^(smp:\/\/[^/]+)\/([A-Za-z0-9_-]+=*)\/?#(.*)$/);
  if (!m) throw new ParseError('bad SMP queue URI');
  const { server: srv0 } = parseServer(m[1]);
  const senderId = fromB64(m[2]);
  let frag = m[3];
  let dhKeyStr: string | undefined;
  if (!frag.startsWith('/?') && !frag.startsWith('?')) {
    const i = frag.indexOf('?');
    dhKeyStr = i < 0 ? frag : frag.slice(0, i);
    frag = i < 0 ? '' : frag.slice(i);
  }
  const q = parseQuery(frag.replace(/^\/?\?/, ''));
  const v = queryParam(q, 'v');
  const versions = v ? parseVR(v) : { min: 1, max: 1 };
  const dh = dhKeyStr ?? queryParam(q, 'dh');
  if (!dh) throw new ParseError('queue URI without DH key');
  const dhPublicKey = decodePubKeyOf(fromB64(dh), 'x25519');
  const srvHosts = queryParam(q, 'srv');
  let server = srvHosts ? { ...srv0, hosts: [...srv0.hosts, ...srvHosts.split(',').filter(Boolean)] } : srv0;
  if (versions.max < SRV_HOSTNAMES_SMP_CLIENT_VERSION) server = updateServerHosts(server);
  const qm = queryParam(q, 'q');
  const queueMode: QueueMode | undefined = qm === 'm' ? 'M' : qm === 'c' ? 'C' : queryParam(q, 'k') === 's' ? 'M' : undefined;
  return { versions, addr: { server, senderId, dhPublicKey, queueMode } };
}

// ---- connection requests (full links)

export type ConnMode = 'invitation' | 'contact';

export interface ConnReqData {
  /** 'simplex' or an app server host such as simplex.chat */
  scheme: string;
  agentVersions: VersionRange;
  queues: QueueUri[];
  clientData?: string;
}

export type ConnectionRequest =
  | { mode: 'invitation'; data: ConnReqData; e2e: E2EParamsUri }
  | { mode: 'contact'; data: ConnReqData; ratchetKeys?: { keyId: Bytes; e2e: E2EParamsUri } };

function strE2E(p: E2EParamsUri): string {
  const q: Query = [
    ['v', strVR(p.versions)],
    ['x3dh', [p.k1, p.k2].map((k) => b64url(encodePubKey(k))).join(',')],
  ];
  if (p.kem?.tag === 'P') q.push(['kem_key', b64url(p.kem.key)]);
  else if (p.kem?.tag === 'A') q.push(['kem_ct', b64url(p.kem.ct)], ['kem_key', b64url(p.kem.key)]);
  return renderQuery(q, false);
}

function parseE2E(s: string): E2EParamsUri {
  const q = parseQuery(s);
  const v = queryParam(q, 'v');
  const x3dh = queryParam(q, 'x3dh');
  if (!v || !x3dh) throw new ParseError('bad e2e params');
  let versions = parseVR(v);
  // adjustE2EVRange: old links are upgraded to the minimum supported version
  const minV = Math.max(3, versions.min);
  if (minV <= Math.max(minV, versions.max)) versions = { min: minV, max: Math.max(minV, versions.max) };
  const keys = x3dh.split(',');
  if (keys.length !== 2) throw new ParseError('bad e2e params keys');
  const k1 = decodePubKeyOf(fromB64(keys[0]), 'x448');
  const k2 = decodePubKeyOf(fromB64(keys[1]), 'x448');
  const kk = queryParam(q, 'kem_key');
  const kc = queryParam(q, 'kem_ct');
  let kem: KemParams | undefined;
  if (kk) kem = kc ? { tag: 'A', ct: fromB64(kc), key: fromB64(kk) } : { tag: 'P', key: fromB64(kk) };
  else if (kc) throw new ParseError('kem_ct without kem_key');
  return { versions, k1, k2, kem };
}

export function strConnReq(cr: ConnectionRequest): string {
  const scheme = cr.data.scheme === 'simplex' ? 'simplex:' : `https://${cr.data.scheme}`;
  const q: Query = [
    ['v', strVR(cr.data.agentVersions)],
    ['smp', cr.data.queues.map(strQueueUri).join(';')],
  ];
  if (cr.mode === 'invitation') q.push(['e2e', strE2E(cr.e2e)]);
  else if (cr.ratchetKeys) q.push(['e2e', strE2E(cr.ratchetKeys.e2e)], ['rk', b64url(cr.ratchetKeys.keyId)]);
  if (cr.data.clientData !== undefined) q.push(['data', cr.data.clientData]);
  return `${scheme}/${cr.mode}#/?${renderQuery(q)}`;
}

export function parseConnReq(s0: string): ConnectionRequest {
  const s = s0.trim();
  const m = s.match(/^(simplex:|https:\/\/([^/]+))\/(invitation|contact)\/?#\/?\?(.*)$/);
  if (!m) throw new ParseError('not a SimpleX connection link');
  const scheme = m[1] === 'simplex:' ? 'simplex' : m[2];
  const mode = m[3] as ConnMode;
  const q = parseQuery(m[4]);
  const v = queryParam(q, 'v');
  const smp = queryParam(q, 'smp');
  if (!v || !smp) throw new ParseError('bad connection link');
  let agentVersions = parseVR(v);
  const queues = smp.split(';').filter(Boolean).map(parseQueueUri);
  if (!queues.length) throw new ParseError('connection link without queues');
  const clientData = queryParam(q, 'data');
  const data: ConnReqData = { scheme, agentVersions, queues, clientData };
  if (mode === 'invitation') {
    const e2e = queryParam(q, 'e2e');
    if (!e2e) throw new ParseError('invitation without e2e params');
    return { mode, data, e2e: parseE2E(e2e) };
  }
  // contact links are adjusted to the minimum supported agent version
  const minV = Math.max(AGENT_VERSIONS.min, agentVersions.min);
  agentVersions = { min: minV, max: Math.max(minV, agentVersions.max) };
  data.agentVersions = agentVersions;
  const e2e = queryParam(q, 'e2e');
  const rk = queryParam(q, 'rk');
  return { mode, data, ratchetKeys: e2e && rk ? { keyId: fromB64(rk), e2e: parseE2E(e2e) } : undefined };
}

/** binary connection request (inside short link data) */
export function encConnReqBinary(e: Encoder, cr: ConnectionRequest): Encoder {
  e.char(cr.mode === 'invitation' ? 'I' : 'C');
  encVR(e, cr.data.agentVersions);
  e.list(cr.data.queues, encQueueUri);
  e.maybe(cr.data.clientData, (e, d) => e.large(utf8(d)));
  if (cr.mode === 'invitation') encE2EParamsUri(e, cr.e2e);
  return e;
}

export function decConnReqBinary(d: Decoder): ConnectionRequest {
  const c = d.char();
  const agentVersions = decVR(d);
  const queues = d.nonEmpty(decQueueUri).map((q) => (q.addr.queueMode ? q : { ...q, addr: { ...q.addr, queueMode: 'C' as QueueMode } }));
  const clientData = d.maybe((d) => fromUtf8Lossy(d.large()));
  const data: ConnReqData = { scheme: 'simplex', agentVersions, queues, clientData };
  if (c === 'I') return { mode: 'invitation', data, e2e: decE2EParamsUri(d) };
  if (c === 'C') return { mode: 'contact', data };
  throw new ParseError('bad connection mode');
}

// ---- agent message envelopes

export type AgentMsgEnvelope =
  | { tag: 'C'; agentVersion: number; e2e?: E2EParams; encConnInfo: Bytes }
  | { tag: 'M'; agentVersion: number; encAgentMessage: Bytes }
  | { tag: 'I'; agentVersion: number; connReq: ConnectionRequest; connInfo: Bytes }
  | { tag: 'A'; agentVersion: number; e2e: E2EParams; ratchetKeyId: Bytes; encConnInfo: Bytes }
  | { tag: 'R'; agentVersion: number; e2e: E2EParams; info: Bytes };

export function encodeAgentEnvelope(env: AgentMsgEnvelope): Bytes {
  const e = new Encoder().word16(env.agentVersion).char(env.tag);
  switch (env.tag) {
    case 'C':
      e.maybe(env.e2e, encE2EParams).raw(env.encConnInfo);
      break;
    case 'M':
      e.raw(env.encAgentMessage);
      break;
    case 'I':
      e.large(utf8(strConnReq(env.connReq))).raw(env.connInfo);
      break;
    case 'A':
      encE2EParams(e, env.e2e).bytes(env.ratchetKeyId).raw(env.encConnInfo);
      break;
    case 'R':
      encE2EParams(e, env.e2e).raw(env.info);
      break;
  }
  return e.finish();
}

export function parseAgentEnvelope(b: Bytes): AgentMsgEnvelope {
  const d = new Decoder(b);
  const agentVersion = d.word16();
  const tag = d.char();
  switch (tag) {
    case 'C': {
      const e2e = d.maybe(decE2EParams);
      return { tag, agentVersion, e2e, encConnInfo: d.rest() };
    }
    case 'M':
      return { tag, agentVersion, encAgentMessage: d.rest() };
    case 'I': {
      const connReq = parseConnReq(fromUtf8(d.large()));
      return { tag, agentVersion, connReq, connInfo: d.rest() };
    }
    case 'A': {
      const e2e = decE2EParams(d);
      const ratchetKeyId = d.bytes();
      return { tag, agentVersion, e2e, ratchetKeyId, encConnInfo: d.rest() };
    }
    case 'R': {
      const e2e = decE2EParams(d);
      return { tag, agentVersion, e2e, info: d.rest() };
    }
  }
  throw new ParseError('bad AgentMsgEnvelope');
}

// ---- agent messages (inside the double ratchet)

export interface MsgReceiptOut {
  agentMsgId: number;
  msgHash: Bytes;
  rcptInfo: Bytes;
}

export type SndQAddr = { server: ProtocolServer; senderId: Bytes };

export type AMessage =
  | { tag: 'HELLO' }
  | { tag: 'A_MSG'; body: Bytes }
  | { tag: 'A_RCVD'; receipts: MsgReceiptOut[] }
  | { tag: 'A_QCONT'; addr: SndQAddr }
  | { tag: 'EREADY'; lastMsgId: number }
  | { tag: 'Q'; sub: string; raw: Bytes };

export type AgentMessage =
  | { tag: 'I'; connInfo: Bytes }
  | { tag: 'D'; replyQueues: QueueInfo[]; connInfo: Bytes }
  | { tag: 'R'; answeredKeyHash?: Bytes }
  | { tag: 'M'; sndMsgId: number; prevMsgHash: Bytes; msg: AMessage }
  | { tag: 'J'; reason: Bytes }
  | { tag: 'OTHER'; type: string };

export function encodeAgentMessage(m: AgentMessage): Bytes {
  const e = new Encoder().char(m.tag === 'OTHER' ? '?' : m.tag);
  switch (m.tag) {
    case 'I':
      e.raw(m.connInfo);
      break;
    case 'D':
      e.list(m.replyQueues, encQueueInfo).raw(m.connInfo);
      break;
    case 'R':
      e.maybe(m.answeredKeyHash, (e, h) => e.bytes(h));
      break;
    case 'M': {
      e.int64(m.sndMsgId).bytes(m.prevMsgHash);
      const a = m.msg;
      switch (a.tag) {
        case 'HELLO':
          e.char('H');
          break;
        case 'A_MSG':
          e.char('M').raw(a.body);
          break;
        case 'A_RCVD':
          e.char('V').list(a.receipts, (e, r) => e.int64(r.agentMsgId).bytes(r.msgHash).large(r.rcptInfo));
          break;
        case 'A_QCONT':
          encServer(e.str('QC'), a.addr.server).bytes(a.addr.senderId);
          break;
        case 'EREADY':
          e.char('E').int64(a.lastMsgId);
          break;
        case 'Q':
          e.str('Q' + a.sub).raw(a.raw);
          break;
      }
      break;
    }
    case 'J':
      e.raw(m.reason);
      break;
  }
  return e.finish();
}

export function parseAgentMessage(b: Bytes): AgentMessage {
  const d = new Decoder(b);
  const tag = d.char();
  switch (tag) {
    case 'I':
      return { tag, connInfo: d.rest() };
    case 'D': {
      const replyQueues = d.nonEmpty(decQueueInfo);
      return { tag, replyQueues, connInfo: d.rest() };
    }
    case 'R':
      return { tag, answeredKeyHash: d.atEnd() ? undefined : d.optional((d) => d.maybe((d) => d.bytes())) };
    case 'M': {
      const sndMsgId = d.int64n();
      const prevMsgHash = d.bytes();
      const t = d.char();
      let msg: AMessage;
      switch (t) {
        case 'H':
          msg = { tag: 'HELLO' };
          break;
        case 'M':
          msg = { tag: 'A_MSG', body: d.rest() };
          break;
        case 'V':
          msg = { tag: 'A_RCVD', receipts: d.nonEmpty((d) => ({ agentMsgId: d.int64n(), msgHash: d.bytes(), rcptInfo: d.large() })) };
          break;
        case 'Q': {
          const sub = d.char();
          if (sub === 'C') {
            const server = decServer(d);
            msg = { tag: 'A_QCONT', addr: { server, senderId: d.bytes() } };
          } else msg = { tag: 'Q', sub, raw: d.rest() };
          break;
        }
        case 'E':
          msg = { tag: 'EREADY', lastMsgId: d.int64n() };
          break;
        default:
          throw new ParseError(`bad AMessage type ${t}`);
      }
      return { tag, sndMsgId, prevMsgHash, msg };
    }
    case 'J':
      return { tag, reason: d.rest() };
    default:
      return { tag: 'OTHER', type: tag };
  }
}

export { b64urlNoPad };
