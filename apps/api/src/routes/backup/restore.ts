import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { backupSnapshotFiles, backupSnapshots, restoreJobs, devices, deviceCommands } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { CommandTypes, queueBackupStopCommand, queueCommandForExecution } from '../../services/commandQueue';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { restoreListSchema, restoreSchema } from './schemas';

export const restoreRoutes = new Hono();

function mapDispatchErrorStatus(error: string): number {
  return error.startsWith('Device is ') ? 409 : 502;
}

function dispatchFailureReason(error: string): string {
  return error.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed';
}

async function markRestoreJobFailed(restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await runOutsideDbContext(async () => {
    await db
      .update(restoreJobs)
      .set({
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
          'error', ${error},
          'result', jsonb_build_object(
            'status', 'failed',
            'error', ${error}
          )
        )`,
      })
      .where(eq(restoreJobs.id, restoreJobId));
  });
}

async function removeQueuedRestoreDispatch(commandId: string | null | undefined): Promise<boolean> {
  if (!commandId) return false;
  const deleted = await runOutsideDbContext(async () =>
    db
      .delete(deviceCommands)
      .where(and(
        eq(deviceCommands.id, commandId),
        eq(deviceCommands.status, 'pending'),
      ))
      .returning({ id: deviceCommands.id })
  );
  return deleted.length > 0;
}

restoreRoutes.get(
  '/restore',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', restoreListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const conditions = [eq(restoreJobs.orgId, orgId)];

    if (query.deviceId) {
      conditions.push(eq(restoreJobs.deviceId, query.deviceId));
    }
    if (query.snapshotId) {
      conditions.push(eq(restoreJobs.snapshotId, query.snapshotId));
    }
    if (query.status) {
      conditions.push(eq(restoreJobs.status, query.status));
    }
    if (query.from) {
      const fromDate = new Date(query.from);
      if (!Number.isNaN(fromDate.getTime())) {
        conditions.push(gte(restoreJobs.createdAt, fromDate));
      }
    }
    if (query.to) {
      const toDate = new Date(query.to);
      if (!Number.isNaN(toDate.getTime())) {
        conditions.push(lte(restoreJobs.createdAt, toDate));
      }
    }

    const rows = await db
      .select()
      .from(restoreJobs)
      .where(and(...conditions))
      .orderBy(desc(restoreJobs.createdAt))
      .limit(query.limit);

    return c.json({ data: rows.map(toRestoreResponse) });
  }
);

restoreRoutes.get(
  '/restore/:id',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const restoreId = c.req.param('id')!;
    const [row] = await db
      .select()
      .from(restoreJobs)
      .where(and(eq(restoreJobs.id, restoreId), eq(restoreJobs.orgId, orgId)))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Restore job not found' }, 404);
    }

    return c.json({ data: toRestoreResponse(row) });
  }
);

restoreRoutes.post(
  '/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', restoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    // Verify snapshot exists and belongs to this org
    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(
        and(
          eq(backupSnapshots.id, payload.snapshotId),
          eq(backupSnapshots.orgId, orgId)
        )
      )
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    if (payload.restoreType === 'selective') {
      const snapshotFiles = await db
        .select({ id: backupSnapshotFiles.id, sourcePath: backupSnapshotFiles.sourcePath })
        .from(backupSnapshotFiles)
        .where(eq(backupSnapshotFiles.snapshotDbId, snapshot.id));

      if (snapshotFiles.length === 0) {
        return c.json({ error: 'Selective restore is unavailable for snapshots without indexed files' }, 409);
      }

      const availablePaths = new Set(snapshotFiles.map((row) => row.sourcePath));
      const invalidPath = payload.selectedPaths?.find((path) => !availablePaths.has(path));
      if (invalidPath) {
        return c.json({ error: `Selected path is not available in this snapshot: ${invalidPath}` }, 400);
      }
    }

    const now = new Date();
    const targetDeviceId = payload.deviceId ?? snapshot.deviceId;
    const [targetDevice] = await db
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(and(eq(devices.id, targetDeviceId), eq(devices.orgId, orgId)))
      .limit(1);

    if (!targetDevice) {
      return c.json({ error: 'Target device not found' }, 404);
    }

    if (targetDevice.status !== 'online') {
      recordBackupDispatchFailure('manual_restore', 'device_offline');
      return c.json({ error: `Device is ${targetDevice.status}, cannot execute command` }, 409);
    }

    const [row] = await runOutsideDbContext(async () =>
      db
        .insert(restoreJobs)
        .values({
          orgId,
          snapshotId: snapshot.id,
          deviceId: targetDeviceId,
          restoreType: payload.restoreType,
          targetPath: payload.targetPath ?? null,
          selectedPaths: payload.restoreType === 'selective' ? (payload.selectedPaths ?? []) : [],
          status: 'pending',
          initiatedBy: c.get('auth')?.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    );

    if (!row) {
      return c.json({ error: 'Failed to create restore job' }, 500);
    }

    let responseRow = row;

    try {
      const { command, error } = await runOutsideDbContext(() =>
        queueCommandForExecution(
          row.deviceId,
          CommandTypes.BACKUP_RESTORE,
          {
            restoreJobId: row.id,
            snapshotId: snapshot.snapshotId,
            targetPath: row.targetPath ?? '',
            selectedPaths: payload.restoreType === 'selective' ? (payload.selectedPaths ?? []) : [],
          },
          { userId: auth?.user?.id ?? undefined }
        )
      );

      if (error) {
        recordBackupDispatchFailure('manual_restore', dispatchFailureReason(error));
        await markRestoreJobFailed(row.id, error);
        writeRouteAudit(c, {
          orgId,
          action: 'backup.restore.create',
          resourceType: 'restore_job',
          resourceId: row.id,
          details: {
            snapshotId: snapshot.id,
            deviceId: row.deviceId,
            restoreType: row.restoreType,
            error,
          },
          result: 'failure',
        });
        return c.json({ error }, mapDispatchErrorStatus(error) as any);
      }

      if (!command?.id) {
        const fallbackError = 'Restore command was queued without a command ID';
        recordBackupDispatchFailure('manual_restore', 'missing_command_id');
        await markRestoreJobFailed(row.id, fallbackError);
        writeRouteAudit(c, {
          orgId,
          action: 'backup.restore.create',
          resourceType: 'restore_job',
          resourceId: row.id,
          details: {
            snapshotId: snapshot.id,
            deviceId: row.deviceId,
            restoreType: row.restoreType,
            error: fallbackError,
          },
          result: 'failure',
        });
        return c.json({ error: fallbackError }, 502);
      }

      const [updatedRestoreJob] = await runOutsideDbContext(async () =>
        db
          .update(restoreJobs)
          .set({
            commandId: command.id,
            status: command.status === 'sent' ? 'running' : row.status,
            startedAt: command.status === 'sent' ? now : row.startedAt,
            updatedAt: new Date(),
          })
          .where(eq(restoreJobs.id, row.id))
          .returning()
      );

      if (updatedRestoreJob) {
        responseRow = updatedRestoreJob;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to dispatch restore command to agent';
      console.error('[BackupRestore] Failed to dispatch restore:', err);
      recordBackupDispatchFailure('manual_restore', 'enqueue_failed');
      await markRestoreJobFailed(row.id, error);
      writeRouteAudit(c, {
        orgId,
        action: 'backup.restore.create',
        resourceType: 'restore_job',
        resourceId: row.id,
        details: {
          snapshotId: snapshot.id,
          deviceId: row.deviceId,
          restoreType: row.restoreType,
          error,
        },
        result: 'failure',
      });
      return c.json({ error }, 502);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.restore.create',
      resourceType: 'restore_job',
      resourceId: row.id,
      details: {
        snapshotId: snapshot.id,
        deviceId: row.deviceId,
        restoreType: row.restoreType,
      },
    });

    return c.json(toRestoreResponse(responseRow), 201);
  }
);

restoreRoutes.post(
  '/restore/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const restoreId = c.req.param('id')!;
    const [current] = await db
      .select()
      .from(restoreJobs)
      .where(and(eq(restoreJobs.id, restoreId), eq(restoreJobs.orgId, orgId)))
      .limit(1);

    if (!current) {
      return c.json({ error: 'Restore job not found' }, 404);
    }

    if (current.status !== 'pending' && current.status !== 'running') {
      return c.json({ error: 'Restore job is not cancelable' }, 409);
    }

    const reason = 'Cancelled by user';
    const now = new Date();
    const [row] = await runOutsideDbContext(async () =>
      db
        .update(restoreJobs)
        .set({
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
          targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
            'error', ${reason},
            'result', jsonb_build_object(
              'status', 'cancelled',
              'error', ${reason}
            )
          )`,
        })
        .where(and(
          eq(restoreJobs.id, restoreId),
          inArray(restoreJobs.status, ['pending', 'running']),
        ))
        .returning()
    );

    if (!row) {
      return c.json({ error: 'Restore job is not cancelable' }, 409);
    }

    let dispatchRemoved = false;
    if (current.commandId) {
      try {
        dispatchRemoved = await removeQueuedRestoreDispatch(current.commandId);
      } catch (err) {
        console.warn(`[BackupRestore] Failed to remove queued dispatch for restore ${row.id}:`, err);
      }
    }

    let stopQueued = false;
    if (current.status === 'running' || (current.status === 'pending' && !dispatchRemoved)) {
      try {
        const { error } = await queueBackupStopCommand(row.deviceId, {
          userId: auth?.user?.id ?? undefined,
        });
        stopQueued = !error;
        if (error) {
          console.warn(`[BackupRestore] Failed to queue backup_stop for restore ${row.id}: ${error}`);
        }
      } catch (err) {
        console.warn(`[BackupRestore] Failed to queue backup_stop for restore ${row.id}:`, err);
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.restore.cancel',
      resourceType: 'restore_job',
      resourceId: row.id,
      details: {
        deviceId: row.deviceId,
        dispatchRemoved,
        stopQueued,
      },
    });

    const data = toRestoreResponse(row);
    if (current.status === 'running' && !stopQueued) {
      return c.json({ data, warning: 'Restore marked as cancelled but the stop signal could not be delivered to the agent. The restore may still be running on the device.' });
    }
    return c.json({ data });
  }
);

function toRestoreResponse(row: typeof restoreJobs.$inferSelect) {
  const targetConfig =
    row.targetConfig && typeof row.targetConfig === 'object' && !Array.isArray(row.targetConfig)
      ? row.targetConfig as Record<string, unknown>
      : {};
  const targetError = typeof targetConfig.error === 'string' && targetConfig.error.trim()
    ? targetConfig.error
    : null;
  const resultDetails =
    targetConfig.result && typeof targetConfig.result === 'object' && !Array.isArray(targetConfig.result)
      ? targetConfig.result as Record<string, unknown>
      : targetError
        ? {
            commandType: typeof targetConfig.commandType === 'string' ? targetConfig.commandType : undefined,
            status: row.status,
            error: targetError,
          }
        : null;
  const errorSummary = resultDetails
    ? typeof resultDetails.error === 'string' && resultDetails.error.trim()
      ? resultDetails.error
      : typeof resultDetails.stderr === 'string' && resultDetails.stderr.trim()
        ? resultDetails.stderr
        : Array.isArray(resultDetails.warnings) && resultDetails.warnings.length > 0
          ? String(resultDetails.warnings[0])
          : targetError
            ? targetError
            : null
    : targetError;

  return {
    id: row.id,
    snapshotId: row.snapshotId,
    deviceId: row.deviceId,
    restoreType: row.restoreType,
    selectedPaths: row.selectedPaths ?? [],
    status: row.status,
    targetPath: row.targetPath ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    restoredSize: row.restoredSize ?? null,
    restoredFiles: row.restoredFiles ?? null,
    commandId: row.commandId ?? null,
    errorSummary,
    resultDetails,
  };
}
