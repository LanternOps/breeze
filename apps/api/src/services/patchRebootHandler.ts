/**
 * Patch Reboot Handler
 *
 * Evaluates reboot policies after patch installation and dispatches
 * reboot commands via the existing command queue infrastructure.
 */

import { queueCommandForExecution } from './commandQueue';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';

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
  delayMinutes: number = 5
): Promise<RebootResult> {
  const result = await queueCommandForExecution(deviceId, 'schedule_reboot', {
    delayMinutes,
    reason,
    source: 'patch_job',
  });

  if (result.error) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
