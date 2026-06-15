/**
 * Agent update policy resolution (pure logic).
 *
 * The org-level "Agent update policy" (Org > General) governs whether the
 * heartbeat handler is allowed to hand an agent an `upgradeTo` target:
 *
 *   - `manual`  → never auto-upgrade; upgrades happen only via explicit admin action
 *   - `auto`    → upgrade whenever a newer version exists
 *   - `staged`  → same as `auto`, but only while inside the configured
 *                 maintenance window (when one is set)
 *
 * In addition, a configured `maintenanceWindow` suppresses upgrades outside the
 * window for both `auto` and `staged`. A device with no maintenance window set
 * may upgrade at any time (this preserves the historical behaviour for orgs
 * that never configured the policy).
 *
 * Timezone note: the org `maintenanceWindow` is a free-form string with no
 * timezone component (e.g. "Sun 02:00-04:00"), so it is evaluated against UTC
 * server time. Malformed windows fail open (no time restriction) so a typo
 * never permanently blocks updates.
 *
 * This module is pure and side-effect free so it can be unit tested without a
 * database. The DB read lives in `getOrgAgentUpdatePolicy` (helpers.ts).
 */

export type AgentUpdatePolicy = 'auto' | 'staged' | 'manual';

export interface AgentUpdateSettings {
  policy: AgentUpdatePolicy;
  maintenanceWindow: string | null;
}

export interface AgentUpdateGate {
  allow: boolean;
  reason: 'allowed' | 'manual-approval' | 'outside-maintenance-window';
}

const DAY_OF_WEEK: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
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
export function shouldSendAgentUpgrade(settings: AgentUpdateSettings, now: Date): AgentUpdateGate {
  if (settings.policy === 'manual') {
    return { allow: false, reason: 'manual-approval' };
  }
  if (!isWithinMaintenanceWindow(settings.maintenanceWindow, now)) {
    return { allow: false, reason: 'outside-maintenance-window' };
  }
  return { allow: true, reason: 'allowed' };
}
