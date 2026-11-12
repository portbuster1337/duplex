// A small TLS 1.3 client (RFC 8446) for connecting to SimpleX servers from the browser through a TCP
// tunnel: SMP servers use self-signed certificates identified by a fingerprint in the server address,
// which browsers' own TLS would reject, and SMP binds its sessions to the TLS Finished message.
//
// Supported: TLS_CHACHA20_POLY1305_SHA256, X25519 key exchange, Ed25519/Ed448 certificates, ALPN,
// KeyUpdate. No session resumption, no 0-RTT, no client certificates.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { ascii, concat, equal, fromAscii, randomBytes, type Bytes } from '../util/bytes';
import { verify, type PublicKey, type SignAlg } from '../crypto/crypto';
import { BufferedReader, ChunkQueue, StreamClosedError, type Stream } from './stream';

const CT_CCS = 20;
const CT_ALERT = 21;
const CT_HANDSHAKE = 22;
const CT_APPDATA = 23;

const HS_CLIENT_HELLO = 1;
const HS_SERVER_HELLO = 2;
const HS_NEW_SESSION_TICKET = 4;
const HS_ENCRYPTED_EXTENSIONS = 8;
const HS_CERTIFICATE = 11;
const HS_CERTIFICATE_REQUEST = 13;
const HS_CERTIFICATE_VERIFY = 15;
const HS_FINISHED = 20;
const HS_KEY_UPDATE = 24;

const TLS_CHACHA20_POLY1305_SHA256 = 0x1303;
const GROUP_X25519 = 0x001d;
const SIG_ED25519 = 0x0807;
const SIG_ED448 = 0x0808;

const HRR_RANDOM = Uint8Array.from(
  'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c'.match(/../g)!.map((h) => parseInt(h, 16)),
);

export class TlsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TlsError';
  }
}

export interface TlsOptions {
  alpn?: string[];
  /** SNI, omitted when undefined (SMP servers serve their web pages when SNI is sent) */
  serverName?: string;
  /** validates the server certificate chain (DER, leaf first) and returns the key that must sign CertificateVerify */
  verifyChain(chain: Bytes[]): PublicKey<SignAlg>;
}

function u16(n: number): Bytes {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function u24(n: number): Bytes {
  return Uint8Array.of((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

function vec8(b: Bytes): Bytes {
  return concat(Uint8Array.of(b.length), b);
}

function vec16(b: Bytes): Bytes {
  return concat(u16(b.length), b);
}

function ext(type: number, data: Bytes): Bytes {
  return concat(u16(type), vec16(data));
}

function hkdfExpandLabel(secret: Bytes, label: string, context: Bytes, length: number): Bytes {
  const info = concat(u16(length), vec8(ascii('tls13 ' + label)), vec8(context));
  return expand(sha256, secret, info, length);
}

function deriveSecret(secret: Bytes, label: string, transcriptHash: Bytes): Bytes {
  return hkdfExpandLabel(secret, label, transcriptHash, 32);
}

class Reader {
  pos = 0;
  constructor(readonly b: Bytes) {}
  u8(): number {
    if (this.pos + 1 > this.b.length) throw new TlsError('decode error');
    return this.b[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u24(): number {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8();
  }
  take(n: number): Bytes {
    if (this.pos + n > this.b.length) throw new TlsError('decode error');
    const r = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
  vec8(): Bytes {
    return this.take(this.u8());
  }
  vec16(): Bytes {
    return this.take(this.u16());
  }
  vec24(): Bytes {
    return this.take(this.u24());
  }
  get done(): boolean {
    return this.pos >= this.b.length;
  }
}

class TrafficKeys {
  seq = 0n;
  private key: Bytes;
  private iv: Bytes;
  constructor(public secret: Bytes) {
    this.key = hkdfExpandLabel(secret, 'key', new Uint8Array(0), 32);
    this.iv = hkdfExpandLabel(secret, 'iv', new Uint8Array(0), 12);
  }
  nonce(): Bytes {
    const n = this.iv.slice();
    let s = this.seq++;
    for (let i = 11; i >= 4; i--) {
      n[i] ^= Number(s & 0xffn);
      s >>= 8n;
    }
    return n;
  }
  seal(type: number, content: Bytes): Bytes {
    const inner = concat(content, Uint8Array.of(type));
    const hdr = concat(Uint8Array.of(CT_APPDATA, 3, 3), u16(inner.length + 16));
    const ct = chacha20poly1305(this.key, this.nonce(), hdr).encrypt(inner);
    return concat(hdr, ct);
  }
  open(hdr: Bytes, body: Bytes): { type: number; content: Bytes } {
    let pt: Bytes;
    try {
      pt = chacha20poly1305(this.key, this.nonce(), hdr).decrypt(body);
    } catch {
      throw new TlsError('bad record MAC');
    }
    let end = pt.length;
    while (end > 0 && pt[end - 1] === 0) end--;
    if (end === 0) throw new TlsError('record without content type');
    return { type: pt[end - 1], content: pt.subarray(0, end - 1) };
  }
  next(): TrafficKeys {
    return new TrafficKeys(hkdfExpandLabel(this.secret, 'traffic upd', new Uint8Array(0), 32));
  }
}

const ALERT_NAMES: Record<number, string> = {
  0: 'close_notify',
  10: 'unexpected_message',
  20: 'bad_record_mac',
  40: 'handshake_failure',
  42: 'bad_certificate',
  47: 'illegal_parameter',
  50: 'decode_error',
  51: 'decrypt_error',
  70: 'protocol_version',
  80: 'internal_error',
  109: 'missing_extension',
  110: 'unsupported_extension',
  120: 'no_application_protocol',
};

export class TlsConnection implements Stream {
  /** tls-unique channel binding: the client's Finished verify_data */
  tlsUnique: Bytes = new Uint8Array(0);
  serverFinished: Bytes = new Uint8Array(0);
  alpn: string | undefined;
  certificates: Bytes[] = [];

  private reader: BufferedReader;
  private rx: TrafficKeys | undefined;
  private tx: TrafficKeys | undefined;
  private app = new ChunkQueue();
  private hsBuf: Bytes = new Uint8Array(0);
  private closed = false;
  private pumping = false;
  private handshakeDone = false;

  private constructor(private transport: Stream) {
    this.reader = new BufferedReader(transport);
  }

  static async connect(transport: Stream, opts: TlsOptions): Promise<TlsConnection> {
    const c = new TlsConnection(transport);
    try {
      await c.handshake(opts);
    } catch (e) {
      c.closed = true;
      transport.close();
      throw e;
    }
    c.pump();
    return c;
  }

  private async readRecord(): Promise<{ type: number; hdr: Bytes; body: Bytes }> {
    const hdr = await this.reader.readExact(5);
    const len = (hdr[3] << 8) | hdr[4];
    if (len > 16384 + 256) throw new TlsError('record overflow');
    const body = await this.reader.readExact(len);
    return { type: hdr[0], hdr: hdr.slice(), body };
  }

  /** next record content, decrypted when keys are set; CCS records are skipped */
  private async nextContent(): Promise<{ type: number; content: Bytes }> {
    for (;;) {
      const r = await this.readRecord();
      if (r.type === CT_CCS) {
        // compatibility-mode CCS records are dropped until the handshake completes
        if (!this.handshakeDone && r.body.length === 1 && r.body[0] === 1) continue;
        throw new TlsError('unexpected change_cipher_spec');
      }
      if (this.rx) {
        if (r.type !== CT_APPDATA) throw new TlsError(`unexpected plaintext record ${r.type}`);
        const { type, content } = this.rx.open(r.hdr, r.body);
        if (type === CT_ALERT) this.alert(content);
        return { type, content };
      }
      if (r.type === CT_ALERT) this.alert(r.body);
      return { type: r.type, content: r.body };
    }
  }

  private alert(content: Bytes): never {
    const level = content[0];
    const desc = content[1];
    if (desc === 0) throw new StreamClosedError('TLS close_notify');
    throw new TlsError(`TLS alert ${level === 2 ? 'fatal' : 'warning'}: ${ALERT_NAMES[desc] ?? desc}`);
  }

  /** next complete handshake message (with its 4-byte header) */
  private async nextHandshake(): Promise<{ type: number; body: Bytes; raw: Bytes }> {
    for (;;) {
      if (this.hsBuf.length >= 4) {
        const len = (this.hsBuf[1] << 16) | (this.hsBuf[2] << 8) | this.hsBuf[3];
        if (this.hsBuf.length >= 4 + len) {
          const raw = this.hsBuf.slice(0, 4 + len);
          this.hsBuf = this.hsBuf.subarray(4 + len);
          return { type: raw[0], body: raw.subarray(4), raw };
        }
      }
      const { type, content } = await this.nextContent();
      if (type !== CT_HANDSHAKE) throw new TlsError(`expected handshake, got content type ${type}`);
      this.hsBuf = this.hsBuf.length ? concat(this.hsBuf, content) : content;
    }
  }

  private async handshake(opts: TlsOptions): Promise<void> {
    const priv = randomBytes(32);
    const pub = x25519.getPublicKey(priv);
    const exts: Bytes[] = [
      ext(0x002b, vec8(u16(0x0304))), // supported_versions
      ext(0x000a, vec16(u16(GROUP_X25519))), // supported_groups
      ext(0x000d, vec16(concat(u16(SIG_ED25519), u16(SIG_ED448)))), // signature_algorithms
      ext(0x0033, vec16(concat(u16(GROUP_X25519), vec16(pub)))), // key_share
    ];
    if (opts.alpn?.length) {
      exts.push(ext(0x0010, vec16(concat(...opts.alpn.map((p) => vec8(ascii(p)))))));
    }
    if (opts.serverName) {
      const name = ascii(opts.serverName);
      exts.push(ext(0x0000, vec16(concat(Uint8Array.of(0), vec16(name)))));
    }
    const chBody = concat(
      u16(0x0303),
      randomBytes(32),
      vec8(new Uint8Array(0)),
      vec16(u16(TLS_CHACHA20_POLY1305_SHA256)),
      Uint8Array.of(1, 0),
      vec16(concat(...exts)),
    );
    const ch = concat(Uint8Array.of(HS_CLIENT_HELLO), u24(chBody.length), chBody);
    this.transport.write(concat(Uint8Array.of(CT_HANDSHAKE, 3, 1), u16(ch.length), ch));
    const transcript: Bytes[] = [ch];
    const th = () => sha256(concat(...transcript));

    // ServerHello
    const sh = await this.nextHandshake();
    if (sh.type !== HS_SERVER_HELLO) throw new TlsError('expected ServerHello');
    const r = new Reader(sh.body);
    r.u16();
    const random = r.take(32);
    if (equal(random, HRR_RANDOM)) throw new TlsError('HelloRetryRequest is not supported');
    r.vec8();
    const suite = r.u16();
    if (suite !== TLS_CHACHA20_POLY1305_SHA256) throw new TlsError('server chose unsupported cipher suite');
    r.u8();
    const er = new Reader(r.vec16());
    let version = 0;
    let serverShare: Bytes | undefined;
    while (!er.done) {
      const t = er.u16();
      const d = new Reader(er.vec16());
      if (t === 0x002b) version = d.u16();
      else if (t === 0x0033) {
        if (d.u16() !== GROUP_X25519) throw new TlsError('server chose unsupported group');
        serverShare = d.vec16();
      }
    }
    if (version !== 0x0304) throw new TlsError('server does not support TLS 1.3');
    if (!serverShare || serverShare.length !== 32) throw new TlsError('no server key share');
    transcript.push(sh.raw);
    if (this.hsBuf.length) throw new TlsError('unexpected data after ServerHello');

    const shared = x25519.getSharedSecret(priv, serverShare);
    priv.fill(0);
    const zeros = new Uint8Array(32);
    const early = extract(sha256, zeros, zeros);
    const hs = extract(sha256, shared, deriveSecret(early, 'derived', sha256(new Uint8Array(0))));
    const h1 = th();
    const cHs = deriveSecret(hs, 'c hs traffic', h1);
    const sHs = deriveSecret(hs, 's hs traffic', h1);
    this.rx = new TrafficKeys(sHs);

    // EncryptedExtensions
    const ee = await this.nextHandshake();
    if (ee.type !== HS_ENCRYPTED_EXTENSIONS) throw new TlsError('expected EncryptedExtensions');
    const eer = new Reader(new Reader(ee.body).vec16());
    while (!eer.done) {
      const t = eer.u16();
      const d = new Reader(eer.vec16());
      if (t === 0x0010) this.alpn = fromAscii(new Reader(d.vec16()).vec8());
    }
    transcript.push(ee.raw);

    let msg = await this.nextHandshake();
    let certRequest: Bytes | undefined;
    if (msg.type === HS_CERTIFICATE_REQUEST) {
      certRequest = new Reader(msg.body).vec8();
      transcript.push(msg.raw);
      msg = await this.nextHandshake();
    }
    if (msg.type !== HS_CERTIFICATE) throw new TlsError('expected Certificate');
    const cr = new Reader(msg.body);
    cr.vec8();
    const list = new Reader(cr.vec24());
    const chain: Bytes[] = [];
    while (!list.done) {
      chain.push(list.vec24().slice());
      list.vec16();
    }
    this.certificates = chain;
    const leafKey = opts.verifyChain(chain);
    transcript.push(msg.raw);

    const cv = await this.nextHandshake();
    if (cv.type !== HS_CERTIFICATE_VERIFY) throw new TlsError('expected CertificateVerify');
    const cvr = new Reader(cv.body);
    const scheme = cvr.u16();
    const sig = cvr.vec16();
    const alg = scheme === SIG_ED25519 ? 'ed25519' : scheme === SIG_ED448 ? 'ed448' : undefined;
    if (!alg || alg !== leafKey.alg) throw new TlsError('unsupported CertificateVerify signature scheme');
    const signed = concat(new Uint8Array(64).fill(0x20), ascii('TLS 1.3, server CertificateVerify'), Uint8Array.of(0), th());
    if (!verify(leafKey, sig, signed)) throw new TlsError('invalid CertificateVerify signature');
    transcript.push(cv.raw);

    const fin = await this.nextHandshake();
    if (fin.type !== HS_FINISHED) throw new TlsError('expected Finished');
    const expected = hmac(sha256, hkdfExpandLabel(sHs, 'finished', new Uint8Array(0), 32), th());
    if (!equal(fin.body, expected)) throw new TlsError('invalid server Finished');
    this.serverFinished = fin.body.slice();
    transcript.push(fin.raw);

    const h3 = th();
    const master = extract(sha256, zeros, deriveSecret(hs, 'derived', sha256(new Uint8Array(0))));
    const cAp = deriveSecret(master, 'c ap traffic', h3);
    const sAp = deriveSecret(master, 's ap traffic', h3);

    const txHs = new TrafficKeys(cHs);
    const out: Bytes[] = [];
    if (certRequest !== undefined) {
      const body = concat(vec8(certRequest), u24(0));
      const m = concat(Uint8Array.of(HS_CERTIFICATE), u24(body.length), body);
      transcript.push(m);
      out.push(txHs.seal(CT_HANDSHAKE, m));
    }
    const verifyData = hmac(sha256, hkdfExpandLabel(cHs, 'finished', new Uint8Array(0), 32), th());
    const cfin = concat(Uint8Array.of(HS_FINISHED), u24(verifyData.length), verifyData);
    out.push(txHs.seal(CT_HANDSHAKE, cfin));
    this.transport.write(concat(...out));
    this.tlsUnique = verifyData;
    this.rx = new TrafficKeys(sAp);
    this.tx = new TrafficKeys(cAp);
    this.handshakeDone = true;
    if (this.hsBuf.length) throw new TlsError('unexpected handshake data after Finished');
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const { type, content } = await this.nextContent();
        if (type === CT_APPDATA) {
          if (content.length) this.app.push(content.slice());
        } else if (type === CT_HANDSHAKE) {
          this.hsBuf = this.hsBuf.length ? concat(this.hsBuf, content) : content;
          while (this.hsBuf.length >= 4) {
            const len = (this.hsBuf[1] << 16) | (this.hsBuf[2] << 8) | this.hsBuf[3];
            if (this.hsBuf.length < 4 + len) break;
            const t = this.hsBuf[0];
            const body = this.hsBuf.subarray(4, 4 + len);
            this.hsBuf = this.hsBuf.subarray(4 + len);
            if (t === HS_KEY_UPDATE) {
              this.rx = this.rx!.next();
              if (body[0] === 1 && this.tx) {
                const ku = concat(Uint8Array.of(HS_KEY_UPDATE), u24(1), Uint8Array.of(0));
                this.transport.write(this.tx.seal(CT_HANDSHAKE, ku));
                this.tx = this.tx.next();
              }
            } else if (t !== HS_NEW_SESSION_TICKET) {
              throw new TlsError(`unexpected post-handshake message ${t}`);
            }
          }
        } else {
          throw new TlsError(`unexpected content type ${type}`);
        }
      }
    } catch (e) {
      this.app.end(e instanceof StreamClosedError ? undefined : (e as Error));
      this.close();
    }
  }

  read(): Promise<Bytes | null> {
    return this.app.read();
  }

  write(data: Bytes): void {
    if (this.closed || !this.tx) throw new StreamClosedError();
    const recs: Bytes[] = [];
    for (let off = 0; off < data.length; off += 16384) {
      recs.push(this.tx.seal(CT_APPDATA, data.subarray(off, Math.min(data.length, off + 16384))));
    }
    this.transport.write(recs.length === 1 ? recs[0] : concat(...recs));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.tx) this.transport.write(this.tx.seal(CT_ALERT, Uint8Array.of(1, 0)));
    } catch {
      // the transport may already be closed
    }
    this.transport.close();
    this.app.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
