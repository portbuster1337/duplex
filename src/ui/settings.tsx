// Settings: profile, privacy, network, security, about.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { defaultRelays, effectiveRelays, relayName, testRelay, type AppSettings, type Session } from '../app/session';
import { parseServer } from '../core/smp/server';
import { DEFAULT_SMP_SERVERS, DEFAULT_XFTP_SERVERS } from '../core/agent/presets';
import { XFTP_VERSIONS } from '../core/xftp/protocol';
import { DEFAULT_ROUTING, type ProxyFallback, type ProxyMode } from '../core/agent/network';
import { serverString } from '../core/smp/server';
import { CHAT_VERSIONS } from '../core/chat/protocol';
import { AGENT_VERSIONS } from '../core/agent/protocol';
import { SMP_VERSIONS } from '../core/smp/protocol';
import { Avatar, resizeImage } from './util';
import { errorText, Modal, Spinner, toast, Toggle } from './components';

type Tab = 'profile' | 'privacy' | 'network' | 'security' | 'about';

declare const __APP_VERSION__: string;

export function Settings({ session, onClose, onLock, onWiped }: { session: Session; onClose: () => void; onLock: () => void; onWiped: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('profile');
  const tabs: Array<[Tab, string]> = [
    ['profile', 'Profile'],
    ['privacy', 'Privacy'],
    ['network', 'Network'],
    ['security', 'Security'],
    ['about', 'About'],
  ];
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div class="tabs" role="tablist">
        {tabs.map(([t, l]) => (
          <button role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'profile' && <ProfileTab session={session} />}
      {tab === 'privacy' && <PrivacyTab session={session} />}
      {tab === 'network' && <NetworkTab session={session} />}
      {tab === 'security' && <SecurityTab session={session} onLock={onLock} onWiped={onWiped} />}
      {tab === 'about' && <About />}
    </Modal>
  );
}

function ProfileTab({ session }: { session: Session }): JSX.Element {
  const p = session.settings.profile;
  const [name, setName] = useState(p.displayName);
  const [fullName, setFullName] = useState(p.fullName ?? '');
  const [image, setImage] = useState<string | undefined>(p.image);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast('Enter a display name', 'error');
    setBusy(true);
    try {
      await session.chat.updateProfile({ ...p, displayName: name.trim(), fullName: fullName.trim(), image });
      toast('Profile updated and sent to your contacts');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  return (
    <div class="form">
      <div class="profile-card">
        <Avatar profile={{ displayName: name || '?', fullName, image }} size={88} />
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
                  setImage(await resizeImage(f));
                } catch (err) {
                  toast(errorText(err), 'error');
                }
              }}
            />
          </label>
          {image && <button onClick={() => setImage(undefined)}>Remove</button>}
        </div>
      </div>
      <label>
        Display name
        <input value={name} maxLength={50} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Full name (optional)
        <input value={fullName} maxLength={100} onInput={(e) => setFullName((e.target as HTMLInputElement).value)} />
      </label>
      <p class="hint">Your profile is stored only in this browser and sent only to your contacts. SimpleX servers never see it.</p>
      <button class="primary" disabled={busy} onClick={save}>
        {busy ? <Spinner label="Saving…" /> : 'Save profile'}
      </button>
    </div>
  );
}

function PrivacyTab({ session }: { session: Session }): JSX.Element {
  const [s, setS] = useState<AppSettings>(session.settings);
  const upd = async (patch: Partial<AppSettings>) => {
    await session.saveSettings(patch);
    setS({ ...session.settings });
  };
  return (
    <div class="form">
      <Toggle checked={s.sendReceipts} onChange={(v) => upd({ sendReceipts: v })} label="Send delivery receipts" hint="Contacts see when their messages reach you. You can change it for each contact." />
      <Toggle
        checked={s.autoReceiveImages !== false}
        onChange={(v) => upd({ autoReceiveImages: v })}
        label="Download images automatically"
        hint="Images up to 510 KB, short videos and voice messages, like the SimpleX Chat apps. Other files are downloaded only when you choose, and files on servers you do not use are downloaded only after you agree."
      />
      <label>
        Notifications
        <select
          value={s.notifications}
          onChange={async (e) => {
            const v = (e.target as HTMLSelectElement).value as AppSettings['notifications'];
            if (v !== 'off' && 'Notification' in window && Notification.permission !== 'granted') {
              const r = await Notification.requestPermission();
              if (r !== 'granted') return toast('Notifications are blocked by the browser', 'error');
            }
            upd({ notifications: v });
          }}
        >
          <option value="off">Off</option>
          <option value="hidden">On, without names and messages</option>
          <option value="full">On, with names and messages</option>
        </select>
        <span class="hint">Shown only while Duplex is open in a background tab. There are no push notifications: no server knows how to reach you.</span>
      </label>
      <div class="note">
        <b>What Duplex does not do</b>
        <ul>
          <li>No link previews are fetched, and links open only when you click them.</li>
          <li>Images are only shown when they are inside messages; nothing is loaded from other sites.</li>
          <li>No analytics, no cookies, no third-party scripts or fonts.</li>
        </ul>
      </div>
    </div>
  );
}

function NetworkTab({ session }: { session: Session }): JSX.Element {
  const st = session.settings;
  const [relays, setRelays] = useState(effectiveRelays(st.network).join('\n'));
  const [servers, setServers] = useState(st.servers.join('\n'));
  const [xftp, setXftp] = useState((st.xftpServers?.length ? st.xftpServers : DEFAULT_XFTP_SERVERS.map((s) => serverString(s))).join('\n'));
  const [onion, setOnion] = useState(st.network.onion);
  const [mode, setMode] = useState<ProxyMode>(st.routing?.mode ?? DEFAULT_ROUTING.mode);
  const [fallback, setFallback] = useState<ProxyFallback>(st.routing?.fallback ?? DEFAULT_ROUTING.fallback);
  const stats = session.chat.agent.network.stats;
  const [tests, setTests] = useState<Record<string, string>>({});
  const status = session.chat.agent.network.status();
  const connectedRelays = session.connector.connected();
  const relayList = () => relays.split(/\s+/).filter(Boolean);
  const save = async () => {
    const rl = relayList();
    if (!rl.length || rl.some((r) => !/^wss?:\/\//.test(r))) return toast('Relays must be ws:// or wss:// URLs', 'error');
    const sv = servers.split(/\s+/).filter(Boolean);
    for (const s of sv) {
      try {
        parseServer(s);
      } catch {
        return toast(`Invalid server address: ${s}`, 'error');
      }
    }
    if (!sv.length) return toast('Add at least one SMP server', 'error');
    const xs = xftp.split(/\s+/).filter(Boolean);
    for (const s of xs) {
      try {
        if (parseServer(s).server.scheme !== 'xftp') throw new Error();
      } catch {
        return toast(`Invalid file server address: ${s}`, 'error');
      }
    }
    // the default relays and file servers are not stored, so that new versions can update them
    const isDefault = rl.join('\n') === defaultRelays().join('\n');
    const xftpDefault = !xs.length || xs.join('\n') === DEFAULT_XFTP_SERVERS.map((s) => serverString(s)).join('\n');
    await session.saveSettings({ network: { relays: isDefault ? [] : rl, onion }, servers: sv, xftpServers: xftpDefault ? [] : xs, routing: { mode, fallback } });
    toast('Network settings saved');
  };
  const test = async () => {
    const rl = relayList();
    setTests(Object.fromEntries(rl.map((r) => [r, 'testing…'])));
    await Promise.all(
      rl.map(async (r) => {
        let res: string;
        try {
          res = `works (${await testRelay(r)} ms)`;
        } catch (e) {
          res = `failed: ${errorText(e)}`;
        }
        setTests((t) => ({ ...t, [r]: res }));
      }),
    );
  };
  return (
    <div class="form">
      <label>
        Wisp relays (tried in order)
        <textarea rows={3} value={relays} spellcheck={false} onInput={(e) => setRelays((e.target as HTMLTextAreaElement).value)} />
        <span class="hint">
          Browsers cannot open TCP connections, so this page tunnels its own TLS connections to SimpleX servers through a Wisp relay. The relay sees your IP address and which servers you connect to — never your messages, contacts or profile — and SimpleX servers see the relay's address instead of yours. The public relays work without installing anything; for more privacy you can run your own relay, optionally through Tor (see About).
        </span>
      </label>
      <div class="row wrap">
        <button onClick={() => setRelays(defaultRelays().join('\n'))}>Default relays</button>
        <button onClick={() => setRelays('ws://127.0.0.1:8745/')}>Relay on this computer</button>
        <button onClick={test}>Test relays</button>
      </div>
      {Object.keys(tests).length > 0 && (
        <div class="kv">
          {Object.entries(tests).map(([r, t]) => (
            <>
              <span>{relayName(r)}</span>
              <span class={t.startsWith('works') ? 'ok' : t.startsWith('failed') ? 'err' : ''}>{t}</span>
            </>
          ))}
        </div>
      )}
      <Toggle checked={onion} onChange={setOnion} label="Use .onion addresses" hint="Only works with a relay that connects through Tor." />
      <label>
        Private message routing
        <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as ProxyMode)}>
          <option value="always">Always</option>
          <option value="unknown">For servers you do not use</option>
          <option value="unprotected">For servers you do not use, when your IP address is not hidden</option>
          <option value="never">Never</option>
        </select>
        <span class="hint">
          Messages to a contact's server are sent through one of your servers, which forwards them encrypted: the contact's server does not see your relay's address or session, and your server does not see where they go to or what they contain.
        </span>
      </label>
      <label>
        When private routing fails, send directly
        <select value={fallback} onChange={(e) => setFallback((e.target as HTMLSelectElement).value as ProxyFallback)}>
          <option value="allow">Yes</option>
          <option value="allowProtected">Only when your IP address is hidden (public relay or Tor)</option>
          <option value="prohibit">No</option>
        </select>
      </label>
      <label>
        SMP servers for new connections
        <textarea rows={5} value={servers} spellcheck={false} onInput={(e) => setServers((e.target as HTMLTextAreaElement).value)} />
      </label>
      <div class="row wrap">
        <button onClick={() => setServers(DEFAULT_SMP_SERVERS.map((s) => serverString(s)).join('\n'))}>Preset servers</button>
      </div>
      <label>
        File servers (XFTP) for sending files
        <textarea rows={4} value={xftp} spellcheck={false} onInput={(e) => setXftp((e.target as HTMLTextAreaElement).value)} />
        <span class="hint">Each file is encrypted in this page and uploaded to one of these servers, which delete it after about 2 days. They never see what is in it or who it is for.</span>
      </label>
      <div class="row wrap">
        <button onClick={() => setXftp(DEFAULT_XFTP_SERVERS.map((s) => serverString(s)).join('\n'))}>Preset file servers</button>
      </div>
      <button class="primary" onClick={save}>
        Save
      </button>
      <h3>Connections</h3>
      <div class="kv">
        <span>Relay</span>
        <span class={connectedRelays.length ? 'ok' : ''}>{connectedRelays.length ? connectedRelays.map(relayName).join(', ') : 'not connected'}</span>
        <span>Sent to other servers</span>
        <span>
          {stats.proxied} via private routing, {stats.direct + stats.fallback} directly{stats.fallback ? ` (${stats.fallback} after private routing failed)` : ''}
        </span>
        {status.map((s) => (
          <>
            <span>{s.server.hosts[0]}</span>
            <span class={s.connected ? 'ok' : 'err'}>{s.connected ? 'connected' : s.error ? `error: ${s.error}` : 'not connected'}</span>
          </>
        ))}
      </div>
    </div>
  );
}

function SecurityTab({ session, onLock, onWiped }: { session: Session; onLock: () => void; onWiped: () => void }): JSX.Element {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [wiping, setWiping] = useState(false);
  const [mins, setMins] = useState(session.settings.autoLockMinutes);
  return (
    <div class="form">
      <label>
        Lock automatically
        <select
          value={String(mins)}
          onChange={async (e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            setMins(v);
            await session.saveSettings({ autoLockMinutes: v });
          }}
        >
          <option value="0">Never</option>
          <option value="5">After 5 minutes of inactivity</option>
          <option value="15">After 15 minutes</option>
          <option value="60">After 1 hour</option>
        </select>
      </label>
      <button onClick={onLock}>Lock now</button>
      <h3>Change passphrase</h3>
      <label>
        New passphrase
        <input type="password" value={p1} autoComplete="new-password" onInput={(e) => setP1((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Repeat
        <input type="password" value={p2} autoComplete="new-password" onInput={(e) => setP2((e.target as HTMLInputElement).value)} />
      </label>
      <button
        disabled={busy}
        onClick={async () => {
          if (p1.length < 8) return toast('Use at least 8 characters', 'error');
          if (p1 !== p2) return toast('The passphrases do not match', 'error');
          setBusy(true);
          await session.vault.changePassphrase(p1);
          setBusy(false);
          setP1('');
          setP2('');
          toast('Passphrase changed');
        }}
      >
        {busy ? <Spinner label="Changing…" /> : 'Change passphrase'}
      </button>
      <h3>Delete all data</h3>
      <p class="hint">Deletes the profile, contacts and messages from this browser. Your contacts will not be able to reach this profile anymore.</p>
      <label>
        Type DELETE to confirm
        <input value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
      </label>
      <button
        class="danger"
        disabled={confirm !== 'DELETE' || wiping}
        onClick={async () => {
          setWiping(true);
          try {
            await session.wipe(true);
          } catch (e) {
            toast(errorText(e), 'error');
          }
          onWiped();
        }}
      >
        {wiping ? <Spinner label="Deleting…" /> : 'Delete everything'}
      </button>
    </div>
  );
}

function About(): JSX.Element {
  return (
    <div class="form about">
      <p>
        <b>Duplex</b> {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''} is an unofficial, independent web client for the SimpleX network. It is not affiliated with or endorsed by SimpleX Chat Ltd.
      </p>
      <p>Everything runs in this page: the SMP protocol, TLS 1.3, the double ratchet and the encrypted storage are implemented in the browser. There is nothing to install and no Duplex server — the page is plain static files, and it reaches the SimpleX servers through public Wisp relays, or through your own.</p>
      <div class="kv">
        <span>SMP protocol</span>
        <span>
          v{SMP_VERSIONS.min}–{SMP_VERSIONS.max}
        </span>
        <span>Agent protocol</span>
        <span>
          v{AGENT_VERSIONS.min}–{AGENT_VERSIONS.max}
        </span>
        <span>Chat protocol</span>
        <span>
          v{CHAT_VERSIONS.min}–{CHAT_VERSIONS.max}
        </span>
        <span>File protocol</span>
        <span>
          XFTP v{XFTP_VERSIONS.min}–{XFTP_VERSIONS.max} over HTTP/2
        </span>
        <span>Encryption</span>
        <span>double ratchet with X448 and sntrup761 (post-quantum), AES-256-GCM; NaCl boxes per queue; files with XSalsa20-Poly1305; TLS 1.3 with server fingerprint pinning</span>
      </div>
      <p class="hint">Not supported yet: groups and channels, calls.</p>
      <p>
        Browsers cannot open TCP connections, so Duplex tunnels its own TLS connections to the SimpleX servers through a Wisp relay — by default a public one. To use your own, run <code>npm run relay</code> in the source code (Node.js, no dependencies; add <code>-- --tor</code> to connect through Tor) and choose “Relay on this computer” in the network settings.
      </p>
      <p>
        <a href="./about/" target="_blank" rel="noopener noreferrer">
          How it works and privacy model
        </a>{' '}
        ·{' '}
        <a href="https://codeberg.org/portbuster/duplex" target="_blank" rel="noopener noreferrer">
          Source code (AGPL-3.0)
        </a>
      </p>
    </div>
  );
}
