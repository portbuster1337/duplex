// Group messages of the SimpleX Chat protocol (Simplex.Chat.Protocol, Types): invitations, joining
// via group links, member introductions, roles, leaving, and forwarding between members that are not
// connected yet. Groups are peer-to-peer: each member has a connection with each other member.
import { b64, b64url, fromB64, randomBytes, utf8 } from '../util/bytes';
import { strVR, type VersionRange } from '../util/version';
import { CHAT_VERSIONS, type ChatMessage, type MsgContent, type Profile } from './protocol';

/** in the order of the official clients: an unknown role is the lowest */
export const ROLES = ['relay', 'observer', 'author', 'member', 'moderator', 'admin', 'owner'] as const;
export type GroupMemberRole = (typeof ROLES)[number] | (string & {});

export function roleRank(r: GroupMemberRole | undefined): number {
  return ROLES.indexOf(r as (typeof ROLES)[number]);
}

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

/** the preferences of new groups in the apps (defaultGroupPrefs), with history on */
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
export const xGrpMemNew = (mi: MemberInfo, msgId?: string) => ev('x.grp.mem.new', { memberInfo: mi }, msgId);
export const xGrpMemIntro = (mi: MemberInfo, msgId?: string) => ev('x.grp.mem.intro', { memberInfo: mi }, msgId);
export const xGrpMemInv = (memberId: string, groupConnReq: string, msgId?: string) => ev('x.grp.mem.inv', { memberId, memberIntro: { groupConnReq } }, msgId);
export const xGrpMemFwd = (mi: MemberInfo, groupConnReq: string, msgId?: string) => ev('x.grp.mem.fwd', { memberInfo: mi, memberIntro: { groupConnReq } }, msgId);
export const xGrpMemInfo = (memberId: string, profile: Profile) => ev('x.grp.mem.info', { memberId, profile });
export const xGrpMemRole = (memberId: string, role: GroupMemberRole, msgId?: string) => ev('x.grp.mem.role', { memberId, role }, msgId);
export const xGrpMemCon = (memberId: string, msgId?: string) => ev('x.grp.mem.con', { memberId }, msgId);
export const xGrpMemDel = (memberId: string, msgId?: string, messages = false) => ev('x.grp.mem.del', { memberId, ...(messages ? { messages: true } : {}) }, msgId);
export const xGrpLeave = (msgId?: string) => ev('x.grp.leave', {}, msgId);
export const xGrpDel = (msgId?: string) => ev('x.grp.del', {}, msgId);
export const xGrpInfo = (groupProfile: GroupProfile, msgId?: string) => ev('x.grp.info', { groupProfile }, msgId);
export const xGrpPrefs = (groupPreferences: GroupPreferences, msgId?: string) => ev('x.grp.prefs', { groupPreferences }, msgId);

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
