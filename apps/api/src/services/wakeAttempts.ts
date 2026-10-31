import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { deviceWakeAttempts } from '../db/schema/deviceWake';
import { isPgUniqueViolation } from '../utils/pgErrors';
import type { WakeFailureCode } from './wakeOnLan';

export const WAKE_OUTCOME_WINDOW_MS = 600_000;

interface WakeRequest {
  deviceId: string;
  orgId: string;
  requestedBy: string;
  bulkId?: string;
}

/** Uses the caller's tenant context; dispatchWake has already checked eligibility. */
export async function openOrJoinWakeAttempt(input: WakeRequest & {
  relayDeviceId: string;
  relayHostname: string;
  macs: string[];
  broadcast: string;
}): Promise<{ attemptId: string; joined: boolean }> {
  const openCondition = and(
    eq(deviceWakeAttempts.deviceId, input.deviceId),
    eq(deviceWakeAttempts.orgId, input.orgId),
    inArray(deviceWakeAttempts.outcome, ['pending', 'sent']),
  );
  // Retry if a result/sweep closes the row between finding it and joining it.
  for (;;) {
    const [existing] = await db.select({ id: deviceWakeAttempts.id })
      .from(deviceWakeAttempts).where(openCondition).limit(1);
    if (existing) {
      const [joined] = await db.update(deviceWakeAttempts)
        .set({ sendCount: sql`${deviceWakeAttempts.sendCount} + 1` })
        .where(and(eq(deviceWakeAttempts.id, existing.id), openCondition))
        .returning({ id: deviceWakeAttempts.id });
      if (joined) return { attemptId: joined.id, joined: true };
      continue;
    }
    try {
      // A driver-owned savepoint keeps a lost unique-index race from aborting
      // the caller's transaction. Do not open another system context here.
      const created = await withDbTransaction(async () => {
        const now = new Date();
        const [row] = await db.insert(deviceWakeAttempts).values({
          ...input, outcome: 'pending', sendCount: 1, requestedAt: now,
          deadlineAt: new Date(now.getTime() + WAKE_OUTCOME_WINDOW_MS),
        }).returning({ id: deviceWakeAttempts.id });
        if (!row) throw new Error('Failed to record wake attempt');
        return row;
      });
      return { attemptId: created.id, joined: false };
    } catch (error) {
      if (!isPgUniqueViolation(error, 'device_wake_attempts_open_uidx')) throw error;
      // The winning transaction has committed; re-read and join its open row.
    }
  }
}

const RECORDED_REFUSALS = new Set<WakeFailureCode>([
  'NO_MACS', 'NO_SUBNET', 'IPV6_ONLY', 'NO_RELAY', 'RELAY_OVERRIDE_INVALID',
]);

export async function recordWakeRefusal(input: WakeRequest & { code: WakeFailureCode }): Promise<void> {
  if (!RECORDED_REFUSALS.has(input.code)) return;
  try {
    // Even a failed ledger insert must leave the caller able to return its
    // original refusal and commit the enclosing request transaction.
    await withDbTransaction(async () => {
      await db.insert(deviceWakeAttempts).values({
        deviceId: input.deviceId, orgId: input.orgId, requestedBy: input.requestedBy,
        bulkId: input.bulkId, outcome: 'refused', refusalCode: input.code,
        resolvedAt: new Date(), deadlineAt: null, relayDeviceId: null, relayHostname: null,
      });
    });
  } catch (error) {
    console.error('[wakeAttempts] failed to record wake refusal', { deviceId: input.deviceId, code: input.code, error });
  }
}

/** Agent result handlers already hold the caller's transaction and RLS context. */
export async function applyWakeRelayResult(attemptId: string, sent: boolean): Promise<void> {
  await db.update(deviceWakeAttempts)
    .set(sent ? { outcome: 'sent' } : { outcome: 'send_failed', resolvedAt: new Date() })
    .where(and(eq(deviceWakeAttempts.id, attemptId), eq(deviceWakeAttempts.outcome, 'pending')));
}
