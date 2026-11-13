// Persistence of agent connections and chat data in the encrypted vault.
import type { AgentStore, Conn } from '../core/agent/agent';
import type { Vault } from './vault';

/** agent connections, one record per connection plus an index */
export class VaultAgentStore implements AgentStore {
  private ids: Set<string> | undefined;
  private indexWrite: Promise<void> = Promise.resolve();

  constructor(
    private vault: Vault,
    private prefix = 'agent',
  ) {}

  private async index(): Promise<Set<string>> {
    if (!this.ids) this.ids = new Set((await this.vault.get<string[]>(`${this.prefix}:index`)) ?? []);
    return this.ids;
  }

  private saveIndex(): Promise<void> {
    const ids = [...this.ids!];
    this.indexWrite = this.indexWrite.then(() => this.vault.put(`${this.prefix}:index`, ids));
    return this.indexWrite;
  }

  async loadConns(): Promise<Conn[]> {
    const out: Conn[] = [];
    for (const id of await this.index()) {
      const c = await this.vault.get<Conn>(`${this.prefix}:conn:${id}`);
      if (c) out.push(c);
    }
    return out;
  }

  async saveConn(c: Conn): Promise<void> {
    const ids = await this.index();
    await this.vault.put(`${this.prefix}:conn:${c.id}`, c);
    if (!ids.has(c.id)) {
      ids.add(c.id);
      await this.saveIndex();
    }
  }

  async deleteConn(id: string): Promise<void> {
    const ids = await this.index();
    await this.vault.del(`${this.prefix}:conn:${id}`);
    if (ids.delete(id)) await this.saveIndex();
  }
}

/** a chat's items, stored in chunks so that appending rewrites only the last chunk */
export const ITEMS_PER_CHUNK = 50;

export class ItemStore<T extends { id: string }> {
  private writes = new Map<string, Promise<void>>();
  /** the number of stored chunks of each chat */
  private counts = new Map<string, number>();

  constructor(private vault: Vault) {}

  async load(chatId: string): Promise<T[]> {
    const meta = await this.vault.get<{ chunks: number }>(`items:${chatId}:meta`);
    this.counts.set(chatId, meta?.chunks ?? 0);
    if (!meta) return [];
    const out: T[] = [];
    for (let i = 0; i < meta.chunks; i++) out.push(...((await this.vault.get<T[]>(`items:${chatId}:${i}`)) ?? []));
    return out;
  }

  /**
   * writes the chunks from the one containing changedFrom; chunks past the end (after deletions) are
   * removed, so that deleted messages do not stay in the storage
   */
  save(chatId: string, items: T[], changedFrom = 0): Promise<void> {
    const prev = this.writes.get(chatId) ?? Promise.resolve();
    const snapshot = items.slice();
    const next = prev.then(async () => {
      const chunks = Math.max(1, Math.ceil(snapshot.length / ITEMS_PER_CHUNK));
      const stored = this.counts.get(chatId) ?? (await this.vault.get<{ chunks: number }>(`items:${chatId}:meta`))?.chunks ?? 0;
      for (let i = Math.floor(changedFrom / ITEMS_PER_CHUNK); i < chunks; i++) {
        await this.vault.put(`items:${chatId}:${i}`, snapshot.slice(i * ITEMS_PER_CHUNK, (i + 1) * ITEMS_PER_CHUNK));
      }
      await this.vault.put(`items:${chatId}:meta`, { chunks });
      for (let i = chunks; i < stored; i++) await this.vault.del(`items:${chatId}:${i}`);
      this.counts.set(chatId, chunks);
    });
    this.writes.set(chatId, next.catch(() => {}));
    return next;
  }

  delete(chatId: string): Promise<void> {
    const prev = this.writes.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const meta = await this.vault.get<{ chunks: number }>(`items:${chatId}:meta`);
      if (meta) for (let i = 0; i < meta.chunks; i++) await this.vault.del(`items:${chatId}:${i}`);
      await this.vault.del(`items:${chatId}:meta`);
      this.counts.set(chatId, 0);
    });
    this.writes.set(chatId, next.catch(() => {}));
    return next;
  }

  /** resolves when the pending writes are done */
  async idle(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }
}
