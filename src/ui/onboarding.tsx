// First start (profile + passphrase) and unlocking.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { defaultRelays, Session, WrongPassphraseError } from '../app/session';
import { errorText, Spinner } from './components';
import { Icon } from './icons';

function Progress({ p }: { p: number }): JSX.Element {
  return (
    <div class="progress" aria-label="deriving key">
      <div style={{ width: `${Math.round(p * 100)}%` }} />
    </div>
  );
}

export function Setup({ onReady }: { onReady: (s: Session) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [relays, setRelays] = useState(defaultRelays().join('\n'));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr('');
    if (!name.trim()) return setErr('Enter a display name');
    if (pass.length < 8) return setErr('Use a passphrase of at least 8 characters');
    if (pass !== pass2) return setErr('The passphrases do not match');
    const rl = relays
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!rl.length || rl.some((r) => !/^wss?:\/\//.test(r))) return setErr('Relays must be ws:// or wss:// URLs');
    // the default relays are not stored, so that later versions can update them
    const custom = rl.join('\n') !== defaultRelays().join('\n');
    setBusy(true);
    try {
      onReady(await Session.create(name.trim(), pass, { relays: custom ? rl : [], onion: false }, setProgress));
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div class="onboarding">
      <form class="card" onSubmit={submit}>
        <div class="brand">
          <img src="./favicon.svg" alt="" width={48} height={48} />
          <div>
            <h1>Duplex</h1>
            <p class="muted">Private messaging on the SimpleX network, in your browser</p>
          </div>
        </div>
        <ul class="points">
          <li>
            <Icon name="shield" size={16} /> No user IDs or phone numbers: you connect with 1-time links
          </li>
          <li>
            <Icon name="lock" size={16} /> End-to-end encrypted with the double ratchet; keys never leave this browser
          </li>
          <li>
            <Icon name="user" size={16} /> Works with the SimpleX Chat apps
          </li>
        </ul>
        <label>
          Display name
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={50} autoFocus placeholder="shown to your contacts" />
        </label>
        <label>
          Passphrase
          <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} autoComplete="new-password" placeholder="encrypts your data in this browser" />
        </label>
        <label>
          Repeat passphrase
          <input type="password" value={pass2} onInput={(e) => setPass2((e.target as HTMLInputElement).value)} autoComplete="new-password" />
        </label>
        <p class="hint">There is no way to recover the passphrase. Without it, the chats stored in this browser cannot be decrypted.</p>
        <button type="button" class="link-btn" onClick={() => setAdvanced(!advanced)}>
          {advanced ? 'Hide network settings' : 'Network settings'}
        </button>
        {advanced && (
          <label>
            Wisp relays (one per line, tried in order)
            <textarea rows={3} value={relays} onInput={(e) => setRelays((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
            <span class="hint">Browsers cannot open TCP connections, so this page tunnels its own TLS connections to SimpleX servers through a Wisp relay. The relay sees your IP address and which servers you use, never your messages or contacts. Public relays work without installing anything; you can also run your own (see About).</span>
          </label>
        )}
        {err && <p class="error">{err}</p>}
        {busy && <Progress p={progress} />}
        <button class="primary" disabled={busy} type="submit">
          {busy ? <Spinner label="Creating…" /> : 'Create profile'}
        </button>
        <p class="card-links">
          <a href="./about/" target="_blank" rel="noopener noreferrer">
            How it works and what it protects
          </a>{' '}
          ·{' '}
          <a href="https://codeberg.org/portbuster/duplex" target="_blank" rel="noopener noreferrer">
            Source code
          </a>
        </p>
      </form>
    </div>
  );
}

export function Unlock({ onReady, onWiped }: { onReady: (s: Session) => void; onWiped: () => void }): JSX.Element {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      onReady(await Session.open(pass, setProgress));
    } catch (e) {
      setErr(e instanceof WrongPassphraseError ? 'Wrong passphrase' : errorText(e));
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <div class="onboarding">
      <form class="card" onSubmit={submit}>
        <div class="brand">
          <img src="./favicon.svg" alt="" width={48} height={48} />
          <div>
            <h1>Duplex</h1>
            <p class="muted">Enter your passphrase to unlock</p>
          </div>
        </div>
        <label>
          Passphrase
          <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} autoFocus autoComplete="current-password" />
        </label>
        {err && <p class="error">{err}</p>}
        {busy && <Progress p={progress} />}
        <button class="primary" disabled={busy || !pass} type="submit">
          {busy ? <Spinner label="Unlocking…" /> : 'Unlock'}
        </button>
        {!confirmWipe ? (
          <button type="button" class="link-btn danger" onClick={() => setConfirmWipe(true)}>
            Forgot the passphrase?
          </button>
        ) : (
          <div class="confirm">
            <p>Without the passphrase the data cannot be decrypted. You can delete it and start again — your contacts will not be able to reach this profile.</p>
            <div class="row">
              <button type="button" onClick={() => setConfirmWipe(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="danger"
                onClick={async () => {
                  await Session.wipeLocked();
                  onWiped();
                }}
              >
                Delete all data
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
