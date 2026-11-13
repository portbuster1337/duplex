// Adding contacts: 1-time links, connecting via a link, and the contact address.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { profileName, type PendingInvitation } from '../app/chat';
import type { Profile } from '../core/chat/protocol';
import { Avatar, copyText, QRCode } from './util';
import { errorText, Modal, Spinner, toast, Toggle } from './components';
import { Icon } from './icons';
import type { Selection } from './layout';

type Tab = 'invite' | 'connect' | 'address';

export function NewChat({ session, onClose, onOpen }: { session: Session; onClose: () => void; onOpen: (s: Selection) => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('invite');
  return (
    <Modal title="New chat" onClose={onClose} wide>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'invite'} class={tab === 'invite' ? 'on' : ''} onClick={() => setTab('invite')}>
          <Icon name="qr" size={16} /> 1-time link
        </button>
        <button role="tab" aria-selected={tab === 'connect'} class={tab === 'connect' ? 'on' : ''} onClick={() => setTab('connect')}>
          <Icon name="link" size={16} /> Connect via link
        </button>
        <button role="tab" aria-selected={tab === 'address'} class={tab === 'address' ? 'on' : ''} onClick={() => setTab('address')}>
          <Icon name="mail" size={16} /> Your address
        </button>
      </div>
      {tab === 'invite' && <Invite session={session} onOpen={onOpen} />}
      {tab === 'connect' && <Connect session={session} onOpen={onOpen} />}
      {tab === 'address' && <AddressTab session={session} />}
    </Modal>
  );
}

export function LinkShare({ link, note }: { link: string; note?: string }): JSX.Element {
  return (
    <div class="share">
      <QRCode text={link} size={232} />
      <div class="link-box">
        <span class="mono small">{link}</span>
      </div>
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
      {note && <p class="hint">{note}</p>}
    </div>
  );
}

function Invite({ session, onOpen }: { session: Session; onOpen: (s: Selection) => void }): JSX.Element {
  const [inv, setInv] = useState<PendingInvitation>();
  const [err, setErr] = useState('');
  // the incognito switch moves at once; the link data is updated on the router in the background
  const [wantIncognito, setWantIncognito] = useState<boolean>();
  useEffect(() => {
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
      <LinkShare link={inv.link} note="Show this QR code or send the link to your contact, ideally in person or via another trusted channel. The link can be used only once — the person who uses it first will connect with you." />
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
      const p = await session.chat.previewLink(link);
      if (p.kind === 'group' || p.kind === 'channel') setErr(`This is a ${p.kind} link — groups and channels are not supported in Duplex yet.`);
      else setPreview(p);
    } catch (e) {
      setErr(`This link cannot be used: ${errorText(e)}`);
    }
    setBusy(false);
  };

  const connect = async () => {
    setBusy(true);
    setErr('');
    try {
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
        Paste a SimpleX link (1-time link or contact address)
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
          {preview.profile ? (
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
              : 'A contact request with your profile will be sent. The address owner can accept or reject it.'}
          </p>
          <Toggle checked={incognito} onChange={setIncognito} label="Connect incognito" hint="Share a new random profile with this contact instead of yours" />
          {preview.kind === 'contact' && (
            <label>
              Message (optional)
              <input value={message} maxLength={500} onInput={(e) => setMessage((e.target as HTMLInputElement).value)} placeholder="Hi! It's me…" />
            </label>
          )}
          <div class="row">
            <button onClick={() => setPreview(undefined)}>Back</button>
            <button class="primary" disabled={busy} onClick={connect}>
              {busy ? <Spinner label="Connecting…" /> : preview.kind === 'invitation' ? 'Connect' : 'Send request'}
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
      <LinkShare link={a.link} note="People who use this address send you a contact request with their profile." />
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
