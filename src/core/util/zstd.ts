// A small zstd compressor (RFC 8878) for chat messages: blocks of Huffman-coded literals without
// matches, which compress base64 images and text by about a quarter. Frames declare their content
// size, as the official clients require before decompressing.
import type { Bytes } from './bytes';

const MAX_BLOCK = 128 * 1024;
const MAX_BITS = 11;

class BitWriter {
  private out: number[] = [];
  private acc = 0;
  private n = 0;
  add(value: number, bits: number): void {
    this.acc |= value << this.n;
    this.n += bits;
    while (this.n >= 8) {
      this.out.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  /** adds the end mark that decoders look for in the last byte */
  finish(): number[] {
    this.add(1, 1);
    if (this.n > 0) this.out.push(this.acc & 0xff);
    return this.out;
  }
}

/** Huffman code lengths of at most MAX_BITS bits for the symbols that occur */
function codeLengths(freq: number[]): number[] {
  let f = freq.slice();
  for (;;) {
    const lens = huffmanLengths(f);
    if (Math.max(...lens) <= MAX_BITS) return lens;
    // flatten the distribution until the longest code fits
    f = f.map((x) => (x ? Math.max(1, x >> 1) : 0));
  }
}

function huffmanLengths(freq: number[]): number[] {
  type Node = { w: number; sym?: number; l?: Node; r?: Node };
  const nodes: Node[] = [];
  freq.forEach((w, sym) => w && nodes.push({ w, sym }));
  const lens = new Array<number>(freq.length).fill(0);
  if (nodes.length === 1) {
    lens[nodes[0].sym!] = 1;
    return lens;
  }
  // a simple priority queue: n is at most 256
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.w - b.w);
    const a = nodes.shift()!;
    const b = nodes.shift()!;
    nodes.push({ w: a.w + b.w, l: a, r: b });
  }
  const walk = (n: Node, d: number) => {
    if (n.sym !== undefined) lens[n.sym] = d;
    else {
      walk(n.l!, d + 1);
      walk(n.r!, d + 1);
    }
  };
  walk(nodes[0], 0);
  return lens;
}

/** the canonical codes of zstd: by increasing weight (decreasing length), then by symbol */
function canonicalCodes(lens: number[], maxBits: number): number[] {
  const codes = new Array<number>(lens.length).fill(0);
  let code = 0;
  for (let w = 1; w <= maxBits; w++) {
    const len = maxBits + 1 - w;
    for (let s = 0; s < lens.length; s++) {
      if (lens[s] === len) codes[s] = code++;
    }
    code >>= 1;
  }
  return codes;
}

/** a compressed literals section, or undefined when Huffman coding does not apply or help */
function huffmanLiterals(lit: Bytes): number[] | undefined {
  const freq = new Array<number>(256).fill(0);
  for (const b of lit) freq[b]++;
  let maxSym = 0;
  let distinct = 0;
  for (let s = 0; s < 256; s++) {
    if (freq[s]) {
      maxSym = s;
      distinct++;
    }
  }
  // the direct representation of weights covers the symbols 0..128
  if (distinct < 2 || maxSym > 128) return undefined;
  const lens = codeLengths(freq.slice(0, maxSym + 1));
  const maxBits = Math.max(...lens);
  const codes = canonicalCodes(lens, maxBits);
  // Huffman_Tree_Description: the weights of the symbols before the last one, 4 bits each
  const weights = lens.slice(0, maxSym).map((l) => (l ? maxBits + 1 - l : 0));
  const tree = [127 + maxSym];
  for (let i = 0; i < weights.length; i += 2) tree.push((weights[i] << 4) | (weights[i + 1] ?? 0));
  const stream = (part: Bytes) => {
    const bw = new BitWriter();
    // the decoder reads the stream backward, so the first literal is written last
    for (let i = part.length - 1; i >= 0; i--) bw.add(codes[part[i]], lens[part[i]]);
    return bw.finish();
  };
  const n = lit.length;
  let body: number[];
  let sizeFormat: number;
  if (n <= 1023) {
    body = [...tree, ...stream(lit)];
    sizeFormat = 0;
    if (body.length > 1023) return undefined;
  } else {
    const seg = Math.floor((n + 3) / 4);
    const parts = [lit.subarray(0, seg), lit.subarray(seg, 2 * seg), lit.subarray(2 * seg, 3 * seg), lit.subarray(3 * seg)].map(stream);
    if (parts.slice(0, 3).some((p) => p.length > 0xffff)) return undefined;
    const jump = parts.slice(0, 3).flatMap((p) => [p.length & 0xff, p.length >> 8]);
    body = [...tree, ...jump, ...parts.flat()];
    const m = Math.max(n, body.length);
    sizeFormat = m <= 1023 ? 1 : m <= 16383 ? 2 : 3;
  }
  const c = body.length;
  let header: number[];
  if (sizeFormat <= 1) {
    const v = 2 | (sizeFormat << 2) | (n << 4) | (c << 14);
    header = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
  } else if (sizeFormat === 2) {
    const v = 2 | (2 << 2) | (n << 4) | (c << 18);
    header = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  } else {
    // 4 bits type and size format, 18 bits for each size
    const lo = 2 | (3 << 2) | ((n & 0xfffff) << 4);
    header = [lo & 0xff, (lo >>> 8) & 0xff, ((lo >>> 16) & 0x3f) | ((c & 0x3) << 6), (c >> 2) & 0xff, (c >> 10) & 0xff];
  }
  return [...header, ...body];
}

function blockHeader(last: boolean, type: number, size: number): number[] {
  const v = (last ? 1 : 0) | (type << 1) | (size << 3);
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
}

/** compresses into one zstd frame with the content size in its header */
export function zstdCompress(data: Bytes): Bytes {
  const n = data.length;
  const out: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  // single segment: the window is the content size
  if (n < 256) out.push(0x20, n);
  else if (n < 65792) out.push(0x60, (n - 256) & 0xff, (n - 256) >> 8);
  else out.push(0xa0, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  if (n === 0) {
    out.push(...blockHeader(true, 0, 0));
    return Uint8Array.from(out);
  }
  for (let off = 0; off < n; off += MAX_BLOCK) {
    const block = data.subarray(off, Math.min(n, off + MAX_BLOCK));
    const last = off + MAX_BLOCK >= n;
    const lit = huffmanLiterals(block);
    // a compressed block: the literals and no sequences
    if (lit && lit.length + 1 < block.length) {
      out.push(...blockHeader(last, 2, lit.length + 1), ...lit, 0);
    } else {
      out.push(...blockHeader(last, 0, block.length));
      for (const b of block) out.push(b);
    }
  }
  return Uint8Array.from(out);
}
