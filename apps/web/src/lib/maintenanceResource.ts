/**
 * The canonical `{ deviceIds, reason, durationHours }` a device-maintenance
 * step-up grant is bound to (RMM-QA-176 D10/D11).
 *
 * The server hashes
 *   JSON.stringify({ deviceIds: [...new Set(ids)].sort(), durationHours, reason: reason.trim() })
 * in `maintenanceResourceDigest` (apps/api/src/services/mfaStepUpGrant.ts) —
 * once when minting the grant and once when spending it. The client builds ONE
 * object here and uses it for BOTH the mint resource and the request body, so
 * the two hashed inputs cannot drift.
 *
 * Why this matters more than it looks: the maintenance routes deliberately
 * answer missing / stale / mismatched grants with the SAME 403
 * `STEP_UP_REQUIRED` so the response is not a probing oracle for the binding.
 * That means a client that minted against even a slightly different reason or
 * device set produces a 403 loop the technician cannot diagnose.
 *
 * This module has no dependencies on purpose: it is imported by the dialog, and
 * component tests that mock `services/deviceActions` must still get the real
 * canonicalization.
 */
export interface MaintenanceResource {
  deviceIds: string[];
  reason: string;
  durationHours: number;
}

export function canonicalMaintenanceResource(input: MaintenanceResource): MaintenanceResource {
  return {
    deviceIds: [...new Set(input.deviceIds)].sort(),
    reason: input.reason.trim(),
    durationHours: input.durationHours,
  };
}

/** Mirrors `maintenanceReasonSchema` — `z.string().trim().min(3).max(500)`. */
export const MAINTENANCE_REASON_MIN = 3;
export const MAINTENANCE_REASON_MAX = 500;

/** Mirrors `maintenanceDurationSchema`'s ceiling, MAINTENANCE_MAX_DURATION_HOURS. */
export const MAINTENANCE_DURATION_OPTIONS = [1, 2, 4, 8, 24, 72, 168] as const;

/**
 * "Is a technician holding this device in maintenance right now?"
 *
 * `status === 'maintenance'` alone is NOT the truth going forward: the agent
 * heartbeat writes `status: 'online'` on every beat
 * (routes/agents/heartbeat.ts, deliberately unchanged — RMM-QA-217), so a
 * device with a live lease can read back online between beats.
 *
 * The two are OR-ed rather than lease-first on purpose. There is no lease
 * expiry sweeper yet (also RMM-QA-217), so a row can carry a PAST
 * `maintenanceUntil` while `status` still says `maintenance`. Lease-first would
 * call that device "not in maintenance" and offer entry — while the status
 * badge next to it says maintenance, and with no way to clear the stale status.
 * OR-ing offers exit, which is the operation that actually resolves it.
 */
export function isInMaintenance(device: {
  status?: string;
  maintenanceUntil?: string | null;
}): boolean {
  if (device.status === 'maintenance') return true;
  if (device.maintenanceUntil == null) return false;
  const until = new Date(device.maintenanceUntil).getTime();
  return !Number.isNaN(until) && until > Date.now();
}
