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
