// HTTP/2 header compression (RFC 7541 Appendix C examples) and frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HpackDecoder, hpackEncode, huffmanDecode } from '../../src/core/net/http2';
import { fromHex, utf8 } from '../../src/core/util/bytes';

test('HPACK: requests with Huffman coding and the dynamic table (C.4)', () => {
  const d = new HpackDecoder();
  assert.deepEqual(d.decode(fromHex('828684418cf1e3c2e5f23a6ba0ab90f4ff')), [
    [':method', 'GET'],
    [':scheme', 'http'],
    [':path', '/'],
    [':authority', 'www.example.com'],
  ]);
  assert.deepEqual(d.decode(fromHex('828684be5886a8eb10649cbf')), [
    [':method', 'GET'],
    [':scheme', 'http'],
    [':path', '/'],
    [':authority', 'www.example.com'],
    ['cache-control', 'no-cache'],
  ]);
  assert.deepEqual(d.decode(fromHex('828785bf408825a849e95ba97d7f8925a849e95bb8e8b4bf')), [
    [':method', 'GET'],
    [':scheme', 'https'],
    [':path', '/index.html'],
    [':authority', 'www.example.com'],
    ['custom-key', 'custom-value'],
  ]);
});

test('HPACK: responses with evictions from a 256-byte table (C.6)', () => {
  const d = new HpackDecoder(256);
  const date1 = 'Mon, 21 Oct 2013 20:13:21 GMT';
  assert.deepEqual(d.decode(fromHex('488264025885aec3771a4b6196d07abe941054d444a8200595040b8166e082a62d1bff6e919d29ad171863c78f0b97c8e9ae82ae43d3')), [
    [':status', '302'],
    ['cache-control', 'private'],
    ['date', date1],
    ['location', 'https://www.example.com'],
  ]);
  assert.deepEqual(d.decode(fromHex('4883640effc1c0bf')), [
    [':status', '307'],
    ['cache-control', 'private'],
    ['date', date1],
    ['location', 'https://www.example.com'],
  ]);
  assert.deepEqual(
    d.decode(fromHex('88c16196d07abe941054d444a8200595040b8166e084a62d1bffc05a839bd9ab77ad94e7821dd7f2e6c7b335dfdfcd5b3960d5af27087f3672c1ab270fb5291f9587316065c003ed4ee5b1063d5007')),
    [
      [':status', '200'],
      ['cache-control', 'private'],
      ['date', 'Mon, 21 Oct 2013 20:13:22 GMT'],
      ['location', 'https://www.example.com'],
      ['content-encoding', 'gzip'],
      ['set-cookie', 'foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1'],
    ],
  );
});

test('HPACK: bad input is rejected', () => {
  // EOS padding longer than 7 bits, and padding that is not all ones
  assert.throws(() => huffmanDecode(fromHex('ffffffff')));
  assert.throws(() => huffmanDecode(fromHex('f1e3c2e5f23a6ba0ab90f4fe')));
  assert.throws(() => new HpackDecoder().decode(fromHex('ff')));
  assert.throws(() => new HpackDecoder().decode(fromHex('be')), /index/);
});

test('HPACK: encoded headers decode back', () => {
  const h: Array<[string, string]> = [
    [':method', 'POST'],
    [':path', '/'],
    ['x-long', 'v'.repeat(300)],
  ];
  assert.deepEqual(new HpackDecoder().decode(hpackEncode(h)), h);
  assert.equal(huffmanDecode(fromHex('f1e3c2e5f23a6ba0ab90f4ff')), 'www.example.com');
  assert.ok(utf8('x').length);
});
