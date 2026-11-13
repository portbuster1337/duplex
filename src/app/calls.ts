// Calls with contacts: the signalling of the SimpleX Chat apps (x.call.inv, .offer, .answer, .extra,
// .end) and the media key. The page runs WebRTC (src/ui/webrtc.ts) and tells this side what to send.
//
// The caller sends an invitation with its DH key; the contact accepts with a WebRTC offer and its own
// DH key; the caller answers. Both derive the key that media frames are encrypted with.
import { callKeyPair, callMediaKey, callVersion, callVRangeStr, decCallKey, encCallKey, newCallId, xCallAnswer, xCallEnd, xCallExtra, xCallInv, xCallOffer, type CallInvitation, type CallMedia, type CallOffer, type WebRTCSession } from '../core/chat/calls';
import { newSharedMsgId, type ChatMessage } from '../core/chat/protocol';
import type { KeyPair } from '../core/crypto/crypto';
import { ChatError, localId, profileName } from './common';
import type { ChatClient, ChatItem, Contact } from './chat';

export type CallStatus = 'calling' | 'ringing' | 'connecting' | 'connected' | 'ended';

export interface ActiveCall {
  contactId: string;
  callId: string;
  /** snd: we called; rcv: the contact called */
  dir: 'snd' | 'rcv';
  media: CallMedia;
  peerMedia?: CallMedia;
  status: CallStatus;
  version: number;
  keyPair?: KeyPair<'x25519'>;
  /** the key of the media frames (base64url), when both sides encrypt them */
  aesKey?: string;
  /** we can encrypt media frames */
  encryption: boolean;
  /** the contact's offer, for the caller to answer */
  offer?: WebRTCSession;
  itemId: string;
  connectedAt?: number;
  endReason?: string;
}

/** what the page has to do with WebRTC */
export type CallSignal =
  | { type: 'offer'; call: ActiveCall; offer: WebRTCSession }
  | { type: 'answer'; call: ActiveCall; answer: WebRTCSession }
  | { type: 'extra'; call: ActiveCall; iceCandidates: string; rtcSession?: string }
  | { type: 'ended'; call: ActiveCall };

/** a call that is not answered is ended after this time (the apps use similar timeouts) */
const RING_TIMEOUT = 60000;

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class CallManager {
  active: ActiveCall | undefined;
  /** set by the page */
  onSignal: (s: CallSignal) => void = () => {};
  private ringTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private chat: ChatClient) {}

  private changed(): void {
    this.chat.emitCall();
  }

  /** whether calls are possible with this contact: both allow them */
  allowed(c: Contact): boolean {
    return c.status === 'active' && c.profile.preferences?.calls?.allow !== 'no';
  }

  private async item(c: Contact, call: ActiveCall, text: string): Promise<void> {
    const items = await this.chat.chatItems(c.id);
    const it = items.find((i) => i.id === call.itemId);
    if (it) {
      it.content = { type: 'text', text };
      await this.chat.updateItem(c.id, it);
    } else await this.chat.addItem(c.id, { id: call.itemId, dir: 'event', content: { type: 'text', text }, ts: Date.now(), status: 'read', call: { media: call.media, dir: call.dir } } as ChatItem);
  }

  private send(c: Contact, m: ChatMessage): Promise<number> {
    return this.chat.sendDirect(c, m);
  }

  private contact(call: ActiveCall): Contact | undefined {
    return this.chat.contact(call.contactId);
  }

  private ring(): void {
    clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => {
      const call = this.active;
      if (call && (call.status === 'calling' || call.status === 'ringing')) void this.end(call.status === 'calling' ? 'no answer' : 'missed');
    }, RING_TIMEOUT);
  }

  /** calls a contact; encryption: the page can encrypt media frames */
  async start(contactId: string, media: CallMedia, encryption: boolean): Promise<ActiveCall> {
    if (this.active && this.active.status !== 'ended') throw new ChatError('there is a call already');
    const c = this.chat.contact(contactId);
    if (!c || c.status !== 'active') throw new ChatError('the contact is not connected');
    if (!this.allowed(c)) throw new ChatError('the contact does not allow calls');
    const keyPair = encryption ? callKeyPair() : undefined;
    const call: ActiveCall = { contactId, callId: newCallId(), dir: 'snd', media, status: 'calling', version: 2, keyPair, encryption, itemId: localId() };
    const invitation: CallInvitation = { callType: { media, capabilities: { encryption } }, ...(keyPair ? { callDhPubKey: encCallKey(keyPair.pub) } : {}), callVRange: callVRangeStr() };
    await this.send(c, xCallInv(call.callId, invitation, newSharedMsgId()));
    this.active = call;
    await this.item(c, call, `outgoing ${media} call…`);
    this.ring();
    this.changed();
    return call;
  }

  /** accepting an incoming call: the media of our side and the key for the page */
  accept(media?: CallMedia): ActiveCall {
    const call = this.active;
    if (!call || call.status !== 'ringing') throw new ChatError('there is no incoming call');
    if (media) call.media = media;
    call.status = 'connecting';
    clearTimeout(this.ringTimer);
    this.changed();
    return call;
  }

  /** the offer of the page, for the caller (our DH key goes with it) */
  async sendOffer(rtcSession: WebRTCSession, encryption: boolean): Promise<void> {
    const call = this.active;
    const c = call && this.contact(call);
    if (!call || !c || call.dir !== 'rcv') return;
    const offer: CallOffer = {
      callType: { media: call.media, capabilities: { encryption } },
      rtcSession,
      ...(encryption && call.keyPair && call.aesKey ? { callDhPubKey: encCallKey(call.keyPair.pub) } : {}),
      callVersion: call.version,
    };
    await this.send(c, xCallOffer(call.callId, offer, newSharedMsgId()));
    await this.item(c, call, `incoming ${call.peerMedia ?? call.media} call: connecting…`);
  }

  async sendAnswer(rtcSession: WebRTCSession): Promise<void> {
    const call = this.active;
    const c = call && this.contact(call);
    if (!call || !c) return;
    await this.send(c, xCallAnswer(call.callId, rtcSession, newSharedMsgId()));
  }

  async sendExtra(iceCandidates: string, rtcSession?: string): Promise<void> {
    const call = this.active;
    const c = call && this.contact(call);
    if (!call || !c || call.status === 'ended') return;
    await this.send(c, xCallExtra(call.callId, { rtcIceCandidates: iceCandidates, ...(rtcSession ? { rtcSession } : {}) }, newSharedMsgId())).catch(() => {});
  }

  /** the page connected the call */
  async connected(): Promise<void> {
    const call = this.active;
    const c = call && this.contact(call);
    if (!call || !c || call.status === 'connected' || call.status === 'ended') return;
    call.status = 'connected';
    call.connectedAt = Date.now();
    await this.item(c, call, `${call.dir === 'snd' ? 'outgoing' : 'incoming'} ${call.media} call: connected`);
    this.changed();
  }

  /**
   * ends the call, and tells the contact unless the contact ended it, or we did not answer it (a
   * rejected call is not answered at all, as in the apps)
   */
  async end(reason?: string): Promise<void> {
    const call = this.active;
    if (!call || call.status === 'ended') return;
    clearTimeout(this.ringTimer);
    call.status = 'ended';
    call.endReason = reason;
    const c = this.contact(call);
    if (c) {
      const notify = reason !== 'rejected' && reason !== 'missed' && reason !== 'ended by the contact' && c.status === 'active';
      if (notify) await this.send(c, xCallEnd(call.callId, newSharedMsgId())).catch(() => {});
      await this.item(c, call, this.endText(call, reason));
    }
    this.onSignal({ type: 'ended', call });
    this.changed();
  }

  private endText(call: ActiveCall, reason?: string): string {
    const kind = `${call.media} call`;
    const which = `${call.dir === 'snd' ? 'outgoing' : 'incoming'} ${kind}`;
    if (call.connectedAt) return `${which}: ${fmtDuration(Date.now() - call.connectedAt)}`;
    if (reason === 'missed') return `missed ${kind}`;
    if (reason === 'rejected') return `rejected ${kind}`;
    return `${which}: ${reason ?? (call.dir === 'snd' ? 'cancelled' : 'ended')}`;
  }

  /** the call screen is closed */
  dismiss(): void {
    if (this.active?.status === 'ended') {
      this.active = undefined;
      this.changed();
    }
  }

  // ---- messages from the contact

  async onMessage(c: Contact, m: ChatMessage): Promise<void> {
    const callId = typeof m.params.callId === 'string' ? m.params.callId : undefined;
    if (!callId) return;
    if (m.event === 'x.call.inv') return this.onInvitation(c, callId, m.params.invitation as CallInvitation | undefined);
    const call = this.active;
    if (!call || call.contactId !== c.id || call.callId !== callId || call.status === 'ended') return;
    switch (m.event) {
      case 'x.call.offer': {
        const offer = m.params.offer as CallOffer | undefined;
        if (call.dir !== 'snd' || call.status !== 'calling' || !offer?.rtcSession) return;
        const v = typeof offer.callVersion === 'number' ? offer.callVersion : 1;
        if (v < 1 || v > 2) return console.warn('x.call.offer: unsupported call version');
        call.version = v;
        call.peerMedia = offer.callType?.media;
        const peerKey = decCallKey(offer.callDhPubKey);
        call.aesKey = peerKey && call.keyPair ? callMediaKey(v, call.callId, peerKey, call.keyPair) : undefined;
        call.offer = offer.rtcSession;
        call.status = 'connecting';
        clearTimeout(this.ringTimer);
        await this.item(c, call, `outgoing ${call.media} call: connecting…`);
        this.changed();
        this.onSignal({ type: 'offer', call, offer: offer.rtcSession });
        return;
      }
      case 'x.call.answer': {
        const s = m.params.answer?.rtcSession as WebRTCSession | undefined;
        if (call.dir === 'rcv' && s) this.onSignal({ type: 'answer', call, answer: s });
        return;
      }
      case 'x.call.extra': {
        const x = m.params.extra?.rtcExtraInfo;
        if (x && typeof x.rtcIceCandidates === 'string') this.onSignal({ type: 'extra', call, iceCandidates: x.rtcIceCandidates, rtcSession: typeof x.rtcSession === 'string' ? x.rtcSession : undefined });
        return;
      }
      case 'x.call.end':
        // this runs while the connection is locked: nothing is sent to it from here
        await this.end('ended by the contact').catch(() => {});
        return;
    }
  }

  private async onInvitation(c: Contact, callId: string, inv: CallInvitation | undefined): Promise<void> {
    const media = inv?.callType?.media;
    if (media !== 'audio' && media !== 'video') return;
    if (c.profile.preferences?.calls?.allow === 'no') return;
    const v = callVersion(inv?.callVRange);
    if (!v) return console.warn('x.call.inv: incompatible call version');
    if (this.active && this.active.status !== 'ended') {
      // busy: the contact's call times out, as with the apps
      await this.chat.addEvent(c.id, `missed ${media} call (you were in another call)`);
      return;
    }
    const peerKey = inv?.callType?.capabilities?.encryption ? decCallKey(inv.callDhPubKey) : undefined;
    const encryption = this.chat.callEncryption();
    const keyPair = peerKey && encryption ? callKeyPair() : undefined;
    const call: ActiveCall = {
      contactId: c.id,
      callId,
      dir: 'rcv',
      media,
      peerMedia: media,
      status: 'ringing',
      version: v,
      keyPair,
      aesKey: peerKey && keyPair ? callMediaKey(v, callId, peerKey, keyPair) : undefined,
      encryption,
      itemId: localId(),
    };
    this.active = call;
    await this.item(c, call, `incoming ${media} call`);
    this.ring();
    this.changed();
    this.chat.notifyCall(`${profileName(c.profile)} is calling`);
  }
}
