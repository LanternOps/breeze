// Per-device viewer preferences (#8241): Cmd↔Ctrl remap, view scaling and
// remote audio, remembered per device id on THIS machine through the Tauri
// store plugin (a JSON file in the viewer's app-data folder). Never sent to
// the API. Every read and write is best-effort: a missing, corrupt or
// unreadable store means defaults, and a failed write is logged and dropped.
//
// Keyboard mode (text vs physical) is not remembered yet: it does not exist
// until W6.

import { isViewScaling, type ViewScaling } from './displayScaling';

export interface DevicePrefs {
  remapCmdCtrl?: boolean;
  viewScaling?: ViewScaling;
  audio?: boolean;
}

/** The subset of the Tauri Store API used here, so tests can swap it. */
export interface PrefsStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const STORE_FILE = 'viewer-prefs.json';
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Log = (message: string) => void;
const defaultLog: Log = (m) => console.warn('[devicePrefs]', m);

export function devicePrefsKey(deviceId: string | undefined | null): string | null {
  return deviceId && DEVICE_ID.test(deviceId) ? `device:${deviceId}` : null;
}

export function sanitizeDevicePrefs(raw: unknown): DevicePrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: DevicePrefs = {};
  if (typeof r.remapCmdCtrl === 'boolean') out.remapCmdCtrl = r.remapCmdCtrl;
  if (isViewScaling(r.viewScaling)) out.viewScaling = r.viewScaling;
  if (typeof r.audio === 'boolean') out.audio = r.audio;
  return out;
}

export async function loadDevicePrefs(
  store: PrefsStore | null,
  deviceId: string | undefined | null,
  log: Log = defaultLog,
): Promise<DevicePrefs> {
  const key = devicePrefsKey(deviceId);
  if (!store || !key) return {};
  try {
    return sanitizeDevicePrefs(await store.get(key));
  } catch (err) {
    log(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Merges `patch` into what is stored for the device. */
export async function saveDevicePrefs(
  store: PrefsStore | null,
  deviceId: string | undefined | null,
  patch: DevicePrefs,
  log: Log = defaultLog,
): Promise<void> {
  const key = devicePrefsKey(deviceId);
  if (!store || !key) return;
  try {
    const current = sanitizeDevicePrefs(await store.get(key));
    await store.set(key, { ...current, ...sanitizeDevicePrefs(patch) });
  } catch (err) {
    log(`write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createMemoryPrefsStore(initial: Record<string, unknown> = {}): PrefsStore {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value); },
  };
}

let tauriStore: Promise<PrefsStore | null> | null = null;

/**
 * The viewer's prefs store, shared by every session window (the plugin hands
 * back the same store for the same file). Null when the plugin is unavailable.
 */
export function getTauriPrefsStore(log: Log = defaultLog): Promise<PrefsStore | null> {
  if (!tauriStore) {
    tauriStore = import('@tauri-apps/plugin-store')
      .then(({ load }) => load(STORE_FILE, { defaults: {}, autoSave: 200 }))
      .then((store): PrefsStore => ({
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
      }))
      .catch((err) => {
        log(`store unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
  }
  return tauriStore;
}
