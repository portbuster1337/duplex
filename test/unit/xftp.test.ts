// File transfer: the streaming secret box against crypto_box (libsodium vector), the YAML subset, and
// file descriptions against the fixture of simplexmq (tests/fixtures/file_description.yaml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cryptoBox, dh } from '../../src/core/crypto/crypto';
import { SbState, sbDecryptTailTag, sbEncryptTailTag } from '../../src/core/crypto/sbstream';
import { concat, fromHex, fromUtf8, randomBytes, toHex, utf8 } from '../../src/core/util/bytes';
import { parseYaml, yamlScalar } from '../../src/core/util/yaml';
import { decodeFileDescription, encodeFileDescription, validateFileDescription, type FileDescription } from '../../src/core/xftp/description';
import { GB, KB, MB, parseFileSize, prepareChunkSizes, strFileSize } from '../../src/core/xftp/protocol';
import { encodeFileHeader, fitFileName } from '../../src/core/xftp/file';
import { serverString } from '../../src/core/smp/server';

const FIXTURE = fs.readFileSync(new URL('./fixtures/file_description.yaml', import.meta.url), 'utf8');

test('the streaming secret box is crypto_box with the tag at the end (libsodium vector)', () => {
  const sk1 = fromHex('3d94eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f');
  const pk2 = fromHex('5730800ab340fcb18ce5111eda9d705f91388b41e4544cbd103ba5942db2233e');
  const nonce = fromHex('6465666768696a6b6c6d6e6f707172737475767778797a7b');
  const secret = dh({ alg: 'x25519', key: pk2 }, { alg: 'x25519', key: sk1 });
  const box = fromHex('387a18b8e5875eca6b07aef2ae50222231fc33cf59a4f4907aea2c97f5');
  const tailTag = sbEncryptTailTag(secret, nonce, utf8('hello SimpleX'));
  assert.equal(toHex(tailTag), toHex(concat(box.subarray(16), box.subarray(0, 16))));
  assert.equal(fromUtf8(sbDecryptTailTag(secret, nonce, tailTag)), 'hello SimpleX');
  const bad = tailTag.slice();
  bad[0] ^= 1;
  assert.throws(() => sbDecryptTailTag(secret, nonce, bad), /authentication/);
});

test('the streaming secret box gives the same result for any split', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const msg = randomBytes(5000);
  const whole = sbEncryptTailTag(key, nonce, msg);
  // the same as a box made in one piece
  const b = cryptoBox(key, nonce, msg);
  assert.equal(toHex(whole), toHex(concat(b.subarray(16), b.subarray(0, 16))));
  for (const sizes of [[1, 63, 64, 65, 1000], [32, 32, 4096], [4999, 1]]) {
    const s = new SbState(key, nonce);
    const parts: Uint8Array[] = [];
    let off = 0;
    for (const n of [...sizes, msg.length]) {
      if (off >= msg.length) break;
      parts.push(s.encrypt(msg.subarray(off, Math.min(off + n, msg.length))));
      off += n;
    }
    assert.equal(toHex(concat(...parts, s.tag())), toHex(whole), `split ${sizes}`);
    const d = new SbState(key, nonce);
    const plain = concat(d.decrypt(whole.subarray(0, 100)), d.decrypt(whole.subarray(100, msg.length)));
    assert.ok(d.verify(whole.subarray(msg.length)));
    assert.equal(toHex(plain), toHex(msg));
  }
});

test('YAML: block mappings and sequences, quoting', () => {
  assert.deepEqual(parseYaml('a: 1\nb:\n- x\n- y: z\n  w: v\nc: \'it\'\'s\'\nd: "q\\n"\ne: []\n'), {
    a: '1',
    b: ['x', { y: 'z', w: 'v' }],
    c: "it's",
    d: 'q\n',
    e: [],
  });
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate/);
  assert.throws(() => parseYaml('a: &x 1\n'));
  const cases: Array<[string, string]> = [
    ['abc', 'abc'],
    ['4mb', '4mb'],
    ['xftp://abc=@example1.com', 'xftp://abc=@example1.com'],
    ['1:YWJj:MC4C:Z2hp', '1:YWJj:MC4C:Z2hp'],
    ['-bIo6', '-bIo6'],
    ["it's", "it's"],
    ['yes', "'yes'"],
    ['Off', "'Off'"],
    ['~', "'~'"],
    ['123', "'123'"],
    ['1.5e3', "'1.5e3'"],
    ['0x1F', "'0x1F'"],
    ['- a', "'- a'"],
    ['a: b', "'a: b'"],
    ['a:', "'a:'"],
    ['a #b', "'a #b'"],
    ['#a', "'#a'"],
    ["'q'", "'''q'''"],
    [' lead', "' lead'"],
    ['line\nbreak', '"line\\nbreak"'],
  ];
  for (const [s, y] of cases) {
    assert.equal(yamlScalar(s), y, s);
    assert.deepEqual(parseYaml(`k: ${y}\n`), { k: s }, `round trip of ${JSON.stringify(s)}`);
  }
});

test('file sizes are written as in the official clients', () => {
  assert.equal(strFileSize(4 * MB), '4mb');
  assert.equal(strFileSize(13 * MB), '13mb');
  assert.equal(strFileSize(1536 * KB), '1536kb');
  assert.equal(strFileSize(GB), '1gb');
  assert.equal(strFileSize(1000), '1000');
  assert.equal(parseFileSize('64kb'), 64 * KB);
  assert.equal(parseFileSize('70000'), 70000);
  assert.throws(() => parseFileSize('1tb'));
  assert.deepEqual(prepareChunkSizes(100).map(strFileSize), ['64kb']);
  assert.deepEqual(prepareChunkSizes(5000000).map(strFileSize), ['4mb', '1mb']);
  // as FileDescriptionTests of simplexmq: the largest file splits into 1282 chunks
  assert.equal(prepareChunkSizes(5 * GB - MB).length, 1282);
});

test('the file description fixture of simplexmq is decoded and encoded byte for byte', () => {
  const fd = decodeFileDescription(FIXTURE);
  assert.equal(fd.party, 'recipient');
  assert.equal(fd.size, 13 * MB);
  assert.equal(fd.chunkSize, 4 * MB);
  assert.equal(fromUtf8(fd.digest), 'abc');
  assert.equal(fd.key.length, 32);
  assert.equal(fd.nonce.length, 24);
  assert.deepEqual(
    fd.chunks.map((c) => [c.chunkNo, strFileSize(c.chunkSize), fromUtf8(c.digest), c.replicas.map((r) => serverString(r.server))]),
    [
      [1, '4mb', 'ghi', ['xftp://abc=@example1.com', 'xftp://abc=@example3.com']],
      [2, '4mb', 'ghi', ['xftp://abc=@example2.com', 'xftp://abc=@example4.com']],
      [3, '4mb', 'ghi', ['xftp://abc=@example1.com', 'xftp://abc=@example4.com']],
      [4, '1mb', 'ghi', ['xftp://abc=@example2.com', 'xftp://abc=@example3.com']],
    ],
  );
  assert.equal(fromUtf8(fd.chunks[0].replicas[0].replicaId), 'abc');
  assert.equal(fd.chunks[0].replicas[0].replicaKey.key.length, 32);
  assert.equal(encodeFileDescription(fd), FIXTURE);
});

test('file descriptions are checked like in simplexmq', () => {
  // testRejectYAMLAliases, testRejectLongNumber, testAcceptMaxNumber
  const [yaml, sizeLine] = [FIXTURE.slice(0, FIXTURE.indexOf('size: ')), FIXTURE.slice(FIXTURE.indexOf('size: '))];
  const i = yaml.indexOf('- chunks:');
  const aliased = yaml.slice(0, i) + '- &g\n  ' + yaml.slice(i + 2) + '- *g\n' + sizeLine;
  assert.throws(() => decodeFileDescription(aliased), /aliases/);
  assert.throws(() => decodeFileDescription(FIXTURE + 'x: ' + '7'.repeat(65) + '\n'), /number too long/);
  assert.equal(decodeFileDescription(FIXTURE + 'x: ' + '7'.repeat(64) + '\n').chunks.length, 4);
  // validateFileDescription
  const fd = decodeFileDescription(FIXTURE);
  const v = (f: (d: FileDescription) => void) => {
    const d = decodeFileDescription(FIXTURE);
    f(d);
    return () => validateFileDescription(d);
  };
  assert.throws(v((d) => (d.chunks[1].chunkNo = 5)), /sequential/);
  assert.throws(v((d) => (d.size = 12 * MB)), /total size/);
  assert.throws(
    v((d) => {
      // the same total size, with sizes the servers do not use
      d.chunks[2].chunkSize = 3 * MB;
      d.chunks[3].chunkSize = 2 * MB;
    }),
    /incorrect chunk size/,
  );
  assert.throws(v((d) => (d.chunks[0].replicas = Array(17).fill(fd.chunks[0].replicas[0]))), /too many chunk replicas/);
  assert.throws(() => decodeFileDescription(FIXTURE.replace('party: recipient', 'party: nobody')), /party/);
});

test('file headers fit 255 bytes', () => {
  assert.equal(toHex(encodeFileHeader('a.txt')), '05' + toHex(utf8('a.txt')) + '30');
  const long = fitFileName('ы'.repeat(300) + '.jpeg');
  assert.ok(utf8(long).length <= 255);
  assert.ok(long.endsWith('.jpeg'));
  assert.equal(fitFileName('../../etc/passwd'), '.._.._etc_passwd');
});
