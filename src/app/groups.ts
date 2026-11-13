// Groups: the peer-to-peer groups of SimpleX Chat. Each member has a connection with each other
// member. An admin who adds a member introduces it to the others (x.grp.mem.intro, .inv, .fwd), and
// forwards messages between members that are not connected to each other yet (x.grp.msg.forward).
import type { AgentEvent, MsgResult, ResolvedLink } from '../core/agent/agent';
import {
  ACCEPTED_TO_GROUP_MESSAGE,
  channelShortLinkData,
  DEFAULT_GROUP_PREFERENCES,
  fwdMemberName,
  encodeRoster,
  GROUP_KNOCKING_VERSION,
  groupLinkClientData,
  groupPrefOn,
  groupShortLinkData,
  isForwardedGroupMsg,
  isRosterRole,
  MAX_ROSTER_BYTES,
  MAX_SENT_ROSTER_BYTES,
  memberInfo,
  memberScope,
  newGroupLinkId,
  newMemberId,
  normMemberId,
  parseRoster,
  PENDING_REVIEW_MESSAGE,
  roleRank,
  roleToChange,
  ROSTER_CHUNK_SIZE,
  scopeMemberId,
  validRoster,
  xGrpAcpt,
  xGrpDel,
  xGrpInfo,
  xGrpInv,
  xGrpLeave,
  xGrpLinkAcpt,
  xGrpLinkInv,
  xGrpLinkMem,
  xGrpMemCon,
  xGrpMemDel,
  xGrpMemFwd,
  xGrpMemInfo,
  xGrpMemIntro,
  xGrpMemInv,
  xGrpMemNew,
  xGrpMemRestrict,
  xGrpMemRole,
  xGrpMsgForward,
  xGrpRoster,
  xGrpRosterRequest,
  type GroupInvitation,
  type GroupLinkInvitation,
  type GroupMemberRole,
  type GroupProfile,
  type MemberInfo,
  type RosterEntry,
} from '../core/chat/groups';
import {
  CHANNEL_CHAT_VERSIONS,
  COMPRESSION_CHAT_VERSION,
  compressToLimit,
  encodeChatMessage,
  fileChunkElement,
  GROUP_ROSTER_VERSION,
  groupBinding,
  jsonBatches,
  MAX_CONN_INFO_LENGTH,
  MAX_ENCODED_MSG_LENGTH,
  newSharedMsgId,
  parseChatMessages,
  parseShortLinkData,
  signedElement,
  verifySigned,
  xContact,
  xInfo,
  xMsgFileDescr,
  xMsgNew,
  xOk,
  type ChatMessage,
  type MsgContainer,
  type ParsedChatMsg,
  type Profile,
} from '../core/chat/protocol';
import { decodePubKeyOf, encodePubKey, generateKeyPair, sha256, sha512, sign, type PublicKey } from '../core/crypto/crypto';
import { parseShortLink, strShortLink } from '../core/agent/shortlink';
import { b64, b64url, concat, fromB64, type Bytes } from '../core/util/bytes';
import { parseVR, type VersionRange } from '../core/util/version';
import { ChatError, localId, profileName } from './common';
import { FIXED_IMAGE_PREVIEW } from './files';
import type { ChatClient, ChatItem, Contact } from './chat';

/** host: the member who added us; invitee: members we added; pre/post: introduced members who joined before/after us */
export type MemberCategory = 'host' | 'invitee' | 'pre' | 'post';

export type MemberStatus =
  | 'invited'
  | 'accepted'
  /** announced by an admin (x.grp.mem.new), not connected yet */
  | 'announced'
  /** introduced to us by the host (x.grp.mem.intro) */
  | 'introduced'
  /** an invitation for the member connection was sent or received */
  | 'introInvited'
  | 'connected'
  /** known only from forwarded messages */
  | 'unknown'
  | 'left'
  | 'removed';

export interface GroupMember {
  memberId: string;
  role: GroupMemberRole;
  profile: Profile;
  category: MemberCategory;
  status: MemberStatus;
  /** the agent connection with this member */
  connId?: string;
  v?: VersionRange;
  /** the member who added or introduced this one */
  invitedBy?: string;
  /** the contact this member was invited as */
  contactId?: string;
  /** joined via our group link */
  viaLink?: boolean;
  /** joined via our group link, and the app showed the welcome message from the link already */
  welcomeMsgId?: string;
  /**
   * joined via a group link that needs a review: until a moderator accepts the member, it is
   * connected only to the moderators, and chats only with them
   */
  review?: boolean;
  /** when the member was accepted after a review */
  acceptedAt?: number;
  /** channels: the key of an owner (Ed25519, raw, base64url), from the channel link, which signs what changes the channel */
  key?: string;
  /** channels: the link of a chat relay */
  relayLink?: string;
  /** channels, as the owner: the address of a chat relay we invited */
  relayAddress?: string;
  /** channels, as the owner: the roster version a relay confirms before the channel link lists it */
  rosterPending?: number;
  blocked?: boolean;
  /** messages kept until the connection is ready (base64) */
  pending?: string[];
  createdAt: number;
}

export type GroupStatus = 'invited' | 'joining' | 'connecting' | 'pending' | 'active' | 'left' | 'removed' | 'deleted' | 'rejected';

export interface ChannelInfo {
  /** the ID of the channel (the entity ID of its link), base64url */
  publicGroupId: string;
  link: string;
  /** our member key (Ed25519, raw, base64url): what we send to the relays is signed with it */
  memberKey: { pub: string; priv: string };
  /** the number of subscribers, as the link data or a relay says */
  subscribers?: number;
  /** as the owner who made the channel: the connection of its link, whose data lists the owners and relays */
  linkConnId?: string;
  /**
   * the version of the roster (the members, moderators and admins, signed by an owner): as the owner
   * who made the channel, the current one; otherwise the newest seen, in a roster or a change
   */
  rosterVersion?: number;
  /** the newest roster version up to which no change was missed */
  rosterComplete?: number;
  /** the rosters that relays are sending, until all of each arrived (by relay) */
  rosterTransfers?: Record<string, RosterTransfer>;
}

/** a roster on its way from a relay: what the owner signed about it, and its chunks so far */
export interface RosterTransfer {
  /** the ID of the message that announced it, which its chunks name */
  ref: string;
  version: number;
  size: number;
  digest: string;
  owner: string;
  chunks: number;
  /** base64 */
  data: string;
}

export interface Group {
  id: string;
  profile: GroupProfile;
  localAlias?: string;
  /** our member ID and role */
  memberId: string;
  role: GroupMemberRole;
  status: GroupStatus;
  /** the random profile shared with this group instead of ours */
  incognito?: Profile;
  members: Record<string, GroupMember>;
  hostMemberId?: string;
  /** a received invitation, until it is accepted or rejected */
  invitation?: { contactId: string; connRequest: string; itemId?: string };
  /** as an admin: the introductions we made, by member pair, until the members are connected */
  intros?: Record<string, 'sent' | 'forwarded' | 'connected'>;
  /** as an admin: how many recent messages we send to new members (the apps send 100); 0 for all */
  historySize?: number;
  /** the chats of members with the moderators (by the member's ID; ours, as a member) */
  support?: Record<string, { unread: number; lastActivity: number }>;
  /** a channel: posts reach the subscribers through chat relays, not from member to member */
  channel?: ChannelInfo;
  link?: { connId: string; link: string; groupLinkId: string; role: GroupMemberRole };
  createdAt: number;
  lastActivity: number;
  unread: number;
  favorite?: boolean;
  muted?: boolean;
}

const DEBUG = typeof process !== 'undefined' && !!process.env?.DEBUG_GROUPS;

/** the host of a group joined via a link, until its member ID is known */
const HOST_PLACEHOLDER = '?host';
/** the number of recent messages sent to new members, unless chosen: as in the apps */
export const HISTORY_ITEMS = 100;
/** in channels, the events that are signed (requiresSignature of the apps) */
const CHANNEL_SIGNED = new Set(['x.grp.del', 'x.grp.info', 'x.grp.prefs', 'x.grp.mem.del', 'x.grp.mem.role', 'x.grp.mem.restrict', 'x.grp.leave', 'x.grp.relay.new', 'x.grp.roster', 'x.info', 'x.grp.link.mem', 'x.grp.relay.inv']);
/** the posts of channels, and what changes them */
const CHANNEL_CONTENT = new Set(['x.msg.new', 'x.msg.update', 'x.msg.del', 'x.msg.react', 'x.msg.file.descr', 'x.file.cancel']);
/** in channels, the roles that owners give: in the roster, or the link */
const privileged = (r: GroupMemberRole | undefined): boolean => isRosterRole(r) || r === 'owner';
/** a member key as the apps send it (the X.509 key, base64url), raw */
function rawMemberKey(k: unknown): string | undefined {
  try {
    return typeof k === 'string' ? b64url(decodePubKeyOf(fromB64(k), 'ed25519').key) : undefined;
  } catch {
    return undefined;
  }
}
const x509Key = (raw: string): string => b64url(encodePubKey({ alg: 'ed25519', key: fromB64(raw) }));
/** the name of a member known only by its ID (nameFromMemberId of the apps) */
const nameFromMemberId = (id: string): string => b64(fromB64(id)).slice(0, 7);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const memberGone = (m: GroupMember): boolean => m.status === 'left' || m.status === 'removed';
export const memberName = (m?: GroupMember): string => profileName(m?.profile);
export const groupName = (g?: Group): string => g?.localAlias || g?.profile.displayName?.trim() || 'group';
export const groupActive = (g: Group): boolean => g.status === 'active' || g.status === 'connecting' || g.status === 'pending';
export const isModerator = (role: GroupMemberRole | undefined): boolean => roleRank(role) >= roleRank('moderator');
/** new members who join via the group link wait for the review of a moderator */
export const reviewsMembers = (g: Group): boolean => g.profile.memberAdmission?.review === 'all';

/** the chat of a member with the moderators of a group: its ID */
export const supportChatId = (groupId: string, memberId: string): string => `${groupId}#${memberId}`;
export function parseSupportChatId(id: string): { groupId: string; memberId: string } | undefined {
  const i = id.indexOf('#');
  return i > 0 ? { groupId: id.slice(0, i), memberId: id.slice(i + 1) } : undefined;
}

function parseVRSafe(s: unknown): VersionRange | undefined {
  if (typeof s !== 'string') return undefined;
  try {
    return parseVR(s);
  } catch {
    return undefined;
  }
}

/** the profile shown to group members (redactedMemberProfile): no preferences or contact link */
function memberProfile(p: Profile): Profile {
  return { displayName: p.displayName, fullName: p.fullName ?? '', ...(p.shortDescr ? { shortDescr: p.shortDescr } : {}), ...(p.image ? { image: p.image } : {}) };
}

export class GroupManager {
  /** member connections, and group link addresses */
  private conns = new Map<string, { groupId: string; memberId: string }>();
  private links = new Map<string, string>();
  /** the sends to each connection, in order */
  private outbox = new Map<string, Promise<void>>();

  constructor(private chat: ChatClient) {}

  private get groups(): Record<string, Group> {
    return (this.chat.state.groups ??= {});
  }

  /** builds the connection indexes from the state */
  index(): void {
    this.conns.clear();
    this.links.clear();
    for (const g of Object.values(this.groups)) {
      for (const m of Object.values(g.members)) if (m.connId) this.conns.set(m.connId, { groupId: g.id, memberId: m.memberId });
      if (g.link) this.links.set(g.link.connId, g.id);
    }
  }

  list(): Group[] {
    return Object.values(this.groups);
  }

  get(id: string): Group | undefined {
    return this.groups[id];
  }

  owns(connId: string): boolean {
    return this.conns.has(connId) || this.links.has(connId);
  }

  private byConn(connId: string): { g: Group; m: GroupMember } | undefined {
    const r = this.conns.get(connId);
    const g = r && this.groups[r.groupId];
    const m = g?.members[r!.memberId];
    return g && m ? { g, m } : undefined;
  }

  private setConn(g: Group, m: GroupMember, connId: string): void {
    m.connId = connId;
    this.conns.set(connId, { groupId: g.id, memberId: m.memberId });
  }

  /** our profile in a group: the incognito one or ours, without preferences */
  ourProfile(g: Group): Profile {
    return memberProfile(g.incognito ?? this.chat.settings.profile);
  }

  /** the members, without us */
  members(g: Group): GroupMember[] {
    return Object.values(g.members).filter((m) => m.memberId !== HOST_PLACEHOLDER || g.status === 'joining');
  }

  currentMembers(g: Group): GroupMember[] {
    return this.members(g).filter((m) => !memberGone(m));
  }

  /** the members who take part in the group: not those waiting for a review */
  activeMembers(g: Group): GroupMember[] {
    return this.currentMembers(g).filter((m) => !m.review);
  }

  /** the members of the chat of a member with the moderators: that member, and the moderators */
  supportMembers(g: Group, memberId: string): GroupMember[] {
    return this.currentMembers(g).filter((m) => m.memberId === memberId || (isModerator(m.role) && !m.review));
  }

  /** the members waiting for a review */
  reviewMembers(g: Group): GroupMember[] {
    return this.currentMembers(g).filter((m) => m.review);
  }

  canSend(g: Group): string | undefined {
    if (g.channel && groupActive(g) && roleRank(g.role) < roleRank('author')) return 'only its owners and members post in this channel';
    if (g.status === 'pending') return 'the group admins have not accepted you yet';
    if (g.status !== 'active' && g.status !== 'connecting') return g.status === 'invited' ? 'join the group first' : 'you are not a member of this group';
    if (roleRank(g.role) < roleRank('author')) return 'observers cannot send messages';
    return undefined;
  }

  /** a member chats with the moderators also while waiting to be accepted; moderators chat with any member */
  canSendSupport(g: Group, memberId: string): string | undefined {
    if (!groupActive(g)) return 'you are not a member of this group';
    if (memberId === g.memberId) return isModerator(g.role) ? 'this chat is for members' : undefined;
    if (g.status !== 'active' || !isModerator(g.role)) return 'only moderators chat with members';
    const m = g.members[memberId];
    return !m || memberGone(m) ? 'the member left the group' : undefined;
  }

  private infoOf(m: GroupMember): MemberInfo {
    return memberInfo(m.memberId, m.role, m.profile, m.v);
  }

  private async save(g?: Group): Promise<void> {
    if (g) g.lastActivity = Date.now();
    await this.chat.saveState();
  }

  private event(g: Group, text: string, memberId?: string): Promise<void> {
    return this.chat.addEvent(g.id, text, memberId);
  }

  /** the chat of a member with the moderators: listed from its first message or event */
  touchSupport(g: Group, memberId: string, unread = 0): void {
    const s = ((g.support ??= {})[memberId] ??= { unread: 0, lastActivity: 0 });
    s.lastActivity = Date.now();
    s.unread += unread;
  }

  /** an event in the chat of a member with the moderators */
  private async supportEvent(g: Group, memberId: string, text: string): Promise<void> {
    this.touchSupport(g, memberId);
    await this.chat.addEvent(supportChatId(g.id, memberId), text, memberId);
  }

  // ---- sending

  /** a body for one member: compressed if needed and the member can decompress it */
  private body(m: GroupMember, msg: ChatMessage): Bytes | undefined {
    const raw = encodeChatMessage(msg);
    if (raw.length <= MAX_ENCODED_MSG_LENGTH) return raw;
    if ((m.v?.max ?? COMPRESSION_CHAT_VERSION) < COMPRESSION_CHAT_VERSION) return undefined;
    return compressToLimit(MAX_ENCODED_MSG_LENGTH, raw);
  }

  /**
   * sends in the order of the calls. Agent event handlers run while their connection is locked, so
   * they cannot wait for a send to the same connection: they do not wait at all.
   */
  private deliver(connId: string, body: Bytes, notification: boolean, wait: boolean): Promise<void> {
    const prev = this.outbox.get(connId) ?? Promise.resolve();
    const p = prev.then(() => this.chat.agent.sendMessage(connId, body, notification)).then(() => {});
    const tail = p.catch((e) => {
      if (!wait) console.warn('a group message was not sent', (e as Error).message);
    });
    this.outbox.set(connId, tail);
    void tail.then(() => this.outbox.get(connId) === tail && this.outbox.delete(connId));
    return wait ? p : Promise.resolve();
  }

  /** sends to one member now (when connected) or once its connection is ready */
  private async sendTo(m: GroupMember, msg: ChatMessage, wait = false): Promise<void> {
    const body = this.body(m, msg);
    if (!body) throw new ChatError('message is too large');
    if (m.connId && m.status === 'connected') await this.deliver(m.connId, body, msg.event === 'x.msg.new', wait);
    else if (m.connId) (m.pending ??= []).push(b64(body));
  }

  /**
   * how a message reaches a member (memberSendAction): directly when connected; members introduced to
   * us get the messages that admins forward from the admin who introduced them, other messages are
   * kept until the connection is ready
   */
  private sendAction(g: Group, m: GroupMember, msg: ChatMessage): 'send' | 'pending' | 'forwarded' | undefined {
    if (memberGone(m) || m.memberId === HOST_PLACEHOLDER) return undefined;
    if (m.connId && m.status === 'connected') return 'send';
    if (m.category === 'host' || m.category === 'invitee') return m.connId ? 'pending' : undefined;
    const inviter = m.category === 'pre' ? g.hostMemberId : m.invitedBy;
    if (inviter && g.members[inviter] && !memberGone(g.members[inviter]) && isForwardedGroupMsg(msg)) return 'forwarded';
    return m.connId ? 'pending' : undefined;
  }

  /** sends a message to the group; returns the number of members it was sent to or kept for */
  async send(g: Group, msg: ChatMessage, except?: string): Promise<number> {
    if (g.channel) return this.sendChannel(g, msg);
    return this.sendToMembers(g, this.members(g).filter((m) => !m.review), msg, except);
  }

  /** a message in the chat of a member with the moderators */
  async sendSupport(g: Group, memberId: string, msg: ChatMessage): Promise<number> {
    return this.sendToMembers(g, this.supportMembers(g, memberId), msg);
  }

  private async sendToMembers(g: Group, members: GroupMember[], msg: ChatMessage, except?: string): Promise<number> {
    let n = 0;
    let err: unknown;
    for (const m of members) {
      if (m.memberId === except) continue;
      const a = this.sendAction(g, m, msg);
      if (a !== 'send' && a !== 'pending') continue;
      try {
        await this.sendTo(m, msg, true);
        n++;
      } catch (e) {
        err = e;
      }
    }
    await this.save(g);
    if (err && !n) throw err;
    return n;
  }

  private sendPending(m: GroupMember): void {
    const pending = m.pending;
    if (!pending?.length || !m.connId) return;
    m.pending = undefined;
    for (const b of pending) void this.deliver(m.connId, fromB64(b), false, false);
  }

  // ---- creating groups and inviting members

  /** a new group; as in the apps, new members get its recent messages */
  async create(p: { displayName: string; fullName?: string; description?: string; image?: string }, incognito?: Profile): Promise<Group> {
    const displayName = p.displayName.trim();
    if (!displayName) throw new ChatError('the group needs a name');
    const now = Date.now();
    const g: Group = {
      id: localId(),
      profile: { displayName, fullName: p.fullName?.trim() ?? '', ...(p.description?.trim() ? { description: p.description.trim() } : {}), ...(p.image ? { image: p.image } : {}), groupPreferences: { ...DEFAULT_GROUP_PREFERENCES, history: { enable: 'on' } } },
      memberId: newMemberId(),
      role: 'owner',
      status: 'active',
      incognito,
      members: {},
      createdAt: now,
      lastActivity: now,
      unread: 0,
    };
    this.groups[g.id] = g;
    await this.save();
    await this.event(g, 'you created the group');
    return g;
  }

  private assertAdmin(g: Group): void {
    if (g.status !== 'active') throw new ChatError('you are not an active member of this group');
    if (roleRank(g.role) < roleRank('admin')) throw new ChatError('only group admins and owners can do this');
  }

  /** invites a contact: x.grp.inv with a 1-time invitation for the member connection */
  async invite(groupId: string, contactId: string, role: GroupMemberRole = 'member'): Promise<GroupMember> {
    const g = this.must(groupId);
    this.assertAdmin(g);
    if (roleRank(role) < 0 || roleRank(role) > roleRank(g.role)) throw new ChatError(`you cannot add a member as ${role}`);
    const c = this.chat.contact(contactId);
    if (!c || c.status !== 'active') throw new ChatError('the contact is not connected');
    if (c.incognito && !g.incognito) throw new ChatError('you are incognito with this contact');
    if (this.currentMembers(g).some((m) => m.contactId === contactId)) throw new ChatError('the contact is already a member');
    const r = await this.chat.agent.createInvitation({ shortLink: false, pq: false });
    const m: GroupMember = { memberId: newMemberId(), role, profile: c.profile, category: 'invitee', status: 'invited', contactId, invitedBy: g.memberId, createdAt: Date.now() };
    g.members[m.memberId] = m;
    this.setConn(g, m, r.connId);
    const inv: GroupInvitation = {
      fromMember: { memberId: g.memberId, memberRole: g.role },
      invitedMember: { memberId: m.memberId, memberRole: role },
      connRequest: r.fullLink,
      groupProfile: g.profile,
      groupSize: this.currentMembers(g).length + 1,
    };
    await this.chat.sendDirect(c, xGrpInv(inv, newSharedMsgId()));
    await this.save(g);
    await this.event(g, `you invited ${profileName(c.profile)}`);
    return m;
  }

  /** an invitation from a contact (x.grp.inv) */
  async onInvitation(c: Contact, msg: ChatMessage): Promise<void> {
    const inv = msg.params.groupInvitation as GroupInvitation | undefined;
    const hostId = normMemberId(inv?.fromMember?.memberId);
    const ourId = normMemberId(inv?.invitedMember?.memberId);
    if (!inv || !hostId || !ourId || typeof inv.connRequest !== 'string' || !inv.groupProfile?.displayName) return;
    const name = inv.groupProfile.displayName;
    if (inv.groupProfile.publicGroup) return this.chat.addEvent(c.id, `${profileName(c.profile)} invited you to the channel "${name}" — channels are not supported yet`);
    const fromRole = inv.fromMember.memberRole;
    const role = inv.invitedMember.memberRole;
    if (roleRank(fromRole) < roleRank('admin') || roleRank(fromRole) < roleRank(role) || hostId === ourId) return;
    // a repeated invitation
    if (this.list().some((g) => g.invitation?.contactId === c.id && g.memberId === ourId)) return;
    const now = Date.now();
    const g: Group = {
      id: localId(),
      profile: inv.groupProfile,
      memberId: ourId,
      role,
      status: 'invited',
      incognito: c.incognito,
      members: { [hostId]: { memberId: hostId, role: fromRole, profile: c.profile, category: 'host', status: 'invited', contactId: c.id, createdAt: now } },
      hostMemberId: hostId,
      invitation: { contactId: c.id, connRequest: inv.connRequest },
      createdAt: now,
      lastActivity: now,
      unread: 0,
    };
    this.groups[g.id] = g;
    const item: ChatItem = {
      id: localId(),
      dir: 'rcv',
      sharedMsgId: msg.msgId,
      content: { type: 'text', text: `invitation to join the group "${name}" as ${role}` },
      ts: now,
      status: 'received',
      groupInv: { groupId: g.id, status: 'pending', name, role },
    };
    g.invitation!.itemId = item.id;
    c.unread++;
    await this.save();
    await this.chat.addItem(c.id, item);
    await this.event(g, `${profileName(c.profile)} invited you to join the group`);
  }

  private async setInvitationStatus(g: Group, status: 'accepted' | 'rejected'): Promise<void> {
    const inv = g.invitation;
    if (!inv?.itemId) return;
    const it = (await this.chat.chatItems(inv.contactId)).find((i) => i.id === inv.itemId);
    if (it?.groupInv) {
      it.groupInv.status = status;
      await this.chat.updateItem(inv.contactId, it);
    }
  }

  /** joins a group we were invited to: x.grp.acpt in the confirmation of the member connection */
  async accept(groupId: string): Promise<void> {
    const g = this.must(groupId);
    if (g.status !== 'invited' || !g.invitation || !g.hostMemberId) throw new ChatError('there is no invitation to accept');
    const host = g.members[g.hostMemberId];
    const connInfo = this.chat.encodeInfo(xGrpAcpt(g.memberId, this.ourProfile(g)), false);
    const connId = await this.chat.agent.joinConnection(g.invitation.connRequest, connInfo, { pq: false });
    this.setConn(g, host, connId);
    host.status = 'accepted';
    g.status = 'connecting';
    await this.setInvitationStatus(g, 'accepted');
    g.invitation = undefined;
    await this.save(g);
    await this.event(g, 'you joined, connecting…');
  }

  async reject(groupId: string): Promise<void> {
    const g = this.must(groupId);
    if (g.status !== 'invited') return;
    await this.setInvitationStatus(g, 'rejected');
    await this.remove(g);
  }

  /** joins via a group link: a contact request (x.contact) answered by the admin with x.grp.link.inv */
  async joinViaLink(resolved: ResolvedLink, groupProfile: GroupProfile | undefined, incognito?: Profile): Promise<Group> {
    const now = Date.now();
    const g: Group = {
      id: localId(),
      profile: groupProfile?.displayName ? groupProfile : { displayName: 'group', fullName: '' },
      memberId: '',
      role: 'member',
      status: 'joining',
      incognito,
      members: {},
      hostMemberId: HOST_PLACEHOLDER,
      createdAt: now,
      lastActivity: now,
      unread: 0,
    };
    const connInfo = this.chat.encodeInfo(xContact(this.ourProfile(g), newSharedMsgId()), false);
    const connId = await this.chat.agent.joinConnection(resolved, connInfo, { pq: false });
    const host: GroupMember = { memberId: HOST_PLACEHOLDER, role: 'admin', profile: { displayName: 'host', fullName: '' }, category: 'host', status: 'accepted', createdAt: now };
    g.members[HOST_PLACEHOLDER] = host;
    this.groups[g.id] = g;
    this.setConn(g, host, connId);
    await this.save();
    await this.event(g, 'joining the group…');
    return g;
  }

  // ---- channels: posts reach the subscribers through chat relays, which forward them. The owners are in the
  // channel link; the members, moderators and admins in its roster, which an owner signs and the relays serve

  /**
   * joins a channel via its link (connectPreparedGroup of the apps): the owners and their keys come from
   * the link, and we join each of its relays with our member key
   */
  async joinChannel(resolved: ResolvedLink, incognito?: Profile): Promise<Group> {
    const ld = resolved.linkData;
    if (!ld || ld.user.mode !== 'contact' || !ld.fixed.linkEntityId) throw new ChatError('this is not a channel link');
    const publicGroupId = b64url(ld.fixed.linkEntityId);
    const sld = parseShortLinkData(ld.user.data.userData) as { groupProfile?: GroupProfile; publicGroupData?: { publicMemberCount?: number } };
    const gp = sld.groupProfile;
    // the profile names the channel that the link is of
    if (!gp?.displayName || normMemberId((gp.publicGroup as { publicGroupId?: unknown } | undefined)?.publicGroupId) !== publicGroupId) throw new ChatError('the channel link is not valid');
    const relays = ld.user.data.relays.map((l) => strShortLink(l));
    if (!relays.length) throw new ChatError('the channel has no relays yet: try again later');
    const kp = generateKeyPair('ed25519');
    const now = Date.now();
    const g: Group = {
      id: localId(),
      profile: gp,
      memberId: newMemberId(),
      role: 'observer',
      status: 'joining',
      incognito,
      members: {},
      createdAt: now,
      lastActivity: now,
      unread: 0,
      channel: { publicGroupId, link: resolved.link, memberKey: { pub: b64url(kp.pub.key), priv: b64url(kp.priv.key) }, subscribers: sld.publicGroupData?.publicMemberCount },
    };
    // all owners, each authorised by the root key of the link or by an owner before it (the agent checked it)
    for (const o of ld.user.data.owners) {
      const id = b64url(o.ownerId);
      g.members[id] = { memberId: id, role: 'owner', profile: { displayName: 'owner', fullName: '' }, category: 'post', status: 'announced', key: b64url(o.ownerKey.key), createdAt: now };
    }
    this.groups[g.id] = g;
    // all relays at once: joined when one accepts
    const rs = await Promise.allSettled(relays.map((l) => this.connectRelay(g, l)));
    const failed = rs.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && rs.every((r) => r.status === 'rejected')) {
      delete this.groups[g.id];
      await this.save();
      throw failed.reason;
    }
    await this.save(g);
    await this.event(g, 'joining the channel…');
    return g;
  }

  private async connectRelay(g: Group, link: string): Promise<void> {
    const r = await this.chat.agent.resolveLink(link);
    const entity = r.linkData?.fixed.linkEntityId;
    if (!entity || r.connReq.mode !== 'contact') throw new ChatError('the link of a relay is not valid');
    const id = b64url(entity);
    const rp = (parseShortLinkData(r.userData) as { relayProfile?: Profile }).relayProfile;
    const m: GroupMember = { memberId: id, role: 'relay', profile: memberProfile(rp?.displayName ? rp : { displayName: 'relay', fullName: '' }), category: 'host', status: 'accepted', relayLink: link, createdAt: Date.now() };
    g.members[id] = m;
    // signed, and bound to this relay, so that another relay cannot replay it
    const xMember = { event: 'x.member', params: { profile: this.ourProfile(g), newMemberId: g.memberId, newMemberKey: this.channelKey(g), viaRelay: id } };
    const connInfo = compressToLimit(MAX_CONN_INFO_LENGTH, this.channelSigned(g, xMember));
    if (!connInfo) throw new ChatError('the profile is too large (try a smaller picture)');
    const connId = await this.chat.agent.joinConnection(r, connInfo, { pq: false });
    this.setConn(g, m, connId);
  }

  /** our member key, as the apps send it (MemberKey: the X.509 key, base64url) */
  private channelKey(g: Group): string {
    return x509Key(g.channel!.memberKey.pub);
  }

  /**
   * a message we send in a channel, signed with our member key (relays and owners verify x.info,
   * x.grp.leave…), with the chat versions of channels: from 19, the relays serve us the roster
   */
  private channelSigned(g: Group, msg: ChatMessage): Bytes {
    const binding = groupBinding(fromB64(g.channel!.publicGroupId), fromB64(g.memberId));
    return signedElement(binding, { alg: 'ed25519', key: fromB64(g.channel!.memberKey.priv) }, encodeChatMessage({ ...msg, v: CHANNEL_CHAT_VERSIONS }));
  }

  /** what changes the channel is signed, and moderation; posts are not (as in the apps); compressed when large */
  private channelBody(g: Group, msg: ChatMessage): Bytes {
    const moderation = msg.event === 'x.msg.del' && !!msg.params.memberId;
    const raw = CHANNEL_SIGNED.has(msg.event) || moderation ? this.channelSigned(g, msg) : encodeChatMessage({ ...msg, v: CHANNEL_CHAT_VERSIONS });
    const body = raw.length <= MAX_ENCODED_MSG_LENGTH ? raw : compressToLimit(MAX_ENCODED_MSG_LENGTH, raw);
    if (!body) throw new ChatError('message is too large');
    return body;
  }

  /**
   * to the relays of a channel, which forward it (or to these relays). In the handler of an agent event of
   * a relay, the sends to it do not wait (wait = false)
   */
  private async sendChannel(g: Group, msg: ChatMessage, to?: GroupMember[], wait = true): Promise<number> {
    const body = this.channelBody(g, msg);
    let n = 0;
    for (const m of to ?? this.relays(g)) {
      if (m.connId && m.status === 'connected') {
        await this.deliver(m.connId, body, false, wait).catch((e) => console.warn('a channel message was not sent', e));
        n++;
      }
    }
    return n;
  }

  relays(g: Group): GroupMember[] {
    return this.currentMembers(g).filter((m) => m.role === 'relay');
  }

  /** the owner who made the channel: the link, the roster and the owners are ours to change */
  isChannelCreator(g: Group): boolean {
    return !!g.channel?.linkConnId && g.role === 'owner';
  }

  private async onChannelEvent(g: Group, m: GroupMember, e: AgentEvent): Promise<MsgResult | void> {
    if (m.role !== 'relay') return;
    if (e.type === 'MSG') return this.onChannelMsg(g, m, e.body);
    if (e.type === 'END') return void this.chat.emitError(`${groupName(g)}: the connection is used by another client (is Duplex open in another tab?)`);
    if (m.category === 'invitee') return this.onOwnedRelayEvent(g, m, e);
    switch (e.type) {
      case 'CONF': {
        // the relay accepts us: x.grp.link.inv, about this channel and our member ID
        const msg = this.chat.parseInfo(e.connInfo);
        const gli = msg?.event === 'x.grp.link.inv' ? (msg.params.groupLinkInvitation as GroupLinkInvitation | undefined) : undefined;
        const pg = normMemberId((gli?.groupProfile?.publicGroup as { publicGroupId?: unknown } | undefined)?.publicGroupId);
        if (!gli || pg !== g.channel!.publicGroupId || normMemberId(gli.invitedMember?.memberId) !== g.memberId || normMemberId(gli.fromMember?.memberId) !== m.memberId) {
          console.warn('a relay answered for another channel or member', msg?.event);
          return;
        }
        if (msg?.v) m.v = msg.v;
        // the profile of the channel comes from its link, and from the owners (signed)
        if (gli.invitedMember.memberRole) g.role = gli.invitedMember.memberRole;
        if (typeof gli.groupSize === 'number') g.channel!.subscribers = gli.groupSize;
        if (gli.fromMemberName) m.profile = { ...m.profile, displayName: gli.fromMemberName };
        await this.save(g);
        return { allow: this.channelSigned(g, { event: 'x.info', params: { profile: this.ourProfile(g), memberKey: this.channelKey(g) } }) };
      }
      case 'CON':
        m.status = 'connected';
        this.sendPending(m);
        if (g.status === 'joining') {
          g.status = 'active';
          await this.event(g, 'you joined the channel');
        }
        await this.save(g);
        return;
      default:
        return;
    }
  }

  private async onChannelMsg(g: Group, relay: GroupMember, body: Bytes): Promise<MsgResult> {
    for (const pm of parseChatMessages(body)) {
      try {
        // the chunks of a roster come from the relay itself, after the roster it forwards
        if (pm.chunk) {
          if (!pm.forward) await this.onRosterChunk(g, relay, pm.chunk);
          continue;
        }
        if (!pm.msg) {
          console.warn('channel message error', pm.error);
          continue;
        }
        if (DEBUG) console.log(`[channel ${groupName(g)}] from ${memberName(relay)}: ${pm.forward ? `forwarded (${pm.forward.memberName ?? 'as the channel'}) ` : ''}${pm.msg.event}`, JSON.stringify(pm.msg.params).slice(0, 200));
        if (pm.forward) await this.onChannelForward(g, relay, pm);
        else await this.onRelayEvent(g, relay, pm.msg);
      } catch (err) {
        console.warn('channel message processing error', pm.msg?.event, err);
      }
    }
    await this.save(g);
    return {};
  }

  /** a message of a relay itself: the members it introduces or announces, its profile, roster confirmations, leaving */
  private async onRelayEvent(g: Group, relay: GroupMember, msg: ChatMessage): Promise<void> {
    const p = msg.params;
    switch (msg.event) {
      case 'x.grp.mem.intro':
      case 'x.grp.mem.new': {
        // x.grp.mem.intro: the owners, admins and moderators, to a new subscriber; x.grp.mem.new: a new subscriber,
        // to them, or the author of a message that follows
        const mi = p.memberInfo as MemberInfo | undefined;
        const id = normMemberId(mi?.memberId);
        if (!mi?.profile || !id || id === g.memberId) return;
        // the roles and keys of members, moderators, admins and owners are the owners' to give (in the link and the
        // roster): a relay only tells their profiles; of the other subscribers, their role and key too
        const ex = g.members[id];
        if (ex) {
          if (ex.role === 'relay') return;
          ex.profile = memberProfile(mi.profile);
          if (ex.status === 'unknown') ex.status = 'announced';
          if (!privileged(ex.role) && !privileged(mi.memberRole)) {
            ex.role = mi.memberRole;
            ex.key ??= rawMemberKey(mi.memberKey);
          }
          return;
        }
        if (privileged(mi.memberRole)) {
          // not in the roster (yet): a subscriber until it is
          if (msg.event === 'x.grp.mem.intro') g.members[id] = { memberId: id, role: 'observer', profile: memberProfile(mi.profile), category: 'post', status: 'announced', createdAt: Date.now() };
          return;
        }
        g.members[id] = { memberId: id, role: mi.memberRole, profile: memberProfile(mi.profile), category: 'post', status: 'announced', invitedBy: relay.memberId, key: rawMemberKey(mi.memberKey), createdAt: Date.now() };
        if (msg.event === 'x.grp.mem.new' && g.role === 'owner') g.channel!.subscribers = (g.channel!.subscribers ?? 0) + 1;
        return;
      }
      case 'x.grp.roster.ack':
        return this.onRosterAck(g, relay, p);
      case 'x.info':
      case 'x.grp.link.mem':
        if (p.profile) relay.profile = memberProfile(p.profile as Profile);
        return;
      case 'x.grp.leave':
        relay.status = 'left';
        relay.rosterPending = undefined;
        await this.event(g, `the relay ${memberName(relay)} left the channel`);
        if (this.isChannelCreator(g)) await this.publishRelays(g).catch((e) => console.warn('the channel link was not updated', e));
        this.later(() => this.dropMember(relay, 0));
        return;
      default:
        return;
    }
  }

  /** a message of the channel or of one of its members, forwarded by a relay */
  private async onChannelForward(g: Group, relay: GroupMember, pm: ParsedChatMsg): Promise<void> {
    const msg = pm.msg!;
    const ts = pm.forward!.brokerTs || Date.now();
    const authorId = normMemberId(pm.forward!.memberId);
    if (!authorId) {
      // sent as the channel, which only owners do (the relay checks it): posts and what changes them
      if (CHANNEL_CONTENT.has(msg.event) && msg.event !== 'x.msg.react') await this.chat.processContent({ chatId: g.id, group: g }, msg, { brokerTs: ts, forwarded: true });
      return;
    }
    if (authorId === g.memberId) return;
    let author = g.members[authorId];
    if (!author) {
      if (msg.event === 'x.grp.leave') return;
      author = g.members[authorId] = { memberId: authorId, role: 'observer', profile: { displayName: pm.forward!.memberName || nameFromMemberId(authorId), fullName: '' }, category: 'post', status: 'unknown', createdAt: Date.now() };
    }
    if (author.role === 'relay' || author.status === 'removed') return;
    if (!this.channelVerified(g, pm, author)) return void console.warn(`a channel message without a valid signature was ignored: ${msg.event} from ${memberName(author)}`);
    await this.onMemberEvent(g, relay, author, msg, ts);
  }

  /**
   * the signature of a message of a member (withVerifiedMsg of the apps): what changes the channel is signed
   * with the member's key (owners: from the link; members, moderators and admins: from the roster); from a
   * member whose key we do not know, a signed message passes only when it needs no signature, or it is a
   * profile or leaving between subscribers
   */
  private channelVerified(g: Group, pm: ParsedChatMsg, m: GroupMember): 'verified' | 'unsigned' | 'nokey' | undefined {
    const event = pm.msg!.event;
    const required = CHANNEL_SIGNED.has(event);
    if (!pm.sig) return required ? undefined : 'unsigned';
    if (m.key) {
      if (pm.sig.binding !== 'G') return required ? undefined : 'nokey';
      const binding = groupBinding(fromB64(g.channel!.publicGroupId), fromB64(m.memberId));
      return verifySigned(pm.sig, binding, [{ alg: 'ed25519', key: fromB64(m.key) }]) ? 'verified' : undefined;
    }
    const betweenSubscribers = (event === 'x.grp.leave' || event === 'x.info') && !isModerator(g.role) && !isModerator(m.role);
    return !required || betweenSubscribers ? 'nokey' : undefined;
  }

  private async onMemberEvent(g: Group, relay: GroupMember, author: GroupMember, msg: ChatMessage, ts: number): Promise<void> {
    const p = msg.params;
    switch (msg.event) {
      case 'x.msg.new':
      case 'x.msg.update':
        // members post, subscribers do not (memberCanSend); the posts of a blocked member are not shown
        if (roleRank(author.role) <= roleRank('observer') || p.scope || (author.blocked && msg.event === 'x.msg.new')) return;
        await this.chat.processContent({ chatId: g.id, group: g, sender: author }, msg, { brokerTs: ts, forwarded: true });
        return;
      case 'x.msg.del':
      case 'x.msg.react':
      case 'x.msg.file.descr':
      case 'x.file.cancel':
        await this.chat.processContent({ chatId: g.id, group: g, sender: author }, msg, { brokerTs: ts, forwarded: true });
        return;
      case 'x.info':
        if (p.profile) author.profile = memberProfile(p.profile as Profile);
        return;
      case 'x.grp.mem.role':
        return this.onChannelRole(g, relay, author, p);
      case 'x.grp.mem.del':
        return this.onChannelRemoval(g, relay, author, p);
      case 'x.grp.mem.restrict': {
        const t = g.members[normMemberId(p.memberId) ?? ''];
        if (!t || t.role === 'relay' || roleRank(author.role) < roleRank('moderator') || roleRank(author.role) < roleRank(t.role)) return;
        t.blocked = p.memberRestrictions?.restriction === 'blocked';
        if (isModerator(g.role)) await this.event(g, `${memberName(author)} ${t.blocked ? 'blocked' : 'unblocked'} ${memberName(t)}`, author.memberId);
        return;
      }
      case 'x.grp.leave':
        if (memberGone(author)) return;
        author.status = 'left';
        if (g.role === 'owner') g.channel!.subscribers = Math.max(0, (g.channel!.subscribers ?? 1) - 1);
        // an owner who left is no longer one in the link
        if (author.role === 'owner' && this.isChannelCreator(g)) await this.setLinkOwner(g, author, false).catch((e) => console.warn('the channel link was not updated', e));
        if (privileged(author.role)) await this.event(g, `${memberName(author)} (${author.role}) left the channel`, author.memberId);
        return;
      case 'x.grp.del':
        if (author.role !== 'owner') return;
        g.status = 'deleted';
        await this.event(g, 'the owner deleted the channel');
        this.later(() => this.dropConnections(g, 0));
        return;
      case 'x.grp.info': {
        const gp = p.groupProfile as GroupProfile | undefined;
        if (author.role !== 'owner' || !gp?.displayName || normMemberId((gp.publicGroup as { publicGroupId?: unknown } | undefined)?.publicGroupId) !== g.channel!.publicGroupId) return;
        g.profile = gp;
        await this.event(g, 'the channel profile was updated');
        return;
      }
      case 'x.grp.prefs':
        if (author.role === 'owner' && p.groupPreferences && typeof p.groupPreferences === 'object') g.profile = { ...g.profile, groupPreferences: p.groupPreferences };
        return;
      case 'x.grp.roster':
        return this.onRosterHeader(g, relay, author, msg);
      default:
        return;
    }
  }

  /**
   * a change that carries a roster version, from an owner (applyAtRosterVersion): ignored when older than
   * one we have; when versions were missed, the relay that forwarded it serves us the whole roster
   */
  private async rosterGate(g: Group, relay: GroupMember, sender: GroupMember, v: unknown): Promise<boolean> {
    const ch = g.channel!;
    if (typeof v !== 'number' || sender.role !== 'owner') return true;
    if (ch.rosterVersion !== undefined && v < ch.rosterVersion) return false;
    ch.rosterVersion = v;
    const next = (ch.rosterComplete ?? -1) + 1;
    if (v === next) ch.rosterComplete = v;
    else if (v > next && (relay.v?.max ?? 0) >= GROUP_ROSTER_VERSION) await this.sendChannel(g, xGrpRosterRequest(ch.rosterComplete), [relay], false);
    return true;
  }

  /** members, moderators and admins are in the roster, which has one signer: only owners give or take these roles */
  private mayChangeRole(sender: GroupMember, from: GroupMemberRole, to: GroupMemberRole): boolean {
    if (roleRank(sender.role) < roleRank(roleToChange(from, to))) return false;
    return !((isRosterRole(from) || isRosterRole(to)) && sender.role !== 'owner');
  }

  /** a role change (x.grp.mem.role, signed): with roster roles and owners, the owner sends the member's key */
  private async onChannelRole(g: Group, relay: GroupMember, sender: GroupMember, p: Record<string, any>): Promise<void> {
    const id = normMemberId(p.memberId);
    const role = p.role as GroupMemberRole;
    if (!id || typeof role !== 'string' || role === 'relay') return;
    if (!(await this.rosterGate(g, relay, sender, p.rosterVersion))) return;
    if (id === g.memberId) {
      if (g.role === role || !this.mayChangeRole(sender, g.role, role)) return;
      g.role = role;
      await this.event(g, `${memberName(sender)} changed your role to ${role}`, sender.memberId);
      return;
    }
    const key = typeof p.memberKey === 'string' ? rawMemberKey(p.memberKey) : undefined;
    // a member named with its key by an owner is created, and its key pinned on first use (TOFU): an owner
    // authorises new owners, as in the link
    const named = sender.role === 'owner' && privileged(role) && !!key;
    let m = g.members[id];
    if (!m) {
      if (!named) return;
      m = g.members[id] = { memberId: id, role: 'observer', profile: { displayName: nameFromMemberId(id), fullName: '' }, category: 'post', status: 'unknown', createdAt: Date.now() };
    }
    if (m.role === 'relay' || !this.mayChangeRole(sender, m.role, role)) return;
    if (key && m.key && m.key !== key) return void console.warn('x.grp.mem.role: a different key of a known member was ignored');
    if (named) m.key ??= key;
    m.role = role;
  }

  /** a removal (x.grp.mem.del, signed): by admins, of members whose role is not higher */
  private async onChannelRemoval(g: Group, relay: GroupMember, sender: GroupMember, p: Record<string, any>): Promise<void> {
    const id = normMemberId(p.memberId);
    if (!id || !(await this.rosterGate(g, relay, sender, p.rosterVersion))) return;
    if (id === g.memberId) {
      if (roleRank(sender.role) < roleRank('admin') || roleRank(sender.role) < roleRank(g.role)) return;
      g.status = 'removed';
      await this.event(g, 'you were removed from the channel');
      this.later(() => this.dropConnections(g, 0));
      return;
    }
    const m = g.members[id];
    if (!m || memberGone(m) || m.role === 'relay' || roleRank(sender.role) < roleRank('admin') || roleRank(sender.role) < roleRank(m.role)) return;
    m.status = 'removed';
    if (g.role === 'owner') g.channel!.subscribers = Math.max(0, (g.channel!.subscribers ?? 1) - 1);
    if (isModerator(g.role)) await this.event(g, `${memberName(sender)} removed ${memberName(m)}`, sender.memberId);
  }

  /** the roster an owner signed, forwarded by a relay: its blob follows in chunks from the relay */
  private async onRosterHeader(g: Group, relay: GroupMember, owner: GroupMember, msg: ChatMessage): Promise<void> {
    const ch = g.channel!;
    const { version, fileInv } = msg.params as { version?: unknown; fileInv?: { fileSize?: unknown; fileDigest?: unknown } };
    if (owner.role !== 'owner' || this.isChannelCreator(g) || !msg.msgId) return;
    if (typeof version !== 'number' || typeof fileInv?.fileSize !== 'number' || typeof fileInv.fileDigest !== 'string' || fileInv.fileSize > MAX_ROSTER_BYTES) return;
    // not older than the roster we have, nor than the one this relay is sending (a newer one replaces it)
    if (ch.rosterVersion !== undefined && version < ch.rosterVersion) return;
    const cur = ch.rosterTransfers?.[relay.memberId];
    if (cur && version < cur.version) return;
    (ch.rosterTransfers ??= {})[relay.memberId] = { ref: b64url(fromB64(msg.msgId)), version, size: fileInv.fileSize, digest: b64url(fromB64(fileInv.fileDigest)), owner: owner.memberId, chunks: 0, data: '' };
  }

  private async onRosterChunk(g: Group, relay: GroupMember, chunk: NonNullable<ParsedChatMsg['chunk']>): Promise<void> {
    const ch = g.channel!;
    const t = ch.rosterTransfers?.[relay.memberId];
    if (!t || t.ref !== chunk.ref) return;
    // a roster served again starts from its first chunk
    if (chunk.chunkNo === 1) {
      t.chunks = 0;
      t.data = '';
    } else if (chunk.chunkNo !== t.chunks + 1) return;
    const data = concat(fromB64(t.data), chunk.data);
    if (data.length < t.size && chunk.data.length === ROSTER_CHUNK_SIZE) {
      t.chunks++;
      t.data = b64(data);
      return;
    }
    delete ch.rosterTransfers![relay.memberId];
    if (data.length !== t.size || b64url(sha512(data)) !== t.digest) return void console.warn('a roster that is not as its owner signed it was ignored');
    let entries: RosterEntry[];
    try {
      entries = validRoster(parseRoster(data));
    } catch (e) {
      return void console.warn('a roster that cannot be read was ignored', e);
    }
    // a roster from another relay, or a change, may have brought a newer version meanwhile
    if (ch.rosterVersion !== undefined && t.version < ch.rosterVersion) return;
    await this.applyRoster(g, entries, t.version);
  }

  /**
   * a complete roster (processRosterEntries): the members it names get their roles, and their keys if we
   * had none (a different key is not taken); members it no longer names are subscribers again
   */
  private async applyRoster(g: Group, entries: RosterEntry[], version: number): Promise<void> {
    const ch = g.channel!;
    const named = new Set(entries.map((e) => e.memberId));
    for (const e of entries) {
      if (e.memberId === g.memberId) {
        if (e.key === ch.memberKey.pub && g.role !== e.role && g.role !== 'owner') {
          g.role = e.role;
          await this.event(g, `your role in the channel is now ${e.role}`);
        }
        continue;
      }
      let m = g.members[e.memberId];
      if (m && (m.role === 'relay' || m.role === 'owner')) continue;
      m ??= g.members[e.memberId] = { memberId: e.memberId, role: 'observer', profile: { displayName: nameFromMemberId(e.memberId), fullName: '' }, category: 'post', status: 'unknown', createdAt: Date.now() };
      if (m.key && m.key !== e.key) {
        console.warn('roster: a different key of a known member was ignored');
        continue;
      }
      m.key = e.key;
      m.role = e.role;
    }
    for (const m of this.members(g)) if (isRosterRole(m.role) && !named.has(m.memberId)) m.role = 'observer';
    ch.rosterVersion = version;
    ch.rosterComplete = version;
  }

  // ---- channels (as the owner)

  /**
   * creates a channel (APINewPublicGroup of the apps): its ID is the hash of a new root key, which
   * authorises our member key as the owner's in the link. The relays are invited; each serves the
   * channel once it accepts, has the roster, and is in the link
   */
  async createChannel(p: { displayName: string; description?: string; image?: string }, relayAddresses: string[], incognito?: Profile): Promise<Group> {
    const displayName = p.displayName.trim();
    if (!displayName) throw new ChatError('the channel needs a name');
    if (!relayAddresses.length) throw new ChatError('choose at least one chat relay');
    const root = generateKeyPair('ed25519');
    const entityId = sha256(root.pub.key);
    const publicGroupId = b64url(entityId);
    const memberId = newMemberId();
    const memberKey = generateKeyPair('ed25519');
    const ownerId = fromB64(memberId);
    const ownerAuth = { ownerId, ownerKey: memberKey.pub, sig: sign(root.priv, concat(ownerId, encodePubKey(memberKey.pub))) };
    const base: GroupProfile = {
      displayName,
      fullName: '',
      ...(p.description?.trim() ? { description: p.description.trim() } : {}),
      ...(p.image ? { image: p.image } : {}),
      groupPreferences: { ...DEFAULT_GROUP_PREFERENCES, history: { enable: 'on' } },
    };
    let profile = base;
    const r = await this.chat.agent.createAddress({
      root,
      linkEntityId: entityId,
      owners: [ownerAuth],
      direct: false,
      linkType: 'C',
      clientData: groupLinkClientData(newGroupLinkId()),
      // the profile names the link
      userData: (link) => channelShortLinkData((profile = { ...base, publicGroup: { groupType: 'channel', groupLink: link, publicGroupId } }), 1),
    });
    const now = Date.now();
    const g: Group = {
      id: localId(),
      profile,
      memberId,
      role: 'owner',
      status: 'active',
      incognito,
      members: {},
      createdAt: now,
      lastActivity: now,
      unread: 0,
      channel: { publicGroupId, link: r.link, memberKey: { pub: b64url(memberKey.pub.key), priv: b64url(memberKey.priv.key) }, subscribers: 0, linkConnId: r.connId },
    };
    this.groups[g.id] = g;
    await this.save(g);
    await this.event(g, 'you created the channel: it can be joined once a relay serves it');
    const rs = await Promise.allSettled(relayAddresses.map((a) => this.inviteRelay(g, a)));
    const failed = rs.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (failed && rs.every((x) => x.status === 'rejected')) {
      await this.remove(g);
      throw failed.reason;
    }
    await this.save(g);
    return g;
  }

  /** a chat relay is asked to serve the channel (x.grp.relay.inv, signed): it checks the link, and makes its own link for it */
  private async inviteRelay(g: Group, address: string): Promise<void> {
    const r = await this.chat.agent.resolveLink(address);
    if (r.connReq.mode !== 'contact') throw new ChatError('this is not the address of a chat relay');
    const d = parseShortLinkData(r.userData) as { profile?: Profile; relayProfile?: Profile };
    const rp = d.relayProfile ?? d.profile;
    const id = newMemberId();
    const m: GroupMember = { memberId: id, role: 'relay', profile: memberProfile(rp?.displayName ? rp : { displayName: 'relay', fullName: '' }), category: 'invitee', status: 'invited', relayAddress: address, createdAt: Date.now() };
    g.members[id] = m;
    const inv = { fromMember: { memberId: g.memberId, memberRole: 'owner' }, fromMemberProfile: this.ourProfile(g), relayMemberId: id, groupLink: g.channel!.link, publicGroupId: g.channel!.publicGroupId, fromMemberKey: this.channelKey(g) };
    const connInfo = compressToLimit(MAX_CONN_INFO_LENGTH, this.channelSigned(g, { event: 'x.grp.relay.inv', params: { groupRelayInvitation: inv } }));
    if (!connInfo) throw new ChatError('the profile is too large (try a smaller picture)');
    const connId = await this.chat.agent.joinConnection(r, connInfo, { pq: false });
    this.setConn(g, m, connId);
  }

  /** the relays we invited to our channel: their acceptance, and the roster they confirm before serving */
  private async onOwnedRelayEvent(g: Group, m: GroupMember, e: AgentEvent): Promise<MsgResult | void> {
    const ok = () => ({ allow: this.chat.encodeInfo({ ...xOk(), v: CHANNEL_CHAT_VERSIONS }, false) });
    switch (e.type) {
      case 'CONF': {
        const msg = this.chat.parseInfo(e.connInfo);
        if (msg?.event === 'x.grp.relay.reject') {
          m.status = 'left';
          await this.event(g, `the relay ${memberName(m)} declined to serve the channel`);
          return ok();
        }
        if (msg?.event !== 'x.grp.relay.acpt' || typeof msg.params.relayLink !== 'string') return void console.warn('unexpected confirmation of a relay', msg?.event);
        // the link the relay made for the channel: its entity is the member ID we gave the relay
        const rl = await this.chat.agent.resolveLink(msg.params.relayLink);
        if (!rl.linkData?.fixed.linkEntityId || b64url(rl.linkData.fixed.linkEntityId) !== m.memberId) return void console.warn('the link of the relay is for another member');
        const rp = (parseShortLinkData(rl.userData) as { relayProfile?: Profile }).relayProfile;
        if (rp?.displayName) m.profile = memberProfile(rp);
        if (msg.v) m.v = msg.v;
        m.relayLink = msg.params.relayLink;
        m.key = b64url(rl.linkData.fixed.rootKey.key);
        m.status = 'accepted';
        await this.save(g);
        return ok();
      }
      case 'CON': {
        m.status = 'connected';
        this.sendPending(m);
        // a relay that takes rosters serves the channel once it has ours (so that nobody joins it as a
        // moderator meanwhile): the link lists it when it confirms
        if ((m.v?.max ?? 0) >= GROUP_ROSTER_VERSION) {
          const ch = g.channel!;
          ch.rosterVersion ??= 0;
          m.rosterPending = ch.rosterVersion;
          await this.save(g);
          await this.sendRoster(g, [m], ch.rosterVersion, false);
          return;
        }
        await this.save(g);
        await this.publishRelays(g);
        await this.event(g, `the relay ${memberName(m)} serves the channel`);
        return;
      }
      default:
        return;
    }
  }

  /** a relay confirms the roster (x.grp.roster.ack): once it has the current one, the link lists it */
  private async onRosterAck(g: Group, relay: GroupMember, p: Record<string, any>): Promise<void> {
    if (relay.category !== 'invitee' || relay.rosterPending === undefined) return;
    if (typeof p.error === 'string') {
      relay.rosterPending = undefined;
      relay.status = 'left';
      await this.event(g, `the relay ${memberName(relay)} could not take the roster of the channel: ${p.error}`);
      return;
    }
    // a newer roster is on its way to it
    if (p.version !== g.channel!.rosterVersion) return;
    relay.rosterPending = undefined;
    await this.publishRelays(g);
    await this.event(g, `the relay ${memberName(relay)} serves the channel`);
  }

  /** the user data of the channel link: its profile, and the number of subscribers */
  private channelLinkData(g: Group): Bytes {
    return channelShortLinkData(g.profile, Math.max(1, g.channel!.subscribers ?? 1));
  }

  /** the link of our channel lists the relays that serve it: subscribers connect to them */
  private async publishRelays(g: Group): Promise<void> {
    const links = this.relays(g)
      .filter((r) => r.relayLink && r.status === 'connected' && r.rosterPending === undefined)
      .map((r) => parseShortLink(r.relayLink!));
    await this.chat.agent.updateLinkData(g.channel!.linkConnId!, this.channelLinkData(g), { relays: links });
  }

  /** the members, moderators and admins, with their keys (buildGroupRoster): the owners are in the link */
  private rosterEntries(g: Group): RosterEntry[] {
    return this.currentMembers(g)
      .filter((m) => isRosterRole(m.role) && m.key)
      .map((m) => ({ memberId: m.memberId, key: m.key!, role: m.role }));
  }

  /** the roster, signed, and its blob, to these relays (sendRoster of the apps); in one chunk */
  private async sendRoster(g: Group, relays: GroupMember[], version: number, wait = true): Promise<void> {
    const blob = encodeRoster(this.rosterEntries(g));
    const msgId = newSharedMsgId();
    await this.sendChannel(g, xGrpRoster(version, blob, msgId), relays, wait);
    const chunk = fileChunkElement(msgId, 1, blob);
    for (const r of relays) if (r.connId && r.status === 'connected') await this.deliver(r.connId, chunk, false, wait).catch((e) => console.warn('a roster was not sent', e));
  }

  /** the next roster version, for a change of the roster, which the relays get first (broadcastRoster) */
  private async nextRoster(g: Group): Promise<number> {
    const ch = g.channel!;
    const v = (ch.rosterVersion ?? -1) + 1;
    ch.rosterVersion = v;
    await this.save(g);
    await this.sendRoster(g, this.relays(g), v);
    return v;
  }

  /**
   * the owners are in the channel link, each authorised by an owner before it or by the root key of the
   * link (validateLinkOwners): a new owner, by our key
   */
  private async setLinkOwner(g: Group, m: GroupMember, add: boolean): Promise<void> {
    const ch = g.channel!;
    const owners = this.chat.agent.linkOwners(ch.linkConnId!).filter((o) => b64url(o.ownerId) !== m.memberId);
    if (add) {
      const ownerId = fromB64(m.memberId);
      const ownerKey: PublicKey<'ed25519'> = { alg: 'ed25519', key: fromB64(m.key!) };
      owners.push({ ownerId, ownerKey, sig: sign({ alg: 'ed25519', key: fromB64(ch.memberKey.priv) }, concat(ownerId, encodePubKey(ownerKey))) });
    }
    await this.chat.agent.updateLinkData(ch.linkConnId!, this.channelLinkData(g), { owners });
  }

  /**
   * a role in a channel (APIMembersRole): members, moderators and admins are in the roster, which the
   * relays get at its next version before the change; owners are in the link too. These are for the
   * owner who made the channel to give; moderators and admins change only the roles below them
   */
  private async setChannelRole(g: Group, m: GroupMember, role: GroupMemberRole): Promise<void> {
    if (m.role === 'relay' || role === 'relay') throw new ChatError('the role of a relay cannot be changed');
    if (m.role === role) return;
    if ((privileged(role) || privileged(m.role)) && !this.isChannelCreator(g)) throw new ChatError('only the owner who made the channel gives the roles of members, moderators, admins and owners');
    if (g.status !== 'active' || roleRank(g.role) < roleRank(roleToChange(m.role, role))) throw new ChatError(`you cannot change this role to ${role}`);
    if (privileged(role) && !m.key) throw new ChatError('the key of this subscriber is not known yet: it comes from the relays when they announce the subscriber');
    const from = m.role;
    const rosterChange = isRosterRole(role) || isRosterRole(from);
    m.role = role;
    try {
      if (rosterChange && encodeRoster(this.rosterEntries(g)).length > MAX_SENT_ROSTER_BYTES) throw new ChatError('a channel has at most about 200 members, moderators and admins');
      if (role === 'owner' || from === 'owner') await this.setLinkOwner(g, m, role === 'owner');
    } catch (e) {
      m.role = from;
      throw e;
    }
    const v = rosterChange ? await this.nextRoster(g) : undefined;
    const memberKey = m.key && (v !== undefined || role === 'owner') ? x509Key(m.key) : undefined;
    await this.sendChannel(g, xGrpMemRole(m.memberId, role, newSharedMsgId(), { memberKey, rosterVersion: v }));
    await this.save(g);
    await this.event(g, `you changed the role of ${memberName(m)} to ${role}`, m.memberId);
  }

  /** removing a subscriber (admins), or a member, moderator, admin or owner (the owner who made the channel) */
  private async removeChannelMember(g: Group, m: GroupMember): Promise<void> {
    if (m.role === 'relay') throw new ChatError('relays are not removed this way');
    if (privileged(m.role) && !this.isChannelCreator(g)) throw new ChatError('only the owner who made the channel removes its members, moderators, admins and owners');
    if (g.status !== 'active' || roleRank(g.role) < roleRank('admin') || roleRank(m.role) > roleRank(g.role)) throw new ChatError('you cannot remove this member');
    if (m.role === 'owner') await this.setLinkOwner(g, m, false);
    m.status = 'removed';
    const v = isRosterRole(m.role) ? await this.nextRoster(g) : undefined;
    await this.sendChannel(g, xGrpMemDel(m.memberId, newSharedMsgId(), false, v));
    if (g.role === 'owner') g.channel!.subscribers = Math.max(0, (g.channel!.subscribers ?? 1) - 1);
    await this.save(g);
    await this.event(g, `you removed ${memberName(m)}`, m.memberId);
  }

  // ---- group links (as an admin)

  async createLink(groupId: string, role: GroupMemberRole = 'member'): Promise<string> {
    const g = this.must(groupId);
    this.assertAdmin(g);
    if (g.link) return g.link.link;
    if (roleRank(role) > roleRank('member')) throw new ChatError('members joining via a link can be at most members');
    const groupLinkId = newGroupLinkId();
    const r = await this.chat.agent.createAddress({ userData: groupShortLinkData(g.profile), clientData: groupLinkClientData(groupLinkId), linkType: 'G' });
    g.link = { connId: r.connId, link: r.link, groupLinkId, role };
    this.links.set(r.connId, g.id);
    await this.save(g);
    return r.link;
  }

  async deleteLink(groupId: string): Promise<void> {
    const g = this.must(groupId);
    const l = g.link;
    if (!l) return;
    g.link = undefined;
    this.links.delete(l.connId);
    await this.save(g);
    await this.chat.agent.deleteConnection(l.connId).catch(() => {});
  }

  /** a request via our group link: accepted as a new member with x.grp.link.inv */
  private async onLinkRequest(g: Group, e: Extract<AgentEvent, { type: 'REQ' }>): Promise<void> {
    const msg = this.chat.parseInfo(e.connInfo);
    const profile = (msg?.event === 'x.contact' || msg?.event === 'x.info') && msg.params.profile ? (msg.params.profile as Profile) : undefined;
    if (!profile || !g.link || g.status !== 'active' || roleRank(g.role) < roleRank('admin')) {
      await this.chat.agent.rejectRequest(e.connId, e.invId).catch(() => {});
      return;
    }
    const m: GroupMember = { memberId: newMemberId(), role: g.link.role, profile: memberProfile(profile), category: 'invitee', status: 'accepted', invitedBy: g.memberId, viaLink: true, v: msg?.v, createdAt: Date.now() };
    if (typeof msg?.params.welcomeMsgId === 'string') m.welcomeMsgId = msg.params.welcomeMsgId;
    // the member learns that it waits from the group profile, and from x.grp.link.acpt once connected
    if (reviewsMembers(g)) m.review = true;
    const gli: GroupLinkInvitation = {
      fromMember: { memberId: g.memberId, memberRole: g.role },
      fromMemberName: this.ourProfile(g).displayName,
      invitedMember: { memberId: m.memberId, memberRole: m.role },
      groupProfile: g.profile,
      accepted: 'accepted',
      groupSize: this.currentMembers(g).length + 1,
    };
    const connInfo = this.chat.encodeInfo(xGrpLinkInv(gli), false);
    // the request is accepted outside of the event handler, which holds the address's lock
    setTimeout(async () => {
      try {
        const connId = await this.chat.agent.acceptRequest(e.connId, e.invId, connInfo, { pq: false });
        g.members[m.memberId] = m;
        this.setConn(g, m, connId);
        await this.save(g);
        await this.event(g, `${memberName(m)} is joining via the group link…`, m.memberId);
      } catch (err) {
        console.warn('accepting a member failed', err);
      }
    }, 0);
  }

  // ---- introductions (as an admin)

  /** a new member is connected: it is announced to the members, and they are introduced to it */
  private async introduceToAll(g: Group, n: GroupMember): Promise<void> {
    g.intros ??= {};
    for (const m of this.activeMembers(g)) {
      if (m.memberId === n.memberId || m.status !== 'connected' || !m.connId || m.memberId === HOST_PLACEHOLDER) continue;
      // after a review: the moderators know the member already
      if (g.intros[pairKey(n.memberId, m.memberId)]) continue;
      try {
        await this.sendTo(m, xGrpMemNew(this.infoOf(n), newSharedMsgId()));
        await this.sendTo(n, xGrpMemIntro(this.infoOf(m)));
        g.intros[pairKey(n.memberId, m.memberId)] = 'sent';
      } catch (e) {
        console.warn('introduction failed', e);
      }
    }
    await this.save(g);
  }

  /**
   * a member who joined via a link that needs a review (introduceToModerators of the apps): it learns
   * that it waits, and is introduced to the moderators only, to chat with them
   */
  private async introduceToModerators(g: Group, n: GroupMember): Promise<void> {
    g.intros ??= {};
    await this.sendTo(n, (n.v?.max ?? 0) >= GROUP_KNOCKING_VERSION ? xGrpLinkAcpt('pending_review', n.role, n.memberId) : xMsgNew(newSharedMsgId(), { content: { type: 'text', text: PENDING_REVIEW_MESSAGE } }));
    for (const m of this.supportMembers(g, n.memberId)) {
      if (m.memberId === n.memberId || m.status !== 'connected' || !m.connId || (m.v?.max ?? 0) < GROUP_KNOCKING_VERSION) continue;
      try {
        await this.sendTo(m, xGrpMemNew(this.infoOf(n), newSharedMsgId(), memberScope(n.memberId)));
        await this.sendTo(n, xGrpMemIntro(this.infoOf(m)));
        g.intros[pairKey(n.memberId, m.memberId)] = 'sent';
      } catch (e) {
        console.warn('introduction failed', e);
      }
    }
    await this.save(g);
  }

  /** a member we added was accepted after its review: the others meet it, and it gets the history */
  private async welcomeAccepted(g: Group, n: GroupMember): Promise<void> {
    n.acceptedAt = Date.now();
    await this.introduceToAll(g, n);
    if (groupPrefOn(g.profile, 'history')) await this.sendHistory(g, n).catch((e) => console.warn('sending the history failed', e));
  }

  /**
   * the recent messages of the group, for a member who joined (sendHistory of the apps): forwarded
   * with their authors and times, with the files that can still be downloaded, then the welcome
   * message. Our messages sent after the member was added reached it directly. A long history takes
   * a while: the member's queue holds a limited number of messages, and sending continues as the
   * member receives them.
   */
  private async sendHistory(g: Group, n: GroupMember): Promise<void> {
    if (!n.connId) return;
    const all = await this.chat.chatItems(g.id);
    const limit = g.historySize ?? HISTORY_ITEMS;
    const recent = all.filter((it) => it.sharedMsgId && (it.dir === 'rcv' || (it.dir === 'snd' && it.status !== 'error' && it.ts < (n.acceptedAt ?? n.createdAt))) && !it.deleted && it.content?.type !== 'report');
    const items = limit > 0 ? recent.slice(-limit) : recent;
    const bySharedId = new Map(all.map((it) => [it.sharedMsgId, it]));
    const msgs: ChatMessage[] = [];
    for (const it of items) {
      const author = it.dir === 'snd' ? { memberId: g.memberId, name: this.ourProfile(g).displayName } : g.members[it.memberId ?? ''] && { memberId: it.memberId!, name: memberName(g.members[it.memberId!]) };
      if (!author || (it.dir === 'rcv' && g.members[author.memberId].blocked)) continue;
      const file = await this.chat.historyFile(it);
      const text = (it.content as { text?: unknown }).text;
      if (!file && !(typeof text === 'string' && text.trim())) continue;
      const mc: MsgContainer = { content: it.content };
      if (it.quote?.sharedMsgId) {
        const quoted = it.quote.sent ? g.memberId : it.quote.memberId;
        const q = bySharedId.get(it.quote.sharedMsgId);
        mc.quote = {
          msgRef: { msgId: it.quote.sharedMsgId, sentAt: new Date(q ? (q.brokerTs ?? q.ts) : (it.brokerTs ?? it.ts)).toISOString(), sent: quoted === g.memberId, ...(quoted ? { memberId: quoted } : {}) },
          content: { type: 'text', text: it.quote.text },
        };
      }
      if (file) mc.file = file.inv;
      const ttl = it.ttl ?? (it.deleteAt ? Math.round((it.deleteAt - it.ts) / 1000) : 0);
      if (ttl > 0) mc.ttl = ttl;
      if (it.forwarded) mc.forward = true;
      const ts = it.brokerTs ?? it.ts;
      const fwd = (msg: ChatMessage) => xGrpMsgForward(author.memberId, fwdMemberName(author.name), ts, msg);
      let m = fwd(xMsgNew(it.sharedMsgId!, mc));
      // a preview with a long caption may not fit when forwarded: then the small preview of the apps
      if (encodeChatMessage(m).length > MAX_ENCODED_MSG_LENGTH && typeof (mc.content as { image?: unknown }).image === 'string') {
        m = fwd(xMsgNew(it.sharedMsgId!, { ...mc, content: { ...mc.content, image: FIXED_IMAGE_PREVIEW } }));
      }
      msgs.push(m);
      for (const part of file?.parts ?? []) msgs.push(fwd(xMsgFileDescr(newSharedMsgId(), it.sharedMsgId!, part, file!.expires)));
    }
    const welcome = g.profile.description?.trim();
    if (welcome && !n.welcomeMsgId) msgs.push(xMsgNew(newSharedMsgId(), { content: { type: 'text', text: g.profile.description! } }));
    if (!msgs.length) return;
    const { bodies, dropped } = jsonBatches(msgs.map(encodeChatMessage), MAX_ENCODED_MSG_LENGTH, (n.v?.max ?? COMPRESSION_CHAT_VERSION) >= COMPRESSION_CHAT_VERSION);
    if (dropped) console.warn(`the history of the group: ${dropped} messages are too large`);
    for (const body of bodies) await this.deliver(n.connId, body, false, false);
  }

  /**
   * forwards a member's message to the members it is not connected to yet; a message in the chat of
   * a member with the moderators only to them
   */
  private async forward(g: Group, s: GroupMember, msg: ChatMessage, brokerTs: number): Promise<void> {
    if (roleRank(g.role) < roleRank('admin') || !g.intros || !isForwardedGroupMsg(msg)) return;
    const scope = scopeMemberId(msg.params);
    for (const m of scope ? this.supportMembers(g, scope) : this.activeMembers(g)) {
      if (m.memberId === s.memberId || m.status !== 'connected') continue;
      const st = g.intros[pairKey(s.memberId, m.memberId)];
      if (!st || st === 'connected') continue;
      await this.sendTo(m, xGrpMsgForward(s.memberId, fwdMemberName(memberName(s)), brokerTs, msg)).catch((e) => console.warn('forwarding failed', e));
    }
  }

  // ---- agent events of member connections

  async onAgentEvent(e: AgentEvent): Promise<MsgResult | void> {
    if (DEBUG && e.type !== 'MSG') console.log(`[groups] ${e.type}`, 'connId' in e ? e.connId : '', e.type === 'ERR' ? e.err : '');
    if (e.type === 'REQ') {
      const g = this.groups[this.links.get(e.connId) ?? ''];
      if (g) await this.onLinkRequest(g, e);
      return;
    }
    if (!('connId' in e) || !e.connId) return;
    const r = this.byConn(e.connId);
    if (!r) return;
    const { g, m } = r;
    if (g.channel) return this.onChannelEvent(g, m, e);
    switch (e.type) {
      case 'CONF':
        return this.onConf(g, m, e.connInfo);
      case 'INFO':
        return this.onInfo(g, m, e.connInfo);
      case 'CON':
        return this.onCon(g, m);
      case 'MSG':
        return this.onMsg(g, m, e);
      case 'END':
        this.chat.emitError(`${groupName(g)}: the connection is used by another client (is Duplex open in another tab?)`);
        return;
      default:
        return;
    }
  }

  /** the confirmation of a member who joined our invitation */
  private async onConf(g: Group, m: GroupMember, connInfo: Bytes): Promise<MsgResult | void> {
    const msg = this.chat.parseInfo(connInfo);
    if (!msg) return;
    if (msg.v) m.v = msg.v;
    const allow = () => ({ allow: this.chat.encodeInfo(xGrpMemInfo(g.memberId, this.ourProfile(g)), false) });
    if (m.category === 'invitee' && msg.event === 'x.grp.acpt' && normMemberId(msg.params.memberId) === m.memberId) {
      m.status = 'accepted';
      if (msg.params.profile) m.profile = memberProfile(msg.params.profile as Profile);
      await this.save(g);
      return allow();
    }
    if (m.category === 'pre' && msg.event === 'x.grp.mem.info' && normMemberId(msg.params.memberId) === m.memberId) {
      if (msg.params.profile) m.profile = memberProfile(msg.params.profile as Profile);
      await this.save(g);
      return allow();
    }
    // joining via a group link: the admin's answer
    if (m.memberId === HOST_PLACEHOLDER && msg.event === 'x.grp.link.inv') return this.onLinkInvitation(g, m, msg);
    if (m.memberId === HOST_PLACEHOLDER && msg.event === 'x.grp.link.reject') {
      g.status = 'rejected';
      await this.save(g);
      await this.event(g, `the group rejected your request to join${msg.params.groupLinkRejection?.rejectionReason ? `: ${msg.params.groupLinkRejection.rejectionReason}` : ''}`);
      return { allow: this.chat.encodeInfo(xInfo(this.ourProfile(g)), false) };
    }
    console.warn('unexpected confirmation in a group', msg.event);
  }

  private async onLinkInvitation(g: Group, placeholder: GroupMember, msg: ChatMessage): Promise<MsgResult | void> {
    const gli = msg.params.groupLinkInvitation as GroupLinkInvitation | undefined;
    const hostId = normMemberId(gli?.fromMember?.memberId);
    const ourId = normMemberId(gli?.invitedMember?.memberId);
    if (!gli || !hostId || !ourId || hostId === ourId) return;
    if (gli.groupProfile?.publicGroup) {
      g.status = 'rejected';
      await this.save(g);
      await this.event(g, 'this is a channel — channels are not supported yet');
      return;
    }
    delete g.members[HOST_PLACEHOLDER];
    const host: GroupMember = { ...placeholder, memberId: hostId, role: gli.fromMember.memberRole, profile: { displayName: gli.fromMemberName || 'host', fullName: '' }, v: msg.v };
    g.members[hostId] = host;
    g.hostMemberId = hostId;
    if (host.connId) this.setConn(g, host, host.connId);
    g.memberId = ourId;
    g.role = gli.invitedMember.memberRole;
    if (gli.groupProfile?.displayName) g.profile = gli.groupProfile;
    // acceptanceToStatus of the apps: a group that reviews new members says so in its profile
    g.status = gli.accepted === 'pending' || gli.accepted === 'pending_review' || reviewsMembers(g) ? 'pending' : 'connecting';
    await this.save(g);
    if (g.status === 'pending') await this.event(g, reviewsMembers(g) ? 'the moderators of this group review new members: you can chat with them until they accept you' : 'please wait for the group admins to accept you');
    return { allow: this.chat.encodeInfo(xInfo(this.ourProfile(g)), false) };
  }

  /** the information of a member whose invitation we joined */
  private async onInfo(g: Group, m: GroupMember, connInfo: Bytes): Promise<void> {
    const msg = this.chat.parseInfo(connInfo);
    if (!msg) return;
    if (msg.v) m.v = msg.v;
    const sameId = !msg.params.memberId || normMemberId(msg.params.memberId) === m.memberId;
    if ((msg.event === 'x.grp.mem.info' && sameId) || msg.event === 'x.info') {
      if (msg.params.profile) m.profile = memberProfile(msg.params.profile as Profile);
      await this.save(g);
    }
  }

  private async onCon(g: Group, m: GroupMember): Promise<void> {
    m.status = 'connected';
    this.sendPending(m);
    await this.save(g);
    switch (m.category) {
      case 'host':
        if (g.status === 'connecting') g.status = 'active';
        await this.save(g);
        await this.event(g, g.status === 'pending' ? `connected to ${memberName(m)} — waiting to be accepted` : 'you joined the group');
        if (g.status !== 'pending') await this.localWelcome(g, m);
        return;
      case 'invitee':
        if (m.viaLink) await this.sendTo(m, xGrpLinkMem(this.ourProfile(g), newSharedMsgId()));
        if (m.review) {
          await this.event(g, `${memberName(m)} wants to join: accept or reject them in the group info`, m.memberId);
          await this.supportEvent(g, m.memberId, `${memberName(m)} wants to join the group`);
          await this.introduceToModerators(g, m);
          return;
        }
        await this.event(g, `${memberName(m)} joined`, m.memberId);
        await this.introduceToAll(g, m);
        if (groupPrefOn(g.profile, 'history')) await this.sendHistory(g, m).catch((e) => console.warn('sending the history failed', e));
        return;
      default: {
        // no event in the chat: the members list shows who is still connecting. The admin who
        // introduced us stops forwarding between us
        const inviter = g.members[(m.category === 'pre' ? g.hostMemberId : m.invitedBy) ?? ''];
        if (inviter?.connId && !memberGone(inviter)) await this.sendTo(inviter, xGrpMemCon(m.memberId)).catch(() => {});
        await this.save(g);
      }
    }
  }

  private async onMsg(g: Group, m: GroupMember, e: Extract<AgentEvent, { type: 'MSG' }>): Promise<MsgResult> {
    const brokerTs = e.brokerTs * 1000;
    for (const pm of parseChatMessages(e.body)) {
      if (!pm.msg) {
        console.warn('group message error', pm.error);
        continue;
      }
      const msg = pm.msg;
      if (msg.v) m.v = msg.v;
      if (DEBUG) console.log(`[group ${groupName(g)}] from ${memberName(m)}: ${pm.forward ? 'forwarded ' : ''}${msg.event}`, JSON.stringify(msg.params).slice(0, 200));
      try {
        if (pm.forward) await this.onForwarded(g, m, pm.forward, msg);
        else if (msg.event === 'x.grp.msg.forward') {
          const inner = msg.params.msg;
          const parsed = inner && typeof inner === 'object' ? parseChatMessages(new TextEncoder().encode(JSON.stringify(inner)))[0]?.msg : undefined;
          if (parsed) await this.onForwarded(g, m, { memberId: msg.params.memberId, memberName: msg.params.memberName, brokerTs: Date.parse(msg.params.msgTs) || brokerTs }, parsed);
        } else {
          await this.processEvent(g, m, msg, brokerTs);
          if (!memberGone(m) || msg.event === 'x.grp.leave') await this.forward(g, m, msg, brokerTs);
        }
      } catch (err) {
        console.warn('group message processing error', msg.event, err);
      }
    }
    await this.save(g);
    return {};
  }

  private async onForwarded(g: Group, by: GroupMember, fwd: { memberId?: string; memberName?: string; brokerTs: number }, msg: ChatMessage): Promise<void> {
    if (roleRank(by.role) < roleRank('admin')) return console.warn('a message forwarded by a member who is not an admin');
    const id = normMemberId(fwd.memberId);
    if (!id || id === g.memberId || !isForwardedGroupMsg(msg)) return;
    let s = g.members[id];
    if (!s) {
      s = { memberId: id, role: 'member', profile: { displayName: fwd.memberName || 'member', fullName: '' }, category: 'post', status: 'unknown', invitedBy: by.memberId, createdAt: Date.now() };
      g.members[id] = s;
    }
    await this.processEvent(g, s, msg, fwd.brokerTs || Date.now(), true);
  }

  /**
   * the chat of a content message: the group, or the chat of a member with the moderators (scope).
   * Members waiting for a review write only there; file descriptions and cancellations have no scope,
   * and go with the message of their file.
   */
  private async contentChat(g: Group, s: GroupMember, msg: ChatMessage): Promise<string | undefined> {
    const scope = scopeMemberId(msg.params);
    if (scope) {
      // moderators have the chats of all members, members only their own
      if (scope !== g.memberId && !isModerator(g.role)) return undefined;
      // the member and the moderators write there
      if (s.memberId !== scope && !isModerator(s.role)) return undefined;
      this.touchSupport(g, scope);
      return supportChatId(g.id, scope);
    }
    if (msg.event === 'x.msg.file.descr' || msg.event === 'x.file.cancel') {
      const ref = msg.params.msgId;
      const chats = [g.id, supportChatId(g.id, s.memberId), supportChatId(g.id, g.memberId), ...Object.keys(g.support ?? {}).map((id) => supportChatId(g.id, id))];
      for (const id of chats) if ((await this.chat.chatItems(id)).some((i) => i.dir === 'rcv' && i.sharedMsgId === ref && i.memberId === s.memberId)) return id;
      return g.id;
    }
    return s.review ? undefined : g.id;
  }

  /**
   * the welcome message, from the admin who added us, as the apps show it (maybeCreateGroupDescrLocal);
   * with the history of the group, the admin sends it after the history
   */
  private async localWelcome(g: Group, host: GroupMember): Promise<void> {
    if (!g.profile.description?.trim() || groupPrefOn(g.profile, 'history')) return;
    await this.chat.addItem(g.id, { id: localId(), dir: 'rcv', memberId: host.memberId, content: { type: 'text', text: g.profile.description }, ts: Date.now(), status: 'received' });
  }

  /** may this member introduce or announce a member with this role (checkHostRole) */
  private canIntroduce(s: GroupMember, role: GroupMemberRole): boolean {
    return roleRank(s.role) >= roleRank('admin') && roleRank(s.role) >= roleRank(role);
  }

  private async processEvent(g: Group, s: GroupMember, msg: ChatMessage, brokerTs: number, forwarded = false): Promise<void> {
    const p = msg.params;
    switch (msg.event) {
      case 'x.msg.new':
      case 'x.msg.update':
      case 'x.msg.del':
      case 'x.msg.react':
      case 'x.msg.file.descr':
      case 'x.file.cancel': {
        if (s.blocked && msg.event === 'x.msg.new') return;
        const chatId = await this.contentChat(g, s, msg);
        if (!chatId) return;
        const support = chatId === g.id ? undefined : parseSupportChatId(chatId)!.memberId;
        await this.chat.processContent({ chatId, group: g, sender: s, support }, msg, { brokerTs, forwarded });
        return;
      }
      case 'x.info':
        if (p.profile) {
          s.profile = memberProfile(p.profile as Profile);
          if (s.status === 'unknown') s.status = 'announced';
        }
        return;
      case 'x.grp.link.mem':
        if (s.memberId === g.hostMemberId && p.profile) s.profile = memberProfile(p.profile as Profile);
        return;
      case 'x.grp.link.acpt': {
        // the admin who added us, or a moderator after a review (xGrpLinkAcpt of the apps)
        const id = normMemberId(p.memberId);
        const role = typeof p.role === 'string' ? (p.role as GroupMemberRole) : undefined;
        if (!id || (s.memberId !== g.hostMemberId && !isModerator(s.role)) || (role && roleRank(role) > roleRank(s.role))) return;
        if (id === g.memberId) {
          if (p.acceptance === 'pending_review') {
            if (g.status !== 'pending') {
              g.status = 'pending';
              await this.event(g, 'the moderators of this group review new members: you can chat with them until they accept you');
            }
            return;
          }
          if (p.acceptance !== 'accepted' || g.status !== 'pending') return;
          if (role) g.role = role;
          g.status = 'active';
          await this.event(g, `${memberName(s)} accepted you`, s.memberId);
          const host = g.members[g.hostMemberId ?? ''];
          if (host) await this.localWelcome(g, host);
          if (g.support?.[g.memberId]) await this.supportEvent(g, g.memberId, `${memberName(s)} accepted you`);
          return;
        }
        // another moderator accepted a member waiting for a review
        const t = g.members[id];
        if (!t?.review || memberGone(t) || p.acceptance !== 'accepted') return;
        t.review = false;
        if (role) t.role = role;
        await this.event(g, `${memberName(s)} accepted ${memberName(t)}`, s.memberId);
        await this.supportEvent(g, t.memberId, `${memberName(s)} accepted ${memberName(t)}`);
        if (t.category === 'invitee') await this.welcomeAccepted(g, t);
        return;
      }
      case 'x.grp.mem.new': {
        const mi = p.memberInfo as MemberInfo | undefined;
        const id = normMemberId(mi?.memberId);
        if (!mi || !id || !mi.profile || id === g.memberId || !this.canIntroduce(s, mi.memberRole)) return;
        const ex = g.members[id];
        if (ex && ex.status !== 'unknown') return;
        // to the moderators: a member who waits for their review
        const review = scopeMemberId(p) === id;
        g.members[id] = { ...(ex ?? {}), memberId: id, role: mi.memberRole, profile: memberProfile(mi.profile), v: parseVRSafe(mi.v), category: 'post', status: 'announced', invitedBy: s.memberId, createdAt: ex?.createdAt ?? Date.now(), ...(review ? { review: true } : {}) };
        if (review) {
          await this.event(g, `${profileName(mi.profile)} wants to join: accept or reject them in the group info`, id);
          await this.supportEvent(g, id, `${profileName(mi.profile)} wants to join the group`);
        } else await this.event(g, `${memberName(s)} added ${profileName(mi.profile)}`, s.memberId);
        return;
      }
      case 'x.grp.mem.intro': {
        // the admin who added us introduces a member, who joins the invitation we send back
        const mi = p.memberInfo as MemberInfo | undefined;
        const id = normMemberId(mi?.memberId);
        if (!mi || !id || !mi.profile || s.memberId !== g.hostMemberId || roleRank(s.role) < roleRank('admin')) return;
        if (g.members[id] || id === g.memberId || !mi.v) return;
        const r = await this.chat.agent.createInvitation({ shortLink: false, pq: false });
        const m: GroupMember = { memberId: id, role: mi.memberRole, profile: memberProfile(mi.profile), v: parseVRSafe(mi.v), category: 'pre', status: 'introduced', invitedBy: s.memberId, createdAt: Date.now() };
        g.members[id] = m;
        this.setConn(g, m, r.connId);
        await this.sendTo(s, xGrpMemInv(id, r.fullLink));
        m.status = 'introInvited';
        return;
      }
      case 'x.grp.mem.inv': {
        // a member we added sends the invitation for a member we introduced to it
        const id = normMemberId(p.memberId);
        const to = id ? g.members[id] : undefined;
        const req = p.memberIntro?.groupConnReq;
        if (s.category !== 'invitee' || !to || typeof req !== 'string' || memberGone(to)) return;
        await this.sendTo(to, xGrpMemFwd(this.infoOf(s), req));
        (g.intros ??= {})[pairKey(s.memberId, to.memberId)] = 'forwarded';
        return;
      }
      case 'x.grp.mem.fwd': {
        // an admin forwards the invitation of a new member: we join it
        const mi = p.memberInfo as MemberInfo | undefined;
        const id = normMemberId(mi?.memberId);
        const req = p.memberIntro?.groupConnReq;
        if (!mi || !id || typeof req !== 'string' || id === g.memberId || !this.canIntroduce(s, mi.memberRole)) return;
        let n = g.members[id];
        if (!n) {
          n = { memberId: id, role: mi.memberRole, profile: memberProfile(mi.profile), category: 'post', status: 'announced', invitedBy: s.memberId, createdAt: Date.now() };
          g.members[id] = n;
        }
        if (memberGone(n) || n.connId || (n.invitedBy !== s.memberId && n.status !== 'unknown')) return;
        n.invitedBy = s.memberId;
        if (mi.profile) n.profile = memberProfile(mi.profile);
        n.v = parseVRSafe(mi.v) ?? n.v;
        const connInfo = this.chat.encodeInfo(xGrpMemInfo(g.memberId, this.ourProfile(g)), false);
        const connId = await this.chat.agent.joinConnection(req, connInfo, { pq: false });
        this.setConn(g, n, connId);
        n.status = 'introInvited';
        return;
      }
      case 'x.grp.mem.con': {
        const id = normMemberId(p.memberId);
        if (id && g.intros?.[pairKey(s.memberId, id)]) g.intros[pairKey(s.memberId, id)] = 'connected';
        return;
      }
      case 'x.grp.mem.role': {
        const id = normMemberId(p.memberId);
        const role = p.role as GroupMemberRole;
        if (!id || typeof role !== 'string') return;
        const target = id === g.memberId ? undefined : g.members[id];
        const current = target ? target.role : g.role;
        if (roleRank(s.role) < roleRank('admin') || roleRank(s.role) < roleRank(role) || roleRank(s.role) < roleRank(current)) return;
        if (!target) {
          g.role = role;
          await this.event(g, `${memberName(s)} changed your role to ${role}`, s.memberId);
        } else {
          target.role = role;
          await this.event(g, `${memberName(s)} changed the role of ${memberName(target)} to ${role}`, s.memberId);
        }
        return;
      }
      case 'x.grp.mem.restrict': {
        const id = normMemberId(p.memberId);
        const target = id ? g.members[id] : undefined;
        if (!target || roleRank(s.role) < roleRank('moderator') || roleRank(s.role) < roleRank(target.role)) return;
        target.blocked = p.memberRestrictions?.restriction === 'blocked';
        await this.event(g, `${memberName(s)} ${target.blocked ? 'blocked' : 'unblocked'} ${memberName(target)}`, s.memberId);
        return;
      }
      case 'x.grp.mem.del': {
        const id = normMemberId(p.memberId);
        if (!id) return;
        if (id === g.memberId) {
          if (roleRank(s.role) < roleRank('admin') || roleRank(s.role) < roleRank(g.role)) return;
          g.status = 'removed';
          await this.event(g, `${memberName(s)} removed you from the group`, s.memberId);
          this.later(() => this.dropConnections(g, 0));
          return;
        }
        const target = g.members[id];
        if (!target || memberGone(target) || roleRank(s.role) < roleRank('admin') || roleRank(s.role) < roleRank(target.role)) return;
        target.status = 'removed';
        await this.event(g, `${memberName(s)} removed ${memberName(target)}`, s.memberId);
        this.later(() => this.dropMember(target, 0));
        return;
      }
      case 'x.grp.leave':
        if (memberGone(s)) return;
        s.status = 'left';
        await this.event(g, `${memberName(s)} left`, s.memberId);
        // after the admin forwards it
        this.later(() => this.dropMember(s, 3000));
        return;
      case 'x.grp.del':
        if (s.role !== 'owner') return;
        g.status = 'deleted';
        await this.event(g, `${memberName(s)} deleted the group`, s.memberId);
        this.later(() => this.dropConnections(g, 0));
        return;
      case 'x.grp.info': {
        const gp = p.groupProfile as GroupProfile | undefined;
        if (s.role !== 'owner' || !gp?.displayName) return;
        g.profile = gp;
        await this.event(g, `${memberName(s)} updated the group profile`, s.memberId);
        return;
      }
      case 'x.grp.prefs':
        if (s.role === 'owner' && p.groupPreferences && typeof p.groupPreferences === 'object') g.profile = { ...g.profile, groupPreferences: p.groupPreferences };
        return;
      case 'x.grp.direct.inv':
        await this.event(g, `${memberName(s)} wants to connect directly — direct connections with members are not supported yet`, s.memberId);
        return;
      case 'x.grp.inv':
        await this.event(g, `${memberName(s)} invited you to another group — accept invitations from your contacts`, s.memberId);
        return;
      case 'x.info.probe':
      case 'x.info.probe.check':
      case 'x.info.probe.ok':
      case 'x.ok':
        return;
      default:
        console.warn('unsupported group message', msg.event);
    }
  }

  // ---- leaving, removing, deleting

  /** after the current event handler (which holds its connection's lock) */
  private later(f: () => Promise<void>): void {
    setTimeout(() => f().catch((e) => console.warn('group connection cleanup', e)), 0);
  }

  /** deletes a member's connection, after the queued messages are sent */
  private async dropMember(m: GroupMember, drainMs: number): Promise<void> {
    const connId = m.connId;
    if (!connId) return;
    if (drainMs) await this.chat.agent.drain(connId, drainMs);
    m.connId = undefined;
    m.pending = undefined;
    this.conns.delete(connId);
    await this.chat.saveState();
    await this.chat.agent.deleteConnection(connId).catch(() => {});
  }

  private async dropConnections(g: Group, drainMs: number): Promise<void> {
    if (g.link) {
      const l = g.link;
      g.link = undefined;
      this.links.delete(l.connId);
      await this.chat.agent.deleteConnection(l.connId).catch(() => {});
    }
    await Promise.all(this.members(g).map((m) => this.dropMember(m, drainMs)));
  }

  async leave(groupId: string): Promise<void> {
    const g = this.must(groupId);
    if (!groupActive(g)) return;
    await this.send(g, xGrpLeave(newSharedMsgId())).catch(() => 0);
    g.status = 'left';
    await this.save(g);
    await this.event(g, g.channel ? 'you left the channel' : 'you left the group');
    void this.dropConnections(g, 10000);
  }

  async removeMember(groupId: string, memberId: string): Promise<void> {
    const g = this.must(groupId);
    const m = g.members[memberId];
    if (g.channel && m && !memberGone(m)) return this.removeChannelMember(g, m);
    this.assertAdmin(g);
    if (!m || memberGone(m)) return;
    if (roleRank(m.role) > roleRank(g.role)) throw new ChatError('you cannot remove a member with a higher role');
    // to all members, the removed one too
    await this.send(g, xGrpMemDel(memberId, newSharedMsgId()));
    m.status = 'removed';
    await this.save(g);
    await this.event(g, `you removed ${memberName(m)}`, memberId);
    void this.dropMember(m, 10000);
  }

  /**
   * a moderator accepts a member who joined via a link that needs a review (APIAcceptMember): the
   * member and the moderators learn it, and the admin who added the member introduces it to the others
   */
  async acceptMember(groupId: string, memberId: string, role?: GroupMemberRole): Promise<void> {
    const g = this.must(groupId);
    const m = g.members[memberId];
    if (g.status !== 'active' || !isModerator(g.role)) throw new ChatError('only moderators accept new members');
    if (!m?.review || memberGone(m)) throw new ChatError('this member is not waiting for a review');
    const r = role ?? m.role;
    // as for roles: moderators accept members up to their own role
    if (roleRank(r) > roleRank(g.role) || roleRank(r) < 0) throw new ChatError(`you cannot accept a member as ${r}`);
    await this.sendSupport(g, memberId, xGrpLinkAcpt('accepted', r, memberId, newSharedMsgId()));
    if ((m.v?.max ?? 0) < GROUP_KNOCKING_VERSION) await this.sendTo(m, xMsgNew(newSharedMsgId(), { content: { type: 'text', text: ACCEPTED_TO_GROUP_MESSAGE } })).catch(() => {});
    m.review = false;
    m.role = r;
    await this.save(g);
    await this.event(g, `you accepted ${memberName(m)}`, memberId);
    await this.supportEvent(g, memberId, `you accepted ${memberName(m)}`);
    if (m.category === 'invitee') await this.welcomeAccepted(g, m);
  }

  /** an admin rejects a member waiting for a review: only the member and the moderators know it */
  async rejectMember(groupId: string, memberId: string): Promise<void> {
    const g = this.must(groupId);
    const m = g.members[memberId];
    // as in the apps: moderators accept members, removing them takes an admin
    if (g.status !== 'active' || roleRank(g.role) < roleRank('admin')) throw new ChatError('only admins reject new members');
    if (!m?.review || memberGone(m)) return;
    await this.sendSupport(g, memberId, xGrpMemDel(memberId, newSharedMsgId()));
    m.status = 'removed';
    await this.save(g);
    await this.event(g, `you rejected ${memberName(m)}`, memberId);
    await this.supportEvent(g, memberId, `you rejected ${memberName(m)}`);
    void this.dropMember(m, 10000);
  }

  async setRole(groupId: string, memberId: string, role: GroupMemberRole): Promise<void> {
    const g = this.must(groupId);
    const m = g.members[memberId];
    if (!m || memberGone(m)) throw new ChatError('the member was not found');
    if (g.channel) return this.setChannelRole(g, m, role);
    this.assertAdmin(g);
    if (roleRank(role) < 0 || roleRank(role) > roleRank(g.role) || roleRank(m.role) > roleRank(g.role)) throw new ChatError(`you cannot change this role to ${role}`);
    await this.send(g, xGrpMemRole(memberId, role, newSharedMsgId()));
    m.role = role;
    await this.save(g);
    await this.event(g, `you changed the role of ${memberName(m)} to ${role}`, memberId);
  }

  /** a moderator blocks the messages of a member for everyone (APIBlockMembersForAll), or unblocks them */
  async blockMember(groupId: string, memberId: string, blocked: boolean): Promise<void> {
    const g = this.must(groupId);
    const m = g.members[memberId];
    if (!m || memberGone(m) || m.role === 'relay') throw new ChatError('the member was not found');
    if (g.status !== 'active' || !isModerator(g.role) || roleRank(m.role) > roleRank(g.role)) throw new ChatError(`you cannot ${blocked ? 'block' : 'unblock'} this member`);
    await this.send(g, xGrpMemRestrict(memberId, blocked, newSharedMsgId()), memberId);
    m.blocked = blocked;
    await this.save(g);
    await this.event(g, `you ${blocked ? 'blocked' : 'unblocked'} ${memberName(m)}`, memberId);
  }

  async updateProfile(groupId: string, patch: Partial<Pick<GroupProfile, 'displayName' | 'fullName' | 'description' | 'image' | 'groupPreferences' | 'memberAdmission'>>): Promise<void> {
    const g = this.must(groupId);
    if (g.status !== 'active' || g.role !== 'owner') throw new ChatError('only group owners can change the group profile');
    // the profile is in the channel link too, which only its maker updates (and the apps check the other owners' signatures only with keys from the link)
    if (g.channel && !this.isChannelCreator(g)) throw new ChatError('only the owner who made the channel changes its profile');
    const profile: GroupProfile = { ...g.profile, ...patch };
    for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined || patch[k] === '') delete profile[k];
    if (!profile.displayName?.trim()) throw new ChatError('the group needs a name');
    g.profile = profile;
    await this.send(g, xGrpInfo(profile, newSharedMsgId()));
    if (g.channel?.linkConnId) await this.publishRelays(g).catch((e) => console.warn('the channel link was not updated', e));
    if (g.link) await this.chat.agent.updateLinkData(g.link.connId, groupShortLinkData(profile)).catch(() => {});
    await this.event(g, 'you updated the group profile');
  }

  /** deletes the group: an owner of an active group deletes it for everyone */
  async delete(groupId: string, forEveryone = true): Promise<void> {
    const g = this.groups[groupId];
    if (!g) return;
    if (forEveryone && g.status === 'active' && g.role === 'owner' && (!g.channel || this.isChannelCreator(g))) await this.send(g, xGrpDel(newSharedMsgId())).catch(() => 0);
    else if (groupActive(g)) await this.send(g, xGrpLeave(newSharedMsgId())).catch(() => 0);
    await this.remove(g);
  }

  private async remove(g: Group): Promise<void> {
    delete this.groups[g.id];
    await this.chat.saveState();
    await this.chat.deleteChatItems(g.id);
    for (const id of Object.keys(g.support ?? {})) await this.chat.deleteChatItems(supportChatId(g.id, id));
    void this.dropConnections(g, 10000);
  }

  /** our profile changed: the groups where we are not incognito are told */
  async profileUpdated(): Promise<void> {
    for (const g of this.list()) {
      if (g.status === 'active' && !g.incognito) await this.send(g, xInfo(this.ourProfile(g), newSharedMsgId())).catch(() => 0);
    }
  }

  /** settings that only we see */
  async updateLocal(groupId: string, patch: Partial<Pick<Group, 'localAlias' | 'favorite' | 'muted' | 'historySize'>>): Promise<void> {
    const g = this.must(groupId);
    Object.assign(g, patch);
    await this.chat.saveState();
  }

  private must(id: string): Group {
    const g = this.groups[id];
    if (!g) throw new ChatError('group not found');
    return g;
  }
}
