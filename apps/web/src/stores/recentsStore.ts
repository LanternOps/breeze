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
 * mounted by DashboardLayout does that from the auth store. Readers (sidebar,
 * command palette) call `useRecentsStore` like any other store.
 */

export const MAX_RECENT_DEVICES = 5;
export const MAX_RECENT_PAGES = 8;

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
  title: string;
  visitedAt: number;
}

interface RecentsState {
  userId: string | null;
  devices: RecentDevice[];
  pages: RecentPage[];
  hydrate: (userId: string | null) => void;
  recordDevice: (device: { id: string; name: string; orgId?: string }) => void;
  forgetDevice: (id: string) => void;
  recordPage: (page: { path: string; title: string }) => void;
}

const STORAGE_PREFIX = 'breeze.recents.';

export function recentsStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

// Paths whose visit is not worth remembering: auth surfaces, and device detail
// pages (those are tracked as recent DEVICES, with the device's own name).
const EXCLUDED_PREFIXES = ['/login', '/logout', '/auth/', '/register', '/reset-password', '/verify'];
const DEVICE_DETAIL = /^\/devices\/[^/]+$/;
const DEVICE_STATIC_SUBPAGES = new Set(['/devices/groups', '/devices/compare', '/devices/posture']);

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

  hydrate: (userId) => {
    if (userId === get().userId && userId !== null) return;
    if (userId === null) {
      set({ userId: null, devices: [], pages: [] });
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
    const { userId, devices, pages } = get();
    if (!userId || !path || !isRecordablePagePath(path.split('?')[0])) return;
    const entry: RecentPage = { path, title: title || path, visitedAt: Date.now() };
    const next = [entry, ...pages.filter((p) => p.path !== path)].slice(0, MAX_RECENT_PAGES);
    set({ pages: next });
    writePersisted(userId, { devices, pages: next });
  },
}));
