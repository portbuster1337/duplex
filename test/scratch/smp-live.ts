import { SMPClient } from '../../src/core/smp/client';
import { parseServer } from '../../src/core/smp/server';
import { tcpConnector } from '../helpers/tcp';
import { WispConnection } from '../../src/core/net/wisp';
import { generateKeyPair, dh } from '../../src/core/crypto/crypto';
import { decryptRcvMsg } from '../../src/core/smp/protocol';
import { utf8, fromUtf8, toHex } from '../../src/core/util/bytes';

const [addr, relay] = process.argv.slice(2);
const srv = parseServer(addr).server;
const connector = relay ? (() => { const w = new WispConnection(relay); return { connect: (h: string, p: number) => w.connect(h, p) }; })() : tcpConnector;
let gotMsg: (m: any) => void;
const msgP = new Promise<any>((r) => (gotMsg = r));
const t0 = Date.now();
const c = await SMPClient.connect(srv, {
  connector,
  onEvent: (eid, m) => { console.log('event', m.tag, toHex(eid)); if (m.tag === 'MSG') gotMsg(m); },
});
console.log(Date.now() - t0, 'ms connected, version', c.version, 'server versions', c.serverVersions, 'info', JSON.stringify(c.serverInfo)?.slice(0, 200));
console.log('PING ->', (await c.sendCommand(new Uint8Array(0), { tag: 'PING' })).tag);
const rk = generateKeyPair('ed25519');
const dhk = generateKeyPair('x25519');
const ids: any = await c.sendCommand(new Uint8Array(0), { tag: 'NEW', rcvAuthKey: rk.pub, rcvDhKey: dhk.pub, subscribe: true, reqData: { mode: 'M' } }, rk.priv);
console.log('NEW ->', ids.tag, 'rcvId', toHex(ids.rcvId), 'sndId', toHex(ids.sndId), 'mode', ids.queueMode);
const rcvDhSecret = dh(ids.srvDhKey, dhk.priv);
const r = await c.sendCommand(ids.sndId, { tag: 'SEND', notification: false, body: utf8('hello from duplex') });
console.log('SEND ->', r.tag);
const m = await msgP;
const body = decryptRcvMsg(rcvDhSecret, m.msgId, m.body);
console.log('MSG body:', body.quota ? 'quota' : fromUtf8(body.body), 'ts', body.ts);
console.log('ACK ->', (await c.sendCommand(ids.rcvId, { tag: 'ACK', msgId: m.msgId }, rk.priv)).tag);
console.log('DEL ->', (await c.sendCommand(ids.rcvId, { tag: 'DEL' }, rk.priv)).tag);
c.close();
process.exit(0);
