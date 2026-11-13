// Post-quantum KEM: sntrup761 against the C implementation of simplexmq (vectors made with a fixed
// random generator), and the hybrid double ratchet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPair, sha256 } from '../../src/core/crypto/crypto';
import { generateE2EParams, initRcvRatchet, initSndRatchet, pqX3dhRcv, pqX3dhSnd, ratchetDecrypt, ratchetEncrypt, replyKem, type Ratchet, type SkippedKeys } from '../../src/core/crypto/ratchet';
import { sntrup761Dec, sntrup761Enc, sntrup761Keypair, type RandomFn } from '../../src/core/crypto/sntrup761';
import { fromUtf8, toHex, utf8 } from '../../src/core/util/bytes';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/sntrup761.json', import.meta.url), 'utf8'));
const MASK64 = (1n << 64n) - 1n;

/** xorshift64*, as in the generator of the vectors */
function testRng(seed: number): RandomFn {
  let st = (0x9e3779b97f4a7c15n * BigInt(seed)) & MASK64;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      st ^= st >> 12n;
      st = (st ^ (st << 25n)) & MASK64;
      st ^= st >> 27n;
      out[i] = Number(((st * 0x2545f4914f6cdd1dn) & MASK64) >> 56n);
    }
    return out;
  };
}

test('sntrup761 matches the implementation of simplexmq', () => {
  for (const v of FIXTURE.vectors) {
    const rnd = testRng(v.seed);
    const kp = sntrup761Keypair(rnd);
    assert.equal(toHex(sha256(kp.pub)), v.pk_sha256, `public key ${v.seed}`);
    assert.equal(toHex(sha256(kp.priv)), v.sk_sha256, `secret key ${v.seed}`);
    const { ct, ss } = sntrup761Enc(kp.pub, rnd);
    assert.equal(toHex(sha256(ct)), v.ct_sha256, `ciphertext ${v.seed}`);
    assert.equal(toHex(ss), v.k);
    assert.equal(toHex(sntrup761Dec(ct, kp.priv)), v.k);
    // a modified ciphertext gives another (implicitly rejected) secret
    const bad = ct.slice();
    bad[5] ^= 1;
    assert.equal(toHex(sntrup761Dec(bad, kp.priv)), v.k_bad_ct);
  }
});

test('sntrup761 with the system random generator', () => {
  const kp = sntrup761Keypair();
  assert.equal(kp.pub.length, 1158);
  assert.equal(kp.priv.length, 1763);
  const t0 = performance.now();
  const { ct, ss } = sntrup761Enc(kp.pub);
  assert.equal(ct.length, 1039);
  assert.deepEqual(sntrup761Dec(ct, kp.priv), ss);
  assert.ok(performance.now() - t0 < 2000);
});

// ---- the PQ double ratchet

/** alice creates the invitation (with a KEM key when kemInInvitation), bob joins it */
function connect(o: { alicePQ: boolean; bobPQ: boolean; kemInInvitation: boolean }): { alice: Party; bob: Party } {
  const v = { current: 3, maxSupported: 3 };
  const a = generateE2EParams(3, o.alicePQ && o.kemInInvitation ? { tag: 'propose' } : undefined);
  const b = generateE2EParams(3, replyKem(a.params.kem, o.bobPQ));
  const sx = pqX3dhSnd(b.priv, a.params);
  const bob = new Party(initSndRatchet(v, a.params.k2, generateKeyPair('x448').priv, sx.init, sx.pqRs));
  const rx = pqX3dhRcv(a.priv, b.params);
  const alice = new Party(initRcvRatchet(v, a.priv.pk2, rx.init, rx.pqRs, o.alicePQ));
  // both sides compute the same associated data and verification code
  assert.equal(toHex(sx.init.vcPQ), toHex(rx.init.vcPQ));
  return { alice, bob };
}

class Party {
  skipped: SkippedKeys = {};
  /** like the agent, the setting of the connection is passed with each message */
  pqEnc: boolean | undefined;
  constructor(public rc: Ratchet) {}
  send(text: string): Uint8Array {
    const r = ratchetEncrypt(this.rc, utf8(text), 13618, 3, this.pqEnc);
    this.rc = r.rc;
    return r.enc;
  }
  receive(enc: Uint8Array): string {
    const r = ratchetDecrypt(this.rc, this.skipped, enc);
    this.rc = r.rc;
    this.skipped = r.skipped;
    return fromUtf8(r.msg);
  }
  get pq(): boolean {
    return !!this.rc.sndKEM && !!this.rc.rcvKEM;
  }
}

function talk(alice: Party, bob: Party, rounds: number): void {
  assert.equal(alice.receive(bob.send('hello')), 'hello');
  for (let i = 0; i < rounds; i++) {
    assert.equal(bob.receive(alice.send(`a${i}`)), `a${i}`);
    assert.equal(alice.receive(bob.send(`b${i}`)), `b${i}`);
  }
}

test('PQ ratchet: the KEM key of the invitation is accepted when joining', () => {
  const { alice, bob } = connect({ alicePQ: true, bobPQ: true, kemInInvitation: true });
  // the first message of bob already uses the KEM secret
  assert.equal(bob.rc.sndKEM, true);
  talk(alice, bob, 2);
  assert.ok(alice.pq && bob.pq);
  // each ratchet step exchanges new KEM keys
  const k1 = alice.rc.kem!.pqRs.pub;
  talk(alice, bob, 1);
  assert.notEqual(toHex(alice.rc.kem!.pqRs.pub), toHex(k1));
});

test('PQ ratchet: without a KEM key in the invitation, it is agreed on the first ratchet steps', () => {
  const { alice, bob } = connect({ alicePQ: true, bobPQ: true, kemInInvitation: false });
  assert.equal(bob.rc.sndKEM, false);
  talk(alice, bob, 2);
  assert.ok(alice.pq && bob.pq, 'both directions use KEM after a round trip');
});

test('PQ ratchet: a party without PQ keeps the connection working without it', () => {
  for (const o of [
    { alicePQ: false, bobPQ: true, kemInInvitation: false },
    { alicePQ: true, bobPQ: false, kemInInvitation: true },
  ]) {
    const { alice, bob } = connect(o);
    talk(alice, bob, 3);
    assert.ok(!alice.pq && !bob.pq);
  }
});

test('PQ ratchet: it can be turned off and on again', () => {
  const { alice, bob } = connect({ alicePQ: true, bobPQ: true, kemInInvitation: true });
  talk(alice, bob, 2);
  assert.ok(alice.pq && bob.pq);
  // alice turns it off; bob keeps proposing new keys, which alice ignores
  alice.pqEnc = false;
  bob.pqEnc = true;
  talk(bob, alice, 3);
  assert.ok(!alice.pq && !bob.pq);
  // and on again
  alice.pqEnc = true;
  talk(bob, alice, 3);
  assert.ok(alice.pq && bob.pq);
});
