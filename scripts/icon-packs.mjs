// Generates src/ui/iconpacks/*.ts: the icons Duplex uses, taken from open-source icon packs, as
// element data rendered without innerHTML. And public/icon-licenses.txt with their licenses.
//   npm pack lucide-static@1.72.0 @tabler/icons@3.51.0 @phosphor-icons/core@2.1.1 \
//     @material-symbols/svg-400@0.49.0 bootstrap-icons@1.13.2 remixicon@4.9.1
//   (unpack each into DIR/<package name>/, as in node_modules)
//   ICON_PACKS_DIR=DIR node scripts/icon-packs.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.ICON_PACKS_DIR ?? 'node_modules';
const OUT = 'src/ui/iconpacks';

/** where each pack keeps an icon, and how it draws */
const PACKS = {
  lucide: { name: 'Lucide', pkg: 'lucide-static', file: (n) => `icons/${n}.svg`, stroke: 2 },
  tabler: { name: 'Tabler Icons', pkg: '@tabler/icons', file: (n) => `icons/outline/${n}.svg`, stroke: 2 },
  phosphor: { name: 'Phosphor', pkg: '@phosphor-icons/core', file: (n) => `assets/regular/${n}.svg` },
  'phosphor-fill': { name: 'Phosphor Fill', pkg: '@phosphor-icons/core', file: (n) => `assets/fill/${n}-fill.svg`, names: 'phosphor' },
  material: { name: 'Material Symbols', pkg: '@material-symbols/svg-400', file: (n) => `rounded/${n}.svg` },
  bootstrap: { name: 'Bootstrap Icons', pkg: 'bootstrap-icons', file: (n) => `icons/${n}.svg` },
  remix: { name: 'Remix Icon', pkg: 'remixicon', file: (n) => remixFile(n) },
};

// the name of each icon in each pack: [lucide, tabler, phosphor, material, bootstrap, remix]
const ICONS = {
  plus: ['plus', 'plus', 'plus', 'add', 'plus-lg', 'add-line'],
  settings: ['settings', 'settings', 'gear', 'settings', 'gear', 'settings-3-line'],
  send: ['send', 'send', 'paper-plane-tilt', 'send', 'send', 'send-plane-2-line'],
  back: ['chevron-left', 'chevron-left', 'caret-left', 'chevron_left', 'chevron-left', 'arrow-left-s-line'],
  close: ['x', 'x', 'x', 'close', 'x-lg', 'close-line'],
  link: ['link', 'link', 'link', 'link', 'link-45deg', 'link'],
  qr: ['qr-code', 'qrcode', 'qr-code', 'qr_code', 'qr-code', 'qr-code-line'],
  user: ['user', 'user', 'user', 'person', 'person', 'user-line'],
  users: ['users', 'users', 'users', 'group', 'people', 'group-line'],
  userPlus: ['user-plus', 'user-plus', 'user-plus', 'person_add', 'person-plus', 'user-add-line'],
  phone: ['phone', 'phone', 'phone', 'call', 'telephone', 'phone-line'],
  phoneOff: ['phone-off', 'phone-off', 'phone-slash', 'call_end', 'telephone-x', ['phone-line', 'rotate(135 12 12)']],
  info: ['info', 'info-circle', 'info', 'info', 'info-circle', 'information-line'],
  lock: ['lock', 'lock', 'lock', 'lock', 'lock', 'lock-line'],
  key: ['key-round', 'key', 'key', 'key', 'key', 'key-2-line'],
  copy: ['copy', 'copy', 'copy', 'content_copy', 'copy', 'file-copy-line'],
  reply: ['reply', 'arrow-back-up', 'arrow-bend-up-left', 'reply', 'reply', 'reply-line'],
  edit: ['pencil', 'pencil', 'pencil-simple', 'edit', 'pencil', 'pencil-line'],
  trash: ['trash-2', 'trash', 'trash', 'delete', 'trash', 'delete-bin-line'],
  smile: ['smile', 'mood-smile', 'smiley', 'mood', 'emoji-smile', 'emotion-happy-line'],
  check: ['check', 'check', 'check', 'check', 'check-lg', 'check-line'],
  checks: ['check-check', 'checks', 'checks', 'done_all', 'check-all', 'check-double-line'],
  clock: ['clock', 'clock', 'clock', 'schedule', 'clock', 'time-line'],
  alert: ['triangle-alert', 'alert-triangle', 'warning', 'warning', 'exclamation-triangle', 'alert-line'],
  wifi: ['wifi', 'wifi', 'wifi-high', 'wifi', 'wifi', 'wifi-line'],
  wifiOff: ['wifi-off', 'wifi-off', 'wifi-slash', 'wifi_off', 'wifi-off', 'wifi-off-line'],
  mail: ['mail', 'mail', 'envelope-simple', 'mail', 'envelope', 'mail-line'],
  bell: ['bell', 'bell', 'bell', 'notifications', 'bell', 'notification-3-line'],
  shield: ['shield', 'shield', 'shield', 'shield', 'shield', 'shield-line'],
  shieldCheck: ['shield-check', 'shield-check', 'shield-check', 'verified_user', 'shield-check', 'shield-check-line'],
  incognito: ['hat-glasses', 'spy', 'detective', 'domino_mask', 'incognito', 'spy-line'],
  search: ['search', 'search', 'magnifying-glass', 'search', 'search', 'search-line'],
  more: ['ellipsis', 'dots', 'dots-three', 'more_horiz', 'three-dots', 'more-line'],
  star: ['star', 'star', 'star', 'star', 'star', 'star-line'],
  file: ['file', 'file', 'file', 'draft', 'file-earmark', 'file-line'],
  image: ['image', 'photo', 'image', 'image', 'image', 'image-line'],
  camera: ['camera', 'camera', 'camera', 'photo_camera', 'camera', 'camera-line'],
  download: ['download', 'download', 'download-simple', 'download', 'download', 'download-line'],
  upload: ['upload', 'upload', 'upload-simple', 'upload', 'upload', 'upload-line'],
  paperclip: ['paperclip', 'paperclip', 'paperclip', 'attach_file', 'paperclip', 'attachment-2'],
  play: ['play', 'player-play', 'play', 'play_arrow', 'play', 'play-line'],
  pause: ['pause', 'player-pause', 'pause', 'pause', 'pause', 'pause-line'],
  mic: ['mic', 'microphone', 'microphone', 'mic', 'mic', 'mic-line'],
  micOff: ['mic-off', 'microphone-off', 'microphone-slash', 'mic_off', 'mic-mute', 'mic-off-line'],
  video: ['video', 'video', 'video-camera', 'videocam', 'camera-video', 'vidicon-line'],
  videoOff: ['video-off', 'video-off', 'video-camera-slash', 'videocam_off', 'camera-video-off', 'camera-off-line'],
  screen: ['monitor-up', 'screen-share', 'screencast', 'screen_share', 'display', 'computer-line'],
  retry: ['rotate-cw', 'refresh', 'arrow-clockwise', 'refresh', 'arrow-clockwise', 'refresh-line'],
  palette: ['palette', 'palette', 'palette', 'palette', 'palette', 'palette-line'],
  globe: ['globe', 'world', 'globe', 'language', 'globe', 'global-line'],
  megaphone: ['megaphone', 'speakerphone', 'megaphone', 'campaign', 'megaphone', 'megaphone-line'],
  logOut: ['log-out', 'logout', 'sign-out', 'logout', 'box-arrow-right', 'logout-box-r-line'],
  eye: ['eye', 'eye', 'eye', 'visibility', 'eye', 'eye-line'],
  eyeOff: ['eye-off', 'eye-off', 'eye-slash', 'visibility_off', 'eye-slash', 'eye-off-line'],
};
const COLUMN = { lucide: 0, tabler: 1, phosphor: 2, material: 3, bootstrap: 4, remix: 5 };

let remixIndex;
function remixFile(n) {
  if (!remixIndex) {
    remixIndex = new Map();
    const root = path.join(DIR, 'remixicon/icons');
    for (const cat of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, cat))) remixIndex.set(f, `icons/${cat}/${f}`);
  }
  return remixIndex.get(`${n}.svg`) ?? `icons/missing/${n}.svg`;
}

const TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const KEEP = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points', 'fill-rule', 'clip-rule', 'transform', 'opacity']);

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** the drawing elements of an SVG file */
function parse(svg, file) {
  const root = /<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new Error(`${file}: no <svg>`);
  const body = svg.slice(root.index + root[0].length, svg.lastIndexOf('</svg>')).replace(/<!--[\s\S]*?-->/g, '');
  const nodes = [];
  for (const m of body.matchAll(/<\s*(\/?)([a-zA-Z]+)\b([^>]*?)\/?>/g)) {
    const [, close, tag, rest] = m;
    if (close) continue;
    if (!TAGS.has(tag)) throw new Error(`${file}: <${tag}> is not supported`);
    const a = attrs(rest);
    // the bounding box of Tabler icons
    if (a.stroke === 'none' && a.d === 'M0 0h24v24H0z') continue;
    if (a.fill === 'none' && a.stroke === 'none') continue;
    const kept = Object.fromEntries(Object.entries(a).filter(([k]) => KEEP.has(k)));
    nodes.push([tag, kept]);
  }
  return { viewBox: attrs(root[1]).viewBox, nodes };
}

const LICENSE_FILES = ['LICENSE', 'License', 'LICENSE.txt'];

fs.mkdirSync(OUT, { recursive: true });
const notices = [];
const seenPkgs = new Set();
for (const [id, pack] of Object.entries(PACKS)) {
  const dir = path.join(DIR, pack.pkg);
  const { version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const column = COLUMN[pack.names ?? id];
  let viewBox;
  const icons = {};
  for (const [name, names] of Object.entries(ICONS)) {
    const entry = names[column];
    const [iconName, transform] = Array.isArray(entry) ? entry : [entry];
    const file = path.join(dir, pack.file(iconName));
    if (!fs.existsSync(file)) throw new Error(`${pack.name}: no icon ${iconName} for ${name} (${file})`);
    const parsed = parse(fs.readFileSync(file, 'utf8'), file);
    if (viewBox && parsed.viewBox !== viewBox) throw new Error(`${file}: viewBox ${parsed.viewBox}, not ${viewBox}`);
    viewBox = parsed.viewBox;
    icons[name] = transform ? parsed.nodes.map(([t, a]) => [t, { ...a, transform }]) : parsed.nodes;
  }
  const src =
    `// Generated by scripts/icon-packs.mjs from ${pack.pkg} ${version} (${license}), see public/icon-licenses.txt.\n` +
    `import type { IconPack } from '../icons';\n\n` +
    `const pack: IconPack = ${JSON.stringify({ viewBox, stroke: pack.stroke ?? 0, icons })};\n\nexport default pack;\n`;
  fs.writeFileSync(path.join(OUT, `${id}.ts`), src);
  console.log(`${id}: ${Object.keys(icons).length} icons, ${src.length} bytes`);
  if (!seenPkgs.has(pack.pkg)) {
    seenPkgs.add(pack.pkg);
    const lf = LICENSE_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    notices.push(`${pack.pkg} ${version} (${license})\n\n${lf ? fs.readFileSync(lf, 'utf8').trim() : license}`);
  }
}
fs.writeFileSync(
  path.join(OUT, 'names.ts'),
  `// Generated by scripts/icon-packs.mjs: the icons of every pack.\nexport type IconName =\n${Object.keys(ICONS)
    .map((n) => `  | '${n}'`)
    .join('\n')};\n`,
);
fs.writeFileSync(
  'public/icon-licenses.txt',
  `Duplex uses icons from these packs (a selection of each, in src/ui/iconpacks), under their licenses:\n\n${notices.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`,
);
