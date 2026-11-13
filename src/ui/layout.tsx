// Main layout: chat list and the selected chat.
import type { JSX } from 'preact';
import { useEffect, useMemo, useReducer, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { contentText, profileName, type ChatItem, type Contact, type ContactRequest, type PendingInvitation } from '../app/chat';
import { groupName, isModerator, memberGone, memberName, type Group } from '../app/groups';
import type { Profile } from '../core/chat/protocol';
import { Avatar, fmtTime, plainText } from './util';
import { Icon } from './icons';
import { ChatView } from './chatview';
import { NewChat } from './newchat';
import { Settings } from './settings';
import { RequestView, InvitationView } from './requests';
import { toast } from './components';
import { CallScreen, callEngine } from './callview';

export type Selection = { kind: 'contact'; id: string } | { kind: 'group'; id: string } | { kind: 'request'; id: string } | { kind: 'invitation'; id: string } | undefined;

export function useChatUpdates(session: Session): number {
  const [n, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => session.chat.on(() => bump(0)), [session]);
  return n;
}

function mediaLabel(it: ChatItem): string {
  switch (it.content.type) {
    case 'image':
      return '🖼 image';
    case 'video':
      return '🎬 video';
    case 'voice':
      return '🎤 voice message';
  }
  return it.file ? `📎 ${it.file.name}` : it.content.type;
}

function lastItemPreview(items: ChatItem[] | undefined, g?: Group): { text: string; ts?: number } {
  if (!items?.length) return { text: '' };
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.dir === 'event') {
      // the "X connected" events of earlier versions are not shown
      if (g && it.memberId && contentText(it.content).endsWith(' connected')) continue;
      return { text: contentText(it.content), ts: it.ts };
    }
    const t = it.deleted ? 'message deleted' : plainText(contentText(it.content)) || mediaLabel(it);
    const who = it.dir === 'snd' ? 'you: ' : g && it.memberId ? `${memberName(g.members[it.memberId])}: ` : '';
    return { text: who + t, ts: it.brokerTs ?? it.ts };
  }
  return { text: '' };
}

/** a contact or a group, in the order of the chat list */
type ChatEntry = { kind: 'contact'; c: Contact; at: number } | { kind: 'group'; g: Group; at: number };

export function Main({ session, onLock, onWiped }: { session: Session; onLock: () => void; onWiped: () => void }): JSX.Element {
  const chat = session.chat;
  useChatUpdates(session);
  const [sel, setSel] = useState<Selection>();
  const [modal, setModal] = useState<'new' | 'settings' | undefined>();
  const [filter, setFilter] = useState('');
  const [previews, setPreviews] = useState<Record<string, ChatItem[]>>({});
  const [, forceNet] = useReducer((x: number) => x + 1, 0);

  // load the last items of each chat for the list previews
  const contacts = chat.contacts();
  const groups = chat.groups.list();
  const entries: ChatEntry[] = [...contacts.map((c) => ({ kind: 'contact' as const, c, at: c.lastActivity })), ...groups.map((g) => ({ kind: 'group' as const, g, at: g.lastActivity }))].sort((a, b) => b.at - a.at);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p: Record<string, ChatItem[]> = {};
      for (const e of entries) {
        const id = e.kind === 'contact' ? e.c.id : e.g.id;
        p[id] = await chat.chatItems(id);
      }
      if (!cancelled) setPreviews(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [entries.map((e) => (e.kind === 'contact' ? e.c.id + e.c.lastActivity + e.c.unread : e.g.id + e.g.lastActivity + e.g.unread + e.g.status)).join()]);

  useEffect(() => {
    callEngine(session);
    // incoming calls while the page is in the background
    chat.callNotifier = (text) => {
      if (session.settings.notifications === 'off' || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        new Notification(session.settings.notifications === 'full' ? text : 'Incoming call', { tag: 'duplex-call', requireInteraction: true });
      } catch {
        // notifications may be unavailable
      }
    };
    const off = chat.on((e) => {
      if (e.type === 'network') forceNet(0);
      if (e.type === 'error') toast(e.message, 'error');
      if (e.type === 'request') toast(`Contact request from ${profileName(e.request.profile)}`);
      if (e.type === 'newItem' && e.item.dir === 'rcv') notify(session, e.contactId, e.item);
    });
    const online = () => chat.agent.retryAll();
    window.addEventListener('online', online);
    return () => {
      off();
      window.removeEventListener('online', online);
    };
  }, [session]);

  // auto-lock after inactivity
  useEffect(() => {
    const mins = session.settings.autoLockMinutes;
    if (!mins) return;
    // not during a call
    const lock = () => {
      const st = session.chat.calls.active?.status;
      if (st && st !== 'ended') t = setTimeout(lock, mins * 60000);
      else onLock();
    };
    let t = setTimeout(lock, mins * 60000);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(lock, mins * 60000);
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(t);
      evs.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [session, session.settings.autoLockMinutes]);

  const requests = Object.values(chat.state.requests).sort((a, b) => b.receivedAt - a.receivedAt);
  const invitations = Object.values(chat.state.invitations).sort((a, b) => b.createdAt - a.createdAt);
  const f = filter.trim().toLowerCase();
  const matches = (...names: Array<string | undefined>) => !f || names.some((n) => (n ?? '').toLowerCase().includes(f));
  const shown = useMemo(
    () => entries.filter((e) => (e.kind === 'contact' ? matches(profileName(e.c.profile), e.c.localAlias, e.c.profile.fullName) : matches(e.g.profile.displayName, e.g.localAlias, e.g.profile.fullName))),
    [entries.map((e) => e.at).join(), f],
  );
  const up = chat.connectedServers().length;
  const selContact = sel?.kind === 'contact' ? chat.contact(sel.id) : undefined;
  const selGroup = sel?.kind === 'group' ? chat.groupOf(sel.id) : undefined;
  const selRequest = sel?.kind === 'request' ? chat.state.requests[sel.id] : undefined;
  const selInvitation = sel?.kind === 'invitation' ? chat.state.invitations[sel.id] : undefined;
  const hasSel = !!(selContact || selGroup || selRequest || selInvitation);
  // groups, and the chats of members with the moderators of a group
  const openChat = (id: string) => setSel(chat.groupOf(id) ? { kind: 'group', id } : { kind: 'contact', id });

  return (
    <div class={`layout ${hasSel ? 'has-sel' : ''}`}>
      <aside class="sidebar">
        <header class="side-head">
          <button class="me" onClick={() => setModal('settings')} title="Settings">
            <Avatar profile={session.settings.profile} size={34} />
            <span class="me-name">{profileName(session.settings.profile)}</span>
          </button>
          <span class={`net ${up ? 'ok' : 'off'}`} title={up ? `connected to ${up} server${up > 1 ? 's' : ''}` : 'not connected'}>
            <Icon name={up ? 'wifi' : 'wifiOff'} size={18} />
          </span>
          <button class="icon-btn" onClick={onLock} title="Lock" aria-label="Lock">
            <Icon name="lock" />
          </button>
          <button class="icon-btn accent" onClick={() => setModal('new')} title="New chat" aria-label="New chat">
            <Icon name="plus" />
          </button>
        </header>
        <div class="search">
          <Icon name="search" size={16} />
          <input placeholder="Search" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} aria-label="Search chats" />
        </div>
        <div class="chat-list" role="list">
          {requests.map((r) => (
            <RequestRow key={r.id} r={r} active={sel?.kind === 'request' && sel.id === r.id} onClick={() => setSel({ kind: 'request', id: r.id })} />
          ))}
          {invitations.map((i) => (
            <InvitationRow key={i.id} i={i} active={sel?.kind === 'invitation' && sel.id === i.id} onClick={() => setSel({ kind: 'invitation', id: i.id })} />
          ))}
          {shown.map((e) =>
            e.kind === 'contact' ? (
              <ContactRow key={e.c.id} c={e.c} items={previews[e.c.id]} active={sel?.kind === 'contact' && sel.id === e.c.id} onClick={() => setSel({ kind: 'contact', id: e.c.id })} />
            ) : (
              <GroupRow key={e.g.id} g={e.g} items={previews[e.g.id]} active={sel?.kind === 'group' && (sel.id === e.g.id || sel.id.startsWith(`${e.g.id}#`))} onClick={() => setSel({ kind: 'group', id: e.g.id })} />
            ),
          )}
          {!contacts.length && !groups.length && !requests.length && !invitations.length && (
            <div class="empty-list">
              <p>No chats yet.</p>
              <button class="primary" onClick={() => setModal('new')}>
                Add a contact
              </button>
            </div>
          )}
        </div>
      </aside>
      <main class="main">
        {selContact || selGroup ? (
          <ChatView key={sel!.id} session={session} chatId={sel!.id} onBack={() => setSel(undefined)} onDeleted={() => setSel(undefined)} onOpen={openChat} />
        ) : selRequest ? (
          <RequestView session={session} request={selRequest} onDone={(c) => setSel(c ? { kind: 'contact', id: c.id } : undefined)} onBack={() => setSel(undefined)} />
        ) : selInvitation ? (
          <InvitationView session={session} inv={selInvitation} onDone={() => setSel(undefined)} onBack={() => setSel(undefined)} />
        ) : (
          <div class="placeholder">
            <img src="./favicon.svg" alt="" width={64} height={64} />
            <h2>Duplex</h2>
            <p class="muted">Messages are end-to-end encrypted. Your contacts are not identified by any user ID — only by the private connections you make.</p>
            <button class="primary" onClick={() => setModal('new')}>
              New chat
            </button>
          </div>
        )}
      </main>
      {modal === 'new' && (
        <NewChat
          session={session}
          onClose={() => setModal(undefined)}
          onOpen={(s) => {
            setModal(undefined);
            setSel(s);
          }}
        />
      )}
      {modal === 'settings' && <Settings session={session} onClose={() => setModal(undefined)} onLock={onLock} onWiped={onWiped} />}
      <CallScreen session={session} />
    </div>
  );
}

function ContactRow({ c, items, active, onClick }: { c: Contact; items?: ChatItem[]; active: boolean; onClick: () => void }): JSX.Element {
  const p = lastItemPreview(items);
  const status = c.status === 'active' ? '' : c.status === 'deleted' ? 'deleted' : c.status === 'requested' ? 'request sent' : 'connecting…';
  return (
    <button class={`row ${active ? 'active' : ''}`} onClick={onClick} role="listitem">
      <Avatar profile={c.profile} size={44} />
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">
            {c.localAlias || profileName(c.profile)}
            {c.incognito && <Icon name="incognito" size={13} class="incog" title={`incognito as ${c.incognito.displayName}`} />}
            {c.favorite && <Icon name="star" size={12} class="fav" />}
          </span>
          <span class="row-time">{p.ts ? fmtTime(p.ts) : ''}</span>
        </span>
        <span class="row-bottom">
          <span class={`row-preview ${status ? 'italic' : ''}`}>{status || p.text}</span>
          {c.unread > 0 && !c.muted && <span class="badge">{c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

function GroupRow({ g, items, active, onClick }: { g: Group; items?: ChatItem[]; active: boolean; onClick: () => void }): JSX.Element {
  const p = lastItemPreview(items, g);
  const status = g.status === 'invited' ? 'invitation to join' : g.status === 'joining' || g.status === 'connecting' ? 'connecting…' : g.status === 'pending' ? 'waiting to be accepted' : '';
  // moderators: members waiting for a review, and the chats of members with the moderators
  const waiting = isModerator(g.role) ? Object.values(g.members).filter((m) => m.review && !memberGone(m)).length : 0;
  const attention = waiting + Object.values(g.support ?? {}).reduce((n, s) => n + s.unread, 0);
  return (
    <button class={`row ${active ? 'active' : ''}`} onClick={onClick} role="listitem">
      <Avatar profile={g.profile as Profile} size={44} />
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">
            <Icon name="users" size={13} class="kind" title="group" />
            {groupName(g)}
            {g.incognito && <Icon name="incognito" size={13} class="incog" title={`incognito as ${g.incognito.displayName}`} />}
            {g.favorite && <Icon name="star" size={12} class="fav" />}
          </span>
          <span class="row-time">{p.ts ? fmtTime(p.ts) : ''}</span>
        </span>
        <span class="row-bottom">
          <span class={`row-preview ${status ? 'italic accent' : ''}`}>{status || p.text}</span>
          {g.unread > 0 && !g.muted && <span class="badge">{g.unread}</span>}
          {attention > 0 && (
            <span class="badge attention" title={waiting ? `${waiting} waiting for review` : 'new messages in chats with members'}>
              {waiting ? `${waiting} waiting` : attention}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function RequestRow({ r, active, onClick }: { r: ContactRequest; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button class={`row ${active ? 'active' : ''}`} onClick={onClick} role="listitem">
      <Avatar profile={r.profile} size={44} />
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">{profileName(r.profile)}</span>
          <span class="row-time">{fmtTime(r.receivedAt)}</span>
        </span>
        <span class="row-bottom">
          <span class="row-preview accent">contact request{r.message ? `: ${r.message}` : ''}</span>
        </span>
      </span>
    </button>
  );
}

function InvitationRow({ i, active, onClick }: { i: PendingInvitation; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button class={`row ${active ? 'active' : ''}`} onClick={onClick} role="listitem">
      <div class="avatar link-avatar">
        <Icon name="link" size={20} />
      </div>
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">{i.label || '1-time link'}</span>
          <span class="row-time">{fmtTime(i.createdAt)}</span>
        </span>
        <span class="row-bottom">
          <span class="row-preview italic">waiting for the contact to connect</span>
        </span>
      </span>
    </button>
  );
}

function notify(session: Session, contactId: string, item: ChatItem): void {
  const mode = session.settings.notifications;
  if (mode === 'off' || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const c = session.chat.contact(contactId);
  const g = session.chat.group(contactId);
  if (c?.muted || g?.muted) return;
  const title = mode === 'full' && c ? c.localAlias || profileName(c.profile) : mode === 'full' && g ? `${item.memberId ? memberName(g.members[item.memberId]) + ' @ ' : ''}${groupName(g)}` : 'Duplex';
  const body = mode === 'full' ? plainText(contentText(item.content)) || (item.file ? mediaLabel(item) : 'new message') : 'New message';
  try {
    new Notification(title, { body, silent: false, tag: mode === 'full' ? contactId : 'duplex' });
  } catch {
    // notifications may be unavailable
  }
}
