// UI helpers: time formatting, avatars, SimpleX markdown, QR codes, image resizing.
import type { JSX } from 'preact';
import qrcode from 'qrcode-generator';
import type { Profile } from '../core/chat/protocol';

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diff = (now.getTime() - ts) / 86400000;
  if (diff < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const COLORS = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#dce775', '#ffb74d', '#a1887f'];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** only inline images are shown: data URLs of image types */
export function safeImage(src: unknown): string | undefined {
  return typeof src === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(src) ? src : undefined;
}

export function Avatar({ profile, size = 40, name }: { profile?: Profile; size?: number; name?: string }): JSX.Element {
  const label = name ?? profile?.displayName ?? '?';
  const img = safeImage(profile?.image);
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` };
  if (img) return <img class="avatar" src={img} alt="" style={style} />;
  return (
    <div class="avatar" style={{ ...style, background: COLORS[hashStr(label) % COLORS.length] }} aria-hidden="true">
      {[...label.trim()][0]?.toUpperCase() ?? '?'}
    </div>
  );
}

export function QRCode({ text, size = 240 }: { text: string; size?: number }): JSX.Element {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  const q = 2;
  return (
    <svg class="qr" width={size} height={size} viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`} shape-rendering="crispEdges" role="img" aria-label="QR code">
      <rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

// ---- SimpleX markdown: *bold* _italic_ ~strike~ `code` !1 colored! #secret# and links

type Seg = { t: string; k?: 'b' | 'i' | 's' | 'code' | 'secret' | 'link' | 'slink' | 'color'; c?: string };

const COLOR_MAP: Record<string, string> = { '1': 'red', '2': 'green', '3': 'blue', '4': 'yellow', '5': 'cyan', '6': 'magenta', r: 'red', g: 'green', b: 'blue', y: 'yellow', c: 'cyan', m: 'magenta' };

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])|(simplex:\/[^\s<>"']+)/g;

function linkify(text: string, out: Seg[]): void {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > last) out.push({ t: text.slice(last, m.index) });
    const u = m[0];
    out.push({ t: u, k: isSimplexLink(u) ? 'slink' : 'link' });
    last = m.index! + u.length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
}

export function isSimplexLink(u: string): boolean {
  return /^simplex:\//.test(u) || /^https:\/\/(simplex\.chat|[^/]+)\/(i|a|c|g|r|invitation|contact)\/?#/.test(u);
}

function parseMd(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /(\*[^*\s](?:[^*]*[^*\s])?\*)|(_[^_\s](?:[^_]*[^_\s])?_)|(~[^~\s](?:[^~]*[^~\s])?~)|(`[^`]+`)|(#[^#\s](?:[^#]*[^#\s])?#)|(![1-6rgbycm] [^!]+!)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index!;
    // formatting must start at a word boundary
    if (i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1]) && !m[4]) continue;
    if (i > last) linkify(text.slice(last, i), out);
    const s = m[0];
    if (m[1]) out.push({ t: s.slice(1, -1), k: 'b' });
    else if (m[2]) out.push({ t: s.slice(1, -1), k: 'i' });
    else if (m[3]) out.push({ t: s.slice(1, -1), k: 's' });
    else if (m[4]) out.push({ t: s.slice(1, -1), k: 'code' });
    else if (m[5]) out.push({ t: s.slice(1, -1), k: 'secret' });
    else if (m[6]) out.push({ t: s.slice(3, -1), k: 'color', c: COLOR_MAP[s[1]] });
    last = i + s.length;
  }
  if (last < text.length) linkify(text.slice(last), out);
  return out;
}

/** the text without formatting markers, with secrets hidden: for previews, quotes and notifications */
export function plainText(text: string): string {
  return text
    .split(/```/)
    .map((b, bi) => (bi % 2 === 1 ? b.replace(/^\n/, '') : parseMd(b).map((s) => (s.k === 'secret' ? '•••' : s.t)).join('')))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }): JSX.Element {
  const parts: JSX.Element[] = [];
  const blocks = text.split(/```/);
  blocks.forEach((b, bi) => {
    if (bi % 2 === 1) {
      parts.push(<pre class="md-pre">{b.replace(/^\n/, '')}</pre>);
      return;
    }
    parseMd(b).forEach((s) => {
      switch (s.k) {
        case 'b':
          parts.push(<b>{s.t}</b>);
          break;
        case 'i':
          parts.push(<i>{s.t}</i>);
          break;
        case 's':
          parts.push(<s>{s.t}</s>);
          break;
        case 'code':
          parts.push(<code>{s.t}</code>);
          break;
        case 'secret':
          parts.push(
            <span class="md-secret" tabIndex={0} onClick={(e) => (e.currentTarget as HTMLElement).classList.toggle('shown')}>
              {s.t}
            </span>,
          );
          break;
        case 'color':
          parts.push(<span class={`md-${s.c}`}>{s.t}</span>);
          break;
        case 'link':
        case 'slink':
          parts.push(
            <a
              href={s.t}
              rel="noopener noreferrer nofollow"
              target="_blank"
              onClick={(e) => {
                if (onLink) {
                  e.preventDefault();
                  onLink(s.t);
                }
              }}
            >
              {s.t}
            </a>,
          );
          break;
        default:
          parts.push(<>{s.t}</>);
      }
    });
  });
  return <>{parts}</>;
}

/** resizes an image file to a square JPEG data URL small enough for a profile */
export async function resizeImage(file: File, size = 192, maxBytes = 12000): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const s = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    for (let q = 0.85; q > 0.2; q -= 0.1) {
      const d = canvas.toDataURL('image/jpeg', q);
      if (d.length <= maxBytes) return d.replace('data:image/jpeg', 'data:image/jpg');
    }
    throw new Error('the image is too large');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function copyText(t: string): Promise<void> {
  return navigator.clipboard.writeText(t);
}
