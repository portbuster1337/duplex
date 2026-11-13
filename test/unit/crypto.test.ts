// Known-answer tests: NaCl crypto_box against libsodium; X25519, X448, Ed25519, Ed448, HKDF-SHA512 and
// AES-256-GCM with 16-byte IVs against OpenSSL (via pyca/cryptography); and the double ratchet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cbDecrypt,
  cbEncrypt,
  cryptoBox,
  cryptoBoxOpen,
  decodePubKey,
  decryptAEAD,
  dh,
  encodePubKey,
  encryptAEAD,
  generateKeyPair,
  hkdf,
  publicKey,
  sha256,
  sign,
  verify,
  type KeyAlg,
  type PrivateKey,
} from '../../src/core/crypto/crypto';
import { generateE2EParams, initRcvRatchet, initSndRatchet, pqX3dhRcv, pqX3dhSnd, ratchetDecrypt, ratchetEncrypt, RatchetError, type Ratchet, type SkippedKeys } from '../../src/core/crypto/ratchet';
import { fromHex, fromUtf8, toHex, utf8 } from '../../src/core/util/bytes';
import { securityCode } from '../../src/core/agent/agent';

const range = (a: number, b: number) => Uint8Array.from({ length: b - a }, (_, i) => a + i);

test('crypto_box matches libsodium', () => {
  const sk1 = fromHex('3d94eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f');
  const pk2 = fromHex('5730800ab340fcb18ce5111eda9d705f91388b41e4544cbd103ba5942db2233e');
  const nonce = fromHex('6465666768696a6b6c6d6e6f707172737475767778797a7b');
  const expected = '387a18b8e5875eca6b07aef2ae50222231fc33cf59a4f4907aea2c97f5';
  const secret = dh({ alg: 'x25519', key: pk2 }, { alg: 'x25519', key: sk1 });
  assert.equal(toHex(cryptoBox(secret, nonce, utf8('hello SimpleX'))), expected);
  assert.equal(fromUtf8(cryptoBoxOpen(secret, nonce, fromHex(expected))), 'hello SimpleX');
  const bad = fromHex(expected);
  bad[20] ^= 1;
  assert.throws(() => cryptoBoxOpen(secret, nonce, bad));
});

test('padded boxes hide the message length', () => {
  const secret = range(0, 32);
  const nonce = range(32, 56);
  const a = cbEncrypt(secret, nonce, utf8('a'), 100);
  const b = cbEncrypt(secret, nonce, utf8('a much longer message'), 100);
  assert.equal(a.length, 116);
  assert.equal(b.length, 116);
  assert.equal(fromUtf8(cbDecrypt(secret, nonce, b)), 'a much longer message');
  assert.throws(() => cbEncrypt(secret, nonce, new Uint8Array(99), 100));
});

const KEYS: Record<KeyAlg, { priv: string; pub: string; spkiPrefix: string }> = {
  x25519: { priv: toHex(range(1, 33)), pub: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c', spkiPrefix: '302a300506032b656e032100' },
  ed25519: { priv: toHex(range(2, 34)), pub: '43cdc023d22d5f9e107d1a0693457d35d1d10eb7d21c721192f56f5de40665d3', spkiPrefix: '302a300506032b6570032100' },
  x448: {
    priv: toHex(range(3, 59)),
    pub: '27b8552e704b5c058380e45715bb3a09de27295c149db6f6fc3ecc89743399d81412a21254c779d0b0af92ea4b9be3eb893103f1d0ccc395',
    spkiPrefix: '3042300506032b656f033900',
  },
  ed448: {
    priv: toHex(range(4, 61)),
    pub: 'f3e3a4aed1dbabc155ae5d4223b5a09e5535f3d689aaa5d9a2e89d4970cced90dfb2dcd4891dd44b09ad0a84a9adf8225a45b87033be192980',
    spkiPrefix: '3043300506032b6571033a00',
  },
};

test('public keys and their X.509 encoding match OpenSSL', () => {
  for (const [alg, k] of Object.entries(KEYS) as Array<[KeyAlg, (typeof KEYS)[KeyAlg]]>) {
    const pub = publicKey({ alg, key: fromHex(k.priv) });
    assert.equal(toHex(pub.key), k.pub, alg);
    const spki = encodePubKey(pub);
    assert.equal(toHex(spki), k.spkiPrefix + k.pub, alg);
    assert.deepEqual(decodePubKey(spki), pub);
  }
});

test('signatures match OpenSSL', () => {
  const msg = utf8('SimpleX signed message');
  const sigs = {
    ed25519: '6011e3708ff81818aa6776e8e1d886f0a91105a23741fbff31b77ccffe459360307f5443db183435c07331b9c99b8d441553a7e2e53e0727931f3f066c2f2b0b',
    ed448:
      'c9794c1bb2eafc7f48dbab4a129df5d0a79542b14a57224e8975aac2c8ab6a280cc5a0cf1d7f2bd0785101efd9c7ffc2909c7335fcc31d7600d43f4dfa5a2518da9d40501aba40ee8daf64a9b2e1b0209e4587a1eb310b90ca9a00fbaeeed3a498f4418bee3126b10f184efd8d7171cd0400',
  };
  for (const alg of ['ed25519', 'ed448'] as const) {
    const priv: PrivateKey<typeof alg> = { alg, key: fromHex(KEYS[alg].priv) };
    const sig = sign(priv, msg);
    assert.equal(toHex(sig), sigs[alg], alg);
    assert.ok(verify(publicKey(priv), sig, msg));
    assert.ok(!verify(publicKey(priv), sig, utf8('another message')));
  }
});

test('X448 key agreement matches OpenSSL', () => {
  const peer = '2b5fdbbeaef3d235310b5a7f550d4744532c01fb3bd09397104f85dfdb330e3a00b8c60b5ef3bca001854a5a09f74ed492a887e794d3067b';
  assert.equal(toHex(publicKey({ alg: 'x448', key: range(100, 156) }).key), peer);
  const s = dh({ alg: 'x448', key: fromHex(peer) }, { alg: 'x448', key: fromHex(KEYS.x448.priv) });
  assert.equal(toHex(s), 'c3717d5d13b5034f765e34fed0dc03960c28a6cc18fb29376e31c49411a45132e1c42b4b6d0d6416eab4e154aaa999578f9c94ba75dde453');
});

test('HKDF-SHA512 matches OpenSSL', () => {
  assert.equal(
    toHex(hkdf(utf8('salt'), utf8('input key material'), 'SimpleXSbChainInit', 64)),
    'fa21d394f7b0eb2edefddde88de1e3d3cc105d73629a9534cb0b909db4d8bad5fc6e7d9ac94e39aac2fb08eb548a9af324bca194460371837a37ccf291522c2e',
  );
  assert.equal(
    toHex(hkdf(new Uint8Array(0), range(0, 32), 'SimpleXSbChain', 88)),
    '0baabe7155d6a65175170eca7e9389e3e73c9d5733df06ec6a44cb80af7fd081998448026fed85ec10292fdfdb4f4c0fe397f3db3936ed8879bad5a78509420f1aa516c1724c58f944d3fcc8486b73e597b82d4aa8afd6f1',
  );
});

test('AES-256-GCM with 16-byte IVs and padding matches OpenSSL', () => {
  const key = range(0, 32);
  const iv = range(0, 16);
  const ad = utf8('associated data');
  const { body, tag } = encryptAEAD(key, iv, 32, ad, utf8('hello'));
  assert.equal(toHex(body), '6769c8135588250bbedcf80a76870f907790488244aef060671d6ef6addaefe9');
  assert.equal(toHex(tag), 'f49d38b2dc0a95848f0ddcbcde997b25');
  assert.equal(fromUtf8(decryptAEAD(key, iv, ad, body, tag)), 'hello');
  assert.throws(() => decryptAEAD(key, iv, utf8('other data'), body, tag));
});

// ---- double ratchet

function pair(): { alice: Ratchet; bob: Ratchet } {
  // alice creates the invitation, bob joins it and sends the first message
  const a = generateE2EParams(3);
  const b = generateE2EParams(3);
  const v = { current: 3, maxSupported: 3 };
  const bob = initSndRatchet(v, a.params.k2, generateKeyPair('x448').priv, pqX3dhSnd(b.priv, a.params));
  const alice = initRcvRatchet(v, a.priv.pk2, pqX3dhRcv(a.priv, b.params));
  return { alice, bob };
}

class Party {
  skipped: SkippedKeys = {};
  constructor(public rc: Ratchet) {}
  send(text: string): Uint8Array {
    const r = ratchetEncrypt(this.rc, utf8(text), 256);
    this.rc = r.rc;
    return r.enc;
  }
  receive(enc: Uint8Array): string {
    const r = ratchetDecrypt(this.rc, this.skipped, enc);
    this.rc = r.rc;
    this.skipped = r.skipped;
    return fromUtf8(r.msg);
  }
}

test('double ratchet: both directions, out of order, duplicates', () => {
  const { alice: a0, bob: b0 } = pair();
  const alice = new Party(a0);
  const bob = new Party(b0);
  assert.equal(alice.receive(bob.send('hi alice')), 'hi alice');
  assert.equal(bob.receive(alice.send('hi bob')), 'hi bob');
  // several ratchet steps
  for (let i = 0; i < 5; i++) {
    assert.equal(alice.receive(bob.send(`b${i}`)), `b${i}`);
    assert.equal(bob.receive(alice.send(`a${i}`)), `a${i}`);
  }
  // out of order delivery uses the skipped message keys
  const m1 = bob.send('one');
  const m2 = bob.send('two');
  const m3 = bob.send('three');
  assert.equal(alice.receive(m3), 'three');
  assert.equal(alice.receive(m1), 'one');
  assert.equal(alice.receive(m2), 'two');
  assert.deepEqual(alice.skipped, {});
  // the same message cannot be decrypted twice
  assert.throws(() => alice.receive(m3), RatchetError);
  assert.throws(() => alice.receive(m1), RatchetError);
  // a tampered message is rejected without changing the state
  const m4 = bob.send('four');
  const bad = m4.slice();
  bad[bad.length - 1] ^= 1;
  const before = alice.rc;
  assert.throws(() => alice.receive(bad));
  assert.equal(alice.rc, before);
  assert.equal(alice.receive(m4), 'four');
  // messages from a skipped chain arrive after a ratchet step
  const late = alice.send('late');
  assert.equal(bob.receive(alice.send('first')), 'first');
  assert.equal(alice.receive(bob.send('step')), 'step');
  assert.equal(bob.receive(late), 'late');
});

test('security codes are formatted like verificationCode of simplex-chat', () => {
  // T.pack . unwords . chunks 5 . show . os2ip
  assert.equal(securityCode(sha256(utf8('abc'))), '84342 36848 70908 00366 52383 49281 42263 66010 48836 95016 51437 74629 85829 71681 70899 65');
  assert.equal(securityCode(Uint8Array.of(0, 0, 1, 2)), '258');
});

test('both parties of a double ratchet have the same security code', () => {
  const { alice, bob } = pair();
  assert.equal(securityCode(sha256(alice.ad)), securityCode(sha256(bob.ad)));
  assert.notEqual(securityCode(sha256(alice.ad)), securityCode(sha256(pair().alice.ad)));
});

test('double ratchet messages have the same size', () => {
  const { bob } = pair();
  const p = new Party(bob);
  assert.equal(p.send('a').length, p.send('a much longer message than the other one').length);
});
