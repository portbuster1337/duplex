# Duplex

An unofficial, privacy-focused web client compatible with the [SimpleX network](https://simplex.chat).
It runs entirely in the browser, as static files: there is no Duplex server, no account and nothing
to install.

**Open it: <https://portbuster.codeberg.page/duplex/>** (about: <https://portbuster.codeberg.page/duplex/about/>)

Duplex is independent and is not affiliated with or endorsed by SimpleX Chat Ltd. SimpleX and SimpleX
Chat are trademarks of SimpleX Chat Ltd.

## What it does

- **No user IDs.** You connect by sharing a 1-time link (or its QR code), or a contact address that
  people can send contact requests to. Links of the SimpleX Chat apps work too, short and full ones.
- **Works with the SimpleX Chat apps**: text with SimpleX markdown, replies, edits, deletion (for
  everyone or for you), reactions, delivery receipts, disappearing messages (set by either side),
  profile pictures, contact addresses with automatic or manual acceptance of requests.
- **Files, images and videos** (up to 1 GB) over XFTP, the SimpleX file protocol, to and from the
  apps: each file is encrypted in the page and uploaded in chunks to a file server, and only its key
  and locations go to the contact, inside the chat. Photos are resized and re-encoded before sending,
  which removes their location and camera metadata. Received images, short videos and voice
  messages are downloaded automatically like in the apps (this can be turned off); other files when
  you choose; files on servers you do not use only after you agree. Sent files can be deleted from
  the server at any time.
- **Groups**, compatible with the groups of the apps: join by invitation or group link, create
  groups, add contacts, share a group link, set roles, remove members, leave. Groups are
  peer-to-peer: each member has an end-to-end encrypted connection with each other member; the
  admin who adds a member introduces it to the others and forwards messages until they are
  connected, and sends it the recent messages (visible history, on in new groups as in the apps):
  the last 100 like the apps, or as many as that admin chooses, up to all of them.
- **Audio and video calls** with the apps, over WebRTC: the call page of the apps is followed
  closely (the media frames are encrypted end to end with the key agreed in the chat), and calls go
  through the TURN server of SimpleX Chat by default, so contacts do not see your IP address. You
  can share your screen, a window or a tab (in desktop browsers), and see the screen your contact
  shares from the apps.
- **Voice messages**, recorded in the page: AAC in M4A like the apps where the browser can encode
  it, otherwise 8 kHz μ-law WAV, which the apps play too.
- **Post-quantum encryption**: the double ratchet with the sntrup761 key encapsulation that the apps
  add, agreed with the contact automatically; the chat says when messages are quantum resistant.
- **Private message routing**: messages to your contacts' servers go through one of your servers,
  which forwards them encrypted, so a contact's server does not see your relay's address or your
  session, and your server does not see which queue they go to. As in the apps, this is used for
  servers you do not use, with direct sending only when your IP address is hidden (adjustable).
- **Address changes**: you can change the address you receive a contact's messages at (a new
  queue, on another of your servers if you have one), and Duplex follows the contact's changes.
- **Incognito connections**: a 1-time link or a connection can share a new random profile (named
  like those of the apps) instead of yours.
- **Themes and icon packs**: Light, Dark, SimpleX (the navy theme of the apps), Black (for OLED
  screens), Sepia and High contrast, or light and dark as your device is; accent colours; and the
  icons of Lucide, Tabler, Phosphor (outline or filled), Material Symbols, Bootstrap Icons or Remix
  Icon. They are bundled with the page (see `public/icon-licenses.txt`), so nothing is loaded from
  elsewhere. The appearance is kept in the browser outside the encrypted data, so that the lock
  screen uses it too.
- **Security codes**: compare a contact's code (or scan its QR code in the apps) to check that nobody
  is in the middle of the connection; the code is the same one the SimpleX Chat apps show.
- **End-to-end encrypted** with the double ratchet (X448 and sntrup761, AES-256-GCM, header
  encryption), per-queue NaCl boxes, and TLS 1.3 to servers that are pinned to the fingerprint in
  their address.
- **Encrypted at rest.** Everything stored in the browser (IndexedDB) is encrypted with
  XChaCha20-Poly1305 under a random key, which is encrypted with a key derived from your passphrase
  (Argon2id, 64 MiB). Record names are keyed hashes and sizes are padded, so the storage does not show
  your contacts or how much you chat. The app can lock itself after a period of inactivity.
- **Nothing from elsewhere.** The page loads no third-party scripts, fonts, analytics or cookies, and
  fetches no link previews; the Content Security Policy only allows its own files and WebSocket
  connections to relays.

## How it works

The SimpleX network carries messages through queues on SimpleX servers (SMP routers). Each
conversation uses its own pair of queues, created by the two clients, and nothing links your
conversations to each other or to you.

Browsers cannot open the TCP connections that SimpleX servers need, so Duplex asks a
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) relay (TCP streams over a WebSocket) for a
connection and runs its own TLS 1.3 inside it (`src/core/net/tls13.ts`), checking the server's
certificate chain against the fingerprint in the server address. On top of that it implements the
SimpleX Messaging Protocol (with private message routing), the SMP agent protocol (fast duplex
handshake, short links, contact addresses, message integrity, receipts, the post-quantum double
ratchet, queue rotation) and the chat protocol, following
[simplexmq](https://github.com/simplex-chat/simplexmq) and
[simplex-chat](https://github.com/simplex-chat/simplex-chat).

```
this page ──WebSocket──▶ Wisp relay ──TCP──▶ SimpleX servers ◀── your contact's app
   └──────────── TLS 1.3, SMP, e2e encryption ────────────┘
```

By default the page uses public Wisp relays (Wasmer, AnuraOS, Mercury Workshop), tried in order, so
it works without installing anything.

### Privacy model

| | can see | cannot see |
|---|---|---|
| the Wisp relay | your IP address, which SimpleX servers you connect to, when and how much (fixed-size blocks) | messages, contacts, profile, queue IDs (all inside TLS) |
| your SimpleX servers | the relay's IP address, the queues you use on that server and when messages pass through them (encrypted fixed-size blocks); when forwarding your messages, which server they go to | your IP address, messages and profile; there are no accounts or user IDs; the queues on other servers that your messages go to |
| your contacts' servers | with private routing, only the address of the server that forwards your messages | your IP address, the relay's address, messages and profile |
| file servers (XFTP) | the relay's IP address, encrypted chunks of 64 KB to 4 MB and when they are uploaded and downloaded | the file, its name and real size, who sent it and to whom |
| your contacts | the profile you share and your messages | your IP address and your other contacts |
| the TURN server of calls | your IP address (calls do not go through the Wisp relay) and that of the contact, and when and how long you talk | what you say or show: frames are encrypted end to end |
| group members | the profile you use in the group (it can be incognito), your messages there, and the other members | your IP address, your contacts and your other groups |
| Codeberg Pages | that the page was loaded, from which IP address | everything after that |
| someone with this browser | that Duplex was used, the number and rough size of stored records, the chosen theme and icons | anything else, without the passphrase |

A public relay is run by someone you do not know. For more privacy, run your own relay, optionally
through Tor (below). Duplex uses one connection per server, so a server can tell that the queues you
use on it belong to the same client.

### Limitations

- No channels (groups with relays) yet. In groups, members cannot be accepted after review.
- Calls: no group calls (SimpleX has none); calls ring only while the page is open. Tor Browser
  disables WebRTC, so calls do not work there.
- Files are kept in the encrypted storage of this browser, which browsers limit in size; large files
  should be saved to disk.
- No per-connection transport isolation (one connection per server, see above).
- No push notifications: messages arrive while the page is open (it can show notifications while it
  is in a background tab). One tab at a time, no syncing between devices.
- The data lives only in this browser: clearing the site data or forgetting the passphrase loses it.

## Your own relay (optional)

`relay/wisp-relay.mjs` is a Wisp relay and static file server in one file, with no dependencies:

```sh
npm run relay                  # ws://127.0.0.1:8745/, and the built app at http://127.0.0.1:8745/
npm run relay -- --tor         # connect through Tor (SOCKS at 127.0.0.1:9050), allows .onion servers
```

In Duplex, choose **Settings → Network → Relay on this computer** and save; with `--tor`, also turn
on **Use .onion addresses**. The relay accepts pages served on this computer and
`https://portbuster.codeberg.page` (add others with `--allow-origin`), only connects to public
addresses (`--allow-private` for testing) and logs nothing (`--verbose` logs destinations).

## Development

Requires Node.js 24.

```sh
npm install
npm run dev          # http://127.0.0.1:5173/ (uses the relay of `npm run relay` at /wisp/)
npm run build        # dist/
npm run typecheck
```

Tests:

| command | what |
|---|---|
| `npm test` | unit tests: crypto against libsodium and OpenSSL vectors, sntrup761 against the C code of simplexmq, the post-quantum ratchet, links of the official client, certificate pinning, zstd compression, the encrypted storage, HTTP/2 header compression (RFC 7541 examples), file descriptions against the fixture of simplexmq, voice formats (with `FFMPEG_DIR`, against ffmpeg) |
| `SMP_SERVER=smp://…@localhost:7001 SMP_SERVER2=smp://…@localhost:7003 npm run test:local` | two agents connecting through local `smp-server`s: invitations, short links, addresses, receipts, private message routing and address changes between the two |
| `SMP_SERVER=… SMP_SERVER2=… XFTP_SERVER=xftp://…@localhost:7002 SIMPLEX_CHAT_BIN=… npm run test:interop` | the chat client against the official SimpleX Chat CLI (on the second router, so that Duplex sends to it with private routing): post-quantum encryption, address changes both ways, files through a local `xftp-server`; groups with two CLI users: invitations, introductions in both directions, Duplex as the admin, group links both ways, leaving and removing |
| `CHROME_PATH=… SIMPLEX_CHAT_BIN=… npm run e2e` | the production build in headless Chrome on the real SimpleX network, chatting with the official CLI, and a video call through the TURN server of SimpleX Chat with the call page of the apps (`test/e2e/fixtures/official-call`) on the other side (run `npm run build` and `npm run relay` first, or set `APP_URL` to the published page; without `CHROME_PATH`, it uses a browser installed with `npx playwright install chromium`) |

`npm run check-server -- smp://… [wss://relay/]` connects to a server (directly or through a relay)
and makes a queue.

| path | |
|---|---|
| `src/core/net` | TLS 1.3 client, Wisp client, X.509, HTTP/2 client |
| `src/core/xftp` | XFTP: file encryption, chunks, file descriptions, the file server client |
| `src/core/smp` | SMP client: handshake, block encryption, commands |
| `src/core/crypto` | primitives (noble), sntrup761, the double ratchet |
| `src/core/agent` | SMP agent: connections, short links, addresses, delivery, private routing, queue rotation |
| `src/core/chat` | chat protocol messages, groups |
| `src/app` | chat client, groups, file transfers, encrypted vault, session and relays |
| `src/ui` | the Preact interface, themes and icon packs (`src/ui/iconpacks`, generated by `scripts/icon-packs.mjs`), voice recording, WebRTC calls |
| `relay` | the optional Wisp relay |
| `site` | the about page, `404.html`, and `_headers` (Content Security Policy) for Codeberg Pages |

### Codeberg Pages

The page is served by [Codeberg Pages](https://docs.codeberg.org/codeberg-pages/) from the `pages`
branch, which holds only the app built from a commit of `main` (`dist/`) plus `site/`.
`npm run site:publish` builds the current commit, commits the result to `pages`, pushes it and tells
git-pages to deploy it.

The page's origin, `https://portbuster.codeberg.page`, is shared with the other Codeberg Pages sites
of the same user, which can access each other's pages and storage (the stored data is encrypted).
For an origin of its own, put `dist/` and `site/` on any other static hosting (GitHub Pages, a
custom domain, a plain web server): the app only uses relative paths. Hosts that ignore `_headers`
still get the Content Security Policy of `index.html`, except `frame-ancestors`.

## License

AGPL-3.0, like simplexmq and simplex-chat, whose protocols this follows. Dependencies:
[noble](https://paulmillr.com/noble/) cryptography, [fzstd](https://github.com/101arrowz/fzstd),
[Preact](https://preactjs.com), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(all MIT). The icons are adapted from [Feather](https://feathericons.com) (MIT).
