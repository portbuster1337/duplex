// Group messages of the SimpleX Chat protocol (Simplex.Chat.Protocol, Types): invitations, joining
// via group links, member introductions, roles, leaving, and forwarding between members that are not
// connected yet. Groups are peer-to-peer: each member has a connection with each other member.
import { b64, b64url, fromB64, randomBytes, utf8 } from '../util/bytes';
import { Decoder, Encoder, ParseError } from '../util/encoding';
import { strVR, type VersionRange } from '../util/version';
import { zstdCompress } from '../util/zstd';
import { decodePubKeyOf, encodePubKey, sha512 } from '../crypto/crypto';
import { CHAT_VERSIONS, type ChatMessage, type MsgContent, type Profile } from './protocol';

/** in the order of the official clients: an unknown role is the lowest */
export const ROLES = ['relay', 'observer', 'author', 'member', 'moderator', 'admin', 'owner'] as const;
export type GroupMemberRole = (typeof ROLES)[number] | (string & {});

export function roleRank(r: GroupMemberRole | undefined): number {
  return ROLES.indexOf(r as (typeof ROLES)[number]);
}

/**
 * the lowest role that may change a role (roleRequiredToChange of the apps): moderators between
 * observer, author and member; otherwise admins, and no lower than either role
 */
export function roleToChange(from: GroupMemberRole, to: GroupMemberRole): GroupMemberRole {
  if (roleRank(from) <= roleRank('member') && roleRank(to) <= roleRank('member')) return 'moderator';
  return [from, to].reduce((a, r) => (roleRank(r) > roleRank(a) ? r : a), 'admin' as GroupMemberRole);
}

// ---- the roster of a channel: the members, moderators and admins, signed by an owner (owners are in the channel link)

/** the roles in a roster (isRosterRole) */
export const isRosterRole = (r: GroupMemberRole | undefined): boolean => r === 'member' || r === 'moderator' || r === 'admin';
/** at most this many members, and this many bytes (maxGroupRosterSize, maxGroupRosterBytes) */
export const MAX_ROSTER_SIZE = 256;
export const MAX_ROSTER_BYTES = MAX_ROSTER_SIZE * 128;
/** a roster is sent in chunks of this size, the last one shorter (fileChunkSize of the apps) */
export const ROSTER_CHUNK_SIZE = 15780;
/**
 * the largest roster that is sent: one chunk, in one message (a chunk of ROSTER_CHUNK_SIZE does not fit
 * in a message of the agent with its header, so neither does a roster in several): about 200 members
 */
export const MAX_SENT_ROSTER_BYTES = 15775;

export interface RosterEntry {
  memberId: string;
  /** the member key: Ed25519, raw, base64url */
  key: string;
  role: GroupMemberRole;
}

/** the roster blob (encodeRosterBlob): a 2-byte count, then the member ID, key, role and privileges (0) of each */
export function encodeRoster(entries: RosterEntry[]): Bytes {
  const e = new Encoder().word16(entries.length);
  for (const r of entries) e.bytes(fromB64(r.memberId)).bytes(encodePubKey({ alg: 'ed25519', key: fromB64(r.key) })).text(r.role).word16(0);
  return e.finish();
}

export function parseRoster(b: Bytes): RosterEntry[] {
  const d = new Decoder(b);
  const n = d.word16();
  if (n > MAX_ROSTER_SIZE) throw new ParseError('roster: too many entries');
  const entries: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    const memberId = b64url(d.bytes());
    const key = b64url(decodePubKeyOf(d.bytes(), 'ed25519').key);
    const role = d.text();
    d.word16();
    entries.push({ memberId, key, role });
  }
  d.end();
  return entries;
}

/** the roster roles only, each member once (validateGroupRoster) */
export function validRoster(entries: RosterEntry[]): RosterEntry[] {
  const seen = new Set<string>();
  return entries.filter((r) => isRosterRole(r.role) && !seen.has(r.memberId) && !!seen.add(r.memberId));
}

/** what the owner signs about the roster blob that follows (InlineFileInvitation): its size and SHA-512 */
export const rosterFileInv = (blob: Bytes): { fileSize: number; fileDigest: string } => ({ fileSize: blob.length, fileDigest: b64url(sha512(blob)) });

export const xGrpRoster = (version: number, blob: Bytes, msgId: string): ChatMessage => ev('x.grp.roster', { version, fileInv: rosterFileInv(blob) }, msgId);
export const xGrpRosterRequest = (version?: number): ChatMessage => ev('x.grp.roster.request', version !== undefined ? { version } : {});

export interface MemberIdRole {
  memberId: string;
  memberRole: GroupMemberRole;
}

export interface MemberInfo {
  memberId: string;
  memberRole: GroupMemberRole;
  /** the member's chat version range, e.g. "1-16" */
  v?: string;
  profile: Profile;
  memberKey?: string;
}

export type FeatureEnabled = 'on' | 'off';

export interface GroupPreferences {
  timedMessages?: { enable: FeatureEnabled; ttl?: number };
  directMessages?: { enable: FeatureEnabled; role?: GroupMemberRole };
  fullDelete?: { enable: FeatureEnabled; role?: GroupMemberRole };
  reactions?: { enable: FeatureEnabled };
  voice?: { enable: FeatureEnabled; role?: GroupMemberRole };
  files?: { enable: FeatureEnabled; role?: GroupMemberRole };
  simplexLinks?: { enable: FeatureEnabled; role?: GroupMemberRole };
  history?: { enable: FeatureEnabled };
  [k: string]: unknown;
}

export interface GroupProfile {
  displayName: string;
  fullName: string;
  shortDescr?: string;
  /** the welcome message */
  description?: string;
  image?: string;
  groupPreferences?: GroupPreferences;
  /** channels (relay-mediated groups) have this */
  publicGroup?: unknown;
  /** review: 'all' — members who join via the group link wait until a moderator accepts them */
  memberAdmission?: { review?: string };
  [k: string]: unknown;
}

export interface GroupInvitation {
  fromMember: MemberIdRole;
  fromMemberKey?: string;
  invitedMember: MemberIdRole;
  /** the full link of a 1-time invitation for the member connection */
  connRequest: string;
  groupProfile: GroupProfile;
  business?: unknown;
  groupLinkId?: string;
  groupSize?: number;
}

export type GroupAcceptance = 'accepted' | 'pending' | 'pending_review';

export interface GroupLinkInvitation {
  fromMember: MemberIdRole;
  fromMemberName: string;
  fromMemberKey?: string;
  invitedMember: MemberIdRole;
  groupProfile: GroupProfile;
  accepted?: GroupAcceptance;
  business?: unknown;
  groupSize?: number;
}

/** the preferences of groups when not set (defaultGroupPrefs of the apps) */
export const DEFAULT_GROUP_PREFERENCES: GroupPreferences = {
  timedMessages: { enable: 'off', ttl: 86400 },
  directMessages: { enable: 'off' },
  fullDelete: { enable: 'off' },
  reactions: { enable: 'on' },
  voice: { enable: 'on' },
  files: { enable: 'on' },
  simplexLinks: { enable: 'on' },
  history: { enable: 'off' },
};

/** member IDs: like the official clients, the base64 text of 12 random bytes (MemberId), base64url in JSON */
export function newMemberId(): string {
  return b64url(utf8(b64(randomBytes(12))));
}

/** member IDs are compared in one form: base64url with padding */
export function normMemberId(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  try {
    return b64url(fromB64(id));
  } catch {
    return undefined;
  }
}

/** the group link ID in the link's client data (CRDataGroup): 16 random bytes */
export function newGroupLinkId(): string {
  return b64url(randomBytes(16));
}

export const groupLinkClientData = (groupLinkId: string): string => JSON.stringify({ groupLinkId });

export function groupLinkIdOf(clientData: string | undefined): string | undefined {
  if (!clientData) return undefined;
  try {
    const d = JSON.parse(clientData);
    return d && typeof d.groupLinkId === 'string' ? d.groupLinkId : undefined;
  } catch {
    return undefined;
  }
}

export const groupShortLinkData = (groupProfile: GroupProfile): Bytes => utf8(JSON.stringify({ groupProfile }));

/** the user data of a channel link (GroupShortLinkData): the profile, and the number of subscribers; compressed when large */
export function channelShortLinkData(groupProfile: GroupProfile, publicMemberCount: number): Bytes {
  const json = utf8(JSON.stringify({ groupProfile, publicGroupData: { publicMemberCount } }));
  return json.length <= 2000 ? json : new Uint8Array([0x58, ...zstdCompress(json)]);
}
type Bytes = Uint8Array;

export const strChatVR = (vr: VersionRange = CHAT_VERSIONS): string => strVR(vr);

export const memberInfo = (memberId: string, memberRole: GroupMemberRole, profile: Profile, v?: VersionRange): MemberInfo => ({
  memberId,
  memberRole,
  ...(v ? { v: strVR(v) } : {}),
  profile,
});

// ---- events

const ev = (event: string, params: Record<string, unknown>, msgId?: string): ChatMessage => ({ ...(msgId ? { msgId } : {}), event, params });

export const xGrpInv = (groupInvitation: GroupInvitation, msgId?: string) => ev('x.grp.inv', { groupInvitation }, msgId);
export const xGrpAcpt = (memberId: string, profile?: Profile) => ev('x.grp.acpt', { memberId, ...(profile ? { profile } : {}) });
export const xGrpLinkInv = (groupLinkInvitation: GroupLinkInvitation) => ev('x.grp.link.inv', { groupLinkInvitation });
export const xGrpLinkMem = (profile: Profile, msgId?: string) => ev('x.grp.link.mem', { profile }, msgId);
export const xGrpMemNew = (mi: MemberInfo, msgId?: string, scope?: MsgScope) => ev('x.grp.mem.new', { memberInfo: mi, ...(scope ? { scope } : {}) }, msgId);
export const xGrpMemIntro = (mi: MemberInfo, msgId?: string) => ev('x.grp.mem.intro', { memberInfo: mi }, msgId);
export const xGrpMemInv = (memberId: string, groupConnReq: string, msgId?: string) => ev('x.grp.mem.inv', { memberId, memberIntro: { groupConnReq } }, msgId);
export const xGrpMemFwd = (mi: MemberInfo, groupConnReq: string, msgId?: string) => ev('x.grp.mem.fwd', { memberInfo: mi, memberIntro: { groupConnReq } }, msgId);
export const xGrpMemInfo = (memberId: string, profile: Profile) => ev('x.grp.mem.info', { memberId, profile });
/** in channels, the owners send the member's key with roster roles, and the roster version the change makes */
export const xGrpMemRole = (memberId: string, role: GroupMemberRole, msgId?: string, roster?: { memberKey?: string; rosterVersion?: number }) =>
  ev('x.grp.mem.role', { memberId, role, ...(roster?.memberKey ? { memberKey: roster.memberKey } : {}), ...(roster?.rosterVersion !== undefined ? { rosterVersion: roster.rosterVersion } : {}) }, msgId);
export const xGrpMemCon = (memberId: string, msgId?: string) => ev('x.grp.mem.con', { memberId }, msgId);
export const xGrpMemDel = (memberId: string, msgId?: string, messages = false, rosterVersion?: number) =>
  ev('x.grp.mem.del', { memberId, ...(messages ? { messages: true } : {}), ...(rosterVersion !== undefined ? { rosterVersion } : {}) }, msgId);
export const xGrpMemRestrict = (memberId: string, blocked: boolean, msgId?: string) => ev('x.grp.mem.restrict', { memberId, memberRestrictions: { restriction: blocked ? 'blocked' : 'unrestricted' } }, msgId);
export const xGrpLeave = (msgId?: string) => ev('x.grp.leave', {}, msgId);
export const xGrpDel = (msgId?: string) => ev('x.grp.del', {}, msgId);
export const xGrpInfo = (groupProfile: GroupProfile, msgId?: string) => ev('x.grp.info', { groupProfile }, msgId);
export const xGrpPrefs = (groupPreferences: GroupPreferences, msgId?: string) => ev('x.grp.prefs', { groupPreferences }, msgId);
/** a member who joined via a link is accepted, or is to wait for the review of a moderator */
export const xGrpLinkAcpt = (acceptance: GroupAcceptance, role: GroupMemberRole, memberId: string, msgId?: string) => ev('x.grp.link.acpt', { acceptance, role, memberId }, msgId);

/**
 * the chat of a member with the moderators of a group (the member support scope of the apps): admins
 * use any member's ID, members their own
 */
export interface MsgScope {
  type: 'member';
  memberId: string;
}

export const memberScope = (memberId: string): MsgScope => ({ type: 'member', memberId });

/** the member whose chat with the moderators a message is in */
export function scopeMemberId(params: Record<string, unknown> | undefined): string | undefined {
  const s = params?.scope as Partial<MsgScope> | undefined;
  return s && typeof s === 'object' && s.type === 'member' ? normMemberId(s.memberId) : undefined;
}

/** the apps' messages for members of versions before knocking (groupKnockingVersion) */
export const GROUP_KNOCKING_VERSION = 15;
export const PENDING_REVIEW_MESSAGE = 'Please wait for group moderators to review your request to join the group.';
export const ACCEPTED_TO_GROUP_MESSAGE = 'You are accepted to the group.';

/** a message of another member, forwarded by an admin to members that are not connected to it yet */
export function xGrpMsgForward(memberId: string, memberName: string, brokerTs: number, msg: ChatMessage): ChatMessage {
  const inner: Record<string, unknown> = { v: strVR(msg.v ?? CHAT_VERSIONS), ...(msg.msgId ? { msgId: msg.msgId } : {}), event: msg.event, params: msg.params };
  return ev('x.grp.msg.forward', { memberId, memberName, msgTs: new Date(brokerTs).toISOString(), msg: inner });
}

/** the events that admins forward (isForwardedGroupMsg) */
export function isForwardedGroupMsg(m: ChatMessage): boolean {
  switch (m.event) {
    case 'x.msg.new':
      return !(m.params?.file && typeof m.params.file === 'object' && m.params.file.fileInline);
    case 'x.msg.file.descr':
    case 'x.msg.update':
    case 'x.msg.del':
    case 'x.msg.react':
    case 'x.file.cancel':
    case 'x.info':
    case 'x.grp.mem.new':
    case 'x.grp.mem.role':
    case 'x.grp.mem.restrict':
    case 'x.grp.mem.del':
    case 'x.grp.leave':
    case 'x.grp.del':
    case 'x.grp.info':
    case 'x.grp.prefs':
      return true;
    default:
      return false;
  }
}

/** a member name as forwarded (memberShortenedName): at most 16 characters */
export function fwdMemberName(name: string): string {
  const chars = [...name];
  return chars.length <= 16 ? name : chars.slice(0, 16).join('') + '…';
}

export function groupPrefOn(p: GroupProfile | undefined, f: 'timedMessages' | 'directMessages' | 'fullDelete' | 'reactions' | 'voice' | 'files' | 'simplexLinks' | 'history'): boolean {
  const v = p?.groupPreferences?.[f] as { enable?: string } | undefined;
  const def = DEFAULT_GROUP_PREFERENCES[f] as { enable: string };
  return (v?.enable ?? def.enable) === 'on';
}

export function contentAllowedInGroup(p: GroupProfile | undefined, c: MsgContent): string | undefined {
  if ((c.type === 'file' || c.type === 'image' || c.type === 'video') && !groupPrefOn(p, 'files')) return 'files and media are not allowed in this group';
  if (c.type === 'voice' && !groupPrefOn(p, 'voice')) return 'voice messages are not allowed in this group';
  return undefined;
}
