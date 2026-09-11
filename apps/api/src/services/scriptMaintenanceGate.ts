import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { captureException } from './sentry';

/**
 * The one place that answers "may a script run on this device right now?" for
 * a device maintenance window (#4919).
 *
 * It exists as its own leaf module rather than as a call to
 * `checkDeviceMaintenanceWindow` inside `scriptDispatch.ts` for two reasons:
 * the fail-closed policy below has to be identical for every dispatch path
 * (an inline `try` per call site is exactly how the four paths diverged in
 * the first place), and `featureConfigResolver.ts` is a large module that
 * every `scriptDispatch` unit test would otherwise have to mock.
 */

/** Reported to operators and to the assistant. Deliberately says WHY, not just "denied". */
export const MAINTENANCE_SUPPRESSED_MESSAGE =
  'Device is in a maintenance window that suppresses script execution';

/**
 * A DIFFERENT message on purpose. Telling an operator their device is in a
 * maintenance window when the truth is "we could not read the maintenance
 * config" sends them to look at a window that may not exist.
 */
export const MAINTENANCE_CHECK_FAILED_MESSAGE =
  'Maintenance window could not be evaluated for this device; refusing to run the script (fail-closed)';

export type ScriptMaintenanceVerdict =
  | { suppressed: false }
  | {
      suppressed: true;
      /**
       * `window_active` — a real window with `suppressScripts` is open.
       * `check_failed` — the resolve threw. We refuse anyway (fail-closed),
       * mirroring `jobs/automationWorker.ts`'s long-standing choice for the
       * same question: an unverifiable window must not become an open door.
       */
      reason: 'window_active' | 'check_failed';
      message: string;
      /** Only ever set for `window_active`; a failed check knows nothing. */
      windowEndsAt: Date | null;
    };

export async function checkScriptMaintenanceSuppression(
  deviceId: string,
): Promise<ScriptMaintenanceVerdict> {
  try {
    const status = await checkDeviceMaintenanceWindow(deviceId);
    if (status.active && status.suppressScripts) {
      return {
        suppressed: true,
        reason: 'window_active',
        message: MAINTENANCE_SUPPRESSED_MESSAGE,
        windowEndsAt: status.windowEndsAt,
      };
    }
    return { suppressed: false };
  } catch (err) {
    console.warn(
      `[scriptMaintenanceGate] maintenance check failed for device ${deviceId}; refusing dispatch (fail-closed):`,
      err,
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return {
      suppressed: true,
      reason: 'check_failed',
      message: MAINTENANCE_CHECK_FAILED_MESSAGE,
      windowEndsAt: null,
    };
  }
}
