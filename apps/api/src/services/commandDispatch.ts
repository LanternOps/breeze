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
  options: {
    /**
     * Stop claiming once the cumulative serialized payload size of already
     * claimed commands plus the next candidate would exceed this budget
     * (the first command is always claimed). Used by the agent WebSocket
     * path, where the whole batch is delivered in a single frame that must
     * stay under the agent's WS read limit (16MB — exceeding it kills the
     * connection, agent/internal/websocket/client.go, issue #2399).
     * Commands left unclaimed stay pending and are delivered by a later
     * heartbeat/claim cycle. HTTP delivery paths have no frame limit and
     * omit this.
     */
    maxTotalPayloadBytes?: number;
  } = {},
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
    let claimedPayloadBytes = 0;
    for (const command of pendingCommands) {
      if (options.maxTotalPayloadBytes !== undefined) {
        const payloadBytes = Buffer.byteLength(
          JSON.stringify(command.payload ?? {}),
          'utf8',
        );
        if (
          claimed.length > 0 &&
          claimedPayloadBytes + payloadBytes > options.maxTotalPayloadBytes
        ) {
          break;
        }
        claimedPayloadBytes += payloadBytes;
      }
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
