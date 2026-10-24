/**
 * §5.2 Commands. Every non-terminal `device_commands` row of the target that
 * was enqueued for an EARLIER incarnation — `pending` and `sent` alike, the
 * uninstall drain included — becomes `cancelled` with reason
 * `superseded_by_reattach`, its payload erased like every terminal
 * transition, and the records that own those commands are settled in the
 * same transaction (`propagateCancelledDeviceCommands`: script executions and
 * their batches, patch job results and counters, deployment results, cleanup
 * runs, automation actions), as decommission and org move do.
 *
 * Differences from those two sweeps, all deliberate:
 *  - `sent` rows too. They are running on the OLD install, whose late result
 *    the incarnation check now refuses, so nothing else would settle them
 *    before the reaper's deadline.
 *  - `self_uninstall` too. A removal queued for the old install must not
 *    uninstall the new one.
 *  - Keyed on the stamp, not on "every open row": the device row handler has
 *    already advanced the incarnation, so a row this transaction (or an insert
 *    that waited behind the device lock) enqueued for the NEW install is
 *    fresh work and is left alone (§4.2).
 *
 * Ending a backup command also fires `device_commands_revoke_backup_storage_sessions`,
 * so the storage sessions those commands held are revoked by the same writes.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { deviceCommands } from '../../../db/schema';
import { propagateCancelledDeviceCommands } from '../../commandCancelPropagation';
import { SUPERSEDED_BY_REATTACH_REASON } from '../../commandIncarnation';
import { terminalPayloadErasureSet } from '../../sensitiveCommandPayload';
import type { BoundaryHandler } from '../types';

const OPEN_COMMAND_STATUSES = ['pending', 'sent'] as const;

export const commandsHandler: BoundaryHandler = {
  id: 'commands',
  spec: '§5.2',
  // The owning records are settled through the cancelled commands.
  tables: ['device_commands', 'script_executions', 'patch_job_results', 'deployment_results', 'automation_action_results'],
  async run(ctx) {
    const earlierIncarnation = and(
      eq(deviceCommands.deviceId, ctx.deviceId),
      inArray(deviceCommands.status, [...OPEN_COMMAND_STATUSES]),
      sql`COALESCE(${deviceCommands.deviceIncarnation}, 1) < ${ctx.newIncarnation}`,
    );

    // Read id/type/payload BEFORE the erasing UPDATE: the propagation keys on
    // `payload.executionId` / `payload.runId`, which the erasure strips. The
    // rows are locked here so the UPDATE below cancels exactly this set.
    const open = await db
      .select({ id: deviceCommands.id, type: deviceCommands.type, payload: deviceCommands.payload })
      .from(deviceCommands)
      .where(earlierIncarnation)
      .for('update');
    if (open.length === 0) return { device_commands: 0 };

    const cancelled = await db
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: ctx.at,
        result: {
          status: 'cancelled',
          reason: SUPERSEDED_BY_REATTACH_REASON,
          cancelledBy: 'install_incarnation_boundary',
        },
        ...terminalPayloadErasureSet(),
      })
      .where(and(inArray(deviceCommands.id, open.map((row) => row.id)), earlierIncarnation))
      .returning({ id: deviceCommands.id });

    const cancelledIds = new Set(cancelled.map((row) => row.id));
    await propagateCancelledDeviceCommands(
      open
        .filter((row) => cancelledIds.has(row.id))
        .map((row) => ({
          id: row.id,
          type: row.type,
          payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
            ? (row.payload as Record<string, unknown>)
            : null,
        })),
      ctx.at,
      db,
    );
    return { device_commands: cancelled.length };
  },
};
