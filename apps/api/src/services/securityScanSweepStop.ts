/**
 * Stops a sweep's children when the sweep is cancelled (a user) or expires
 * (the pump) — #6263 W05-2/W05-6. Runs inside the caller's transaction, after
 * the caller has taken FOR UPDATE on the sweep row (which serializes it with
 * the claim's FOR SHARE).
 *
 *  - `queued` children never got a command: they take the terminal status.
 *  - `running` children whose command is still `pending` were claimed but not
 *    delivered: the command is cancelled through `cancelDeviceCommands` (so its
 *    owners are terminalised and its payload erased) and the scan takes the
 *    terminal status. Found by `security_scans.command_id`, never by payload.
 *  - Delivered scans finish: the agent has no cancel wire for a running scan.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, securityScans } from '../db/schema';
import { cancelDeviceCommands } from './commandCancelPropagation';

export async function stopSweepChildren(input: {
  sweepId: string;
  orgId: string;
  status: 'cancelled' | 'expired';
  reason: string;
  cancelledBy?: string | null;
  now: Date;
}): Promise<{ queued: number; undelivered: number; stillRunning: number }> {
  const { sweepId, orgId, status, now } = input;
  const queued = await db
    .update(securityScans)
    .set({ status, completedAt: now })
    .where(and(eq(securityScans.sweepId, sweepId), eq(securityScans.orgId, orgId), eq(securityScans.status, 'queued')))
    .returning({ id: securityScans.id });

  const pending = await db
    .select({ scanId: securityScans.id, commandId: deviceCommands.id })
    .from(securityScans)
    .innerJoin(deviceCommands, eq(deviceCommands.id, securityScans.commandId))
    .where(
      and(
        eq(securityScans.sweepId, sweepId),
        eq(securityScans.orgId, orgId),
        eq(securityScans.status, 'running'),
        eq(deviceCommands.status, 'pending'),
      ),
    );
  let undelivered = 0;
  if (pending.length > 0) undelivered = await cancelPending(pending, input, now);

  // Delivered scans keep running on the agent (there is no cancel wire); the
  // caller says so instead of implying the scanning stopped.
  const [running] = await db
    .select({ running: sql<number>`count(*)::int` })
    .from(securityScans)
    .where(and(eq(securityScans.sweepId, sweepId), eq(securityScans.orgId, orgId), eq(securityScans.status, 'running')));
  return { queued: queued.length, undelivered, stillRunning: Number(running?.running ?? 0) };
}

async function cancelPending(
  pending: Array<{ scanId: string; commandId: string }>,
  input: { status: 'cancelled' | 'expired'; reason: string; cancelledBy?: string | null },
  now: Date,
): Promise<number> {
  const { status } = input;

  const cancelled = await cancelDeviceCommands({
    where: and(inArray(deviceCommands.id, pending.map((p) => p.commandId)), eq(deviceCommands.status, 'pending'))!,
    result: { status: 'cancelled', reason: input.reason, ...(input.cancelledBy ? { cancelledBy: input.cancelledBy } : {}) },
    completedAt: now,
  });
  if (cancelled.length > 0) {
    // The cancel hook already moved these scans running -> cancelled; an
    // expiry records them as expired instead.
    await db
      .update(securityScans)
      .set({ status, completedAt: now })
      .where(
        and(
          inArray(securityScans.commandId, cancelled.map((c) => c.id)),
          inArray(securityScans.status, ['running', 'cancelled']),
        ),
      );
  }
  return cancelled.length;
}
