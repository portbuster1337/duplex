// Group protocol: the binary batches with forwarded and signed elements that the official clients
// send (encodeBinaryBatch, encodeFwdElement), member IDs, the JSON forward of this client, and the
// roster of channels (encodeRosterBlob, BFileChunk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileChunkElement, newSharedMsgId, parseChatMessages } from '../../src/core/chat/protocol';
import {
  encodeRoster,
  fwdMemberName,
  isForwardedGroupMsg,
  MAX_SENT_ROSTER_BYTES,
  newMemberId,
  normMemberId,
  parseRoster,
  roleRank,
  roleToChange,
  rosterFileInv,
  validRoster,
  xGrpMsgForward,
} from '../../src/core/chat/groups';
import { encodeAgentMessage, E2E_ENC_AGENT_MSG_LENGTH } from '../../src/core/agent/protocol';
import { encodePubKey, generateKeyPair, sha512 } from '../../src/core/crypto/crypto';
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

test('the roster blob: as encodeRosterBlob of the apps, and only the roster roles, each member once', () => {
  const k1 = generateKeyPair('ed25519').pub;
  const k2 = generateKeyPair('ed25519').pub;
  const m1 = newMemberId();
  const m2 = newMemberId();
  const blob = encodeRoster([
    { memberId: m1, key: b64url(k1.key), role: 'moderator' },
    { memberId: m2, key: b64url(k2.key), role: 'member' },
  ]);
  // Word16 count; then memberId, the X.509 key and the role, each with a 1-byte length, and the privileges (Word16 0)
  const e = new Encoder().word16(2);
  e.bytes(fromB64(m1)).bytes(encodePubKey(k1)).bytes(utf8('moderator')).word16(0);
  e.bytes(fromB64(m2)).bytes(encodePubKey(k2)).bytes(utf8('member')).word16(0);
  assert.deepEqual(blob, e.finish());
  assert.deepEqual(parseRoster(blob), [
    { memberId: m1, key: b64url(k1.key), role: 'moderator' },
    { memberId: m2, key: b64url(k2.key), role: 'member' },
  ]);
  assert.throws(() => parseRoster(concat(blob, new Uint8Array([0]))));
  const inv = rosterFileInv(blob);
  assert.equal(inv.fileSize, blob.length);
  assert.deepEqual(fromB64(inv.fileDigest), sha512(blob));
  const valid = validRoster([
    { memberId: m1, key: b64url(k1.key), role: 'admin' },
    { memberId: m1, key: b64url(k2.key), role: 'member' },
    { memberId: m2, key: b64url(k2.key), role: 'owner' },
  ]);
  assert.deepEqual(
    valid.map((r) => [r.memberId, r.role]),
    [[m1, 'admin']],
  );
});

test('a roster chunk (BFileChunk): parsed as sent, and the largest roster that is sent fits in a message', () => {
  const ref = newSharedMsgId();
  const data = new Uint8Array(MAX_SENT_ROSTER_BYTES).fill(7);
  const el = fileChunkElement(ref, 1, data);
  const [pm] = parseChatMessages(el);
  assert.equal(pm.chunk?.ref, b64url(fromB64(ref)));
  assert.equal(pm.chunk?.chunkNo, 1);
  assert.deepEqual(pm.chunk?.data, data);
  // in a forward of a relay too
  const fwd = new Encoder().char('>').char('M').bytes(utf8('n9blo/fyr1M5fr4A')).bytes(utf8('eve')).int64(1).finish();
  assert.equal(parseChatMessages(concat(fwd, el))[0].chunk?.chunkNo, 1);
  const size = (n: number) => encodeAgentMessage({ tag: 'M', sndMsgId: 1, prevMsgHash: new Uint8Array(32), msg: { tag: 'A_MSG', body: fileChunkElement(ref, 1, new Uint8Array(n)) } }).length + 2;
  assert.ok(size(MAX_SENT_ROSTER_BYTES) <= E2E_ENC_AGENT_MSG_LENGTH);
  assert.ok(size(MAX_SENT_ROSTER_BYTES + 1) > E2E_ENC_AGENT_MSG_LENGTH);
});

test('who changes a role (roleRequiredToChange)', () => {
  assert.equal(roleToChange('observer', 'member'), 'moderator');
  assert.equal(roleToChange('member', 'moderator'), 'admin');
  assert.equal(roleToChange('observer', 'admin'), 'admin');
  assert.equal(roleToChange('admin', 'observer'), 'admin');
  assert.equal(roleToChange('observer', 'owner'), 'owner');
  assert.equal(roleToChange('owner', 'observer'), 'owner');
});
