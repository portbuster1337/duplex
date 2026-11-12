#!/usr/bin/env node
// Duplex relay: a Wisp v1 relay (https://github.com/MercuryWorkshop/wisp-protocol) and a static file
// server, with no dependencies. It is optional: the published page uses public Wisp relays.
//
// Browsers cannot open TCP connections, so Duplex asks a Wisp relay for TCP streams to SimpleX
// servers and runs TLS inside them (src/core/net/tls13.ts): the relay passes encrypted bytes and
// sees only which servers are used. This relay makes no connections of its own and keeps no logs.
// WebSocket connections are accepted on any path (the page served by this relay uses /wisp/), from
// pages served on this computer and from the origins allowed below.
//
// Usage: node relay/wisp-relay.mjs [options]
//   --port 8745           listen port (env PORT)
//   --host 127.0.0.1      listen address (env HOST)
//   --dist ./dist         directory with the built app to serve (env DIST), "none" to disable;
//                         site/ (the about page) is served too
//   --tor                 connect through Tor (SOCKS5 at 127.0.0.1:9050), also allows .onion hosts
//   --socks5 HOST:PORT    connect through this SOCKS5 proxy
//   --allow-private       allow connections to private/loopback addresses (for testing with a local server)
//   --allow-origin URL    another page origin allowed to use this relay (repeatable; env ALLOWED_ORIGINS, comma separated)
//   --ports LIST          allowed destination ports, e.g. "443,5223,1024-65535" (default)
//   --verbose             log streams (destinations only)
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const opts = (n) => args.flatMap((a, i) => (a === `--${n}` && i + 1 < args.length ? [args[i + 1]] : []));

const PORT = Number(opt('port', process.env.PORT || 8745));
const HOST = opt('host', process.env.HOST || '127.0.0.1');
const DIST = opt('dist', process.env.DIST || path.join(__dirname, '..', 'dist'));
// the about page and the other files published with the app (site/), served when not in DIST
const SITE = path.join(__dirname, '..', 'site');
const SOCKS = flag('tor') ? '127.0.0.1:9050' : opt('socks5', process.env.SOCKS5 || '');
const ALLOW_PRIVATE = flag('allow-private');
const VERBOSE = flag('verbose');
const ORIGINS = new Set(['https://portbuster.codeberg.page', ...opts('allow-origin'), ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)].map((o) => o.replace(/\/$/, '')));
const PORTS = parsePorts(opt('ports', '443,5223,1024-65535'));
const BUFFER = 128;

function parsePorts(s) {
  const ranges = s.split(',').map((p) => p.split('-').map(Number));
  return (port) => ranges.some(([a, b]) => (b ? port >= a && port <= b : port === a));
}

const log = (...a) => VERBOSE && console.log(new Date().toISOString(), ...a);

// ---- destination policy

function isPublicIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isPublicIPv6(ip) {
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (first & 0xe000) === 0x2000;
}

async function resolveAllowed(host) {
  if (host.endsWith('.onion')) {
    if (!SOCKS) throw new Error('onion hosts need --tor');
    return host;
  }
  if (SOCKS) return host; // resolved by the proxy (e.g. Tor), so DNS does not leak here
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  const ok = ips.find((ip) => ALLOW_PRIVATE || (net.isIPv4(ip) ? isPublicIPv4(ip) : isPublicIPv6(ip)));
  if (!ok) throw new Error('destination not allowed');
  return ok;
}

function socksConnect(host, port) {
  const [ph, pp] = SOCKS.split(':');
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(pp), ph);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (e) => {
      s.destroy();
      reject(e);
    };
    s.once('error', fail);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS auth rejected'));
        buf = buf.subarray(2);
        stage = 1;
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1 && buf.length >= 5) {
        if (buf[1] !== 0) return fail(new Error(`SOCKS connect failed (${buf[1]})`));
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        s.removeListener('data', onData);
        s.removeListener('error', fail);
        const rest = buf.subarray(len);
        resolve({ socket: s, rest });
      }
    };
    s.on('data', onData);
  });
}

async function openTcp(host, port) {
  if (!PORTS(port)) throw new Error('port not allowed');
  const dest = await resolveAllowed(host);
  if (SOCKS) return socksConnect(dest, port);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, dest, () => {
      s.removeListener('error', reject);
      resolve({ socket: s, rest: Buffer.alloc(0) });
    });
    s.once('error', reject);
    s.setTimeout(20000, () => s.destroy(new Error('timeout')));
  });
}

// ---- WebSocket (RFC 6455)

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) hdr = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x80 | opcode;
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([hdr, payload]);
}

function wispPacket(type, id, payload) {
  const p = Buffer.alloc(5 + payload.length);
  p[0] = type;
  p.writeUInt32LE(id, 1);
  payload.copy(p, 5);
  return p;
}

function handleWisp(sock) {
  const streams = new Map();
  let buf = Buffer.alloc(0);
  let fragments = [];
  const send = (type, id, payload) => {
    if (!sock.destroyed) sock.write(wsFrame(2, wispPacket(type, id, payload)));
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const closeStream = (id, reason) => {
    const st = streams.get(id);
    if (!st) return;
    streams.delete(id);
    st.socket?.destroy();
    send(4, id, Buffer.from([reason]));
  };
  send(3, 0, u32(BUFFER));

  const onPacket = (p) => {
    if (p.length < 5) return;
    const type = p[0];
    const id = p.readUInt32LE(1);
    const payload = p.subarray(5);
    if (type === 1) {
      if (streams.has(id) || payload.length < 4 || payload[0] !== 1) return send(4, id, Buffer.from([0x41]));
      const port = payload.readUInt16LE(1);
      const host = payload.subarray(3).toString();
      const st = { socket: undefined, pending: [], received: 0 };
      streams.set(id, st);
      log('connect', host, port);
      openTcp(host, port).then(
        ({ socket, rest }) => {
          if (!streams.has(id)) return socket.destroy();
          st.socket = socket;
          if (rest.length) send(2, id, rest);
          for (const d of st.pending) socket.write(d);
          st.pending = [];
          socket.on('data', (d) => send(2, id, d));
          socket.on('close', () => closeStream(id, 2));
          socket.on('error', () => closeStream(id, 3));
          socket.setTimeout(0);
        },
        (e) => {
          log('connect failed', host, port, e.message);
          closeStream(id, /not allowed/.test(e.message) ? 0x48 : /ENOTFOUND|EAI_AGAIN/.test(e.message) ? 0x42 : /timeout/.test(e.message) ? 0x43 : 0x44);
        },
      );
    } else if (type === 2) {
      const st = streams.get(id);
      if (!st) return;
      if (st.socket) st.socket.write(payload);
      else st.pending.push(Buffer.from(payload));
      if (++st.received >= BUFFER / 2) {
        st.received = 0;
        send(3, id, u32(BUFFER));
      }
    } else if (type === 4) {
      const st = streams.get(id);
      if (st) {
        streams.delete(id);
        st.socket?.destroy();
      }
    }
  };

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > 1 << 20) return sock.destroy();
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + maskLen + len);
      if (op === 8) {
        sock.end(wsFrame(8, Buffer.alloc(0)));
        return;
      }
      if (op === 9) {
        sock.write(wsFrame(10, data));
        continue;
      }
      if (op === 10) continue;
      fragments.push(data);
      if (fin) {
        const msg = Buffer.concat(fragments);
        fragments = [];
        onPacket(msg);
      }
    }
  });
  sock.on('close', () => {
    for (const st of streams.values()) st.socket?.destroy();
    streams.clear();
  });
  sock.on('error', () => {});
}

// ---- static files

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function serveStatic(req, res) {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p.endsWith('/')) p += 'index.html';
  const roots = [DIST, SITE].filter((d) => d !== 'none' && fs.existsSync(d)).map((d) => path.resolve(d));
  if (!roots.length) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Duplex relay\n');
  }
  const candidates = roots.map((root) => ({ root, file: path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, '')) })).filter(({ root, file }) => file.startsWith(root + path.sep));
  const found = candidates.find(({ file }) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  fs.readFile(found.file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(found.file)] || 'application/octet-stream',
      'content-security-policy': CSP,
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
server.on('upgrade', (req, sock) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const own = [`http://${req.headers.host}`, `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
  if (origin && !own.includes(origin) && !local && !ORIGINS.has(origin)) {
    log('rejected origin', origin);
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
  sock.setNoDelay(true);
  handleWisp(sock);
});

server.listen(PORT, HOST, () => {
  console.log(`Duplex relay listening on http://${HOST}:${PORT}/ (Wisp: ws://${HOST}:${PORT}/)${SOCKS ? `, via SOCKS5 ${SOCKS}` : ''}${ALLOW_PRIVATE ? ', private addresses allowed' : ''}`);
});
