import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { backupSnapshotFiles, backupSnapshots, restoreJobs, devices, deviceCommands } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { CommandTypes, queueBackupStopCommand, queueCommandForExecution } from '../../services/commandQueue';
import { PERMISSIONS } from '../../services/permissions';
import { resolveBackupProviderConfig, resolveBackupDestinationError } from '../../services/backupProviderConfig';
import { backupReadCredentialPayload } from '../../services/backupCommandCredentials';
import { resolveScopedOrgId } from './helpers';
import { attachDeviceNames, restoreModeFromTargetConfig } from './deviceNames';
import { restoreListSchema, restoreSchema } from './schemas';
import { resolveSelectedSnapshotPaths, selectedSnapshotPathError } from '../../services/backupSelectedPaths';
import {
  authorizeRouteResilienceResources,
  resolveRouteAuthorizedDeviceIds,
} from './resilienceAuthorization';
import { BareMetalRecoveryError, cancelBareMetalRecovery } from '../../services/bareMetalRecoveryService';
import { isBackupHelperUpdateRequiredError } from '../../services/backupReadHelperGate';
import { isRestoreHelperUpdateRequiredError } from '../../services/backupRestoreGate';
import { randomUUID } from 'node:crypto';
import { checkRestoreIntegrityRequest, recordRequestAuthorization, restoreIntegrityResponse } from './restoreIntegrityGate';

export const restoreRoutes = new Hono();

function runInOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      fn
    )
  );
}

function isHelperUpdateRequired(error: string): boolean {
  return isBackupHelperUpdateRequiredError(error) || isRestoreHelperUpdateRequiredError(error);
}

function mapDispatchErrorStatus(error: string): number {
  // Both are states of the target device the operator can act on, not
  // dispatch failures.
  return error.startsWith('Device is ') || isHelperUpdateRequired(error) ? 409 : 502;
}

function dispatchFailureReason(error: string): string {
  if (isHelperUpdateRequired(error)) return 'helper_update_required';
  return error.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed';
}

async function markRestoreJobFailed(orgId: string, restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await runInOrg(orgId, async () => {
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

// Cancels a not-yet-delivered restore dispatch. Runs outside the caller's
// tenant transaction (device_commands has no RLS and the dispatcher may have
// committed the row after that transaction began), but under an explicit
// system context so the DELETE is not a contextless bare-pool write (#1375) —
// same shape as the agent result paths in agentWs.ts and agents/commands.ts.
async function removeQueuedRestoreDispatch(commandId: string | null | undefined): Promise<boolean> {
  if (!commandId) return false;
  const deleted = await runOutsideDbContext(async () =>
    withSystemDbAccessContext(async () =>
      db
        .delete(deviceCommands)
        .where(and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
        ))
        .returning({ id: deviceCommands.id })
    )
  );
  return deleted.length > 0;
}

restoreRoutes.get(
  '/restore',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', restoreListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const conditions = [eq(restoreJobs.orgId, orgId)];

    if (query.deviceId) {
      conditions.push(eq(restoreJobs.deviceId, query.deviceId));
    }

    const allowedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
    if (allowedDeviceIds) {
      if (query.deviceId && !allowedDeviceIds.includes(query.deviceId)) {
        return c.json({ error: 'site_access_denied' }, 403);
      }
      if (allowedDeviceIds.length === 0) {
        return c.json({ data: [] });
      }
      conditions.push(inArray(restoreJobs.deviceId, allowedDeviceIds));
      // D17 (2026-10-15-140004): restore_jobs.snapshot_id is now ON DELETE
      // SET NULL, so a retention-expired snapshot leaves the job row behind
      // with snapshot_id: null. A bare EXISTS keyed off snapshot_id can never
      // match a NULL join key, so without the `is null` arm this predicate
      // silently dropped every null-snapshot job from site-scoped listings —
      // even though the `inArray(restoreJobs.deviceId, allowedDeviceIds)`
      // condition just above it already fully bounds the row to an allowed
      // device on its own.
      conditions.push(sql`(
        ${restoreJobs.snapshotId} is null
        or exists (
          select 1
          from ${backupSnapshots}
          where ${backupSnapshots.id} = ${restoreJobs.snapshotId}
            and ${backupSnapshots.orgId} = ${restoreJobs.orgId}
            and ${inArray(backupSnapshots.deviceId, allowedDeviceIds)}
        )
      )`);
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

    return c.json({ data: await attachDeviceNames(orgId, rows.map(toRestoreResponse)) });
  }
);

restoreRoutes.get(
  '/restore/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const restoreId = c.req.param('id')!;
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'restore_job', id: restoreId, role: 'source' },
      { kind: 'restore_job', id: restoreId, role: 'target' },
    ], 'read');
    if (!authorization.ok) return authorization.response;

    const [row] = await db
      .select()
      .from(restoreJobs)
      .where(and(eq(restoreJobs.id, restoreId), eq(restoreJobs.orgId, orgId)))
      .limit(1);

    if (!row) {
      return c.json({ error: 'Restore job not found' }, 404);
    }

    const [withName] = await attachDeviceNames(orgId, [toRestoreResponse(row)]);
    return c.json({ data: withName });
  }
);

restoreRoutes.post(
  '/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', restoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: payload.snapshotId, role: 'source' },
      payload.deviceId
        ? { kind: 'device', id: payload.deviceId, role: 'target' }
        : { kind: 'snapshot', id: payload.snapshotId, role: 'target' },
    ], 'restore');
    if (!authorization.ok) return authorization.response;

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

    let selectedPaths: string[] = [];
    if (payload.restoreType === 'selective') {
      const snapshotFiles = await db
        .select({ id: backupSnapshotFiles.id, sourcePath: backupSnapshotFiles.sourcePath })
        .from(backupSnapshotFiles)
        .where(eq(backupSnapshotFiles.snapshotDbId, snapshot.id));

      if (snapshotFiles.length === 0) {
        return c.json({ error: 'Selective restore is unavailable for snapshots without indexed files' }, 409);
      }

      // The browse tree shows forward-slash paths; map each selection back to
      // the stored original the agent indexed (and matches against).
      const resolution = resolveSelectedSnapshotPaths(
        payload.selectedPaths ?? [],
        snapshotFiles.map((row) => row.sourcePath)
      );
      if (!resolution.ok) {
        return c.json({ error: selectedSnapshotPathError(resolution) }, 400);
      }
      selectedPaths = resolution.paths;
    }

    const now = new Date();
    const resolvedTargetDeviceId = payload.deviceId ?? snapshot.deviceId;
    const [targetDevice] = await db
      .select({ id: devices.id, status: devices.status, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.id, resolvedTargetDeviceId), eq(devices.orgId, orgId)))
      .limit(1);

    if (!targetDevice) {
      return c.json({ error: 'Target device not found' }, 404);
    }
    if (targetDevice.status !== 'online') {
      recordBackupDispatchFailure('manual_restore', 'device_offline');
      return c.json({ error: `Device is ${targetDevice.status}, cannot execute command` }, 409);
    }

    // The agent needs the same provider + providerConfig the BACKUP command
    // used to write this snapshot, so it can build a storage provider to
    // read it back. Fail loudly rather than dispatch a config-less restore
    // that the agent can't act on.
    const backupProviderConfig = snapshot.configId
      ? await resolveBackupProviderConfig(snapshot.configId, orgId)
      : null;
    if (!backupProviderConfig) {
      // Distinguish a legacy snapshot (configId never recorded → cannot be
      // auto-restored) from a genuine misconfiguration, so operators aren't
      // misled into hunting a "missing config" that never existed. We do NOT
      // fall back to the device's current config — the snapshot's objects may
      // live at a different destination than the device backs up to today.
      const { reason, message } = resolveBackupDestinationError(snapshot.configId);
      recordBackupDispatchFailure(
        'manual_restore',
        reason === 'legacy_snapshot' ? 'snapshot_predates_config_tracking' : 'missing_provider_config'
      );
      return c.json({ error: message, reason }, 422);
    }

    // Integrity (routes/backup/restoreIntegrityGate.ts): decided before
    // anything is created. A restore of a snapshot without a usable
    // attestation needs a step-up; once consumed, its authorization is
    // recorded bound to the command id reserved here, before the command
    // exists, so delivery can find it.
    const integrityRequest = {
      orgId,
      snapshotDbId: snapshot.id,
      targetDeviceId: resolvedTargetDeviceId,
      commandType: CommandTypes.BACKUP_RESTORE,
      stepUpGrant: payload.stepUpGrant,
      confirmUnattestedRestore: payload.confirmUnattestedRestore,
      executingDeviceId: resolvedTargetDeviceId,
    };
    const integrityCheck = await checkRestoreIntegrityRequest(c, integrityRequest);
    if (!integrityCheck.ok) {
      recordBackupDispatchFailure('manual_restore', 'integrity_refused');
      return restoreIntegrityResponse(c, integrityCheck);
    }
    let reservedCommandId: string | undefined;
    if (integrityCheck.authorizationReason) {
      reservedCommandId = randomUUID();
      await recordRequestAuthorization(c, integrityRequest, integrityCheck.authorizationReason, { commandId: reservedCommandId }, {
        confirmationMethod: integrityCheck.confirmationMethod,
      });
    }

    const [row] = await runInOrg(orgId, async () =>
      db
        .insert(restoreJobs)
        .values({
          orgId,
          snapshotId: snapshot.id,
          deviceId: resolvedTargetDeviceId,
          restoreType: payload.restoreType,
          targetPath: payload.targetPath ?? null,
          selectedPaths,
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
      const { command, error } = await runInOrg(orgId, () =>
        queueCommandForExecution(
          row.deviceId,
          CommandTypes.BACKUP_RESTORE,
          {
            restoreJobId: row.id,
            snapshotId: snapshot.snapshotId,
            targetPath: row.targetPath ?? '',
            selectedPaths,
            // A reference only: the destination is resolved when the command
            // is delivered, so it is never written to the command row.
            ...backupReadCredentialPayload(snapshot.configId!, orgId, backupProviderConfig.provider),
          },
          {
            userId: auth?.user?.id ?? undefined,
            ...(reservedCommandId ? { commandId: reservedCommandId } : {}),
          }
        )
      );

      if (error) {
        recordBackupDispatchFailure('manual_restore', dispatchFailureReason(error));
        await markRestoreJobFailed(orgId, row.id, error);
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
        await markRestoreJobFailed(orgId, row.id, fallbackError);
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

      const [updatedRestoreJob] = await runInOrg(orgId, async () =>
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
      await markRestoreJobFailed(orgId, row.id, error);
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
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const restoreId = c.req.param('id')!;
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'restore_job', id: restoreId, role: 'source' },
      { kind: 'restore_job', id: restoreId, role: 'target' },
    ], 'revoke');
    if (!authorization.ok) return authorization.response;

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

    // A rebuild-engine job owns a bare-metal recovery that holds the device's
    // "one non-terminal recovery" slot. backup_stop does not stop a rebuild, so
    // only a rebuild still queued (command not yet delivered) can be cancelled;
    // once running the host is mid-rebuild and cancelling would be a lie.
    const config = current.targetConfig as Record<string, unknown> | null;
    const rebuildRecoveryId =
      config && config.engine === 'rebuild' && typeof config.recoveryId === 'string'
        ? config.recoveryId
        : null;
    let rebuildDispatchRemoved = false;
    if (rebuildRecoveryId) {
      if (current.status === 'running') {
        return c.json({ error: 'A rebuild that is already running cannot be cancelled' }, 409);
      }
      if (current.commandId) {
        try {
          rebuildDispatchRemoved = await removeQueuedRestoreDispatch(current.commandId);
        } catch (err) {
          console.error(`[BackupRestore] Failed to remove queued rebuild dispatch for restore ${current.id}:`, err);
          return c.json({ error: 'Could not remove the queued rebuild command; try again' }, 503);
        }
        if (!rebuildDispatchRemoved) {
          return c.json({ error: 'The rebuild command was already delivered and cannot be cancelled' }, 409);
        }
      }
    }

    const reason = 'Cancelled by user';
    const now = new Date();
    const [row] = await runInOrg(orgId, async () =>
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

    let recoveryCloseFailed = false;
    if (rebuildRecoveryId) {
      // Free the device's recovery slot so the next rebuild isn't refused.
      try {
        await cancelBareMetalRecovery({
          recoveryId: rebuildRecoveryId,
          orgId,
          userId: auth?.user?.id ?? null,
          reason,
        });
      } catch (err) {
        // invalid_state = recovery already terminal, which is the goal state.
        if (!(err instanceof BareMetalRecoveryError && err.code === 'invalid_state')) {
          recoveryCloseFailed = true;
          console.error(`[BackupRestore] Failed to close bare-metal recovery ${rebuildRecoveryId} for restore ${row.id}:`, err);
        }
      }
    }

    let dispatchRemoved = rebuildDispatchRemoved;
    if (current.commandId && !rebuildRecoveryId) {
      try {
        dispatchRemoved = await removeQueuedRestoreDispatch(current.commandId);
      } catch (err) {
        console.warn(`[BackupRestore] Failed to remove queued dispatch for restore ${row.id}:`, err);
      }
    }

    let stopQueued = false;
    if (!rebuildRecoveryId && (current.status === 'running' || (current.status === 'pending' && !dispatchRemoved))) {
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
        ...(rebuildRecoveryId ? { recoveryClosed: !recoveryCloseFailed } : {}),
      },
    });

    const data = toRestoreResponse(row);
    if (recoveryCloseFailed) {
      return c.json({ data, warning: 'Rebuild cancelled but its bare-metal recovery could not be closed; the device may refuse a new rebuild until it is cancelled from Recoveries.' });
    }
    if (current.status === 'running' && !stopQueued) {
      return c.json({ data, warning: 'Restore marked as cancelled but the stop signal could not be delivered to the agent. The restore may still be running on the device.' });
    }
    return c.json({ data });
  }
);

// Advisory restore warnings describe how a restore ran rather than why it
// failed. Mirrors isAdvisoryRestoreWarning in the web RestoreResultNotices.
function isAdvisoryRestoreWarning(warning: string): boolean {
  const trimmed = warning.trim();
  return (
    trimmed.startsWith('system_state_requires_rebuild:') ||
    trimmed.includes('unattested snapshot: files were not checked against a snapshot attestation') ||
    trimmed.startsWith('vault copy differs from backup; restored from primary storage')
  );
}

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
  // Warnings on a completed restore, and advisory warnings on any restore
  // (e.g. an unattested snapshot), are shown as warnings, never as the error
  // summary.
  const summaryWarning = row.status !== 'completed' && Array.isArray(resultDetails?.warnings)
    ? resultDetails.warnings.find(
        (warning): warning is string => typeof warning === 'string' && warning.trim() !== '' && !isAdvisoryRestoreWarning(warning)
      ) ?? null
    : null;
  const errorSummary = resultDetails
    ? typeof resultDetails.error === 'string' && resultDetails.error.trim()
      ? resultDetails.error
      : typeof resultDetails.stderr === 'string' && resultDetails.stderr.trim()
        ? resultDetails.stderr
        : summaryWarning
          ? summaryWarning
          : targetError
            ? targetError
            : null
    : targetError;

  return {
    id: row.id,
    snapshotId: row.snapshotId,
    deviceId: row.deviceId,
    restoreType: row.restoreType,
    // Restore-as-VM / instant boot persist restoreType 'full'; expose the mode so
    // the UI does not label them "full restore" (#7213).
    restoreMode: restoreModeFromTargetConfig(row.targetConfig),
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
