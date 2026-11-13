// Group protocol: the binary batches with forwarded and signed elements that the official clients
// send (encodeBinaryBatch, encodeFwdElement), member IDs, and the JSON forward of this client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMessages } from '../../src/core/chat/protocol';
import { fwdMemberName, isForwardedGroupMsg, newMemberId, normMemberId, roleRank, xGrpMsgForward } from '../../src/core/chat/groups';
import { b64url, concat, fromB64, utf8 } from '../../src/core/util/bytes';
import { Encoder } from '../../src/core/util/encoding';

const json = (event: string, params: object, msgId?: string) => utf8(JSON.stringify({ v: '1-22', ...(msgId ? { msgId } : {}), event, params }));

test('binary batches: forwarded and signed elements as the official clients make them', () => {
  const memberIdBytes = utf8('n9blo/fyr1M5fr4A');
  const ts = 1763000000;
  // '>' GrpMsgForward: 'M' memberId memberName, then SystemTime (Int64 seconds)
  const fwd = new Encoder().char('>').char('M').bytes(memberIdBytes).bytes(utf8('eve')).int64(ts).finish();
  const forwarded = concat(fwd, json('x.msg.new', { content: { type: 'text', text: 'forwarded hello' } }, 'abc'));
  // '/' chatBinding signatures (keyRef + Ed25519 signature) body
  const signed = concat(new Encoder().char('/').char('G').byte(1).char('M').bytes(new Uint8Array(64)).finish(), json('x.grp.leave', {}));
  const plain = json('x.msg.new', { content: { type: 'text', text: 'direct' } });
  const batch = new Encoder().char('=').byte(3).large(forwarded).large(signed).large(plain).finish();
  const ms = parseChatMessages(batch);
  assert.equal(ms.length, 3);
  assert.equal(ms[0].msg?.event, 'x.msg.new');
  assert.equal(ms[0].msg?.params.content.text, 'forwarded hello');
  assert.deepEqual(ms[0].forward, { memberId: b64url(memberIdBytes), memberName: 'eve', brokerTs: ts * 1000 });
  assert.equal(ms[1].msg?.event, 'x.grp.leave');
  assert.equal(ms[1].signed, true);
  assert.equal(ms[2].msg?.params.content.text, 'direct');
  assert.equal(ms[2].forward, undefined);
});

test('member IDs are compared in one form', () => {
  const id = newMemberId();
  assert.equal(fromB64(id).length, 16);
  assert.equal(normMemberId(id), id);
  assert.equal(normMemberId(id.replace(/=+$/, '')), id);
  assert.equal(normMemberId(''), undefined);
  assert.equal(normMemberId(42), undefined);
});

test('roles are ordered as in the apps', () => {
  assert.ok(roleRank('owner') > roleRank('admin'));
  assert.ok(roleRank('admin') > roleRank('moderator'));
  assert.ok(roleRank('member') > roleRank('observer'));
  assert.ok(roleRank('newrole') < roleRank('relay'));
});

test('x.grp.msg.forward carries the original message', () => {
  const inner = { msgId: 'm1', event: 'x.msg.new', params: { content: { type: 'text', text: 'hi' } } };
  assert.ok(isForwardedGroupMsg(inner));
  assert.ok(!isForwardedGroupMsg({ event: 'x.grp.mem.intro', params: {} }));
  const f = xGrpMsgForward('bWVtYmVy', fwdMemberName('a very long member name'), 1763000000123, inner);
  assert.equal(f.params.memberName, 'a very long memb…');
  assert.equal(f.params.msgTs, '2025-11-13T02:13:20.123Z');
  const back = parseChatMessages(utf8(JSON.stringify(f.params.msg)))[0].msg!;
  assert.equal(back.event, 'x.msg.new');
  assert.equal(back.msgId, 'm1');
  assert.equal(back.params.content.text, 'hi');
});
