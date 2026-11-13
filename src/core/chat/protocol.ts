// SimpleX Chat protocol messages (Simplex.Chat.Protocol): JSON events like x.info and x.msg.new,
// batches ('[...]'), compressed batches ('X'), and the element prefixes used by newer clients.
import { decompress } from 'fzstd';
import { b64, b64url, b64urlNoPad, fromB64, fromUtf8, fromUtf8Lossy, randomBytes, utf8, type Bytes } from '../util/bytes';
import { Decoder, ParseError } from '../util/encoding';
import { parseVR, strVR, type VersionRange } from '../util/version';

/**
 * Chat protocol versions this client supports. Advertising v16 (short link data) keeps peers from
 * using newer features (signed group messages, rosters, binary batches) that are not implemented.
 */
export const CHAT_VERSIONS: VersionRange = { min: 1, max: 16 };

export const MAX_ENCODED_MSG_LENGTH = 15602;
export const MAX_CONN_INFO_LENGTH = 14574;
export const MAX_DECOMPRESSED_LENGTH = 65536;

export interface Preferences {
  timedMessages?: { allow: 'always' | 'yes' | 'no'; ttl?: number };
  fullDelete?: { allow: 'always' | 'yes' | 'no' };
  reactions?: { allow: 'always' | 'yes' | 'no' };
  voice?: { allow: 'always' | 'yes' | 'no' };
  files?: { allow: 'always' | 'yes' | 'no' };
  calls?: { allow: 'always' | 'yes' | 'no' };
  [k: string]: unknown;
}

export interface Profile {
  displayName: string;
  fullName: string;
  shortDescr?: string;
  image?: string;
  contactLink?: string;
  preferences?: Preferences;
  peerType?: string;
  [k: string]: unknown;
}

export type MsgContent =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; preview: { uri: string; title: string; description: string; image: string } }
  | { type: 'image'; text: string; image: string }
  | { type: 'video'; text: string; image: string; duration: number }
  | { type: 'voice'; text: string; duration: number }
  | { type: 'file'; text: string }
  | { type: string; text?: string; [k: string]: unknown };

export interface MsgRef {
  msgId?: string;
  sentAt: string;
  sent: boolean;
  memberId?: string;
}

export interface FileInvitation {
  fileName: string;
  fileSize: number;
  fileDigest?: string;
  fileConnReq?: string;
  fileInline?: string;
  fileDescr?: { fileDescrText: string; fileDescrPartNo: number; fileDescrComplete: boolean };
}

export interface MsgContainer {
  content: MsgContent;
  file?: FileInvitation;
  ttl?: number;
  live?: boolean;
  quote?: { msgRef: MsgRef; content: MsgContent };
  forward?: boolean;
  mentions?: Record<string, { memberId: string }>;
  [k: string]: unknown;
}

export interface ChatMessage {
  v?: VersionRange;
  msgId?: string;
  event: string;
  params: Record<string, any>;
}

/** like the official clients: base64 text of 12 random bytes, itself encoded as base64url */
export function newSharedMsgId(): string {
  return b64url(utf8(b64(randomBytes(12))));
}

export function encodeChatMessage(m: ChatMessage): Bytes {
  const o: Record<string, unknown> = {};
  o.v = strVR(m.v ?? CHAT_VERSIONS);
  if (m.msgId) o.msgId = m.msgId;
  o.event = m.event;
  o.params = m.params;
  return utf8(JSON.stringify(o));
}

function toChatMessage(v: unknown): ChatMessage {
  if (!v || typeof v !== 'object') throw new ParseError('chat message is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.event !== 'string') throw new ParseError('chat message without event');
  const params = (o.params && typeof o.params === 'object' ? o.params : {}) as Record<string, any>;
  let vr: VersionRange | undefined;
  if (typeof o.v === 'string') {
    try {
      vr = parseVR(o.v);
    } catch {
      vr = undefined;
    }
  }
  return { v: vr, msgId: typeof o.msgId === 'string' ? o.msgId : undefined, event: o.event, params };
}

export interface ParsedChatMsg {
  msg?: ChatMessage;
  error?: string;
  /** the element was signed by a group member (signatures are not verified by this client) */
  signed?: boolean;
  /** forwarded by a group member or channel relay */
  forward?: { memberId?: string; memberName?: string; brokerTs: string };
}

function parseJsonElement(b: Bytes): ParsedChatMsg {
  try {
    return { msg: toChatMessage(JSON.parse(fromUtf8(b))) };
  } catch (e) {
    return { error: `bad chat message: ${(e as Error).message}` };
  }
}

function parseElement(b: Bytes, fwd?: ParsedChatMsg['forward']): ParsedChatMsg {
  if (!b.length) return { error: 'empty element' };
  const c = String.fromCharCode(b[0]);
  if (c === '{') return { ...parseJsonElement(b), forward: fwd };
  if (c === '/') {
    // '/' chatBinding signatures body: signed by a group member
    try {
      const d = new Decoder(b.subarray(1));
      d.char();
      d.list((d) => {
        d.char();
        d.bytes();
      });
      return { ...parseJsonElement(d.rest()), signed: true, forward: fwd };
    } catch (e) {
      return { error: `bad signed element: ${(e as Error).message}` };
    }
  }
  if (c === '>') {
    if (fwd) return { error: 'nested forward elements' };
    try {
      const d = new Decoder(b.subarray(1));
      const f = parseFwd(d);
      return parseElement(d.rest(), f);
    } catch (e) {
      return { error: `bad forward element: ${(e as Error).message}` };
    }
  }
  return { error: `unsupported element prefix ${c}` };
}

function parseFwd(d: Decoder): ParsedChatMsg['forward'] {
  // GrpMsgForward: fwdSender ('M' memberId memberName | 'C') + brokerTs (text)
  const t = d.char();
  let memberId: string | undefined;
  let memberName: string | undefined;
  if (t === 'M') {
    memberId = b64urlNoPad(d.bytes());
    memberName = fromUtf8Lossy(d.bytes());
  } else if (t !== 'C') throw new ParseError('bad forward sender');
  const brokerTs = fromUtf8Lossy(d.bytes());
  return { memberId, memberName, brokerTs };
}

function parseUncompressed(b: Bytes): ParsedChatMsg[] {
  if (!b.length) return [{ error: 'empty message' }];
  const c = String.fromCharCode(b[0]);
  if (c === '[') {
    try {
      const arr = JSON.parse(fromUtf8(b));
      if (!Array.isArray(arr)) return [{ error: 'bad batch' }];
      return arr.map((v) => {
        try {
          return { msg: toChatMessage(v) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      });
    } catch (e) {
      return [{ error: `bad batch: ${(e as Error).message}` }];
    }
  }
  if (c === '=') {
    try {
      const d = new Decoder(b.subarray(1));
      return d.list((d) => d.large()).map((e) => parseElement(e));
    } catch (e) {
      return [{ error: `bad binary batch: ${(e as Error).message}` }];
    }
  }
  return [parseElement(b)];
}

/** the content size in a zstd frame header (RFC 8878, 3.1.1.1), undefined when it is not declared */
export function zstdContentSize(b: Bytes): number | undefined {
  if (b.length < 6 || b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) return undefined;
  const fhd = b[4];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const dictIdLen = [0, 1, 2, 4][fhd & 3];
  const fcsLen = fcsFlag === 0 ? singleSegment : 1 << fcsFlag;
  if (fcsLen === 0) return undefined;
  const off = 5 + (singleSegment ? 0 : 1) + dictIdLen;
  if (b.length < off + fcsLen) return undefined;
  let v = 0;
  for (let i = fcsLen - 1; i >= 0; i--) v = v * 256 + b[off + i];
  return fcsLen === 2 ? v + 256 : v;
}

/** parses an agent message body into chat messages */
export function parseChatMessages(b: Bytes): ParsedChatMsg[] {
  if (!b.length) return [{ error: 'empty message' }];
  if (b[0] !== 0x58) return limit(parseUncompressed(b));
  try {
    const d = new Decoder(b.subarray(1));
    const parts = d.nonEmpty((d) => {
      const t = d.char();
      if (t === '0') return { plain: d.bytes() as Bytes | undefined, zstd: undefined as Bytes | undefined };
      if (t === '1') return { plain: undefined as Bytes | undefined, zstd: d.large() as Bytes | undefined };
      throw new ParseError('bad Compressed tag');
    });
    // like the official clients, the sizes are checked before decompressing
    const sizes = parts.map((p) => (p.plain ? p.plain.length : zstdContentSize(p.zstd!)));
    if (sizes.some((s) => s === undefined)) return [{ error: 'compressed size not specified' }];
    if ((sizes as number[]).reduce((a, b) => a + b, 0) > MAX_DECOMPRESSED_LENGTH) return [{ error: 'decompressed size exceeds limit' }];
    const out: ParsedChatMsg[] = [];
    parts.forEach((p, i) => {
      // the output buffer has the declared size, which bounds the memory a peer can make us use
      const raw = p.plain ?? decompress(p.zstd!, new Uint8Array(sizes[i]!));
      out.push(...parseUncompressed(raw));
    });
    return limit(out);
  } catch (e) {
    return [{ error: `bad compressed message: ${(e as Error).message}` }];
  }
}

function limit(ms: ParsedChatMsg[]): ParsedChatMsg[] {
  return ms.length > 255 ? [{ error: 'too many messages in batch' }] : ms;
}

// ---- event constructors

export const xInfo = (profile: Profile): ChatMessage => ({ event: 'x.info', params: { profile } });

export const xContact = (profile: Profile, contactReqId?: string, msg?: { msgId: string; content: MsgContent }): ChatMessage => ({
  event: 'x.contact',
  params: { profile, ...(contactReqId ? { contactReqId } : {}), ...(msg ? { msgId: msg.msgId, content: msg.content } : {}) },
});

export const xMsgNew = (msgId: string, mc: MsgContainer): ChatMessage => ({ msgId, event: 'x.msg.new', params: mc });

export const xMsgUpdate = (msgId: string, refMsgId: string, content: MsgContent): ChatMessage => ({ msgId, event: 'x.msg.update', params: { msgId: refMsgId, content } });

export const xMsgDel = (msgId: string, refMsgId: string): ChatMessage => ({ msgId, event: 'x.msg.del', params: { msgId: refMsgId } });

export const xMsgReact = (msgId: string, refMsgId: string, emoji: string, add: boolean): ChatMessage => ({
  msgId,
  event: 'x.msg.react',
  params: { msgId: refMsgId, reaction: { type: 'emoji', emoji }, add },
});

export const xDirectDel = (msgId: string): ChatMessage => ({ msgId, event: 'x.direct.del', params: {} });

/** a part of the description of a file sent with the message refMsgId */
export const xMsgFileDescr = (msgId: string, refMsgId: string, fileDescr: { fileDescrText: string; fileDescrPartNo: number; fileDescrComplete: boolean }, fileExpires?: string): ChatMessage => ({
  msgId,
  event: 'x.msg.file.descr',
  params: { msgId: refMsgId, fileDescr, ...(fileExpires ? { fileExpires } : {}) },
});

/** the file of the message refMsgId was cancelled (deleted from the file servers) */
export const xFileCancel = (msgId: string, refMsgId: string): ChatMessage => ({ msgId, event: 'x.file.cancel', params: { msgId: refMsgId } });

export const xOk = (): ChatMessage => ({ event: 'x.ok', params: {} });

/** reactions allowed by the official clients */
export const REACTIONS = ['👍', '👎', '😀', '😂', '😢', '❤️', '🚀', '✅'];

export function contactShortLinkData(profile: Profile, message?: MsgContent, business = false): Bytes {
  return utf8(JSON.stringify({ profile, ...(message ? { message } : {}), business }));
}

export function parseShortLinkData(b?: Bytes): { profile?: Profile; message?: MsgContent; business?: boolean } {
  if (!b || !b.length) return {};
  try {
    const o = JSON.parse(fromUtf8Lossy(b));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export { fromB64 };
