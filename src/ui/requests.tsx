// Contact requests and pending 1-time links.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { profileName, type Contact, type ContactRequest, type PendingInvitation } from '../app/chat';
import { Avatar } from './util';
import { errorText, Spinner, toast } from './components';
import { Icon } from './icons';
import { LinkShare } from './newchat';

export function RequestView({ session, request, onDone, onBack }: { session: Session; request: ContactRequest; onDone: (c?: Contact) => void; onBack: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const p = request.profile;
  return (
    <div class="chat">
      <header class="chat-head">
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <span class="chat-title static">
          <Avatar profile={p} size={36} />
          <span>
            <span class="chat-name">{profileName(p)}</span>
            <span class="chat-sub">contact request</span>
          </span>
        </span>
      </header>
      <div class="panel">
        <div class="profile-card">
          <Avatar profile={p} size={88} />
          <h3>{profileName(p)}</h3>
          {p.fullName && <p class="muted">{p.fullName}</p>}
          {request.message && <p class="request-msg">“{request.message}”</p>}
        </div>
        <p class="hint">This person used your contact address. Accept to connect, or reject — they will not be notified.</p>
        <div class="row">
          <button
            class="danger"
            disabled={busy}
            onClick={async () => {
              await session.chat.rejectRequest(request.id);
              onDone();
            }}
          >
            Reject
          </button>
          <button
            class="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onDone(await session.chat.acceptRequest(request.id));
              } catch (e) {
                toast(errorText(e), 'error');
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner label="Accepting…" /> : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InvitationView({ session, inv, onDone, onBack }: { session: Session; inv: PendingInvitation; onDone: () => void; onBack: () => void }): JSX.Element {
  return (
    <div class="chat">
      <header class="chat-head">
        <button class="icon-btn back" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <span class="chat-title static">
          <div class="avatar link-avatar">
            <Icon name="link" size={20} />
          </div>
          <span>
            <span class="chat-name">1-time link</span>
            <span class="chat-sub">waiting for the contact to connect</span>
          </span>
        </span>
      </header>
      <div class="panel">
        <LinkShare link={inv.link} note="The contact will appear here once they use the link and you are both online." />
        {inv.incognito && (
          <p class="note">
            <Icon name="incognito" size={16} /> Incognito: whoever uses this link sees the random profile <b>{inv.incognito.displayName}</b>, not yours.
          </p>
        )}
        <button
          class="danger"
          onClick={async () => {
            await session.chat.deleteInvitation(inv.id);
            onDone();
          }}
        >
          Delete link
        </button>
      </div>
    </div>
  );
}
