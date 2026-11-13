// Pool of SMP router connections with reconnection and resubscription, and private message routing:
// the commands of a queue's sender can go through another router (a proxy), so that the destination
// router does not see the sender's address or session (Simplex.Messaging.Agent.Client).
import { ProxyError, SMPClient, type AuthKey, type Connector } from '../smp/client';
import { serverKey, type ProtocolServer } from '../smp/server';
import { SMPError, type BrokerMsg, type Command } from '../smp/protocol';
import type { Bytes } from '../util/bytes';

/** when to use private routing (SMPProxyMode): always, for unknown servers, for unknown servers when the IP address is not protected, or never */
export type ProxyMode = 'always' | 'unknown' | 'unprotected' | 'never';
/** sending directly when private routing fails (SMPProxyFallback): yes, only when the IP address is protected, or no */
export type ProxyFallback = 'allow' | 'allowProtected' | 'prohibit';

export interface RoutingConfig {
  mode: ProxyMode;
  fallback: ProxyFallback;
  /** the routers the user uses: with mode 'unknown', commands to them are sent directly */
  known(): ProtocolServer[];
  /** the routers that can forward commands */
  proxies(): ProtocolServer[];
}

export const DEFAULT_ROUTING = { mode: 'unknown' as ProxyMode, fallback: 'allowProtected' as ProxyFallback };

/** the same router: a common host and the same port */
const sharesHost = (a: ProtocolServer, b: ProtocolServer) => a.port === b.port && a.hosts.some((h) => b.hosts.includes(h));
/** the operator of a router, approximated by the domain of its first host */
const operatorOf = (s: ProtocolServer) => s.hosts[0].split('.').slice(-2).join('.');

export interface NetworkEvents {
  /** a router event or a MSG delivered in response to SUB/ACK */
  onMessage(server: ProtocolServer, entityId: Bytes, msg: BrokerMsg): void;
  /** called after (re)connecting, so that the receiving queues can be subscribed */
  onConnected(server: ProtocolServer, client: SMPClient): void;
  onDisconnected(server: ProtocolServer, err?: Error): void;
}

interface Entry {
  server: ProtocolServer;
  client?: SMPClient;
  connecting?: Promise<SMPClient>;
  retryTimer?: ReturnType<typeof setTimeout>;
  failures: number;
  /** keep reconnecting while there are subscriptions */
  persistent: boolean;
  lastError?: string;
}

export class Network {
  private entries = new Map<string, Entry>();
  private stopped = false;
  routing: RoutingConfig | undefined;
  /** the proxy used for each destination router */
  private proxyFor = new Map<string, ProtocolServer>();
  /** commands sent to queues of other routers, directly and through proxies */
  readonly stats = { direct: 0, proxied: 0, fallback: 0 };

  constructor(
    public connector: Connector,
    private events: NetworkEvents,
  ) {}

  private entry(srv: ProtocolServer): Entry {
    const k = serverKey(srv);
    let e = this.entries.get(k);
    if (!e) {
      e = { server: srv, failures: 0, persistent: false };
      this.entries.set(k, e);
    }
    return e;
  }

  status(): Array<{ server: ProtocolServer; connected: boolean; error?: string }> {
    return [...this.entries.values()].map((e) => ({ server: e.server, connected: !!e.client && !e.client.isClosed, error: e.lastError }));
  }

  /** returns a connected client, connecting if needed */
  get(srv: ProtocolServer): Promise<SMPClient> {
    if (this.stopped) return Promise.reject(new Error('network stopped'));
    const e = this.entry(srv);
    if (e.client && !e.client.isClosed) return Promise.resolve(e.client);
    if (e.connecting) return e.connecting;
    const p = SMPClient.connect(e.server, {
      connector: this.connector,
      onEvent: (entityId, msg) => this.events.onMessage(e.server, entityId, msg),
      onClose: (c, err) => {
        if (e.client !== c) return;
        e.client = undefined;
        e.lastError = err?.message;
        this.events.onDisconnected(e.server, err);
        if (e.persistent && !this.stopped) this.scheduleReconnect(e);
      },
    });
    e.connecting = p;
    p.then(
      (c) => {
        e.connecting = undefined;
        e.client = c;
        e.failures = 0;
        e.lastError = undefined;
        if (this.stopped) {
          c.close();
          return;
        }
        this.events.onConnected(e.server, c);
      },
      (err) => {
        e.connecting = undefined;
        e.failures++;
        e.lastError = (err as Error).message;
        if (e.persistent && !this.stopped) this.scheduleReconnect(e);
      },
    );
    return p;
  }

  private scheduleReconnect(e: Entry): void {
    if (e.retryTimer) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(e.failures, 6)) * (0.75 + Math.random() * 0.5);
    e.retryTimer = setTimeout(() => {
      e.retryTimer = undefined;
      if (!this.stopped && e.persistent) this.get(e.server).catch(() => {});
    }, delay);
  }

  /** keeps a connection to this server (for subscribed queues) */
  keep(srv: ProtocolServer): void {
    const e = this.entry(srv);
    e.persistent = true;
    this.get(srv).catch(() => {});
  }

  release(srv: ProtocolServer): void {
    const e = this.entries.get(serverKey(srv));
    if (e) e.persistent = false;
  }

  /** reconnects now (e.g. when the browser comes back online) */
  retryAll(): void {
    for (const e of this.entries.values()) {
      if (e.persistent && !e.client && !e.connecting) {
        clearTimeout(e.retryTimer);
        e.retryTimer = undefined;
        e.failures = 0;
        this.get(e.server).catch(() => {});
      }
    }
  }

  async send(srv: ProtocolServer, entityId: Bytes, cmd: Command, key?: AuthKey): Promise<BrokerMsg> {
    const c = await this.get(srv);
    return c.sendCommand(entityId, cmd, key);
  }

  private isKnown(dest: ProtocolServer): boolean {
    return !!this.routing?.known().some((k) => sharesHost(k, dest));
  }

  /** whether a command to this router goes through a proxy (shouldUseProxy) */
  useProxy(dest: ProtocolServer): boolean {
    const r = this.routing;
    if (!r) return false;
    switch (r.mode) {
      case 'always':
        return true;
      case 'unknown':
        return !this.isKnown(dest);
      case 'unprotected':
        return !this.connector.ipProtected && !this.isKnown(dest);
      default:
        return false;
    }
  }

  private directAllowed(): boolean {
    const f = this.routing?.fallback ?? 'allow';
    return f === 'allow' || (f === 'allowProtected' && !!this.connector.ipProtected);
  }

  /** a random proxy, preferably of another operator than the destination and never one of its hosts if there is a choice */
  private pickProxy(dest: ProtocolServer): ProtocolServer {
    const all = this.routing?.proxies() ?? [];
    if (!all.length) throw new ProxyError('no routers to forward messages', '-');
    const otherHosts = all.filter((s) => !sharesHost(s, dest));
    const otherOperator = otherHosts.filter((s) => operatorOf(s) !== operatorOf(dest));
    const pool = otherOperator.length ? otherOperator : otherHosts.length ? otherHosts : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private async viaProxy(dest: ProtocolServer, entityId: Bytes, cmd: Command, key?: AuthKey): Promise<BrokerMsg> {
    const k = serverKey(dest);
    let proxy = this.proxyFor.get(k);
    if (!proxy) {
      proxy = this.pickProxy(dest);
      this.proxyFor.set(k, proxy);
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const pc = await this.get(proxy);
        const relay = await pc.proxiedRelay(dest);
        try {
          return await pc.proxyCommand(relay, entityId, cmd, key);
        } catch (e) {
          // the proxy lost its session with the destination: a new one is made once
          if (e instanceof ProxyError && e.noSession && attempt === 0) {
            pc.forgetRelay(dest);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      // another proxy is tried next time
      if (!(e instanceof SMPError)) this.proxyFor.delete(k);
      throw e;
    }
  }

  /**
   * a command of the sender of a queue (SEND, SKEY, LKEY, LGET): through a proxy when the routing
   * settings say so, directly when private routing fails and the fallback allows it. Errors of the
   * destination router (like AUTH) are not retried directly.
   */
  async sendToQueue(dest: ProtocolServer, entityId: Bytes, cmd: Command, key?: AuthKey): Promise<BrokerMsg> {
    if (!this.useProxy(dest)) {
      const r = await this.send(dest, entityId, cmd, key);
      this.stats.direct++;
      return r;
    }
    try {
      const r = await this.viaProxy(dest, entityId, cmd, key);
      this.stats.proxied++;
      return r;
    } catch (e) {
      if (e instanceof SMPError || this.stopped || !this.directAllowed()) throw e;
      const r = await this.send(dest, entityId, cmd, key);
      this.stats.fallback++;
      return r;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      clearTimeout(e.retryTimer);
      e.client?.close();
    }
    this.entries.clear();
  }
}
