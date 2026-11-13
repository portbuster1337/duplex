// WebRTC calls with the SimpleX Chat apps, following their call page (packages/simplex-chat-webrtc):
// four transceivers in this order (microphone, camera, screen audio, screen video), VP8 for video,
// LZString-compressed session descriptions and ICE candidates, and media frames encrypted end to end
// with the key agreed in the call messages.
import { compressToBase64, decompressFromBase64 } from '../core/util/lzstring';
import type { CallMedia } from '../core/chat/calls';
import { decodeKey, frameTransform, type TransformOperation } from './callcrypto';

/** the STUN and TURN servers of the apps */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stuns:stun.simplex.im:443'] },
  { urls: ['stun:stun.simplex.im:443'] },
  { urls: ['turns:turn.simplex.im:443?transport=tcp'], username: 'private2', credential: 'Hxuq2QxUjnhj96Zq2r4HjqHRj' },
];

/** ICE servers in the format of the apps: stun:host:port, turns:user:password@host:port?transport=tcp */
export function parseIceServer(s0: string): RTCIceServer | undefined {
  const m = /^(stuns?|turns?):(?:([^:@/]+):([^@/]+)@)?([^:@/?]+|\[[0-9a-fA-F:]+\]):(\d{1,5})(\?transport=(?:udp|tcp))?$/.exec(s0.trim());
  if (!m) return undefined;
  const [, scheme, user, pass, host, port, query] = m;
  if (scheme.startsWith('turn') && !user) return undefined;
  return { urls: [`${scheme}:${host}:${port}${query ?? ''}`], ...(user ? { username: user, credential: pass } : {}) };
}

export const iceServerString = (s: RTCIceServer): string => {
  const url = [s.urls].flat()[0] ?? '';
  const i = url.indexOf(':');
  return s.username ? `${url.slice(0, i)}:${s.username}:${s.credential ?? ''}@${url.slice(i + 1)}` : url;
};

const serialize = (x: unknown): string => compressToBase64(JSON.stringify(x));

function parse<T>(s: string): T {
  const j = decompressFromBase64(s);
  if (!j) throw new Error('bad call data');
  return JSON.parse(j) as T;
}

type Transformable = Omit<RTCRtpSender | RTCRtpReceiver, 'transform'> & {
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
  transform?: unknown;
};

type EncryptionMode = 'script' | 'insertable' | undefined;

function encryptionMode(): EncryptionMode {
  if (typeof window === 'undefined' || typeof RTCRtpSender === 'undefined') return undefined;
  if ('RTCRtpScriptTransform' in window && typeof Worker !== 'undefined') return 'script';
  if ('createEncodedStreams' in RTCRtpSender.prototype && 'createEncodedStreams' in RTCRtpReceiver.prototype) return 'insertable';
  return undefined;
}

/** whether this browser can encrypt media frames end to end (insertable streams or RTCRtpScriptTransform) */
export const supportsCallEncryption = (): boolean => !!encryptionMode();

export function supportsCalls(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** desktop browsers: mobile ones cannot capture the screen */
export const supportsScreenSharing = (): boolean => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** what each transceiver carries, by its mid, as in the apps */
export type MediaSource = 'mic' | 'camera' | 'screenAudio' | 'screenVideo';
const SOURCES: readonly MediaSource[] = ['mic', 'camera', 'screenAudio', 'screenVideo'];

const CAMERA: MediaTrackConstraints = { frameRate: 24, width: { min: 480, ideal: 720, max: 1280 }, aspectRatio: 1.33, facingMode: 'user' };

async function userMedia(audio: boolean, video: boolean): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: video ? CAMERA : false });
  } catch (e) {
    // a camera that does not meet the constraints
    if (!video || (e as Error).name !== 'OverconstrainedError') throw e;
    return await navigator.mediaDevices.getUserMedia({ audio, video: true });
  }
}

export interface CallOptions {
  iceServers?: RTCIceServer[];
  /** only relayed ICE candidates: the contact does not see our IP address */
  relay: boolean;
}

export class WebRTCCall {
  readonly pc: RTCPeerConnection;
  /** the microphone and camera of the contact */
  readonly remoteStream = new MediaStream();
  /** the screen the contact shares */
  readonly remoteScreen = new MediaStream();
  /** what the contact sends now: the apps switch a source off by sending nothing on its transceiver */
  readonly peerMedia: Record<MediaSource, boolean> = { mic: false, camera: false, screenAudio: false, screenVideo: false };
  localStream = new MediaStream();
  /** the screen, window or tab we share */
  screen: MediaStream | undefined;
  /** later local ICE candidates, for x.call.extra */
  onIce: (iceCandidates: string) => void = () => {};
  onState: (state: RTCPeerConnectionState) => void = () => {};
  /** the media of either side changed */
  onMedia: () => void = () => {};
  private mode: EncryptionMode;
  private key?: CryptoKey;
  private worker?: Worker;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  /** senders and receivers with a transform (each can have one) */
  private transformed = new WeakSet<object>();
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private closed = false;

  private constructor(
    readonly media: CallMedia,
    readonly aesKey: string | undefined,
    opts: CallOptions,
  ) {
    this.mode = aesKey ? encryptionMode() : undefined;
    if (aesKey && !this.mode) throw new Error('this browser cannot encrypt calls');
    const config: RTCConfiguration & { encodedInsertableStreams?: boolean } = {
      iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 0,
      iceTransportPolicy: opts.relay ? 'relay' : 'all',
    };
    if (this.mode === 'insertable') config.encodedInsertableStreams = true;
    try {
      this.pc = new RTCPeerConnection(config);
    } catch {
      // older browsers do not accept stuns: URLs
      config.iceServers = config.iceServers!.filter((s) => ![s.urls].flat().some((u) => u.startsWith('stuns:')));
      this.pc = new RTCPeerConnection(config);
    }
    this.pc.ontrack = (e) => this.onTrack(e);
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
  }

  private async init(): Promise<void> {
    if (!this.aesKey) return;
    this.key = await decodeKey(this.aesKey);
    if (typeof Worker === 'undefined') return;
    const w = (this.worker = new Worker(new URL('./callworker.ts', import.meta.url), { type: 'module' }));
    // transform events sent before the worker listens are lost
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the encryption worker did not start')), 10000);
      w.addEventListener('message', (e) => {
        if (e.data?.ready) {
          clearTimeout(t);
          resolve();
        }
      });
      w.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('the encryption worker failed'));
      });
    });
  }

  private async getMedia(): Promise<void> {
    this.localStream = await userMedia(true, this.media === 'video');
  }

  private onTrack(e: RTCTrackEvent): void {
    this.transform('decrypt', e.receiver as Transformable);
    const source = SOURCES[Number(e.transceiver.mid)];
    if (source) this.watch(e.transceiver, e.track, source);
  }

  /**
   * a source of the contact is on while bytes arrive on its transceiver, as the apps detect it: they
   * switch the camera or the screen off by sending nothing (no renegotiation). Its track joins the
   * stream when it first plays (Safari does not play a stream with a silent track).
   */
  private watch(t: RTCRtpTransceiver, track: MediaStreamTrack, source: MediaSource): void {
    let statsId = '';
    let last = 0;
    let idle = 4;
    const iv = setInterval(async () => {
      if (this.closed) return clearInterval(iv);
      let stats: RTCStatsReport;
      try {
        stats = await t.receiver.getStats();
      } catch {
        return;
      }
      if (!statsId) stats.forEach((s: { type: string; id: string }) => s.type === 'inbound-rtp' && (statsId = s.id));
      const bytes = (stats.get(statsId) as { bytesReceived?: number } | undefined)?.bytesReceived;
      if (bytes === undefined) return;
      if (bytes > last) {
        last = bytes;
        if (idle >= 3) this.setPeerMedia(source, track, true);
        idle = 0;
      } else if (++idle === 3) this.setPeerMedia(source, track, false);
    }, 1000);
    this.intervals.push(iv);
  }

  private setPeerMedia(source: MediaSource, track: MediaStreamTrack, on: boolean): void {
    if (this.closed || this.peerMedia[source] === on) return;
    this.peerMedia[source] = on;
    const stream = source === 'mic' || source === 'camera' ? this.remoteStream : this.remoteScreen;
    if (on && !stream.getTracks().includes(track)) stream.addTrack(track);
    this.onMedia();
  }

  private transform(operation: TransformOperation, peer: Transformable): void {
    if (!this.aesKey || !this.mode || this.transformed.has(peer)) return;
    this.transformed.add(peer);
    if (this.mode === 'script') {
      const T = (window as unknown as { RTCRtpScriptTransform: new (w: Worker, o: unknown) => unknown }).RTCRtpScriptTransform;
      peer.transform = new T(this.worker!, { operation, aesKey: this.aesKey });
    } else if (peer.createEncodedStreams) {
      const { readable, writable } = peer.createEncodedStreams();
      if (this.worker) this.worker.postMessage({ operation, readable, writable, aesKey: this.aesKey }, [readable as unknown as Transferable, writable as unknown as Transferable]);
      else void readable.pipeThrough(new TransformStream({ transform: frameTransform(operation, this.key!) })).pipeTo(writable);
    }
  }

  /**
   * the transforms of all senders and receivers. They are attached before the tracks: Chrome ignores
   * a sender transform attached after a track was set with replaceTrack.
   */
  private attachTransforms(): void {
    for (const t of this.pc.getTransceivers()) {
      this.transform('encrypt', t.sender as Transformable);
      this.transform('decrypt', t.receiver as Transformable);
    }
  }

  /** VP8 first: the plain prefix of encrypted frames is that of VP8 */
  private preferVP8(): void {
    const caps = typeof RTCRtpReceiver.getCapabilities === 'function' ? RTCRtpReceiver.getCapabilities('video') : null;
    if (!caps) return;
    const codecs = [...caps.codecs];
    const i = codecs.findIndex((c) => c.mimeType === 'video/VP8');
    if (i < 0) return;
    codecs.unshift(...codecs.splice(i, 1));
    this.pc.getTransceivers().forEach((t, n) => {
      if ((n === 1 || n === 3) && t.setCodecPreferences) {
        try {
          t.setCodecPreferences(codecs);
        } catch {
          // the browser chooses the codecs
        }
      }
    });
  }

  /** the candidates gathered in the first 750 ms (or all of them, when gathering completes sooner); later ones go to onIce */
  private gatherIce(): Promise<string> {
    return new Promise((resolve) => {
      let candidates: RTCIceCandidate[] = [];
      let resolved = false;
      const flush = () => {
        if (candidates.length && !this.closed) this.onIce(serialize(candidates));
        candidates = [];
      };
      const first = () => {
        if (resolved) return;
        resolved = true;
        resolve(serialize(candidates));
        candidates = [];
      };
      this.timers.push(
        setTimeout(() => {
          if (resolved) return;
          first();
          const iv = setInterval(flush, 1500);
          this.intervals.push(iv);
          this.timers.push(
            setTimeout(() => {
              clearInterval(iv);
              flush();
            }, 12000),
          );
        }, 750),
      );
      this.pc.onicecandidate = ({ candidate }) => candidate && candidates.push(candidate);
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState !== 'complete') return;
        if (resolved) flush();
        else first();
      };
    });
  }

  /** the party that accepts a call makes the offer (the "start" command of the apps) */
  static async offer(media: CallMedia, aesKey: string | undefined, opts: CallOptions): Promise<{ call: WebRTCCall; offer: string; iceCandidates: string }> {
    const call = new WebRTCCall(media, aesKey, opts);
    try {
      await call.init();
      await call.getMedia();
      const pc = call.pc;
      const audio = pc.addTransceiver('audio', { streams: [call.localStream] });
      const video = pc.addTransceiver('video', { streams: [call.localStream] });
      const screen = new MediaStream();
      pc.addTransceiver('audio', { streams: [screen] });
      pc.addTransceiver('video', { streams: [screen] });
      call.attachTransforms();
      const mic = call.localStream.getAudioTracks()[0];
      if (mic) await audio.sender.replaceTrack(mic);
      const cam = call.localStream.getVideoTracks()[0];
      if (cam) await video.sender.replaceTrack(cam);
      call.preferVP8();
      const ice = call.gatherIce();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return { call, offer: serialize(offer), iceCandidates: await ice };
    } catch (e) {
      call.close();
      throw e;
    }
  }

  /** the party that called answers the offer (the "offer" command of the apps) */
  static async answer(media: CallMedia, aesKey: string | undefined, opts: CallOptions, offer: string, iceCandidates: string): Promise<{ call: WebRTCCall; answer: string; iceCandidates: string }> {
    const call = new WebRTCCall(media, aesKey, opts);
    try {
      await call.init();
      await call.getMedia();
      const pc = call.pc;
      const ice = call.gatherIce();
      await pc.setRemoteDescription(new RTCSessionDescription(parse<RTCSessionDescriptionInit>(offer)));
      const ts = pc.getTransceivers();
      if (ts.length > 2) {
        call.attachTransforms();
        const mic = call.localStream.getAudioTracks()[0];
        const cam = call.localStream.getVideoTracks()[0];
        if (mic) await ts.find((t) => t.mid === '0')?.sender.replaceTrack(mic);
        if (cam) await ts.find((t) => t.mid === '1')?.sender.replaceTrack(cam);
      } else {
        // older apps: two transceivers, the tracks are added
        for (const t of call.localStream.getTracks()) pc.addTrack(t, call.localStream);
        call.attachTransforms();
      }
      call.preferVP8();
      for (const t of pc.getTransceivers()) t.direction = 'sendrecv';
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      call.addCandidates(iceCandidates);
      return { call, answer: serialize(answer), iceCandidates: await ice };
    } catch (e) {
      call.close();
      throw e;
    }
  }

  async receiveAnswer(answer: string, iceCandidates: string): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(parse<RTCSessionDescriptionInit>(answer)));
    this.addCandidates(iceCandidates);
  }

  addCandidates(iceCandidates: string): void {
    for (const c of parse<RTCIceCandidateInit[]>(iceCandidates) ?? []) this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }

  get micOn(): boolean {
    return this.localStream.getAudioTracks().some((t) => t.enabled);
  }

  get cameraOn(): boolean {
    return this.localStream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  private transceiver(source: MediaSource): RTCRtpTransceiver | undefined {
    const mid = String(SOURCES.indexOf(source));
    return this.pc.getTransceivers().find((t) => t.mid === mid);
  }

  setMic(on: boolean): void {
    for (const t of this.localStream.getAudioTracks()) t.enabled = on;
  }

  /**
   * the camera, also in audio calls. Off, it is released and nothing is sent, as in the apps: the
   * contact sees the picture of the profile rather than a black video.
   */
  async setCamera(on: boolean): Promise<void> {
    const t = this.transceiver('camera');
    if (!on) {
      for (const track of this.localStream.getVideoTracks()) {
        track.stop();
        this.localStream.removeTrack(track);
      }
      await t?.sender.replaceTrack(null);
      this.onMedia();
      return;
    }
    if (this.cameraOn || !t) return;
    const s = await userMedia(false, true);
    const track = s.getVideoTracks()[0];
    if (this.closed || !track) return s.getTracks().forEach((x) => x.stop());
    await t.sender.replaceTrack(track);
    this.localStream.addTrack(track);
    this.onMedia();
  }

  /** the apps of older versions negotiated two transceivers, without the screen */
  get canShareScreen(): boolean {
    return supportsScreenSharing() && !!this.transceiver('screenVideo');
  }

  /** shares a screen, window or tab chosen in the browser, without its sound (as the apps do) */
  async shareScreen(on: boolean): Promise<void> {
    const t = this.transceiver('screenVideo');
    if (!on) {
      const s = this.screen;
      if (!s) return;
      this.screen = undefined;
      s.getTracks().forEach((x) => x.stop());
      await t?.sender.replaceTrack(null).catch(() => {});
      this.onMedia();
      return;
    }
    if (this.screen || !t) return;
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 24 }, audio: false });
    const track = s.getVideoTracks()[0];
    if (this.closed || !track || this.screen) return s.getTracks().forEach((x) => x.stop());
    // "Stop sharing" in the browser
    track.addEventListener('ended', () => this.screen === s && void this.shareScreen(false));
    this.screen = s;
    await t.sender.replaceTrack(track);
    this.onMedia();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    for (const t of this.localStream.getTracks()) t.stop();
    for (const t of this.screen?.getTracks() ?? []) t.stop();
    this.screen = undefined;
    try {
      this.pc.close();
    } catch {
      // closed
    }
    this.worker?.terminate();
  }
}
