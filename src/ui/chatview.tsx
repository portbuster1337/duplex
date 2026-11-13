// A conversation with a contact or a group: messages, composer, message actions, and the contact
// and group info panels.
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { contentText, itemText, profileName, TTL_CHOICES, ttlText, type ChatItem, type Contact } from '../app/chat';
import { groupName, isModerator, memberGone, memberName, supportChatId, type Group } from '../app/groups';
import { groupPrefOn } from '../core/chat/groups';
import type { Profile } from '../core/chat/protocol';
import { GroupInfo, ReviewButtons } from './groups';
import { startCall } from './callview';
import { supportsCalls } from './webrtc';
import { hasContent } from '../app/files';
import { AttachmentStrip, FileContent, fmtDuration, saveFile, useAttachments } from './files';
import { canRecord, MAX_VOICE_SECONDS, VoiceRecorder, type Recording } from './recorder';
import { REACTIONS } from '../core/chat/protocol';
import { Avatar, fmtClock, fmtDay, isSimplexLink, Markdown, plainText, QRCode, safeImage } from './util';
import { Icon } from './icons';
import { errorText, Modal, toast, Toggle } from './components';
import { useChatUpdates } from './layout';

const PAGE = 100;

/**
 * the items shown: not the expired ones, nor in groups the "X connected" events of earlier versions
 * (the members list shows who is still connecting)
 */
const visibleItem = (i: ChatItem, group?: Group): boolean => (!i.deleteAt || i.deleteAt > Date.now()) && !(group && i.dir === 'event' && i.memberId && contentText(i.content).endsWith(' connected'));

export function ChatView({ session, chatId, onBack, onDeleted, onOpen }: { session: Session; chatId: string; onBack: () => void; onDeleted: () => void; onOpen?: (chatId: string) => void }): JSX.Element {
  const chat = session.chat;
  useChatUpdates(session);
  const contact = chat.contact(chatId);
  // a group chat, or the chat of a member with the moderators of the group
  const support = chat.supportChat(chatId);
  const group = chat.group(chatId) ?? support?.g;
  const supportMember = support && group && support.memberId !== group.memberId ? group.members[support.memberId] : undefined;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  // the message a quote was clicked for: scrolled to once it is shown, and highlighted for a moment
  const scrollTo = useRef<string>();
  const [flash, setFlash] = useState<string>();
  const { atts, add: addFiles, remove: removeFile, clear: clearFiles, ready: filesReady } = useAttachments();
  const [dragging, setDragging] = useState(false);
  const [recorder, setRecorder] = useState<VoiceRecorder>();
  const [recTick, setRecTick] = useState(0);
  const [voice, setVoice] = useState<{ rec: Recording; url: string }>();

  // the elapsed time and level of a recording, 10 times a second
  useEffect(() => {
    if (!recorder) return;
    const t = setInterval(() => setRecTick(recorder.level()), 100);
    return () => clearInterval(t);
  }, [recorder]);
  useEffect(() => () => voice && URL.revokeObjectURL(voice.url), [voice]);
  useEffect(() => () => recorder?.cancel(), [recorder]);

  const startRecording = async () => {
    const r = new VoiceRecorder();
    try {
      await r.start();
    } catch (e) {
      return toast(`The microphone is not available: ${errorText(e)}`, 'error');
    }
    r.onLimit = () => void stopRecording(r);
    setRecorder(r);
  };
  const stopRecording = async (r = recorder) => {
    if (!r) return;
    setRecorder(undefined);
    try {
      const rec = await r.stop();
      if (rec.duration < 0.5) return;
      setVoice({ rec, url: URL.createObjectURL(rec.blob) });
    } catch (e) {
      toast(`The recording failed: ${errorText(e)}`, 'error');
    }
  };
  const cancelRecording = () => {
    recorder?.cancel();
    setRecorder(undefined);
  };

  const reload = async () => setItems([...(await chat.chatItems(chatId))]);

  useEffect(() => {
    reload();
    chat.markRead(chatId);
    const off = chat.on((e) => {
      if ((e.type === 'newItem' || e.type === 'items') && e.contactId === chatId) {
        reload();
        if (!document.hidden) chat.markRead(chatId);
      }
    });
    const vis = () => !document.hidden && chat.markRead(chatId);
    document.addEventListener('visibilitychange', vis);
    return () => {
      off();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [chatId]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useLayoutEffect(() => {
    const id = scrollTo.current;
    const el = id && listRef.current?.querySelector(`[data-item="${CSS.escape(id)}"]`);
    if (!el) return;
    scrollTo.current = undefined;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), 2000);
    return () => clearTimeout(t);
  }, [flash]);

  /** goes to the message that a reply quotes */
  const showQuoted = (q: NonNullable<ChatItem['quote']>) => {
    const live = items.filter((i) => visibleItem(i, group));
    const target = live.find((i) => !!q.sharedMsgId && i.sharedMsgId === q.sharedMsgId && i.dir === (q.sent ? 'snd' : 'rcv') && (!group || q.sent || !q.memberId || i.memberId === q.memberId));
    if (!target) return toast('The original message is not in this chat');
    // older messages are shown first
    const need = live.length - live.indexOf(target);
    if (need > limit) setLimit(need + 10);
    stick.current = false;
    scrollTo.current = target.id;
    setFlash(target.id);
  };

  const onScroll = () => {
    const el = listRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && items.length > limit) setLimit((l) => l + PAGE);
  };

  const send = async () => {
    const t = text.trim();
    if (voice && !editing) {
      const v = voice;
      setVoice(undefined);
      stick.current = true;
      try {
        await chat.sendFile(chatId, { blob: v.rec.blob, name: v.rec.name, kind: 'voice', duration: v.rec.duration }, '', reply?.id);
        setReply(undefined);
      } catch (e) {
        toast(errorText(e), 'error');
      }
      return;
    }
    if (atts.length && !editing) {
      if (!filesReady) return toast('The files are still being prepared');
      const list = atts.filter((a) => a.prepared);
      const quoteId = reply?.id;
      clearFiles();
      setText('');
      setReply(undefined);
      stick.current = true;
      // the caption goes with the last file, as in the apps
      for (let i = 0; i < list.length; i++) {
        try {
          await chat.sendFile(chatId, list[i].prepared!, i === list.length - 1 ? t : '', i === 0 ? quoteId : undefined);
        } catch (e) {
          toast(`${list[i].file.name}: ${errorText(e)}`, 'error');
        }
      }
      inputRef.current?.focus();
      return;
    }
    if (!t) return;
    try {
      if (editing) {
        await chat.editItem(chatId, editing.id, t);
        setEditing(undefined);
      } else {
        stick.current = true;
        await chat.sendText(chatId, t, reply?.id);
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

  if (!contact && !group) return <div class="placeholder" />;
  const shownItems = items.filter((i) => visibleItem(i, group)).slice(-limit);
  const groupBlock = group ? (support ? chat.groups.canSendSupport(group, support.memberId) : chat.groups.canSend(group)) : undefined;
  const canSend = contact ? contact.status === 'active' : !groupBlock;
  const allowsFiles = contact ? chat.peerAllowsFiles(contact) : groupPrefOn(group!.profile, 'files');
  const allowsVoice = contact ? chat.peerAllowsVoice(contact) : groupPrefOn(group!.profile, 'voice');
  const noFiles = contact ? 'The contact does not allow files and media' : 'Files and media are not allowed in this group';
  const canAttach = canSend && !editing && allowsFiles;
  const dropFiles = (files: FileList | null | undefined) => {
    if (!files?.length) return;
    if (!canAttach) return toast(canSend ? noFiles : contact ? 'The contact is not connected' : groupBlock!, 'error');
    addFiles(files);
  };
  const name = contact ? contact.localAlias || profileName(contact.profile) : support ? (supportMember ? memberName(supportMember) : 'Chat with the moderators') : groupName(group);
  const ttl = contact ? chat.disappearingTtl(contact) : chat.groupTtl(group!);
  const verified = contact ? chat.isVerified(contact) : false;
  const members = group ? chat.groups.activeMembers(group).filter((m) => m.status === 'connected').length : 0;
  const waiting = group && !support && isModerator(group.role) && group.status === 'active' ? chat.groups.reviewMembers(group) : [];
  const sub = contact
    ? contact.status === 'active'
      ? [contact.incognito ? `incognito as ${contact.incognito.displayName}` : contact.profile.fullName || 'end-to-end encrypted', ttl ? `disappearing after ${ttlText(ttl)}` : ''].filter(Boolean).join(' · ')
      : contact.status === 'deleted'
        ? 'deleted the connection'
        : contact.status === 'requested'
          ? 'waiting for the contact to accept'
          : 'connecting…'
    : support
      ? `${groupName(group)} · ${supportMember?.review ? 'wants to join, waiting for review' : supportMember ? 'only this member and the moderators see this chat' : 'only you and the moderators see this chat'}`
      : groupStatusText(group!, members, ttl);
  const placeholder = canSend
    ? ttl
      ? `Message (disappears after ${ttlText(ttl)})`
      : 'Message'
    : contact
      ? contact.status === 'deleted'
        ? 'The contact deleted the connection'
        : 'Waiting for the connection…'
      : groupBlock!;
  let lastDay = '';
  let lastSender: string | undefined;

  return (
    <div
      class={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        setDragging(false);
        dropFiles(e.dataTransfer.files);
      }}
    >
      <header class="chat-head">
        <button class="icon-btn back" onClick={support ? () => onOpen?.(group!.id) : onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <button class="chat-title" onClick={() => setInfo(true)}>
          <Avatar profile={contact ? contact.profile : supportMember ? supportMember.profile : (group!.profile as Profile)} size={36} />
          <span>
            <span class="chat-name">
              {name}
              {verified && <Icon name="shieldCheck" size={15} class="verified" title="security code verified" />}
            </span>
            <span class="chat-sub">{sub}</span>
          </span>
        </button>
        {supportMember?.review && !memberGone(supportMember) && isModerator(group!.role) && <ReviewButtons session={session} g={group!} m={supportMember} />}
        {contact && session.settings.calls !== false && chat.calls.allowed(contact) && supportsCalls() && (
          <>
            <button class="icon-btn" disabled={!!chat.calls.active} onClick={() => startCall(session, contact.id, 'audio')} aria-label="Audio call" title="Audio call">
              <Icon name="phone" />
            </button>
            <button class="icon-btn" disabled={!!chat.calls.active} onClick={() => startCall(session, contact.id, 'video')} aria-label="Video call" title="Video call">
              <Icon name="video" />
            </button>
          </>
        )}
        <button class="icon-btn" onClick={() => setInfo(true)} aria-label={contact ? 'Contact info' : group?.channel ? 'Channel info' : 'Group info'} title={contact ? 'Contact info' : group?.channel ? 'Channel info' : 'Group info'}>
          <Icon name="info" />
        </button>
      </header>
      {group && !support && group.status === 'pending' && (
        <div class="chat-banner">
          <span>The moderators review new members. Until they accept you, you can chat with them.</span>
          <button class="small primary" onClick={() => onOpen?.(supportChatId(group.id, group.memberId))}>
            Chat with the moderators
          </button>
        </div>
      )}
      {waiting.length > 0 && (
        <div class="chat-banner">
          <span>
            {waiting.length === 1 ? `${memberName(waiting[0])} wants` : `${waiting.length} people want`} to join the group.
          </span>
          <button class="small primary" onClick={() => setInfo(true)}>
            Review
          </button>
        </div>
      )}
      <div class="messages" ref={listRef} onScroll={onScroll}>
        {items.length > limit && (
          <button class="load-more" onClick={() => setLimit((l) => l + PAGE)}>
            Load earlier messages
          </button>
        )}
        {shownItems.map((it) => {
          const day = fmtDay(it.brokerTs ?? it.ts);
          const sep = day !== lastDay ? <div class="day">{day}</div> : null;
          // in groups, the sender is shown above the first of its consecutive messages (channel posts have none)
          const sender = group && it.dir === 'rcv' ? it.memberId : undefined;
          const showSender = !!sender && (sender !== lastSender || !!sep);
          lastSender = it.dir === 'rcv' ? sender : undefined;
          lastDay = day;
          return (
            <>
              {sep}
              {it.groupInv ? (
                <GroupInvitationItem key={it.id} session={session} it={it} onOpen={onOpen} />
              ) : it.dir === 'event' ? (
                <div class="event" key={it.id}>
                  {contentText(it.content)}
                </div>
              ) : (
                <Bubble
                  key={it.id}
                  session={session}
                  contactId={chatId}
                  it={it}
                  group={group}
                  showSender={showSender}
                  flash={flash === it.id}
                  onQuote={() => it.quote && showQuoted(it.quote)}
                  onMenu={(x, y) => setMenu({ item: it, x, y })}
                  onLink={(u) => (isSimplexLink(u) ? setOpenLink(u) : window.open(u, '_blank', 'noopener,noreferrer'))}
                  onReact={(emoji, add) => chat.react(chatId, it.id, emoji, add).catch((e) => toast(errorText(e), 'error'))}
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
            <span class="ctx-text">{editing ? 'Editing message' : `Reply to: ${plainText(itemText(reply!)).slice(0, 120)}`}</span>
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
        <AttachmentStrip atts={atts} onRemove={removeFile} />
        {voice && (
          <div class="voice-preview">
            <Icon name="mic" size={18} />
            <audio src={voice.url} controls preload="metadata" aria-label="Recorded voice message" />
            <span class="muted">{fmtDuration(voice.rec.duration)}</span>
            <button class="icon-btn" onClick={() => setVoice(undefined)} aria-label="Delete the recording" title="Delete the recording">
              <Icon name="trash" size={18} />
            </button>
          </div>
        )}
        {recorder && (
          <div class="recording" role="status">
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-time">
              {fmtDuration(recorder.elapsed)} / {fmtDuration(MAX_VOICE_SECONDS)}
            </span>
            <span class="rec-level" aria-hidden="true">
              <span style={{ width: `${Math.round(Math.min(1, recTick * 1.6) * 100)}%` }} />
            </span>
            <button class="icon-btn" onClick={cancelRecording} aria-label="Cancel recording" title="Cancel">
              <Icon name="trash" size={18} />
            </button>
            <button class="primary small" onClick={() => void stopRecording()} aria-label="Stop recording">
              Stop
            </button>
          </div>
        )}
        <div class="compose-row">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              dropFiles(el.files);
              el.value = '';
            }}
          />
          <button
            class="icon-btn attach"
            onClick={() => fileRef.current?.click()}
            disabled={!canAttach}
            aria-label="Attach files"
            title={canSend && !allowsFiles ? noFiles : 'Attach files or images'}
          >
            <Icon name="paperclip" />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            disabled={!canSend}
            placeholder={placeholder}
            onInput={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              setText(ta.value);
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
            }}
            onKeyDown={onKey}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files?.length && canAttach) {
                e.preventDefault();
                dropFiles(files);
              }
            }}
            aria-label="Message"
          />
          {canAttach && allowsVoice && canRecord() && !text.trim() && !atts.length && !voice && !recorder ? (
            <button class="send" onClick={startRecording} aria-label="Record a voice message" title="Record a voice message">
              <Icon name="mic" />
            </button>
          ) : (
            <button class="send" onClick={send} disabled={!canSend || !!recorder || (!text.trim() && !((atts.length || voice) && !editing))} aria-label="Send" title="Send">
              <Icon name={editing ? 'check' : 'send'} />
            </button>
          )}
        </div>
      </footer>
      {menu && (
        <ItemMenu
          {...menu}
          onClose={() => setMenu(undefined)}
          canAct={canSend}
          canDeleteForEveryone={!menu.item.deleted && !!menu.item.sharedMsgId && canSend && (menu.item.dir === 'snd' || (!!group && menu.item.dir === 'rcv' && chat.canModerate(group, menu.item)))}
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
          onDelete={(everyone) => chat.deleteItem(chatId, menu.item.id, everyone).catch((e) => toast(errorText(e), 'error'))}
          onReact={(emoji) => chat.react(chatId, menu.item.id, emoji, !menu.item.reactions?.[emoji]?.me).catch((e) => toast(errorText(e), 'error'))}
          onSave={menu.item.file && hasContent(menu.item.file) ? () => saveFile(session, menu.item.file!).catch((e) => toast(errorText(e), 'error')) : undefined}
          onRevoke={
            menu.item.dir === 'snd' && menu.item.file && !['sndCancelled', 'sndError'].includes(menu.item.file.status)
              ? () =>
                  chat
                    .revokeFile(chatId, menu.item.id)
                    .then(() => toast('The file was deleted from the server'))
                    .catch((e) => toast(errorText(e), 'error'))
              : undefined
          }
        />
      )}
      {info && contact && <ContactInfo session={session} contact={contact} onClose={() => setInfo(false)} onDeleted={onDeleted} />}
      {info && group && (
        <GroupInfo
          session={session}
          group={group}
          onClose={() => setInfo(false)}
          onDeleted={onDeleted}
          onOpenChat={(id) => {
            setInfo(false);
            onOpen?.(id);
          }}
        />
      )}
      {openLink && <OpenLink session={session} link={openLink} onClose={() => setOpenLink(undefined)} onOpen={onOpen} />}
    </div>
  );
}

function groupStatusText(g: Group, connected: number, ttl?: number): string {
  if (g.channel && g.status === 'active') {
    const n = g.channel.subscribers;
    return ['channel', n !== undefined ? `${n} subscriber${n === 1 ? '' : 's'}` : '', g.incognito ? `incognito as ${g.incognito.displayName}` : ''].filter(Boolean).join(' · ');
  }
  switch (g.status) {
    case 'invited':
      return 'you are invited';
    case 'joining':
    case 'connecting':
      return 'connecting…';
    case 'pending':
      return 'waiting for the admins to accept you';
    case 'left':
      return 'you left';
    case 'removed':
      return 'you were removed';
    case 'deleted':
      return 'the group was deleted';
    case 'rejected':
      return 'your request to join was rejected';
    default:
      return [`${connected + 1} member${connected ? 's' : ''}`, g.incognito ? `incognito as ${g.incognito.displayName}` : '', ttl ? `disappearing after ${ttlText(ttl)}` : ''].filter(Boolean).join(' · ');
  }
}

/** an invitation to a group, in the chat with the contact who sent it */
function GroupInvitationItem({ session, it, onOpen }: { session: Session; it: ChatItem; onOpen?: (chatId: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const inv = it.groupInv!;
  const g = session.chat.group(inv.groupId);
  const pending = inv.status === 'pending' && g?.status === 'invited';
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  return (
    <div class="msg rcv">
      <div class="bubble group-inv">
        <div class="group-inv-head">
          <Avatar profile={(g?.profile as Profile) ?? { displayName: inv.name, fullName: '' }} size={40} />
          <span>
            <b>{inv.name}</b>
            <span class="muted small">invitation to join as {inv.role}</span>
          </span>
        </div>
        {g?.profile.description && <p class="small">{g.profile.description}</p>}
        {pending ? (
          <div class="row">
            <button disabled={busy} onClick={() => run(() => session.chat.groups.reject(inv.groupId))}>
              Reject
            </button>
            <button
              class="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await session.chat.groups.accept(inv.groupId);
                  onOpen?.(inv.groupId);
                })
              }
            >
              Join group
            </button>
          </div>
        ) : (
          <p class="muted small">{inv.status === 'accepted' ? 'you joined' : inv.status === 'rejected' ? 'you rejected the invitation' : 'the invitation is no longer valid'}</p>
        )}
        <span class="meta">
          <span>{fmtClock(it.brokerTs ?? it.ts)}</span>
        </span>
      </div>
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

function Bubble({
  session,
  contactId,
  it,
  group,
  showSender,
  flash,
  onQuote,
  onMenu,
  onLink,
  onReact,
}: {
  session: Session;
  contactId: string;
  it: ChatItem;
  group?: Group;
  showSender?: boolean;
  /** just gone to from a reply that quotes it */
  flash?: boolean;
  onQuote: () => void;
  onMenu: (x: number, y: number) => void;
  onLink: (u: string) => void;
  onReact: (emoji: string, add: boolean) => void;
}): JSX.Element {
  const sender = group && it.memberId ? group.members[it.memberId] : undefined;
  // posts sent as a channel are its own: shown without a sender
  const inGroup = !!group && it.dir === 'rcv' && !(group.channel && !it.memberId);
  const quoteWho = it.quote ? (it.quote.sent ? 'you' : group ? (it.quote.memberId && group.members[it.quote.memberId] ? memberName(group.members[it.quote.memberId]) : 'member') : 'contact') : '';
  const c = it.content;
  // images and videos with files are shown by FileContent
  const img = !it.file && (c.type === 'image' || c.type === 'video') ? safeImage((c as { image?: string }).image) : undefined;
  const preview = c.type === 'link' ? (c as { preview?: { uri: string; title: string; description: string; image: string } }).preview : undefined;
  const text = contentText(c);
  const open = (e: MouseEvent) => {
    e.preventDefault();
    onMenu(e.clientX, e.clientY);
  };
  return (
    <div class={`msg ${it.dir} ${inGroup ? 'in-group' : ''} ${flash ? 'flash' : ''}`} data-item={it.id}>
      {inGroup && (showSender ? <Avatar profile={sender?.profile} size={28} /> : <span class="avatar-gap" />)}
      <div class={`bubble ${it.deleted ? 'deleted' : ''} ${it.file && (c.type === 'image' || c.type === 'video') ? 'has-media' : ''}`} onContextMenu={open}>
        {showSender && (
          <div class="sender">
            {sender ? memberName(sender) : 'member'}
            {sender && sender.role !== 'member' && <span class="role">{sender.role}</span>}
          </div>
        )}
        {it.forwarded && <div class="fwd">forwarded</div>}
        {it.quote && (
          <button class="quote" onClick={onQuote} title="Go to the message">
            <span class="quote-who">{quoteWho}</span>
            <span class="quote-text">{plainText(it.quote.text) || '…'}</span>
          </button>
        )}
        {it.deleted ? (
          <i>{it.moderated ? 'removed by a moderator' : 'message deleted'}</i>
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
            {it.file && <FileContent session={session} contactId={contactId} it={it} />}
            {c.type === 'voice' && !it.file && <div class="hint">voice message</div>}
            {text && (
              <div class="text">
                <Markdown text={text} onLink={onLink} />
              </div>
            )}
            {!text && !img && !it.file && c.type !== 'voice' && !preview && <div class="hint">{it.error ? `error: ${it.error}` : `unsupported content: ${c.type}`}</div>}
          </>
        )}
        <span class="meta">
          {(it.deleteAt || it.ttl) && <Icon name="clock" size={11} title={it.deleteAt ? `disappears ${new Date(it.deleteAt).toLocaleString()}` : `disappears ${ttlText(it.ttl!)} after it is read`} />}
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
            <button
              class={`reaction ${r.me ? 'mine' : ''}`}
              onClick={() => onReact(emoji, !r.me)}
              title={[r.me && 'you', r.peer && 'contact', ...(r.members ?? []).map((id) => memberName(group?.members[id]))].filter(Boolean).join(', ')}
            >
              {emoji} {(r.me ? 1 : 0) + (r.peer ? 1 : 0) + (r.members?.length ?? 0)}
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
  canDeleteForEveryone,
  onClose,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onSave,
  onRevoke,
}: {
  item: ChatItem;
  x: number;
  y: number;
  canAct: boolean;
  canDeleteForEveryone: boolean;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: (everyone: boolean) => void;
  onReact: (emoji: string) => void;
  onSave?: () => void;
  onRevoke?: () => void;
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
        {onSave && (
          <button onClick={act(onSave)} role="menuitem">
            <Icon name="download" size={16} /> Save file
          </button>
        )}
        {canAct && item.dir === 'snd' && !item.deleted && item.sharedMsgId && ['text', 'image', 'video', 'file'].includes(item.content.type) && (
          <button onClick={act(onEdit)} role="menuitem">
            <Icon name="edit" size={16} /> {item.content.type === 'text' ? 'Edit' : 'Edit caption'}
          </button>
        )}
        {onRevoke && (
          <button onClick={act(onRevoke)} role="menuitem" class="danger">
            <Icon name="close" size={16} /> Delete file from server
          </button>
        )}
        {canDeleteForEveryone && (
          <button onClick={act(() => onDelete(true))} role="menuitem" class="danger">
            <Icon name="trash" size={16} /> {item.dir === 'snd' ? 'Delete for everyone' : 'Delete for everyone (moderate)'}
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
      {contact.incognito && (
        <p class="note">
          <Icon name="incognito" size={16} /> You are incognito with this contact: they see the random profile <b>{contact.incognito.displayName}</b>, not yours.
        </p>
      )}
      <Disappearing session={session} contact={contact} />
      <SecurityCode session={session} contact={contact} />
      <div class="kv">
        <span>Status</span>
        <span>{contact.status}</span>
        <span>Encryption</span>
        <span>{contact.pq ? 'quantum resistant: double ratchet with X448 and sntrup761, AES-256-GCM' : 'double ratchet (X448, AES-256-GCM)'}</span>
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
      <AddressChange session={session} contact={contact} />
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

/** changing the receiving address (queue rotation), as in the apps */
function AddressChange({ session, contact }: { session: Session; contact: Contact }): JSX.Element {
  const chat = session.chat;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const q = chat.contactQueues(contact.id);
  if (!q || contact.status !== 'active') return <></>;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (err) {
      toast(errorText(err), 'error');
    }
    setBusy(false);
    setConfirm(false);
  };
  return (
    <div class="address-change">
      {q.sndSwitch && <p class="hint">Your contact is changing their address…</p>}
      {q.rcvSwitch ? (
        <>
          <p class="hint">Changing the receiving address… It completes when your contact is online.</p>
          {q.canAbort && (
            <button disabled={busy} onClick={() => run(() => chat.abortSwitch(contact.id))}>
              Stop changing address
            </button>
          )}
        </>
      ) : confirm ? (
        <>
          <p class="hint">The receiving address will be changed to a new queue, on another of your servers if there is one. The change completes when your contact is online.</p>
          <div class="row">
            <button class="primary" disabled={busy} onClick={() => run(() => chat.switchAddress(contact.id))}>
              Change
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button onClick={() => setConfirm(true)}>Change receiving address</button>
      )}
    </div>
  );
}

function Disappearing({ session, contact }: { session: Session; contact: Contact }): JSX.Element {
  const chat = session.chat;
  const [busy, setBusy] = useState(false);
  const allowed = chat.peerAllowsTimed(contact);
  const current = contact.ttl ?? 0;
  const choices = current && !TTL_CHOICES.includes(current) ? [...TTL_CHOICES, current].sort((a, b) => a - b) : TTL_CHOICES;
  return (
    <label>
      Disappearing messages
      <select
        value={String(allowed ? current : 0)}
        disabled={busy || contact.status !== 'active' || !allowed}
        onChange={async (e) => {
          setBusy(true);
          try {
            await chat.setDisappearing(contact.id, Number((e.target as HTMLSelectElement).value) || undefined);
          } catch (err) {
            toast(errorText(err), 'error');
          }
          setBusy(false);
        }}
      >
        <option value="0">Off</option>
        {choices.map((s) => (
          <option value={String(s)}>{ttlText(s)}</option>
        ))}
      </select>
      <span class="hint">
        {allowed
          ? 'New messages are deleted for both of you after this time; the ones you receive, from when you read them. Your contact can change it too.'
          : 'The contact does not allow disappearing messages.'}
      </span>
    </label>
  );
}

function SecurityCode({ session, contact }: { session: Session; contact: Contact }): JSX.Element {
  const chat = session.chat;
  const code = chat.securityCode(contact.id);
  const verified = chat.isVerified(contact);
  const [other, setOther] = useState('');
  if (!code || contact.status !== 'active') return <></>;
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  return (
    <details class="security-code">
      <summary>
        <Icon name={verified ? 'shieldCheck' : 'shield'} size={16} /> Security code {verified ? '(verified)' : ''}
      </summary>
      <p class="hint">
        Compare this code with the one your contact sees (in the SimpleX Chat apps: contact info → Verify security code, where they can also scan this QR code). If they are the same, nobody is in the middle of your connection.
      </p>
      <QRCode text={code} size={180} />
      <p class="mono code">{code}</p>
      {verified ? (
        <button onClick={() => chat.setVerified(contact.id, false)}>Clear verification</button>
      ) : (
        <>
          <label>
            Paste your contact's code to compare (optional)
            <input value={other} onInput={(e) => setOther((e.target as HTMLInputElement).value)} inputMode="numeric" spellcheck={false} />
          </label>
          {other.trim() && <p class={same(other, code) ? 'ok' : 'error'}>{same(other, code) ? 'The codes are the same.' : 'The codes are different!'}</p>}
          <button
            class="primary"
            disabled={!!other.trim() && !same(other, code)}
            onClick={async () => {
              await chat.setVerified(contact.id, true);
              toast('Marked as verified');
            }}
          >
            Mark as verified
          </button>
        </>
      )}
    </details>
  );
}

function OpenLink({ session, link, onClose, onOpen }: { session: Session; link: string; onClose: () => void; onOpen?: (chatId: string) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="SimpleX link" onClose={onClose}>
      <p>Connect via this link? The link owner (or the group admin) will see your profile.</p>
      <p class="mono small">{link}</p>
      <div class="row">
        <button onClick={onClose}>Cancel</button>
        <button
          class="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const p = await session.chat.previewLink(link);
              if (p.kind === 'channel') throw new Error('channels are not supported yet');
              const id = p.kind === 'group' ? (await session.chat.joinGroup(link, { resolved: p.resolved })).id : (await session.chat.connect(link, { resolved: p.resolved })).id;
              toast(p.kind === 'group' ? 'Joining the group…' : 'Connecting…');
              onClose();
              onOpen?.(id);
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
