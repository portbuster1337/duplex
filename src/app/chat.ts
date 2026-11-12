// Chat client: contacts, contact requests and chat items on top of the SMP agent, speaking the
// SimpleX Chat protocol with the official apps.
import { Agent, type AgentEvent, type MsgResult } from '../core/agent/agent';
import type { Connector } from '../core/smp/client';
import type { ProtocolServer } from '../core/smp/server';
import { fromUtf8Lossy, type Bytes } from '../core/util/bytes';
import { isShortLink, parseShortLink } from '../core/agent/shortlink';
import {
  CHAT_VERSIONS,
  contactShortLinkData,
  encodeChatMessage,
  MAX_CONN_INFO_LENGTH,
  MAX_ENCODED_MSG_LENGTH,
  newSharedMsgId,
  parseChatMessages,
  parseShortLinkData,
  xContact,
  xDirectDel,
  xInfo,
  xMsgDel,
  xMsgNew,
  xMsgReact,
  xMsgUpdate,
  type ChatMessage,
  type MsgContainer,
  type MsgContent,
  type Profile,
} from '../core/chat/protocol';
import { ItemStore, VaultAgentStore } from './store';
import type { Vault } from './vault';

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
  /** timed messages TTL in seconds, set when both sides allow it */
  ttl?: number;
}

export interface PendingInvitation {
  id: string;
  connId: string;
  link: string;
  createdAt: number;
  label?: string;
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
  quote?: { sharedMsgId?: string; text: string; sent: boolean };
  edited?: boolean;
  deleted?: boolean;
  forwarded?: boolean;
  reactions?: Record<string, { me?: boolean; peer?: boolean }>;
  /** disappearing message: deletion time */
  deleteAt?: number;
  file?: { name: string; size: number };
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
}

interface ChatState {
  contacts: Record<string, Contact>;
  requests: Record<string, ContactRequest>;
  invitations: Record<string, PendingInvitation>;
  address?: Address;
}

export type ChatEvent =
  | { type: 'state' }
  | { type: 'items'; contactId: string }
  | { type: 'newItem'; contactId: string; item: ChatItem }
  | { type: 'request'; request: ContactRequest }
  | { type: 'connected'; contactId: string }
  | { type: 'network' }
  | { type: 'error'; message: string };

function localId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULT_PREFERENCES = {
  timedMessages: { allow: 'yes' as const },
  fullDelete: { allow: 'no' as const },
  reactions: { allow: 'yes' as const },
  voice: { allow: 'no' as const },
  files: { allow: 'no' as const },
  calls: { allow: 'no' as const },
};

export function withDefaultPreferences(p: Profile): Profile {
  return { ...p, preferences: { ...DEFAULT_PREFERENCES, ...(p.preferences ?? {}), voice: { allow: 'no' }, files: { allow: 'no' }, calls: { allow: 'no' } } };
}

export function profileName(p?: Profile): string {
  return p?.displayName?.trim() || 'unknown';
}

export function contentText(c: MsgContent): string {
  return typeof c.text === 'string' ? c.text : '';
}

export class ChatError extends Error {}

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

  constructor(
    private vault: Vault,
    public settings: ChatSettings,
    connector: Connector,
    servers: ProtocolServer[],
  ) {
    this.agent = new Agent(new VaultAgentStore(vault), connector, { servers, shortLinks: settings.shortLinks });
    this.agent.onEvent = (e) => this.onAgentEvent(e);
    this.itemStore = new ItemStore<ChatItem>(vault);
  }

  on(f: (e: ChatEvent) => void): () => void {
    this.listeners.push(f);
    return () => {
      this.listeners = this.listeners.filter((g) => g !== f);
    };
  }

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
    if (s) this.state = { contacts: s.contacts ?? {}, requests: s.requests ?? {}, invitations: s.invitations ?? {}, address: s.address };
    for (const c of Object.values(this.state.contacts)) this.connToContact.set(c.connId, c.id);
    await this.agent.start();
    this.ttlTimer = setInterval(() => this.expireItems(), 10000);
  }

  stop(): void {
    clearInterval(this.ttlTimer);
    this.agent.stop();
  }

  /** after stop: resolves when the event handlers and writes that were running have finished */
  async idle(): Promise<void> {
    await this.agent.idle();
    await this.stateWrite;
    await this.itemStore.idle();
  }

  private saveState(): Promise<void> {
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
      it = await this.itemStore.load(contactId);
      this.items.set(contactId, it);
    }
    return it;
  }

  private async addItem(contactId: string, item: ChatItem): Promise<void> {
    const items = await this.chatItems(contactId);
    items.push(item);
    await this.itemStore.save(contactId, items, items.length - 1);
    this.emit({ type: 'newItem', contactId, item });
  }

  private async updateItem(contactId: string, item: ChatItem): Promise<void> {
    const items = await this.chatItems(contactId);
    const i = items.findIndex((x) => x.id === item.id);
    if (i < 0) return;
    items[i] = item;
    await this.itemStore.save(contactId, items, i);
    this.emit({ type: 'items', contactId });
  }

  private ourProfile(): Profile {
    return withDefaultPreferences(this.settings.profile);
  }

  private encodeInfo(m: ChatMessage): Bytes {
    const b = encodeChatMessage(m);
    if (b.length > MAX_CONN_INFO_LENGTH) throw new ChatError('profile is too large (try a smaller picture)');
    return b;
  }

  // ---- connecting

  /** creates a 1-time invitation link */
  async createInvitation(label?: string): Promise<PendingInvitation> {
    const r = await this.agent.createInvitation({ userData: contactShortLinkData(this.ourProfile()) });
    const inv: PendingInvitation = { id: localId(), connId: r.connId, link: r.link, createdAt: Date.now(), label };
    this.state.invitations[inv.id] = inv;
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
  async previewLink(link: string): Promise<{ kind: 'invitation' | 'contact' | 'group' | 'channel'; profile?: Profile; message?: string; resolved?: Awaited<ReturnType<Agent['resolveLink']>> }> {
    const l = link.trim();
    if (isShortLink(l)) {
      const sl = parseShortLink(l);
      if (sl.mode === 'contact' && (sl.type === 'G' || sl.type === 'C' || sl.type === 'R')) return { kind: sl.type === 'G' ? 'group' : 'channel' };
      const resolved = await this.agent.resolveLink(l);
      const d = parseShortLinkData(resolved.userData);
      return { kind: sl.mode === 'invitation' ? 'invitation' : 'contact', profile: d.profile, message: d.message ? contentText(d.message) : undefined, resolved };
    }
    const resolved = await this.agent.resolveLink(l);
    return { kind: resolved.connReq.mode === 'invitation' ? 'invitation' : 'contact', resolved };
  }

  /** connects via a 1-time invitation or a contact address */
  async connect(link: string, opts: { resolved?: Awaited<ReturnType<Agent['resolveLink']>>; message?: string } = {}): Promise<Contact> {
    const resolved = opts.resolved ?? (await this.agent.resolveLink(link));
    if (resolved.connReq.data.clientData) {
      // group links carry group data
      try {
        const d = JSON.parse(resolved.connReq.data.clientData);
        if (d && d.groupLinkId) throw new ChatError('groups are not supported yet');
      } catch (e) {
        if (e instanceof ChatError) throw e;
      }
    }
    const d = parseShortLinkData(resolved.userData);
    const profile: Profile = d.profile ?? { displayName: 'contact', fullName: '' };
    const isInv = resolved.connReq.mode === 'invitation';
    let connInfo: Bytes;
    if (isInv) connInfo = this.encodeInfo(xInfo(this.ourProfile()));
    else {
      const msg = opts.message?.trim() ? { msgId: newSharedMsgId(), content: { type: 'text', text: opts.message.trim() } as MsgContent } : undefined;
      connInfo = this.encodeInfo(xContact(this.ourProfile(), newSharedMsgId(), msg));
    }
    const connId = await this.agent.joinConnection(resolved, connInfo);
    const now = Date.now();
    const c: Contact = { id: localId(), connId, profile, status: isInv ? 'connecting' : 'requested', via: isInv ? 'invitation-joined' : 'address-request', createdAt: now, lastActivity: now, unread: 0 };
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
    const body = encodeChatMessage(m);
    if (body.length > MAX_ENCODED_MSG_LENGTH) throw new ChatError('message is too large');
    return this.agent.sendMessage(c.connId, body, m.event === 'x.msg.new');
  }

  private activeContact(contactId: string): Contact {
    const c = this.state.contacts[contactId];
    if (!c) throw new ChatError('contact not found');
    if (c.status !== 'active') throw new ChatError(c.status === 'deleted' ? 'the contact deleted the connection' : 'the contact is not connected yet');
    return c;
  }

  async sendText(contactId: string, text: string, quoteItemId?: string): Promise<ChatItem> {
    const c = this.activeContact(contactId);
    const sharedMsgId = newSharedMsgId();
    const content: MsgContent = { type: 'text', text };
    const mc: MsgContainer = { content };
    let quote: ChatItem['quote'];
    if (quoteItemId) {
      const q = (await this.chatItems(contactId)).find((i) => i.id === quoteItemId);
      if (q && q.sharedMsgId) {
        mc.quote = { msgRef: { msgId: q.sharedMsgId, sentAt: new Date(q.brokerTs ?? q.ts).toISOString(), sent: q.dir === 'snd' }, content: q.content };
        quote = { sharedMsgId: q.sharedMsgId, text: contentText(q.content), sent: q.dir === 'snd' };
      }
    }
    if (c.ttl) mc.ttl = c.ttl;
    const now = Date.now();
    const item: ChatItem = { id: localId(), dir: 'snd', sharedMsgId, content, ts: now, status: 'sending', quote, deleteAt: c.ttl ? now + c.ttl * 1000 : undefined };
    await this.addItem(contactId, item);
    try {
      item.agentMsgId = await this.send(c, xMsgNew(sharedMsgId, mc));
    } catch (e) {
      item.status = 'error';
      item.error = (e as Error).message;
    }
    await this.updateItem(contactId, item);
    c.lastActivity = now;
    await this.saveState();
    return item;
  }

  async editItem(contactId: string, itemId: string, text: string): Promise<void> {
    const c = this.activeContact(contactId);
    const items = await this.chatItems(contactId);
    const item = items.find((i) => i.id === itemId);
    if (!item || item.dir !== 'snd' || !item.sharedMsgId || item.deleted) throw new ChatError('cannot edit this message');
    const content: MsgContent = { ...item.content, text } as MsgContent;
    await this.send(c, xMsgUpdate(newSharedMsgId(), item.sharedMsgId, content));
    item.content = content;
    item.edited = true;
    await this.updateItem(contactId, item);
  }

  async deleteItem(contactId: string, itemId: string, forEveryone: boolean): Promise<void> {
    const items = await this.chatItems(contactId);
    const i = items.findIndex((x) => x.id === itemId);
    if (i < 0) return;
    const item = items[i];
    if (forEveryone && item.dir === 'snd' && item.sharedMsgId && !item.deleted) {
      const c = this.activeContact(contactId);
      await this.send(c, xMsgDel(newSharedMsgId(), item.sharedMsgId));
      item.deleted = true;
      item.content = { type: 'text', text: '' };
      await this.updateItem(contactId, item);
      return;
    }
    items.splice(i, 1);
    await this.itemStore.save(contactId, items, i);
    this.emit({ type: 'items', contactId });
  }

  async react(contactId: string, itemId: string, emoji: string, add: boolean): Promise<void> {
    const c = this.activeContact(contactId);
    const item = (await this.chatItems(contactId)).find((i) => i.id === itemId);
    if (!item || !item.sharedMsgId) return;
    await this.send(c, xMsgReact(newSharedMsgId(), item.sharedMsgId, emoji, add));
    item.reactions ??= {};
    const r = (item.reactions[emoji] ??= {});
    r.me = add;
    if (!r.me && !r.peer) delete item.reactions[emoji];
    await this.updateItem(contactId, item);
  }

  async markRead(contactId: string): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
    const items = await this.chatItems(contactId);
    let changed = -1;
    items.forEach((it, i) => {
      if (it.dir === 'rcv' && it.status === 'received') {
        it.status = 'read';
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
    this.items.set(contactId, []);
    await this.itemStore.delete(contactId);
    this.emit({ type: 'items', contactId });
  }

  async deleteContact(contactId: string, notify = true): Promise<void> {
    const c = this.state.contacts[contactId];
    if (!c) return;
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
    const p = this.ourProfile();
    const info = xInfo(p);
    for (const c of Object.values(this.state.contacts)) {
      if (c.status === 'active') await this.send(c, info).catch(() => {});
    }
    if (this.state.address) await this.agent.updateAddressData(this.state.address.connId, contactShortLinkData(p)).catch(() => {});
  }

  private async addEvent(contactId: string, text: string): Promise<void> {
    await this.addItem(contactId, { id: localId(), dir: 'event', content: { type: 'text', text }, ts: Date.now(), status: 'read' });
  }

  private async expireItems(): Promise<void> {
    const now = Date.now();
    for (const [contactId, items] of this.items) {
      const keep = items.filter((i) => !i.deleteAt || i.deleteAt > now);
      if (keep.length !== items.length) {
        this.items.set(contactId, keep);
        await this.itemStore.save(contactId, keep, 0);
        this.emit({ type: 'items', contactId });
      }
    }
  }

  // ---- agent events

  private contactByConn(connId: string): Contact | undefined {
    const id = this.connToContact.get(connId);
    return id ? this.state.contacts[id] : undefined;
  }

  private parseInfo(b: Bytes): ChatMessage | undefined {
    const ms = parseChatMessages(b);
    return ms.find((m) => m.msg)?.msg;
  }

  private async onAgentEvent(e: AgentEvent): Promise<MsgResult | void> {
    switch (e.type) {
      case 'CONF': {
        const m = this.parseInfo(e.connInfo);
        const profile = m?.event === 'x.info' ? (m.params.profile as Profile) : undefined;
        let c = this.contactByConn(e.connId);
        const inv = Object.values(this.state.invitations).find((i) => i.connId === e.connId);
        if (!c) {
          const now = Date.now();
          c = { id: localId(), connId: e.connId, profile: profile ?? { displayName: 'contact', fullName: '' }, status: 'connecting', via: 'invitation-created', createdAt: now, lastActivity: now, unread: 0 };
          this.state.contacts[c.id] = c;
          this.connToContact.set(e.connId, c.id);
          await this.addEvent(c.id, 'connecting…');
        } else {
          if (profile) c.profile = profile;
          if (c.status === 'requested') c.status = 'connecting';
        }
        if (m?.v) c.peerChatVR = m.v;
        if (inv) delete this.state.invitations[inv.id];
        await this.saveState();
        return { allow: this.encodeInfo(xInfo(this.ourProfile())) };
      }
      case 'INFO': {
        const c = this.contactByConn(e.connId);
        const m = this.parseInfo(e.connInfo);
        if (c && m?.event === 'x.info' && m.params.profile) {
          c.profile = m.params.profile as Profile;
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
        await this.saveState();
        await this.addEvent(c.id, 'connected — messages are end-to-end encrypted');
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
      case 'ERR':
        console.warn('agent error', e.connId, e.err);
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
    await this.saveState();
    return { receipt: receipt && (c.sendReceipts ?? this.settings.sendReceipts) };
  }

  /** returns true for messages that get delivery receipts */
  private async processMsg(c: Contact, m: ChatMessage, e: Extract<AgentEvent, { type: 'MSG' }>): Promise<boolean> {
    const brokerTs = e.brokerTs * 1000;
    const items = await this.chatItems(c.id);
    const bySharedId = (id: unknown, dir: 'snd' | 'rcv') => (typeof id === 'string' ? items.find((i) => i.sharedMsgId === id && i.dir === dir) : undefined);
    switch (m.event) {
      case 'x.msg.new': {
        if (m.msgId && bySharedId(m.msgId, 'rcv')) return true;
        const mc = m.params as MsgContainer;
        const content = mc.content ?? { type: 'text', text: '' };
        const item: ChatItem = { id: localId(), dir: 'rcv', sharedMsgId: m.msgId, content, ts: Date.now(), brokerTs, status: 'received', integrity: e.integrity };
        if (mc.quote) {
          const q = bySharedId(mc.quote.msgRef?.msgId, mc.quote.msgRef?.sent ? 'rcv' : 'snd');
          item.quote = { sharedMsgId: mc.quote.msgRef?.msgId, text: q ? contentText(q.content) : contentText(mc.quote.content ?? { type: 'text', text: '' }), sent: !mc.quote.msgRef?.sent };
        }
        if (mc.forward) item.forwarded = true;
        if (mc.file) item.file = { name: mc.file.fileName, size: mc.file.fileSize };
        if (typeof mc.ttl === 'number' && mc.ttl > 0) item.deleteAt = brokerTs + mc.ttl * 1000;
        c.unread++;
        await this.addItem(c.id, item);
        return true;
      }
      case 'x.msg.update': {
        const it = bySharedId(m.params.msgId, 'rcv');
        if (!it || it.deleted) return false;
        it.content = m.params.content as MsgContent;
        it.edited = true;
        await this.updateItem(c.id, it);
        return false;
      }
      case 'x.msg.del': {
        const it = bySharedId(m.params.msgId, 'rcv');
        if (!it) return false;
        it.deleted = true;
        it.content = { type: 'text', text: '' };
        await this.updateItem(c.id, it);
        return false;
      }
      case 'x.msg.react': {
        const target = bySharedId(m.params.msgId, 'snd') ?? bySharedId(m.params.msgId, 'rcv');
        const emoji = m.params.reaction?.emoji;
        if (!target || typeof emoji !== 'string') return false;
        target.reactions ??= {};
        const r = (target.reactions[emoji] ??= {});
        r.peer = !!m.params.add;
        if (!r.me && !r.peer) delete target.reactions[emoji];
        await this.updateItem(c.id, target);
        return false;
      }
      case 'x.info': {
        if (m.params.profile) c.profile = m.params.profile as Profile;
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
        await this.addEvent(c.id, `${profileName(c.profile)} invited you to the group "${m.params.groupInvitation?.groupProfile?.displayName ?? ''}" — groups are not supported yet`);
        return true;
      case 'x.call.inv':
        await this.addEvent(c.id, `${profileName(c.profile)} is calling — calls are not supported in Duplex`);
        return true;
      case 'x.call.offer':
      case 'x.call.answer':
      case 'x.call.extra':
      case 'x.call.end':
        return false;
      case 'x.file.cancel':
      case 'x.msg.file.descr':
      case 'x.file.acpt.inv':
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
