// Two agents connecting through a local SMP router: 1-time invitations (short and full links),
// contact addresses, messages and delivery receipts; with a second router, private message routing.
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 SMP_SERVER2=smp://<fingerprint>@localhost:7003 npm run test:local
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, MemoryAgentStore, type AgentEvent } from '../../src/core/agent/agent';
import { parseServer } from '../../src/core/smp/server';
import { fromUtf8, utf8 } from '../../src/core/util/bytes';
import { tcpConnector } from '../helpers/tcp';

const SERVER = process.env.SMP_SERVER;
const SERVER2 = process.env.SMP_SERVER2;

function mkAgent(name: string, server = SERVER!) {
  const events: AgentEvent[] = [];
  const waiters: Array<{ pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }> = [];
  const a = new Agent(new MemoryAgentStore(), tcpConnector, { servers: [parseServer(server).server] });
  a.onEvent = async (e) => {
    events.push(e);
    if (process.env.DEBUG) console.log(name, e.type, 'connId' in e ? e.connId : '', e.type === 'MSG' ? fromUtf8(e.body) : e.type === 'ERR' ? e.err : '');
    for (const w of waiters.splice(0)) {
      if (w.pred(e)) w.resolve(e);
      else waiters.push(w);
    }
    if (e.type === 'MSG') return { receipt: true };
  };
  const wait = <T extends AgentEvent['type']>(type: T, pred: (e: Extract<AgentEvent, { type: T }>) => boolean = () => true, ms = 15000) =>
    new Promise<Extract<AgentEvent, { type: T }>>((resolve, reject) => {
      const found = events.find((e) => e.type === type && pred(e as Extract<AgentEvent, { type: T }>));
      if (found) {
        events.splice(events.indexOf(found), 1);
        return resolve(found as Extract<AgentEvent, { type: T }>);
      }
      const t = setTimeout(() => reject(new Error(`${name}: timeout waiting for ${type}`)), ms);
      waiters.push({
        pred: (e) => e.type === type && pred(e as Extract<AgentEvent, { type: T }>),
        resolve: (e) => {
          clearTimeout(t);
          events.splice(events.indexOf(e), 1);
          resolve(e as Extract<AgentEvent, { type: T }>);
        },
      });
    });
  return { a, events, wait };
}

async function connectPair(shortLink: boolean, bobServer = SERVER!) {
  const alice = mkAgent('alice');
  const bob = mkAgent('bob', bobServer);
  await alice.a.start();
  await bob.a.start();
  const inv = await alice.a.createInvitation({ shortLink, userData: utf8('{"alice":true}') });
  assert.ok(shortLink ? inv.link.startsWith('https://localhost') : inv.link.startsWith('simplex:/invitation#/?'), inv.link);
  const resolved = await bob.a.resolveLink(inv.link);
  if (shortLink) assert.equal(fromUtf8(resolved.userData!), '{"alice":true}');
  const bobConnId = await bob.a.joinConnection(resolved, utf8('bob info'));
  const conf = await alice.wait('CONF');
  assert.equal(fromUtf8(conf.connInfo), 'bob info');
  await alice.a.allowConnection(conf.connId, utf8('alice info'));
  const info = await bob.wait('INFO');
  assert.equal(fromUtf8(info.connInfo), 'alice info');
  await alice.wait('CON');
  await bob.wait('CON');
  return { alice, bob, aliceConnId: conf.connId, bobConnId };
}

test('invitation via short link, messages and receipts', { skip: !SERVER }, async () => {
  const { alice, bob, aliceConnId, bobConnId } = await connectPair(true);
  const id1 = await alice.a.sendMessage(aliceConnId, utf8('hello bob'));
  const m1 = await bob.wait('MSG');
  assert.equal(fromUtf8(m1.body), 'hello bob');
  assert.equal(m1.integrity, undefined);
  await alice.wait('SENT', (e) => e.msgId === id1);
  const r1 = await alice.wait('RCVD');
  assert.deepEqual(r1.receipts, [{ msgId: id1, ok: true }]);
  for (let i = 0; i < 5; i++) await bob.a.sendMessage(bobConnId, utf8(`reply ${i}`));
  for (let i = 0; i < 5; i++) {
    const m = await alice.wait('MSG');
    assert.equal(fromUtf8(m.body), `reply ${i}`);
    assert.equal(m.integrity, undefined);
  }
  await alice.a.sendMessage(aliceConnId, utf8('after ratchet steps'));
  assert.equal(fromUtf8((await bob.wait('MSG')).body), 'after ratchet steps');
  alice.a.stop();
  bob.a.stop();
});

test('invitation via full link', { skip: !SERVER }, async () => {
  const { alice, bob, aliceConnId, bobConnId } = await connectPair(false);
  await bob.a.sendMessage(bobConnId, utf8('hi'));
  assert.equal(fromUtf8((await alice.wait('MSG')).body), 'hi');
  await alice.a.sendMessage(aliceConnId, utf8('hi back'));
  assert.equal(fromUtf8((await bob.wait('MSG')).body), 'hi back');
  alice.a.stop();
  bob.a.stop();
});

test('contact address request and accept', { skip: !SERVER }, async () => {
  const alice = mkAgent('alice');
  const bob = mkAgent('bob');
  await alice.a.start();
  await bob.a.start();
  const addr = await alice.a.createAddress({ userData: utf8('alice profile') });
  assert.ok(addr.link.startsWith('https://localhost/a#'), addr.link);
  const resolved = await bob.a.resolveLink(addr.link);
  assert.equal(fromUtf8(resolved.userData!), 'alice profile');
  const bobConnId = await bob.a.joinConnection(resolved, utf8('bob request'));
  const req = await alice.wait('REQ');
  assert.equal(fromUtf8(req.connInfo), 'bob request');
  const aliceConnId = await alice.a.acceptRequest(req.connId, req.invId, utf8('alice accepts'));
  const conf = await bob.wait('CONF');
  assert.equal(conf.connId, bobConnId);
  assert.equal(fromUtf8(conf.connInfo), 'alice accepts');
  await bob.a.allowConnection(bobConnId, utf8('bob info'));
  assert.equal(fromUtf8((await alice.wait('INFO')).connInfo), 'bob info');
  await alice.wait('CON');
  await bob.wait('CON');
  await alice.a.sendMessage(aliceConnId, utf8('welcome'));
  assert.equal(fromUtf8((await bob.wait('MSG')).body), 'welcome');
  // the address data can be updated
  await alice.a.updateLinkData(addr.connId, utf8('new profile'));
  const r2 = await bob.a.resolveLink(addr.link);
  assert.equal(fromUtf8(r2.userData!), 'new profile');
  alice.a.stop();
  bob.a.stop();
});

test('private message routing: each agent sends through its own router to the other one', { skip: !SERVER || !SERVER2 }, async () => {
  // alice uses only the first router, bob only the second: each one's router is unknown to the other
  const { alice, bob, aliceConnId, bobConnId } = await connectPair(true, SERVER2);
  try {
    for (const x of [alice, bob]) assert.equal(x.a.network.stats.direct, 0, 'nothing was sent directly to the other router');
    // getting the link data and the confirmation of bob went through bob's router
    assert.ok(bob.a.network.stats.proxied >= 2, `bob proxied ${bob.a.network.stats.proxied}`);
    assert.ok(alice.a.network.stats.proxied >= 2, `alice proxied ${alice.a.network.stats.proxied}`);
    const before = alice.a.network.stats.proxied;
    await alice.a.sendMessage(aliceConnId, utf8('via my router'));
    assert.equal(fromUtf8((await bob.wait('MSG')).body), 'via my router');
    await bob.a.sendMessage(bobConnId, utf8('via mine'));
    assert.equal(fromUtf8((await alice.wait('MSG')).body), 'via mine');
    assert.ok(alice.a.network.stats.proxied > before);
    // errors of the destination router come back through the proxy
    const dest = parseServer(SERVER2!).server;
    await assert.rejects(alice.a.network.sendToQueue(dest, new Uint8Array(24), { tag: 'SEND', notification: false, body: utf8('x') }), /AUTH/);
    // with private routing off, the commands go directly
    alice.a.config.routing = { mode: 'never', fallback: 'allow' };
    await alice.a.sendMessage(aliceConnId, utf8('directly'));
    assert.equal(fromUtf8((await bob.wait('MSG')).body), 'directly');
    assert.ok(alice.a.network.stats.direct >= 1);
  } finally {
    alice.a.stop();
    bob.a.stop();
  }
});
