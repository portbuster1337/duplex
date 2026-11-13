// Files, images, videos and voice messages in conversations, and the files chosen to send.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { FileApprovalError, type ChatItem } from '../app/chat';
import { hasContent, isImageType, isVideoType, type ChatFile, type OutgoingFile } from '../app/files';
import { errorText, Modal, Spinner, toast } from './components';
import { Icon } from './icons';
import { fmtSize, safeImage } from './util';
import { prepareOutgoing } from './media';

/** an object URL of a stored file while the component is shown (enabled) */
export function useFileUrl(session: Session, f: ChatFile | undefined, enabled: boolean): string | undefined {
  const [url, setUrl] = useState<string>();
  const key = f && enabled && hasContent(f) ? `${f.id}:${f.pieces}:${f.status}` : '';
  useEffect(() => {
    if (!key || !f) {
      setUrl(undefined);
      return;
    }
    let u: string | undefined;
    let cancelled = false;
    session.chat
      .fileBlob(f, true)
      .then((b) => {
        if (cancelled) return;
        u = URL.createObjectURL(b);
        setUrl(u);
      })
      .catch(() => setUrl(undefined));
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [key]);
  return url;
}

/** saves a stored file with the download dialog of the browser (only its bytes, never opened in the page) */
export async function saveFile(session: Session, f: ChatFile): Promise<void> {
  const b = await session.chat.fileBlob(f, false);
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function fileStatusText(f: ChatFile, progress?: number): string {
  const pct = progress !== undefined ? ` ${Math.floor(progress * 100)}%` : '';
  switch (f.status) {
    case 'sndStored':
      return 'waiting to upload';
    case 'sndUploading':
      return `uploading${pct}`;
    case 'sndComplete':
      return '';
    case 'sndCancelled':
      return 'deleted from the server';
    case 'sndError':
      return `not sent: ${f.error ?? 'error'}`;
    case 'rcvInvitation':
      return f.unknownServers?.length ? `on an unknown server (${f.unknownServers.join(', ')})` : '';
    case 'rcvAccepted':
      return 'waiting for the file…';
    case 'rcvTransfer':
      return `downloading${pct}`;
    case 'rcvComplete':
      return '';
    case 'rcvCancelled':
      return 'the sender deleted the file';
    case 'rcvError':
      return f.error ?? 'the download failed';
  }
}

const transferring = (f: ChatFile) => f.status === 'sndStored' || f.status === 'sndUploading' || f.status === 'rcvAccepted' || f.status === 'rcvTransfer';

/** downloads a received file, asking first when it is on a server the user does not use */
export function useReceive(session: Session, contactId: string, it: ChatItem): { receive: () => void; modal: JSX.Element | null } {
  const [servers, setServers] = useState<string[]>();
  const receive = (approve = false) =>
    session.chat.receiveFile(contactId, it.id, approve).catch((e) => {
      if (e instanceof FileApprovalError) setServers(e.servers);
      else toast(errorText(e), 'error');
    });
  const modal = servers ? (
    <Modal title="Download from an unknown server?" onClose={() => setServers(undefined)}>
      <p>
        The file is on <b>{servers.join(', ')}</b>, a file server that you do not use. Your relay connects to it from this computer, so the server can see your IP address and when you download the file. Everything in the file stays end-to-end encrypted.
      </p>
      <div class="row">
        <button onClick={() => setServers(undefined)}>Cancel</button>
        <button
          class="primary"
          onClick={() => {
            setServers(undefined);
            void receive(true);
          }}
        >
          Download
        </button>
      </div>
    </Modal>
  ) : null;
  return { receive: () => void receive(), modal };
}

function ProgressBar({ value }: { value?: number }): JSX.Element {
  return (
    <div class={`progress small ${value === undefined ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value !== undefined ? Math.round(value * 100) : undefined}>
      <div style={{ width: `${Math.round((value ?? 0.3) * 100)}%` }} />
    </div>
  );
}

/** the button over an image or video preview: download, progress or play */
function MediaOverlay({ f, progress, onDownload, onCancel, onPlay }: { f: ChatFile; progress?: number; onDownload: () => void; onCancel: () => void; onPlay?: () => void }): JSX.Element | null {
  if (f.status === 'rcvInvitation' || (f.status === 'rcvError' && !f.permanent))
    return (
      <button class="media-overlay" onClick={onDownload} aria-label={`Download (${fmtSize(f.size)})`} title={`Download (${fmtSize(f.size)})`}>
        <Icon name={f.status === 'rcvError' ? 'retry' : 'download'} size={22} />
        <span>{fmtSize(f.size)}</span>
      </button>
    );
  if (f.status === 'rcvAccepted' || f.status === 'rcvTransfer')
    return (
      <button class="media-overlay" onClick={onCancel} aria-label="Stop downloading" title="Stop downloading">
        <Spinner />
        <span>{progress !== undefined ? `${Math.floor(progress * 100)}%` : ''}</span>
      </button>
    );
  if (f.status === 'sndStored' || f.status === 'sndUploading')
    return (
      <div class="media-overlay passive" aria-label="uploading">
        <Spinner />
        <span>{progress !== undefined ? `${Math.floor(progress * 100)}%` : ''}</span>
      </div>
    );
  if (onPlay && hasContent(f))
    return (
      <button class="media-overlay" onClick={onPlay} aria-label="Play">
        <Icon name="play" size={24} />
      </button>
    );
  return null;
}

/** the file part of a message bubble */
export function FileContent({ session, contactId, it }: { session: Session; contactId: string; it: ChatItem }): JSX.Element | null {
  const chat = session.chat;
  const f = it.file;
  const c = it.content;
  const kind = c.type === 'image' ? 'image' : c.type === 'video' ? 'video' : c.type === 'voice' ? 'voice' : 'file';
  const [viewer, setViewer] = useState(false);
  const [play, setPlay] = useState(false);
  // only content that is what the message says it is gets shown in the page
  const showable = !!f && (kind === 'image' ? isImageType(f.mime) : kind === 'video' ? isVideoType(f.mime) : kind === 'voice');
  const url = useFileUrl(session, f, showable && (kind === 'image' || kind === 'voice' || (kind === 'video' && play)));
  const { receive, modal } = useReceive(session, contactId, it);
  if (!f) return null;
  const progress = chat.files.progress.get(f.id);
  const status = fileStatusText(f, progress);
  const cancel = () => chat.cancelDownload(contactId, it.id).catch((e) => toast(errorText(e), 'error'));
  const save = () => saveFile(session, f).catch((e) => toast(errorText(e), 'error'));
  const failed = f.status === 'sndError' || f.status === 'rcvError' || f.status === 'rcvCancelled' || f.status === 'sndCancelled';
  const preview = safeImage((c as { image?: unknown }).image);

  if ((kind === 'image' || kind === 'video') && preview) {
    const duration = kind === 'video' ? Number((c as { duration?: unknown }).duration) || 0 : 0;
    return (
      <div class="media">
        {kind === 'video' && play && url ? (
          <video class="msg-img" src={url} controls autoPlay playsInline preload="metadata" />
        ) : (
          <button class="media-img" onClick={() => (kind === 'image' && url ? setViewer(true) : kind === 'video' && showable && hasContent(f) ? setPlay(true) : undefined)} aria-label={kind === 'image' ? 'Open image' : 'Play video'} tabIndex={url || (showable && hasContent(f)) ? 0 : -1}>
            <img class={`msg-img ${url ? '' : 'preview'}`} src={url ?? preview} alt={c.text || (kind === 'image' ? 'image' : 'video')} />
          </button>
        )}
        {!(kind === 'video' && play) && <MediaOverlay f={f} progress={progress} onDownload={receive} onCancel={cancel} onPlay={kind === 'video' && showable ? () => setPlay(true) : undefined} />}
        {hasContent(f) && !showable && (
          <button class="media-save" onClick={save} aria-label="Save" title="This file is not an image or video that can be shown here: save it to open it">
            <Icon name="download" size={18} />
          </button>
        )}
        {kind === 'video' && !play && duration > 0 && <span class="media-badge">{fmtDuration(duration)}</span>}
        {status && <div class={`file-status ${failed ? 'err' : ''}`}>{status}</div>}
        {viewer && url && (
          <Modal title={f.name} onClose={() => setViewer(false)} wide>
            <div class="viewer">
              <img src={url} alt={c.text || 'image'} />
            </div>
            <div class="row">
              <button class="primary" onClick={save}>
                <Icon name="download" size={16} /> Save
              </button>
            </div>
          </Modal>
        )}
        {modal}
      </div>
    );
  }

  if (kind === 'voice' && url) {
    return (
      <div class="voice">
        <audio src={url} controls preload="metadata" />
      </div>
    );
  }

  return (
    <div class="file-row">
      <span class="file-icon">
        <Icon name={kind === 'voice' ? 'mic' : kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'file'} size={22} />
      </span>
      <span class="file-info">
        <span class="file-name">{kind === 'voice' ? `voice message${(c as { duration?: number }).duration ? ` (${fmtDuration(Number((c as { duration?: number }).duration))})` : ''}` : f.name}</span>
        <span class={`file-status ${failed ? 'err' : ''}`}>{[fmtSize(f.size), status].filter(Boolean).join(' · ')}</span>
        {transferring(f) && <ProgressBar value={f.status === 'rcvAccepted' || f.status === 'sndStored' ? undefined : progress} />}
      </span>
      {(f.status === 'rcvInvitation' || (f.status === 'rcvError' && !f.permanent)) && (
        <button class="icon-btn accent" onClick={receive} aria-label="Download" title="Download">
          <Icon name={f.status === 'rcvError' ? 'retry' : 'download'} />
        </button>
      )}
      {(f.status === 'rcvAccepted' || f.status === 'rcvTransfer') && (
        <button class="icon-btn" onClick={cancel} aria-label="Stop downloading" title="Stop downloading">
          <Icon name="close" />
        </button>
      )}
      {hasContent(f) && kind !== 'voice' && (
        <button class="icon-btn accent" onClick={save} aria-label="Save" title="Save">
          <Icon name="download" />
        </button>
      )}
      {f.status === 'sndError' && !f.permanent && (
        <button class="icon-btn accent" onClick={() => chat.retryFile(contactId, it.id).catch((e) => toast(errorText(e), 'error'))} aria-label="Try again" title="Try again">
          <Icon name="retry" />
        </button>
      )}
      {modal}
    </div>
  );
}

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---- files chosen to send

export interface Attachment {
  id: number;
  file: File;
  prepared?: OutgoingFile;
  error?: string;
}

let attId = 0;

/** prepares chosen files (images are resized and lose their metadata) */
export function useAttachments(): {
  atts: Attachment[];
  add: (files: Iterable<File>) => void;
  remove: (id: number) => void;
  clear: () => void;
  ready: boolean;
} {
  const [atts, setAtts] = useState<Attachment[]>([]);
  const add = (files: Iterable<File>) => {
    const list = [...files].slice(0, 10).map((file) => ({ id: ++attId, file }));
    if (!list.length) return;
    setAtts((a) => [...a, ...list].slice(0, 10));
    for (const a of list) {
      prepareOutgoing(a.file)
        .then((prepared) => setAtts((x) => x.map((y) => (y.id === a.id ? { ...y, prepared } : y))))
        .catch((e) => setAtts((x) => x.map((y) => (y.id === a.id ? { ...y, error: errorText(e) } : y))));
    }
  };
  return {
    atts,
    add,
    remove: (id) => setAtts((a) => a.filter((x) => x.id !== id)),
    clear: () => setAtts([]),
    ready: atts.length > 0 && atts.every((a) => a.prepared || a.error),
  };
}

export function AttachmentStrip({ atts, onRemove }: { atts: Attachment[]; onRemove: (id: number) => void }): JSX.Element | null {
  if (!atts.length) return null;
  return (
    <div class="attachments" aria-label="Files to send">
      {atts.map((a) => {
        const p = a.prepared;
        const thumb = p?.kind !== 'file' ? safeImage(p?.preview) : undefined;
        return (
          <div class={`att ${a.error ? 'err' : ''}`} key={a.id} title={a.error ?? a.file.name}>
            {thumb ? (
              <img src={thumb} alt="" />
            ) : (
              <span class="att-file">
                {p ? <Icon name="file" size={20} /> : <Spinner />}
                <span class="att-name">{a.file.name}</span>
              </span>
            )}
            {p?.kind === 'video' && <span class="media-badge">{fmtDuration(p.duration ?? 0)}</span>}
            <span class="att-size">{fmtSize(p?.blob.size ?? a.file.size)}</span>
            <button class="att-remove" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.file.name}`}>
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
