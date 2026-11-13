// File and image messages (XFTP) in chats. Files are sent as the SimpleX Chat apps send them: the
// message with the file goes first, then the file is encrypted and uploaded to a file server, and its
// description (the key and the locations of the chunks) follows in x.msg.file.descr messages. Copies
// of sent and received files are kept in the vault, in pieces.
import type { Connector } from '../core/smp/client';
import type { ProtocolServer } from '../core/smp/server';
import { equal, fromAscii, type Bytes } from '../core/util/bytes';
import { XFTPPool } from '../core/xftp/client';
import { decodeFileDescription, descriptionServers, type FileDescription } from '../core/xftp/description';
import { GB, MB } from '../core/xftp/protocol';
import { deletePieces, piecesFor, readPieceBlobs, storeBlob } from './filestore';
import type { Vault } from './vault';

export type FileStatus =
  /** sent: stored in this browser, waiting to be uploaded */
  | 'sndStored'
  | 'sndUploading'
  /** sent: uploaded, and the description was sent */
  | 'sndComplete'
  /** sent: cancelled or revoked (deleted from the servers) */
  | 'sndCancelled'
  | 'sndError'
  /** received: not downloaded */
  | 'rcvInvitation'
  /** received: to be downloaded when the description is complete */
  | 'rcvAccepted'
  | 'rcvTransfer'
  | 'rcvComplete'
  /** received: cancelled by the sender */
  | 'rcvCancelled'
  | 'rcvError';

export interface ChatFile {
  /** local ID: the name of the stored pieces and of the transfer record */
  id: string;
  /** the name to save it as, without folders */
  name: string;
  size: number;
  status: FileStatus;
  /** the number of stored pieces, when the content is in this browser */
  pieces?: number;
  /** the type found in the first bytes (images and videos are shown in the page, nothing else) */
  mime?: string;
  error?: string;
  /** the error cannot be fixed by trying again */
  permanent?: boolean;
  /** received: download it as soon as the description is complete */
  accepted?: boolean;
  /** received: hosts of file servers that the user has not approved */
  unknownServers?: string[];
  /** when the file servers delete the file (ms) */
  expiresAt?: number;
}

/** the transfer record of a file, kept apart from the chat items because it holds keys */
export interface FileMeta {
  /** sent: the descriptions of the uploaded file (YAML): to delete it, and for the recipient */
  sndDescr?: string;
  rcvDescr?: string;
  /** received: the description received so far */
  descrText?: string;
  descrPartNo?: number;
  descrComplete?: boolean;
  /** received: the user approved downloading from servers they do not use */
  approved?: boolean;
  /** sent: the number of description parts sent to the contact */
  sentParts?: number;
  /** sent: when the file servers delete the file, in seconds since the epoch */
  expiresAt?: number;
}

/** a file to send, prepared by the page (images resized, previews made) */
export interface OutgoingFile {
  blob: Blob;
  name: string;
  /** an image or a video is shown with its preview (a data URL), a file with its name */
  kind: 'image' | 'video' | 'file';
  preview?: string;
  /** of a video, in seconds */
  duration?: number;
}

/** the preview that simplex-chat uses when it cannot make one (fixedImagePreview) */
export const FIXED_IMAGE_PREVIEW =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAKVJREFUeF7t1kENACEUQ0FQhnVQ9lfGO+xggITQdvbMzArPey+8fa3tAfwAEdABZQspQStgBssEcgAIkSAJkiAJljtEgiRIgmUCSZAESZAESZAEyx0iQRIkwTKBJEiCv5fgvTd1wDmn7QAP4AeIgA4oW0gJWgEzWCZwbQ7gAA7ggLKFOIADOKBMIAeAEAmSIAmSYLlDJEiCJFgmkARJkARJ8N8S/ADTZUewBvnTOQAAAABJRU5ErkJggg==';

/** the largest file sent or received: the limit of the apps for users without badges */
export const MAX_FILE_SIZE = GB;
/** the limit of the file servers, for the check of received descriptions (maxFileSizeHard) */
const MAX_FILE_SIZE_HARD = 5 * GB;
/** sent images are resized to fit this size, as in the apps */
export const MAX_IMAGE_SIZE = 261120;
/** received images and videos up to these sizes are downloaded automatically, as in the apps */
export const AUTO_RECEIVE_IMAGE_SIZE = 2 * MAX_IMAGE_SIZE;
export const AUTO_RECEIVE_VIDEO_SIZE = 1047552;
/** image previews in messages are data URLs of at most this length */
export const MAX_PREVIEW_LENGTH = 14000;
/** the size of the description parts in messages (xftpDescrPartSize) */
export const DESCR_PART_SIZE = 14000;
/** the limits of received descriptions (rcvFileDescrWithinLimits) */
export const MAX_DESCR_LENGTH = 1024 * 1024;
export const MAX_DESCR_PARTS = 1024;

export interface FileDescrPart {
  fileDescrText: string;
  fileDescrPartNo: number;
  fileDescrComplete: boolean;
}

/** splitFileDescr of simplex-chat: parts numbered from 1, the last one marked complete */
export function splitFileDescr(text: string, partSize = DESCR_PART_SIZE): FileDescrPart[] {
  const parts: FileDescrPart[] = [];
  let rest = text;
  for (let n = 1; ; n++) {
    const part = rest.slice(0, partSize);
    rest = rest.slice(partSize);
    parts.push({ fileDescrText: part, fileDescrPartNo: n, fileDescrComplete: !rest.length });
    if (!rest.length) return parts;
  }
}

/** a file name without folders and without characters that file systems refuse */
export function safeFileName(name: unknown): string {
  let n = typeof name === 'string' ? name : '';
  n = n.split(/[/\\]/).pop() ?? '';
  n = n
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\s+/, '')
    .replace(/[\s.]+$/, '');
  if (!n || n === '.' || n === '..') return 'file';
  const chars = [...n];
  if (chars.length <= 200) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
  return chars.slice(0, 200 - [...ext].length).join('') + ext;
}

/** the type of a file from its first bytes: only these types are shown in the page */
export function sniffType(b: Bytes): string | undefined {
  const at = (o: number, s: string) => b.length >= o + s.length && fromAscii(b.subarray(o, o + s.length)) === s;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp')) return at(8, 'M4A ') ? 'audio/mp4' : at(8, 'qt  ') ? 'video/quicktime' : 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (at(0, 'OggS')) return 'audio/ogg';
  return undefined;
}

export const isImageType = (t?: string): boolean => !!t && /^image\/(jpeg|png|gif|webp)$/.test(t);
export const isVideoType = (t?: string): boolean => t === 'video/mp4' || t === 'video/webm';
/** voice messages of the apps are AAC in MP4 containers */
export const isAudioType = (t?: string): boolean => t === 'audio/mp4' || t === 'audio/ogg' || t === 'video/mp4' || t === 'video/webm';

/** a sent file, or a received one that was downloaded, is stored in this browser */
export const hasContent = (f: ChatFile): boolean => f.pieces !== undefined && (f.status === 'rcvComplete' || f.status.startsWith('snd'));

/** a file server that the user uses or that belongs to the presets: the same identity and a common host */
export function knownServer(srv: ProtocolServer, known: ProtocolServer[]): boolean {
  return known.some((k) => equal(k.keyHash, srv.keyHash) && (k.port || '') === (srv.port || '') && k.hosts.some((h) => srv.hosts.includes(h)));
}

/** checks a complete received description, like receiveViaCompleteFD */
export function checkDescription(text: string, declaredSize: number): FileDescription {
  const fd = decodeFileDescription(text);
  if (fd.party !== 'recipient') throw new Error('not a description for the recipient');
  if (fd.redirect) throw new Error('file links are not supported');
  // encryption and the chunk sizes make the transfer larger than the file
  if (fd.size > Math.min(declaredSize, MAX_FILE_SIZE_HARD) + 10 * MB) throw new Error('the file is larger than declared');
  return fd;
}

export const unknownServers = (fd: FileDescription, known: ProtocolServer[]): ProtocolServer[] => descriptionServers(fd).filter((s) => !knownServer(s, known));

export const abortError = (msg: string): DOMException => new DOMException(msg, 'AbortError');

/**
 * why a transfer was aborted: cancelled by the user, revoked (a sent file deleted from the servers),
 * cancelled by the sender, its message deleted, or the profile locked
 */
export type CancelReason = 'cancelled' | 'revoked' | 'sender' | 'deleted' | 'stopped';

/** the reason of an aborted transfer, undefined for other errors */
export function cancelReason(e: unknown): CancelReason | undefined {
  return (e as Error | undefined)?.name === 'AbortError' ? ((e as Error).message as CancelReason) : undefined;
}

/**
 * The file transfers of a profile: at most two at a time over one connection per file server, and
 * the local copies of files.
 */
export class FileManager {
  readonly pool: XFTPPool;
  /** the progress (0..1) of running transfers */
  readonly progress = new Map<string, number>();
  private active = new Map<string, { ctrl: AbortController; done: Promise<void>; f: (signal: AbortSignal) => Promise<void>; again?: boolean }>();
  private lastEmit = new Map<string, number>();
  private slots = 2;
  private waiting: Array<() => void> = [];
  private stopped = false;

  constructor(
    private vault: Vault,
    connector: () => Connector,
  ) {
    this.pool = new XFTPPool(connector);
  }

  /** after stop, transfers end without changing the files: they are started again after unlocking */
  get isStopped(): boolean {
    return this.stopped;
  }

  getMeta(id: string): Promise<FileMeta | undefined> {
    return this.vault.get<FileMeta>(`filemeta:${id}`);
  }

  putMeta(id: string, m: FileMeta): Promise<void> {
    return this.vault.put(`filemeta:${id}`, m);
  }

  delMeta(id: string): Promise<void> {
    return this.vault.del(`filemeta:${id}`);
  }

  /** stores a file chosen to send; returns the number of pieces */
  store(id: string, blob: Blob): Promise<number> {
    return storeBlob(this.vault, id, blob);
  }

  /** the stored content: images and videos with their type, anything else as plain bytes to save */
  async blob(f: ChatFile, inline = false): Promise<Blob> {
    if (f.pieces === undefined) throw new Error('the file is not in this browser');
    const parts = await readPieceBlobs(this.vault, f.id, f.pieces);
    const type = inline && (isImageType(f.mime) || isAudioType(f.mime)) ? f.mime! : 'application/octet-stream';
    return new Blob(parts, { type });
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /**
   * runs a transfer when a slot is free; cancel(id) and stop() abort its signal. f is always called
   * (with an aborted signal when it was cancelled while waiting), and it handles its own errors and
   * the status of the file, so that the file is in its final state when settled(id) resolves.
   */
  run(id: string, f: (signal: AbortSignal) => Promise<void>): void {
    if (this.stopped) return;
    const cur = this.active.get(id);
    if (cur) {
      // e.g. the last part of a description arrived while an earlier attempt was still checking it
      cur.again = true;
      return;
    }
    const ctrl = new AbortController();
    const done = (async () => {
      let acquired = false;
      try {
        await this.acquire(ctrl.signal);
        acquired = true;
      } catch {
        // cancelled while waiting
      }
      try {
        await f(ctrl.signal);
      } catch (e) {
        console.warn('file transfer error', e);
      } finally {
        if (acquired) this.release();
      }
    })();
    const entry: { ctrl: AbortController; done: Promise<void>; f: (signal: AbortSignal) => Promise<void>; again?: boolean } = { ctrl, done, f };
    this.active.set(id, entry);
    void done.then(() => {
      if (this.active.get(id) === entry) this.active.delete(id);
      this.progress.delete(id);
      this.lastEmit.delete(id);
      if (entry.again && !ctrl.signal.aborted) this.run(id, f);
    });
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject(signal.reason);
      };
      this.waiting.push(go);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.slots++;
  }

  /** aborts a transfer; the reason ('cancelled', 'revoked', 'sender', 'deleted') is the message of the error */
  cancel(id: string, reason: CancelReason = 'cancelled'): void {
    const a = this.active.get(id);
    if (!a) return;
    a.again = false;
    a.ctrl.abort(abortError(reason));
  }

  /** resolves when the transfer of this file (if any) has ended */
  async settled(id: string): Promise<void> {
    await this.active.get(id)?.done;
  }

  /** records the progress of a transfer; true when it is time to show it (at most 4 times a second) */
  setProgress(id: string, done: number, total: number): boolean {
    const v = total ? Math.min(1, done / total) : 0;
    this.progress.set(id, v);
    const now = Date.now();
    if (v < 1 && now - (this.lastEmit.get(id) ?? 0) < 250) return false;
    this.lastEmit.set(id, now);
    return true;
  }

  /** deletes the local copy and the transfer record of a file whose transfer has ended */
  async deleteLocal(f: ChatFile): Promise<void> {
    // an interrupted download may have left pieces
    const pieces = f.status === 'rcvTransfer' ? piecesFor(f.size + 10 * MB) : (f.pieces ?? 0);
    await deletePieces(this.vault, f.id, pieces);
    await this.delMeta(f.id);
  }

  stop(): void {
    this.stopped = true;
    for (const a of this.active.values()) a.ctrl.abort(abortError('stopped'));
    this.pool.close();
  }

  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}
