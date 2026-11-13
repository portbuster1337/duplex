// Groups in the interface: creating a group, the group info panel with members, adding members,
// the group link, roles, leaving and deleting.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { profileName, type Contact } from '../app/chat';
import { groupActive, groupName, memberGone, memberName, type Group, type GroupMember } from '../app/groups';
import { roleRank, type GroupMemberRole } from '../core/chat/groups';
import type { Profile } from '../core/chat/protocol';
import { Avatar, resizeImage } from './util';
import { errorText, Modal, Spinner, toast, Toggle } from './components';
import { Icon } from './icons';
import { LinkShare } from './newchat';
import { useChatUpdates } from './layout';

const MEMBER_ROLES: GroupMemberRole[] = ['observer', 'member', 'moderator', 'admin', 'owner'];

const STATUS_TEXT: Record<string, string> = {
  invited: 'invited',
  accepted: 'connecting…',
  announced: 'connecting…',
  introduced: 'connecting…',
  introInvited: 'connecting…',
  connected: '',
  unknown: 'not connected yet',
  left: 'left',
  removed: 'removed',
};

/** a picture for a profile: chosen, resized in the page */
function PictureInput({ image, name, onChange }: { image?: string; name: string; onChange: (image: string | undefined) => void }): JSX.Element {
  return (
    <div class="profile-card">
      <Avatar profile={{ displayName: name || '?', fullName: '', image }} size={88} />
      <div class="row">
        <label class="button">
          Choose picture
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              try {
                onChange(await resizeImage(f));
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          />
        </label>
        {image && <button onClick={() => onChange(undefined)}>Remove</button>}
      </div>
    </div>
  );
}

export function NewGroup({ session, onCreated }: { session: Session; onCreated: (g: Group) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<string>();
  const [incognito, setIncognito] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div class="form">
      <PictureInput image={image} name={name} onChange={setImage} />
      <label>
        Group name
        <input value={name} maxLength={50} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="e.g. Book club" />
      </label>
      <label>
        Welcome message (optional)
        <textarea rows={3} value={description} maxLength={1000} onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
      </label>
      <Toggle checked={incognito} onChange={setIncognito} label="Incognito" hint="Members see a new random profile instead of yours" />
      <p class="hint">
        Groups are peer-to-peer: each member connects to each other member, and you introduce the members you add. Messages reach members who are not connected yet through you, while you are online.
      </p>
      <button
        class="primary"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            onCreated(await session.chat.createGroup({ displayName: name, description, image }, incognito));
          } catch (e) {
            toast(errorText(e), 'error');
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner label="Creating…" /> : 'Create group'}
      </button>
    </div>
  );
}

export function GroupInfo({ session, group, onClose, onDeleted }: { session: Session; group: Group; onClose: () => void; onDeleted: () => void }): JSX.Element {
  const chat = session.chat;
  useChatUpdates(session);
  const g = chat.group(group.id) ?? group;
  const [alias, setAlias] = useState(g.localAlias ?? '');
  const [panel, setPanel] = useState<'add' | 'edit' | undefined>();
  const [confirm, setConfirm] = useState<'leave' | 'delete'>();
  const [busy, setBusy] = useState(false);
  const active = g.status === 'active';
  const admin = active && roleRank(g.role) >= roleRank('admin');
  const owner = active && g.role === 'owner';
  const members = chat.groups
    .members(g)
    .slice()
    .sort((a, b) => Number(memberGone(a)) - Number(memberGone(b)) || roleRank(b.role) - roleRank(a.role) || memberName(a).localeCompare(memberName(b)));
  const run = async (f: () => Promise<void>, done?: () => void) => {
    setBusy(true);
    try {
      await f();
      done?.();
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  return (
    <Modal title="Group" onClose={onClose}>
      <div class="profile-card">
        <Avatar profile={g.profile as Profile} size={88} />
        <h3>{groupName(g)}</h3>
        {g.profile.fullName && <p class="muted">{g.profile.fullName}</p>}
        {g.profile.description && <p class="welcome">{g.profile.description}</p>}
      </div>
      {owner && panel !== 'edit' && <button onClick={() => setPanel('edit')}>Edit group profile</button>}
      {panel === 'edit' && <EditGroup session={session} g={g} onDone={() => setPanel(undefined)} />}
      <label>
        Local name (only you see it)
        <input value={alias} onInput={(e) => setAlias((e.target as HTMLInputElement).value)} onBlur={() => chat.groups.updateLocal(g.id, { localAlias: alias.trim() || undefined })} placeholder={g.profile.displayName} />
      </label>
      <Toggle checked={!!g.favorite} onChange={(v) => chat.groups.updateLocal(g.id, { favorite: v })} label="Favorite" />
      <Toggle checked={!!g.muted} onChange={(v) => chat.groups.updateLocal(g.id, { muted: v })} label="Mute notifications" />
      {g.incognito && (
        <p class="note">
          <Icon name="incognito" size={16} /> You are incognito in this group: members see the random profile <b>{g.incognito.displayName}</b>, not yours.
        </p>
      )}
      <div class="kv">
        <span>Your role</span>
        <span>{g.role}</span>
        <span>Encryption</span>
        <span>double ratchet with each member (X448, AES-256-GCM)</span>
      </div>
      {admin && <GroupLinkSection session={session} g={g} />}
      <h4 class="members-head">
        Members <span class="muted">{members.filter((m) => !memberGone(m)).length + 1}</span>
        {admin && panel !== 'add' && (
          <button class="small" onClick={() => setPanel('add')}>
            <Icon name="plus" size={14} /> Add members
          </button>
        )}
      </h4>
      {panel === 'add' && <AddMembers session={session} g={g} onDone={() => setPanel(undefined)} />}
      <ul class="members">
        <li class="member">
          <Avatar profile={chat.groups.ourProfile(g)} size={32} />
          <span class="member-name">
            {profileName(chat.groups.ourProfile(g))} <span class="muted">(you)</span>
          </span>
          <span class="role">{g.role}</span>
        </li>
        {members.map((m) => (
          <MemberRow key={m.memberId} session={session} g={g} m={m} canManage={admin && !memberGone(m) && roleRank(m.role) <= roleRank(g.role)} />
        ))}
      </ul>
      <div class="row">
        <button onClick={() => chat.clearChat(g.id)}>Clear chat</button>
        {groupActive(g) && !confirm && (
          <button class="danger" onClick={() => setConfirm('leave')}>
            Leave group
          </button>
        )}
        {!confirm && (
          <button class="danger" onClick={() => setConfirm('delete')}>
            Delete group
          </button>
        )}
      </div>
      {confirm && (
        <div class="confirm">
          <p>
            {confirm === 'leave'
              ? 'You will stop receiving messages from this group. The chat stays until you delete it.'
              : owner
                ? 'The group will be deleted for all members.'
                : groupActive(g)
                  ? 'You will leave the group, and the chat will be deleted.'
                  : 'The chat will be deleted.'}
          </p>
          <div class="row">
            <button onClick={() => setConfirm(undefined)}>Cancel</button>
            <button
              class="danger"
              disabled={busy}
              onClick={() =>
                confirm === 'leave'
                  ? run(() => chat.groups.leave(g.id), () => setConfirm(undefined))
                  : run(
                      () => chat.groups.delete(g.id),
                      () => {
                        onClose();
                        onDeleted();
                      },
                    )
              }
            >
              {confirm === 'leave' ? 'Leave' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MemberRow({ session, g, m, canManage }: { session: Session; g: Group; m: GroupMember; canManage: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = STATUS_TEXT[m.status] ?? m.status;
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
    <li class={`member ${memberGone(m) ? 'gone' : ''}`}>
      <Avatar profile={m.profile} size={32} />
      <span class="member-name">
        {memberName(m)}
        {status && <span class="muted small"> · {status}</span>}
        {m.blocked && <span class="muted small"> · blocked</span>}
      </span>
      <span class="role">{m.role}</span>
      {canManage && (
        <button class="icon-btn small" onClick={() => setOpen(!open)} aria-label={`Manage ${memberName(m)}`} title="Manage">
          <Icon name="more" size={16} />
        </button>
      )}
      {open && canManage && (
        <div class="member-actions">
          <label>
            Role
            <select value={m.role} disabled={busy} onChange={(e) => run(() => session.chat.groups.setRole(g.id, m.memberId, (e.target as HTMLSelectElement).value))}>
              {MEMBER_ROLES.filter((r) => roleRank(r) <= roleRank(g.role)).map((r) => (
                <option value={r}>{r}</option>
              ))}
            </select>
          </label>
          <button class="danger small" disabled={busy} onClick={() => run(() => session.chat.groups.removeMember(g.id, m.memberId))}>
            Remove from group
          </button>
        </div>
      )}
    </li>
  );
}

function AddMembers({ session, g, onDone }: { session: Session; g: Group; onDone: () => void }): JSX.Element {
  const chat = session.chat;
  const inGroup = new Set(chat.groups.currentMembers(g).map((m) => m.contactId));
  const candidates = chat.contacts().filter((c: Contact) => c.status === 'active' && !inGroup.has(c.id) && (!c.incognito || !!g.incognito));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<GroupMemberRole>('member');
  const [busy, setBusy] = useState(false);
  if (!candidates.length)
    return (
      <div class="add-members">
        <p class="hint">All your contacts are in this group already, or you have none. Share the group link to let others join.</p>
        <button onClick={onDone}>Close</button>
      </div>
    );
  return (
    <div class="add-members">
      <ul class="pick">
        {candidates.map((c) => (
          <li>
            <label class="pick-row">
              <input
                type="checkbox"
                checked={picked.has(c.id)}
                onChange={(e) => {
                  const s = new Set(picked);
                  if ((e.target as HTMLInputElement).checked) s.add(c.id);
                  else s.delete(c.id);
                  setPicked(s);
                }}
              />
              <Avatar profile={c.profile} size={28} />
              <span>{c.localAlias || profileName(c.profile)}</span>
            </label>
          </li>
        ))}
      </ul>
      <label>
        Role of the new members
        <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
          {MEMBER_ROLES.filter((r) => roleRank(r) <= roleRank(g.role)).map((r) => (
            <option value={r}>{r}</option>
          ))}
        </select>
      </label>
      <div class="row">
        <button onClick={onDone}>Cancel</button>
        <button
          class="primary"
          disabled={busy || !picked.size}
          onClick={async () => {
            setBusy(true);
            for (const id of picked) {
              try {
                await chat.groups.invite(g.id, id, role);
              } catch (e) {
                toast(`${profileName(chat.contact(id)?.profile)}: ${errorText(e)}`, 'error');
              }
            }
            setBusy(false);
            toast(picked.size > 1 ? 'Invitations sent' : 'Invitation sent');
            onDone();
          }}
        >
          {busy ? <Spinner label="Inviting…" /> : `Invite${picked.size ? ` (${picked.size})` : ''}`}
        </button>
      </div>
    </div>
  );
}

function GroupLinkSection({ session, g }: { session: Session; g: Group }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setShow(true);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  if (!g.link)
    return (
      <div class="group-link">
        <button disabled={busy} onClick={() => run(() => session.chat.groups.createLink(g.id))}>
          {busy ? <Spinner label="Creating…" /> : (
            <>
              <Icon name="link" size={16} /> Create group link
            </>
          )}
        </button>
        <p class="hint">Anyone with the link can join the group as a member, while you are online to accept them.</p>
      </div>
    );
  return (
    <div class="group-link">
      {show ? (
        <>
          <LinkShare link={g.link.link} note="People who use this link join the group as members. You introduce them to the other members." />
          <button class="danger" disabled={busy} onClick={() => run(() => session.chat.groups.deleteLink(g.id)).then(() => setShow(false))}>
            Delete group link
          </button>
        </>
      ) : (
        <button onClick={() => setShow(true)}>
          <Icon name="link" size={16} /> Show group link
        </button>
      )}
    </div>
  );
}

function EditGroup({ session, g, onDone }: { session: Session; g: Group; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(g.profile.displayName);
  const [description, setDescription] = useState(g.profile.description ?? '');
  const [image, setImage] = useState<string | undefined>(g.profile.image);
  const [busy, setBusy] = useState(false);
  return (
    <div class="form">
      <PictureInput image={image} name={name} onChange={setImage} />
      <label>
        Group name
        <input value={name} maxLength={50} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Welcome message
        <textarea rows={3} value={description} maxLength={1000} onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
      </label>
      <div class="row">
        <button onClick={onDone}>Cancel</button>
        <button
          class="primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await session.chat.groups.updateProfile(g.id, { displayName: name.trim(), description: description.trim(), image });
              onDone();
            } catch (e) {
              toast(errorText(e), 'error');
            }
            setBusy(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
