// SMP agent: duplex connections over pairs of SMP queues, with the fast connection handshake
// (sender-secured queues), double ratchet e2e encryption, message integrity, delivery receipts,
// contact addresses and short links (Simplex.Messaging.Agent).
import { b64url, b64urlNoPad, equal, randomBytes, toHex, type Bytes } from '../util/bytes';
import { dh, generateKeyPair, sha256, sha3_384, sign, cbDecrypt, cbEncrypt, CryptoError, type KeyPair, type PrivateKey, type PublicKey } from '../crypto/crypto';
import {
  E2E_VERSIONS,
  generateE2EParams,
  initRcvRatchet,
  initSndRatchet,
  pqX3dhRcv,
  pqX3dhSnd,
  ratchetDecrypt,
  ratchetEncrypt,
  replyKem,
  RatchetError,
  type E2EParams,
  type E2EPrivParams,
  type Ratchet,
  type SkippedKeys,
} from '../crypto/ratchet';
import { compatibleVersion, isCompatible, type VersionRange } from '../util/version';
import { serverKey, type ProtocolServer } from '../smp/server';
import {
  decryptRcvMsg,
  encodeClientMessage,
  encodeClientMsgEnvelope,
  E2E_ENC_CONFIRMATION_LENGTH,
  E2E_ENC_MESSAGE_LENGTH,
  parseClientMessage,
  parseClientMsgEnvelope,
  SMPError,
  type BrokerMsg,
  type QueueLinkData,
  type QueueMode,
  type QueueReqData,
} from '../smp/protocol';
import type { Connector, SMPClient } from '../smp/client';
import {
  AGENT_VERSIONS,
  E2E_ENC_AGENT_MSG_LENGTH,
  E2E_ENC_AGENT_MSG_LENGTH_PQ,
  E2E_ENC_CONN_INFO_LENGTH,
  E2E_ENC_CONN_INFO_LENGTH_PQ,
  encodeAgentEnvelope,
  encodeAgentMessage,
  parseAgentEnvelope,
  parseAgentMessage,
  parseConnReq,
  SMP_CLIENT_VERSIONS,
  strConnReq,
  type AgentMessage,
  type AMessage,
  type ConnectionRequest,
  type QueueInfo,
  type QueueUri,
} from './protocol';
import {
  contactShortLinkKdf,
  decryptLinkData,
  encodeSignLinkData,
  encryptLinkData,
  encodeLinkData,
  encryptUserData,
  invShortLinkKdf,
  isShortLink,
  parseShortLink,
  strShortLink,
  type ConnLinkData,
  type FixedLinkData,
  type ShortLink,
} from './shortlink';
import { DEFAULT_ROUTING, Network, type ProxyFallback, type ProxyMode } from './network';
import { PRESET_SMP_SERVERS } from './presets';
import { Encoder } from '../util/encoding';

export interface RcvQueue {
  server: ProtocolServer;
  rcvId: Bytes;
  sndId: Bytes;
  rcvPrivKey: PrivateKey<'ed25519'>;
  rcvDhSecret: Bytes;
  e2ePrivKey: PrivateKey<'x25519'>;
  e2ePubKey: PublicKey<'x25519'>;
  e2eDhSecret?: Bytes;
  queueMode?: QueueMode;
  status: 'new' | 'confirmed' | 'secured' | 'active';
  smpClientVersion: number;
  shortLink?: ShortLinkCreds;
}

export interface ShortLinkCreds {
  linkId: Bytes;
  linkKey: Bytes;
  rootPriv: PrivateKey<'ed25519'>;
  rootPub: PublicKey<'ed25519'>;
  encFixedData: Bytes;
  link: string;
}

export interface SndQueue {
  server: ProtocolServer;
  sndId: Bytes;
  queueMode?: QueueMode;
  sndPrivKey: PrivateKey<'ed25519'>;
  sndPubKey: PublicKey<'ed25519'>;
  e2eDhSecret: Bytes;
  e2ePubKey: PublicKey<'x25519'>;
  status: 'new' | 'secured' | 'confirmed' | 'active';
  smpClientVersion: number;
}

export interface PendingSend {
  id: number;
  kind: 'skey' | 'conf' | 'msg' | 'rcpt' | 'hello';
  /** SEND body (ClientMsgEnvelope), absent for SKEY */
  body?: Bytes;
  notification: boolean;
  /** sign with the sender key (false for unsecured confirmations) */
  signed: boolean;
  /** agent message ID reported in SENT/MERR */
  msgId?: number;
  createdAt: number;
  attempts: number;
}

export interface ContactRequest {
  invId: string;
  connReq: string;
  connInfo: Bytes;
  receivedAt: number;
}

export type ConnStatus = 'new' | 'joining' | 'joined' | 'confirmed' | 'allowed' | 'ready' | 'address' | 'deleted';

export interface Conn {
  id: string;
  mode: 'invitation' | 'contact';
  status: ConnStatus;
  agentVersion: number;
  rcv?: RcvQueue;
  snd?: SndQueue;
  /** the initiator's X3DH keys from the invitation, until the confirmation */
  x3dh?: E2EPrivParams;
  ratchet?: Ratchet;
  skipped: SkippedKeys;
  /** confirmation received by the initiating party, until allowConnection */
  confirmation?: { replyQueues: QueueInfo[]; connInfo: Bytes; senderKey?: PublicKey };
  rcvLastExtId: number;
  rcvLastHash: Bytes;
  rcvInternalId: number;
  /** hashes of recently received encrypted messages, to detect redelivered duplicates */
  rcvEncHashes: string[];
  sndInternalId: number;
  sndLastHash: Bytes;
  /** hashes of sent messages, to check delivery receipts */
  sentHashes: Record<number, string>;
  pending: PendingSend[];
  nextPendingId: number;
  requests?: Record<string, ContactRequest>;
  link?: string;
  createdAt: number;
  quotaPaused?: boolean;
  /** post-quantum encryption is supported (and proposed) in this connection: larger headers, smaller messages */
  pqSupport?: boolean;
}

export type AgentEvent =
  | { type: 'CONF'; connId: string; connInfo: Bytes }
  | { type: 'INFO'; connId: string; connInfo: Bytes }
  | { type: 'CON'; connId: string }
  | { type: 'REQ'; connId: string; invId: string; connInfo: Bytes }
  | { type: 'MSG'; connId: string; msgId: number; sndMsgId: number; body: Bytes; brokerTs: number; integrity?: string; notification: boolean }
  | { type: 'RCVD'; connId: string; receipts: Array<{ msgId: number; ok: boolean }> }
  | { type: 'SENT'; connId: string; msgId: number }
  | { type: 'MERR'; connId: string; msgId: number; err: string }
  | { type: 'ERR'; connId?: string; err: string }
  | { type: 'END'; connId: string }
  | { type: 'DELD'; connId: string }
  | { type: 'UP'; server: ProtocolServer }
  | { type: 'DOWN'; server: ProtocolServer; err?: string };

/**
 * returned by event handlers, as handlers run while the connection is locked and cannot call
 * agent methods for the same connection: MSG - send a delivery receipt; CONF - allow the
 * connection with this connection info; REQ - accept the contact request with this info
 */
export interface MsgResult {
  receipt?: boolean;
  allow?: Bytes;
  accept?: Bytes;
}

export interface AgentStore {
  loadConns(): Promise<Conn[]>;
  saveConn(c: Conn): Promise<void>;
  deleteConn(id: string): Promise<void>;
}

export class MemoryAgentStore implements AgentStore {
  conns = new Map<string, Conn>();
  async loadConns(): Promise<Conn[]> {
    return [...this.conns.values()].map((c) => structuredClone(c));
  }
  async saveConn(c: Conn): Promise<void> {
    this.conns.set(c.id, structuredClone(c));
  }
  async deleteConn(id: string): Promise<void> {
    this.conns.delete(id);
  }
}

export interface AgentConfig {
  /** routers for new queues */
  servers: ProtocolServer[];
  /** create short links (default true) */
  shortLinks?: boolean;
  /** private message routing; by default for routers the user does not use, as in the apps */
  routing?: { mode: ProxyMode; fallback: ProxyFallback };
  /** post-quantum encryption for new connections (default true, as the apps do for contacts) */
  pq?: boolean;
}

export class AgentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AgentError';
  }
}

export interface ResolvedLink {
  link: string;
  connReq: ConnectionRequest;
  shortLink?: ShortLink;
  /** user data stored with the short link (e.g. the chat profile) */
  userData?: Bytes;
  /** sender key that secured the queue with LKEY (invitation short links) */
  sndKey?: KeyPair<'ed25519'>;
  linkData?: { fixed: FixedLinkData; user: ConnLinkData };
}

const MAX_SENT_HASHES = 1000;
const DEBUG = typeof process !== 'undefined' && !!process.env?.DEBUG_AGENT;
const MAX_ENC_HASHES = 200;

function newConnId(): string {
  return b64urlNoPad(randomBytes(12));
}

function qKey(srv: ProtocolServer, id: Bytes): string {
  return serverKey(srv) + '/' + b64url(id);
}

function checkIntegrity(prevExtId: number, extId: number, prevHash: Bytes, receivedPrevHash: Bytes): string | undefined {
  if (extId === prevExtId + 1 && equal(prevHash, receivedPrevHash)) return undefined;
  if (extId < prevExtId) return `bad message ID ${extId}`;
  if (extId === prevExtId) return 'duplicate message';
  if (extId > prevExtId + 1) return `skipped messages ${prevExtId + 1}..${extId - 1}`;
  return 'bad message hash';
}

/** verificationCode of simplex-chat: the hash as a decimal number, in groups of 5 digits */
export function securityCode(hash: Bytes): string {
  return BigInt('0x' + (toHex(hash) || '0'))
    .toString()
    .replace(/(\d{5})(?=\d)/g, '$1 ');
}

const connInfoLength = (c: Conn) => (c.pqSupport ? E2E_ENC_CONN_INFO_LENGTH_PQ : E2E_ENC_CONN_INFO_LENGTH);

export function isNetworkError(e: unknown): boolean {
  return !(e instanceof SMPError) && !(e instanceof AgentError) && !(e instanceof CryptoError);
}

export class Agent {
  readonly network: Network;
  /** awaited for each event; MSG handlers may request a delivery receipt */
  onEvent: (e: AgentEvent) => Promise<MsgResult | void> | MsgResult | void = () => {};
  private conns = new Map<string, Conn>();
  private rcvIndex = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private sending = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private serverIdx = Math.floor(Math.random() * 1000);

  constructor(
    private store: AgentStore,
    connector: Connector,
    public config: AgentConfig,
  ) {
    this.network = new Network(connector, {
      onMessage: (srv, entityId, msg) => this.onRouterMessage(srv, entityId, msg),
      onConnected: (srv, client) => this.onConnected(srv, client),
      onDisconnected: (srv, err) => void this.emit({ type: 'DOWN', server: srv, err: err?.message }),
    });
    const cfg = () => this.config;
    this.network.routing = {
      get mode() {
        return cfg().routing?.mode ?? DEFAULT_ROUTING.mode;
      },
      get fallback() {
        return cfg().routing?.fallback ?? DEFAULT_ROUTING.fallback;
      },
      known: () => [...cfg().servers, ...PRESET_SMP_SERVERS],
      proxies: () => cfg().servers,
    };
  }

  private async emit(e: AgentEvent): Promise<MsgResult | void> {
    try {
      return await this.onEvent(e);
    } catch (err) {
      console.error('agent event handler error', e.type, err);
    }
  }

  async start(): Promise<void> {
    for (const c of await this.store.loadConns()) {
      c.rcvEncHashes ??= [];
      this.conns.set(c.id, c);
      if (c.rcv) this.rcvIndex.set(qKey(c.rcv.server, c.rcv.rcvId), c.id);
    }
    const servers = new Map<string, ProtocolServer>();
    for (const c of this.conns.values()) {
      if (c.rcv && c.status !== 'deleted') servers.set(serverKey(c.rcv.server), c.rcv.server);
    }
    for (const s of servers.values()) this.network.keep(s);
    for (const c of this.conns.values()) if (c.pending.length) this.kickSend(c.id);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    this.network.stop();
  }

  /** resolves when the operations that were running when the agent stopped have finished */
  async idle(): Promise<void> {
    while (this.locks.size) await Promise.all([...this.locks.values()]);
  }

  getConn(id: string): Conn | undefined {
    return this.conns.get(id);
  }

  /** whether the connection supports post-quantum encryption (and has the smaller message limits) */
  pqSupport(connId: string): boolean {
    return !!this.conns.get(connId)?.pqSupport;
  }

  /** whether messages are post-quantum encrypted in both directions now */
  pqEncryption(connId: string): boolean {
    const rc = this.conns.get(connId)?.ratchet;
    return !!rc?.sndKEM && !!rc.rcvKEM;
  }

  /** the security code of a connection, which both parties can compare (codeAD in simplexmq) */
  securityCode(connId: string): string | undefined {
    const ad = this.conns.get(connId)?.ratchet?.ad;
    return ad ? securityCode(sha256(ad)) : undefined;
  }

  allConns(): Conn[] {
    return [...this.conns.values()];
  }

  private async withLock<T>(id: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(f, f);
    const done = next.catch(() => {});
    this.locks.set(id, done);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === done) this.locks.delete(id);
    }
  }

  private async save(c: Conn): Promise<void> {
    this.conns.set(c.id, c);
    if (c.rcv) this.rcvIndex.set(qKey(c.rcv.server, c.rcv.rcvId), c.id);
    await this.store.saveConn(c);
  }

  private nextServer(): ProtocolServer {
    const s = this.config.servers;
    if (!s.length) throw new AgentError('no SMP servers configured');
    return s[this.serverIdx++ % s.length];
  }

  private newConn(mode: 'invitation' | 'contact', status: ConnStatus): Conn {
    return {
      id: newConnId(),
      mode,
      status,
      agentVersion: AGENT_VERSIONS.max,
      skipped: {},
      rcvLastExtId: 0,
      rcvLastHash: new Uint8Array(0),
      rcvInternalId: 0,
      rcvEncHashes: [],
      sndInternalId: 0,
      sndLastHash: new Uint8Array(0),
      sentHashes: {},
      pending: [],
      nextPendingId: 1,
      createdAt: Date.now(),
    };
  }

  // ---- receive queues

  /**
   * creates a queue; with `link`, the link data is stored with the queue (the sender ID is derived
   * from the correlation ID so that it can be included in the link data before the queue exists)
   */
  private async newRcvQueue(
    srv: ProtocolServer,
    mode: QueueMode,
    smpClientVersion = SMP_CLIENT_VERSIONS.max,
    link?: (sndId: Bytes, e2ePub: PublicKey<'x25519'>) => { linkId?: Bytes; data: QueueLinkData },
  ): Promise<{ rq: RcvQueue; linkId?: Bytes }> {
    const auth = generateKeyPair('ed25519');
    const dhKeys = generateKeyPair('x25519');
    const e2e = generateKeyPair('x25519');
    const client = await this.network.get(srv);
    const corrId = randomBytes(24);
    let reqData: QueueReqData = { mode };
    let expectSndId: Bytes | undefined;
    let linkId: Bytes | undefined;
    if (link) {
      expectSndId = sha3_384(corrId).slice(0, 24);
      const l = link(expectSndId, e2e.pub);
      linkId = l.linkId;
      reqData = mode === 'M' ? { mode, link: { sndId: expectSndId, data: l.data } } : { mode, link: { linkId: l.linkId!, sndId: expectSndId, data: l.data } };
    }
    const r = await client.sendCommand(new Uint8Array(0), { tag: 'NEW', rcvAuthKey: auth.pub, rcvDhKey: dhKeys.pub, subscribe: true, reqData }, auth.priv, corrId);
    if (r.tag !== 'IDS') throw new AgentError(`unexpected response to NEW: ${r.tag}`);
    if (expectSndId && !equal(r.sndId, expectSndId)) throw new AgentError('router returned a different sender ID');
    if (linkId && r.linkId && !equal(r.linkId, linkId)) throw new AgentError('router returned a different link ID');
    if (link && !r.linkId) throw new AgentError('router did not store the link');
    const rq: RcvQueue = {
      server: srv,
      rcvId: r.rcvId,
      sndId: r.sndId,
      rcvPrivKey: auth.priv,
      rcvDhSecret: dh(r.srvDhKey, dhKeys.priv),
      e2ePrivKey: e2e.priv,
      e2ePubKey: e2e.pub,
      queueMode: r.queueMode ?? mode,
      status: 'new',
      smpClientVersion,
    };
    this.network.keep(srv);
    return { rq, linkId: r.linkId };
  }

  private queueUri(rq: RcvQueue, versions: VersionRange = SMP_CLIENT_VERSIONS): QueueUri {
    return { versions, addr: { server: rq.server, senderId: rq.sndId, dhPublicKey: rq.e2ePubKey, queueMode: rq.queueMode } };
  }

  // ---- 1-time invitations (the initiating party)

  /** creates a 1-time invitation link; userData (e.g. the chat profile) is stored with the short link */
  async createInvitation(opts: { userData?: Bytes; shortLink?: boolean; pq?: boolean } = {}): Promise<{ connId: string; link: string; fullLink: string }> {
    const c = this.newConn('invitation', 'new');
    const srv = this.nextServer();
    const short = opts.shortLink ?? this.config.shortLinks ?? true;
    c.pqSupport = opts.pq ?? this.config.pq ?? true;
    // the KEM key is too large for full links: then it is proposed on the first ratchet step
    const { priv, params } = generateE2EParams(E2E_VERSIONS.max, c.pqSupport && short ? { tag: 'propose' } : undefined);
    c.x3dh = priv;
    const e2eUri = { versions: E2E_VERSIONS, k1: params.k1, k2: params.k2, kem: params.kem };
    const mkReq = (q: QueueUri): ConnectionRequest => ({ mode: 'invitation', data: { scheme: 'simplex', agentVersions: AGENT_VERSIONS, queues: [q] }, e2e: e2eUri });
    let connReq!: ConnectionRequest;
    if (short) {
      const root = generateKeyPair('ed25519');
      let linkKey!: Bytes;
      let encFixed!: Bytes;
      const { rq, linkId } = await this.newRcvQueue(srv, 'M', SMP_CLIENT_VERSIONS.max, (sndId, e2ePub) => {
        connReq = mkReq({ versions: SMP_CLIENT_VERSIONS, addr: { server: srv, senderId: sndId, dhPublicKey: e2ePub, queueMode: 'M' } });
        const s = encodeSignLinkData(root, { agentVersions: AGENT_VERSIONS, rootKey: root.pub, connReq }, { mode: 'invitation', agentVersions: AGENT_VERSIONS, userData: opts.userData ?? new Uint8Array(0) });
        linkKey = s.linkKey;
        const data = encryptLinkData(invShortLinkKdf(linkKey), s.fixed, s.user);
        encFixed = data.fixedData;
        return { data };
      });
      const link = strShortLink({ mode: 'invitation', scheme: 'server', server: srv, linkId: linkId!, linkKey });
      rq.shortLink = { linkId: linkId!, linkKey, rootPriv: root.priv, rootPub: root.pub, encFixedData: encFixed, link };
      c.rcv = rq;
      c.link = link;
    } else {
      const { rq } = await this.newRcvQueue(srv, 'M');
      c.rcv = rq;
      connReq = mkReq(this.queueUri(rq));
      c.link = strConnReq(connReq);
    }
    await this.save(c);
    return { connId: c.id, link: c.link!, fullLink: strConnReq(connReq) };
  }

  /** the initiating party continues the connection after CONF, sending its connection info */
  async allowConnection(connId: string, connInfo: Bytes): Promise<void> {
    await this.withLock(connId, () => this.allowConn(this.mustConn(connId), connInfo));
    this.kickSend(connId);
  }

  private async allowConn(c: Conn, connInfo: Bytes): Promise<void> {
    if (c.status !== 'confirmed' || !c.confirmation || !c.ratchet || !c.rcv) throw new AgentError('allowConnection: no confirmation');
    const { replyQueues, senderKey } = c.confirmation;
    if (senderKey) await this.network.send(c.rcv.server, c.rcv.rcvId, { tag: 'KEY', sndKey: senderKey }, c.rcv.rcvPrivKey);
    const qi = replyQueues[0];
    if (!isCompatible(qi.version, SMP_CLIENT_VERSIONS)) throw new AgentError('incompatible reply queue version');
    c.snd = this.newSndQueue(qi.addr, qi.version);
    const sndSecure = c.snd.queueMode === 'M';
    if (sndSecure) this.addPending(c, { kind: 'skey', notification: false, signed: true });
    const am = encodeAgentMessage({ tag: 'I', connInfo });
    c.sndInternalId = 1;
    c.sndLastHash = sha256(am);
    const { enc, rc } = ratchetEncrypt(c.ratchet, am, connInfoLength(c));
    c.ratchet = rc;
    const env = encodeAgentEnvelope({ tag: 'C', agentVersion: c.agentVersion, encConnInfo: enc });
    const clientMsg = encodeClientMessage(sndSecure ? { tag: '_' } : { tag: 'K', senderKey: c.snd.sndPubKey }, env);
    this.addPending(c, { kind: 'conf', body: this.e2eEncrypt(c.snd, clientMsg, true), notification: true, signed: sndSecure });
    c.status = 'allowed';
    c.confirmation = undefined;
    await this.save(c);
  }

  private newSndQueue(addr: QueueInfo['addr'], smpClientVersion: number, keys?: KeyPair<'ed25519'>): SndQueue {
    const k = keys ?? generateKeyPair('ed25519');
    const e2e = generateKeyPair('x25519');
    return {
      server: addr.server,
      sndId: addr.senderId,
      queueMode: addr.queueMode,
      sndPrivKey: k.priv,
      sndPubKey: k.pub,
      e2eDhSecret: dh(addr.dhPublicKey, e2e.priv),
      e2ePubKey: e2e.pub,
      status: keys ? 'secured' : 'new',
      smpClientVersion,
    };
  }

  private e2eEncrypt(sq: SndQueue, clientMsg: Bytes, withKey: boolean): Bytes {
    const nonce = randomBytes(24);
    const encBody = cbEncrypt(sq.e2eDhSecret, nonce, clientMsg, withKey ? E2E_ENC_CONFIRMATION_LENGTH : E2E_ENC_MESSAGE_LENGTH);
    return encodeClientMsgEnvelope({ version: sq.smpClientVersion, e2ePubKey: withKey ? sq.e2ePubKey : undefined, nonce, encBody });
  }

  private addPending(c: Conn, p: Omit<PendingSend, 'id' | 'createdAt' | 'attempts'>): void {
    c.pending.push({ ...p, id: c.nextPendingId++, createdAt: Date.now(), attempts: 0 });
  }

  private mustConn(id: string): Conn {
    const c = this.conns.get(id);
    if (!c || c.status === 'deleted') throw new AgentError('connection not found');
    return c;
  }

  // ---- links

  /** parses a full or short link, fetching and decrypting the short link data from the router */
  async resolveLink(link0: string): Promise<ResolvedLink> {
    const link = link0.trim();
    if (!isShortLink(link)) return { link, connReq: parseConnReq(link) };
    const sl = parseShortLink(link);
    if (!sl.server.keyHash.length) throw new AgentError('the link router is unknown: the link has no router fingerprint');
    let r: BrokerMsg;
    let key: Bytes;
    let sndKey: KeyPair<'ed25519'> | undefined;
    if (sl.mode === 'invitation') {
      sndKey = generateKeyPair('ed25519');
      key = invShortLinkKdf(sl.linkKey);
      r = await this.network.sendToQueue(sl.server, sl.linkId, { tag: 'LKEY', sndKey: sndKey.pub }, sndKey.priv);
    } else {
      const k = contactShortLinkKdf(sl.linkKey);
      key = k.key;
      r = await this.network.sendToQueue(sl.server, k.linkId, { tag: 'LGET' });
    }
    if (r.tag !== 'LNK') throw new AgentError(`unexpected response: ${r.tag}`);
    const ld = decryptLinkData(sl.linkKey, key, r.data);
    let connReq = ld.fixed.connReq;
    const q0 = connReq.data.queues[0];
    if (!q0.addr.server.hosts.some((h) => h === sl.server.hosts[0]) || !equal(q0.addr.senderId, r.sndId)) throw new AgentError('short link: different address');
    if (connReq.mode !== sl.mode) throw new AgentError('short link: different connection mode');
    if (connReq.mode === 'contact' && ld.user.mode === 'contact') connReq = { ...connReq, ratchetKeys: ld.user.data.ratchetKeys };
    const userData = ld.user.mode === 'invitation' ? ld.user.userData : ld.user.data.userData;
    return { link, connReq, shortLink: sl, userData, sndKey, linkData: ld };
  }

  /** joins a 1-time invitation or sends a contact request to an address; returns the new connection ID */
  async joinConnection(link: string | ResolvedLink, connInfo: Bytes, opts: { pq?: boolean } = {}): Promise<string> {
    const r = typeof link === 'string' ? await this.resolveLink(link) : link;
    const pq = opts.pq ?? this.config.pq ?? true;
    return r.connReq.mode === 'invitation' ? this.joinInvitation(r, connInfo, pq) : this.joinContact(r, connInfo, pq);
  }

  private async joinInvitation(r: ResolvedLink, connInfo: Bytes, pq: boolean): Promise<string> {
    const cr = r.connReq;
    if (cr.mode !== 'invitation') throw new AgentError('not an invitation');
    const q = cr.data.queues[0];
    const smpV = compatibleVersion(q.versions, SMP_CLIENT_VERSIONS);
    const aV = compatibleVersion(cr.data.agentVersions, AGENT_VERSIONS);
    const e2eV = compatibleVersion(cr.e2e.versions, E2E_VERSIONS);
    if (smpV === undefined || aV === undefined || e2eV === undefined) throw new AgentError('incompatible link version');
    const c = this.newConn('invitation', 'joining');
    c.agentVersion = aV;
    c.link = r.link;
    c.snd = this.newSndQueue(q.addr, smpV, r.sndKey);
    c.pqSupport = pq;
    // a proposed KEM key is accepted (encapsulated), otherwise ours is proposed
    const own = generateE2EParams(e2eV, replyKem(cr.e2e.kem, pq));
    const rcvParams: E2EParams = { version: e2eV, k1: cr.e2e.k1, k2: cr.e2e.k2, kem: cr.e2e.kem };
    const x3dh = pqX3dhSnd(own.priv, rcvParams);
    c.ratchet = initSndRatchet({ current: e2eV, maxSupported: E2E_VERSIONS.max }, rcvParams.k2, generateKeyPair('x448').priv, x3dh.init, x3dh.pqRs);
    const sndSecure = c.snd.queueMode === 'M';
    await this.withLock(c.id, async () => {
      await this.save(c);
      if (sndSecure && c.snd!.status === 'new') {
        await this.network.sendToQueue(c.snd!.server, c.snd!.sndId, { tag: 'SKEY', sndKey: c.snd!.sndPubKey }, c.snd!.sndPrivKey);
        c.snd!.status = 'secured';
        await this.save(c);
      }
      const { rq } = await this.newRcvQueue(this.nextServer(), 'M', smpV);
      c.rcv = rq;
      const replyInfo: QueueInfo = { version: smpV, addr: { server: rq.server, senderId: rq.sndId, dhPublicKey: rq.e2ePubKey, queueMode: rq.queueMode } };
      const am = encodeAgentMessage({ tag: 'D', replyQueues: [replyInfo], connInfo });
      c.sndInternalId = 1;
      c.sndLastHash = sha256(am);
      const { enc, rc } = ratchetEncrypt(c.ratchet!, am, connInfoLength(c));
      c.ratchet = rc;
      const env = encodeAgentEnvelope({ tag: 'C', agentVersion: c.agentVersion, e2e: own.params, encConnInfo: enc });
      const clientMsg = encodeClientMessage(sndSecure ? { tag: '_' } : { tag: 'K', senderKey: c.snd!.sndPubKey }, env);
      this.addPending(c, { kind: 'conf', body: this.e2eEncrypt(c.snd!, clientMsg, true), notification: true, signed: sndSecure });
      c.status = 'joined';
      await this.save(c);
    });
    this.kickSend(c.id);
    return c.id;
  }

  /** sends a contact request (an invitation to this new connection) to a contact address */
  private async joinContact(r: ResolvedLink, connInfo: Bytes, pq: boolean): Promise<string> {
    const cr = r.connReq;
    if (cr.mode !== 'contact') throw new AgentError('not a contact address');
    const q = cr.data.queues[0];
    const smpV = compatibleVersion(q.versions, SMP_CLIENT_VERSIONS);
    const aV = compatibleVersion(cr.data.agentVersions, AGENT_VERSIONS);
    if (smpV === undefined || aV === undefined) throw new AgentError('incompatible address version');
    const c = this.newConn('invitation', 'new');
    c.link = r.link;
    c.pqSupport = pq;
    // the invitation in a contact request proposes a KEM key (joinContactInitialKeys)
    const { priv, params } = generateE2EParams(E2E_VERSIONS.max, pq ? { tag: 'propose' } : undefined);
    c.x3dh = priv;
    const { rq } = await this.newRcvQueue(this.nextServer(), 'M');
    c.rcv = rq;
    const inv: ConnectionRequest = {
      mode: 'invitation',
      data: { scheme: 'simplex', agentVersions: AGENT_VERSIONS, queues: [this.queueUri(rq)] },
      e2e: { versions: E2E_VERSIONS, k1: params.k1, k2: params.k2, kem: params.kem },
    };
    await this.save(c);
    const env = encodeAgentEnvelope({ tag: 'I', agentVersion: aV, connReq: inv, connInfo });
    const k = generateKeyPair('x25519');
    const nonce = randomBytes(24);
    const encBody = cbEncrypt(dh(q.addr.dhPublicKey, k.priv), nonce, encodeClientMessage({ tag: '_' }, env), E2E_ENC_CONFIRMATION_LENGTH);
    const body = encodeClientMsgEnvelope({ version: smpV, e2ePubKey: k.pub, nonce, encBody });
    await this.network.sendToQueue(q.addr.server, q.addr.senderId, { tag: 'SEND', notification: true, body });
    return c.id;
  }

  // ---- contact addresses

  async createAddress(opts: { userData?: Bytes } = {}): Promise<{ connId: string; link: string; fullLink: string }> {
    const c = this.newConn('contact', 'address');
    const srv = this.nextServer();
    const root = generateKeyPair('ed25519');
    let connReq!: ConnectionRequest;
    let linkKey!: Bytes;
    let encFixed!: Bytes;
    const { rq } = await this.newRcvQueue(srv, 'C', SMP_CLIENT_VERSIONS.max, (sndId, e2ePub) => {
      connReq = {
        mode: 'contact',
        data: { scheme: 'simplex', agentVersions: AGENT_VERSIONS, queues: [{ versions: SMP_CLIENT_VERSIONS, addr: { server: srv, senderId: sndId, dhPublicKey: e2ePub, queueMode: 'C' } }] },
      };
      const s = encodeSignLinkData(
        root,
        { agentVersions: AGENT_VERSIONS, rootKey: root.pub, connReq },
        { mode: 'contact', agentVersions: AGENT_VERSIONS, data: { direct: true, owners: [], relays: [], userData: opts.userData ?? new Uint8Array(0) } },
      );
      linkKey = s.linkKey;
      const k = contactShortLinkKdf(linkKey);
      const data = encryptLinkData(k.key, s.fixed, s.user);
      encFixed = data.fixedData;
      return { linkId: k.linkId, data };
    });
    const link = strShortLink({ mode: 'contact', scheme: 'server', type: 'A', server: srv, linkKey });
    rq.shortLink = { linkId: contactShortLinkKdf(linkKey).linkId, linkKey, rootPriv: root.priv, rootPub: root.pub, encFixedData: encFixed, link };
    c.rcv = rq;
    c.link = link;
    c.requests = {};
    await this.save(c);
    return { connId: c.id, link, fullLink: strConnReq(connReq) };
  }

  /**
   * updates the user data (e.g. the profile) stored with the short link of an address, or of a 1-time
   * invitation that was not used yet (the router refuses it once the joining party has the link)
   */
  async updateLinkData(connId: string, userData: Bytes): Promise<void> {
    await this.withLock(connId, async () => {
      const c = this.mustConn(connId);
      const sl = c.rcv?.shortLink;
      if (!c.rcv || !sl) throw new AgentError('the connection has no short link');
      const ld: ConnLinkData =
        c.mode === 'contact' ? { mode: 'contact', agentVersions: AGENT_VERSIONS, data: { direct: true, owners: [], relays: [], userData } } : { mode: 'invitation', agentVersions: AGENT_VERSIONS, userData };
      const lb = encodeLinkData(ld);
      const signed = new Encoder().bytes(sign(sl.rootPriv, lb)).raw(lb).finish();
      const key = c.mode === 'contact' ? contactShortLinkKdf(sl.linkKey).key : invShortLinkKdf(sl.linkKey);
      await this.network.send(c.rcv.server, c.rcv.rcvId, { tag: 'LSET', linkId: sl.linkId, data: { fixedData: sl.encFixedData, userData: encryptUserData(key, signed) } }, c.rcv.rcvPrivKey);
    });
  }

  /** accepts a contact request received via an address: joins the requester's invitation */
  async acceptRequest(addressConnId: string, invId: string, connInfo: Bytes, opts: { pq?: boolean } = {}): Promise<string> {
    const addr = this.mustConn(addressConnId);
    const req = addr.requests?.[invId];
    if (!req) throw new AgentError('contact request not found');
    const connId = await this.joinConnection(req.connReq, connInfo, opts);
    await this.withLock(addressConnId, async () => {
      delete addr.requests![invId];
      await this.save(addr);
    });
    return connId;
  }

  async rejectRequest(addressConnId: string, invId: string): Promise<void> {
    await this.withLock(addressConnId, async () => {
      const addr = this.mustConn(addressConnId);
      if (addr.requests) delete addr.requests[invId];
      await this.save(addr);
    });
  }

  // ---- messages

  /** sends a message, returning its agent message ID */
  async sendMessage(connId: string, body: Bytes, notification = true): Promise<number> {
    const id = await this.withLock(connId, async () => {
      const c = this.mustConn(connId);
      if (!c.snd || !c.ratchet || !['ready', 'allowed', 'joined'].includes(c.status)) throw new AgentError('connection is not ready');
      const msgId = this.enqueueAgentMsg(c, { tag: 'A_MSG', body }, notification);
      await this.save(c);
      return msgId;
    });
    this.kickSend(connId);
    return id;
  }

  private enqueueAgentMsg(c: Conn, msg: AMessage, notification: boolean): number {
    if (!c.snd || !c.ratchet) throw new AgentError('connection has no send queue');
    const sndMsgId = c.sndInternalId + 1;
    const am: AgentMessage = { tag: 'M', sndMsgId, prevMsgHash: c.sndLastHash, msg };
    const agentMsgStr = encodeAgentMessage(am);
    const { enc, rc } = ratchetEncrypt(c.ratchet, agentMsgStr, c.pqSupport ? E2E_ENC_AGENT_MSG_LENGTH_PQ : E2E_ENC_AGENT_MSG_LENGTH);
    c.ratchet = rc;
    c.sndInternalId = sndMsgId;
    c.sndLastHash = sha256(agentMsgStr);
    if (msg.tag === 'A_MSG') {
      c.sentHashes[sndMsgId] = b64url(c.sndLastHash);
      const ids = Object.keys(c.sentHashes);
      if (ids.length > MAX_SENT_HASHES) for (const k of ids.slice(0, ids.length - MAX_SENT_HASHES)) delete c.sentHashes[Number(k)];
    }
    const env = encodeAgentEnvelope({ tag: 'M', agentVersion: AGENT_VERSIONS.max, encAgentMessage: enc });
    const kind = msg.tag === 'A_MSG' ? 'msg' : msg.tag === 'A_RCVD' ? 'rcpt' : msg.tag === 'HELLO' ? 'hello' : 'msg';
    this.addPending(c, { kind, body: this.e2eEncrypt(c.snd, encodeClientMessage({ tag: '_' }, env), false), notification, signed: true, msgId: sndMsgId });
    return sndMsgId;
  }

  // ---- delivery

  private kickSend(connId: string): void {
    if (this.stopped || this.sending.has(connId)) return;
    const t = this.retryTimers.get(connId);
    if (t) {
      clearTimeout(t);
      this.retryTimers.delete(connId);
    }
    this.sending.add(connId);
    this.sendLoop(connId)
      .catch((e) => console.error('send loop error', e))
      .finally(() => this.sending.delete(connId));
  }

  private async sendLoop(connId: string): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const c = this.conns.get(connId);
      if (!c || c.status === 'deleted' || !c.snd || !c.pending.length || c.quotaPaused) return;
      const p = c.pending[0];
      const sq = c.snd;
      try {
        if (p.kind === 'skey') {
          await this.network.sendToQueue(sq.server, sq.sndId, { tag: 'SKEY', sndKey: sq.sndPubKey }, sq.sndPrivKey);
        } else {
          await this.network.sendToQueue(sq.server, sq.sndId, { tag: 'SEND', notification: p.notification, body: p.body! }, p.signed ? sq.sndPrivKey : undefined);
        }
      } catch (e) {
        if (e instanceof SMPError) {
          if (e.code === 'QUOTA') {
            await this.withLock(connId, async () => {
              c.quotaPaused = true;
              await this.save(c);
            });
            this.scheduleRetry(connId, 10 * 60000, true);
            return;
          }
          // AUTH and other permanent errors: the message cannot be delivered
          await this.withLock(connId, async () => {
            c.pending = c.pending.filter((x) => x.id !== p.id);
            await this.save(c);
          });
          if (p.kind === 'msg' && p.msgId) await this.emit({ type: 'MERR', connId, msgId: p.msgId, err: e.message });
          else await this.emit({ type: 'ERR', connId, err: `${p.kind}: ${e.message}` });
          continue;
        }
        p.attempts++;
        if (DEBUG) console.warn(`[agent] ${p.kind} to ${sq.server.hosts[0]} failed (attempt ${p.attempts}):`, (e as Error).message);
        this.scheduleRetry(connId, Math.min(60000, 2000 * 2 ** Math.min(p.attempts, 5)));
        return;
      }
      let con = false;
      await this.withLock(connId, async () => {
        c.pending = c.pending.filter((x) => x.id !== p.id);
        if (p.kind === 'skey') sq.status = 'secured';
        else if (p.kind === 'conf') {
          if (c.status === 'allowed') {
            // the initiating party: the reply queue was secured by us, so the connection is ready
            if (sq.queueMode === 'M') {
              sq.status = 'active';
              c.status = 'ready';
              con = true;
            } else sq.status = 'confirmed';
          } else sq.status = 'confirmed';
        }
        await this.save(c);
      });
      if (con) await this.emit({ type: 'CON', connId });
      if (p.kind === 'msg' && p.msgId) await this.emit({ type: 'SENT', connId, msgId: p.msgId });
    }
  }

  private scheduleRetry(connId: string, ms: number, unpause = false): void {
    if (this.stopped || this.retryTimers.has(connId)) return;
    this.retryTimers.set(
      connId,
      setTimeout(async () => {
        this.retryTimers.delete(connId);
        if (unpause) {
          const c = this.conns.get(connId);
          if (c) c.quotaPaused = false;
        }
        this.kickSend(connId);
      }, ms),
    );
  }

  /** retries pending deliveries now (e.g. after the network is back) */
  retryAll(): void {
    this.network.retryAll();
    for (const c of this.conns.values()) if (c.pending.length && !c.quotaPaused) this.kickSend(c.id);
  }

  // ---- subscriptions and incoming messages

  private onConnected(srv: ProtocolServer, client: SMPClient): void {
    const subs: Array<{ c: Conn; rq: RcvQueue }> = [];
    for (const c of this.conns.values()) {
      if (c.rcv && c.status !== 'deleted' && serverKey(c.rcv.server) === serverKey(srv)) subs.push({ c, rq: c.rcv });
    }
    void this.emit({ type: 'UP', server: srv });
    if (!subs.length) return;
    const rs = client.sendCommands(subs.map(({ rq }) => ({ entityId: rq.rcvId, cmd: { tag: 'SUB' as const }, key: rq.rcvPrivKey })));
    rs.forEach((p, i) =>
      p.catch((e) => {
        if (e instanceof SMPError) void this.emit({ type: 'ERR', connId: subs[i].c.id, err: `subscription error: ${e.message}` });
      }),
    );
    // messages that could not be sent while disconnected
    for (const c of this.conns.values()) if (c.pending.length && c.snd && serverKey(c.snd.server) === serverKey(srv)) this.kickSend(c.id);
  }

  private onRouterMessage(srv: ProtocolServer, entityId: Bytes, msg: BrokerMsg): void {
    if (this.stopped) return;
    const connId = this.rcvIndex.get(qKey(srv, entityId));
    if (!connId) return;
    if (msg.tag === 'MSG') {
      this.withLock(connId, () => this.processMsg(connId, msg.msgId, msg.body)).catch((e) => void this.emit({ type: 'ERR', connId, err: `message processing error: ${(e as Error).message}` }));
    } else if (msg.tag === 'END') void this.emit({ type: 'END', connId });
    else if (msg.tag === 'DELD') void this.emit({ type: 'DELD', connId });
  }

  private async ack(rq: RcvQueue, srvMsgId: Bytes): Promise<void> {
    try {
      await this.network.send(rq.server, rq.rcvId, { tag: 'ACK', msgId: srvMsgId }, rq.rcvPrivKey);
    } catch (e) {
      if (!(e instanceof SMPError && e.code === 'NO_MSG')) console.warn('ACK failed', (e as Error).message);
    }
  }

  private async processMsg(connId: string, srvMsgId: Bytes, encBody: Bytes): Promise<void> {
    const c = this.conns.get(connId);
    if (!c || !c.rcv || c.status === 'deleted') return;
    const rq = c.rcv;
    let ackNow = true;
    try {
      const rcv = decryptRcvMsg(rq.rcvDhSecret, srvMsgId, encBody);
      if (rcv.quota) {
        if (c.snd && c.ratchet && c.status === 'ready') {
          this.enqueueAgentMsg(c, { tag: 'A_QCONT', addr: { server: rq.server, senderId: rq.sndId } }, false);
          await this.save(c);
          this.kickSend(connId);
        }
        return;
      }
      const env = parseClientMsgEnvelope(rcv.body);
      if (!isCompatible(env.version, SMP_CLIENT_VERSIONS) && env.version > rq.smpClientVersion) throw new AgentError('incompatible message version');
      if (!rq.e2eDhSecret && env.e2ePubKey) {
        const e2eDh = dh(env.e2ePubKey, rq.e2ePrivKey);
        const { header, body } = parseClientMessage(cbDecrypt(e2eDh, env.nonce, env.encBody));
        const ae = parseAgentEnvelope(body);
        if (ae.tag === 'C') {
          if (header.tag === '_' && rq.queueMode !== 'M') throw new AgentError('confirmation without sender key');
          await this.smpConfirmation(c, header.tag === 'K' ? header.senderKey : undefined, env.e2ePubKey, ae.e2e, ae.encConnInfo, env.version, ae.agentVersion);
        } else if (ae.tag === 'I' && header.tag === '_') {
          await this.smpInvitation(c, ae.connReq, ae.connInfo);
        } else if (ae.tag === 'A') {
          throw new AgentError('contact requests with ratchet keys are not supported');
        } else throw new AgentError(`unexpected handshake message ${ae.tag}`);
      } else if (rq.e2eDhSecret && !env.e2ePubKey) {
        const { body } = parseClientMessage(cbDecrypt(rq.e2eDhSecret, env.nonce, env.encBody));
        const ae = parseAgentEnvelope(body);
        if (ae.tag === 'M') {
          ackNow = await this.agentMsg(c, ae.encAgentMessage, srvMsgId, rcv.ts, rcv.notification);
        } else if (ae.tag === 'R') {
          throw new AgentError('ratchet re-synchronization is not supported');
        } else throw new AgentError(`unexpected message ${ae.tag}`);
      }
      // otherwise: a repeated confirmation, or a message without keys - ignored
    } catch (e) {
      // stopped while processing (the app was locked): the router delivers the message again later
      if (this.stopped) return;
      await this.emit({ type: 'ERR', connId, err: (e as Error).message });
    } finally {
      if (ackNow && !this.stopped) await this.ack(rq, srvMsgId);
    }
  }

  private async smpConfirmation(c: Conn, senderKey: PublicKey | undefined, e2ePubKey: PublicKey<'x25519'>, e2e: E2EParams | undefined, encConnInfo: Bytes, phVer: number, agentVersion: number): Promise<void> {
    const rq = c.rcv!;
    if (rq.status !== 'new') throw new AgentError('confirmation: queue is not new');
    if (!isCompatible(agentVersion, AGENT_VERSIONS) && agentVersion > c.agentVersion) throw new AgentError('incompatible agent version');
    if (c.status === 'new' && c.x3dh) {
      // the initiating party: create the ratchet from our invitation keys and the received keys
      if (!e2e) throw new AgentError('confirmation without e2e keys');
      if (!isCompatible(e2e.version, E2E_VERSIONS)) throw new AgentError('incompatible e2e version');
      const x3dh = pqX3dhRcv(c.x3dh, e2e);
      const rc0 = initRcvRatchet({ current: e2e.version, maxSupported: E2E_VERSIONS.max }, c.x3dh.pk2, x3dh.init, x3dh.pqRs, !!c.pqSupport);
      const dec = ratchetDecrypt(rc0, {}, encConnInfo);
      const am = parseAgentMessage(dec.msg);
      if (am.tag !== 'D') throw new AgentError('confirmation: unexpected message');
      c.ratchet = dec.rc;
      c.skipped = dec.skipped;
      c.x3dh = undefined;
      c.agentVersion = agentVersion;
      rq.e2eDhSecret = dh(e2ePubKey, rq.e2ePrivKey);
      rq.smpClientVersion = Math.min(rq.smpClientVersion, phVer);
      rq.status = 'confirmed';
      c.rcvLastExtId = 1;
      c.rcvLastHash = sha256(dec.msg);
      c.confirmation = { replyQueues: am.replyQueues, connInfo: am.connInfo, senderKey };
      c.status = 'confirmed';
      await this.save(c);
      const r = await this.emit({ type: 'CONF', connId: c.id, connInfo: am.connInfo });
      if (r && r.allow) {
        await this.allowConn(c, r.allow);
        this.kickSend(c.id);
      }
    } else if ((c.status === 'joined' || c.status === 'joining') && c.ratchet && !e2e) {
      // the joining party: the initiator's information
      const dec = ratchetDecrypt(c.ratchet, c.skipped, encConnInfo);
      const am = parseAgentMessage(dec.msg);
      if (am.tag !== 'I') throw new AgentError('confirmation: expected connection info');
      c.ratchet = dec.rc;
      c.skipped = dec.skipped;
      rq.e2eDhSecret = dh(e2ePubKey, rq.e2ePrivKey);
      rq.smpClientVersion = Math.min(rq.smpClientVersion, phVer);
      c.rcvLastExtId = 1;
      c.rcvLastHash = sha256(dec.msg);
      if (senderKey) {
        // the initiator could not secure our queue: secure it and send HELLO
        await this.network.send(rq.server, rq.rcvId, { tag: 'KEY', sndKey: senderKey }, rq.rcvPrivKey);
        rq.status = 'secured';
        this.enqueueAgentMsg(c, { tag: 'HELLO' }, true);
        await this.save(c);
        await this.emit({ type: 'INFO', connId: c.id, connInfo: am.connInfo });
        this.kickSend(c.id);
      } else {
        rq.status = 'active';
        if (c.snd) c.snd.status = 'active';
        c.status = 'ready';
        await this.save(c);
        await this.emit({ type: 'INFO', connId: c.id, connInfo: am.connInfo });
        await this.emit({ type: 'CON', connId: c.id });
      }
    } else throw new AgentError(`confirmation in state ${c.status}`);
  }

  private async smpInvitation(c: Conn, connReq: ConnectionRequest, connInfo: Bytes): Promise<void> {
    if (c.mode !== 'contact') throw new AgentError('invitation sent to a messaging connection');
    const invId = b64urlNoPad(randomBytes(12));
    c.requests ??= {};
    c.requests[invId] = { invId, connReq: strConnReq(connReq), connInfo, receivedAt: Date.now() };
    await this.save(c);
    const r = await this.emit({ type: 'REQ', connId: c.id, invId, connInfo });
    if (r && r.accept) {
      await this.joinConnection(c.requests[invId].connReq, r.accept);
      delete c.requests[invId];
      await this.save(c);
    }
  }

  /** processes a double-ratchet encrypted agent message; returns whether to ACK now */
  private async agentMsg(c: Conn, encAgentMessage: Bytes, srvMsgId: Bytes, brokerTs: number, notification: boolean): Promise<boolean> {
    if (!c.ratchet) throw new AgentError('message without ratchet');
    const encHash = b64url(sha256(encAgentMessage));
    let dec;
    try {
      dec = ratchetDecrypt(c.ratchet, c.skipped, encAgentMessage);
    } catch (e) {
      if (c.rcvEncHashes.includes(encHash)) return true; // redelivered duplicate
      if (e instanceof RatchetError && e.code === 'DUPLICATE') return true;
      throw e;
    }
    const am = parseAgentMessage(dec.msg);
    if (am.tag !== 'M') throw new AgentError('unexpected agent message');
    c.ratchet = dec.rc;
    c.skipped = dec.skipped;
    c.rcvEncHashes.push(encHash);
    if (c.rcvEncHashes.length > MAX_ENC_HASHES) c.rcvEncHashes.splice(0, c.rcvEncHashes.length - MAX_ENC_HASHES);
    const rq = c.rcv!;
    if (rq.status !== 'active') rq.status = 'active';
    const integrity = checkIntegrity(c.rcvLastExtId, am.sndMsgId, c.rcvLastHash, am.prevMsgHash);
    const msgHash = sha256(dec.msg);
    c.rcvLastExtId = am.sndMsgId;
    c.rcvLastHash = msgHash;
    c.rcvInternalId++;
    const msgId = c.rcvInternalId;
    const m = am.msg;
    switch (m.tag) {
      case 'HELLO': {
        await this.save(c);
        if (c.snd?.status === 'active' || c.status === 'ready') {
          if (c.status !== 'ready') {
            c.status = 'ready';
            await this.save(c);
            await this.emit({ type: 'CON', connId: c.id });
          }
        } else if (c.snd) {
          c.snd.status = 'active';
          this.enqueueAgentMsg(c, { tag: 'HELLO' }, true);
          c.status = 'ready';
          await this.save(c);
          this.kickSend(c.id);
          await this.emit({ type: 'CON', connId: c.id });
        }
        return true;
      }
      case 'A_MSG': {
        // the ratchet state is saved after the client has stored the message: if the app stops in
        // between, the message is not acknowledged and the router delivers it again
        const r = await this.emit({ type: 'MSG', connId: c.id, msgId, sndMsgId: am.sndMsgId, body: m.body, brokerTs, integrity, notification });
        if (this.stopped) throw new AgentError('stopped');
        await this.save(c);
        await this.ack(rq, srvMsgId);
        if (r && r.receipt && c.snd && c.status === 'ready') {
          this.enqueueAgentMsg(c, { tag: 'A_RCVD', receipts: [{ agentMsgId: am.sndMsgId, msgHash, rcptInfo: new Uint8Array(0) }] }, false);
          await this.save(c);
          this.kickSend(c.id);
        }
        return false;
      }
      case 'A_RCVD': {
        await this.save(c);
        const receipts = m.receipts.filter((r) => c.sentHashes[r.agentMsgId]).map((r) => ({ msgId: r.agentMsgId, ok: c.sentHashes[r.agentMsgId] === b64url(r.msgHash) }));
        if (receipts.length) await this.emit({ type: 'RCVD', connId: c.id, receipts });
        return true;
      }
      case 'A_QCONT':
        c.quotaPaused = false;
        await this.save(c);
        this.kickSend(c.id);
        return true;
      case 'EREADY':
        await this.save(c);
        return true;
      default:
        await this.save(c);
        await this.emit({ type: 'ERR', connId: c.id, err: 'queue rotation is not supported' });
        return true;
    }
  }

  // ---- deletion

  async deleteConnection(connId: string): Promise<void> {
    await this.withLock(connId, async () => {
      const c = this.conns.get(connId);
      if (!c) return;
      c.status = 'deleted';
      c.pending = [];
      if (c.rcv) {
        try {
          await this.network.send(c.rcv.server, c.rcv.rcvId, { tag: 'DEL' }, c.rcv.rcvPrivKey);
        } catch (e) {
          console.warn('failed to delete queue', (e as Error).message);
        }
        this.rcvIndex.delete(qKey(c.rcv.server, c.rcv.rcvId));
      }
      this.conns.delete(connId);
      await this.store.deleteConn(connId);
    });
  }

  /** the router has no queue for this connection (e.g. after an error) - forget it locally */
  async forgetConnection(connId: string): Promise<void> {
    const c = this.conns.get(connId);
    if (c?.rcv) this.rcvIndex.delete(qKey(c.rcv.server, c.rcv.rcvId));
    this.conns.delete(connId);
    await this.store.deleteConn(connId);
  }
}

