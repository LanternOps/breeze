/**
 * Fleet-finding lifecycle gating and copy (#5365).
 *
 * Kept as a pure leaf module — no React Native imports — so the gating table
 * is unit-tested in Vitest's node environment. The mobile app has no RN test
 * runtime (see `apps/mobile/vitest.config.ts`), so anything worth asserting
 * has to live outside a `.tsx`.
 *
 * The table below mirrors `apps/web/src/components/fleet/FindingDrawer.tsx`
 * exactly: a tech must not be offered an action on the phone that the web
 * refuses (or vice versa), because both hit the same
 * `PATCH /fleet/findings/:id` and the server is the real arbiter.
 */

export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FleetFindingAction = 'acknowledge' | 'dismiss' | 'reopen';

/** Matches the server's `notes` max on `PATCH /fleet/findings/:id`. */
export const DISMISS_NOTES_MAX_LENGTH = 2000;

export function canAcknowledge(status: FleetFindingStatus): boolean {
  return status === 'open';
}

export function canDismiss(status: FleetFindingStatus): boolean {
  return status === 'open' || status === 'acknowledged';
}

export function canReopen(status: FleetFindingStatus): boolean {
  return status === 'acknowledged' || status === 'dismissed';
}

/**
 * The actions to render, in render order. `resolved` is terminal: the
 * reconciler owns resolution and there is deliberately no resolve action.
 */
export function availableFindingActions(status: FleetFindingStatus): FleetFindingAction[] {
  const actions: FleetFindingAction[] = [];
  if (canAcknowledge(status)) actions.push('acknowledge');
  if (canDismiss(status)) actions.push('dismiss');
  if (canReopen(status)) actions.push('reopen');
  return actions;
}

export type DismissNoteResult =
  | { ok: true; notes: string }
  | { ok: false; reason: 'required' | 'too_long' };

/**
 * A dismiss without a note is a 400 from the API, so the sheet blocks it
 * locally rather than round-tripping. The length is measured on the trimmed
 * value because that is what gets sent.
 */
export function validateDismissNote(raw: string): DismissNoteResult {
  const notes = raw.trim();
  if (notes.length === 0) return { ok: false, reason: 'required' };
  if (notes.length > DISMISS_NOTES_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, notes };
}

const ACTION_LABELS: Record<FleetFindingAction, string> = {
  acknowledge: 'Acknowledge',
  dismiss: 'Dismiss',
  reopen: 'Reopen',
};

export function findingActionLabel(action: FleetFindingAction): string {
  return ACTION_LABELS[action];
}

const STATUS_LABELS: Record<FleetFindingStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
};

/**
 * Falls back to the raw server value for a status this build does not know
 * about — a blank chip would read as "no status" and hide the truth.
 */
export function findingStatusLabel(status: FleetFindingStatus): string {
  return STATUS_LABELS[status] ?? String(status);
}

const SEVERITY_LABELS: Record<FleetFindingSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
  critical: 'Critical',
};

export function severityLabel(severity: FleetFindingSeverity): string {
  return SEVERITY_LABELS[severity] ?? String(severity);
}

const SEVERITY_RANK: Record<FleetFindingSeverity, number> = {
  critical: 4,
  error: 3,
  warning: 2,
  info: 1,
};

/** Higher sorts first. An unrecognised severity ranks 0, i.e. last. */
export function findingSeverityRank(severity: FleetFindingSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/**
 * The `riskTier` band a severity pill should wear. Findings carry the API's
 * four-value severity scale while the mobile theme exposes the alert
 * `riskTier` bands, so the two have to be mapped somewhere — here, as a pure
 * function, rather than inline in the screen where it would be untestable.
 * `error` maps to `high` and `warning` to `medium`, matching how the web
 * findings table colours the same values.
 */
export type FindingSeverityTier = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_TIERS: Record<FleetFindingSeverity, FindingSeverityTier> = {
  info: 'low',
  warning: 'medium',
  error: 'high',
  critical: 'critical',
};

export function findingSeverityTier(severity: FleetFindingSeverity): FindingSeverityTier {
  return SEVERITY_TIERS[severity] ?? 'low';
}
