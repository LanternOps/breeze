import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';

type DeviceCommandRow = typeof deviceCommands.$inferSelect;

export async function claimPendingCommandForDelivery(
  commandId: string,
  executedAt: Date = new Date(),
): Promise<{ id: string; executedAt: Date } | null> {
  // device_commands is system-scoped (agent WS path) and this runs from
  // executeCommand's runOutsideDbContext block — establish a system context so
  // the write isn't a contextless bare-pool write (#1375 warning flood).
  const rows = await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({ status: 'sent', executedAt })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
        ),
      )
      .returning({ id: deviceCommands.id }),
  );

  return rows.length > 0 ? { id: commandId, executedAt } : null;
}

/**
 * Put a claimed-but-undelivered command back to `pending`. Keyed on
 * `(id, status='sent', executedAt=<claim ts>)` so a stale release can never
 * clobber a newer claim or resurrect a terminal command (0-row no-op is the
 * correct outcome in both cases).
 *
 * Context note: `withSystemDbAccessContext` does NOT escalate when a request
 * context is already active — on the heartbeat paths (#2414) this UPDATE runs
 * inside the caller's org-scoped transaction. That is safe solely because
 * `device_commands` is intentionally RLS-free; if it ever gains a system-only
 * write policy, this release would become a silent 0-row no-op on the hottest
 * delivery path.
 */
export async function releaseClaimedCommandDelivery(
  commandId: string,
  executedAt: Date,
): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({ status: 'pending', executedAt: null })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.executedAt, executedAt),
        ),
      ),
  );
}

export async function claimPendingCommandsForDevice(
  deviceId: string,
  limit: number = 10,
  targetRole: 'agent' | 'watchdog' = 'agent',
): Promise<DeviceCommandRow[]> {
  // Only HTTP delivery paths (heartbeat responses) claim batches; the agent
  // WebSocket never embeds command batches in frames (#2407 removed the
  // connect-time/heartbeat_ack claims — no agent version ever consumed them),
  // so the per-frame payload budget that #2399 added here is gone with it.
  return db.transaction(async (tx) => {
    const pendingCommands = await tx
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'pending'),
          eq(deviceCommands.targetRole, targetRole),
        ),
      )
      .orderBy(deviceCommands.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed: DeviceCommandRow[] = [];
    for (const command of pendingCommands) {
      const executedAt = new Date();
      const rows = await tx
        .update(deviceCommands)
        .set({ status: 'sent', executedAt })
        .where(
          and(
            eq(deviceCommands.id, command.id),
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, 'pending'),
            eq(deviceCommands.targetRole, targetRole),
          ),
        )
        .returning();
      if (rows[0]) {
        claimed.push(rows[0]);
      }
    }

    return claimed;
  });
}
