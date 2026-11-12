// Main layout: chat list and the selected chat.
import type { JSX } from 'preact';
import { useEffect, useMemo, useReducer, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { contentText, profileName, type ChatItem, type Contact, type ContactRequest, type PendingInvitation } from '../app/chat';
import { Avatar, fmtTime, plainText } from './util';
import { Icon } from './icons';
import { ChatView } from './chatview';
import { NewChat } from './newchat';
import { Settings } from './settings';
import { RequestView, InvitationView } from './requests';
import { toast } from './components';

export type Selection = { kind: 'contact'; id: string } | { kind: 'request'; id: string } | { kind: 'invitation'; id: string } | undefined;

export function useChatUpdates(session: Session): number {
  const [n, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => session.chat.on(() => bump(0)), [session]);
  return n;
}

function lastItemPreview(items: ChatItem[] | undefined): { text: string; ts?: number } {
  if (!items?.length) return { text: '' };
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.dir === 'event') return { text: contentText(it.content), ts: it.ts };
    const t = it.deleted ? 'message deleted' : plainText(contentText(it.content)) || (it.content.type === 'image' ? '🖼 image' : it.file ? `📎 ${it.file.name}` : it.content.type);
    return { text: (it.dir === 'snd' ? 'you: ' : '') + t, ts: it.brokerTs ?? it.ts };
  }
  return { text: '' };
}

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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p: Record<string, ChatItem[]> = {};
      for (const c of contacts) p[c.id] = await chat.chatItems(c.id);
      if (!cancelled) setPreviews(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [contacts.map((c) => c.id + c.lastActivity + c.unread).join()]);

  useEffect(() => {
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
    let t = setTimeout(onLock, mins * 60000);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(onLock, mins * 60000);
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
  const shown = useMemo(
    () => contacts.filter((c) => !f || profileName(c.profile).toLowerCase().includes(f) || (c.localAlias ?? '').toLowerCase().includes(f) || (c.profile.fullName ?? '').toLowerCase().includes(f)),
    [contacts, f],
  );
  const up = chat.connectedServers().length;
  const selContact = sel?.kind === 'contact' ? chat.contact(sel.id) : undefined;
  const selRequest = sel?.kind === 'request' ? chat.state.requests[sel.id] : undefined;
  const selInvitation = sel?.kind === 'invitation' ? chat.state.invitations[sel.id] : undefined;
  const hasSel = !!(selContact || selRequest || selInvitation);

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
          {shown.map((c) => (
            <ContactRow key={c.id} c={c} items={previews[c.id]} active={sel?.kind === 'contact' && sel.id === c.id} onClick={() => setSel({ kind: 'contact', id: c.id })} />
          ))}
          {!contacts.length && !requests.length && !invitations.length && (
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
        {selContact ? (
          <ChatView key={selContact.id} session={session} contact={selContact} onBack={() => setSel(undefined)} onDeleted={() => setSel(undefined)} />
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
  if (c?.muted) return;
  const title = mode === 'full' && c ? c.localAlias || profileName(c.profile) : 'Duplex';
  const body = mode === 'full' ? plainText(contentText(item.content)) || 'new message' : 'New message';
  try {
    new Notification(title, { body, silent: false, tag: mode === 'full' ? contactId : 'duplex' });
  } catch {
    // notifications may be unavailable
  }
}
