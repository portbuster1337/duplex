// Calls of the SimpleX Chat protocol (Simplex.Chat.Call): WebRTC signalling in x.call.* messages of a
// direct connection, and the key of the end-to-end encryption of media frames.
import { b64url, fromB64, randomBytes } from '../util/bytes';
import { decodePubKeyOf, dh, encodePubKey, generateKeyPair, hkdf, type KeyPair, type PublicKey } from '../crypto/crypto';
import { parseVR, strVR, type VersionRange } from '../util/version';
import type { ChatMessage } from './protocol';

/** 1: the media key is the DH secret; 2: the key is derived with HKDF (callMediaKdfVersion) */
export const CALL_VERSIONS: VersionRange = { min: 1, max: 2 };
const CALL_KDF_VERSION = 2;

export type CallMedia = 'audio' | 'video';

export interface CallType {
  media: CallMedia;
  capabilities: { encryption: boolean };
}

/** an offer or an answer, and the ICE candidates: LZString-compressed JSON (as the call pages of the apps make them) */
export interface WebRTCSession {
  rtcSession: string;
  rtcIceCandidates: string;
}

export interface CallInvitation {
  callType: CallType;
  callDhPubKey?: string;
  callVRange?: string;
}

export interface CallOffer {
  callType: CallType;
  rtcSession: WebRTCSession;
  callDhPubKey?: string;
  callVersion?: number;
}

export interface WebRTCExtraInfo {
  /** an ICE restart offer or answer */
  rtcSession?: string;
  rtcIceCandidates: string;
}

export const newCallId = (): string => b64url(randomBytes(16));

export const callKeyPair = (): KeyPair<'x25519'> => generateKeyPair('x25519');

export const encCallKey = (k: PublicKey<'x25519'>): string => b64url(encodePubKey(k));

export function decCallKey(s: unknown): PublicKey<'x25519'> | undefined {
  if (typeof s !== 'string') return undefined;
  try {
    return decodePubKeyOf(fromB64(s), 'x25519');
  } catch {
    return undefined;
  }
}

/** the version both sides support, from the range in an invitation (none: version 1) */
export function callVersion(range: unknown): number | undefined {
  let vr: VersionRange = { min: 1, max: 1 };
  if (typeof range === 'string') {
    try {
      vr = parseVR(range);
    } catch {
      return undefined;
    }
  }
  const max = Math.min(vr.max, CALL_VERSIONS.max);
  return max >= Math.max(vr.min, CALL_VERSIONS.min) ? max : undefined;
}

/** callMediaKey: the AES-256-GCM key of the media frames, base64url (as the apps give it to their call pages) */
export function callMediaKey(version: number, callId: string, peerKey: PublicKey<'x25519'>, kp: KeyPair<'x25519'>): string {
  const secret = dh(peerKey, kp.priv);
  return b64url(version >= CALL_KDF_VERSION ? hkdf(fromB64(callId), secret, 'SimpleXCallMediaKey', 32) : secret);
}

const ev = (event: string, params: Record<string, unknown>, msgId?: string): ChatMessage => ({ ...(msgId ? { msgId } : {}), event, params });

export const xCallInv = (callId: string, invitation: CallInvitation, msgId?: string) => ev('x.call.inv', { callId, invitation }, msgId);
export const xCallOffer = (callId: string, offer: CallOffer, msgId?: string) => ev('x.call.offer', { callId, offer }, msgId);
export const xCallAnswer = (callId: string, rtcSession: WebRTCSession, msgId?: string) => ev('x.call.answer', { callId, answer: { rtcSession } }, msgId);
export const xCallExtra = (callId: string, rtcExtraInfo: WebRTCExtraInfo, msgId?: string) => ev('x.call.extra', { callId, extra: { rtcExtraInfo } }, msgId);
export const xCallEnd = (callId: string, msgId?: string) => ev('x.call.end', { callId }, msgId);

export const callVRangeStr = (): string => strVR(CALL_VERSIONS);
