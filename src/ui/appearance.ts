// Appearance: the theme, the accent colour and the icon pack. They are kept in this browser outside
// the encrypted data (localStorage), so that the lock screen uses them too; "Delete all data" removes
// them. Themes are sets of CSS variables (styles.css); the icon packs other than the default are
// loaded when chosen.
import { DEFAULT_ICON_PACK, type IconPack } from './icons';

export type ThemeId = 'light' | 'dark' | 'simplex' | 'black' | 'sepia' | 'contrast';
export type DarkThemeId = 'dark' | 'simplex' | 'black';
export type AccentId = 'theme' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'green' | 'teal';
export type IconPackId = 'lucide' | 'tabler' | 'phosphor' | 'phosphor-fill' | 'material' | 'bootstrap' | 'remix';

export interface Appearance {
  /** a theme, or light and dark as the system is */
  theme: 'system' | ThemeId;
  /** the dark theme when following the system */
  dark: DarkThemeId;
  accent: AccentId;
  icons: IconPackId;
}

export const THEMES: ReadonlyArray<{ id: ThemeId; name: string; dark: boolean; note?: string }> = [
  { id: 'light', name: 'Light', dark: false },
  { id: 'dark', name: 'Dark', dark: true },
  { id: 'simplex', name: 'SimpleX', dark: true, note: 'the navy theme of the apps' },
  { id: 'black', name: 'Black', dark: true, note: 'for OLED screens' },
  { id: 'sepia', name: 'Sepia', dark: false, note: 'warm, with less blue light' },
  { id: 'contrast', name: 'High contrast', dark: false, note: 'black on white, stronger borders' },
];

export const ACCENTS: ReadonlyArray<{ id: AccentId; name: string }> = [
  { id: 'theme', name: 'Theme colour' },
  { id: 'blue', name: 'Blue' },
  { id: 'purple', name: 'Purple' },
  { id: 'pink', name: 'Pink' },
  { id: 'red', name: 'Red' },
  { id: 'orange', name: 'Orange' },
  { id: 'green', name: 'Green' },
  { id: 'teal', name: 'Teal' },
];

export const ICON_PACKS: ReadonlyArray<{ id: IconPackId; name: string; license: string; url: string }> = [
  { id: 'lucide', name: 'Lucide', license: 'ISC', url: 'https://lucide.dev' },
  { id: 'tabler', name: 'Tabler Icons', license: 'MIT', url: 'https://tabler.io/icons' },
  { id: 'phosphor', name: 'Phosphor', license: 'MIT', url: 'https://phosphoricons.com' },
  { id: 'phosphor-fill', name: 'Phosphor Fill', license: 'MIT', url: 'https://phosphoricons.com' },
  { id: 'material', name: 'Material Symbols', license: 'Apache-2.0', url: 'https://fonts.google.com/icons' },
  { id: 'bootstrap', name: 'Bootstrap Icons', license: 'MIT', url: 'https://icons.getbootstrap.com' },
  { id: 'remix', name: 'Remix Icon', license: 'Apache-2.0', url: 'https://remixicon.com' },
];

const KEY = 'duplex-appearance';
const DEFAULTS: Appearance = { theme: 'system', dark: 'dark', accent: 'theme', icons: 'lucide' };

const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);

function sanitize(v: Partial<Record<keyof Appearance, unknown>>): Appearance {
  const themes = THEMES.map((t) => t.id);
  return {
    theme: pick(v.theme, ['system', ...themes] as const, DEFAULTS.theme),
    dark: pick(v.dark, ['dark', 'simplex', 'black'] as const, DEFAULTS.dark),
    accent: pick(v.accent, ACCENTS.map((a) => a.id), DEFAULTS.accent),
    icons: pick(v.icons, ICON_PACKS.map((p) => p.id), DEFAULTS.icons),
  };
}

function load(): Appearance {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {});
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();
let pack: IconPack = DEFAULT_ICON_PACK;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const appearance = (): Appearance => current;
export const iconPack = (): IconPack => pack;

/** called when the appearance changes (also when the system switches between light and dark) */
export function onAppearance(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function importPack(id: IconPackId): Promise<IconPack> {
  const m = (p: Promise<{ default: IconPack }>) => p.then((x) => x.default);
  switch (id) {
    case 'tabler':
      return m(import('./iconpacks/tabler'));
    case 'phosphor':
      return m(import('./iconpacks/phosphor'));
    case 'phosphor-fill':
      return m(import('./iconpacks/phosphor-fill'));
    case 'material':
      return m(import('./iconpacks/material'));
    case 'bootstrap':
      return m(import('./iconpacks/bootstrap'));
    case 'remix':
      return m(import('./iconpacks/remix'));
    default:
      return Promise.resolve(DEFAULT_ICON_PACK);
  }
}

const cache: Partial<Record<IconPackId, IconPack>> = { lucide: DEFAULT_ICON_PACK };

export async function loadIconPack(id: IconPackId): Promise<IconPack> {
  return (cache[id] ??= await importPack(id));
}

/** the packs loaded already, shown at once */
export const loadedIconPacks = (): Partial<Record<IconPackId, IconPack>> => ({ ...cache });

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;

/** the theme shown now */
export const shownTheme = (a: Appearance = current): ThemeId => (a.theme === 'system' ? (darkQuery?.matches ? a.dark : 'light') : a.theme);

function apply(): void {
  const root = document.documentElement;
  const theme = shownTheme();
  root.dataset.theme = theme;
  root.dataset.scheme = THEMES.find((t) => t.id === theme)?.dark ? 'dark' : 'light';
  if (current.accent === 'theme') delete root.dataset.accent;
  else root.dataset.accent = current.accent;
  // the colour of the browser's own bars around the page, where browsers use it
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#ffffff';
}

darkQuery?.addEventListener('change', () => {
  if (current.theme !== 'system') return;
  apply();
  notify();
});

/** before the first render: the theme, and the chosen icon pack */
export async function initAppearance(): Promise<void> {
  apply();
  if (current.icons !== DEFAULTS.icons) pack = await loadIconPack(current.icons).catch(() => DEFAULT_ICON_PACK);
}

export async function setAppearance(patch: Partial<Appearance>): Promise<void> {
  const next = sanitize({ ...current, ...patch });
  // the pack is loaded before it is used
  const nextPack = next.icons !== current.icons ? await loadIconPack(next.icons) : pack;
  current = next;
  pack = nextPack;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage is unavailable: this page keeps the choice
  }
  apply();
  notify();
}

/** "Delete all data": back to the defaults */
export function resetAppearance(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  current = { ...DEFAULTS };
  pack = DEFAULT_ICON_PACK;
  apply();
  notify();
}
