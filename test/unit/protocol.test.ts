// Encodings checked against the official implementation: links created by the SimpleX Chat CLI,
// router certificate chains created by smp-server (Ed25519) and OpenSSL (Ed448), compressed chat
// messages in the official format, and the encrypted storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parseConnReq, strConnReq } from '../../src/core/agent/protocol';
import { isShortLink, parseShortLink, strShortLink } from '../../src/core/agent/shortlink';
import { verifyServerChain } from '../../src/core/smp/client';
import { parseServer, serverString } from '../../src/core/smp/server';
import { sha256 } from '../../src/core/crypto/crypto';
import { b64url, fromB64, toHex, utf8 } from '../../src/core/util/bytes';
import { Decoder, Encoder, pad, unPad } from '../../src/core/util/encoding';
import { encodeChatMessage, MAX_DECOMPRESSED_LENGTH, newSharedMsgId, parseChatMessages, xMsgNew, zstdContentSize } from '../../src/core/chat/protocol';
import { MemoryBackend, Vault, VaultLockedError, WrongPassphraseError } from '../../src/app/vault';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const links = JSON.parse(fs.readFileSync(fixture('links.json'), 'utf8'));

function pemToDer(name: string): Uint8Array {
  const pem = fs.readFileSync(fixture(name), 'utf8');
  return fromB64(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
}

test('full links of the official client are parsed and encoded identically', () => {
  for (const link of [links.invitationFull, links.contactFull]) {
    const cr = parseConnReq(link);
    assert.equal(strConnReq(cr), link);
  }
  const inv = parseConnReq(links.invitationFull);
  assert.equal(inv.mode, 'invitation');
  if (inv.mode !== 'invitation') return;
  const q = inv.data.queues[0];
  assert.deepEqual(q.versions, { min: 1, max: 4 });
  assert.equal(q.addr.queueMode, 'M');
  assert.deepEqual(q.addr.server.hosts, ['localhost']);
  assert.equal(q.addr.server.port, '7001');
  assert.equal(b64url(q.addr.server.keyHash), '94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=');
  assert.equal(inv.e2e.kem?.tag, 'P', 'the official client proposes post-quantum keys');
  const contact = parseConnReq(links.contactFull);
  assert.equal(contact.mode, 'contact');
  assert.equal(contact.data.queues[0].addr.queueMode, 'C');
});

test('short links of the official client are parsed and encoded identically', () => {
  for (const link of [links.invitationShort, links.contactShort]) {
    assert.ok(isShortLink(link));
    assert.equal(strShortLink(parseShortLink(link)), link);
  }
  const inv = parseShortLink(links.invitationShort);
  assert.equal(inv.mode, 'invitation');
  assert.equal(inv.server.port, '7001');
  const addr = parseShortLink(links.contactShort);
  assert.equal(addr.mode, 'contact');
  if (addr.mode === 'contact') assert.equal(addr.type, 'A');
  assert.ok(!isShortLink(links.invitationFull));
});

test('short links to preset routers omit the router fingerprint', () => {
  const l = parseShortLink('https://smp8.simplex.im/a#5ZNyP3ObpTvm2pJGr3sZLZUWbAN1iZ5EZxKtVBKy53Y');
  assert.equal(b64url(l.server.keyHash), '0YuTwO05YJWS8rkjn9eLJDjQhFKvIYd8d4xG8X1blIU=');
  assert.ok(l.server.hosts.some((h) => h.endsWith('.onion')));
  assert.equal(strShortLink(l), 'https://smp8.simplex.im/a#5ZNyP3ObpTvm2pJGr3sZLZUWbAN1iZ5EZxKtVBKy53Y');
});

test('server addresses', () => {
  const s = 'smp://0YuTwO05YJWS8rkjn9eLJDjQhFKvIYd8d4xG8X1blIU=@smp8.simplex.im,beccx4yfxxbvyhqypaavemqurytl6hozr47wfc7uuecacjqdvwpw2xid.onion';
  const { server } = parseServer(s);
  assert.deepEqual(server.hosts, ['smp8.simplex.im', 'beccx4yfxxbvyhqypaavemqurytl6hozr47wfc7uuecacjqdvwpw2xid.onion']);
  assert.equal(serverString(server), s);
  assert.equal(parseServer('smp://94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=@localhost:7001').server.port, '7001');
  assert.throws(() => parseServer('https://example.org'));
});

test('router certificate chains are pinned to the fingerprint in the address', () => {
  const ca = pemToDer('smp-ca.crt');
  const leaf = pemToDer('smp-server.crt');
  const fp = fromB64('94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=');
  assert.deepEqual(sha256(ca), fp);
  assert.equal(verifyServerChain([leaf, ca], fp).alg, 'ed25519');
  assert.throws(() => verifyServerChain([leaf, ca], sha256(leaf)), /identity/);
  assert.throws(() => verifyServerChain([ca, leaf], sha256(leaf)));
  assert.throws(() => verifyServerChain([leaf], fp), /length/);
  const ca448 = pemToDer('ed448-ca.crt');
  const leaf448 = pemToDer('ed448-leaf.crt');
  assert.equal(verifyServerChain([leaf448, ca448], sha256(ca448)).alg, 'ed448');
  // a leaf certificate signed by another CA
  assert.throws(() => verifyServerChain([leaf448, ca], fp), /signature/);
});

test('binary encoding', () => {
  const e = new Encoder()
    .word16(513)
    .word32(0xdeadbeef)
    .int64(-2)
    .bytes(utf8('abc'))
    .large(new Uint8Array(300))
    .bool(true)
    .maybe(undefined, (e, v: number) => e.byte(v))
    .maybe(7, (e, v) => e.byte(v))
    .list([1, 2, 3], (e, v) => e.byte(v));
  const d = new Decoder(e.finish());
  assert.equal(d.word16(), 513);
  assert.equal(d.word32(), 0xdeadbeef);
  assert.equal(d.int64(), -2n);
  assert.equal(d.text(), 'abc');
  assert.equal(d.large().length, 300);
  assert.equal(d.bool(), true);
  assert.equal(d.maybe((d) => d.byte()), undefined);
  assert.equal(d.maybe((d) => d.byte()), 7);
  assert.deepEqual(d.list((d) => d.byte()), [1, 2, 3]);
  d.end();
  assert.throws(() => new Encoder().bytes(new Uint8Array(256)));
  const p = pad(utf8('hi'), 16);
  assert.equal(toHex(p), '0002' + '6869' + '23'.repeat(12));
  assert.deepEqual(unPad(p), utf8('hi'));
});

// 'X' + 1-byte count + ('0' + 1-byte length + bytes | '1' + 2-byte length + zstd frame)
function compressedBatch(parts: Array<{ plain?: Uint8Array; zstd?: Uint8Array }>): Uint8Array {
  return new Encoder()
    .char('X')
    .list(parts, (e, p) => (p.plain ? e.char('0').bytes(p.plain) : e.char('1').large(p.zstd!)))
    .finish();
}

test('compressed chat messages', () => {
  const m = encodeChatMessage(xMsgNew(newSharedMsgId(), { content: { type: 'text', text: 'compressed '.repeat(50) } }));
  const z = new Uint8Array(zlib.zstdCompressSync(m));
  assert.equal(zstdContentSize(z), m.length);
  const parsed = parseChatMessages(compressedBatch([{ zstd: z }, { plain: utf8('{"v":"1-16","event":"x.ok","params":{}}') }]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].msg?.event, 'x.msg.new');
  assert.equal(parsed[0].msg?.params.content.text, 'compressed '.repeat(50));
  assert.equal(parsed[1].msg?.event, 'x.ok');
  // the declared sizes are checked before decompressing
  const noSize = new Uint8Array(zlib.zstdCompressSync(m, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: 0 } }));
  assert.equal(zstdContentSize(noSize), undefined);
  assert.match(parseChatMessages(compressedBatch([{ zstd: noSize }]))[0].error ?? '', /size not specified/);
  const big = new Uint8Array(zlib.zstdCompressSync(new Uint8Array(MAX_DECOMPRESSED_LENGTH + 1)));
  assert.match(parseChatMessages(compressedBatch([{ zstd: big }]))[0].error ?? '', /exceeds limit/);
  // a frame that decompresses to more than it declares is rejected
  const lying = z.slice();
  lying[5] = 10;
  lying[6] = 0;
  assert.ok(parseChatMessages(compressedBatch([{ zstd: lying }]))[0].error);
});

test('JSON chat messages and batches', () => {
  const [one] = parseChatMessages(utf8('{"v":"1-16","msgId":"abc","event":"x.msg.new","params":{"content":{"type":"text","text":"hi"}}}'));
  assert.deepEqual(one.msg?.v, { min: 1, max: 16 });
  assert.equal(one.msg?.msgId, 'abc');
  const batch = parseChatMessages(utf8('[{"event":"x.ok","params":{}},{"event":"x.info","params":{"profile":{"displayName":"a","fullName":""}}}]'));
  assert.deepEqual(
    batch.map((b) => b.msg?.event),
    ['x.ok', 'x.info'],
  );
  assert.ok(parseChatMessages(utf8('{not json'))[0].error);
  assert.ok(parseChatMessages(new Uint8Array(0))[0].error);
});

test('shared message IDs have the format of the official clients', () => {
  const id = newSharedMsgId();
  // base64url of the base64 text of 12 random bytes
  assert.match(new TextDecoder().decode(fromB64(id)), /^[A-Za-z0-9+/]{16}$/);
});

const KDF = { t: 1, m: 256, p: 1 };

test('the vault stores only padded ciphertext under keyed hashes', async () => {
  const backend = new MemoryBackend();
  const v = await Vault.create(backend, 'correct horse battery staple', KDF);
  await v.put('contact:alice', { name: 'Alice Secretname', key: new Uint8Array([1, 2, 3]) });
  await v.put('contact:b', { name: 'B' });
  assert.deepEqual(await v.get('contact:alice'), { name: 'Alice Secretname', key: new Uint8Array([1, 2, 3]) });
  assert.equal(await v.get('missing'), undefined);
  for (const [k, val] of backend.m) {
    assert.ok(!k.includes('contact'), 'record names are not stored');
    const text = Buffer.from(val).toString('latin1');
    assert.ok(!text.includes('Secretname') && !text.includes('Alice'), 'records are encrypted');
  }
  const sizes = [...backend.m.entries()].filter(([k]) => k !== 'meta').map(([, v]) => v.length);
  assert.equal(new Set(sizes).size, 1, 'small records have the same size');
  // reopening
  await assert.rejects(Vault.open(backend, 'wrong passphrase'), WrongPassphraseError);
  const v2 = await Vault.open(backend, 'correct horse battery staple');
  assert.equal(((await v2.get('contact:b')) as { name: string }).name, 'B');
  // changing the passphrase keeps the data
  await v2.changePassphrase('new passphrase', KDF);
  await assert.rejects(Vault.open(backend, 'correct horse battery staple'), WrongPassphraseError);
  const v3 = await Vault.open(backend, 'new passphrase');
  assert.equal(((await v3.get('contact:alice')) as { name: string }).name, 'Alice Secretname');
  // a record cannot be moved to another name
  const keys = [...backend.m.keys()].filter((k) => k !== 'meta');
  const [ka, kb] = keys;
  const tmp = backend.m.get(ka)!;
  backend.m.set(ka, backend.m.get(kb)!);
  backend.m.set(kb, tmp);
  await assert.rejects(v3.get('contact:alice'));
  // locked vaults cannot be used
  v3.lock();
  await assert.rejects(v3.get('contact:b'), VaultLockedError);
  await assert.rejects(v3.put('contact:b', {}), VaultLockedError);
});
