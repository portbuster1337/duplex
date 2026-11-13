// Voice recording formats: the M4A writer against ffmpeg (AAC frames from ffmpeg's encoder, muxed
// here, probed and decoded by ffmpeg), μ-law against G.711, and the WAV conversion for browsers.
//   FFMPEG_DIR=/path/to/ffmpeg-and-ffprobe npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audioSpecificConfig, encodeMulawWav, mulawDecode, mulawEncode, muxM4A, playableAudio, resample } from '../../src/ui/recorder';

const FF = process.env.FFMPEG_DIR;

test('μ-law encoding is G.711', () => {
  // values from the G.711 tables
  assert.equal(mulawEncode(0), 0xff);
  assert.equal(mulawEncode(-1), 0x00);
  assert.equal(mulawEncode(1), 0x80);
  assert.equal(mulawDecode(0xff), 0);
  assert.equal(mulawDecode(0x80), 32124);
  assert.equal(mulawDecode(0x00), -32124);
  // the round trip keeps the sample within the quantization step of its segment
  for (let s = -1; s <= 1; s += 0.001) {
    const v = Math.round(s * 32767);
    const d = mulawDecode(mulawEncode(s));
    assert.ok(Math.abs(d - v) <= Math.max(16, Math.abs(v) / 16), `${v} -> ${d}`);
  }
});

test('resampling keeps a tone below the new Nyquist frequency and removes one above it', () => {
  const tone = (f: number, rate: number, n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));
  const rms = (x: Float32Array) => Math.sqrt(x.slice(100, -100).reduce((s, v) => s + v * v, 0) / (x.length - 200));
  const low = resample(tone(440, 48000, 48000), 48000, 8000);
  assert.equal(low.length, 8000);
  assert.ok(Math.abs(rms(low) - 0.5 / Math.SQRT2) < 0.02, `440 Hz kept: ${rms(low)}`);
  const high = resample(tone(6000, 48000, 48000), 48000, 8000);
  assert.ok(rms(high) < 0.05, `6 kHz removed: ${rms(high)}`);
});

test('μ-law WAV files are converted to PCM for browsers', async () => {
  const x = Float32Array.from({ length: 800 }, (_, i) => 0.3 * Math.sin(i / 5));
  const wav = encodeMulawWav(x, 8000);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(new DataView(wav.buffer).getUint16(20, true), 7);
  const pcm = new Uint8Array(await (await playableAudio(new Blob([wav as BlobPart]))).arrayBuffer());
  const dv = new DataView(pcm.buffer);
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 1600);
  assert.equal(dv.getInt16(44 + 2 * 100, true), mulawDecode(wav[46 + 100]));
});

test('AudioSpecificConfig of AAC-LC', () => {
  assert.deepEqual([...audioSpecificConfig(48000, 1)], [0x11, 0x88]);
  assert.deepEqual([...audioSpecificConfig(44100, 2)], [0x12, 0x10]);
  assert.deepEqual([...audioSpecificConfig(16000, 1)], [0x14, 0x08]);
});

test('M4A files are read by ffmpeg like those of the apps', { skip: !FF }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4a-'));
  try {
    const ff = path.join(FF!, 'ffmpeg');
    const probe = path.join(FF!, 'ffprobe');
    // 3 seconds of AAC-LC at 48 kHz as ADTS, from ffmpeg's own encoder
    execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '1', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', path.join(dir, 'a.aac')]);
    const adts = fs.readFileSync(path.join(dir, 'a.aac'));
    const frames: Uint8Array[] = [];
    for (let o = 0; o + 7 <= adts.length; ) {
      assert.equal(adts[o], 0xff);
      const len = ((adts[o + 3] & 3) << 11) | (adts[o + 4] << 3) | (adts[o + 5] >> 5);
      const hdr = adts[o + 1] & 1 ? 7 : 9;
      frames.push(new Uint8Array(adts.subarray(o + hdr, o + len)));
      o += len;
    }
    const m4a = muxM4A(frames, audioSpecificConfig(48000, 1), 48000, 1);
    fs.writeFileSync(path.join(dir, 'voice.m4a'), m4a);
    const info = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path.join(dir, 'voice.m4a')]).toString());
    assert.equal(info.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
    assert.equal(info.format.tags?.major_brand, 'M4A ');
    assert.equal(info.streams.length, 1);
    assert.equal(info.streams[0].codec_name, 'aac');
    assert.equal(info.streams[0].profile, 'LC');
    assert.equal(Number(info.streams[0].sample_rate), 48000);
    assert.equal(info.streams[0].channels, 1);
    assert.equal(Number(info.streams[0].nb_frames), frames.length);
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.1, `duration ${info.format.duration}`);
    // decodes without errors, to the same audio as the ADTS stream
    const decode = (f: string) => execFileSync(ff, ['-v', 'error', '-xerror', '-i', f, '-f', 's16le', '-ac', '1', '-']);
    const a = decode(path.join(dir, 'a.aac'));
    const b = decode(path.join(dir, 'voice.m4a'));
    assert.ok(Math.abs(a.length - b.length) <= 2 * 2048, `${a.length} vs ${b.length}`);
    // and μ-law WAV files too
    fs.writeFileSync(path.join(dir, 'voice.wav'), encodeMulawWav(Float32Array.from({ length: 8000 }, (_, i) => 0.4 * Math.sin(i / 3)), 8000));
    const w = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(dir, 'voice.wav')]).toString());
    assert.equal(w.streams[0].codec_name, 'pcm_mulaw');
    assert.equal(Number(w.streams[0].sample_rate), 8000);
    assert.equal(decode(path.join(dir, 'voice.wav')).length, 16000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
