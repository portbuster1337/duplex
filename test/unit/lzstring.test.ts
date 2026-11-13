// LZString against lz-string.min.js of the SimpleX Chat apps (assets/www), which their call pages use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compressToBase64, decompressFromBase64 } from '../../src/core/util/lzstring';

const ctx: { LZString?: { compressToBase64(s: string): string; decompressFromBase64(s: string): string | null } } = {};
vm.runInNewContext(fs.readFileSync(new URL('./fixtures/lz-string.min.js', import.meta.url), 'utf8') + '\nthis.LZString = LZString;', ctx);
const ref = ctx.LZString!;

const sdp = {
  type: 'offer',
  sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2 3\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijklmn\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=mid:0\r\n'.repeat(3),
};

test('LZString base64 is the same as lz-string of the apps', () => {
  const rnd = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(32 + ((i * 7919 + n) % 95))).join('');
  const cases = ['', 'a', 'aaaaaaaaaaaa', 'hello hello hello', JSON.stringify(sdp), JSON.stringify([{ candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }]), 'Привет, мир 👋🏽 ✓', rnd(5000), rnd(70000)];
  for (const s of cases) {
    const c = compressToBase64(s);
    assert.equal(c, ref.compressToBase64(s), `compress ${s.slice(0, 20)}`);
    if (s) {
      assert.equal(decompressFromBase64(c), s);
      assert.equal(ref.decompressFromBase64(c), s);
    }
  }
  assert.equal(decompressFromBase64(''), null);
  assert.equal(ref.decompressFromBase64(''), null);
});
