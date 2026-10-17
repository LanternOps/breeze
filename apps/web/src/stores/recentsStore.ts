import { create } from 'zustand';

/**
 * Recently opened devices and recently visited pages, per signed-in user.
 *
 * Client-only. Persisted to localStorage under a key that includes the user id
 * so a shared browser never shows one account's device names to another. The
 * in-memory lists are emptied on logout (`hydrate(null)`); the on-disk copy for
 * that user stays so their next sign-in on the same browser restores it.
 *
 * Writers no-op until `hydrate(userId)` has run — the `GlobalShortcuts` island
 * mounted by DashboardLayout does that from the auth store. Readers (sidebar
 * Recent group, dashboard card, command palette) call `useRecentsStore` like any other store.
 */

export const MAX_RECENT_DEVICES = 10;
export const MAX_RECENT_PAGES = 10;

export interface RecentDevice {
  id: string;
  /** displayName || hostname at the time it was opened. */
  name: string;
  orgId?: string;
  openedAt: number;
}

export interface RecentPage {
  /** pathname + search, no hash. */
  path: string;
  /** The page's own title ("Quote", "Organization"). */
  title: string;
  /** The item a detail page shows ("Q-0042 Acme firewall"), once it has loaded. */
  name?: string;
  visitedAt: number;
}

export interface RecentsState {
  userId: string | null;
  devices: RecentDevice[];
  pages: RecentPage[];
  hydrate: (userId: string | null) => void;
  recordDevice: (device: { id: string; name: string; orgId?: string }) => void;
  forgetDevice: (id: string) => void;
  recordPage: (page: { path: string; title: string }) => void;
  /** Attach the displayed item's name to a detail page (see `usePageItemName`). */
  namePage: (path: string, name: string) => void;
  /** A name reported before its page visit was recorded; applied by `recordPage`. Not persisted. */
  pendingPageName: { path: string; name: string } | null;
}

const STORAGE_PREFIX = 'breeze.recents.';

export function recentsStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

// Paths whose visit is not worth remembering: auth surfaces, and device detail
// pages (those are tracked as recent DEVICES, with the device's own name).
const EXCLUDED_PREFIXES = ['/login', '/logout', '/auth/', '/register', '/reset-password', '/verify'];
const DEVICE_DETAIL = /^\/devices\/[^/]+$/;
const DEVICE_STATIC_SUBPAGES = new Set(['/devices/groups', '/devices/compare', '/devices/posture', '/devices/unassigned']);

export function isRecordablePagePath(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return false;
  if (DEVICE_DETAIL.test(path) && !DEVICE_STATIC_SUBPAGES.has(path)) return false;
  return true;
}

type Persisted = { devices: RecentDevice[]; pages: RecentPage[] };

function readPersisted(userId: string): Persisted {
  const empty: Persisted = { devices: [], pages: [] };
  try {
    const raw = localStorage.getItem(recentsStorageKey(userId));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Persisted> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const devices = (Array.isArray(parsed.devices) ? parsed.devices : [])
      .filter(
        (d): d is RecentDevice =>
          !!d && typeof d === 'object' && typeof d.id === 'string' && typeof d.name === 'string',
      )
      .slice(0, MAX_RECENT_DEVICES);
    const pages = (Array.isArray(parsed.pages) ? parsed.pages : [])
      .filter(
        (p): p is RecentPage =>
          !!p && typeof p === 'object' && typeof p.path === 'string' && typeof p.title === 'string',
      )
      .map((p) => (p.name === undefined || typeof p.name === 'string' ? p : { ...p, name: undefined }))
      .slice(0, MAX_RECENT_PAGES);
    return { devices, pages };
  } catch {
    return empty;
  }
}

function writePersisted(userId: string, data: Persisted): void {
  try {
    localStorage.setItem(recentsStorageKey(userId), JSON.stringify(data));
  } catch {
    /* Storage unavailable (private mode, quota) — recents are a convenience. */
  }
}

export const useRecentsStore = create<RecentsState>()((set, get) => ({
  userId: null,
  devices: [],
  pages: [],
  pendingPageName: null,

  hydrate: (userId) => {
    if (userId === get().userId && userId !== null) return;
    if (userId === null) {
      set({ userId: null, devices: [], pages: [], pendingPageName: null });
      return;
    }
    const { devices, pages } = readPersisted(userId);
    set({ userId, devices, pages });
  },

  recordDevice: ({ id, name, orgId }) => {
    const { userId, devices, pages } = get();
    if (!userId || !id) return;
    const entry: RecentDevice = { id, name: name || id, orgId, openedAt: Date.now() };
    const next = [entry, ...devices.filter((d) => d.id !== id)].slice(0, MAX_RECENT_DEVICES);
    set({ devices: next });
    writePersisted(userId, { devices: next, pages });
  },

  forgetDevice: (id) => {
    const { userId, devices, pages } = get();
    if (!userId) return;
    const next = devices.filter((d) => d.id !== id);
    if (next.length === devices.length) return;
    set({ devices: next });
    writePersisted(userId, { devices: next, pages });
  },

  recordPage: ({ path, title }) => {
    const { userId, devices, pages, pendingPageName } = get();
    if (!userId || !path || !isRecordablePagePath(path.split('?')[0])) return;
    // The path carries the item id, so a revisit shows the same item: keep its name.
    const name = pendingPageName?.path === path ? pendingPageName.name : pages.find((p) => p.path === path)?.name;
    const entry: RecentPage = { path, title: title || path, visitedAt: Date.now(), ...(name ? { name } : {}) };
    const next = [entry, ...pages.filter((p) => p.path !== path)].slice(0, MAX_RECENT_PAGES);
    set({ pages: next, pendingPageName: null });
    writePersisted(userId, { devices, pages: next });
  },

  namePage: (path, name) => {
    const { userId, devices, pages } = get();
    const trimmed = name.trim();
    if (!userId || !path || !trimmed) return;
    if (!pages.some((p) => p.path === path)) {
      set({ pendingPageName: { path, name: trimmed } });
      return;
    }
    const next = pages.map((p) => (p.path === path ? { ...p, name: trimmed } : p));
    set({ pages: next });
    writePersisted(userId, { devices, pages: next });
  },
}));

export type RecentEntryKind = 'device' | 'org' | 'ticket' | 'alert' | 'site' | 'page';

export interface RecentEntry {
  kind: RecentEntryKind;
  href: string;
  label: string;
  at: number;
}

export const DEFAULT_RECENT_ENTRY_LIMIT = 10;

const RECORD_KIND_PATTERNS: Array<[RegExp, RecentEntryKind]> = [
  [/^\/organizations\/[^/]+$/, 'org'],
  [/^\/tickets\/[^/]+$/, 'ticket'],
  [/^\/alerts\/[^/]+$/, 'alert'],
  [/^\/settings\/sites\/[^/]+$/, 'site'],
];

function kindFromPath(path: string): RecentEntryKind {
  const pathname = path.split('?')[0];
  return RECORD_KIND_PATTERNS.find(([re]) => re.test(pathname))?.[1] ?? 'page';
}

/**
 * One recency-ordered list of recently opened things: devices plus pages that
 * carry an item name (hub/list pages have none and are never listed). The page
 * currently open (matched by pathname) is excluded.
 */
export function selectRecentEntries(
  state: Pick<RecentsState, 'devices' | 'pages'>,
  currentPath: string,
  limit: number = DEFAULT_RECENT_ENTRY_LIMIT,
): RecentEntry[] {
  const current = currentPath.split('?')[0];
  const entries: RecentEntry[] = [];
  for (const d of state.devices) {
    entries.push({ kind: 'device', href: `/devices/${d.id}`, label: d.name, at: d.openedAt });
  }
  for (const p of state.pages) {
    const label = p.name?.trim();
    if (!label) continue;
    entries.push({ kind: kindFromPath(p.path), href: p.path, label, at: p.visitedAt });
  }
  const seen = new Set<string>();
  return entries
    .filter((e) => e.href.split('?')[0] !== current)
    .sort((a, b) => b.at - a.at)
    .filter((e) => (seen.has(e.href) ? false : (seen.add(e.href), true)))
    .slice(0, limit);
}
