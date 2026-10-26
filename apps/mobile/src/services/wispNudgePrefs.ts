import { coreRequest } from './api';

/**
 * Wisp (W06c). Per-USER Wisp nudge preferences.
 *
 * Like the ticket push preferences these follow the person across every phone
 * they sign in on. The types are declared locally rather than imported from
 * `@breeze/shared`: the mobile app has no dependency on the shared package
 * (see `ticketPushPrefs.ts`). The wire contract is `{ data: { settings } }`
 * and the API route tests own it on the server side.
 */
export type WispQuietOverride = 'never' | 'urgent_only';
export type WispProactivity = 'quiet' | 'normal' | 'chatty';

export interface WispNudgePreferences {
  channels: { inApp: boolean; push: boolean };
  quietOverride: WispQuietOverride;
  /** Server accepts integers 15..1440. */
  digestCadenceMinutes: number;
  /** 'HH:MM' 24h; null = morning brief off. */
  briefTimeLocal: string | null;
  /** IANA zone; null = server picks the device timezone / UTC. */
  briefTimezone: string | null;
  proactivity: WispProactivity;
}

/** Mirrors the server-side Wisp nudge preference defaults. */
export const WISP_NUDGE_PREFERENCE_DEFAULTS: WispNudgePreferences = Object.freeze({
  channels: Object.freeze({ inApp: true, push: true }),
  quietOverride: 'never',
  digestCadenceMinutes: 240,
  briefTimeLocal: '08:00',
  briefTimezone: null,
  proactivity: 'normal',
});

/**
 * Caller sends at least one key. `channels`, when sent, is the COMPLETE object:
 * the server schema is `.partial().strict()` over a full channels object, so a
 * half-built `channels` is a 400.
 */
export type UpdateWispNudgePreferences = Partial<WispNudgePreferences>;

const QUIET_OVERRIDES: readonly WispQuietOverride[] = ['never', 'urgent_only'];
const PROACTIVITIES: readonly WispProactivity[] = ['quiet', 'normal', 'chatty'];
const BRIEF_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Normalise whatever came back onto the settings the UI renders, defaulting
 * each key independently. Defence against a truncated or older-shaped body:
 * without it a missing field renders as an unchecked switch and the next tap
 * PUTs a change the person never intended.
 */
function normalize(raw: unknown): WispNudgePreferences {
  const d = WISP_NUDGE_PREFERENCE_DEFAULTS;
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ch = (s.channels && typeof s.channels === 'object' ? s.channels : {}) as Record<
    string,
    unknown
  >;
  const cadence = s.digestCadenceMinutes;
  const tz = s.briefTimezone;
  return {
    channels: {
      inApp: typeof ch.inApp === 'boolean' ? ch.inApp : d.channels.inApp,
      push: typeof ch.push === 'boolean' ? ch.push : d.channels.push,
    },
    quietOverride: QUIET_OVERRIDES.includes(s.quietOverride as WispQuietOverride)
      ? (s.quietOverride as WispQuietOverride)
      : d.quietOverride,
    digestCadenceMinutes:
      typeof cadence === 'number' && Number.isInteger(cadence) && cadence >= 15 && cadence <= 1440
        ? cadence
        : d.digestCadenceMinutes,
    // An explicit null is a real value ("Off"), not a missing field.
    briefTimeLocal:
      s.briefTimeLocal === null
        ? null
        : typeof s.briefTimeLocal === 'string' && BRIEF_TIME.test(s.briefTimeLocal)
          ? s.briefTimeLocal
          : d.briefTimeLocal,
    briefTimezone:
      typeof tz === 'string' && tz.length > 0 && tz.length <= 64 ? tz : null,
    proactivity: PROACTIVITIES.includes(s.proactivity as WispProactivity)
      ? (s.proactivity as WispProactivity)
      : d.proactivity,
  };
}

interface SettingsBody {
  data?: { settings?: unknown };
}

/**
 * A body without an object at `data.settings` is contract drift, not "nothing
 * saved yet" (the route answers defaults itself for a user with no row).
 * Throwing keeps defaults from being shown — or adopted after a save — as if
 * they were the user's stored values. Per-KEY gaps are still defaulted.
 */
function settingsOf(res: SettingsBody | undefined): unknown {
  const settings = res?.data?.settings;
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('wisp nudge preferences payload malformed');
  }
  return settings;
}

/** `coreRequest`, not `request`: the route is on the core `/api/v1` surface. */
export async function getWispNudgePrefs(): Promise<WispNudgePreferences> {
  const res = await coreRequest<SettingsBody>('/wisp/nudge-preferences');
  return normalize(settingsOf(res));
}

/** Send only the keys that changed; the server schema is `.strict()`. */
export async function updateWispNudgePrefs(
  patch: UpdateWispNudgePreferences
): Promise<WispNudgePreferences> {
  if (Object.keys(patch).length === 0) {
    throw new Error('updateWispNudgePrefs requires at least one key');
  }
  const res = await coreRequest<SettingsBody>('/wisp/nudge-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return normalize(settingsOf(res));
}
