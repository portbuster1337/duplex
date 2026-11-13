// XFTP client: a TLS connection to a file server (through the relay, like SMP), HTTP/2 inside it, the
// XFTP handshake, and authorized commands (Simplex.FileTransfer.Client). The server binds the session
// to the TLS connection, so all requests of a session use the same connection.
import { concat, equal, type Bytes } from '../util/bytes';
import { sha256, sign, type PrivateKey } from '../crypto/crypto';
import { compatibleVRange } from '../util/version';
import { TlsConnection } from '../net/tls13';
import { Http2Connection, Http2Error } from '../net/http2';
import { timeout } from '../net/stream';
import { parseCertificate, parseSignedObject, signKeyOf, verifySignedObject } from '../net/x509';
import { chooseHost, TransportError, verifyServerChain, type Connector } from '../smp/client';
import type { ProtocolServer } from '../smp/server';
import {
  decodeServerHandshake,
  decodeTransmission,
  encodeClientHandshake,
  encodeFileCommand,
  encodeTransmission,
  parseFileResponse,
  XFTP_BLOCK_SIZE,
  XFTP_VERSIONS,
  XFTPError,
  type FileCommand,
  type FileResponse,
} from './protocol';

export interface CommandOptions {
  /** ms; by default it depends on the size of the chunk sent or received */
  timeout?: number;
  /** the size of the chunk expected in the response */
  expectBody?: number;
  signal?: AbortSignal;
  /** the chunk bytes sent or received so far */
  onProgress?: (bytes: number) => void;
}

export const isAbort = (e: unknown): boolean => (e as Error | undefined)?.name === 'AbortError';

/** errors after which a new connection may help */
export function isRetriable(e: unknown): boolean {
  if (isAbort(e)) return false;
  if (e instanceof XFTPError) return e.code === 'SESSION' || e.code === 'HANDSHAKE' || e.code === 'TIMEOUT' || e.code === 'HTTP';
  return !(e instanceof TypeError) && !(e instanceof RangeError);
}

/** a generous timeout: 30 s plus 1 s per 32 KB, so that slow relays work */
export const transferTimeout = (bytes: number): number => 30000 + Math.ceil(bytes / 32768) * 1000;

export class XFTPClient {
  version = 1;
  sessionId: Bytes = new Uint8Array(0);
  private lastUsed = Date.now();

  private constructor(
    readonly server: ProtocolServer,
    private h2: Http2Connection,
  ) {}

  get label(): string {
    return this.server.hosts[0];
  }

  get isClosed(): boolean {
    return this.h2.isClosed;
  }

  get idleFor(): number {
    return this.h2.activeStreams ? 0 : Date.now() - this.lastUsed;
  }

  static async connect(server: ProtocolServer, connector: Connector): Promise<XFTPClient> {
    const host = chooseHost(server, !!connector.onion);
    const port = server.port ? Number(server.port) : 443;
    const stream = await connector.connect(host, port);
    let tls: TlsConnection;
    try {
      // no SNI: with SNI the server expects the handshake of its web page
      tls = await timeout(TlsConnection.connect(stream, { alpn: ['xftp/1'], verifyChain: (chain) => verifyServerChain(chain, server.keyHash) }), 30000, `TLS handshake with ${host} timed out`);
    } catch (e) {
      stream.close();
      throw e;
    }
    const c = new XFTPClient(server, new Http2Connection(tls, host));
    try {
      await timeout(c.handshake(tls), 30000, `XFTP handshake with ${host} timed out`);
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  private async handshake(tls: TlsConnection): Promise<void> {
    const r = await this.h2.request('/', undefined, { timeout: 30000, maxBody: XFTP_BLOCK_SIZE });
    if (r.status !== 200) throw new XFTPError('HANDSHAKE', `HTTP ${r.status}`);
    const hs = decodeServerHandshake(r.body);
    if (!equal(hs.sessionId, tls.tlsUnique)) throw new TransportError('bad XFTP session ID');
    // the identity certificate must be the one in the server address, and the session key must be
    // signed with the key of the TLS certificate
    if (hs.certChain.length !== 2 || !equal(sha256(hs.certChain[1]), this.server.keyHash)) throw new TransportError('XFTP server identity does not match its address');
    const so = parseSignedObject(hs.signedKey);
    if (!verifySignedObject(so, signKeyOf(parseCertificate(tls.certificates[0])))) throw new TransportError('bad XFTP server key signature');
    const vr = compatibleVRange(hs.versions, XFTP_VERSIONS);
    if (!vr) throw new TransportError(`incompatible XFTP server version ${hs.versions.min}-${hs.versions.max}`);
    this.version = vr.max;
    this.sessionId = hs.sessionId;
    const ack = await this.h2.request('/', encodeClientHandshake(this.version, this.server.keyHash), { timeout: 30000, maxBody: XFTP_BLOCK_SIZE });
    if (ack.status !== 200) throw new XFTPError('HANDSHAKE', `HTTP ${ack.status}`);
    if (ack.body.length) {
      // an error is sent as a padded block
      decodeTransmission(this.sessionId, ack.body);
      throw new XFTPError('HANDSHAKE', 'unexpected handshake response');
    }
  }

  /** sends a command signed with the key (except PING), with the chunk for FPUT */
  async command(key: PrivateKey<'ed25519'> | undefined, entityId: Bytes, cmd: FileCommand, data?: Bytes, opts: CommandOptions = {}): Promise<{ resp: FileResponse; body: Bytes }> {
    this.lastUsed = Date.now();
    const block = encodeTransmission(this.sessionId, entityId, encodeFileCommand(this.version, cmd), key ? (s) => sign(key, s) : undefined);
    const size = (data?.length ?? 0) + (opts.expectBody ?? 0);
    let r;
    try {
      const onProgress = opts.onProgress;
      r = await this.h2.request('/', data ? concat(block, data) : block, {
        timeout: opts.timeout ?? transferTimeout(size),
        maxBody: XFTP_BLOCK_SIZE + (opts.expectBody ?? 0) + 16,
        signal: opts.signal,
        // the command block comes before the chunk in both directions
        onProgress: onProgress && ((sent, received) => onProgress(Math.max(0, sent - XFTP_BLOCK_SIZE) + Math.max(0, received - XFTP_BLOCK_SIZE))),
      });
    } catch (e) {
      if (e instanceof Http2Error && /timed out/.test(e.message)) throw new XFTPError('TIMEOUT', `${cmd.tag} to ${this.label}`);
      throw e;
    } finally {
      this.lastUsed = Date.now();
    }
    if (r.status !== 200) throw new XFTPError('HTTP', `${r.status}`);
    if (r.body.length < XFTP_BLOCK_SIZE) throw new XFTPError('BLOCK', 'response too short');
    const { command } = decodeTransmission(this.sessionId, r.body.subarray(0, XFTP_BLOCK_SIZE));
    const resp = parseFileResponse(this.version, command);
    if (resp.tag === 'ERR') throw resp.err;
    return { resp, body: r.body.subarray(XFTP_BLOCK_SIZE) };
  }

  close(): void {
    this.h2.close();
  }
}

/** one connection per file server, reconnecting after errors and closing idle connections */
export class XFTPPool {
  private clients = new Map<string, Promise<XFTPClient>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private connector: () => Connector,
    private idleMs = 60000,
  ) {}

  private key(srv: ProtocolServer): string {
    return `${srv.hosts[0]}:${srv.port}`;
  }

  private get(srv: ProtocolServer, fresh = false): Promise<XFTPClient> {
    if (this.closed) return Promise.reject(new Error('stopped'));
    const k = this.key(srv);
    const cur = this.clients.get(k);
    if (cur && !fresh) {
      return cur.then(
        (c) => (c.isClosed ? this.get(srv, true) : c),
        () => this.get(srv, true),
      );
    }
    cur?.then((c) => c.close()).catch(() => {});
    const p = XFTPClient.connect(srv, this.connector());
    this.clients.set(k, p);
    p.catch(() => {
      if (this.clients.get(k) === p) this.clients.delete(k);
    });
    this.timer ??= setInterval(() => this.closeIdle(), Math.min(this.idleMs, 15000));
    return p;
  }

  private closeIdle(): void {
    for (const [k, p] of this.clients) {
      p.then((c) => {
        if (c.isClosed || c.idleFor > this.idleMs) {
          c.close();
          if (this.clients.get(k) === p) this.clients.delete(k);
        }
      }).catch(() => {});
    }
  }

  /**
   * runs f with a connected client, once more with a new connection after a network or session error
   * (unless retry is false: for commands that must not be repeated)
   */
  async with<T>(srv: ProtocolServer, f: (c: XFTPClient) => Promise<T>, opts: { retry?: boolean } = {}): Promise<T> {
    try {
      return await f(await this.get(srv));
    } catch (e) {
      if (!isRetriable(e) || this.closed || opts.retry === false) throw e;
      return f(await this.get(srv, true));
    }
  }

  /** closes the connections (e.g. after the relays changed); new requests make new ones */
  reset(): void {
    for (const p of this.clients.values()) p.then((c) => c.close()).catch(() => {});
    this.clients.clear();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.reset();
  }
}
