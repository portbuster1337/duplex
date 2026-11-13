// The app session in the browser: the encrypted vault, the relay connector and the chat client.
import { ChatClient, PREFS_VERSION, type ChatSettings } from './chat';
import { IdbBackend, Vault, WrongPassphraseError, type KvBackend } from './vault';
import { WispConnection } from '../core/net/wisp';
import { timeout, type Stream } from '../core/net/stream';
import { SMPClient, type Connector } from '../core/smp/client';
import { parseServer, serverString, type ProtocolServer } from '../core/smp/server';
import { DEFAULT_SMP_SERVERS } from '../core/agent/presets';

/** public Wisp relays, so that the page works without installing anything */
export const PUBLIC_RELAYS = ['wss://wisp-server.wasmer.app/', 'wss://anura.pro/', 'wss://wisp.mercurywork.shop/'];

export const RELAY_NAMES: Record<string, string> = {
  'wss://wisp-server.wasmer.app/': 'Wasmer',
  'wss://anura.pro/': 'AnuraOS',
  'wss://wisp.mercurywork.shop/': 'Mercury Workshop',
};

/** the page is served from this computer (by relay/wisp-relay.mjs or the dev server), which has a relay at /wisp/ */
export const servedLocally = typeof location !== 'undefined' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

/** the relays used when none are configured: the public ones, or the relay that served the page */
export function defaultRelays(): string[] {
  if (servedLocally) return [`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`];
  return [...PUBLIC_RELAYS];
}

export interface NetworkSettings {
  /** Wisp relays tried in order; empty for the default relays */
  relays: string[];
  /** prefer .onion router addresses (needs a relay that connects through Tor) */
  onion: boolean;
}

export function effectiveRelays(n: NetworkSettings): string[] {
  return n.relays.length ? n.relays : defaultRelays();
}

export function relayName(url: string): string {
  if (RELAY_NAMES[url]) return RELAY_NAMES[url];
  if (servedLocally && url === defaultRelays()[0]) return 'this computer';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface AppSettings extends ChatSettings {
  network: NetworkSettings;
  /** lock after this many minutes without activity (0 - never) */
  autoLockMinutes: number;
  notifications: 'off' | 'hidden' | 'full';
}

/**
 * Opens TCP streams through the configured relays, keeping one WebSocket per relay. It sticks to the
 * relay that works and tries the others (in the configured order) only when it fails.
 */
export class RelayConnector implements Connector {
  private conns = new Map<string, WispConnection>();
  private preferred: string | undefined;
  private failedAt = new Map<string, number>();
  onStatus: (relay: string, ok: boolean, err?: string) => void = () => {};

  constructor(
    public relays: string[],
    public onion = false,
  ) {}

  /** the preferred relay first, the ones that failed in the last minute last */
  private order(): string[] {
    const now = Date.now();
    const failed = (u: string) => (now - (this.failedAt.get(u) ?? 0) < 60000 ? 1 : 0);
    const preferred = (u: string) => (u === this.preferred ? 0 : 1);
    return [...this.relays].sort((a, b) => failed(a) - failed(b) || preferred(a) - preferred(b));
  }

  async connect(host: string, port: number): Promise<Stream> {
    let lastErr: Error = new Error('no relays configured');
    for (const url of this.order()) {
      try {
        let w = this.conns.get(url);
        if (!w || w.isClosed) {
          w = new WispConnection(url);
          this.conns.set(url, w);
          const wc = w;
          w.onClose = () => {
            if (this.conns.get(url) === wc) this.conns.delete(url);
          };
          await timeout(w.ready(), 15000, `relay ${url} did not respond`);
          this.onStatus(url, true);
        }
        const s = await w.connect(host, port);
        this.preferred = url;
        this.failedAt.delete(url);
        return this.watch(url, s);
      } catch (e) {
        lastErr = e as Error;
        this.conns.get(url)?.close();
        this.conns.delete(url);
        this.failedAt.set(url, Date.now());
        this.onStatus(url, false, lastErr.message);
      }
    }
    throw lastErr;
  }

  /**
   * A relay can accept the WebSocket and still fail to reach a server (it may block the destination
   * or be overloaded): when a stream ends before any data arrives, the relay is tried last for a while.
   */
  private watch(url: string, s: Stream): Stream {
    let gotData = false;
    const failed = () => {
      if (gotData) return;
      this.failedAt.set(url, Date.now());
      if (this.preferred === url) this.preferred = undefined;
    };
    return {
      read: async () => {
        try {
          const b = await s.read();
          if (b) gotData = true;
          else failed();
          return b;
        } catch (e) {
          failed();
          throw e;
        }
      },
      write: (b) => s.write(b),
      close: () => {
        failed();
        s.close();
      },
    };
  }

  /**
   * whether servers see an IP address that is not linked to the user: Tor, or one of the public
   * relays (a relay of the user's own, on this computer or a server, shows the user's address)
   */
  get ipProtected(): boolean {
    return this.onion || (this.relays.length > 0 && this.relays.every((r) => PUBLIC_RELAYS.includes(r)));
  }

  /** the relays with an open WebSocket */
  connected(): string[] {
    return [...this.conns.entries()].filter(([, w]) => !w.isClosed).map(([u]) => u);
  }

  close(): void {
    for (const w of this.conns.values()) w.close();
    this.conns.clear();
  }
}

/** connects to a SimpleX server through this relay and returns the time in ms, or throws */
export async function testRelay(url: string, server: ProtocolServer = DEFAULT_SMP_SERVERS[0]): Promise<number> {
  const rc = new RelayConnector([url]);
  const t0 = performance.now();
  try {
    const c = await SMPClient.connect(server, { connector: rc, commandTimeout: 20000 });
    try {
      await c.sendCommand(new Uint8Array(0), { tag: 'PING' });
    } finally {
      c.close();
    }
    return Math.round(performance.now() - t0);
  } finally {
    rc.close();
  }
}

export function defaultSettings(displayName: string): AppSettings {
  return {
    profile: { displayName, fullName: '' },
    servers: DEFAULT_SMP_SERVERS.map((s) => serverString(s)),
    sendReceipts: true,
    shortLinks: true,
    network: { relays: [], onion: false },
    autoLockMinutes: 0,
    notifications: 'hidden',
    prefsVersion: PREFS_VERSION,
  };
}

export function parseServers(list: string[]): ProtocolServer[] {
  const out: ProtocolServer[] = [];
  for (const s of list) {
    try {
      out.push(parseServer(s).server);
    } catch {
      // ignore invalid entries
    }
  }
  return out;
}

export class Session {
  chat!: ChatClient;
  connector!: RelayConnector;
  private initial!: AppSettings;

  /** the chat client holds the current settings */
  get settings(): AppSettings {
    return (this.chat?.settings as AppSettings) ?? this.initial;
  }

  private constructor(readonly vault: Vault) {}

  static backend(): KvBackend {
    return new IdbBackend('duplex');
  }

  static exists(backend = Session.backend()): Promise<boolean> {
    return Vault.exists(backend);
  }

  static async create(displayName: string, passphrase: string, network?: NetworkSettings, onProgress?: (p: number) => void): Promise<Session> {
    const backend = Session.backend();
    const vault = await Vault.create(backend, passphrase, undefined, onProgress);
    const s = new Session(vault);
    s.initial = defaultSettings(displayName);
    if (network) s.initial.network = network;
    await vault.put('settings', s.initial);
    await s.startChat();
    return s;
  }

  static async open(passphrase: string, onProgress?: (p: number) => void): Promise<Session> {
    const backend = Session.backend();
    const vault = await Vault.open(backend, passphrase, onProgress);
    const s = new Session(vault);
    const saved = await vault.get<AppSettings>('settings');
    s.initial = { ...defaultSettings(saved?.profile?.displayName ?? 'me'), ...saved } as AppSettings;
    await s.startChat();
    return s;
  }

  private async startChat(): Promise<void> {
    const st = this.initial;
    this.connector = new RelayConnector(effectiveRelays(st.network), st.network.onion);
    this.chat = new ChatClient(this.vault, st, this.connector, parseServers(st.servers));
    await this.chat.start();
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    await this.chat.saveSettings(patch);
    if (patch.network) {
      this.connector.close();
      this.connector.relays = effectiveRelays(patch.network);
      this.connector.onion = patch.network.onion;
      this.chat.agent.network.connector = this.connector;
      this.chat.files.pool.reset();
      this.chat.agent.retryAll();
    }
    if (patch.servers) this.chat.agent.config.servers = parseServers(patch.servers);
  }

  /** disconnects, lets the running writes finish (for up to 3 seconds) and wipes the key from memory */
  async lock(): Promise<void> {
    if (this.vault.isLocked) return;
    this.chat.stop();
    this.connector.close();
    await Promise.race([this.chat.idle().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    this.vault.lock();
  }

  /**
   * deletes all data in this browser; with deleteQueues, the queues of all connections (contacts,
   * pending links, the address) are first deleted on the servers, for at most 10 seconds
   */
  async wipe(deleteQueues = false): Promise<void> {
    try {
      if (deleteQueues) {
        const agent = this.chat.agent;
        await Promise.race([Promise.allSettled(agent.allConns().map((c) => agent.deleteConnection(c.id))), new Promise((r) => setTimeout(r, 10000))]);
      }
      this.chat.stop();
      this.connector.close();
      await Promise.race([this.chat.idle().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      await this.vault.wipe();
    }
  }

  static async wipeLocked(): Promise<void> {
    await Session.backend().clear();
  }
}

export { WrongPassphraseError };
