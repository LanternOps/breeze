/**
 * Agent update policy resolution (pure logic).
 *
 * The org-level update settings (Org > General) govern whether heartbeat may
 * hand an agent/watchdog an automatic update target:
 *
 *   - `manual`           → never auto-upgrade or auto-heal
 *   - `automatic`/`asap` → upgrade whenever a newer allowed target exists
 *   - `automatic`/`weekly` → upgrade only during selected weekly windows
 *
 * Backward compatibility: legacy `agentUpdatePolicy` / `maintenanceWindow`
 * values are still read and normalized into the structured shape below. The
 * old `staged` label was not a real staged rollout; it only gated automatic
 * updates on a free-text maintenance window.
 *
 * Timezone note: the org `maintenanceWindow` is a free-form string with no
 * timezone component (e.g. "Sun 02:00-04:00"), so it is evaluated against UTC
 * server time. New structured schedules are also evaluated against UTC.
 *
 * This module is pure and side-effect free so it can be unit tested without a
 * database. The DB read lives in `getOrgAgentUpdatePolicy` (helpers.ts).
 */

export type AgentUpdatePolicy = 'auto' | 'staged' | 'manual';
export type AgentUpdateMode = 'automatic' | 'manual';
export type AgentUpdateTiming = 'asap' | 'weekly';
export type AgentUpdateDayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface AgentUpdateScheduleWindow {
  dayOfWeek: AgentUpdateDayOfWeek;
  start: string;
  end: string;
}

export interface AgentUpdateSchedule {
  windows: AgentUpdateScheduleWindow[];
}

export interface AgentUpdateSettings {
  mode: AgentUpdateMode;
  timing: AgentUpdateTiming;
  schedule: AgentUpdateSchedule | null;
  pins: {
    agent?: string;
    watchdog?: string;
  };
  legacyPolicy: AgentUpdatePolicy | null;
  legacyMaintenanceWindow: string | null;
  legacyWindowInvalid: boolean;
}

export interface LegacyAgentUpdateSettings {
  policy: AgentUpdatePolicy;
  maintenanceWindow: string | null;
}

export interface AgentUpdateGate {
  allow: boolean;
  reason: 'allowed' | 'manual-approval' | 'outside-schedule';
}

const DAY_OF_WEEK: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAY_KEYS: AgentUpdateDayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const STRUCTURED_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VERSION_PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DEFAULT_WEEKLY_SCHEDULE: AgentUpdateSchedule = {
  windows: [{ dayOfWeek: 'sun', start: '02:00', end: '04:00' }],
};

interface ParsedWindow {
  /** UTC day-of-week the window starts on (0=Sun), or null for "any day" (daily). */
  day: number | null;
  /** Minutes-since-midnight the window opens. */
  startMin: number;
  /** Minutes-since-midnight the window closes. */
  endMin: number;
}

/**
 * Coerce an arbitrary stored value into a known policy. Unknown / absent values
 * default to `staged` to match the UI default; combined with an absent
 * maintenance window this is permissive (upgrade anytime), which preserves the
 * pre-existing behaviour for orgs that never set the policy.
 */
export function normalizeAgentUpdatePolicy(raw: unknown): AgentUpdatePolicy {
  if (raw === 'auto' || raw === 'staged' || raw === 'manual') return raw;
  return 'staged';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersionPin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function minutesToTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function addMinutesToTime(time: string, minutes: number): string {
  const match = time.match(STRUCTURED_TIME_RE);
  if (!match) return time;
  return minutesToTime(Number(match[1]) * 60 + Number(match[2]) + minutes);
}

function parseScheduleWindow(raw: unknown): AgentUpdateScheduleWindow | null {
  if (!isObject(raw)) return null;
  const rawDay = raw.dayOfWeek;
  const rawStart = raw.start ?? raw.time;
  const rawEnd = raw.end ?? (typeof rawStart === 'string' ? addMinutesToTime(rawStart, 60) : undefined);
  if (typeof rawDay !== 'string' || typeof rawStart !== 'string' || typeof rawEnd !== 'string') {
    return null;
  }
  const day = rawDay.toLowerCase();
  if (!DAY_KEYS.includes(day as AgentUpdateDayOfWeek)) return null;
  if (!STRUCTURED_TIME_RE.test(rawStart) || !STRUCTURED_TIME_RE.test(rawEnd)) return null;
  if (rawStart === rawEnd) return null;
  return {
    dayOfWeek: day as AgentUpdateDayOfWeek,
    start: rawStart,
    end: rawEnd,
  };
}

function parseStructuredSchedule(raw: unknown): AgentUpdateSchedule | null {
  if (!isObject(raw)) return null;
  if (Array.isArray(raw.windows)) {
    const windows = raw.windows
      .map(parseScheduleWindow)
      .filter((window): window is AgentUpdateScheduleWindow => window !== null);
    return windows.length > 0 ? { windows } : null;
  }
  const legacyWindow = parseScheduleWindow(raw);
  return legacyWindow ? { windows: [legacyWindow] } : null;
}

function scheduleFromLegacyWindow(raw: string | null): AgentUpdateSchedule | null {
  const parsed = parseMaintenanceWindow(raw);
  if (!parsed) return null;
  const start = minutesToTime(parsed.startMin);
  const end = minutesToTime(parsed.endMin);
  if (parsed.day === null) {
    return {
      windows: DAY_KEYS.map((dayOfWeek) => ({ dayOfWeek, start, end })),
    };
  }
  const dayOfWeek = DAY_KEYS[parsed.day];
  return dayOfWeek ? { windows: [{ dayOfWeek, start, end }] } : null;
}

export function normalizeAgentUpdateSettings(defaultsRaw: unknown): AgentUpdateSettings {
  const defaults = isObject(defaultsRaw) ? defaultsRaw : {};

  const legacyPolicy =
    defaults.agentUpdatePolicy === 'auto' ||
    defaults.agentUpdatePolicy === 'staged' ||
    defaults.agentUpdatePolicy === 'manual'
      ? defaults.agentUpdatePolicy
      : null;
  const legacyMaintenanceWindow =
    typeof defaults.maintenanceWindow === 'string' && defaults.maintenanceWindow.trim()
      ? defaults.maintenanceWindow.trim()
      : null;
  const legacySchedule = scheduleFromLegacyWindow(legacyMaintenanceWindow);
  const legacyWindowInvalid = legacyMaintenanceWindow !== null && legacySchedule === null;

  const rawMode = defaults.agentUpdateMode;
  const mode: AgentUpdateMode =
    rawMode === 'automatic' || rawMode === 'manual'
      ? rawMode
      : legacyPolicy === 'manual'
        ? 'manual'
        : 'automatic';

  const rawTiming = defaults.agentUpdateTiming;
  const explicitSchedule = parseStructuredSchedule(defaults.agentUpdateSchedule);
  const timing: AgentUpdateTiming =
    mode === 'manual'
      ? 'asap'
      : rawTiming === 'weekly'
        ? 'weekly'
        : rawTiming === 'asap'
          ? 'asap'
          : legacyPolicy === 'auto' || legacySchedule
            ? 'weekly'
            : 'asap';

  const pins = isObject(defaults.agentVersionPins) ? defaults.agentVersionPins : {};
  return {
    mode,
    timing,
    schedule: timing === 'weekly' ? (explicitSchedule ?? legacySchedule ?? DEFAULT_WEEKLY_SCHEDULE) : null,
    pins: {
      ...(normalizeVersionPin(pins.agent) ? { agent: normalizeVersionPin(pins.agent) } : {}),
      ...(normalizeVersionPin(pins.watchdog) ? { watchdog: normalizeVersionPin(pins.watchdog) } : {}),
    },
    legacyPolicy,
    legacyMaintenanceWindow,
    legacyWindowInvalid,
  };
}

export function validateAgentUpdateDefaults(defaultsRaw: unknown): string | null {
  if (!isObject(defaultsRaw)) return null;

  if (
    defaultsRaw.agentUpdateMode !== undefined &&
    defaultsRaw.agentUpdateMode !== 'automatic' &&
    defaultsRaw.agentUpdateMode !== 'manual'
  ) {
    return 'agentUpdateMode must be automatic or manual';
  }
  if (
    defaultsRaw.agentUpdateTiming !== undefined &&
    defaultsRaw.agentUpdateTiming !== 'asap' &&
    defaultsRaw.agentUpdateTiming !== 'weekly'
  ) {
    return 'agentUpdateTiming must be asap or weekly';
  }
  if (defaultsRaw.agentUpdateTiming === 'weekly' || defaultsRaw.agentUpdateSchedule !== undefined) {
    if (!parseStructuredSchedule(defaultsRaw.agentUpdateSchedule)) {
      return 'agentUpdateSchedule must include at least one window with dayOfWeek, start, and end in HH:MM format';
    }
  }
  if (defaultsRaw.agentVersionPins !== undefined) {
    if (!isObject(defaultsRaw.agentVersionPins)) {
      return 'agentVersionPins must be an object';
    }
    for (const key of ['agent', 'watchdog'] as const) {
      const raw = defaultsRaw.agentVersionPins[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string' || !VERSION_PIN_RE.test(raw.trim())) {
        return `agentVersionPins.${key} must be a valid version string`;
      }
    }
  }
  return null;
}

/**
 * Parse a maintenance window string of the form "Sun 02:00-04:00" (optional
 * 3-letter day prefix; "02:00-04:00" means daily). Returns null when the input
 * is empty or malformed — callers treat null as "no time restriction".
 */
export function parseMaintenanceWindow(raw: string | null | undefined): ParsedWindow | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^(?:([A-Za-z]{3})\s+)?(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const [, dayStr, sh, sm, eh, em] = m;
  let day: number | null = null;
  if (dayStr) {
    const d = DAY_OF_WEEK[dayStr.toLowerCase()];
    if (d === undefined) return null;
    day = d;
  }

  const startH = Number(sh), startM = Number(sm), endH = Number(eh), endM = Number(em);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;

  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin === endMin) return null; // zero-length window is meaningless

  return { day, startMin, endMin };
}

/**
 * Whether `now` (evaluated in UTC) falls inside the maintenance window. A null /
 * empty / malformed window means "no restriction" → always true (fail open).
 * Windows that wrap past midnight (start > end) are supported.
 */
export function isWithinMaintenanceWindow(raw: string | null | undefined, now: Date): boolean {
  const parsed = parseMaintenanceWindow(raw);
  if (!parsed) return true;

  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowDay = now.getUTCDay();
  const { day, startMin, endMin } = parsed;

  if (startMin < endMin) {
    // Same-day window, e.g. 02:00-04:00.
    if (day !== null && day !== nowDay) return false;
    return nowMin >= startMin && nowMin < endMin;
  }

  // Wraps past midnight, e.g. 22:00-02:00 → [start,24:00) today + [00:00,end) tomorrow.
  if (day === null) {
    return nowMin >= startMin || nowMin < endMin;
  }
  const nextDay = (day + 1) % 7;
  if (nowDay === day) return nowMin >= startMin;
  if (nowDay === nextDay) return nowMin < endMin;
  return false;
}

/**
 * Decide whether the heartbeat handler may hand the agent an upgrade target
 * right now, given the org's update settings.
 */
export function isWithinWeeklySchedule(schedule: AgentUpdateSchedule | null, now: Date): boolean {
  if (!schedule || schedule.windows.length === 0) return false;
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowDay = now.getUTCDay();

  return schedule.windows.some((window) => {
    const day = DAY_OF_WEEK[window.dayOfWeek];
    if (day === undefined) return false;
    const startMatch = window.start.match(STRUCTURED_TIME_RE);
    const endMatch = window.end.match(STRUCTURED_TIME_RE);
    if (!startMatch || !endMatch) return false;
    const startMin = Number(startMatch[1]) * 60 + Number(startMatch[2]);
    const endMin = Number(endMatch[1]) * 60 + Number(endMatch[2]);

    if (startMin < endMin) {
      return nowDay === day && nowMin >= startMin && nowMin < endMin;
    }

    const nextDay = (day + 1) % 7;
    if (nowDay === day) return nowMin >= startMin;
    if (nowDay === nextDay) return nowMin < endMin;
    return false;
  });
}

/**
 * Decide whether the heartbeat handler may hand the agent an automatic update
 * target right now. Accepts the legacy shape too so older tests/mocks and any
 * transitional call sites continue to behave until they are migrated.
 */
export function shouldSendAgentUpgrade(
  settings: AgentUpdateSettings | LegacyAgentUpdateSettings,
  now: Date,
): AgentUpdateGate {
  if ('policy' in settings) {
    if (settings.policy === 'manual') {
      return { allow: false, reason: 'manual-approval' };
    }
    if (!isWithinMaintenanceWindow(settings.maintenanceWindow, now)) {
      return { allow: false, reason: 'outside-schedule' };
    }
    return { allow: true, reason: 'allowed' };
  }

  if (settings.mode === 'manual') {
    return { allow: false, reason: 'manual-approval' };
  }
  if (settings.timing === 'weekly' && !isWithinWeeklySchedule(settings.schedule, now)) {
    return { allow: false, reason: 'outside-schedule' };
  }
  return { allow: true, reason: 'allowed' };
}
