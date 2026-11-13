// Recording voice messages. The apps send AAC in M4A files (and iOS plays nothing else that browsers
// can record), so AAC is recorded where the browser can encode it (WebCodecs) and put into an M4A file
// here. Browsers without an AAC encoder (Firefox, Chrome on Linux) record 8 kHz μ-law WAV, which all the
// apps can play; Duplex converts it for browsers that cannot.
import { timestampName } from './media';

export const MAX_VOICE_SECONDS = 300;

export interface Recording {
  blob: Blob;
  name: string;
  /** seconds */
  duration: number;
  format: 'aac' | 'wav';
}

const AAC = { codec: 'mp4a.40.2', numberOfChannels: 1, bitrate: 32000 };

export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
}

async function aacSupported(sampleRate: number): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
  try {
    return !!(await AudioEncoder.isConfigSupported({ ...AAC, sampleRate })).supported;
  } catch {
    return false;
  }
}

export class VoiceRecorder {
  private stream!: MediaStream;
  private ctx!: AudioContext;
  private node!: ScriptProcessorNode;
  private source!: MediaStreamAudioSourceNode;
  private pcm: Float32Array[] = [];
  private frames = 0;
  private encoder: AudioEncoder | undefined;
  private aacFrames: Uint8Array[] = [];
  private asc: Uint8Array | undefined;
  private encodeError: Error | undefined;
  private peak = 0;
  private stopped = false;
  /** called when the maximum length is reached */
  onLimit: () => void = () => {};

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** seconds recorded */
  get elapsed(): number {
    return this.ctx ? this.frames / this.ctx.sampleRate : 0;
  }

  /** the loudness since the last call, 0..1 */
  level(): number {
    const p = this.peak;
    this.peak = 0;
    return Math.min(1, p);
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (await aacSupported(this.ctx.sampleRate)) {
        this.encoder = new AudioEncoder({
          output: (chunk, meta) => {
            const b = new Uint8Array(chunk.byteLength);
            chunk.copyTo(b);
            this.aacFrames.push(b);
            const d = meta?.decoderConfig?.description;
            if (d && !this.asc) this.asc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice(0));
          },
          error: (e) => (this.encodeError = e as Error),
        });
        this.encoder.configure({ ...AAC, sampleRate: this.ctx.sampleRate });
      }
      this.source = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessorNode needs no module script (a worklet would need another file)
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination);
    } catch (e) {
      this.release();
      throw e;
    }
  }

  private onAudio(input: Float32Array): void {
    if (this.stopped) return;
    const left = Math.round(MAX_VOICE_SECONDS * this.ctx.sampleRate) - this.frames;
    if (left <= 0) return;
    const data = input.slice(0, Math.min(input.length, left));
    for (let i = 0; i < data.length; i += 16) this.peak = Math.max(this.peak, Math.abs(data[i]));
    if (this.encoder) {
      const ad = new AudioData({ format: 'f32-planar', sampleRate: this.ctx.sampleRate, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((this.frames / this.ctx.sampleRate) * 1e6), data });
      this.encoder.encode(ad);
      ad.close();
    } else this.pcm.push(data);
    this.frames += data.length;
    if (this.frames >= MAX_VOICE_SECONDS * this.ctx.sampleRate) this.onLimit();
  }

  private release(): void {
    this.stopped = true;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      // already disconnected
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
  }

  cancel(): void {
    this.release();
    try {
      this.encoder?.close();
    } catch {
      // closed
    }
  }

  async stop(): Promise<Recording> {
    const rate = this.ctx.sampleRate;
    this.release();
    const duration = this.frames / rate;
    if (this.encoder) {
      await this.encoder.flush();
      this.encoder.close();
      if (this.encodeError) throw this.encodeError;
      const asc = this.asc ?? audioSpecificConfig(rate, 1);
      const m4a = muxM4A(this.aacFrames, asc, rate, 1);
      return { blob: new Blob([m4a as BlobPart], { type: 'audio/mp4' }), name: timestampName('voice', 'm4a'), duration, format: 'aac' };
    }
    const wav = encodeMulawWav(resample(concatF32(this.pcm), rate, 8000), 8000);
    return { blob: new Blob([wav as BlobPart], { type: 'audio/wav' }), name: timestampName('voice', 'wav'), duration, format: 'wav' };
  }
}

function concatF32(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** windowed-sinc resampling with a low-pass below the new Nyquist frequency */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const cutoff = Math.min(1, to / from) * 0.9;
  const half = 24;
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const c = Math.floor(t);
    let acc = 0;
    let wsum = 0;
    for (let k = c - half * Math.ceil(ratio); k <= c + half * Math.ceil(ratio); k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (k - t) * cutoff;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (k - t)) / (half * Math.ceil(ratio) + 1));
      acc += x[k] * sinc * w;
      wsum += sinc * w;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

/** G.711 μ-law */
export function mulawEncode(s: number): number {
  const BIAS = 0x84;
  let v = Math.max(-32635, Math.min(32635, Math.round(s * 32767)));
  const sign = v < 0 ? 0x80 : 0;
  if (v < 0) v = -v;
  v += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (v >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

export function mulawDecode(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  const v = (((mant << 3) + 0x84) << exp) - 0x84;
  return sign ? -v : v;
}

export function alawDecode(a: number): number {
  a ^= 0x55;
  const sign = a & 0x80;
  const exp = (a >> 4) & 0x07;
  const mant = a & 0x0f;
  const v = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1);
  return sign ? v : -v;
}

function riff(fmt: number[], data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + data.length + (data.length & 1));
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => (out[o + i] = ch.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, out.length - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  str(20 + fmt.length, 'data');
  dv.setUint32(24 + fmt.length, data.length, true);
  out.set(data, 28 + fmt.length);
  return out;
}

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

/** a mono 8-bit μ-law WAV file (format 7, with the cbSize field of non-PCM formats) */
export function encodeMulawWav(x: Float32Array, rate: number): Uint8Array {
  const data = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) data[i] = mulawEncode(x[i]);
  return riff([...le16(7), ...le16(1), ...le32(rate), ...le32(rate), ...le16(1), ...le16(8), ...le16(0)], data);
}

/** μ-law and A-law WAV files as 16-bit PCM WAV, which all browsers play; anything else unchanged */
export async function playableAudio(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const s = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (s(0, 4) !== 'RIFF' || s(8, 4) !== 'WAVE') return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(b.buffer);
  let fmt: { code: number; ch: number; rate: number; bits: number } | undefined;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const len = dv.getUint32(o + 4, true);
    if (id === 'fmt ' && len >= 16) fmt = { code: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data' && fmt && (fmt.code === 6 || fmt.code === 7) && fmt.bits === 8) {
      const src = b.subarray(o + 8, Math.min(b.length, o + 8 + len));
      const pcm = new Uint8Array(src.length * 2);
      const pv = new DataView(pcm.buffer);
      const dec = fmt.code === 7 ? mulawDecode : alawDecode;
      for (let i = 0; i < src.length; i++) pv.setInt16(i * 2, dec(src[i]), true);
      const out = riff([...le16(1), ...le16(fmt.ch), ...le32(fmt.rate), ...le32(fmt.rate * fmt.ch * 2), ...le16(fmt.ch * 2), ...le16(16)], pcm);
      return new Blob([out as BlobPart], { type: 'audio/wav' });
    }
    o += 8 + len + (len & 1);
  }
  return blob;
}

// ---- M4A (MP4 with one AAC track), as the apps write voice messages

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig of AAC-LC (ISO 14496-3), for encoders that do not give one */
export function audioSpecificConfig(rate: number, channels: number): Uint8Array {
  const idx = SAMPLE_RATES.indexOf(rate);
  if (idx < 0) throw new Error(`unsupported sample rate ${rate}`);
  return Uint8Array.of((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
}

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...content: Array<number[] | Uint8Array>): Uint8Array {
  const len = 8 + content.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  out.set([...u32(len), ...ascii(type)]);
  let o = 8;
  for (const c of content) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const fullBox = (type: string, version: number, flags: number, ...content: Array<number[] | Uint8Array>) => box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...content);

/** an MPEG-4 descriptor with a one-byte length */
function descr(tag: number, ...content: Array<number[] | Uint8Array>): number[] {
  const body = content.flatMap((c) => [...c]);
  if (body.length > 127) throw new Error('descriptor too long');
  return [tag, body.length, ...body];
}

const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

export function muxM4A(frames: Uint8Array[], asc: Uint8Array, rate: number, channels: number): Uint8Array {
  const n = frames.length;
  const samples = n * 1024;
  const durMs = Math.round((samples / rate) * 1000);
  const totalBytes = frames.reduce((s, f) => s + f.length, 0);
  const avgBitrate = durMs ? Math.round((totalBytes * 8 * 1000) / durMs) : 0;
  const maxFrame = frames.reduce((m, f) => Math.max(m, f.length), 0);
  const esds = fullBox(
    'esds',
    0,
    0,
    descr(0x03, u16(1), [0], descr(0x04, [0x40, 0x15], [(maxFrame >> 16) & 0xff, (maxFrame >> 8) & 0xff, maxFrame & 0xff], u32(Math.max(avgBitrate, 32000)), u32(avgBitrate), descr(0x05, asc)), descr(0x06, [0x02])),
  );
  const mp4a = box('mp4a', [0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(channels), u16(16), u16(0), u16(0), u32(rate << 16 >>> 0), esds);
  const stbl = (chunkOffset: number) =>
    box(
      'stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, u32(n ? 1 : 0), ...(n ? [u32(n), u32(1024)] : [])),
      fullBox('stsc', 0, 0, u32(n ? 1 : 0), ...(n ? [u32(1), u32(n), u32(1)] : [])),
      fullBox('stsz', 0, 0, u32(0), u32(n), ...frames.map((f) => u32(f.length))),
      fullBox('stco', 0, 0, u32(n ? 1 : 0), ...(n ? [u32(chunkOffset)] : [])),
    );
  const moov = (chunkOffset: number) =>
    box(
      'moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x10000), u16(0x100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2)),
      box(
        'trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), u32(0), u32(0), u16(0), u16(1), u16(0x100), u16(0), MATRIX, u32(0), u32(0)),
        box(
          'mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(samples), u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), [...ascii('SoundHandler'), 0]),
          box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl(chunkOffset)),
        ),
      ),
    );
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));
  const moovLen = moov(0).length;
  const mdatHeader = u32(8 + totalBytes).concat(ascii('mdat'));
  const out = new Uint8Array(ftyp.length + moovLen + 8 + totalBytes);
  out.set(ftyp, 0);
  out.set(moov(ftyp.length + moovLen + 8), ftyp.length);
  out.set(mdatHeader, ftyp.length + moovLen);
  let o = ftyp.length + moovLen + 8;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
