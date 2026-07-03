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
 * window for both `auto` and `staged`. The explicit "24/7" / empty state (see
 * `isAlwaysMaintenanceWindow` in @breeze/shared) means no restriction — upgrade
 * at any time. This preserves the historical behaviour for orgs that never
 * configured the policy.
 *
 * Timezone note: the `maintenanceWindow` is a string with no timezone
 * component (e.g. "Sun 02:00-04:00"), so it is evaluated against UTC server
 * time. This gate reads the EFFECTIVE settings (getOrgAgentUpdatePolicy) —
 * partner defaults applied on top of org-local values, matching the settings UI
 * (issue #2123). Both write paths are validated at save time as of issue #1963:
 * PATCH /organizations/:id (org-local) and PATCH /partners/me (partner default,
 * which now reaches this gate: a partner-set field wins and locks, and the
 * org-local value applies only where the partner has not set it). Any legacy
 * malformed value still fails open (no restriction) rather than permanently
 * blocking, and is logged
 * the first time it is ignored per org (per process; see getOrgAgentUpdatePolicy)
 * so the lifted restriction is observable.
 *
 * This module is pure and side-effect free so it can be unit tested without a
 * database. The DB read lives in `getOrgAgentUpdatePolicy` (helpers.ts).
 */

import { parseMaintenanceWindow } from '@breeze/shared';

export type AgentUpdatePolicy = 'auto' | 'staged' | 'manual';

export interface AgentUpdateSettings {
  policy: AgentUpdatePolicy;
  maintenanceWindow: string | null;
}

export interface AgentUpdateGate {
  allow: boolean;
  reason: 'allowed' | 'manual-approval' | 'outside-maintenance-window';
}

// The window grammar/parser lives in @breeze/shared so the web editor and this
// gate validate against the exact same shape. Re-exported here so existing
// callers/tests in this module keep their import surface.
export { parseMaintenanceWindow };

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
