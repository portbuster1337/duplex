// SimpleX file descriptions (Simplex.FileTransfer.Description): the key, digests and chunk replicas that
// a recipient needs to download a file, or a sender to delete it, as YAML text. Recipients get theirs in
// x.msg.file.descr messages.
import { b64url, compare, equal, fromB64, type Bytes } from '../util/bytes';
import { ParseError } from '../util/encoding';
import { parseServer, serverString, type ProtocolServer } from '../smp/server';
import { parseYaml, yamlScalar, type YamlValue } from '../util/yaml';
import type { PrivateKey } from '../crypto/crypto';
import { CHUNK_SIZES, parseFileSize, strFileSize } from './protocol';

export interface FileChunkReplica {
  server: ProtocolServer;
  replicaId: Bytes;
  /** signs the commands for this replica (FGET of the recipient, FDEL of the sender) */
  replicaKey: PrivateKey<'ed25519'>;
}

export interface FileChunk {
  chunkNo: number;
  chunkSize: number;
  /** SHA-256 of the encrypted chunk */
  digest: Bytes;
  replicas: FileChunkReplica[];
}

export interface FileDescription {
  party: 'recipient' | 'sender';
  /** the size of the encrypted file, the sum of the chunk sizes */
  size: number;
  /** SHA-512 of the encrypted file */
  digest: Bytes;
  key: Bytes;
  nonce: Bytes;
  /** the default chunk size: chunks of other sizes have their size in the description */
  chunkSize: number;
  chunks: FileChunk[];
  /** the description of another file (used for links to files, not in chats) */
  redirect?: { size: number; digest: Bytes };
}

const ED25519_PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

/** the DER encoding (PKCS #8) of an Ed25519 private key, as in C.encodePrivKey */
export function encodePrivKey(k: PrivateKey<'ed25519'>): Bytes {
  const out = new Uint8Array(ED25519_PKCS8.length + 32);
  out.set(ED25519_PKCS8);
  out.set(k.key, ED25519_PKCS8.length);
  return out;
}

export function decodePrivKey(der: Bytes): PrivateKey<'ed25519'> {
  if (der.length !== ED25519_PKCS8.length + 32 || !equal(der.subarray(0, ED25519_PKCS8.length), ED25519_PKCS8)) {
    throw new ParseError('unsupported replica key: only Ed25519 keys are supported');
  }
  return { alg: 'ed25519', key: der.slice(ED25519_PKCS8.length) };
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** the Ord instance of TransportHost: IPv4 < IPv6 < onion < domain name, then the address */
function hostOrder(a: string, b: string): number {
  const kind = (h: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? 0 : h.includes(':') ? 1 : /^[a-z0-9]+\.onion$/.test(h) ? 2 : 3);
  const ka = kind(a);
  const kb = kind(b);
  if (ka !== kb) return ka - kb;
  if (ka === 0) {
    const na = a.split('.').map(Number);
    const nb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (na[i] !== nb[i]) return na[i] - nb[i];
    return 0;
  }
  return cmp(a, b);
}

/** servers in the order of the Ord instance of ProtocolServer: hosts, port, key hash */
function serverOrder(a: ProtocolServer, b: ProtocolServer): number {
  for (let i = 0; i < Math.min(a.hosts.length, b.hosts.length); i++) {
    const o = hostOrder(a.hosts[i], b.hosts[i]);
    if (o) return o;
  }
  return a.hosts.length - b.hosts.length || cmp(a.port, b.port) || compare(a.keyHash, b.keyHash);
}

/** the YAML text, as Data.Yaml writes it: keys in alphabetical order, replicas grouped by server */
export function encodeFileDescription(fd: FileDescription): string {
  const lines: string[] = [];
  const kv = (k: string, v: string, indent = '') => lines.push(`${indent}${k}: ${yamlScalar(v)}`);
  kv('chunkSize', strFileSize(fd.chunkSize));
  kv('digest', b64url(fd.digest));
  kv('key', b64url(fd.key));
  kv('nonce', b64url(fd.nonce));
  kv('party', fd.party);
  if (fd.redirect) {
    lines.push('redirect:');
    kv('digest', b64url(fd.redirect.digest), '  ');
    lines.push(`  size: ${fd.redirect.size}`);
  }
  // unfoldChunksToReplicas: the digest and a non-default size are written with the first replica only
  const flat: Array<{ server: ProtocolServer; text: string }> = [];
  for (const c of fd.chunks) {
    c.replicas.forEach((r, i) => {
      let text = `${c.chunkNo}:${b64url(r.replicaId)}:${b64url(encodePrivKey(r.replicaKey))}`;
      if (i === 0) {
        text += `:${b64url(c.digest)}`;
        if (c.chunkSize !== fd.chunkSize) text += `:${strFileSize(c.chunkSize)}`;
      }
      flat.push({ server: r.server, text });
    });
  }
  const groups: Array<{ server: ProtocolServer; chunks: string[] }> = [];
  for (const r of flat) {
    const g = groups.find((g) => serverOrder(g.server, r.server) === 0);
    if (g) g.chunks.push(r.text);
    else groups.push({ server: r.server, chunks: [r.text] });
  }
  groups.sort((a, b) => serverOrder(a.server, b.server));
  lines.push('replicas:');
  for (const g of groups) {
    lines.push('- chunks:');
    for (const c of g.chunks) lines.push(`  - ${yamlScalar(c)}`);
    kv('server', serverString(g.server), '  ');
  }
  kv('size', strFileSize(fd.size));
  return lines.join('\n') + '\n';
}

function str(v: YamlValue | undefined, name: string): string {
  if (typeof v !== 'string') throw new ParseError(`file description: bad ${name}`);
  return v;
}

function bytes(v: YamlValue | undefined, name: string, len?: number): Bytes {
  const b = fromB64(str(v, name));
  if (len !== undefined && b.length !== len) throw new ParseError(`file description: bad ${name}`);
  return b;
}

/** the checks of AFileDescription strDecode and validateFileDescription */
export function decodeFileDescription(text: string): FileDescription {
  if (text.includes('*')) throw new ParseError('file description: YAML aliases are not allowed');
  if (/[0-9a-fA-F]{65}/.test(text)) throw new ParseError('file description: number too long');
  const y = parseYaml(text);
  if (!y || typeof y !== 'object' || Array.isArray(y)) throw new ParseError('file description: not a mapping');
  const party = str(y.party, 'party');
  if (party !== 'recipient' && party !== 'sender') throw new ParseError('file description: bad party');
  const size = parseFileSize(str(y.size, 'size'));
  const chunkSize = parseFileSize(str(y.chunkSize, 'chunkSize'));
  const fd: FileDescription = { party, size, digest: bytes(y.digest, 'digest'), key: bytes(y.key, 'key', 32), nonce: bytes(y.nonce, 'nonce', 24), chunkSize, chunks: [] };
  if (y.redirect !== undefined && y.redirect !== '') {
    const r = y.redirect;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ParseError('file description: bad redirect');
    const rs = Number(str(r.size, 'redirect size'));
    if (!Number.isSafeInteger(rs) || rs < 0) throw new ParseError('file description: bad redirect size');
    fd.redirect = { size: rs, digest: bytes(r.digest, 'redirect digest') };
  }
  const replicas = y.replicas;
  if (!Array.isArray(replicas)) throw new ParseError('file description: bad replicas');
  const chunks = new Map<number, FileChunk>();
  const sizes = new Map<number, number>();
  const digests = new Map<number, Bytes>();
  const parsed: Array<{ chunkNo: number; replica: FileChunkReplica }> = [];
  for (const g of replicas) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw new ParseError('file description: bad replica group');
    const server = parseServer(str(g.server, 'server')).server;
    if (server.scheme !== 'xftp') throw new ParseError('file description: not an XFTP server');
    const cs = g.chunks;
    if (!Array.isArray(cs)) throw new ParseError('file description: bad chunks');
    for (const c of cs) {
      const parts = str(c, 'chunk replica').split(':');
      if (parts.length < 3 || parts.length > 5 || !/^\d+$/.test(parts[0])) throw new ParseError('file description: bad chunk replica');
      const chunkNo = Number(parts[0]);
      const replica = { server, replicaId: fromB64(parts[1]), replicaKey: decodePrivKey(fromB64(parts[2])) };
      if (parts[3] !== undefined) {
        const d = fromB64(parts[3]);
        const prev = digests.get(chunkNo);
        if (prev && !equal(prev, d)) throw new ParseError('file description: different digests in chunk replicas');
        digests.set(chunkNo, d);
      }
      if (parts[4] !== undefined) {
        const s = parseFileSize(parts[4]);
        const prev = sizes.get(chunkNo);
        if (prev !== undefined && prev !== s) throw new ParseError('file description: different sizes in chunk replicas');
        sizes.set(chunkNo, s);
      }
      parsed.push({ chunkNo, replica });
    }
  }
  for (const { chunkNo, replica } of parsed) {
    let c = chunks.get(chunkNo);
    if (!c) {
      const digest = digests.get(chunkNo);
      if (!digest) throw new ParseError('file description: no digest for chunk');
      c = { chunkNo, chunkSize: sizes.get(chunkNo) ?? chunkSize, digest, replicas: [] };
      chunks.set(chunkNo, c);
    }
    c.replicas.push(replica);
  }
  fd.chunks = [...chunks.values()].sort((a, b) => a.chunkNo - b.chunkNo);
  validateFileDescription(fd);
  return fd;
}

export function validateFileDescription(fd: FileDescription): void {
  if (!fd.chunks.every((c, i) => c.chunkNo === i + 1)) throw new ParseError('file description: chunk numbers are not sequential');
  if (fd.chunks.reduce((s, c) => s + c.chunkSize, 0) !== fd.size) throw new ParseError('file description: chunks total size is different than file size');
  if (fd.chunks.some((c) => !CHUNK_SIZES.includes(c.chunkSize))) throw new ParseError('file description: incorrect chunk size');
  if (fd.chunks.some((c) => c.replicas.length > 16)) throw new ParseError('file description: too many chunk replicas');
  if (fd.chunks.reduce((s, c) => s + c.replicas.length, 0) > 131072) throw new ParseError('file description: too many file replicas');
}

/** the servers used by a description */
export function descriptionServers(fd: FileDescription): ProtocolServer[] {
  const out: ProtocolServer[] = [];
  for (const c of fd.chunks) for (const r of c.replicas) if (!out.some((s) => serverOrder(s, r.server) === 0)) out.push(r.server);
  return out;
}
