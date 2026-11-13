// Small shared UI components.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './icons';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }): JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }): JSX.Element {
  return (
    <label class="toggle-row">
      <span>
        <span class="toggle-label">{label}</span>
        {hint && <span class="hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

export type Toast = { id: number; text: string; kind: 'info' | 'error' };

let toastId = 0;
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  pushToast({ text, kind });
}

export function Toasts(): JSX.Element {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const item = { ...t, id: ++toastId };
      setList((l) => [...l.slice(-3), item]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== item.id)), t.kind === 'error' ? 7000 : 3500);
    };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span class="spinner-wrap">
      <span class="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/AUTH/.test(m)) return 'the link was already used or deleted';
  if (/timed out|timeout/i.test(m)) return 'the server did not respond in time — check the network settings';
  if (/relay/i.test(m)) return m;
  return m;
}
