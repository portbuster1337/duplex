// Encrypted storage. All records are kept in one IndexedDB object store under keyed hashes of their
// names, encrypted with XChaCha20-Poly1305 under a random master key, padded to size buckets.
// The master key is encrypted with a key derived from the passphrase (Argon2id). Nothing else is
// stored in plaintext except the KDF parameters, so the database does not reveal contacts, chats
// or message counts beyond the number and approximate sizes of records.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64, b64urlNoPad, concat, fromB64, fromUtf8, randomBytes, utf8, type Bytes } from '../core/util/bytes';

export interface KvBackend {
  get(key: string): Promise<Bytes | undefined>;
  put(key: string, value: Bytes): Promise<void>;
  del(key: string): Promise<void>;
  /** all keys (for wiping) */
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MemoryBackend implements KvBackend {
  m = new Map<string, Bytes>();
  async get(k: string) {
    return this.m.get(k);
  }
  async put(k: string, v: Bytes) {
    this.m.set(k, v);
  }
  async del(k: string) {
    this.m.delete(k);
  }
  async keys() {
    return [...this.m.keys()];
  }
  async clear() {
    this.m.clear();
  }
}

export class IdbBackend implements KvBackend {
  private dbp: Promise<IDBDatabase>;
  constructor(readonly name = 'duplex') {
    this.dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('r');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const t = db.transaction('r', mode);
      const req = f(t.objectStore('r'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  async get(k: string) {
    const v = await this.tx('readonly', (s) => s.get(k));
    return v ? new Uint8Array(v as ArrayBuffer) : undefined;
  }
  async put(k: string, v: Bytes) {
    await this.tx('readwrite', (s) => s.put(v.slice().buffer, k));
  }
  async del(k: string) {
    await this.tx('readwrite', (s) => s.delete(k));
  }
  async keys() {
    return (await this.tx('readonly', (s) => s.getAllKeys())).map(String);
  }
  async clear() {
    await this.tx('readwrite', (s) => s.clear());
  }
}

/** JSON with binary values, as {"$b": base64} */
export function serialize(v: unknown): Bytes {
  return utf8(
    JSON.stringify(v, (_k, x) => {
      if (x instanceof Uint8Array) return { $b: b64(x) };
      return x;
    }),
  );
}

export function deserialize<T>(b: Bytes): T {
  return JSON.parse(fromUtf8(b), (_k, x) => (x && typeof x === 'object' && typeof x.$b === 'string' && Object.keys(x).length === 1 ? fromB64(x.$b) : x)) as T;
}

const META_KEY = 'meta';

export interface VaultMeta {
  v: 1;
  salt: string;
  kdf: { t: number; m: number; p: number };
  /** master key encrypted with the passphrase key */
  key: string;
  created: number;
}

export const DEFAULT_KDF = { t: 3, m: 65536, p: 1 };

function bucket(n: number): number {
  // pad to 256-byte steps up to 4 KB, then to the next power of two
  if (n <= 4096) return Math.ceil((n + 1) / 256) * 256;
  let p = 8192;
  while (p < n + 1) p *= 2;
  return p;
}

function padRecord(b: Bytes): Bytes {
  const len = bucket(b.length + 4);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}

function unpadRecord(b: Bytes): Bytes {
  const len = new DataView(b.buffer, b.byteOffset).getUint32(0);
  return b.subarray(4, 4 + len);
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase');
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('the storage is locked');
  }
}

export class Vault {
  private locked = false;

  private constructor(
    private backend: KvBackend,
    private master: Bytes,
  ) {}

  /** the master key, while unlocked: writes that were still pending when locking must not use a wiped key */
  private key(): Bytes {
    if (this.locked) throw new VaultLockedError();
    return this.master;
  }

  static async exists(backend: KvBackend): Promise<boolean> {
    return (await backend.get(META_KEY)) !== undefined;
  }

  private static async deriveKey(passphrase: string, salt: Bytes, kdf: VaultMeta['kdf'], onProgress?: (p: number) => void): Promise<Bytes> {
    return argon2idAsync(utf8(passphrase), salt, { ...kdf, dkLen: 32, onProgress, asyncTick: 20 });
  }

  static async create(backend: KvBackend, passphrase: string, kdf = DEFAULT_KDF, onProgress?: (p: number) => void): Promise<Vault> {
    const salt = randomBytes(16);
    const pk = await Vault.deriveKey(passphrase, salt, kdf, onProgress);
    const master = randomBytes(32);
    const nonce = randomBytes(24);
    const meta: VaultMeta = { v: 1, salt: b64(salt), kdf, key: b64(concat(nonce, xchacha20poly1305(pk, nonce).encrypt(master))), created: Date.now() };
    await backend.put(META_KEY, utf8(JSON.stringify(meta)));
    return new Vault(backend, master);
  }

  static async open(backend: KvBackend, passphrase: string, onProgress?: (p: number) => void): Promise<Vault> {
    const raw = await backend.get(META_KEY);
    if (!raw) throw new Error('no vault');
    const meta = JSON.parse(fromUtf8(raw)) as VaultMeta;
    const pk = await Vault.deriveKey(passphrase, fromB64(meta.salt), meta.kdf, onProgress);
    const enc = fromB64(meta.key);
    try {
      const master = xchacha20poly1305(pk, enc.subarray(0, 24)).decrypt(enc.subarray(24));
      return new Vault(backend, master);
    } catch {
      throw new WrongPassphraseError();
    }
  }

  /** re-encrypts the master key with a new passphrase */
  async changePassphrase(passphrase: string, kdf = DEFAULT_KDF, onProgress?: (p: number) => void): Promise<void> {
    const salt = randomBytes(16);
    const pk = await Vault.deriveKey(passphrase, salt, kdf, onProgress);
    const nonce = randomBytes(24);
    const meta: VaultMeta = { v: 1, salt: b64(salt), kdf, key: b64(concat(nonce, xchacha20poly1305(pk, nonce).encrypt(this.key()))), created: Date.now() };
    await this.backend.put(META_KEY, utf8(JSON.stringify(meta)));
  }

  private recordKey(name: string): string {
    return 'r' + b64urlNoPad(hmac(sha256, this.key(), utf8('record:' + name)));
  }

  private aad(name: string): Bytes {
    return sha256(utf8('aad:' + name));
  }

  async get<T>(name: string): Promise<T | undefined> {
    const raw = await this.backend.get(this.recordKey(name));
    if (!raw) return undefined;
    const pt = xchacha20poly1305(this.key(), raw.subarray(0, 24), this.aad(name)).decrypt(raw.subarray(24));
    return deserialize<T>(unpadRecord(pt));
  }

  async put(name: string, value: unknown): Promise<void> {
    const key = this.recordKey(name);
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(this.key(), nonce, this.aad(name)).encrypt(padRecord(serialize(value)));
    await this.backend.put(key, concat(nonce, ct));
  }

  async del(name: string): Promise<void> {
    await this.backend.del(this.recordKey(name));
  }

  /** deletes everything, including the KDF parameters */
  async wipe(): Promise<void> {
    this.lock();
    await this.backend.clear();
  }

  lock(): void {
    this.locked = true;
    this.master.fill(0);
  }

  get isLocked(): boolean {
    return this.locked;
  }
}
