// Pool of SMP router connections with reconnection and resubscription.
import { SMPClient, type AuthKey, type Connector } from '../smp/client';
import { serverKey, type ProtocolServer } from '../smp/server';
import type { BrokerMsg, Command } from '../smp/protocol';
import type { Bytes } from '../util/bytes';

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

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      clearTimeout(e.retryTimer);
      e.client?.close();
    }
    this.entries.clear();
  }
}
