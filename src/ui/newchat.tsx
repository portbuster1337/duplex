// Adding contacts and groups: 1-time links, connecting via a link (or joining a group), the contact
// address, and new groups, as options listed in the window (the chosen one opens under its title).
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { profileName, type PendingInvitation } from '../app/chat';
import type { Profile } from '../core/chat/protocol';
import { Avatar, copyText, QRCode } from './util';
import { errorText, Modal, OptionSections, Spinner, toast, Toggle } from './components';
import { Icon } from './icons';
import type { Selection } from './layout';
import { NewGroup } from './groups';

export function NewChat({ session, onClose, onOpen }: { session: Session; onClose: () => void; onOpen: (s: Selection) => void }): JSX.Element {
  // the 1-time link is made when that option is first opened, and kept while others are opened
  const [inv, setInv] = useState<PendingInvitation>();
  return (
    <Modal title="New chat" onClose={onClose} wide>
      <OptionSections
        sections={[
          { id: 'invite', icon: 'qr', title: 'Create a 1-time link', hint: 'A link or QR code for one person to connect with you', body: () => <Invite session={session} inv={inv} setInv={setInv} onOpen={onOpen} /> },
          { id: 'connect', icon: 'link', title: 'Connect via a link', hint: 'Paste a 1-time link, a contact address or a group link', body: () => <Connect session={session} onOpen={onOpen} /> },
          { id: 'address', icon: 'mail', title: 'Your contact address', hint: 'A long-term link that people can send contact requests to', body: () => <AddressTab session={session} /> },
          { id: 'group', icon: 'users', title: 'Create a group', hint: 'Add your contacts, or share a link to the group', body: () => <NewGroup session={session} onCreated={(g) => onOpen({ kind: 'group', id: g.id })} /> },
        ]}
      />
    </Modal>
  );
}

/** a link with its QR code; compact: the QR code beside the link, so that what is around stays in view */
export function LinkShare({ link, note, compact }: { link: string; note?: string; compact?: boolean }): JSX.Element {
  const actions = (
    <div class="row">
      <button onClick={() => copyText(link).then(() => toast('Link copied'))}>
        <Icon name="copy" size={16} /> Copy link
      </button>
      {'share' in navigator && (
        <button onClick={() => navigator.share({ text: link }).catch(() => {})}>
          <Icon name="send" size={16} /> Share
        </button>
      )}
    </div>
  );
  if (compact)
    return (
      <div class="share compact">
        <QRCode text={link} size={168} />
        <div class="share-side">
          <div class="link-box">
            <span class="mono small">{link}</span>
          </div>
          {actions}
          {note && <p class="hint">{note}</p>}
        </div>
      </div>
    );
  return (
    <div class="share">
      <QRCode text={link} size={232} />
      <div class="link-box">
        <span class="mono small">{link}</span>
      </div>
      {actions}
      {note && <p class="hint">{note}</p>}
    </div>
  );
}

function Invite({ session, inv, setInv, onOpen }: { session: Session; inv?: PendingInvitation; setInv: (i: PendingInvitation) => void; onOpen: (s: Selection) => void }): JSX.Element {
  const [err, setErr] = useState('');
  // the incognito switch moves at once; the link data is updated on the router in the background
  const [wantIncognito, setWantIncognito] = useState<boolean>();
  // made once, when this option is first opened
  useEffect(() => {
    if (inv) return;
    let cancelled = false;
    session.chat
      .createInvitation()
      .then((i) => !cancelled && setInv(i))
      .catch((e) => !cancelled && setErr(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  if (err) return <p class="error">Could not create a link: {err}</p>;
  if (!inv)
    return (
      <div class="center pad">
        <Spinner label="Creating a 1-time link…" />
      </div>
    );
  const updating = wantIncognito !== undefined;
  return (
    <>
      <LinkShare compact link={inv.link} note="Show the QR code or send the link, ideally in person or through another trusted channel. It works once: the first person who uses it connects with you." />
      <Toggle
        checked={wantIncognito ?? !!inv.incognito}
        disabled={updating}
        label="Incognito"
        hint={updating ? 'Updating the link…' : inv.incognito ? `Your contact will see a random profile: ${inv.incognito.displayName}` : 'Share a new random profile with this contact instead of yours'}
        onChange={async (v) => {
          setWantIncognito(v);
          try {
            setInv({ ...(await session.chat.setInvitationIncognito(inv.id, v)) });
          } catch (e) {
            toast(errorText(e), 'error');
          }
          setWantIncognito(undefined);
        }}
      />
      <div class="row">
        <button class="link-btn" onClick={() => onOpen({ kind: 'invitation', id: inv.id })}>
          Close and wait for the contact
        </button>
      </div>
    </>
  );
}

function Connect({ session, onOpen }: { session: Session; onOpen: (s: Selection) => void }): JSX.Element {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<Session['chat']['previewLink']>>>();
  const [message, setMessage] = useState('');
  const [incognito, setIncognito] = useState(false);

  const doPreview = async () => {
    setErr('');
    setPreview(undefined);
    setBusy(true);
    try {
      setPreview(await session.chat.previewLink(link));
    } catch (e) {
      setErr(`This link cannot be used: ${errorText(e)}`);
    }
    setBusy(false);
  };

  const connect = async () => {
    setBusy(true);
    setErr('');
    try {
      if (preview?.kind === 'group' || preview?.kind === 'channel') {
        const g = await session.chat.joinGroup(link, { resolved: preview.resolved, incognito });
        onOpen({ kind: 'group', id: g.id });
        return;
      }
      const c = await session.chat.connect(link, { resolved: preview?.resolved, message, incognito });
      onOpen({ kind: 'contact', id: c.id });
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div class="connect">
      <label>
        Paste a SimpleX link (1-time link, contact address, group or channel link)
        <textarea
          rows={3}
          value={link}
          spellcheck={false}
          placeholder="https://smp….simplex.im/i#…  or  simplex:/contact#/?v=…"
          onInput={(e) => {
            setLink((e.target as HTMLTextAreaElement).value);
            setPreview(undefined);
          }}
        />
      </label>
      {!preview && (
        <button class="primary" disabled={busy || !link.trim()} onClick={doPreview}>
          {busy ? <Spinner label="Checking the link…" /> : 'Continue'}
        </button>
      )}
      {preview && (
        <div class="preview">
          {preview.kind === 'group' || preview.kind === 'channel' ? (
            <div class="profile-card small">
              <Avatar profile={(preview.groupProfile as Profile | undefined) ?? { displayName: preview.kind, fullName: '' }} size={64} />
              <h3>
                {preview.kind === 'channel' && <Icon name="megaphone" size={18} />} {preview.groupProfile?.displayName ?? `A ${preview.kind}`}
              </h3>
              {preview.groupProfile?.description && <p class="muted">{preview.groupProfile.description}</p>}
              {preview.kind === 'channel' && preview.subscribers !== undefined && <p class="muted small">{preview.subscribers} subscribers</p>}
            </div>
          ) : preview.profile ? (
            <div class="profile-card small">
              <Avatar profile={preview.profile as Profile} size={64} />
              <h3>{profileName(preview.profile)}</h3>
              {preview.profile.shortDescr && <p>{String(preview.profile.shortDescr)}</p>}
              {preview.message && <p class="muted">“{preview.message}”</p>}
            </div>
          ) : (
            <p>{preview.kind === 'invitation' ? 'A 1-time invitation link.' : 'A contact address.'}</p>
          )}
          <p class="hint">
            {preview.kind === 'invitation'
              ? 'You will share your profile with this contact. The connection is established once both of you are online.'
              : preview.kind === 'group'
                ? 'You will join this group with your profile: its members see it. The group admin accepts you, then introduces you to the members.'
                : preview.kind === 'channel'
                  ? 'You will get the posts of this channel through its chat relays. The relays and the owners see the profile you join with; other subscribers do not.'
                  : 'A contact request with your profile will be sent. The address owner can accept or reject it.'}
          </p>
          <Toggle
            checked={incognito}
            onChange={setIncognito}
            label={preview.kind === 'group' || preview.kind === 'channel' ? 'Join incognito' : 'Connect incognito'}
            hint={preview.kind === 'group' ? 'Members see a new random profile instead of yours' : preview.kind === 'channel' ? 'The relays and the owners see a new random profile instead of yours' : 'Share a new random profile with this contact instead of yours'}
          />
          {preview.kind === 'contact' && (
            <label>
              Message (optional)
              <input value={message} maxLength={500} onInput={(e) => setMessage((e.target as HTMLInputElement).value)} placeholder="Hi! It's me…" />
            </label>
          )}
          <div class="row">
            <button onClick={() => setPreview(undefined)}>Back</button>
            <button class="primary" disabled={busy} onClick={connect}>
              {busy ? <Spinner label="Connecting…" /> : preview.kind === 'invitation' ? 'Connect' : preview.kind === 'group' ? 'Join group' : preview.kind === 'channel' ? 'Join channel' : 'Send request'}
            </button>
          </div>
        </div>
      )}
      {err && <p class="error">{err}</p>}
    </div>
  );
}

function AddressTab({ session }: { session: Session }): JSX.Element {
  const chat = session.chat;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [, setN] = useState(0);
  const a = chat.state.address;
  if (!a)
    return (
      <div class="address">
        <p>A contact address is a long-term link that people can use to send you contact requests. You can share it publicly or with groups of people, and delete it at any time — the contacts made with it will remain.</p>
        <p class="hint">Use 1-time links for the best privacy: an address can be used by anyone who has it.</p>
        {err && <p class="error">{err}</p>}
        <button
          class="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await chat.createAddress();
              setN((n) => n + 1);
            } catch (e) {
              setErr(errorText(e));
            }
            setBusy(false);
          }}
        >
          {busy ? <Spinner label="Creating…" /> : 'Create address'}
        </button>
      </div>
    );
  return (
    <div class="address">
      <LinkShare compact link={a.link} note="People who use this address send you a contact request with their profile." />
      <Toggle
        checked={a.autoAccept}
        onChange={async (v) => {
          await chat.setAutoAccept(v);
          setN((n) => n + 1);
        }}
        label="Accept requests automatically"
      />
      {!confirm ? (
        <button class="danger" onClick={() => setConfirm(true)}>
          Delete address
        </button>
      ) : (
        <div class="confirm">
          <p>The address will stop working. Contacts made with it will remain.</p>
          <div class="row">
            <button onClick={() => setConfirm(false)}>Cancel</button>
            <button
              class="danger"
              onClick={async () => {
                await chat.deleteAddress();
                setConfirm(false);
                setN((n) => n + 1);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
