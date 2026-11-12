// A conversation: messages, composer, message actions and the contact info panel.
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { contentText, profileName, type ChatItem, type Contact } from '../app/chat';
import { REACTIONS } from '../core/chat/protocol';
import { Avatar, fmtClock, fmtDay, fmtSize, isSimplexLink, Markdown, plainText, safeImage } from './util';
import { Icon } from './icons';
import { errorText, Modal, toast, Toggle } from './components';
import { useChatUpdates } from './layout';

const PAGE = 100;

export function ChatView({ session, contact, onBack, onDeleted }: { session: Session; contact: Contact; onBack: () => void; onDeleted: () => void }): JSX.Element {
  const chat = session.chat;
  useChatUpdates(session);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<ChatItem>();
  const [editing, setEditing] = useState<ChatItem>();
  const [menu, setMenu] = useState<{ item: ChatItem; x: number; y: number }>();
  const [info, setInfo] = useState(false);
  const [openLink, setOpenLink] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const reload = async () => setItems([...(await chat.chatItems(contact.id))]);

  useEffect(() => {
    reload();
    chat.markRead(contact.id);
    const off = chat.on((e) => {
      if ((e.type === 'newItem' || e.type === 'items') && e.contactId === contact.id) {
        reload();
        if (!document.hidden) chat.markRead(contact.id);
      }
    });
    const vis = () => !document.hidden && chat.markRead(contact.id);
    document.addEventListener('visibilitychange', vis);
    return () => {
      off();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [contact.id]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = listRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && items.length > limit) setLimit((l) => l + PAGE);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      if (editing) {
        await chat.editItem(contact.id, editing.id, t);
        setEditing(undefined);
      } else {
        stick.current = true;
        await chat.sendText(contact.id, t, reply?.id);
        setReply(undefined);
      }
      setText('');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    inputRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      setReply(undefined);
      if (editing) {
        setEditing(undefined);
        setText('');
      }
    }
  };

  const shownItems = items.filter((i) => !i.deleteAt || i.deleteAt > Date.now()).slice(-limit);
  const canSend = contact.status === 'active';
  const name = contact.localAlias || profileName(contact.profile);
  let lastDay = '';

  return (
    <div class="chat">
      <header class="chat-head">
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <button class="chat-title" onClick={() => setInfo(true)}>
          <Avatar profile={contact.profile} size={36} />
          <span>
            <span class="chat-name">{name}</span>
            <span class="chat-sub">{contact.status === 'active' ? (contact.profile.fullName || 'end-to-end encrypted') : contact.status === 'deleted' ? 'deleted the connection' : contact.status === 'requested' ? 'waiting for the contact to accept' : 'connecting…'}</span>
          </span>
        </button>
        <button class="icon-btn" onClick={() => setInfo(true)} aria-label="Contact info" title="Contact info">
          <Icon name="info" />
        </button>
      </header>
      <div class="messages" ref={listRef} onScroll={onScroll}>
        {items.length > limit && (
          <button class="load-more" onClick={() => setLimit((l) => l + PAGE)}>
            Load earlier messages
          </button>
        )}
        {shownItems.map((it) => {
          const day = fmtDay(it.brokerTs ?? it.ts);
          const sep = day !== lastDay ? <div class="day">{day}</div> : null;
          lastDay = day;
          return (
            <>
              {sep}
              {it.dir === 'event' ? (
                <div class="event" key={it.id}>
                  {contentText(it.content)}
                </div>
              ) : (
                <Bubble
                  key={it.id}
                  it={it}
                  onMenu={(x, y) => setMenu({ item: it, x, y })}
                  onLink={(u) => (isSimplexLink(u) ? setOpenLink(u) : window.open(u, '_blank', 'noopener,noreferrer'))}
                  onReact={(emoji, add) => chat.react(contact.id, it.id, emoji, add).catch((e) => toast(errorText(e), 'error'))}
                />
              )}
            </>
          );
        })}
      </div>
      <footer class="composer">
        {(reply || editing) && (
          <div class="compose-ctx">
            <Icon name={editing ? 'edit' : 'reply'} size={16} />
            <span class="ctx-text">{editing ? 'Editing message' : `Reply to: ${plainText(contentText(reply!.content)).slice(0, 120)}`}</span>
            <button
              class="icon-btn small"
              onClick={() => {
                setReply(undefined);
                if (editing) setText('');
                setEditing(undefined);
              }}
              aria-label="Cancel"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        <div class="compose-row">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            disabled={!canSend}
            placeholder={canSend ? 'Message' : contact.status === 'deleted' ? 'The contact deleted the connection' : 'Waiting for the connection…'}
            onInput={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              setText(ta.value);
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
            }}
            onKeyDown={onKey}
            aria-label="Message"
          />
          <button class="send" onClick={send} disabled={!canSend || !text.trim()} aria-label="Send" title="Send">
            <Icon name={editing ? 'check' : 'send'} />
          </button>
        </div>
      </footer>
      {menu && (
        <ItemMenu
          {...menu}
          onClose={() => setMenu(undefined)}
          canAct={canSend}
          onReply={() => {
            setReply(menu.item);
            setEditing(undefined);
            inputRef.current?.focus();
          }}
          onEdit={() => {
            setEditing(menu.item);
            setReply(undefined);
            setText(contentText(menu.item.content));
            inputRef.current?.focus();
          }}
          onDelete={(everyone) => chat.deleteItem(contact.id, menu.item.id, everyone).catch((e) => toast(errorText(e), 'error'))}
          onReact={(emoji) => chat.react(contact.id, menu.item.id, emoji, !menu.item.reactions?.[emoji]?.me).catch((e) => toast(errorText(e), 'error'))}
        />
      )}
      {info && <ContactInfo session={session} contact={contact} onClose={() => setInfo(false)} onDeleted={onDeleted} />}
      {openLink && <OpenLink session={session} link={openLink} onClose={() => setOpenLink(undefined)} />}
    </div>
  );
}

function StatusIcon({ it }: { it: ChatItem }): JSX.Element | null {
  if (it.dir !== 'snd') return null;
  switch (it.status) {
    case 'sending':
      return <Icon name="clock" size={13} class="st" title="sending" />;
    case 'sent':
      return <Icon name="check" size={14} class="st" title="sent" />;
    case 'delivered':
      return <Icon name="checks" size={15} class="st" title="delivered" />;
    case 'error':
      return <Icon name="alert" size={14} class="st err" title={it.error ?? 'error'} />;
    default:
      return null;
  }
}

function Bubble({ it, onMenu, onLink, onReact }: { it: ChatItem; onMenu: (x: number, y: number) => void; onLink: (u: string) => void; onReact: (emoji: string, add: boolean) => void }): JSX.Element {
  const c = it.content;
  const img = c.type === 'image' || c.type === 'video' ? safeImage((c as { image?: string }).image) : undefined;
  const preview = c.type === 'link' ? (c as { preview?: { uri: string; title: string; description: string; image: string } }).preview : undefined;
  const text = contentText(c);
  const open = (e: MouseEvent) => {
    e.preventDefault();
    onMenu(e.clientX, e.clientY);
  };
  return (
    <div class={`msg ${it.dir}`}>
      <div class={`bubble ${it.deleted ? 'deleted' : ''}`} onContextMenu={open}>
        {it.forwarded && <div class="fwd">forwarded</div>}
        {it.quote && (
          <div class="quote">
            <span class="quote-who">{it.quote.sent ? 'you' : 'contact'}</span>
            <span class="quote-text">{plainText(it.quote.text) || '…'}</span>
          </div>
        )}
        {it.deleted ? (
          <i>message deleted</i>
        ) : (
          <>
            {img && <img class="msg-img" src={img} alt={text || 'image'} />}
            {preview && (
              <div class="link-preview">
                {safeImage(preview.image) && <img src={safeImage(preview.image)} alt="" />}
                <div>
                  <b>{preview.title}</b>
                  <span>{preview.description}</span>
                </div>
              </div>
            )}
            {it.file && (
              <div class="file">
                <Icon name="file" size={18} /> {it.file.name} <span class="muted">{fmtSize(it.file.size)}</span>
                <div class="hint">Files are not supported in Duplex yet</div>
              </div>
            )}
            {c.type === 'voice' && <div class="hint">voice message — not supported in Duplex yet</div>}
            {text && (
              <div class="text">
                <Markdown text={text} onLink={onLink} />
              </div>
            )}
            {!text && !img && !it.file && c.type !== 'voice' && !preview && <div class="hint">{it.error ? `error: ${it.error}` : `unsupported content: ${c.type}`}</div>}
          </>
        )}
        <span class="meta">
          {it.deleteAt && <Icon name="clock" size={11} title="disappearing message" />}
          {it.edited && !it.deleted && <span>edited</span>}
          {it.integrity && <span class="err" title={it.integrity}>!</span>}
          <span>{fmtClock(it.brokerTs ?? it.ts)}</span>
          <StatusIcon it={it} />
        </span>
        <button class="more" onClick={(e) => onMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY)} aria-label="Message actions">
          <Icon name="more" size={16} />
        </button>
      </div>
      {it.reactions && Object.keys(it.reactions).length > 0 && (
        <div class="reactions">
          {Object.entries(it.reactions).map(([emoji, r]) => (
            <button class={`reaction ${r.me ? 'mine' : ''}`} onClick={() => onReact(emoji, !r.me)} title={[r.me && 'you', r.peer && 'contact'].filter(Boolean).join(', ')}>
              {emoji} {(r.me ? 1 : 0) + (r.peer ? 1 : 0)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemMenu({
  item,
  x,
  y,
  canAct,
  onClose,
  onReply,
  onEdit,
  onDelete,
  onReact,
}: {
  item: ChatItem;
  x: number;
  y: number;
  canAct: boolean;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: (everyone: boolean) => void;
  onReact: (emoji: string) => void;
}): JSX.Element {
  const style = { left: `${Math.min(x, window.innerWidth - 230)}px`, top: `${Math.min(y, window.innerHeight - 280)}px` };
  const act = (f: () => void) => () => {
    f();
    onClose();
  };
  const text = contentText(item.content);
  return (
    <div class="menu-bg" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <div class="menu" style={style} onClick={(e) => e.stopPropagation()} role="menu">
        {canAct && !item.deleted && item.sharedMsgId && (
          <div class="menu-reactions">
            {REACTIONS.map((r) => (
              <button onClick={act(() => onReact(r))} aria-label={`react ${r}`}>
                {r}
              </button>
            ))}
          </div>
        )}
        {canAct && !item.deleted && item.sharedMsgId && (
          <button onClick={act(onReply)} role="menuitem">
            <Icon name="reply" size={16} /> Reply
          </button>
        )}
        {text && !item.deleted && (
          <button onClick={act(() => navigator.clipboard.writeText(text).then(() => toast('Copied')))} role="menuitem">
            <Icon name="copy" size={16} /> Copy
          </button>
        )}
        {canAct && item.dir === 'snd' && !item.deleted && item.sharedMsgId && item.content.type === 'text' && (
          <button onClick={act(onEdit)} role="menuitem">
            <Icon name="edit" size={16} /> Edit
          </button>
        )}
        {canAct && item.dir === 'snd' && !item.deleted && item.sharedMsgId && (
          <button onClick={act(() => onDelete(true))} role="menuitem" class="danger">
            <Icon name="trash" size={16} /> Delete for everyone
          </button>
        )}
        <button onClick={act(() => onDelete(false))} role="menuitem" class="danger">
          <Icon name="trash" size={16} /> Delete for me
        </button>
      </div>
    </div>
  );
}

function ContactInfo({ session, contact, onClose, onDeleted }: { session: Session; contact: Contact; onClose: () => void; onDeleted: () => void }): JSX.Element {
  const chat = session.chat;
  const [alias, setAlias] = useState(contact.localAlias ?? '');
  const [confirm, setConfirm] = useState(false);
  const conn = chat.agent.getConn(contact.connId);
  const p = contact.profile;
  return (
    <Modal title="Contact" onClose={onClose}>
      <div class="profile-card">
        <Avatar profile={p} size={88} />
        <h3>{profileName(p)}</h3>
        {p.fullName && <p class="muted">{p.fullName}</p>}
        {p.shortDescr && <p>{p.shortDescr}</p>}
      </div>
      <label>
        Local name (only you see it)
        <input value={alias} onInput={(e) => setAlias((e.target as HTMLInputElement).value)} onBlur={() => chat.setAlias(contact.id, alias)} placeholder={profileName(p)} />
      </label>
      <Toggle checked={contact.sendReceipts ?? session.settings.sendReceipts} onChange={(v) => chat.updateContact(contact.id, { sendReceipts: v })} label="Send delivery receipts" hint="Let this contact see when messages are delivered to you" />
      <Toggle checked={!!contact.favorite} onChange={(v) => chat.updateContact(contact.id, { favorite: v })} label="Favorite" />
      <Toggle checked={!!contact.muted} onChange={(v) => chat.updateContact(contact.id, { muted: v })} label="Mute notifications" />
      <div class="kv">
        <span>Status</span>
        <span>{contact.status}</span>
        <span>Encryption</span>
        <span>double ratchet (X448, AES-256-GCM)</span>
        <span>Receiving via</span>
        <span>{conn?.rcv?.server.hosts[0] ?? '—'}</span>
        <span>Sending via</span>
        <span>{conn?.snd?.server.hosts[0] ?? '—'}</span>
        {contact.peerChatVR && (
          <>
            <span>Peer protocol</span>
            <span>
              chat v{contact.peerChatVR.min}–{contact.peerChatVR.max}
            </span>
          </>
        )}
      </div>
      <div class="row">
        <button onClick={() => chat.clearChat(contact.id)}>Clear chat</button>
        {!confirm ? (
          <button class="danger" onClick={() => setConfirm(true)}>
            Delete contact
          </button>
        ) : (
          <button
            class="danger"
            onClick={async () => {
              await chat.deleteContact(contact.id, true);
              onClose();
              onDeleted();
            }}
          >
            Confirm delete
          </button>
        )}
      </div>
    </Modal>
  );
}

function OpenLink({ session, link, onClose }: { session: Session; link: string; onClose: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="SimpleX link" onClose={onClose}>
      <p>Connect via this link? The link owner will see your profile.</p>
      <p class="mono small">{link}</p>
      <div class="row">
        <button onClick={onClose}>Cancel</button>
        <button
          class="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await session.chat.connect(link);
              toast('Connecting…');
              onClose();
            } catch (e) {
              toast(errorText(e), 'error');
              setBusy(false);
            }
          }}
        >
          Connect
        </button>
      </div>
    </Modal>
  );
}
