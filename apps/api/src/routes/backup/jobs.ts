import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { backupJobs, backupConfigs, devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { createManualBackupJobIfIdle } from '../../services/backupJobCreation';
import { removeQueuedBackupDispatch } from '../../jobs/backupEnqueue';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { resolveBackupConfigForDevice, resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { queueBackupStopCommand } from '../../services/commandQueue';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { jobListSchema } from './schemas';

export const jobsRoutes = new Hono();

function canAccessDeviceSite(device: { siteId?: string | null }, permissions: UserPermissions | undefined): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId);
}

async function canAccessDeviceIdSite(orgId: string, deviceId: string, permissions: UserPermissions | undefined): Promise<boolean> {
  if (!permissions?.allowedSiteIds) return true;
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return Boolean(device && canAccessDeviceSite(device, permissions));
}

async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices).where(eq(devices.orgId, orgId));
  return orgDevices.filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId)).map((d) => d.id);
}

async function markBackupJobDispatchFailed(jobId: string, error: string) {
  const now = new Date();
  await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorLog: error,
    })
    .where(eq(backupJobs.id, jobId));
}

jobsRoutes.get('/jobs', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('query', jobListSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const deviceFilter = query.deviceId ?? query.device;
  const perms = c.get('permissions') as UserPermissions | undefined;

  const conditions = [eq(backupJobs.orgId, orgId)];

  if (query.status) {
    conditions.push(eq(backupJobs.status, query.status as any));
  }

  if (deviceFilter) {
    conditions.push(eq(backupJobs.deviceId, deviceFilter));
  }

  if (perms?.allowedSiteIds) {
    const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
    if (deviceFilter && !allowedDeviceIds!.includes(deviceFilter)) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }
    if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
      return c.json({ data: [] });
    }
    conditions.push(inArray(backupJobs.deviceId, allowedDeviceIds));
  }

  if (query.from) {
    const fromDate = new Date(query.from);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(backupJobs.createdAt, fromDate));
    }
  }

  if (query.to) {
    const toDate = new Date(query.to);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lte(backupJobs.createdAt, toDate));
    }
  }

  if (query.date) {
    const datePrefix = query.date.slice(0, 10);
    conditions.push(
      sql`${backupJobs.createdAt}::date = ${datePrefix}::date`
    );
  }

  const rows = await db
    .select({
      job: backupJobs,
      deviceName: devices.displayName,
      deviceHostname: devices.hostname,
      siteId: devices.siteId,
      configName: backupConfigs.name,
    })
    .from(backupJobs)
    .leftJoin(devices, eq(backupJobs.deviceId, devices.id))
    .leftJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
    .where(and(...conditions))
    .orderBy(desc(backupJobs.createdAt));

  return c.json({
    data: rows.map((r) => ({
      ...toJobResponse(r.job),
      deviceName: r.deviceName ?? r.deviceHostname ?? null,
      configName: r.configName ?? null,
    })),
  });
});

jobsRoutes.get('/jobs/:id', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id')!;
  const [row] = await db
    .select({
      job: backupJobs,
      deviceName: devices.displayName,
      deviceHostname: devices.hostname,
      siteId: devices.siteId,
      configName: backupConfigs.name,
    })
    .from(backupJobs)
    .leftJoin(devices, eq(backupJobs.deviceId, devices.id))
    .leftJoin(backupConfigs, eq(backupJobs.configId, backupConfigs.id))
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!canAccessDeviceSite({ siteId: row.siteId }, c.get('permissions') as UserPermissions | undefined)) {
    return c.json({ error: 'Device not found or access denied' }, 403);
  }
  return c.json({
    ...toJobResponse(row.job),
    deviceName: row.deviceName ?? row.deviceHostname ?? null,
    configName: row.configName ?? null,
  });
});

jobsRoutes.post(
  '/jobs/run/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId')!;
  const [targetDevice] = await db
    .select({ id: devices.id, status: devices.status, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);

  if (!targetDevice) {
    return c.json({ error: 'Device not found' }, 404);
  }
  if (!canAccessDeviceSite(targetDevice, c.get('permissions') as UserPermissions | undefined)) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  if (targetDevice.status !== 'online') {
    recordBackupDispatchFailure('manual_backup', 'device_offline');
    return c.json({ error: `Device is ${targetDevice.status}, cannot execute backup` }, 409);
  }

  // Resolve backup config via configuration policy system
  const resolved = await resolveBackupConfigForDevice(deviceId);
  let configId = resolved?.configId ?? null;
  let featureLinkId = resolved?.featureLinkId ?? null;

  // Broken profile link — refuse loudly. Falling through to the legacy fallback
  // below would run a single empty file job and report success, so the tech
  // would believe the server was backed up.
  if (resolved?.selectionError) {
    console.error(
      `[BackupJobs] Manual run for device ${deviceId} (link ${resolved.featureLinkId}): ${resolved.selectionError}`
    );
    return c.json(
      { error: 'The backup profile linked to this device\'s policy has no usable data sources. Fix the profile before running a backup.' },
      400
    );
  }

  if (resolved && !configId) {
    return c.json({ error: 'Backup policy assigned but no backup config linked. Update the configuration policy.' }, 400);
  }

  // Only fallback if NO policy assignment at all
  if (!configId) {
    const [fallbackConfig] = await db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(eq(backupConfigs.orgId, orgId))
      .limit(1);
    configId = fallbackConfig?.id ?? null;
  }

  if (!configId) {
    return c.json({ error: 'No backup config available' }, 400);
  }

  // Profile fan-out: one manual job per enabled selection (idle-checked per
  // device+mode). Legacy custom links create a single NULL-mode job as before.
  const specs = resolved?.selectionSpecs ?? [undefined];
  const createdJobs: Array<NonNullable<Awaited<ReturnType<typeof createManualBackupJobIfIdle>>>['job']> = [];

  // A job row that is created but never enqueued sits `pending` forever, and
  // its device+mode idle check then blocks every future manual run of that
  // mode. Whenever we bail out mid-fan-out, fail the rows we already created.
  const failCreatedJobs = async (error: string): Promise<void> => {
    for (const job of createdJobs) {
      await markBackupJobDispatchFailed(job.id, error);
    }
  };

  for (const spec of specs) {
    const result = await createManualBackupJobIfIdle({
      orgId,
      configId,
      featureLinkId,
      deviceId,
      ...(spec ? { backupMode: spec.backupMode, modeTargets: spec.targets } : {}),
    });
    if (!result) {
      const error = 'Failed to create backup job';
      await failCreatedJobs(error);
      return c.json({ error }, 500);
    }
    if (result.created) {
      createdJobs.push(result.job);
    }
  }

  if (createdJobs.length === 0) {
    return c.json({ error: 'A backup job is already pending or running for this device' }, 409);
  }

  // Enqueue BullMQ dispatch for each created job
  const { enqueueBackupDispatch } = await import(
    '../../jobs/backupWorker'
  );
  for (const [index, row] of createdJobs.entries()) {
    try {
      await enqueueBackupDispatch(row.id, row.configId, orgId, deviceId);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to enqueue backup dispatch';
      console.error('[BackupJobs] Failed to enqueue dispatch:', err);
      recordBackupDispatchFailure('manual_backup', 'enqueue_failed');
      // This job and every one after it in the fan-out never reached the queue.
      for (const stranded of createdJobs.slice(index)) {
        await markBackupJobDispatchFailed(stranded.id, error);
      }
      writeRouteAudit(c, {
        orgId,
        action: 'backup.job.run',
        resourceType: 'backup_job',
        resourceId: row.id,
        details: { deviceId, configId, featureLinkId, error },
        result: 'failure',
      });
      return c.json({ error }, 502);
    }
  }

  const row = createdJobs[0]!;
  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run',
    resourceType: 'backup_job',
    resourceId: row.id,
    details: { deviceId, configId, featureLinkId, jobCount: createdJobs.length },
  });

  return c.json(
    {
      ...toJobResponse(row),
      jobs: createdJobs.map((job) => toJobResponse(job)),
      jobCount: createdJobs.length,
    },
    201
  );
});

jobsRoutes.get('/jobs/run-all/preview', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const assigned = await resolveAllBackupAssignedDevices(orgId);
  const deviceIds = new Set(assigned.filter((a) => a.configId).map((a) => a.deviceId));

  if (deviceIds.size === 0) {
    return c.json({ data: { deviceCount: 0, deviceIds: [], alreadyRunning: 0 } });
  }

  const onlineDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(devices.id, Array.from(deviceIds)),
        eq(devices.status, 'online')
      )
    );
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const onlineDeviceIds = new Set(
    onlineDevices.filter((device) => canAccessDeviceSite(device, permissions)).map((device) => device.id)
  );

  // Check which devices already have a running/pending job
  const activeJobs = await db
    .select({ deviceId: backupJobs.deviceId })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.orgId, orgId),
        sql`${backupJobs.status} IN ('running', 'pending')`
      )
    );
  const activeDeviceIds = new Set(activeJobs.map((j) => j.deviceId));

  const eligibleIds = Array.from(deviceIds).filter((id) => onlineDeviceIds.has(id) && !activeDeviceIds.has(id));
  const offlineDeviceIds = Array.from(deviceIds).filter((id) => !onlineDeviceIds.has(id));
  const alreadyRunningDeviceIds = Array.from(deviceIds).filter((id) => onlineDeviceIds.has(id) && activeDeviceIds.has(id));

  return c.json({
    data: {
      deviceCount: eligibleIds.length,
      deviceIds: eligibleIds,
      alreadyRunning: alreadyRunningDeviceIds.length,
      offline: offlineDeviceIds.length,
    },
  });
});

jobsRoutes.post(
  '/jobs/run-all',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const assigned = await resolveAllBackupAssignedDevices(orgId);
  const deviceConfigMap = new Map(
    assigned.filter((a) => a.configId).map((a) => [a.deviceId, { configId: a.configId!, featureLinkId: a.featureLinkId }])
  );

  if (deviceConfigMap.size === 0) {
    return c.json({ error: 'No devices have backup policies configured' }, 400);
  }

  const created: string[] = [];
  const skippedOffline: string[] = [];
  const skippedRunning: string[] = [];
  // Broken profile link, or no backup config could be resolved at all — same
  // "refuse loudly" contract as POST /jobs/run/:deviceId. These devices get
  // NO job (an empty job would report success while protecting nothing). Each
  // entry carries a `reason` so an operator can tell WHY from the response
  // alone (the single-device path distinguishes these; run-all used to fold
  // them into one opaque bucket).
  const skippedBrokenProfile: Array<{ deviceId: string; reason: 'broken_profile' | 'no_config' }> = [];
  const failed: string[] = [];
  // Job creation returned null (DB error or lost idle-check race). Distinct
  // from skippedRunning ("benign, already pending") and from created — a device
  // with ANY spec that failed to create surfaces here so the failure is visible
  // in the response body, not laundered into "already running" or hidden behind
  // a sibling spec that did create. `modes` lists which selections failed.
  const failedToCreate: Array<{ deviceId: string; modes: string[] }> = [];
  const deviceIds = Array.from(deviceConfigMap.keys());
  const onlineDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(devices.id, deviceIds),
        eq(devices.status, 'online')
      )
    );
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const onlineDeviceIds = new Set(
    onlineDevices.filter((device) => canAccessDeviceSite(device, permissions)).map((device) => device.id)
  );

  for (const [deviceId, { configId: fallbackConfigId, featureLinkId: fallbackFeatureLinkId }] of deviceConfigMap) {
    if (!onlineDeviceIds.has(deviceId)) {
      recordBackupDispatchFailure('manual_backup', 'device_offline');
      skippedOffline.push(deviceId);
      continue;
    }

    // Resolve backup config + selection specs via the same configuration
    // policy resolver the single-device run endpoint uses. deviceConfigMap's
    // configId/featureLinkId come from resolveAllBackupAssignedDevices (used
    // to build the eligible-device set above) and don't apply device role/OS
    // targeting filters, so resolveBackupConfigForDevice is the source of
    // truth here — its configId/featureLinkId/specs are used when available,
    // falling back to the map's values only if the resolver itself returns
    // nothing for this device.
    const resolved = await resolveBackupConfigForDevice(deviceId);

    // Broken profile link — refuse loudly. Falling through to the legacy
    // fallback would run a single empty file job and report success, so the
    // tech would believe the device was backed up.
    if (resolved?.selectionError) {
      console.error(
        `[BackupJobs] Run-all for device ${deviceId} (link ${resolved.featureLinkId}): ${resolved.selectionError}`
      );
      recordBackupDispatchFailure('manual_backup', 'selection_error');
      skippedBrokenProfile.push({ deviceId, reason: 'broken_profile' });
      continue;
    }

    const configId = resolved?.configId ?? fallbackConfigId;
    const featureLinkId = resolved?.featureLinkId ?? fallbackFeatureLinkId;

    if (!configId) {
      console.error(`[BackupJobs] Run-all for device ${deviceId}: no backup config could be resolved`);
      recordBackupDispatchFailure('manual_backup', 'no_config');
      skippedBrokenProfile.push({ deviceId, reason: 'no_config' });
      continue;
    }

    // Profile fan-out: one manual job per enabled selection (idle-checked per
    // device+mode), mirroring POST /jobs/run/:deviceId. Legacy custom links
    // create a single NULL-mode job as before.
    const specs = resolved?.selectionSpecs ?? [undefined];
    const deviceJobs: Array<NonNullable<Awaited<ReturnType<typeof createManualBackupJobIfIdle>>>['job']> = [];
    // Selections whose job creation returned null (DB error / lost idle race).
    const failedModes: string[] = [];

    for (const spec of specs) {
      const result = await createManualBackupJobIfIdle({
        orgId,
        configId,
        featureLinkId,
        deviceId,
        ...(spec ? { backupMode: spec.backupMode, modeTargets: spec.targets } : {}),
      });
      if (!result) {
        console.error(`[BackupJobs] Run-all: failed to create backup job for device ${deviceId}`);
        recordBackupDispatchFailure('manual_backup', 'create_failed');
        failedModes.push(spec?.backupMode ?? 'legacy');
        continue;
      }
      if (result.created) {
        deviceJobs.push(result.job);
      }
    }

    // Enqueue whatever WAS created for this device — a create failure on one
    // spec must not strand a sibling spec's real job (a created-but-unenqueued
    // row sits `pending` forever and blocks that mode's future manual runs).
    for (const job of deviceJobs) {
      try {
        const { enqueueBackupDispatch } = await import('../../jobs/backupWorker');
        await enqueueBackupDispatch(job.id, configId, orgId, deviceId);
        created.push(job.id);
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Failed to enqueue backup dispatch';
        console.error('[BackupJobs] Failed to enqueue dispatch:', err);
        recordBackupDispatchFailure('manual_backup', 'enqueue_failed');
        await markBackupJobDispatchFailed(job.id, error);
        failed.push(job.id);
      }
    }

    if (failedModes.length > 0) {
      // At least one selection failed to create. Surface the device explicitly
      // instead of laundering it into skippedRunning (if nothing created) or
      // hiding it behind the sibling jobs that did create.
      failedToCreate.push({ deviceId, modes: failedModes });
    } else if (deviceJobs.length === 0) {
      // Every spec already had an active job for this device+mode — benign,
      // nothing new to dispatch.
      skippedRunning.push(deviceId);
    }
  }

  const skipped = skippedOffline.length + skippedRunning.length + skippedBrokenProfile.length;

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run_all',
    resourceType: 'backup_job',
    resourceId: null,
    details: {
      created: created.length,
      skipped,
      skippedOffline: skippedOffline.length,
      skippedRunning: skippedRunning.length,
      skippedBrokenProfile: skippedBrokenProfile.length,
      failed: failed.length,
      failedToCreate: failedToCreate.length,
    },
    result:
      (failed.length > 0 || failedToCreate.length > 0) && created.length === 0
        ? 'failure'
        : 'success',
  });

  return c.json({
    data: {
      created: created.length,
      skipped,
      skippedOffline: skippedOffline.length,
      skippedRunning: skippedRunning.length,
      skippedBrokenProfile: skippedBrokenProfile.length,
      failed: failed.length,
      // Job-creation failures (DB error / lost idle race). Additive: distinct
      // from `skippedRunning` (benign) and `failed` (enqueue failure).
      failedToCreate: failedToCreate.length,
      jobIds: created,
      failedJobIds: failed,
      // Per-device detail so an operator can act from the response alone.
      failedToCreateDevices: failedToCreate,
      skippedBrokenProfileDevices: skippedBrokenProfile,
    },
  }, 201);
});

jobsRoutes.post(
  '/jobs/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id')!;
  const [current] = await db
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.orgId, orgId)))
    .limit(1);

  if (!current) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!(await canAccessDeviceIdSite(orgId, current.deviceId, c.get('permissions') as UserPermissions | undefined))) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  if (current.status !== 'running' && current.status !== 'pending') {
    return c.json({ error: 'Job is not cancelable' }, 409);
  }

  const now = new Date();
  const [row] = await db
    .update(backupJobs)
    .set({
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
      errorLog: 'Cancelled by user',
    })
    .where(and(
      eq(backupJobs.id, jobId),
      inArray(backupJobs.status, ['pending', 'running'])
    ))
    .returning();

  if (!row) {
    return c.json({ error: 'Job is not cancelable' }, 409);
  }

  let dispatchRemoved = false;
  try {
    dispatchRemoved = await removeQueuedBackupDispatch(row.id);
  } catch (err) {
    console.warn(`[BackupJobs] Failed to remove queued dispatch for job ${row.id}:`, err);
  }

  let stopQueued = false;
  if (current.status === 'running' || (current.status === 'pending' && !dispatchRemoved)) {
    try {
      const { error } = await queueBackupStopCommand(row.deviceId, {
        userId: auth?.user?.id ?? undefined,
      });
      stopQueued = !error;
      if (error) {
        console.warn(`[BackupJobs] Failed to queue backup_stop for job ${row.id}: ${error}`);
      }
    } catch (err) {
      console.warn(`[BackupJobs] Failed to queue backup_stop for job ${row.id}:`, err);
    }
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.cancel',
    resourceType: 'backup_job',
    resourceId: row.id,
    details: {
      deviceId: row.deviceId,
      dispatchRemoved,
      stopQueued,
    },
  });

  const response = toJobResponse(row);
  if (current.status === 'running' && !stopQueued) {
    return c.json({ ...response, warning: 'Job marked as cancelled but the stop signal could not be delivered to the agent. The backup may still be running on the device.' });
  }
  return c.json(response);
});

function toJobResponse(row: typeof backupJobs.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    deviceId: row.deviceId,
    configId: row.configId,
    policyId: row.policyId ?? null,
    featureLinkId: row.featureLinkId ?? null,
    snapshotId: row.snapshotId ?? null,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    totalSize: row.totalSize ?? null,
    transferredSize: row.transferredSize ?? null,
    fileCount: row.fileCount ?? null,
    totalFiles: row.totalFiles ?? null,
    lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
    referencedSize: row.referencedSize ?? null,
    referencedFiles: row.referencedFiles ?? null,
    errorCount: row.errorCount ?? null,
    errorLog: row.errorLog ?? null,
  };
}
