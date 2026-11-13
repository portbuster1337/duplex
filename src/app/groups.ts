// Groups: the peer-to-peer groups of SimpleX Chat. Each member has a connection with each other
// member. An admin who adds a member introduces it to the others (x.grp.mem.intro, .inv, .fwd), and
// forwards messages between members that are not connected to each other yet (x.grp.msg.forward).
import type { AgentEvent, MsgResult, ResolvedLink } from '../core/agent/agent';
import {
  DEFAULT_GROUP_PREFERENCES,
  fwdMemberName,
  groupLinkClientData,
  groupPrefOn,
  groupShortLinkData,
  isForwardedGroupMsg,
  memberInfo,
  newGroupLinkId,
  newMemberId,
  normMemberId,
  roleRank,
  xGrpAcpt,
  xGrpDel,
  xGrpInfo,
  xGrpInv,
  xGrpLeave,
  xGrpLinkInv,
  xGrpLinkMem,
  xGrpMemCon,
  xGrpMemDel,
  xGrpMemFwd,
  xGrpMemInfo,
  xGrpMemIntro,
  xGrpMemInv,
  xGrpMemNew,
  xGrpMemRole,
  xGrpMsgForward,
  type GroupInvitation,
  type GroupLinkInvitation,
  type GroupMemberRole,
  type GroupProfile,
  type MemberInfo,
} from '../core/chat/groups';
import { COMPRESSION_CHAT_VERSION, compressToLimit, encodeChatMessage, jsonBatches, MAX_ENCODED_MSG_LENGTH, newSharedMsgId, parseChatMessages, xContact, xInfo, xMsgFileDescr, xMsgNew, type ChatMessage, type MsgContainer, type Profile } from '../core/chat/protocol';
import { b64, fromB64, type Bytes } from '../core/util/bytes';
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
  blocked?: boolean;
  /** messages kept until the connection is ready (base64) */
  pending?: string[];
  createdAt: number;
}

export type GroupStatus = 'invited' | 'joining' | 'connecting' | 'pending' | 'active' | 'left' | 'removed' | 'deleted' | 'rejected';

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
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const memberGone = (m: GroupMember): boolean => m.status === 'left' || m.status === 'removed';
export const memberName = (m?: GroupMember): string => profileName(m?.profile);
export const groupName = (g?: Group): string => g?.localAlias || g?.profile.displayName?.trim() || 'group';
export const groupActive = (g: Group): boolean => g.status === 'active' || g.status === 'connecting' || g.status === 'pending';

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

  canSend(g: Group): string | undefined {
    if (g.status === 'pending') return 'the group admins have not accepted you yet';
    if (g.status !== 'active' && g.status !== 'connecting') return g.status === 'invited' ? 'join the group first' : 'you are not a member of this group';
    if (roleRank(g.role) < roleRank('author')) return 'observers cannot send messages';
    return undefined;
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
    let n = 0;
    let err: unknown;
    for (const m of this.members(g)) {
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
    for (const m of this.currentMembers(g)) {
      if (m.memberId === n.memberId || m.status !== 'connected' || !m.connId || m.memberId === HOST_PLACEHOLDER) continue;
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
    const recent = all.filter((it) => it.sharedMsgId && (it.dir === 'rcv' || (it.dir === 'snd' && it.status !== 'error' && it.ts < n.createdAt)) && !it.deleted && it.content?.type !== 'report');
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

  /** forwards a member's message to the members it is not connected to yet */
  private async forward(g: Group, s: GroupMember, msg: ChatMessage, brokerTs: number): Promise<void> {
    if (roleRank(g.role) < roleRank('admin') || !g.intros || !isForwardedGroupMsg(msg)) return;
    for (const m of this.currentMembers(g)) {
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
    g.status = gli.accepted === 'pending' || gli.accepted === 'pending_review' ? 'pending' : 'connecting';
    await this.save(g);
    if (g.status === 'pending') await this.event(g, 'please wait for the group admins to accept you');
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
        // the welcome message, from the admin who added us (as the apps show it); with the history of
        // the group, the admin sends it after the history
        if (g.profile.description?.trim() && !groupPrefOn(g.profile, 'history')) {
          await this.chat.addItem(g.id, { id: localId(), dir: 'rcv', memberId: m.memberId, content: { type: 'text', text: g.profile.description }, ts: Date.now(), status: 'received' });
        }
        return;
      case 'invitee':
        await this.event(g, `${memberName(m)} joined`, m.memberId);
        if (m.viaLink) await this.sendTo(m, xGrpLinkMem(this.ourProfile(g), newSharedMsgId()));
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
      case 'x.file.cancel':
        if (s.blocked && msg.event === 'x.msg.new') return;
        await this.chat.processContent({ chatId: g.id, group: g, sender: s }, msg, { brokerTs, forwarded });
        return;
      case 'x.info':
        if (p.profile) {
          s.profile = memberProfile(p.profile as Profile);
          if (s.status === 'unknown') s.status = 'announced';
        }
        return;
      case 'x.grp.link.mem':
        if (s.memberId === g.hostMemberId && p.profile) s.profile = memberProfile(p.profile as Profile);
        return;
      case 'x.grp.link.acpt':
        if (s.memberId === g.hostMemberId && normMemberId(p.memberId) === g.memberId) {
          if (typeof p.role === 'string') g.role = p.role;
          if (g.status === 'pending') g.status = 'active';
          await this.event(g, `${memberName(s)} accepted you`, s.memberId);
        }
        return;
      case 'x.grp.mem.new': {
        const mi = p.memberInfo as MemberInfo | undefined;
        const id = normMemberId(mi?.memberId);
        if (!mi || !id || !mi.profile || id === g.memberId || !this.canIntroduce(s, mi.memberRole)) return;
        const ex = g.members[id];
        if (ex && ex.status !== 'unknown') return;
        g.members[id] = { ...(ex ?? {}), memberId: id, role: mi.memberRole, profile: memberProfile(mi.profile), v: parseVRSafe(mi.v), category: 'post', status: 'announced', invitedBy: s.memberId, createdAt: ex?.createdAt ?? Date.now() };
        await this.event(g, `${memberName(s)} added ${profileName(mi.profile)}`, s.memberId);
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
    await this.event(g, 'you left the group');
    void this.dropConnections(g, 10000);
  }

  async removeMember(groupId: string, memberId: string): Promise<void> {
    const g = this.must(groupId);
    this.assertAdmin(g);
    const m = g.members[memberId];
    if (!m || memberGone(m)) return;
    if (roleRank(m.role) > roleRank(g.role)) throw new ChatError('you cannot remove a member with a higher role');
    // to all members, the removed one too
    await this.send(g, xGrpMemDel(memberId, newSharedMsgId()));
    m.status = 'removed';
    await this.save(g);
    await this.event(g, `you removed ${memberName(m)}`, memberId);
    void this.dropMember(m, 10000);
  }

  async setRole(groupId: string, memberId: string, role: GroupMemberRole): Promise<void> {
    const g = this.must(groupId);
    this.assertAdmin(g);
    const m = g.members[memberId];
    if (!m || memberGone(m)) throw new ChatError('the member was not found');
    if (roleRank(role) < 0 || roleRank(role) > roleRank(g.role) || roleRank(m.role) > roleRank(g.role)) throw new ChatError(`you cannot change this role to ${role}`);
    await this.send(g, xGrpMemRole(memberId, role, newSharedMsgId()));
    m.role = role;
    await this.save(g);
    await this.event(g, `you changed the role of ${memberName(m)} to ${role}`, memberId);
  }

  async updateProfile(groupId: string, patch: Partial<Pick<GroupProfile, 'displayName' | 'fullName' | 'description' | 'image' | 'groupPreferences'>>): Promise<void> {
    const g = this.must(groupId);
    if (g.status !== 'active' || g.role !== 'owner') throw new ChatError('only group owners can change the group profile');
    const profile: GroupProfile = { ...g.profile, ...patch };
    for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined || patch[k] === '') delete profile[k];
    if (!profile.displayName?.trim()) throw new ChatError('the group needs a name');
    g.profile = profile;
    await this.send(g, xGrpInfo(profile, newSharedMsgId()));
    if (g.link) await this.chat.agent.updateLinkData(g.link.connId, groupShortLinkData(profile)).catch(() => {});
    await this.event(g, 'you updated the group profile');
  }

  /** deletes the group: an owner of an active group deletes it for everyone */
  async delete(groupId: string, forEveryone = true): Promise<void> {
    const g = this.groups[groupId];
    if (!g) return;
    if (forEveryone && g.status === 'active' && g.role === 'owner') await this.send(g, xGrpDel(newSharedMsgId())).catch(() => 0);
    else if (groupActive(g)) await this.send(g, xGrpLeave(newSharedMsgId())).catch(() => 0);
    await this.remove(g);
  }

  private async remove(g: Group): Promise<void> {
    delete this.groups[g.id];
    await this.chat.saveState();
    await this.chat.deleteChatItems(g.id);
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
