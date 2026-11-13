// Chat client: contacts, contact requests and chat items on top of the SMP agent, speaking the
// SimpleX Chat protocol with the official apps.
import { Agent, type AgentEvent, type ConnQueues, type MsgResult } from '../core/agent/agent';
import type { ProxyFallback, ProxyMode } from '../core/agent/network';
import type { Connector } from '../core/smp/client';
import { parseServer, type ProtocolServer, type ServerWithAuth } from '../core/smp/server';
import { fromUtf8Lossy, type Bytes } from '../core/util/bytes';
import { DEFAULT_XFTP_SERVERS, FLUX_XFTP_SERVERS } from '../core/agent/presets';
import { decodeFileDescription, encodeFileDescription } from '../core/xftp/description';
import { deleteUploadedFile, downloadFile, uploadFile } from '../core/xftp/file';
import { GB, MB, XFTPError } from '../core/xftp/protocol';
import { isShortLink, parseShortLink } from '../core/agent/shortlink';
import {
  CHAT_VERSIONS,
  contactShortLinkData,
  encodeChatMessage,
  COMPRESSION_CHAT_VERSION,
  compressToLimit,
  MAX_CONN_INFO_LENGTH,
  MAX_CONN_INFO_LENGTH_PQ,
  MAX_ENCODED_MSG_LENGTH,
  MAX_ENCODED_MSG_LENGTH_PQ,
  newSharedMsgId,
  parseChatMessages,
  parseShortLinkData,
  xContact,
  xDirectDel,
  xFileCancel,
  xInfo,
  xMsgDel,
  xMsgFileDescr,
  xMsgNew,
  xMsgReact,
  xMsgUpdate,
  type ChatMessage,
  type FileInvitation,
  type MsgContainer,
  type MsgContent,
  type Profile,
} from '../core/chat/protocol';
import { ADJECTIVES, NOUNS } from '../core/chat/names';
import { deletePieces, PieceWriter, piecesFor, storedSource } from './filestore';
import {
  AUTO_RECEIVE_IMAGE_SIZE,
  AUTO_RECEIVE_VIDEO_SIZE,
  cancelReason,
  checkDescription,
  FileManager,
  FIXED_IMAGE_PREVIEW,
  MAX_DESCR_LENGTH,
  MAX_DESCR_PARTS,
  MAX_FILE_SIZE,
  safeFileName,
  sniffType,
  splitFileDescr,
  unknownServers,
  type ChatFile,
  type FileDescrPart,
  type FileMeta,
  type OutgoingFile,
} from './files';
import { ItemStore, VaultAgentStore } from './store';
import { ChatError, FileApprovalError, localId, profileName, randomIndex } from './common';
import { GroupManager, parseSupportChatId, type Group, type GroupMember } from './groups';
import { CallManager } from './calls';
import { contentAllowedInGroup, groupLinkIdOf, groupPrefOn, memberScope, normMemberId, roleRank, type GroupProfile } from '../core/chat/groups';
import type { Vault } from './vault';

export { ChatError, FileApprovalError, profileName };

export type ContactStatus = 'connecting' | 'requested' | 'active' | 'deleted';

export interface Contact {
  id: string;
  connId: string;
  profile: Profile;
  localAlias?: string;
  status: ContactStatus;
  /** how the contact was made */
  via: 'invitation-created' | 'invitation-joined' | 'address-request' | 'address-accepted';
  createdAt: number;
  lastActivity: number;
  unread: number;
  peerChatVR?: { min: number; max: number };
  sendReceipts?: boolean;
  favorite?: boolean;
  muted?: boolean;
  /** disappearing messages: the TTL in seconds of the messages sent to this contact */
  ttl?: number;
  /** the contact's disappearing messages preference, from its profile */
  peerTimed?: { allow?: string; ttl?: number };
  /** the random profile shared with this contact instead of ours (incognito) */
  incognito?: Profile;
  /** the security code when it was verified */
  verifiedCode?: string;
  /** messages are post-quantum encrypted in both directions */
  pq?: boolean;
}

export interface PendingInvitation {
  id: string;
  connId: string;
  link: string;
  createdAt: number;
  label?: string;
  incognito?: Profile;
}

export interface ContactRequest {
  id: string;
  addressConnId: string;
  invId: string;
  profile: Profile;
  receivedAt: number;
  message?: string;
}

export type ItemStatus = 'sending' | 'sent' | 'delivered' | 'error' | 'received' | 'read';

export interface ChatItem {
  id: string;
  dir: 'snd' | 'rcv' | 'event';
  sharedMsgId?: string;
  content: MsgContent;
  ts: number;
  /** router timestamp of received messages */
  brokerTs?: number;
  status: ItemStatus;
  agentMsgId?: number;
  /** in groups: whose message was quoted (sent: we sent it) */
  quote?: { sharedMsgId?: string; text: string; sent: boolean; memberId?: string };
  edited?: boolean;
  deleted?: boolean;
  /** deleted by a group moderator */
  moderated?: boolean;
  forwarded?: boolean;
  /** peer: the contact's reaction; members: the group members who reacted */
  reactions?: Record<string, { me?: boolean; peer?: boolean; members?: string[] }>;
  /** in groups: the member who sent a received message, or who an event is about */
  memberId?: string;
  /** an invitation to a group, received from a contact */
  groupInv?: { groupId: string; status: 'pending' | 'accepted' | 'rejected'; name: string; role: string };
  /** a call with the contact (the text says how it went) */
  call?: { media: string; dir: 'snd' | 'rcv' };
  /** disappearing message: deletion time */
  deleteAt?: number;
  /** a received disappearing message: its TTL in seconds, counted from when it is read */
  ttl?: number;
  file?: ChatFile;
  error?: string;
  integrity?: string;
}

export interface Address {
  connId: string;
  link: string;
  autoAccept: boolean;
  createdAt: number;
}

export interface ChatSettings {
  profile: Profile;
  servers: string[];
  sendReceipts: boolean;
  shortLinks: boolean;
  /** file servers (XFTP) for sending files; empty for the presets */
  xftpServers?: string[];
  /** download received images, videos and voice messages up to the sizes the apps download */
  autoReceiveImages?: boolean;
  /** the version of our preferences that the contacts were told about */
  prefsVersion?: number;
  /** private message routing (the defaults of the apps when not set) */
  routing?: { mode: ProxyMode; fallback: ProxyFallback };
  /** audio and video calls with contacts (default on) */
  calls?: boolean;
}

interface ChatState {
  contacts: Record<string, Contact>;
  requests: Record<string, ContactRequest>;
  invitations: Record<string, PendingInvitation>;
  address?: Address;
  /** files being uploaded or downloaded, to continue after a reload */
  pendingFiles?: Record<string, { contactId: string; itemId: string }>;
  groups?: Record<string, Group>;
}

/** where a message was received: a contact's chat, or a group and the member who sent it */
export interface ChatTarget {
  chatId: string;
  group?: Group;
  sender?: GroupMember;
  /** in the chat of this member with the moderators of the group */
  support?: string;
}

export type ChatEvent =
  | { type: 'state' }
  | { type: 'items'; contactId: string }
  | { type: 'newItem'; contactId: string; item: ChatItem }
  | { type: 'request'; request: ContactRequest }
  | { type: 'connected'; contactId: string }
  | { type: 'network' }
  | { type: 'fileProgress'; fileId: string }
  /** the current call changed (chat.calls.active) */
  | { type: 'call' }
  | { type: 'error'; message: string };

const DEFAULT_PREFERENCES = {
  timedMessages: { allow: 'yes' as const },
  fullDelete: { allow: 'no' as const },
  reactions: { allow: 'yes' as const },
  voice: { allow: 'yes' as const },
  files: { allow: 'always' as const },
  calls: { allow: 'yes' as const },
};

/** 1: files and voice messages not allowed; 2: allowed; 3: calls allowed */
export const PREFS_VERSION = 3;

/** calls: allowed unless the user turned them off */
export function withDefaultPreferences(p: Profile, calls = true): Profile {
  return { ...p, preferences: { ...DEFAULT_PREFERENCES, ...(p.preferences ?? {}), calls: { allow: calls ? 'yes' : 'no' } } };
}

/** a random profile for an incognito connection, named like those of the official apps */
export function randomProfile(): Profile {
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)];
  let noun = NOUNS[randomIndex(NOUNS.length)];
  for (let i = 0; i < 2 && noun === adjective; i++) noun = NOUNS[randomIndex(NOUNS.length)];
  return { displayName: adjective + noun, fullName: '' };
}

export const TTL_CHOICES = [300, 3600, 8 * 3600, 86400, 7 * 86400, 30 * 86400];

export function ttlText(s: number): string {
  const units: Array<[number, string]> = [
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [n, u] of units) if (s >= n && s % n === 0) return `${s / n} ${u}${s / n === 1 ? '' : 's'}`;
  return `${s} seconds`;
}

export function contentText(c: MsgContent): string {
  return typeof c.text === 'string' ? c.text : '';
}

/** the text of an item, or the name of its file */
export function itemText(it: ChatItem): string {
  return contentText(it.content) || it.file?.name || '';
}

/** quoteContent of simplex-chat: what a reply with this content quotes of an item */
function quoteContent(mc: MsgContent, q: ChatItem): MsgContent {
  const text = itemText(q);
  // replies with large content quote only the text
  if (!['text', 'file', 'voice', 'report'].includes(mc.type)) return { type: 'text', text };
  const image = (q.content as { image?: unknown }).image;
  if (q.content.type === 'image' && typeof image === 'string') return { type: 'image', text, image };
  if (q.content.type === 'file') return { type: 'file', text };
  return q.content;
}

function fileErrorText(e: unknown): string {
  if (e instanceof XFTPError) {
    if (e.gone) return 'the file was deleted from the server or has expired';
    if (e.code === 'QUOTA') return 'the file server is full';
    if (e.code === 'DIGEST' || e.code === 'CRYPTO') return 'the file is damaged';
    if (e.code === 'SIZE') return 'the file has a different size';
  }
  return e instanceof Error ? e.message : String(e);
}

/** errors after which trying again does not help */
const permanentFileError = (e: unknown): boolean => e instanceof XFTPError && (e.gone || ['DIGEST', 'CRYPTO', 'SIZE', 'DESCRIPTION'].includes(e.code));

export class ChatClient {
  readonly agent: Agent;
  state: ChatState = { contacts: {}, requests: {}, invitations: {} };
  private items = new Map<string, ChatItem[]>();
  private itemStore: ItemStore<ChatItem>;
  private listeners: Array<(e: ChatEvent) => void> = [];
  private connToContact = new Map<string, string>();
  private stateWrite: Promise<void> = Promise.resolve();
  private ttlTimer: ReturnType<typeof setInterval> | undefined;
  network: { connected: number; total: number; errors: string[] } = { connected: 0, total: 0, errors: [] };
  private up = new Set<string>();
  /** file transfers and the local copies of files */
  readonly files: FileManager;
  readonly groups: GroupManager;
  readonly calls: CallManager;
  /** whether the page can encrypt call media (set by the interface) */
  callEncryption: () => boolean = () => false;

  constructor(
    private vault: Vault,
    public settings: ChatSettings,
    connector: Connector,
    servers: ProtocolServer[],
  ) {
    this.agent = new Agent(new VaultAgentStore(vault), connector, { servers, shortLinks: settings.shortLinks, routing: settings.routing });
    this.agent.onEvent = (e) => this.onAgentEvent(e);
    this.itemStore = new ItemStore<ChatItem>(vault);
    this.files = new FileManager(vault, () => this.agent.network.connector);
    this.groups = new GroupManager(this);
    this.calls = new CallManager(this);
  }

  on(f: (e: ChatEvent) => void): () => void {
    this.listeners.push(f);
    return () => {
      this.listeners = this.listeners.filter((g) => g !== f);
    };
  }

  /** @internal */
  emitError(message: string): void {
    this.emit({ type: 'error', message });
  }

  /** @internal */
  emitCall(): void {
    this.emit({ type: 'call' });
  }

  /** @internal an incoming call while the page is in the background */
  notifyCall(text: string): void {
    this.callNotifier(text);
  }

  /** shows notifications of incoming calls (set by the interface) */
  callNotifier: (text: string) => void = () => {};

  private emit(e: ChatEvent): void {
    for (const f of this.listeners) {
      try {
        f(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  get profile(): Profile {
    return this.settings.profile;
  }

  async start(): Promise<void> {
    const s = await this.vault.get<ChatState>('chat');
    if (s) this.state = { contacts: s.contacts ?? {}, requests: s.requests ?? {}, invitations: s.invitations ?? {}, address: s.address, pendingFiles: s.pendingFiles ?? {}, groups: s.groups ?? {} };
    for (const c of Object.values(this.state.contacts)) this.connToContact.set(c.connId, c.id);
    this.groups.index();
    await this.agent.start();
    this.ttlTimer = setInterval(() => this.expireItems(), 10000);
    void this.resumeTransfers().catch((e) => console.warn('resuming file transfers failed', e));
    void this.announcePreferences().catch((e) => console.warn('sending the preferences failed', e));
  }

  stop(): void {
    clearInterval(this.ttlTimer);
    this.files.stop();
    this.agent.stop();
  }

  /** after stop: resolves when the event handlers and writes that were running have finished */
  async idle(): Promise<void> {
    await this.files.idle();
    await this.agent.idle();
    await this.stateWrite;
    await this.itemStore.idle();
  }

  /** @internal */
  saveState(): Promise<void> {
    const snapshot = structuredClone(this.state);
    this.stateWrite = this.stateWrite.then(() => this.vault.put('chat', snapshot)).catch((e) => console.error('save failed', e));
    this.emit({ type: 'state' });
    return this.stateWrite;
  }

  async saveSettings(s: Partial<ChatSettings>): Promise<void> {
    this.settings = { ...this.settings, ...s };
    await this.vault.put('settings', this.settings);
    this.emit({ type: 'state' });
  }

  contacts(): Contact[] {
    return Object.values(this.state.contacts).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  contact(id: string): Contact | undefined {
    return this.state.contacts[id];
  }

  async chatItems(contactId: string): Promise<ChatItem[]> {
    let it = this.items.get(contactId);
    if (!it) {
      const loaded = await this.itemStore.load(contactId);
      const now = Date.now();
      it = loaded.filter((i) => !i.deleteAt || i.deleteAt > now);
      // files received before files were supported have no description
      for (const i of it) {
        if (i.file && !i.file.status) i.file = { id: localId(), name: safeFileName(i.file.name), size: Number(i.file.size) || 0, status: 'rcvError', error: 'received before Duplex supported files', permanent: true };
      }
      this.items.set(contactId, it);
      if (it.length !== loaded.length) await this.itemStore.save(contactId, it, 0);
    }
    return it;
  }

  /** @internal */
  async addItem(contactId: string, item: ChatItem): Promise<void> {
    const items = await this.chatItems(contactId);
    items.push(item);
    await this.itemStore.save(contactId, items, items.length - 1);
    this.emit({ type: 'newItem', contactId, item });
  }

  /**
   * @internal an item at its place in time (forwarded messages, and the history of a group sent to
   * a new member); returns false when it is older than the last item
   */
  async insertItem(contactId: string, item: ChatItem): Promise<boolean> {
    const items = await this.chatItems(contactId);
    const t = item.brokerTs ?? item.ts;
    let i = items.length;
    while (i > 0 && (items[i - 1].brokerTs ?? items[i - 1].ts) > t) i--;
    if (i === items.length) {
      await this.addItem(contactId, item);
      return true;
    }
    items.splice(i, 0, item);
    await this.itemStore.save(contactId, items, i);
    this.emit({ type: 'items', contactId });
    return false;
  }

  /** @internal */
  async updateItem(contactId: string, item: ChatItem): Promise<void> {
    const items = await this.chatItems(contactId);
    const i = items.findIndex((x) => x.id === item.id);
    if (i < 0) return;
    items[i] = item;
    await this.itemStore.save(contactId, items, i);
    this.emit({ type: 'items', contactId });
  }

  /** the profile sent to a contact: incognito or ours, with the disappearing messages TTL for this contact */
  private ourProfile(c?: { incognito?: Profile; ttl?: number }): Profile {
    const p = withDefaultPreferences(c?.incognito ?? this.settings.profile, this.settings.calls !== false);
    if (c?.ttl) p.preferences = { ...p.preferences, timedMessages: { allow: 'yes', ttl: c.ttl } };
    return p;
  }

  /** connection info: post-quantum connections leave less space for it, so it may be compressed (compressConnInfo) */
  /** @internal */
  encodeInfo(m: ChatMessage, pq = this.agent.config.pq ?? true): Bytes {
    const b = compressToLimit(pq ? MAX_CONN_INFO_LENGTH_PQ : MAX_CONN_INFO_LENGTH, encodeChatMessage(m));
    if (!b) throw new ChatError('profile is too large (try a smaller picture)');
    return b;
  }

  /** the largest message to this contact: smaller with post-quantum encryption */
  private maxMsgLength(c: Contact): number {
    return this.agent.pqSupport(c.connId) ? MAX_ENCODED_MSG_LENGTH_PQ : MAX_ENCODED_MSG_LENGTH;
  }

  /** a message body that fits, compressed if the contact can decompress it */
  private fitBody(c: Contact, m: ChatMessage): Bytes | undefined {
    const raw = encodeChatMessage(m);
    const max = this.maxMsgLength(c);
    if (raw.length <= max) return raw;
    if ((c.peerChatVR?.max ?? COMPRESSION_CHAT_VERSION) < COMPRESSION_CHAT_VERSION) return undefined;
    return compressToLimit(max, raw);
  }

  // ---- connecting

  /** creates a 1-time invitation link */
  async createInvitation(opts: { label?: string; incognito?: boolean } = {}): Promise<PendingInvitation> {
    const incognito = opts.incognito ? randomProfile() : undefined;
    const r = await this.agent.createInvitation({ userData: contactShortLinkData(this.ourProfile({ incognito })) });
    const inv: PendingInvitation = { id: localId(), connId: r.connId, link: r.link, createdAt: Date.now(), label: opts.label, incognito };
    this.state.invitations[inv.id] = inv;
    await this.saveState();
    return inv;
  }

  /** shares a random profile (or ours again) with whoever uses this 1-time link */
  async setInvitationIncognito(id: string, on: boolean): Promise<PendingInvitation> {
    const inv = this.state.invitations[id];
    if (!inv) throw new ChatError('link not found');
    const incognito = on ? randomProfile() : undefined;
    await this.agent.updateLinkData(inv.connId, contactShortLinkData(this.ourProfile({ incognito })));
    inv.incognito = incognito;
    await this.saveState();
    return inv;
  }

  async deleteInvitation(id: string): Promise<void> {
    const inv = this.state.invitations[id];
    if (!inv) return;
    delete this.state.invitations[id];
    await this.saveState();
    await this.agent.deleteConnection(inv.connId).catch(() => {});
  }

  /** what a link connects to, before connecting */
  async previewLink(link: string): Promise<{ kind: 'invitation' | 'contact' | 'group' | 'channel'; profile?: Profile; groupProfile?: GroupProfile; message?: string; subscribers?: number; resolved?: Awaited<ReturnType<Agent['resolveLink']>> }> {
    const l = link.trim();
    if (isShortLink(l)) {
      const sl = parseShortLink(l);
      if (sl.mode === 'contact' && sl.type === 'R') throw new ChatError('this is the address of a chat relay, not of a channel');
      const resolved = await this.agent.resolveLink(l);
      const d = parseShortLinkData(resolved.userData) as ReturnType<typeof parseShortLinkData> & { publicGroupData?: { publicMemberCount?: number } };
      const gp = d.groupProfile as GroupProfile | undefined;
      if (sl.mode === 'contact' && (sl.type === 'C' || gp?.publicGroup)) return { kind: 'channel', groupProfile: gp, subscribers: d.publicGroupData?.publicMemberCount, resolved };
      if (sl.mode === 'contact' && (sl.type === 'G' || groupLinkIdOf(resolved.connReq.data.clientData))) return { kind: 'group', groupProfile: gp, resolved };
      return { kind: sl.mode === 'invitation' ? 'invitation' : 'contact', profile: d.profile, message: d.message ? contentText(d.message) : undefined, resolved };
    }
    const resolved = await this.agent.resolveLink(l);
    if (resolved.connReq.mode === 'contact' && groupLinkIdOf(resolved.connReq.data.clientData)) return { kind: 'group', resolved };
    return { kind: resolved.connReq.mode === 'invitation' ? 'invitation' : 'contact', resolved };
  }

  /** creates a group, with us as the owner; incognito: members see a random profile */
  createGroup(p: { displayName: string; fullName?: string; description?: string; image?: string }, incognito = false): Promise<Group> {
    return this.groups.create(p, incognito ? randomProfile() : undefined);
  }

  /** joins a group via its link (the group is shown once the admin accepts), or a channel */
  async joinGroup(link: string, opts: { resolved?: Awaited<ReturnType<Agent['resolveLink']>>; incognito?: boolean } = {}): Promise<Group> {
    const resolved = opts.resolved ?? (await this.agent.resolveLink(link));
    if (resolved.connReq.mode !== 'contact') throw new ChatError('this is not a group link');
    const gp = parseShortLinkData(resolved.userData).groupProfile as GroupProfile | undefined;
    const incognito = opts.incognito ? randomProfile() : undefined;
    if (gp?.publicGroup) return this.groups.joinChannel(resolved, incognito);
    return this.groups.joinViaLink(resolved, gp, incognito);
  }

  /** connects via a 1-time invitation or a contact address */
  async connect(link: string, opts: { resolved?: Awaited<ReturnType<Agent['resolveLink']>>; message?: string; incognito?: boolean } = {}): Promise<Contact> {
    const resolved = opts.resolved ?? (await this.agent.resolveLink(link));
    // group links carry the group link ID
    if (groupLinkIdOf(resolved.connReq.data.clientData)) throw new ChatError('this is a group link: join the group instead');
    const d = parseShortLinkData(resolved.userData);
    const profile: Profile = d.profile ?? { displayName: 'contact', fullName: '' };
    const isInv = resolved.connReq.mode === 'invitation';
    const incognito = opts.incognito ? randomProfile() : undefined;
    const ours = this.ourProfile({ incognito });
    let connInfo: Bytes;
    if (isInv) connInfo = this.encodeInfo(xInfo(ours));
    else {
      const msg = opts.message?.trim() ? { msgId: newSharedMsgId(), content: { type: 'text', text: opts.message.trim() } as MsgContent } : undefined;
      connInfo = this.encodeInfo(xContact(ours, newSharedMsgId(), msg));
    }
    const connId = await this.agent.joinConnection(resolved, connInfo);
    const now = Date.now();
    const c: Contact = { id: localId(), connId, profile, status: isInv ? 'connecting' : 'requested', via: isInv ? 'invitation-joined' : 'address-request', createdAt: now, lastActivity: now, unread: 0, incognito };
    this.notePeerPrefs(c, profile);
    this.state.contacts[c.id] = c;
    this.connToContact.set(connId, c.id);
    await this.saveState();
    if (!isInv && opts.message?.trim()) {
      await this.addItem(c.id, { id: localId(), dir: 'snd', content: { type: 'text', text: opts.message.trim() }, ts: now, status: 'sent' });
    }
    await this.addEvent(c.id, isInv ? 'connecting…' : 'contact request sent');
    return c;
  }

  // ---- address

  async createAddress(): Promise<Address> {
    if (this.state.address) return this.state.address;
    const r = await this.agent.createAddress({ userData: contactShortLinkData(this.ourProfile()) });
    this.state.address = { connId: r.connId, link: r.link, autoAccept: false, createdAt: Date.now() };
    await this.saveState();
    return this.state.address;
  }

  async deleteAddress(): Promise<void> {
    const a = this.state.address;
    if (!a) return;
    this.state.address = undefined;
    for (const [id, r] of Object.entries(this.state.requests)) if (r.addressConnId === a.connId) delete this.state.requests[id];
    await this.saveState();
    await this.agent.deleteConnection(a.connId).catch(() => {});
  }

  async setAutoAccept(on: boolean): Promise<void> {
    if (!this.state.address) return;
    this.state.address.autoAccept = on;
    await this.saveState();
  }

  async acceptRequest(reqId: string): Promise<Contact> {
    const r = this.state.requests[reqId];
    if (!r) throw new ChatError('request not found');
    const connId = await this.agent.acceptRequest(r.addressConnId, r.invId, this.encodeInfo(xInfo(this.ourProfile())));
    delete this.state.requests[reqId];
    const now = Date.now();
    const c: Contact = { id: localId(), connId, profile: r.profile, status: 'connecting', via: 'address-accepted', createdAt: now, lastActivity: now, unread: 0 };
    this.notePeerPrefs(c, r.profile);
    this.state.contacts[c.id] = c;
    this.connToContact.set(connId, c.id);
    await this.saveState();
    if (r.message) await this.addItem(c.id, { id: localId(), dir: 'rcv', content: { type: 'text', text: r.message }, ts: r.receivedAt, status: 'received' });
    await this.addEvent(c.id, 'accepted contact request, connecting…');
    return c;
  }

  async rejectRequest(reqId: string): Promise<void> {
    const r = this.state.requests[reqId];
    if (!r) return;
    delete this.state.requests[reqId];
    await this.saveState();
    await this.agent.rejectRequest(r.addressConnId, r.invId).catch(() => {});
  }

  // ---- messages

  private async send(c: Contact, m: ChatMessage): Promise<number> {
    const body = this.fitBody(c, m);
    if (!body) throw new ChatError('message is too large');
    return this.agent.sendMessage(c.connId, body, m.event === 'x.msg.new');
  }

  /** @internal */
  sendDirect(c: Contact, m: ChatMessage): Promise<number> {
    return this.send(c, m);
  }

  /** sends to a contact, or to the members of a group */
  private async sendToChat(chatId: string, m: ChatMessage): Promise<void> {
    const sc = this.supportChat(chatId);
    if (sc) {
      const err = this.groups.canSendSupport(sc.g, sc.memberId);
      if (err) throw new ChatError(err);
      // the events of messages carry their chat; file descriptions and cancellations follow their message
      if (['x.msg.update', 'x.msg.del', 'x.msg.react'].includes(m.event)) m.params.scope = memberScope(sc.memberId);
      await this.groups.sendSupport(sc.g, sc.memberId, m);
      return;
    }
    const g = this.state.groups?.[chatId];
    if (!g) {
      await this.send(this.activeContact(chatId), m);
      return;
    }
    const err = this.groups.canSend(g);
    if (err) throw new ChatError(err);
    await this.groups.send(g, m);
  }

  isGroup(chatId: string): boolean {
    return !!this.state.groups?.[chatId];
  }

  group(id: string): Group | undefined {
    return this.state.groups?.[id];
  }

  /** the chat of a member with the moderators of a group, by its ID */
  supportChat(chatId: string): { g: Group; memberId: string } | undefined {
    const p = parseSupportChatId(chatId);
    const g = p && this.state.groups?.[p.groupId];
    return g ? { g, memberId: p.memberId } : undefined;
  }

  /** the group of a group chat, or of the chat of a member with its moderators */
  groupOf(chatId: string): Group | undefined {
    return this.state.groups?.[chatId] ?? this.supportChat(chatId)?.g;
  }

  /** the TTL of messages in a group: its disappearing messages preference */
  groupTtl(g: Group): number | undefined {
    const tm = g.profile.groupPreferences?.timedMessages;
    return groupPrefOn(g.profile, 'timedMessages') && typeof tm?.ttl === 'number' && tm.ttl > 0 ? tm.ttl : undefined;
  }

  private activeContact(contactId: string): Contact {
    const c = this.state.contacts[contactId];
    if (!c) throw new ChatError('contact not found');
    if (c.status !== 'active') throw new ChatError(c.status === 'deleted' ? 'the contact deleted the connection' : 'the contact is not connected yet');
    return c;
  }

  async sendText(contactId: string, text: string, quoteItemId?: string): Promise<ChatItem> {
    return this.sendContent(contactId, { type: 'text', text }, quoteItemId);
  }

  /**
   * sends a file, an image or a video with an optional caption: the message goes first, and the file
   * is stored in this browser and uploaded in the background
   */
  async sendFile(contactId: string, out: OutgoingFile, text = '', quoteItemId?: string): Promise<ChatItem> {
    const g = this.state.groups?.[contactId];
    if (g) {
      const err = this.groups.canSend(g) ?? contentAllowedInGroup(g.profile, { type: out.kind === 'voice' ? 'voice' : 'file', text: '' });
      if (err) throw new ChatError(err);
    } else {
      const c = this.activeContact(contactId);
      if (!this.peerAllowsFiles(c)) throw new ChatError('the contact does not allow files and media');
      if (out.kind === 'voice' && !this.peerAllowsVoice(c)) throw new ChatError('the contact does not allow voice messages');
    }
    const size = out.blob.size;
    if (!size) throw new ChatError('the file is empty');
    if (size > MAX_FILE_SIZE) throw new ChatError(`the file is too large: files can be up to ${MAX_FILE_SIZE / GB} GB`);
    const id = localId();
    const file: ChatFile = { id, name: safeFileName(out.name), size, status: 'sndStored' };
    try {
      file.mime = sniffType(new Uint8Array(await out.blob.slice(0, 64).arrayBuffer()));
      file.pieces = await this.files.store(id, out.blob);
    } catch (e) {
      await this.files.deleteLocal({ ...file, pieces: piecesFor(size) }).catch(() => {});
      throw new ChatError(`the file could not be stored in this browser: ${(e as Error).message}`);
    }
    const content: MsgContent =
      out.kind === 'image'
        ? { type: 'image', text, image: out.preview || FIXED_IMAGE_PREVIEW }
        : out.kind === 'video'
          ? { type: 'video', text, image: out.preview || FIXED_IMAGE_PREVIEW, duration: Math.max(0, Math.round(out.duration ?? 0)) }
          : out.kind === 'voice'
            ? { type: 'voice', text, duration: Math.max(1, Math.round(out.duration ?? 0)) }
            : { type: 'file', text };
    return this.sendContent(contactId, content, quoteItemId, file);
  }

  private async sendContent(contactId: string, content: MsgContent, quoteItemId?: string, file?: ChatFile): Promise<ChatItem> {
    const sc = this.supportChat(contactId);
    const g = sc?.g ?? this.state.groups?.[contactId];
    const c = g ? undefined : this.activeContact(contactId);
    if (g) {
      const err = (sc ? this.groups.canSendSupport(g, sc.memberId) : this.groups.canSend(g)) ?? contentAllowedInGroup(g.profile, content);
      if (err) throw new ChatError(err);
    }
    const sharedMsgId = newSharedMsgId();
    const mc: MsgContainer = { content };
    if (sc) mc.scope = memberScope(sc.memberId);
    let quote: ChatItem['quote'];
    if (quoteItemId) {
      const q = (await this.chatItems(contactId)).find((i) => i.id === quoteItemId);
      if (q && q.sharedMsgId) {
        const sent = q.dir === 'snd';
        // in groups the reference says whose message it is
        const memberId = g ? (sent ? g.memberId : q.memberId) : undefined;
        mc.quote = { msgRef: { msgId: q.sharedMsgId, sentAt: new Date(q.brokerTs ?? q.ts).toISOString(), sent, ...(memberId ? { memberId } : {}) }, content: quoteContent(content, q) };
        quote = { sharedMsgId: q.sharedMsgId, text: itemText(q), sent, ...(g && !sent && q.memberId ? { memberId: q.memberId } : {}) };
      }
    }
    // XFTP files: the description follows in x.msg.file.descr messages
    if (file) mc.file = { fileName: file.name, fileSize: file.size, fileDescr: { fileDescrText: '', fileDescrPartNo: 0, fileDescrComplete: false } };
    const ttl = g ? this.groupTtl(g) : this.sendTtl(c!);
    if (ttl) mc.ttl = ttl;
    const tooLarge = () => (c ? !this.fitBody(c, xMsgNew(sharedMsgId, mc)) : !compressToLimit(MAX_ENCODED_MSG_LENGTH, encodeChatMessage(xMsgNew(sharedMsgId, mc))));
    // a quoted image may not fit with the message: then only its text is quoted
    if (mc.quote && quote && tooLarge()) mc.quote.content = { type: 'text', text: quote.text };
    // nor a preview with a long caption: then the small preview of the apps is used
    if (typeof (content as { image?: unknown }).image === 'string' && tooLarge()) (content as { image: string }).image = FIXED_IMAGE_PREVIEW;
    const now = Date.now();
    const item: ChatItem = { id: localId(), dir: 'snd', sharedMsgId, content, ts: now, status: 'sending', quote, deleteAt: ttl ? now + ttl * 1000 : undefined, file };
    await this.addItem(contactId, item);
    if (file) this.trackTransfer(file.id, contactId, item.id);
    try {
      if (c) item.agentMsgId = await this.send(c, xMsgNew(sharedMsgId, mc));
      else {
        await (sc ? this.groups.sendSupport(g!, sc.memberId, xMsgNew(sharedMsgId, mc)) : this.groups.send(g!, xMsgNew(sharedMsgId, mc)));
        item.status = 'sent';
      }
    } catch (e) {
      item.status = 'error';
      item.error = (e as Error).message;
      if (file) {
        file.status = 'sndError';
        file.error = 'the message was not sent';
        file.permanent = true;
        this.untrackTransfer(file.id);
      }
    }
    await this.updateItem(contactId, item);
    if (sc) this.groups.touchSupport(g!, sc.memberId);
    else (c ?? g!).lastActivity = now;
    await this.saveState();
    if (file && item.status !== 'error') this.startUpload(contactId, item.id, file.id);
    return item;
  }

  async editItem(contactId: string, itemId: string, text: string): Promise<void> {
    const items = await this.chatItems(contactId);
    const item = items.find((i) => i.id === itemId);
    if (!item || item.dir !== 'snd' || !item.sharedMsgId || item.deleted) throw new ChatError('cannot edit this message');
    const content: MsgContent = { ...item.content, text } as MsgContent;
    await this.sendToChat(contactId, xMsgUpdate(newSharedMsgId(), item.sharedMsgId, content));
    item.content = content;
    item.edited = true;
    await this.updateItem(contactId, item);
  }

  async deleteItem(contactId: string, itemId: string, forEveryone: boolean): Promise<void> {
    const items = await this.chatItems(contactId);
    const i = items.findIndex((x) => x.id === itemId);
    if (i < 0) return;
    const item = items[i];
    const g = this.groupOf(contactId);
    // group moderators can delete the messages of other members for everyone
    if (forEveryone && g && item.dir === 'rcv' && item.sharedMsgId && item.memberId && !item.deleted && this.canModerate(g, item)) {
      await this.sendToChat(contactId, xMsgDel(newSharedMsgId(), item.sharedMsgId, item.memberId));
      await this.dropFile(item, false);
      Object.assign(item, { deleted: true, moderated: true, content: { type: 'text', text: '' }, file: undefined });
      await this.updateItem(contactId, item);
      return;
    }
    if (forEveryone && item.dir === 'snd' && item.sharedMsgId && !item.deleted) {
      await this.sendToChat(contactId, xMsgDel(newSharedMsgId(), item.sharedMsgId, g ? g.memberId : undefined));
      // a sent file is deleted from the file servers too
      await this.dropFile(item, true);
      item.deleted = true;
      item.content = { type: 'text', text: '' };
      item.file = undefined;
      await this.updateItem(contactId, item);
      return;
    }
    await this.dropFile(item, false);
    const j = items.indexOf(item);
    if (j < 0) return;
    items.splice(j, 1);
    await this.itemStore.save(contactId, items, j);
    this.emit({ type: 'items', contactId });
  }

  /** whether we can delete this member's message for everyone */
  canModerate(g: Group, item: ChatItem): boolean {
    const author = item.memberId ? g.members[item.memberId] : undefined;
    return g.status === 'active' && roleRank(g.role) >= roleRank('moderator') && (!author || roleRank(author.role) <= roleRank(g.role));
  }

  async react(contactId: string, itemId: string, emoji: string, add: boolean): Promise<void> {
    const item = (await this.chatItems(contactId)).find((i) => i.id === itemId);
    if (!item || !item.sharedMsgId) return;
    const g = this.groupOf(contactId);
    // in groups: whose message it is
    const author = g ? (item.dir === 'snd' ? g.memberId : item.memberId) : undefined;
    await this.sendToChat(contactId, xMsgReact(newSharedMsgId(), item.sharedMsgId, emoji, add, author));
    item.reactions ??= {};
    const r = (item.reactions[emoji] ??= {});
    r.me = add;
    if (!r.me && !r.peer) delete item.reactions[emoji];
    await this.updateItem(contactId, item);
  }

  async markRead(contactId: string): Promise<void> {
    const sc = this.supportChat(contactId);
    const c = sc ? sc.g.support?.[sc.memberId] : (this.state.contacts[contactId] ?? this.state.groups?.[contactId]);
    if (!c) return;
    const items = await this.chatItems(contactId);
    let changed = -1;
    const now = Date.now();
    items.forEach((it, i) => {
      if (it.dir === 'rcv' && it.status === 'received') {
        it.status = 'read';
        if (it.ttl && !it.deleteAt) it.deleteAt = now + it.ttl * 1000;
        if (changed < 0) changed = i;
      }
    });
    if (changed >= 0) await this.itemStore.save(contactId, items, changed);
    if (c.unread) {
      c.unread = 0;
      await this.saveState();
    }
  }

  async clearChat(contactId: string): Promise<void> {
    const items = await this.chatItems(contactId);
    this.items.set(contactId, []);
    await this.itemStore.delete(contactId);
    this.emit({ type: 'items', contactId });
    for (const it of items) await this.dropFile(it, false);
  }

  async deleteContact(contactId: string, notify = true): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
    const items = await this.chatItems(contactId);
    for (const it of items) await this.dropFile(it, false);
    if (notify && c.status === 'active') await this.send(c, xDirectDel(newSharedMsgId())).catch(() => {});
    delete this.state.contacts[contactId];
    this.connToContact.delete(c.connId);
    await this.saveState();
    await this.itemStore.delete(contactId);
    this.items.delete(contactId);
    // give the deletion notice a moment to be delivered before removing the queues
    setTimeout(() => this.agent.deleteConnection(c.connId).catch(() => {}), notify ? 3000 : 0);
  }

  async setAlias(contactId: string, alias: string): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
    c.localAlias = alias.trim() || undefined;
    await this.saveState();
  }

  async updateContact(contactId: string, patch: Partial<Pick<Contact, 'favorite' | 'muted' | 'sendReceipts'>>): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
    Object.assign(c, patch);
    await this.saveState();
  }

  /** updates our profile and sends it to all contacts */
  async updateProfile(profile: Profile): Promise<void> {
    await this.saveSettings({ profile });
    // contacts that know an incognito profile keep it
    for (const c of Object.values(this.state.contacts)) {
      if (c.status === 'active' && !c.incognito) await this.send(c, xInfo(this.ourProfile(c))).catch(() => {});
    }
    if (this.state.address) await this.agent.updateLinkData(this.state.address.connId, contactShortLinkData(this.ourProfile())).catch(() => {});
    await this.groups.profileUpdated();
  }

  // ---- disappearing messages and security codes

  /** whether the contact accepts disappearing messages */
  peerAllowsTimed(c: Contact): boolean {
    return c.peerTimed?.allow !== 'no';
  }

  /** the TTL of the messages sent to this contact now, if any */
  disappearingTtl(c: Contact): number | undefined {
    return this.sendTtl(c);
  }

  private sendTtl(c: Contact): number | undefined {
    return c.ttl && this.peerAllowsTimed(c) ? c.ttl : undefined;
  }

  /** sets the TTL of the messages sent to this contact (and offers it to the contact, as the apps do) */
  async setDisappearing(contactId: string, ttl: number | undefined): Promise<void> {
    const c = this.activeContact(contactId);
    if (ttl && !this.peerAllowsTimed(c)) throw new ChatError('the contact does not allow disappearing messages');
    c.ttl = ttl || undefined;
    await this.send(c, xInfo(this.ourProfile(c)));
    await this.saveState();
    await this.addEvent(c.id, c.ttl ? `you set disappearing messages to ${ttlText(c.ttl)}` : 'you turned off disappearing messages');
  }

  /** records the contact's preferences; a changed TTL is used for our messages too, like the apps do */
  private notePeerPrefs(c: Contact, profile: Profile | undefined, update = false): string | undefined {
    const tm = profile?.preferences?.timedMessages;
    const next = { allow: tm?.allow, ttl: typeof tm?.ttl === 'number' && tm.ttl > 0 ? tm.ttl : undefined };
    const prev = c.peerTimed;
    c.peerTimed = next;
    if (!update) return undefined;
    // contacts made by an earlier version have no recorded preferences
    if (!prev) {
      if (next.allow !== 'no' && next.ttl && next.ttl !== c.ttl) {
        c.ttl = next.ttl;
        return `the contact set disappearing messages to ${ttlText(next.ttl)}`;
      }
      return undefined;
    }
    if (next.allow === 'no' && prev.allow !== 'no') return 'the contact does not allow disappearing messages';
    if (next.allow !== 'no' && next.ttl !== prev.ttl && next.ttl !== c.ttl) {
      c.ttl = next.ttl;
      return next.ttl ? `the contact set disappearing messages to ${ttlText(next.ttl)}` : 'the contact turned off disappearing messages';
    }
    if (next.allow !== 'no' && prev.allow === 'no') return 'the contact allows disappearing messages again';
    return undefined;
  }

  /** the security code to compare with the contact (the same as in the SimpleX Chat apps) */
  securityCode(contactId: string): string | undefined {
    const c = this.state.contacts[contactId];
    return c ? this.agent.securityCode(c.connId) : undefined;
  }

  /** marks the connection as verified (with the code of this connection), or clears it */
  async setVerified(contactId: string, verified: boolean): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
    c.verifiedCode = verified ? this.securityCode(contactId) : undefined;
    await this.saveState();
  }

  isVerified(c: Contact): boolean {
    return !!c.verifiedCode && c.verifiedCode === this.agent.securityCode(c.connId);
  }

  // ---- address changes

  /** the routers used with a contact and the state of address changes */
  contactQueues(contactId: string): ConnQueues | undefined {
    const c = this.state.contacts[contactId];
    return c ? this.agent.queueInfo(c.connId) : undefined;
  }

  /** changes the receiving address for a contact (a new queue, preferably on another router) */
  async switchAddress(contactId: string): Promise<void> {
    const c = this.activeContact(contactId);
    await this.agent.switchConnection(c.connId);
  }

  async abortSwitch(contactId: string): Promise<void> {
    const c = this.activeContact(contactId);
    await this.agent.abortSwitch(c.connId);
    await this.addEvent(c.id, 'stopped changing address');
    this.emit({ type: 'state' });
  }

  // ---- files

  /** whether the contact accepts files and media (the preference in its profile) */
  peerAllowsFiles(c: Contact): boolean {
    return c.profile.preferences?.files?.allow !== 'no';
  }

  /** whether the contact accepts voice messages */
  peerAllowsVoice(c: Contact): boolean {
    return c.profile.preferences?.voice?.allow !== 'no' && this.peerAllowsFiles(c);
  }

  /** the file servers for sending files: the configured ones, or the presets */
  xftpServers(): ServerWithAuth[] {
    const out: ServerWithAuth[] = [];
    for (const s of this.settings.xftpServers ?? []) {
      try {
        const p = parseServer(s);
        if (p.server.scheme === 'xftp') out.push(p);
      } catch {
        // ignored
      }
    }
    return out.length ? out : DEFAULT_XFTP_SERVERS.map((server) => ({ server }));
  }

  /** the file servers that files are downloaded from without asking */
  private knownXftpServers(): ProtocolServer[] {
    return [...this.xftpServers().map((s) => s.server), ...DEFAULT_XFTP_SERVERS, ...FLUX_XFTP_SERVERS];
  }

  /**
   * whether file servers see another IP address than the user's (a relay elsewhere, or Tor): then, as
   * in the apps, files are downloaded from unknown servers without asking
   */
  private ipProtected(): boolean {
    return !!this.agent.network.connector.ipProtected;
  }

  /** contacts made by earlier versions were told that files are not allowed */
  private async announcePreferences(): Promise<void> {
    if ((this.settings.prefsVersion ?? 1) >= PREFS_VERSION) return;
    for (const c of Object.values(this.state.contacts)) {
      if (c.status === 'active') await this.send(c, xInfo(this.ourProfile(c))).catch(() => {});
    }
    await this.saveSettings({ prefsVersion: PREFS_VERSION });
  }

  /** the stored content of a file; inline: with its type, to show images, videos and audio in the page */
  fileBlob(f: ChatFile, inline = false): Promise<Blob> {
    return this.files.blob(f, inline);
  }

  private fileProgress(fileId: string, done: number, total: number): void {
    if (this.files.setProgress(fileId, done, total)) this.emit({ type: 'fileProgress', fileId });
  }

  private trackTransfer(fileId: string, contactId: string, itemId: string): void {
    (this.state.pendingFiles ??= {})[fileId] = { contactId, itemId };
    void this.saveState();
  }

  private untrackTransfer(fileId: string): void {
    if (!this.state.pendingFiles?.[fileId]) return;
    delete this.state.pendingFiles[fileId];
    void this.saveState();
  }

  /** changes the file of an item (undefined values remove the fields) and saves the item */
  private async setFile(contactId: string, item: ChatItem, patch: Partial<ChatFile>): Promise<void> {
    const f = item.file;
    if (!f) return;
    Object.assign(f, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (f as unknown as Record<string, unknown>)[k];
    await this.updateItem(contactId, item);
  }

  private async fileItem(contactId: string, itemId: string, fileId: string): Promise<ChatItem | undefined> {
    if (!this.state.contacts[contactId] && !this.state.groups?.[contactId]) return undefined;
    const it = (await this.chatItems(contactId)).find((i) => i.id === itemId);
    return it?.file?.id === fileId ? it : undefined;
  }

  private async findFile(contactId: string, itemId: string): Promise<{ it: ChatItem; f: ChatFile }> {
    const it = (await this.chatItems(contactId)).find((i) => i.id === itemId);
    if (!it?.file) throw new ChatError('the file was not found');
    return { it, f: it.file };
  }

  private startUpload(contactId: string, itemId: string, fileId: string): void {
    this.files.run(fileId, (signal) => this.runUpload(contactId, itemId, fileId, signal));
  }

  private startDownload(contactId: string, itemId: string, fileId: string): void {
    this.files.run(fileId, (signal) => this.runDownload(contactId, itemId, fileId, signal));
  }

  /** continues the transfers that a reload or locking interrupted */
  private async resumeTransfers(): Promise<void> {
    for (const [fileId, t] of Object.entries(this.state.pendingFiles ?? {})) {
      const s = (await this.fileItem(t.contactId, t.itemId, fileId))?.file?.status;
      if (s === 'sndStored' || s === 'sndUploading') this.startUpload(t.contactId, t.itemId, fileId);
      else if (s === 'rcvAccepted' || s === 'rcvTransfer') this.startDownload(t.contactId, t.itemId, fileId);
      else this.untrackTransfer(fileId);
    }
  }

  /** uploads a sent file to a file server, then sends its description to the contact */
  private async runUpload(contactId: string, itemId: string, fileId: string, signal: AbortSignal): Promise<void> {
    const item = await this.fileItem(contactId, itemId, fileId);
    const f = item?.file;
    const sharedMsgId = item?.sharedMsgId;
    if (!item || !f || !sharedMsgId) return this.untrackTransfer(fileId);
    try {
      signal.throwIfAborted();
      const meta: FileMeta = (await this.files.getMeta(fileId)) ?? {};
      if (!meta.rcvDescr) {
        if (f.pieces === undefined) throw new ChatError('the file is not stored in this browser');
        await this.setFile(contactId, item, { status: 'sndUploading', error: undefined });
        const servers = this.xftpServers();
        const srv = servers[randomIndex(servers.length)];
        const up = await uploadFile(this.files.pool, srv.server, storedSource(this.vault, fileId, f.size), f.name, {
          signal,
          basicAuth: srv.basicAuth,
          onProgress: (done, total) => this.fileProgress(fileId, done, total),
        });
        Object.assign(meta, { sndDescr: encodeFileDescription(up.snd), rcvDescr: encodeFileDescription(up.rcv), sentParts: 0, expiresAt: up.expiresAt });
        await this.files.putMeta(fileId, meta);
      }
      const fileExpires = meta.expiresAt ? new Date(meta.expiresAt * 1000).toISOString() : undefined;
      const parts = splitFileDescr(meta.rcvDescr!);
      for (let i = meta.sentParts ?? 0; i < parts.length; i++) {
        signal.throwIfAborted();
        await this.sendToChat(contactId, xMsgFileDescr(newSharedMsgId(), sharedMsgId, parts[i], fileExpires));
        meta.sentParts = i + 1;
        await this.files.putMeta(fileId, meta);
      }
      this.untrackTransfer(fileId);
      await this.setFile(contactId, item, { status: 'sndComplete', expiresAt: meta.expiresAt ? meta.expiresAt * 1000 : undefined });
    } catch (e) {
      const reason = cancelReason(e);
      // after locking, the upload continues when the profile is unlocked
      if (reason === 'stopped' || this.files.isStopped) return;
      this.untrackTransfer(fileId);
      if (reason === 'deleted') return;
      if (reason) await this.setFile(contactId, item, { status: 'sndCancelled' });
      else await this.setFile(contactId, item, { status: 'sndError', error: fileErrorText(e) });
    }
  }

  /** downloads a received file into the vault, once its description is complete */
  private async runDownload(contactId: string, itemId: string, fileId: string, signal: AbortSignal): Promise<void> {
    const item = await this.fileItem(contactId, itemId, fileId);
    const f = item?.file;
    if (!item || !f) return this.untrackTransfer(fileId);
    const meta = await this.files.getMeta(fileId);
    // it starts again when the last part of the description arrives
    if (!meta?.descrComplete || meta.descrText === undefined) return;
    let writer: PieceWriter | undefined;
    try {
      signal.throwIfAborted();
      const fd = checkDescription(meta.descrText, f.size);
      const unknown = unknownServers(fd, this.knownXftpServers());
      if (unknown.length && !meta.approved && !this.ipProtected()) {
        // as in the apps: the user is asked before files are downloaded from servers they do not use
        this.untrackTransfer(fileId);
        await this.setFile(contactId, item, { status: 'rcvInvitation', accepted: undefined, unknownServers: unknown.map((s) => s.hosts[0]) });
        return;
      }
      // an interrupted download may have left pieces
      if (f.status === 'rcvTransfer') await deletePieces(this.vault, fileId, piecesFor(f.size + 10 * MB));
      await this.setFile(contactId, item, { status: 'rcvTransfer', error: undefined });
      const w = (writer = new PieceWriter(this.vault, fileId));
      let head: Bytes | undefined;
      const r = await downloadFile(
        this.files.pool,
        fd,
        async (piece) => {
          head ??= piece.slice(0, 64);
          await w.write(piece);
        },
        { signal, maxSize: f.size + 10 * MB, onProgress: (done, total) => this.fileProgress(fileId, done, total) },
      );
      const pieces = await w.end();
      this.untrackTransfer(fileId);
      await this.setFile(contactId, item, { status: 'rcvComplete', pieces, size: r.size, mime: head ? sniffType(head) : undefined, unknownServers: undefined });
    } catch (e) {
      const reason = cancelReason(e);
      // after locking, the download starts again when the profile is unlocked
      if (reason === 'stopped' || this.files.isStopped) return;
      if (writer) await deletePieces(this.vault, fileId, writer.pieces + 1).catch(() => {});
      this.untrackTransfer(fileId);
      if (reason === 'deleted') return;
      if (reason === 'sender') await this.setFile(contactId, item, { status: 'rcvCancelled', accepted: undefined });
      else if (reason) await this.setFile(contactId, item, { status: 'rcvInvitation', accepted: undefined });
      else await this.setFile(contactId, item, { status: 'rcvError', accepted: undefined, error: fileErrorText(e), permanent: permanentFileError(e) || undefined });
    }
  }

  /**
   * @internal the file of a message, for the history of a group sent to a new member: the invitation
   * and the description we have (of the file we sent, or received), while the servers keep the file
   */
  async historyFile(it: ChatItem): Promise<{ inv: FileInvitation; parts: FileDescrPart[]; expires?: string } | undefined> {
    const f = it.file;
    if (!f) return undefined;
    const meta = await this.files.getMeta(f.id);
    const usable = f.status === 'sndComplete' || (f.status.startsWith('rcv') && f.status !== 'rcvCancelled' && !(f.status === 'rcvError' && f.permanent));
    const descr = !usable ? undefined : f.status === 'sndComplete' ? meta?.rcvDescr : meta?.descrComplete ? meta.descrText : undefined;
    const expiresAt = f.expiresAt ?? (meta?.expiresAt ? meta.expiresAt * 1000 : undefined);
    if (!descr || (expiresAt !== undefined && expiresAt < Date.now())) return undefined;
    return {
      inv: { fileName: f.name, fileSize: f.size, fileDescr: { fileDescrText: '', fileDescrPartNo: 0, fileDescrComplete: false } },
      parts: splitFileDescr(descr),
      ...(expiresAt ? { expires: new Date(expiresAt).toISOString() } : {}),
    };
  }

  /** the file of a received message, and whether it is downloaded without asking */
  private async newRcvFile(item: ChatItem, inv: FileInvitation): Promise<void> {
    const id = localId();
    const name = safeFileName(inv.fileName);
    const size = Number(inv.fileSize);
    const d = inv.fileDescr;
    const fail = (error: string) => {
      item.file = { id, name, size: Number.isSafeInteger(size) && size > 0 ? size : 0, status: 'rcvError', error, permanent: true };
    };
    if (!Number.isSafeInteger(size) || size <= 0) return fail('the file has no size');
    // files sent over SMP connections are not used by the apps anymore
    if (!d || typeof d !== 'object') return fail('this file was sent in a way that Duplex does not support');
    if (d.fileDescrPartNo !== 0 || typeof d.fileDescrText !== 'string' || d.fileDescrText.length > MAX_DESCR_LENGTH) return fail('the file description is invalid');
    await this.files.putMeta(id, { descrText: d.fileDescrText, descrPartNo: 0, descrComplete: d.fileDescrComplete === true });
    item.file = { id, name, size, status: 'rcvInvitation' };
    const t = item.content.type;
    const auto = (t === 'image' && size <= AUTO_RECEIVE_IMAGE_SIZE) || (t === 'video' && size <= AUTO_RECEIVE_VIDEO_SIZE) || (t === 'voice' && size <= AUTO_RECEIVE_IMAGE_SIZE);
    if (auto && this.settings.autoReceiveImages !== false) Object.assign(item.file, { status: 'rcvAccepted', accepted: true });
  }

  /** appendRcvFD of simplex-chat: the parts are numbered from 1 and the description has size limits */
  private async addFileDescrPart(contactId: string, it: ChatItem, part: Record<string, unknown>, fileExpires: unknown): Promise<void> {
    const f = it.file!;
    const meta = await this.files.getMeta(f.id);
    if (!meta || meta.descrComplete || f.status === 'rcvCancelled' || f.status === 'rcvComplete' || f.status === 'rcvError') return;
    const partNo = part.fileDescrPartNo;
    const text = (meta.descrText ?? '') + (typeof part.fileDescrText === 'string' ? part.fileDescrText : '');
    if (typeof part.fileDescrText !== 'string' || typeof partNo !== 'number' || partNo !== (meta.descrPartNo ?? 0) + 1 || partNo > MAX_DESCR_PARTS || text.length > MAX_DESCR_LENGTH) {
      await this.files.delMeta(f.id);
      this.untrackTransfer(f.id);
      return this.setFile(contactId, it, { status: 'rcvError', accepted: undefined, error: 'the file description is invalid', permanent: true });
    }
    Object.assign(meta, { descrText: text, descrPartNo: partNo, descrComplete: part.fileDescrComplete === true });
    await this.files.putMeta(f.id, meta);
    const expires = typeof fileExpires === 'string' ? Date.parse(fileExpires) : NaN;
    if (!Number.isNaN(expires)) f.expiresAt = expires;
    if (meta.descrComplete) {
      try {
        const unknown = unknownServers(checkDescription(text, f.size), this.knownXftpServers());
        f.unknownServers = unknown.length ? unknown.map((s) => s.hosts[0]) : undefined;
      } catch (e) {
        this.untrackTransfer(f.id);
        return this.setFile(contactId, it, { status: 'rcvError', accepted: undefined, error: `the file cannot be received: ${(e as Error).message}`, permanent: true });
      }
    }
    await this.updateItem(contactId, it);
    if (meta.descrComplete && f.accepted) this.startDownload(contactId, it.id, f.id);
  }

  private async fileCancelledBySender(contactId: string, it: ChatItem): Promise<void> {
    const f = it.file!;
    if (f.status === 'rcvComplete' || f.status === 'rcvCancelled') return;
    if (this.files.isActive(f.id)) {
      this.files.cancel(f.id, 'sender');
      await this.files.settled(f.id);
    }
    await this.files.delMeta(f.id).catch(() => {});
    this.untrackTransfer(f.id);
    await this.setFile(contactId, it, { status: 'rcvCancelled', accepted: undefined });
  }

  /**
   * downloads a received file; approve: the user agreed to download it from file servers they do
   * not use (otherwise FileApprovalError is thrown for such files)
   */
  async receiveFile(contactId: string, itemId: string, approve = false): Promise<void> {
    const { it, f } = await this.findFile(contactId, itemId);
    if (it.dir !== 'rcv') throw new ChatError('the file was not received');
    if (f.status === 'rcvCancelled') throw new ChatError('the sender deleted the file');
    if (f.status === 'rcvError' && f.permanent) throw new ChatError(f.error ?? 'the file cannot be received');
    if (f.status !== 'rcvInvitation' && f.status !== 'rcvError') return;
    const meta = await this.files.getMeta(f.id);
    if (!meta) throw new ChatError('the file description is missing');
    if (meta.descrComplete && meta.descrText !== undefined) {
      let unknown: ProtocolServer[];
      try {
        unknown = unknownServers(checkDescription(meta.descrText, f.size), this.knownXftpServers());
      } catch (e) {
        await this.setFile(contactId, it, { status: 'rcvError', error: `the file cannot be received: ${(e as Error).message}`, permanent: true });
        throw e;
      }
      if (unknown.length && !meta.approved && !this.ipProtected() && !approve) throw new FileApprovalError(unknown.map((s) => s.hosts[0]));
    }
    if (approve && !meta.approved) await this.files.putMeta(f.id, { ...meta, approved: true });
    await this.setFile(contactId, it, { status: 'rcvAccepted', accepted: true, error: undefined });
    this.trackTransfer(f.id, contactId, it.id);
    this.startDownload(contactId, it.id, f.id);
  }

  /** stops downloading a file; it can be downloaded again */
  async cancelDownload(contactId: string, itemId: string): Promise<void> {
    const { it, f } = await this.findFile(contactId, itemId);
    if (it.dir !== 'rcv') return;
    if (this.files.isActive(f.id)) {
      this.files.cancel(f.id, 'cancelled');
      await this.files.settled(f.id);
    }
    if (f.status === 'rcvAccepted' || f.status === 'rcvTransfer') {
      this.untrackTransfer(f.id);
      await this.setFile(contactId, it, { status: 'rcvInvitation', accepted: undefined });
    }
  }

  /** deletes a sent file from the file servers (or stops uploading it) and tells the contact; the local copy stays */
  async revokeFile(contactId: string, itemId: string): Promise<void> {
    const { it, f } = await this.findFile(contactId, itemId);
    if (it.dir !== 'snd' || f.status === 'sndCancelled') return;
    if (this.files.isActive(f.id)) {
      this.files.cancel(f.id, 'revoked');
      await this.files.settled(f.id);
    }
    const meta = await this.files.getMeta(f.id);
    if (meta?.sndDescr) await deleteUploadedFile(this.files.pool, decodeFileDescription(meta.sndDescr)).catch((e) => console.warn('deleting the file from the server failed', e));
    await this.files.delMeta(f.id);
    if (it.sharedMsgId) await this.sendToChat(contactId, xFileCancel(newSharedMsgId(), it.sharedMsgId)).catch(() => {});
    this.untrackTransfer(f.id);
    await this.setFile(contactId, it, { status: 'sndCancelled', error: undefined });
  }

  /** tries a failed upload or download again */
  async retryFile(contactId: string, itemId: string): Promise<void> {
    const { it, f } = await this.findFile(contactId, itemId);
    if (it.dir === 'rcv') return this.receiveFile(contactId, itemId);
    if (f.status !== 'sndError' || f.permanent) return;
    await this.setFile(contactId, it, { status: 'sndStored', error: undefined });
    this.trackTransfer(f.id, contactId, it.id);
    this.startUpload(contactId, it.id, f.id);
  }

  /** cancels the transfer of a file and deletes its local copy; with revoke, a sent file is also deleted from the servers */
  private async dropFile(item: ChatItem, revoke: boolean): Promise<void> {
    const f = item.file;
    if (!f) return;
    if (this.files.isActive(f.id)) {
      this.files.cancel(f.id, 'deleted');
      await this.files.settled(f.id);
    }
    if (revoke && item.dir === 'snd') {
      const meta = await this.files.getMeta(f.id).catch(() => undefined);
      if (meta?.sndDescr) {
        const fd = decodeFileDescription(meta.sndDescr);
        void deleteUploadedFile(this.files.pool, fd).catch(() => {});
      }
    }
    await this.files.deleteLocal(f).catch(() => {});
    this.untrackTransfer(f.id);
  }

  /** @internal */
  async addEvent(contactId: string, text: string, memberId?: string): Promise<void> {
    await this.addItem(contactId, { id: localId(), dir: 'event', content: { type: 'text', text }, ts: Date.now(), status: 'read', ...(memberId ? { memberId } : {}) });
  }

  /** @internal the items of a deleted chat, and their files */
  async deleteChatItems(chatId: string): Promise<void> {
    const items = await this.chatItems(chatId);
    for (const it of items) await this.dropFile(it, false);
    await this.itemStore.delete(chatId);
    this.items.delete(chatId);
  }

  private async expireItems(): Promise<void> {
    const now = Date.now();
    for (const [contactId, items] of this.items) {
      const keep = items.filter((i) => !i.deleteAt || i.deleteAt > now);
      if (keep.length !== items.length) {
        this.items.set(contactId, keep);
        await this.itemStore.save(contactId, keep, 0);
        this.emit({ type: 'items', contactId });
        for (const it of items) if (!keep.includes(it)) await this.dropFile(it, false);
      }
    }
  }

  // ---- agent events

  private contactByConn(connId: string): Contact | undefined {
    const id = this.connToContact.get(connId);
    return id ? this.state.contacts[id] : undefined;
  }

  /** @internal */
  parseInfo(b: Bytes): ChatMessage | undefined {
    const ms = parseChatMessages(b);
    return ms.find((m) => m.msg)?.msg;
  }

  private async onAgentEvent(e: AgentEvent): Promise<MsgResult | void> {
    // the connections with group members, and group links
    if ('connId' in e && e.connId && this.groups.owns(e.connId)) {
      if (e.type === 'ERR') console.warn('agent error (group)', e.err);
      return this.groups.onAgentEvent(e);
    }
    switch (e.type) {
      case 'CONF': {
        const m = this.parseInfo(e.connInfo);
        const profile = m?.event === 'x.info' ? (m.params.profile as Profile) : undefined;
        let c = this.contactByConn(e.connId);
        const inv = Object.values(this.state.invitations).find((i) => i.connId === e.connId);
        if (!c) {
          const now = Date.now();
          c = { id: localId(), connId: e.connId, profile: profile ?? { displayName: 'contact', fullName: '' }, status: 'connecting', via: 'invitation-created', createdAt: now, lastActivity: now, unread: 0, incognito: inv?.incognito };
          this.state.contacts[c.id] = c;
          this.connToContact.set(e.connId, c.id);
          await this.addEvent(c.id, 'connecting…');
        } else {
          if (profile) c.profile = profile;
          if (c.status === 'requested') c.status = 'connecting';
        }
        this.notePeerPrefs(c, profile);
        if (m?.v) c.peerChatVR = m.v;
        if (inv) delete this.state.invitations[inv.id];
        await this.saveState();
        return { allow: this.encodeInfo(xInfo(this.ourProfile(c)), this.agent.pqSupport(e.connId)) };
      }
      case 'INFO': {
        const c = this.contactByConn(e.connId);
        const m = this.parseInfo(e.connInfo);
        if (c && m?.event === 'x.info' && m.params.profile) {
          c.profile = m.params.profile as Profile;
          this.notePeerPrefs(c, c.profile);
          if (m.v) c.peerChatVR = m.v;
          await this.saveState();
        }
        return;
      }
      case 'CON': {
        const c = this.contactByConn(e.connId);
        if (!c) return;
        c.status = 'active';
        c.lastActivity = Date.now();
        c.pq = this.agent.pqEncryption(c.connId);
        await this.saveState();
        await this.addEvent(c.id, c.pq ? 'connected — messages are quantum resistant end-to-end encrypted' : 'connected — messages are end-to-end encrypted');
        this.emit({ type: 'connected', contactId: c.id });
        return;
      }
      case 'REQ': {
        const m = this.parseInfo(e.connInfo);
        if (!m || m.event !== 'x.contact') return;
        const profile = m.params.profile as Profile;
        const content = m.params.content as MsgContent | undefined;
        const r: ContactRequest = { id: localId(), addressConnId: e.connId, invId: e.invId, profile, receivedAt: Date.now(), message: content ? contentText(content) : undefined };
        // a repeated request from the same profile replaces the previous one
        for (const [id, x] of Object.entries(this.state.requests)) {
          if (x.addressConnId === e.connId && x.profile?.displayName === profile?.displayName && x.profile?.image === profile?.image) delete this.state.requests[id];
        }
        this.state.requests[r.id] = r;
        await this.saveState();
        this.emit({ type: 'request', request: r });
        if (this.state.address?.autoAccept) setTimeout(() => this.acceptRequest(r.id).catch((err) => this.emit({ type: 'error', message: err.message })), 0);
        return;
      }
      case 'MSG':
        return this.onMessage(e);
      case 'SENT':
      case 'RCVD':
      case 'MERR': {
        const c = this.contactByConn(e.connId);
        if (!c) return;
        const items = await this.chatItems(c.id);
        const ids = e.type === 'RCVD' ? e.receipts.map((r) => r.msgId) : [e.msgId];
        for (const it of items) {
          if (it.dir === 'snd' && it.agentMsgId !== undefined && ids.includes(it.agentMsgId)) {
            if (e.type === 'SENT' && it.status === 'sending') it.status = 'sent';
            else if (e.type === 'RCVD') it.status = 'delivered';
            else if (e.type === 'MERR') {
              it.status = 'error';
              it.error = e.err;
            }
            await this.updateItem(c.id, it);
          }
        }
        return;
      }
      case 'UP':
        this.up.add(e.server.hosts[0]);
        this.emit({ type: 'network' });
        return;
      case 'DOWN':
        this.up.delete(e.server.hosts[0]);
        this.emit({ type: 'network' });
        return;
      case 'END': {
        const c = this.contactByConn(e.connId);
        this.emit({ type: 'error', message: `${c ? profileName(c.profile) + ': ' : ''}the connection is used by another client (is Duplex open in another tab?)` });
        return;
      }
      case 'DELD':
        return;
      case 'SWITCH': {
        const c = this.contactByConn(e.connId);
        if (!c) return;
        // the texts of the apps
        if (e.phase === 'started') await this.addEvent(c.id, e.dir === 'rcv' ? 'started changing address…' : 'started changing address for you…');
        else if (e.phase === 'completed') await this.addEvent(c.id, e.dir === 'rcv' ? 'you changed address' : 'changed address for you');
        this.emit({ type: 'state' });
        return;
      }
      case 'ERR':
        console.warn('agent error', e.connId, e.err);
        if (e.connId && e.err.startsWith('address change')) {
          const c = this.contactByConn(e.connId);
          if (c) await this.addEvent(c.id, `changing address failed: ${e.err.replace(/^address change: /, '')}`);
          this.emit({ type: 'state' });
        }
        return;
    }
  }

  connectedServers(): string[] {
    return [...this.up];
  }

  private async onMessage(e: Extract<AgentEvent, { type: 'MSG' }>): Promise<MsgResult> {
    const c = this.contactByConn(e.connId);
    if (!c) return {};
    const msgs = parseChatMessages(e.body);
    let receipt = false;
    for (const pm of msgs) {
      if (!pm.msg) {
        await this.addItem(c.id, { id: localId(), dir: 'rcv', content: { type: 'text', text: '' }, ts: Date.now(), status: 'received', error: pm.error });
        continue;
      }
      const m = pm.msg;
      if (m.v) c.peerChatVR = m.v;
      try {
        if (await this.processMsg(c, m, e)) receipt = true;
      } catch (err) {
        console.warn('message processing error', m.event, err);
      }
    }
    c.lastActivity = Date.now();
    // post-quantum encryption is agreed on the ratchet steps
    const pq = this.agent.pqEncryption(c.connId);
    if (c.status === 'active' && pq !== !!c.pq) {
      c.pq = pq;
      await this.addEvent(c.id, pq ? 'messages are now quantum resistant end-to-end encrypted' : 'messages are no longer quantum resistant (standard end-to-end encryption)');
    }
    await this.saveState();
    return { receipt: receipt && (c.sendReceipts ?? this.settings.sendReceipts) };
  }

  /**
   * @internal the content events of a contact or of a group member: new messages, edits, deletions,
   * reactions and files; returns true for messages that get delivery receipts
   */
  async processContent(t: ChatTarget, m: ChatMessage, meta: { brokerTs: number; integrity?: string; forwarded?: boolean }): Promise<boolean> {
    const chatId = t.chatId;
    const g = t.group;
    const items = await this.chatItems(chatId);
    const bySharedId = (id: unknown, dir: 'snd' | 'rcv', memberId = t.sender?.memberId) =>
      typeof id === 'string' ? items.find((i) => i.sharedMsgId === id && i.dir === dir && (!g || dir === 'snd' || i.memberId === memberId)) : undefined;
    // in groups: an item of the member with this ID, or ours
    const byAuthor = (id: unknown, author: string | undefined) => (g && author === g.memberId ? bySharedId(id, 'snd') : bySharedId(id, 'rcv', author));
    switch (m.event) {
      case 'x.msg.new': {
        if (m.msgId && bySharedId(m.msgId, 'rcv')) return true;
        const mc = m.params as MsgContainer;
        const content = mc.content ?? { type: 'text', text: '' };
        const item: ChatItem = { id: localId(), dir: 'rcv', sharedMsgId: m.msgId, content, ts: Date.now(), brokerTs: meta.brokerTs, status: 'received', integrity: meta.integrity, ...(t.sender ? { memberId: t.sender.memberId } : {}) };
        if (mc.quote) {
          const ref = mc.quote.msgRef;
          const author = g ? (normMemberId(ref?.memberId) ?? (ref?.sent ? t.sender?.memberId : undefined)) : undefined;
          const q = g ? byAuthor(ref?.msgId, author) : bySharedId(ref?.msgId, ref?.sent ? 'rcv' : 'snd');
          const sent = g ? author === g.memberId : !ref?.sent;
          item.quote = { sharedMsgId: ref?.msgId, text: q ? itemText(q) : contentText(mc.quote.content ?? { type: 'text', text: '' }), sent, ...(g && !sent && author ? { memberId: author } : {}) };
        }
        if (mc.forward) item.forwarded = true;
        if (mc.file && typeof mc.file === 'object') await this.newRcvFile(item, mc.file);
        if (typeof mc.ttl === 'number' && mc.ttl > 0) item.ttl = mc.ttl;
        const chat = g ?? this.state.contacts[chatId];
        // forwarded by an admin, with the time it was sent: the history of the group goes before newer
        // messages, and is not counted as unread
        const latest = meta.forwarded ? await this.insertItem(chatId, item) : (await this.addItem(chatId, item), true);
        if (g && t.support) {
          if (latest) this.groups.touchSupport(g, t.support, 1);
        } else if (chat && latest) chat.unread++;
        if (item.file?.status === 'rcvAccepted') {
          this.trackTransfer(item.file.id, chatId, item.id);
          this.startDownload(chatId, item.id, item.file.id);
        }
        return true;
      }
      case 'x.msg.update': {
        const it = bySharedId(m.params.msgId, 'rcv');
        if (!it || it.deleted) return false;
        it.content = m.params.content as MsgContent;
        it.edited = true;
        await this.updateItem(chatId, it);
        return false;
      }
      case 'x.msg.del': {
        // in groups, moderators delete the messages of others (memberId is the author)
        const author = g ? (normMemberId(m.params.memberId) ?? t.sender?.memberId) : undefined;
        const moderated = !!g && author !== t.sender?.memberId;
        if (moderated) {
          const target = byAuthor(m.params.msgId, author);
          const tm = author && author !== g.memberId ? g.members[author] : undefined;
          const authorRole = author === g.memberId ? g.role : tm?.role;
          if (!target || roleRank(t.sender?.role) < roleRank('moderator') || roleRank(t.sender?.role) < roleRank(authorRole)) return false;
        }
        const it = moderated ? byAuthor(m.params.msgId, author) : bySharedId(m.params.msgId, 'rcv');
        if (!it) return false;
        it.deleted = true;
        if (moderated) it.moderated = true;
        it.content = { type: 'text', text: '' };
        if (it.file) {
          await this.dropFile(it, false);
          it.file = undefined;
        }
        await this.updateItem(chatId, it);
        return false;
      }
      case 'x.msg.react': {
        const target = g ? byAuthor(m.params.msgId, normMemberId(m.params.memberId)) : (bySharedId(m.params.msgId, 'snd') ?? bySharedId(m.params.msgId, 'rcv'));
        const emoji = m.params.reaction?.emoji;
        if (!target || typeof emoji !== 'string') return false;
        target.reactions ??= {};
        const r = (target.reactions[emoji] ??= {});
        if (t.sender) {
          const others = (r.members ?? []).filter((x) => x !== t.sender!.memberId);
          r.members = m.params.add ? [...others, t.sender.memberId] : others;
          if (!r.members.length) delete r.members;
        } else r.peer = !!m.params.add;
        if (!r.me && !r.peer && !r.members?.length) delete target.reactions[emoji];
        await this.updateItem(chatId, target);
        return false;
      }
      case 'x.msg.file.descr': {
        const it = bySharedId(m.params.msgId, 'rcv');
        const part = m.params.fileDescr;
        if (it?.file && part && typeof part === 'object') await this.addFileDescrPart(chatId, it, part, m.params.fileExpires);
        return false;
      }
      case 'x.file.cancel': {
        const it = bySharedId(m.params.msgId, 'rcv');
        if (it?.file) await this.fileCancelledBySender(chatId, it);
        return false;
      }
      default:
        return false;
    }
  }

  /** returns true for messages that get delivery receipts */
  private async processMsg(c: Contact, m: ChatMessage, e: Extract<AgentEvent, { type: 'MSG' }>): Promise<boolean> {
    switch (m.event) {
      case 'x.msg.new':
      case 'x.msg.update':
      case 'x.msg.del':
      case 'x.msg.react':
      case 'x.msg.file.descr':
      case 'x.file.cancel':
        return this.processContent({ chatId: c.id }, m, { brokerTs: e.brokerTs * 1000, integrity: e.integrity });
      case 'x.info': {
        if (m.params.profile) {
          c.profile = m.params.profile as Profile;
          const note = this.notePeerPrefs(c, c.profile, true);
          if (note) await this.addEvent(c.id, note);
        }
        return false;
      }
      case 'x.direct.del': {
        c.status = 'deleted';
        await this.addEvent(c.id, 'the contact deleted the connection');
        return false;
      }
      case 'x.info.probe':
      case 'x.info.probe.check':
      case 'x.info.probe.ok':
      case 'x.ok':
        return false;
      case 'x.grp.inv':
        await this.groups.onInvitation(c, m);
        return true;
      case 'x.call.inv':
        await this.calls.onMessage(c, m);
        return true;
      case 'x.call.offer':
      case 'x.call.answer':
      case 'x.call.extra':
      case 'x.call.end':
        await this.calls.onMessage(c, m);
        return false;
      case 'x.file.acpt.inv':
        // files sent over SMP connections (not used by the apps anymore)
        return false;
      default:
        await this.addEvent(c.id, `unsupported message: ${m.event}`);
        return false;
    }
  }

  /** for tests and diagnostics */
  static versions() {
    return { chat: CHAT_VERSIONS };
  }

  debugText(b: Bytes): string {
    return fromUtf8Lossy(b);
  }
}
