// Preparing files to send. Photos are re-encoded in the page, which removes their location and the
// other metadata of the camera, and resized to the size the apps send; videos get a preview frame and
// their duration. Browsers that resist fingerprinting (Tor Browser) do not let pages read canvas
// pixels: there, JPEG and PNG metadata is removed from the original file instead.
import { FIXED_IMAGE_PREVIEW, MAX_IMAGE_SIZE, MAX_PREVIEW_LENGTH, type OutgoingFile } from '../app/files';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** IMG_yyyyMMdd_HHmmss.ext in UTC, as the apps name images */
export function timestampName(prefix: string, ext: string, d = new Date()): string {
  return `${prefix}_${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.${ext}`;
}

let canvasOk: boolean | undefined;

/** whether the page can read canvas pixels (noise added by anti-fingerprinting is tolerated) */
export function canvasReadable(): boolean {
  if (canvasOk !== undefined) return canvasOk;
  try {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const ctx = c.getContext('2d')!;
    const colors = [
      [255, 0, 0],
      [0, 128, 0],
      [0, 0, 255],
      [16, 16, 16],
    ];
    colors.forEach(([r, g, b], i) => {
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((i % 2) * 2, Math.floor(i / 2) * 2, 2, 2);
    });
    const d = ctx.getImageData(0, 0, 4, 4).data;
    canvasOk = colors.every(([r, g, b], i) => {
      const o = (Math.floor(i / 2) * 2 * 4 + (i % 2) * 2) * 4;
      return Math.abs(d[o] - r) <= 8 && Math.abs(d[o + 1] - g) <= 8 && Math.abs(d[o + 2] - b) <= 8;
    });
  } catch {
    canvasOk = false;
  }
  return canvasOk;
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // the decoded image stays usable
    URL.revokeObjectURL(url);
  }
}

function draw(src: CanvasImageSource, w: number, h: number, maxSide: number, background?: string): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be encoded'))), type, quality));
}

/** a JPEG data URL of at most MAX_PREVIEW_LENGTH characters, with the "jpg" type that the apps decode */
export function previewDataUrl(src: CanvasImageSource, w: number, h: number): string {
  if (!canvasReadable()) return FIXED_IMAGE_PREVIEW;
  for (let side = 480; side >= 32; side = Math.floor(side * 0.8)) {
    const c = draw(src, w, h, side, '#ffffff');
    for (const q of [0.75, 0.6, 0.45]) {
      const d = c.toDataURL('image/jpeg', q).replace(/^data:image\/jpeg/, 'data:image/jpg');
      if (d.length <= MAX_PREVIEW_LENGTH) return d;
    }
  }
  return FIXED_IMAGE_PREVIEW;
}

function hasAlpha(c: HTMLCanvasElement): boolean {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const step = Math.max(1, Math.floor(d.length / 4 / 20000)) * 4;
  for (let i = 3; i < d.length; i += step) if (d[i] < 250) return true;
  return false;
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.slice(0, Math.min(b.size, 64)).arrayBuffer());

function isAnimatedWebp(head: Uint8Array): boolean {
  // RIFF....WEBPVP8X with the animation flag
  const s = String.fromCharCode(...head.subarray(8, 16));
  return s === 'WEBPVP8X' && (head[20] & 0x02) !== 0;
}

/** an image to send: resized to MAX_IMAGE_SIZE and re-encoded, or as it is (animations, Tor Browser) */
async function prepareImage(file: File): Promise<OutgoingFile | undefined> {
  const head = await bytesOf(file);
  const isGif = String.fromCharCode(...head.subarray(0, 3)) === 'GIF';
  const isPng = head[0] === 0x89 && head[1] === 0x50;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    // a format this browser cannot show (e.g. HEIC): sent as a file
    return undefined;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return undefined;
  const preview = previewDataUrl(img, w, h);
  // animations are sent as they are, like in the apps
  if (isGif || isAnimatedWebp(head)) return { blob: file, name: timestampName('IMG', isGif ? 'gif' : 'webp'), kind: 'image', preview };
  if (!canvasReadable()) {
    // the pixels cannot be read here: the metadata is removed from the file itself
    const orig = new Uint8Array(await file.arrayBuffer());
    const clean = isJpeg ? stripJpegMetadata(orig) : isPng ? stripPngMetadata(orig) : undefined;
    if (!clean) return { blob: file, name: file.name || timestampName('IMG', 'jpg'), kind: 'file' };
    const blob = new Blob([clean as BlobPart]);
    const ext = isJpeg ? 'jpg' : 'png';
    return blob.size <= MAX_IMAGE_SIZE ? { blob, name: timestampName('IMG', ext), kind: 'image', preview } : { blob, name: timestampName('IMG', ext), kind: 'file' };
  }
  // PNG and WebP images with transparency stay PNG, everything else becomes JPEG
  const transparent = !isJpeg && hasAlpha(draw(img, w, h, 512));
  for (let side = 2048; side >= 64; side = Math.floor(side * 0.8)) {
    if (transparent) {
      const b = await toBlob(draw(img, w, h, side), 'image/png');
      if (b.size <= MAX_IMAGE_SIZE) return { blob: b, name: timestampName('IMG', 'png'), kind: 'image', preview };
    } else {
      const c = draw(img, w, h, side, '#ffffff');
      for (const q of [0.85, 0.75, 0.65]) {
        const b = await toBlob(c, 'image/jpeg', q);
        if (b.size <= MAX_IMAGE_SIZE) return { blob: b, name: timestampName('IMG', 'jpg'), kind: 'image', preview };
      }
    }
  }
  return undefined;
}

/** a video to send, with its first frame as the preview; undefined when the browser cannot play it */
async function prepareVideo(file: File): Promise<OutgoingFile | undefined> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    const event = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 10000);
        v.addEventListener(name, () => (clearTimeout(t), resolve()), { once: true });
        v.addEventListener('error', () => (clearTimeout(t), reject(new Error('the video cannot be played'))), { once: true });
      });
    const loaded = event('loadeddata');
    v.src = url;
    await loaded;
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const seeked = event('seeked');
    v.currentTime = Math.min(0.5, duration / 2);
    await seeked;
    if (!v.videoWidth || !v.videoHeight) return undefined;
    return { blob: file, name: file.name || timestampName('video', 'mp4'), kind: 'video', preview: previewDataUrl(v, v.videoWidth, v.videoHeight), duration };
  } catch {
    return undefined;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

/** a chosen file as an image, a video or a file */
export async function prepareOutgoing(file: File): Promise<OutgoingFile> {
  const type = file.type.toLowerCase();
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (/^image\/(jpeg|png|gif|webp|bmp|avif)$/.test(type) || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
    const img = await prepareImage(file);
    if (img) return img;
  } else if (/^video\/(mp4|webm|quicktime)$/.test(type) || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) {
    const vid = await prepareVideo(file);
    if (vid) return vid;
  }
  return { blob: file, name: file.name || 'file', kind: 'file' };
}

// ---- metadata removal without decoding (when canvas pixels cannot be read)

/** the orientation tag of an Exif APP1 segment */
function exifOrientation(seg: Uint8Array): number | undefined {
  // FF E1 len "Exif\0\0" TIFF
  if (String.fromCharCode(...seg.subarray(4, 10)) !== 'Exif\0\0') return undefined;
  const t = seg.subarray(10);
  const le = t[0] === 0x49;
  const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  if (t.length < 8) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return undefined;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return undefined;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : undefined;
    }
  }
  return undefined;
}

/** an Exif APP1 segment with only the orientation */
function orientationSegment(o: number): Uint8Array {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0];
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const len = 2 + exif.length + tiff.length;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...exif, ...tiff]);
}

/**
 * removes the Exif, XMP, IPTC and comment segments of a JPEG and anything after its end (like the
 * extra images that phones append), keeping the orientation; undefined if it is not a valid JPEG
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const out: Uint8Array[] = [];
  let orientation = 1;
  let i = 2;
  let scan = false;
  while (i < b.length) {
    if (scan) {
      // entropy-coded data: until a marker that is not a stuffed byte or a restart marker
      const start = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) i++;
      out.push(b.subarray(start, i));
      scan = false;
      if (i + 1 >= b.length) return undefined;
      continue;
    }
    if (b[i] !== 0xff) return undefined;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd9) {
      out.push(b.subarray(i, i + 2));
      const parts = [b.subarray(0, 2), ...(orientation !== 1 ? [orientationSegment(orientation)] : []), ...out];
      const res = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) {
        res.set(p, o);
        o += p.length;
      }
      return res;
    }
    if (i + 4 > b.length) return undefined;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return undefined;
    const seg = b.subarray(i, i + 2 + len);
    if (m === 0xe1) orientation = exifOrientation(seg) ?? orientation;
    const iccProfile = m === 0xe2 && String.fromCharCode(...seg.subarray(4, 15)) === 'ICC_PROFILE';
    // JFIF (APP0), the color profile (APP2) and Adobe color information (APP14) are kept
    const drop = (m >= 0xe1 && m <= 0xef && m !== 0xee && !iccProfile) || m === 0xfe;
    if (!drop) out.push(seg);
    i += 2 + len;
    if (m === 0xda) scan = true;
  }
  return undefined;
}

/** removes the text, time and Exif chunks of a PNG; undefined if it is not a valid PNG */
export function stripPngMetadata(b: Uint8Array): Uint8Array | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || sig.some((x, i) => b[i] !== x)) return undefined;
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    if (i + 12 + len > b.length) return undefined;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) keep.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') break;
  }
  const res = new Uint8Array(keep.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of keep) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}
