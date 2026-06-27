/**
 * Agent-update maintenance window — shared grammar + validation.
 *
 * The org/partner "Agent update policy" stores a single free-form string,
 * `maintenanceWindow`, that gates when the heartbeat handler may hand an agent
 * an upgrade target. This module is the ONE source of truth for that string's
 * shape so the web editor (client-side validation + structured control) and the
 * API (save-time rejection + heartbeat gating) never drift.
 *
 * Value space:
 *   - "always allowed" / no restriction → empty, or the explicit sentinel
 *     `"24/7"` (also tolerated: "always", "none", "anytime"). Agents may update
 *     anytime. The canonical persisted form is `MAINTENANCE_WINDOW_ALWAYS`.
 *   - a window → `"[Day ]HH:MM-HH:MM"` (optional 3-letter day prefix; no day
 *     means "daily"). Times are evaluated in **UTC** (the string carries no
 *     timezone), so the UI must say so explicitly.
 *
 * Anything else is malformed. The API rejects malformed values at save time
 * (issue #1963) so the heartbeat gate never has to silently fail open on a typo.
 */

/** Canonical sentinel persisted for the "update anytime" / no-window state. */
export const MAINTENANCE_WINDOW_ALWAYS = '24/7';

/** Display labels indexed by UTC day-of-week (0 = Sunday). */
export const MAINTENANCE_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** UTC day-of-week index, 0=Sun … 6=Sat (matches Date.getUTCDay / MAINTENANCE_DAYS). */
export type MaintenanceDayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DAY_OF_WEEK: Record<string, MaintenanceDayIndex> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// Values (besides empty/whitespace) that mean "no maintenance window".
const ALWAYS_TOKENS = new Set(['24/7', 'always', 'none', 'anytime']);

export interface ParsedMaintenanceWindow {
  /** UTC day-of-week the window starts on (0=Sun), or null for "any day" (daily). */
  day: MaintenanceDayIndex | null;
  /** Minutes-since-midnight the window opens (0..1439, parser-guaranteed). */
  startMin: number;
  /** Minutes-since-midnight the window closes (0..1439, parser-guaranteed). */
  endMin: number;
}

/**
 * True when `raw` represents the "update anytime / no maintenance window" state:
 * empty / whitespace-only / the `24/7` sentinel (or the tolerated aliases).
 */
export function isAlwaysMaintenanceWindow(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return raw == null; // null/undefined → always; other non-strings → not
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return ALWAYS_TOKENS.has(trimmed.toLowerCase());
}

/**
 * Parse a maintenance window string of the form "Sun 02:00-04:00" (optional
 * 3-letter day prefix; "02:00-04:00" means daily). Returns null when the input
 * is empty, an "always" sentinel, or malformed — callers treat null as
 * "no time restriction".
 */
export function parseMaintenanceWindow(
  raw: string | null | undefined,
): ParsedMaintenanceWindow | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^(?:([A-Za-z]{3})\s+)?(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const [, dayStr, sh, sm, eh, em] = m;
  let day: MaintenanceDayIndex | null = null;
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
 * Whether `raw` is an acceptable value to persist: either the "always" state or
 * a parseable window. Used by both the API save guard and the web editor so a
 * malformed value can never be silently stored.
 */
export function isValidMaintenanceWindow(raw: string | null | undefined): boolean {
  return isAlwaysMaintenanceWindow(raw) || parseMaintenanceWindow(raw) !== null;
}

/** Format minutes-since-midnight as zero-padded "HH:MM". */
export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Build a canonical window string from UI fields. `dayLabel` is one of
 * MAINTENANCE_DAYS or null/"" for daily; `start`/`end` are "HH:MM". Returns the
 * canonical `"[Day ]HH:MM-HH:MM"` string, or `null` if the result would not be a
 * valid window (caller should treat null as "invalid input", distinct from the
 * always sentinel).
 */
export function formatMaintenanceWindow(
  dayLabel: string | null | undefined,
  start: string,
  end: string,
): string | null {
  const prefix = dayLabel ? `${dayLabel} ` : '';
  const candidate = `${prefix}${start}-${end}`;
  return parseMaintenanceWindow(candidate) ? candidate : null;
}
