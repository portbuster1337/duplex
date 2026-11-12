// SMP client: TLS + SMP handshake to one router, transmission encoding/authorization,
// request/response correlation and router events (Simplex.Messaging.Transport / Client).
import { b64url, concat, equal, randomBytes, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError, pad, unPad } from '../util/encoding';
import {
  cbAuthenticate,
  cbDecrypt,
  cryptoBox,
  dh,
  encPubKey,
  generateKeyPair,
  sbcHkdf,
  sbcInit,
  sha256,
  sign,
  type PrivateKey,
  type PublicKey,
  type SignAlg,
} from '../crypto/crypto';
import { TlsConnection } from '../net/tls13';
import { BufferedReader, StreamClosedError, timeout, type Stream } from '../net/stream';
import { parseCertificate, parseSignedObject, signedBy, signedObjectPubKey, signKeyOf, verifySignedObject } from '../net/x509';
import { compatibleVRange, decVR, type VersionRange } from '../util/version';
import { isOnion, serverString, type ProtocolServer } from './server';
import {
  encodeCommand,
  parseBrokerMsg,
  SERVER_INFO_SMP_VERSION,
  SERVICE_CERTS_SMP_VERSION,
  SMP_BLOCK_SIZE,
  SMP_VERSIONS,
  SMPError,
  type BrokerMsg,
  type Command,
} from './protocol';

export interface Connector {
  /** opens a TCP stream (directly, or through a relay) */
  connect(host: string, port: number): Promise<Stream>;
  /** whether .onion hosts can be reached */
  onion?: boolean;
}

export type AuthKey = PrivateKey<SignAlg> | PrivateKey<'x25519'>;

export class TransportError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransportError';
  }
}

const PRESET_DOMAINS = ['simplex.im', 'simplexonflux.com'];

export function isPresetHost(host: string): boolean {
  return PRESET_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

export function chooseHost(srv: ProtocolServer, onion: boolean): string {
  if (onion) return srv.hosts.find(isOnion) ?? srv.hosts[0];
  const h = srv.hosts.find((h) => !isOnion(h));
  if (!h) throw new TransportError(`server ${srv.hosts[0]} is only reachable via Tor`);
  return h;
}

/** validates a router certificate chain against the fingerprint in its address, returns the TLS key */
export function verifyServerChain(chain: Bytes[], keyHash: Bytes): PublicKey<SignAlg> {
  if (chain.length < 2 || chain.length > 4) throw new TransportError(`bad certificate chain length ${chain.length}`);
  if (!equal(sha256(chain[1]), keyHash)) throw new TransportError('server identity does not match its address');
  const certs = chain.map(parseCertificate);
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!signedBy(certs[i], certs[i + 1])) throw new TransportError('invalid certificate chain signature');
  }
  if (certs.length === 2 && !signedBy(certs[1], certs[1])) throw new TransportError('invalid identity certificate');
  return signKeyOf(certs[0]);
}

interface Pending {
  resolve: (m: BrokerMsg) => void;
  reject: (e: Error) => void;
  entityId: Bytes;
  timer: ReturnType<typeof setTimeout>;
}

export interface SMPClientOptions {
  connector: Connector;
  commandTimeout?: number;
  pingInterval?: number;
  onEvent?: (entityId: Bytes, msg: BrokerMsg, client: SMPClient) => void;
  onClose?: (client: SMPClient, err?: Error) => void;
}

export class SMPClient {
  sessionId!: Bytes;
  version!: number;
  serverVersions!: VersionRange;
  /** router session key used to authorize commands with X25519 queue keys */
  serverKey!: PublicKey<'x25519'>;
  serverInfo: unknown;
  private tls!: TlsConnection;
  private reader!: BufferedReader;
  private sndChain: Bytes | undefined;
  private rcvChain: Bytes | undefined;
  private pending = new Map<string, Pending>();
  private closedErr: Error | undefined;
  private lastReceived = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly server: ProtocolServer,
    private opts: SMPClientOptions,
  ) {}

  get label(): string {
    return this.server.hosts[0];
  }

  static async connect(server: ProtocolServer, opts: SMPClientOptions): Promise<SMPClient> {
    const c = new SMPClient(server, opts);
    await c.start();
    return c;
  }

  private async start(): Promise<void> {
    const { connector } = this.opts;
    const host = chooseHost(this.server, !!connector.onion);
    const webPort = !this.server.port && isPresetHost(host);
    const port = this.server.port ? Number(this.server.port) : webPort ? 443 : 5223;
    const stream = await connector.connect(host, port);
    try {
      this.tls = await timeout(
        TlsConnection.connect(stream, {
          alpn: [port === 443 && webPort ? 'http/1.1' : 'smp/1'],
          verifyChain: (chain) => verifyServerChain(chain, this.server.keyHash),
        }),
        30000,
        `TLS handshake with ${host} timed out`,
      );
    } catch (e) {
      stream.close();
      throw e;
    }
    this.reader = new BufferedReader(this.tls);
    try {
      await timeout(this.handshake(), 30000, `SMP handshake with ${host} timed out`);
    } catch (e) {
      this.tls.close();
      throw e;
    }
    this.receiveLoop();
    const interval = this.opts.pingInterval ?? 60000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastReceived >= interval - 1000) {
        this.sendCommand(new Uint8Array(0), { tag: 'PING' }).catch(() => {});
      }
    }, interval);
  }

  private async handshake(): Promise<void> {
    const block = unPad(await this.reader.readExact(SMP_BLOCK_SIZE));
    const d = new Decoder(block);
    const serverVersions = decVR(d);
    const sessionId = d.bytes();
    const certChain = d.nonEmpty((d) => d.large());
    const signedKey = d.large();
    if (serverVersions.max >= SERVER_INFO_SMP_VERSION && !d.atEnd()) {
      const info = d.optional((d) => d.maybe((d) => d.large()));
      if (info) {
        try {
          this.serverInfo = JSON.parse(new TextDecoder().decode(info));
        } catch {
          // optional information
        }
      }
    }
    if (!equal(sessionId, this.tls.tlsUnique)) throw new TransportError('bad session ID');
    const vr = compatibleVRange(serverVersions, SMP_VERSIONS);
    if (!vr) throw new TransportError(`incompatible server version ${serverVersions.min}-${serverVersions.max}`);
    // the handshake chain must have the same identity, and the session key must be signed by the TLS key
    if (certChain.length < 2 || !equal(sha256(certChain[1]), this.server.keyHash)) throw new TransportError('handshake identity mismatch');
    const tlsKey = signKeyOf(parseCertificate(this.tls.certificates[0]));
    const so = parseSignedObject(signedKey);
    if (!verifySignedObject(so, tlsKey)) throw new TransportError('bad server session key signature');
    const sk = signedObjectPubKey(so.object);
    if (sk.alg !== 'x25519') throw new TransportError('bad server session key');
    const serverKey = sk as PublicKey<'x25519'>;
    const v = vr.max;
    const ks = generateKeyPair('x25519');
    const e = new Encoder().word16(v).bytes(this.server.keyHash);
    encPubKey(e, ks.pub);
    e.bool(false);
    if (v >= SERVICE_CERTS_SMP_VERSION) e.char('0');
    this.tls.write(pad(e.finish(), SMP_BLOCK_SIZE));
    this.sessionId = sessionId;
    this.version = v;
    this.serverVersions = serverVersions;
    this.serverKey = serverKey;
    const [ck1, ck2] = sbcInit(sessionId, dh(serverKey, ks.priv));
    this.sndChain = ck2;
    this.rcvChain = ck1;
  }

  private encryptBlock(block: Bytes): Bytes {
    if (!this.sndChain) return pad(block, SMP_BLOCK_SIZE);
    const [sk, nonce, next] = sbcHkdf(this.sndChain);
    this.sndChain = next;
    return cryptoBox(sk, nonce, pad(block, SMP_BLOCK_SIZE - 16));
  }

  private decryptBlock(block: Bytes): Bytes {
    if (!this.rcvChain) return unPad(block);
    const [sk, nonce, next] = sbcHkdf(this.rcvChain);
    this.rcvChain = next;
    return cbDecrypt(sk, nonce, block);
  }

  private async receiveLoop(): Promise<void> {
    try {
      for (;;) {
        const raw = await this.reader.readExact(SMP_BLOCK_SIZE);
        this.lastReceived = Date.now();
        const block = this.decryptBlock(raw);
        const d = new Decoder(block);
        const n = d.byte();
        for (let i = 0; i < n; i++) {
          const t = d.large();
          try {
            this.processTransmission(t);
          } catch (e) {
            console.warn(`[smp ${this.label}] bad transmission`, e);
          }
        }
      }
    } catch (e) {
      this.shutdown(e instanceof StreamClosedError ? new TransportError(`disconnected from ${this.label}`) : (e as Error));
    }
  }

  private processTransmission(t: Bytes): void {
    const d = new Decoder(t);
    const auth = d.bytes();
    if (this.version >= SERVICE_CERTS_SMP_VERSION && auth.length) d.maybe((d) => d.bytes());
    const corrId = d.bytes();
    const entityId = d.bytes().slice();
    let msg: BrokerMsg;
    try {
      msg = parseBrokerMsg(this.version, d.rest());
    } catch (e) {
      msg = { tag: 'ERR', err: new SMPError('PARSE', (e as Error).message) };
    }
    if (msg.tag === 'MSG' || corrId.length === 0) {
      this.opts.onEvent?.(entityId, msg, this);
    }
    if (corrId.length) {
      const key = b64url(corrId);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        clearTimeout(p.timer);
        if (msg.tag === 'ERR') p.reject(msg.err);
        else p.resolve(msg);
      }
    }
  }

  private shutdown(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.tls?.close();
    this.opts.onClose?.(this, err);
  }

  get isClosed(): boolean {
    return this.closedErr !== undefined;
  }

  close(): void {
    this.shutdown(new TransportError('closed'));
  }

  /** encodes and authorizes one transmission, returning [corrId, bytes] */
  private transmission(entityId: Bytes, cmd: Command, key?: AuthKey, corrId: Bytes = randomBytes(24)): Bytes {
    const body = new Encoder().bytes(corrId).bytes(entityId).raw(encodeCommand(this.version, cmd)).finish();
    let auth: Bytes = new Uint8Array(0);
    if (key) {
      const signed = concat(new Encoder().bytes(this.sessionId).finish(), body);
      auth = key.alg === 'x25519' ? cbAuthenticate(this.serverKey, key as PrivateKey<'x25519'>, corrId, signed) : sign(key as PrivateKey<SignAlg>, signed);
    }
    const e = new Encoder().bytes(auth);
    if (this.version >= SERVICE_CERTS_SMP_VERSION && auth.length) e.char('0');
    return e.raw(body).finish();
  }

  /** sends commands in as few blocks as possible; resolves with the responses in order */
  sendCommands(cmds: Array<{ entityId: Bytes; cmd: Command; key?: AuthKey; corrId?: Bytes }>): Promise<BrokerMsg>[] {
    if (this.closedErr) return cmds.map(() => Promise.reject(this.closedErr));
    const results: Promise<BrokerMsg>[] = [];
    const blocks: Bytes[][] = [[]];
    let size = 0;
    for (const c of cmds) {
      const corrId = c.corrId ?? randomBytes(24);
      const t = this.transmission(c.entityId, c.cmd, c.key, corrId);
      const tLen = t.length + 2;
      if (tLen > SMP_BLOCK_SIZE - 19) {
        results.push(Promise.reject(new TransportError('transmission too large')));
        continue;
      }
      const cur = blocks[blocks.length - 1];
      if (size + tLen > SMP_BLOCK_SIZE - 19 || cur.length >= 255) {
        blocks.push([t]);
        size = tLen;
      } else {
        cur.push(t);
        size += tLen;
      }
      results.push(
        new Promise<BrokerMsg>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(b64url(corrId));
            reject(new TransportError(`${c.cmd.tag} to ${this.label} timed out`));
          }, this.opts.commandTimeout ?? 45000);
          this.pending.set(b64url(corrId), { resolve, reject, entityId: c.entityId, timer });
        }),
      );
    }
    for (const ts of blocks) {
      if (!ts.length) continue;
      const e = new Encoder().byte(ts.length);
      for (const t of ts) e.large(t);
      const block = this.encryptBlock(e.finish());
      try {
        this.tls.write(block);
      } catch (err) {
        this.shutdown(err as Error);
      }
    }
    return results;
  }

  sendCommand(entityId: Bytes, cmd: Command, key?: AuthKey, corrId?: Bytes): Promise<BrokerMsg> {
    return this.sendCommands([{ entityId, cmd, key, corrId }])[0];
  }

  toString(): string {
    return serverString(this.server);
  }
}

export { ParseError };
