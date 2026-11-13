// LZString (lz-string 1.4.4 by pieroxy, MIT): compressToBase64 and decompressFromBase64, the format
// that the call pages of the SimpleX Chat apps use for WebRTC session descriptions and ICE candidates.
const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const KEY_INDEX: Record<string, number> = Object.fromEntries([...KEY].map((c, i) => [c, i]));

class BitWriter {
  private out: string[] = [];
  private val = 0;
  private pos = 0;
  constructor(
    private bitsPerChar: number,
    private toChar: (n: number) => string,
  ) {}
  /** writes n bits of v, the lowest first (as lz-string writes values) */
  bits(v: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.val = (this.val << 1) | (v & 1);
      if (this.pos === this.bitsPerChar - 1) {
        this.pos = 0;
        this.out.push(this.toChar(this.val));
        this.val = 0;
      } else this.pos++;
      v >>= 1;
    }
  }
  /** pads the last character with zero bits */
  finish(): string {
    for (;;) {
      this.val <<= 1;
      if (this.pos === this.bitsPerChar - 1) {
        this.out.push(this.toChar(this.val));
        break;
      }
      this.pos++;
    }
    return this.out.join('');
  }
}

function compress(input: string, bitsPerChar: number, toChar: (n: number) => string): string {
  const dict = new Map<string, number>();
  const toCreate = new Set<string>();
  let w = '';
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const out = new BitWriter(bitsPerChar, toChar);
  const enlarge = () => {
    if (--enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };
  const emit = (s: string) => {
    if (toCreate.has(s)) {
      const code = s.charCodeAt(0);
      if (code < 256) {
        out.bits(0, numBits);
        out.bits(code, 8);
      } else {
        out.bits(1, numBits);
        out.bits(code, 16);
      }
      enlarge();
      toCreate.delete(s);
    } else out.bits(dict.get(s)!, numBits);
    enlarge();
  };
  // lz-string works on UTF-16 code units
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (!dict.has(c)) {
      dict.set(c, dictSize++);
      toCreate.add(c);
    }
    const wc = w + c;
    if (dict.has(wc)) w = wc;
    else {
      emit(w);
      dict.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== '') emit(w);
  // the end of the stream
  out.bits(2, numBits);
  return out.finish();
}

function decompress(length: number, resetValue: number, next: (i: number) => number): string | null {
  const dict: string[] = ['0', '1', '2'];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let val = next(0);
  let position = resetValue;
  let index = 1;
  const read = (n: number) => {
    let bits = 0;
    for (let power = 1; power !== 2 ** n; power <<= 1) {
      const b = val & position;
      position >>= 1;
      if (position === 0) {
        position = resetValue;
        val = next(index++);
      }
      if (b > 0) bits |= power;
    }
    return bits;
  };
  let c: string;
  switch (read(2)) {
    case 0:
      c = String.fromCharCode(read(8));
      break;
    case 1:
      c = String.fromCharCode(read(16));
      break;
    default:
      return '';
  }
  dict[3] = c;
  let w = c;
  const result = [c];
  for (;;) {
    if (index > length) return '';
    let code = read(numBits);
    switch (code) {
      case 0:
        dict[dictSize++] = String.fromCharCode(read(8));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dict[dictSize++] = String.fromCharCode(read(16));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    let entry: string;
    if (code < dictSize && dict[code] !== undefined && code > 2) entry = dict[code];
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dict[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}

export function compressToBase64(input: string): string {
  const r = compress(input, 6, (n) => KEY.charAt(n));
  return r + ['', '===', '==', '='][r.length % 4];
}

export function decompressFromBase64(input: string): string | null {
  if (input === '') return null;
  return decompress(input.length, 32, (i) => KEY_INDEX[input.charAt(i)] ?? 0);
}
