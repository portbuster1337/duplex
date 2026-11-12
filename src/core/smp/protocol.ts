// SMP commands and router messages (Simplex.Messaging.Protocol), for protocol versions 15..23.
import { fromUtf8Lossy, type Bytes } from '../util/bytes';
import { Decoder, Encoder, ParseError, unPad } from '../util/encoding';
import { cbDecrypt, decPubKey, encPubKey, type PublicKey } from '../crypto/crypto';
import { decVR, type VersionRange } from '../util/version';

export const SMP_BLOCK_SIZE = 16384;
export const MAX_MESSAGE_LENGTH = 16048;
export const E2E_ENC_CONFIRMATION_LENGTH = 15904;
export const E2E_ENC_MESSAGE_LENGTH = 16000;

export const SMP_VERSIONS = { min: 15, max: 23 };
export const SERVICE_CERTS_SMP_VERSION = 16;
export const NEW_NTF_CREDS_SMP_VERSION = 17;
export const SERVER_INFO_SMP_VERSION = 21;
export const FWD_NONCES_SMP_VERSION = 23;

export type QueueMode = 'M' | 'C';

export interface QueueLinkData {
  fixedData: Bytes;
  userData: Bytes;
}

export type QueueReqData =
  | { mode: 'M'; link?: { sndId: Bytes; data: QueueLinkData } }
  | { mode: 'C'; link?: { linkId: Bytes; sndId: Bytes; data: QueueLinkData } };

export type Command =
  | { tag: 'NEW'; rcvAuthKey: PublicKey; rcvDhKey: PublicKey<'x25519'>; basicAuth?: string; subscribe: boolean; reqData?: QueueReqData }
  | { tag: 'SUB' }
  | { tag: 'KEY'; sndKey: PublicKey }
  | { tag: 'LSET'; linkId: Bytes; data: QueueLinkData }
  | { tag: 'LDEL' }
  | { tag: 'GET' }
  | { tag: 'ACK'; msgId: Bytes }
  | { tag: 'OFF' }
  | { tag: 'DEL' }
  | { tag: 'SKEY'; sndKey: PublicKey }
  | { tag: 'SEND'; notification: boolean; body: Bytes }
  | { tag: 'PING' }
  | { tag: 'LKEY'; sndKey: PublicKey }
  | { tag: 'LGET' }
  | { tag: 'PRXY'; hosts: string[]; port: string; keyHash: Bytes; basicAuth?: string }
  | { tag: 'PFWD'; version: number; pubKey: PublicKey<'x25519'>; encTransmission: Bytes };

function encLinkData(e: Encoder, d: QueueLinkData): Encoder {
  return e.large(d.fixedData).large(d.userData);
}

export function encodeCommand(v: number, c: Command): Bytes {
  const e = new Encoder();
  switch (c.tag) {
    case 'NEW': {
      e.str('NEW ');
      encPubKey(e, c.rcvAuthKey);
      encPubKey(e, c.rcvDhKey);
      e.maybe(c.basicAuth, (e, a) => e.text(a));
      e.char(c.subscribe ? 'S' : 'C');
      e.maybe(c.reqData, (e, r) => {
        e.char(r.mode);
        if (r.mode === 'M') e.maybe(r.link, (e, l) => encLinkData(e.bytes(l.sndId), l.data));
        else e.maybe(r.link, (e, l) => encLinkData(e.bytes(l.linkId).bytes(l.sndId), l.data));
      });
      if (v >= NEW_NTF_CREDS_SMP_VERSION) e.char('0');
      break;
    }
    case 'KEY':
    case 'SKEY':
    case 'LKEY':
      e.str(c.tag + ' ');
      encPubKey(e, c.sndKey);
      break;
    case 'LSET':
      encLinkData(e.str('LSET ').bytes(c.linkId), c.data);
      break;
    case 'ACK':
      e.str('ACK ').bytes(c.msgId);
      break;
    case 'SEND':
      e.str('SEND ').bool(c.notification).char(' ').raw(c.body);
      break;
    case 'PRXY':
      e.str('PRXY ')
        .list(c.hosts, (e, h) => e.text(h))
        .text(c.port)
        .bytes(c.keyHash)
        .maybe(c.basicAuth, (e, a) => e.text(a));
      break;
    case 'PFWD':
      e.str('PFWD ').word16(c.version);
      encPubKey(e, c.pubKey);
      e.raw(c.encTransmission);
      break;
    default:
      e.str(c.tag);
  }
  return e.finish();
}

export class SMPError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(detail ? `SMP error ${code} ${detail}` : `SMP error ${code}`);
    this.name = 'SMPError';
  }
}

export type BrokerMsg =
  | { tag: 'IDS'; rcvId: Bytes; sndId: Bytes; srvDhKey: PublicKey<'x25519'>; queueMode?: QueueMode; linkId?: Bytes; serviceId?: Bytes }
  | { tag: 'LNK'; sndId: Bytes; data: QueueLinkData }
  | { tag: 'SOK'; serviceId?: Bytes }
  | { tag: 'MSG'; msgId: Bytes; body: Bytes }
  | { tag: 'NID'; notifierId: Bytes }
  | { tag: 'PKEY'; sessionId: Bytes; versions: VersionRange; certChain: Bytes[]; signedKey: Bytes }
  | { tag: 'PRES'; nonce?: Bytes; body: Bytes }
  | { tag: 'END' }
  | { tag: 'DELD' }
  | { tag: 'INFO'; info: string }
  | { tag: 'OK' }
  | { tag: 'ERR'; err: SMPError }
  | { tag: 'PONG' }
  | { tag: 'ALLS' }
  | { tag: 'OTHER'; name: string };

function decQueueMode(d: Decoder): QueueMode {
  const c = d.char();
  if (c !== 'M' && c !== 'C') throw new ParseError('bad QueueMode');
  return c;
}

export function parseError(b: Bytes): SMPError {
  const s = fromUtf8Lossy(b);
  const i = s.indexOf(' ');
  return i < 0 ? new SMPError(s) : new SMPError(s.slice(0, i), s.slice(i + 1));
}

export function parseBrokerMsg(v: number, b: Bytes): BrokerMsg {
  const d = new Decoder(b);
  const tag = d.tag();
  switch (tag) {
    case 'IDS': {
      const rcvId = d.bytes();
      const sndId = d.bytes();
      const srvDhKey = decPubKey(d, 'x25519');
      const queueMode = d.maybe(decQueueMode);
      const linkId = d.maybe((d) => d.bytes());
      const serviceId = v >= SERVICE_CERTS_SMP_VERSION ? d.maybe((d) => d.bytes()) : undefined;
      return { tag, rcvId, sndId, srvDhKey, queueMode, linkId, serviceId };
    }
    case 'LNK': {
      const sndId = d.bytes();
      const fixedData = d.large();
      const userData = d.large();
      return { tag, sndId, data: { fixedData, userData } };
    }
    case 'SOK':
      return { tag, serviceId: d.atEnd() ? undefined : d.maybe((d) => d.bytes()) };
    case 'MSG': {
      const msgId = d.bytes();
      return { tag, msgId, body: d.rest() };
    }
    case 'NID':
      return { tag, notifierId: d.bytes() };
    case 'PKEY': {
      const sessionId = d.bytes();
      const versions = decVR(d);
      const certChain = d.nonEmpty((d) => d.large());
      const signedKey = d.large();
      return { tag, sessionId, versions, certChain, signedKey };
    }
    case 'PRES': {
      const nonce = v >= FWD_NONCES_SMP_VERSION ? d.maybe((d) => d.take(24)) : undefined;
      return { tag, nonce, body: d.rest() };
    }
    case 'INFO':
      return { tag, info: fromUtf8Lossy(d.rest()) };
    case 'ERR':
      return { tag, err: parseError(d.rest()) };
    case 'END':
    case 'DELD':
    case 'OK':
    case 'PONG':
    case 'ALLS':
      return { tag };
    default:
      return { tag: 'OTHER', name: tag };
  }
}

/** The message as delivered to the recipient after removing the router's encryption layer. */
export type ClientRcvMsgBody =
  | { quota: false; ts: number; notification: boolean; body: Bytes }
  | { quota: true; ts: number };

export function decryptRcvMsg(rcvDhSecret: Bytes, msgId: Bytes, encBody: Bytes): ClientRcvMsgBody {
  const b = cbDecrypt(rcvDhSecret, msgId.subarray(0, 24), encBody);
  const d = new Decoder(b);
  if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === 'QUOTA') {
    d.take(5);
    d.space();
    return { quota: true, ts: d.int64n() };
  }
  const ts = d.int64n();
  const notification = d.bool();
  d.takeTill(' ');
  d.space();
  return { quota: false, ts, notification, body: d.rest() };
}

// ---- client message envelope (the body of SEND / MSG)

export interface ClientMsgEnvelope {
  version: number;
  e2ePubKey?: PublicKey<'x25519'>;
  nonce: Bytes;
  encBody: Bytes;
}

export function encodeClientMsgEnvelope(m: ClientMsgEnvelope): Bytes {
  const e = new Encoder().word16(m.version);
  e.maybe(m.e2ePubKey, (e, k) => encPubKey(e, k));
  return e.raw(m.nonce).raw(m.encBody).finish();
}

export function parseClientMsgEnvelope(b: Bytes): ClientMsgEnvelope {
  const d = new Decoder(b);
  const version = d.word16();
  const e2ePubKey = d.maybe((d) => decPubKey(d, 'x25519'));
  const nonce = d.take(24);
  return { version, e2ePubKey, nonce, encBody: d.rest() };
}

export type PrivHeader = { tag: 'K'; senderKey: PublicKey } | { tag: '_' };

export function encodeClientMessage(h: PrivHeader, body: Bytes): Bytes {
  const e = new Encoder();
  if (h.tag === 'K') encPubKey(e.char('K'), h.senderKey);
  else e.char('_');
  return e.raw(body).finish();
}

export function parseClientMessage(b: Bytes): { header: PrivHeader; body: Bytes } {
  const d = new Decoder(b);
  const c = d.char();
  let header: PrivHeader;
  if (c === 'K') header = { tag: 'K', senderKey: decPubKey(d, 'ed25519', 'x25519', 'ed448') };
  else if (c === '_') header = { tag: '_' };
  else throw new ParseError('invalid PrivHeader');
  return { header, body: d.rest() };
}

export { unPad };
