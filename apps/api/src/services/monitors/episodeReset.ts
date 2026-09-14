/**
 * The human reset of a recurrence escalation (#5287 W03 / #5290).
 *
 * Clears the latch, resumes automatic responses and restarts the recurrence
 * window. It deliberately does NOT close the open episode and does NOT resolve
 * or acknowledge the requires-human alert: acknowledging is separately audited
 * and stops paging on its own, and a device still in breach is still in breach.
 *
 * Runs under the request's own DB context, so RLS already refuses a
 * cross-tenant reset; the route additionally 404s when the monitor is not
 * visible to the caller.
 */

import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDeviceState } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

export interface ResetMonitorEscalationInput {
  monitorId: string;
  deviceId: string;
  auth: AuthContext;
}

export async function resetMonitorEscalation(
  input: ResetMonitorEscalationInput,
): Promise<{ reset: boolean }> {
  const now = new Date();
  const conditions: (SQL | undefined)[] = [
    eq(monitorDeviceState.monitorId, input.monitorId),
    eq(monitorDeviceState.deviceId, input.deviceId),
    // Only an ESCALATED pair can be reset: without this a reset on a healthy
    // pair would stamp reset_at/reset_by and report success for a no-op.
    isNotNull(monitorDeviceState.escalatedAt),
    input.auth.orgCondition(monitorDeviceState.orgId),
  ];

  const rows = await db
    .update(monitorDeviceState)
    .set({
      escalatedAt: null,
      escalationAlertId: null,
      responsesPaused: false,
      episodesInWindow: 0,
      windowStartedAt: null,
      resetAt: now,
      resetBy: input.auth.user?.id ?? null,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning({ monitorId: monitorDeviceState.monitorId });

  return { reset: rows.length > 0 };
}
