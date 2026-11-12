// Checks that an SMP server can be reached, directly or through a Wisp relay, and that a queue works:
//   npx tsx scripts/check-server.ts smp://<fingerprint>@<host>[:<port>] [wss://relay/]
import { SMPClient } from '../src/core/smp/client';
import { parseServer } from '../src/core/smp/server';
import { WispConnection } from '../src/core/net/wisp';
import { dh, generateKeyPair } from '../src/core/crypto/crypto';
import { decryptRcvMsg, type BrokerMsg } from '../src/core/smp/protocol';
import { fromUtf8, utf8 } from '../src/core/util/bytes';
import { tcpConnector } from '../test/helpers/tcp';

const [addr, relay] = process.argv.slice(2);
if (!addr) {
  console.error('usage: npx tsx scripts/check-server.ts smp://<fingerprint>@<host>[:<port>] [wss://relay/]');
  process.exit(2);
}
const srv = parseServer(addr).server;
const wisp = relay ? new WispConnection(relay) : undefined;
const connector = wisp ? { connect: (h: string, p: number) => wisp.connect(h, p) } : tcpConnector;
let gotMsg: (m: Extract<BrokerMsg, { tag: 'MSG' }>) => void = () => {};
const msgP = new Promise<Extract<BrokerMsg, { tag: 'MSG' }>>((r) => (gotMsg = r));
const t0 = Date.now();
const c = await SMPClient.connect(srv, { connector, onEvent: (_id, m) => m.tag === 'MSG' && gotMsg(m) });
console.log(`connected in ${Date.now() - t0} ms${relay ? ` via ${relay}` : ''}, SMP version ${c.version} (server ${c.serverVersions.min}-${c.serverVersions.max})`);
console.log('PING ->', (await c.sendCommand(new Uint8Array(0), { tag: 'PING' })).tag);
const rk = generateKeyPair('ed25519');
const dhk = generateKeyPair('x25519');
const ids = await c.sendCommand(new Uint8Array(0), { tag: 'NEW', rcvAuthKey: rk.pub, rcvDhKey: dhk.pub, subscribe: true, reqData: { mode: 'M' } }, rk.priv);
if (ids.tag !== 'IDS') throw new Error(`unexpected response ${ids.tag}`);
console.log('NEW ->', ids.tag);
console.log('SEND ->', (await c.sendCommand(ids.sndId, { tag: 'SEND', notification: false, body: utf8('hello from duplex') })).tag);
const m = await msgP;
const body = decryptRcvMsg(dh(ids.srvDhKey, dhk.priv), m.msgId, m.body);
console.log('MSG ->', body.quota ? 'QUOTA' : fromUtf8(body.body));
console.log('ACK ->', (await c.sendCommand(ids.rcvId, { tag: 'ACK', msgId: m.msgId }, rk.priv)).tag);
console.log('DEL ->', (await c.sendCommand(ids.rcvId, { tag: 'DEL' }, rk.priv)).tag);
c.close();
wisp?.close();
process.exit(0);
