// The call screen: an incoming call, a call in progress (the contact's video or picture, ours in a
// corner, microphone and camera switches), and the WebRTC side of the signalling.
import type { JSX } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { profileName } from '../app/chat';
import type { ActiveCall } from '../app/calls';
import type { CallMedia } from '../core/chat/calls';
import { Avatar } from './util';
import { Icon } from './icons';
import { errorText, toast } from './components';
import { parseIceServer, supportsCallEncryption, supportsScreenSharing, WebRTCCall, type CallOptions } from './webrtc';

/** connects the signalling of the chat client with WebRTC in the page */
class CallEngine {
  rtc: WebRTCCall | undefined;
  private early: string[] = [];
  onChange: () => void = () => {};

  constructor(readonly session: Session) {
    const chat = session.chat;
    chat.callEncryption = supportsCallEncryption;
    chat.calls.onSignal = (s) => {
      switch (s.type) {
        case 'offer':
          void this.answer(s.call, s.offer.rtcSession, s.offer.rtcIceCandidates);
          return;
        case 'answer':
          this.rtc?.receiveAnswer(s.answer.rtcSession, s.answer.rtcIceCandidates).catch((e) => this.fail(e));
          return;
        case 'extra':
          if (this.rtc) this.rtc.addCandidates(s.iceCandidates);
          else this.early.push(s.iceCandidates);
          return;
        case 'ended':
          this.close();
          return;
      }
    };
  }

  private get opts(): CallOptions {
    const custom = (this.session.settings.iceServers ?? []).map(parseIceServer).filter((s): s is RTCIceServer => !!s);
    return { relay: this.session.settings.callsRelay !== false, ...(custom.length ? { iceServers: custom } : {}) };
  }

  private wire(rtc: WebRTCCall): void {
    const calls = this.session.chat.calls;
    this.rtc = rtc;
    for (const c of this.early.splice(0)) rtc.addCandidates(c);
    rtc.onIce = (c) => void calls.sendExtra(c);
    let lost: ReturnType<typeof setTimeout> | undefined;
    rtc.onState = (st) => {
      clearTimeout(lost);
      if (st === 'connected') void calls.connected();
      else if (st === 'failed') void calls.end('the connection failed');
      else if (st === 'disconnected') lost = setTimeout(() => void calls.end('the connection was lost'), 15000);
      this.onChange();
    };
    rtc.onMedia = () => this.onChange();
    this.onChange();
  }

  private fail(e: unknown): void {
    toast(`The call failed: ${errorText(e)}`, 'error');
    void this.session.chat.calls.end('failed');
  }

  /** we called, and the contact accepted with an offer */
  private async answer(call: ActiveCall, offer: string, ice: string): Promise<void> {
    try {
      const r = await WebRTCCall.answer(call.media, call.aesKey, this.opts, offer, ice);
      if (this.session.chat.calls.active !== call || call.status === 'ended') return r.call.close();
      this.wire(r.call);
      await this.session.chat.calls.sendAnswer({ rtcSession: r.answer, rtcIceCandidates: r.iceCandidates });
    } catch (e) {
      this.fail(e);
    }
  }

  /** accepts an incoming call with an offer */
  async accept(media: CallMedia): Promise<void> {
    const calls = this.session.chat.calls;
    const call = calls.accept(media);
    try {
      const r = await WebRTCCall.offer(call.media, call.aesKey, this.opts);
      if (calls.active !== call || call.status === 'ended') return r.call.close();
      this.wire(r.call);
      await calls.sendOffer({ rtcSession: r.offer, rtcIceCandidates: r.iceCandidates }, !!call.aesKey);
    } catch (e) {
      this.fail(e);
    }
  }

  close(): void {
    this.rtc?.close();
    this.rtc = undefined;
    this.early = [];
    this.onChange();
  }
}

let engine: CallEngine | undefined;

/** the engine of this session (a new one after the profile is unlocked again) */
export function callEngine(session: Session): CallEngine {
  if (engine?.session !== session) {
    engine?.close();
    engine = new CallEngine(session);
  }
  return engine;
}

/** starts a call from a chat */
export async function startCall(session: Session, contactId: string, media: CallMedia): Promise<void> {
  callEngine(session);
  try {
    // the camera and microphone are asked for when the contact accepts; asking now shows the prompt at once
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
    s.getTracks().forEach((t) => t.stop());
    await session.chat.calls.start(contactId, media, supportsCallEncryption());
  } catch (e) {
    toast(`The call could not start: ${errorText(e)}`, 'error');
  }
}

function useTicker(on: boolean): void {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick(0), 1000);
    return () => clearInterval(t);
  }, [on]);
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function attach(v: HTMLVideoElement | null, stream: MediaStream | undefined, play = false): void {
  if (!v || v.srcObject === (stream ?? null)) return;
  v.srcObject = stream ?? null;
  if (play && stream) v.play().catch(() => {});
}

export function CallScreen({ session }: { session: Session }): JSX.Element | null {
  const chat = session.chat;
  const eng = callEngine(session);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [busy, setBusy] = useState(false);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const myScreenRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    eng.onChange = () => bump(0);
    const off = chat.on((e) => e.type === 'call' && bump(0));
    return () => {
      off();
      eng.onChange = () => {};
      // locked: the call stops with the session
      eng.close();
    };
  }, [session]);
  const call = chat.calls.active;
  const rtc = eng.rtc;
  useTicker(call?.status === 'connected');
  useEffect(() => {
    attach(remoteRef.current, rtc?.remoteStream, true);
    attach(screenRef.current, rtc?.remoteScreen, true);
    attach(localRef.current, rtc?.localStream);
    attach(myScreenRef.current, rtc?.screen);
  });
  // the screen closes a moment after the call ended
  useEffect(() => {
    if (call?.status !== 'ended') return;
    const t = setTimeout(() => chat.calls.dismiss(), 2500);
    return () => clearTimeout(t);
  }, [call?.status]);
  if (!call) return null;
  const c = chat.contact(call.contactId);
  const name = c ? c.localAlias || profileName(c.profile) : 'contact';
  const live = !!rtc && call.status === 'connected';
  const remoteVideo = live && rtc.peerMedia.camera;
  const peerScreen = live && rtc.peerMedia.screenVideo;
  const status =
    call.status === 'ringing'
      ? `incoming ${call.media} call`
      : call.status === 'calling'
        ? 'calling…'
        : call.status === 'connecting'
          ? 'connecting…'
          : call.status === 'connected'
            ? clock(Date.now() - (call.connectedAt ?? Date.now()))
            : call.endReason && !['ended', 'ended by the contact'].includes(call.endReason)
              ? `call ended: ${call.endReason}`
              : 'call ended';
  const accept = async (media: CallMedia) => {
    setBusy(true);
    await eng.accept(media);
    setBusy(false);
  };
  return (
    <div class={`call-screen ${call.status} ${remoteVideo || peerScreen ? 'with-video' : ''} ${peerScreen ? 'peer-screen' : ''}`} role="dialog" aria-label={`Call with ${name}`}>
      <video ref={screenRef} class={`remote-screen ${peerScreen ? '' : 'hidden'}`} autoplay playsinline aria-label={peerScreen ? `The screen of ${name}` : undefined} />
      <video ref={remoteRef} class={`remote-video ${remoteVideo ? '' : 'hidden'}`} autoplay playsinline />
      {!remoteVideo && !peerScreen && (
        <div class="call-peer">
          <Avatar profile={c?.profile} size={120} />
        </div>
      )}
      <div class="call-info">
        <h2>{name}</h2>
        <p class="call-status" role="status">
          {status}
        </p>
        {call.status !== 'ringing' && call.status !== 'ended' && (
          <p class="call-enc">
            <Icon name={call.aesKey ? 'shieldCheck' : 'shield'} size={14} /> {call.aesKey ? 'end-to-end encrypted' : 'encrypted (DTLS) — not end-to-end'}
          </p>
        )}
        {peerScreen && <p class="call-enc">sharing their screen</p>}
      </div>
      {rtc?.cameraOn && <video ref={localRef} class="local-video" autoplay playsinline muted />}
      {rtc?.screen && (
        <figure class="local-screen">
          <video ref={myScreenRef} autoplay playsinline muted />
          <figcaption>You are sharing your screen</figcaption>
        </figure>
      )}
      <div class="call-controls">
        {call.status === 'ringing' ? (
          <>
            <button class="call-btn end" onClick={() => void chat.calls.end('rejected')} aria-label="Reject">
              <Icon name="close" size={26} />
            </button>
            {call.media === 'video' && (
              <button class="call-btn accept" disabled={busy} onClick={() => void accept('video')} aria-label="Accept with video">
                <Icon name="video" size={26} />
              </button>
            )}
            <button class="call-btn accept" disabled={busy} onClick={() => void accept('audio')} aria-label={call.media === 'video' ? 'Accept without video' : 'Accept'}>
              <Icon name="phone" size={26} />
            </button>
          </>
        ) : call.status !== 'ended' ? (
          <>
            <button
              class={`call-btn ${rtc && !rtc.micOn ? 'off' : ''}`}
              disabled={!rtc}
              onClick={() => {
                rtc?.setMic(!rtc.micOn);
                bump(0);
              }}
              aria-label={rtc && !rtc.micOn ? 'Unmute' : 'Mute'}
              aria-pressed={!!rtc && !rtc.micOn}
            >
              <Icon name="mic" size={24} />
            </button>
            <button
              class={`call-btn ${rtc && !rtc.cameraOn ? 'off' : ''}`}
              disabled={!rtc}
              onClick={() =>
                rtc
                  ?.setCamera(!rtc.cameraOn)
                  .then(() => bump(0))
                  .catch((e) => toast(errorText(e), 'error'))
              }
              aria-label={rtc?.cameraOn ? 'Turn the camera off' : 'Turn the camera on'}
            >
              <Icon name="video" size={24} />
            </button>
            {supportsScreenSharing() && (
              <button
                class={`call-btn ${rtc?.screen ? 'active' : ''}`}
                disabled={!rtc?.canShareScreen || call.status !== 'connected'}
                onClick={() =>
                  rtc?.shareScreen(!rtc.screen).catch((e) => {
                    // closing the browser's picker is not an error
                    if ((e as Error).name !== 'NotAllowedError' && (e as Error).name !== 'AbortError') toast(errorText(e), 'error');
                  })
                }
                aria-label={rtc?.screen ? 'Stop sharing your screen' : 'Share your screen'}
                aria-pressed={!!rtc?.screen}
                title={rtc && !rtc.canShareScreen ? 'The app of your contact cannot show a shared screen' : undefined}
              >
                <Icon name="screen" size={24} />
              </button>
            )}
            <button class="call-btn end" onClick={() => void chat.calls.end()} aria-label="End call">
              <Icon name="phoneOff" size={26} />
            </button>
          </>
        ) : (
          <button class="call-btn" onClick={() => chat.calls.dismiss()} aria-label="Close">
            <Icon name="close" size={24} />
          </button>
        )}
      </div>
    </div>
  );
}
