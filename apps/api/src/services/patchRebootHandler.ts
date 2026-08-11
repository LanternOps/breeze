/**
 * Patch Reboot Handler
 *
 * Evaluates reboot policies after patch installation and dispatches
 * reboot commands via the existing command queue infrastructure.
 */

import { queueCommandForExecution } from './commandQueue';
import { checkDeviceMaintenanceWindow, resolvePatchConfigForDevice } from './featureConfigResolver';
import { captureException } from './sentry';

// ============================================
// Reboot delay resolution (issue #3197)
// ============================================

/**
 * Fallback delay when a device resolves to no effective patch policy.
 *
 * This is the single source of truth for the reboot grace across BOTH reboot
 * paths. Before #3197 the patch path hardcoded 5 and the maintenance-window
 * worker hardcoded its own 15, and they disagreed silently: at 5 minutes the
 * agent's 60/15/5 warning ladder (gated on strict `>`) fired nothing at all, so
 * a patched workstation rebooted with no notice, while the maintenance path
 * happened to warn. Operators configure the real value on the patch
 * Configuration Policy (`config_policy_patch_settings.reboot_delay_minutes`);
 * this constant only covers a device with no policy at all.
 */
export const DEFAULT_REBOOT_DELAY_MINUTES = 15;

/** Inclusive bounds, mirroring the DB CHECK and the zod validator. */
export const MIN_REBOOT_DELAY_MINUTES = 1;
export const MAX_REBOOT_DELAY_MINUTES = 1440;

/**
 * Coerces a policy value into a usable delay. The column is NOT NULL with a
 * CHECK, so this is defense-in-depth against a null from an outer join, a
 * pre-migration row, or a hand-edited database — not the primary validation.
 */
export function clampRebootDelayMinutes(value: unknown): number {
  // Deliberately NOT a bare `Number(value)`: Number(null), Number('') and
  // Number([]) are all 0, which would clamp to MIN — a one-minute warning.
  // Unusable input has to mean "use the safe default", never "give the user the
  // shortest possible notice".
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  } else {
    return DEFAULT_REBOOT_DELAY_MINUTES;
  }
  if (!Number.isFinite(parsed)) return DEFAULT_REBOOT_DELAY_MINUTES;
  const rounded = Math.round(parsed);
  if (rounded < MIN_REBOOT_DELAY_MINUTES) return MIN_REBOOT_DELAY_MINUTES;
  if (rounded > MAX_REBOOT_DELAY_MINUTES) return MAX_REBOOT_DELAY_MINUTES;
  return rounded;
}

/**
 * Resolves how long the logged-in user is warned before this device reboots,
 * from the device's effective patch Configuration Policy.
 *
 * `resolvePatchConfigForDevice` already walks the assignment hierarchy with
 * partner-wide visibility, so a partner-wide patch policy is honoured here with
 * no extra work — the delay rides on an existing partner-linkable surface
 * rather than a new table.
 *
 * A resolution failure falls back to the default rather than propagating. That
 * is a deliberate trade, not a swallowed error: this runs after patches have
 * already been installed, so throwing would strand the device with an
 * unfinalized update and no reboot, which is worse than rebooting on the
 * default 15-minute warning. The failure is reported to Sentry so it cannot
 * hide.
 */
export async function resolveRebootDelayMinutes(
  deviceId: string,
  deps = { resolvePatchConfigForDevice }
): Promise<number> {
  try {
    const settings = await deps.resolvePatchConfigForDevice(deviceId);
    if (!settings) return DEFAULT_REBOOT_DELAY_MINUTES;
    const stored = settings.rebootDelayMinutes;
    const delay = clampRebootDelayMinutes(stored);
    // The column is NOT NULL with CHECK (reboot_delay_minutes BETWEEN 1 AND 1440)
    // and every write path is zod-validated, so a value that needed clamping got
    // past all of that — a CHECK bypass, a hand-edited row, or a NULL leaking
    // through a join. Clamping keeps the reboot warned, but the anomaly must not
    // be the quiet branch: it is more likely to indicate a bug than the throwing
    // path below, which is already reported.
    if (stored !== delay) {
      console.warn(
        `[PatchReboot] device ${deviceId} had an out-of-range stored reboot delay ${String(stored)}; using ${delay}m`
      );
      captureException(
        new Error(
          `Out-of-range config_policy_patch_settings.reboot_delay_minutes ${String(stored)} for device ${deviceId} (clamped to ${delay})`
        )
      );
    }
    return delay;
  } catch (err) {
    console.warn(
      `[PatchReboot] failed to resolve reboot delay for device ${deviceId}, falling back to ${DEFAULT_REBOOT_DELAY_MINUTES}m:`,
      err
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return DEFAULT_REBOOT_DELAY_MINUTES;
  }
}

// ============================================
// Types
// ============================================

export interface RebootEvaluation {
  shouldReboot: boolean;
  reason: string;
  deferred: boolean;
}

export interface RebootResult {
  success: boolean;
  error?: string;
  /** The delay actually dispatched, so the caller can record it on the job. */
  delayMinutes?: number;
}

export type RebootPolicy = 'never' | 'if_required' | 'always' | 'maintenance_window';

// ============================================
// Policy evaluation
// ============================================

export async function evaluateRebootPolicy(
  deviceId: string,
  rebootPolicy: string,
  anyPatchRequiresReboot: boolean
): Promise<RebootEvaluation> {
  switch (rebootPolicy) {
    case 'never':
      return { shouldReboot: false, reason: 'Reboot policy is never', deferred: false };

    case 'if_required':
      if (anyPatchRequiresReboot) {
        return { shouldReboot: true, reason: 'Installed patch requires reboot', deferred: false };
      }
      return { shouldReboot: false, reason: 'No installed patch requires reboot', deferred: false };

    case 'always':
      return { shouldReboot: true, reason: 'Reboot policy is always', deferred: false };

    case 'maintenance_window': {
      const maintenanceStatus = await checkDeviceMaintenanceWindow(deviceId);
      if (maintenanceStatus.active) {
        return { shouldReboot: true, reason: 'In active maintenance window', deferred: false };
      }
      return {
        shouldReboot: false,
        reason: 'Outside maintenance window — reboot deferred',
        deferred: true,
      };
    }

    default:
      // Unknown policy — treat as if_required for safety
      if (anyPatchRequiresReboot) {
        return { shouldReboot: true, reason: `Unknown reboot policy "${rebootPolicy}", defaulting to if_required`, deferred: false };
      }
      return { shouldReboot: false, reason: `Unknown reboot policy "${rebootPolicy}", no reboot needed`, deferred: false };
  }
}

// ============================================
// Reboot execution
// ============================================

export async function executeReboot(
  deviceId: string,
  reason: string,
  options: {
    /**
     * Explicit delay in minutes. Omit to resolve it from the device's effective
     * patch policy — which is what callers should normally do. There is no
     * hardcoded default any more: the old `delayMinutes = 5` was #3197, because
     * 5 minutes reached none of the agent's warning thresholds.
     */
    delayMinutes?: number;
    /**
     * Owning org, for the cross-tenant guard in queueCommandForExecution. This
     * path runs from a BullMQ worker under a system DB context (RLS off), so
     * without it a mismatched device id would receive a reboot.
     */
    expectedOrgId?: string;
  } = {}
): Promise<RebootResult> {
  const delayMinutes =
    options.delayMinutes !== undefined
      ? clampRebootDelayMinutes(options.delayMinutes)
      : await resolveRebootDelayMinutes(deviceId);

  const result = await queueCommandForExecution(
    deviceId,
    'schedule_reboot',
    {
      delayMinutes,
      reason,
      source: 'patch_job',
    },
    { expectedOrgId: options.expectedOrgId }
  );

  if (result.error) {
    return { success: false, error: result.error };
  }

  return { success: true, delayMinutes };
}
