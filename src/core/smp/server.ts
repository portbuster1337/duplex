// SMP server addresses: smp://<fingerprint>[:<password>]@<host>[,<host>...][:<port>]
import { b64url, fromB64, fromUtf8, utf8, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';

export interface ProtocolServer {
  scheme: 'smp' | 'xftp' | 'ntf';
  hosts: string[];
  /** empty for the default port */
  port: string;
  keyHash: Bytes;
}

export interface ServerWithAuth {
  server: ProtocolServer;
  basicAuth?: string;
}

const HOST_RE = /^[^:#,;/ \n\r\t[\]]+$/;

export function parseServer(s: string): ServerWithAuth {
  const m = s.trim().match(/^(smp|xftp|ntf):\/\/([A-Za-z0-9_-]+=*)(?::([^@]+))?@([^:/?#]+(?:,[^:/?#]+)*)(?::(\d+))?\/?$/);
  if (!m) throw new ParseError(`bad server address: ${s}`);
  const hosts = m[4].split(',');
  if (!hosts.every((h) => HOST_RE.test(h))) throw new ParseError(`bad server host: ${s}`);
  return {
    server: { scheme: m[1] as ProtocolServer['scheme'], keyHash: fromB64(m[2]), hosts, port: m[5] ?? '' },
    basicAuth: m[3],
  };
}

export function serverString(srv: ProtocolServer, basicAuth?: string): string {
  return `${srv.scheme}://${b64url(srv.keyHash)}${basicAuth ? ':' + basicAuth : ''}@${srv.hosts.join(',')}${srv.port ? ':' + srv.port : ''}`;
}

/** identifies a server for connection pooling and queue lookup (sameSrvAddr ignores the key hash) */
export function serverKey(srv: ProtocolServer): string {
  return `${srv.hosts[0]}:${srv.port}`;
}

export function sameServer(a: ProtocolServer, b: ProtocolServer): boolean {
  return a.hosts.length === b.hosts.length && a.hosts.every((h, i) => h === b.hosts[i]) && a.port === b.port;
}

export function encServer(e: Encoder, srv: ProtocolServer): Encoder {
  return e.list(srv.hosts, (e, h) => e.bytes(utf8(h))).bytes(utf8(srv.port)).bytes(srv.keyHash);
}

export function decServer(d: Decoder, scheme: ProtocolServer['scheme'] = 'smp'): ProtocolServer {
  const hosts = d.nonEmpty((d) => fromUtf8(d.bytes()));
  const port = fromUtf8(d.bytes());
  const keyHash = d.bytes();
  return { scheme, hosts, port, keyHash };
}

export function isOnion(host: string): boolean {
  return host.endsWith('.onion');
}
