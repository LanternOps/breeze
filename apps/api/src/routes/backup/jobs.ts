import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { backupJobs, backupConfigs, devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { createManualBackupJobIfIdle } from '../../services/backupJobCreation';
import { resolveBackupConfigForDevice, resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { jobListSchema } from './schemas';

export const jobsRoutes = new Hono();

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
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  const deviceFilter = query.deviceId ?? query.device;

  const conditions = [eq(backupJobs.orgId, orgId)];

  if (query.status) {
    conditions.push(eq(backupJobs.status, query.status as any));
  }

  if (deviceFilter) {
    conditions.push(eq(backupJobs.deviceId, deviceFilter));
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
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id')!;
  const [row] = await db
    .select({
      job: backupJobs,
      deviceName: devices.displayName,
      deviceHostname: devices.hostname,
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
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId')!;
  const [targetDevice] = await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);

  if (!targetDevice) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (targetDevice.status !== 'online') {
    return c.json({ error: `Device is ${targetDevice.status}, cannot execute backup` }, 409);
  }

  // Resolve backup config via configuration policy system
  const resolved = await resolveBackupConfigForDevice(deviceId);
  let configId = resolved?.configId ?? null;
  let featureLinkId = resolved?.featureLinkId ?? null;

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

  const result = await createManualBackupJobIfIdle({
    orgId,
    configId,
    featureLinkId,
    deviceId,
  });

  if (!result) {
    return c.json({ error: 'Failed to create backup job' }, 500);
  }

  if (!result.created) {
    return c.json({ error: 'A backup job is already pending or running for this device' }, 409);
  }

  const row = result.job;

  // Enqueue BullMQ job to dispatch to agent
  try {
    const { enqueueBackupDispatch } = await import(
      '../../jobs/backupWorker'
    );
    await enqueueBackupDispatch(row.id, row.configId, orgId, deviceId);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to enqueue backup dispatch';
    console.error('[BackupJobs] Failed to enqueue dispatch:', err);
    await markBackupJobDispatchFailed(row.id, error);
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

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run',
    resourceType: 'backup_job',
    resourceId: row.id,
    details: { deviceId, configId, featureLinkId },
  });

  return c.json(toJobResponse(row), 201);
});

jobsRoutes.get('/jobs/run-all/preview', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const assigned = await resolveAllBackupAssignedDevices(orgId);
  const deviceIds = new Set(assigned.filter((a) => a.configId).map((a) => a.deviceId));

  if (deviceIds.size === 0) {
    return c.json({ data: { deviceCount: 0, deviceIds: [], alreadyRunning: 0 } });
  }

  const onlineDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(devices.id, Array.from(deviceIds)),
        eq(devices.status, 'online')
      )
    );
  const onlineDeviceIds = new Set(onlineDevices.map((device) => device.id));

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

  return c.json({
    data: {
      deviceCount: eligibleIds.length,
      deviceIds: eligibleIds,
      alreadyRunning: deviceIds.size - eligibleIds.length,
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
  const orgId = resolveScopedOrgId(auth);
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
  const skipped: string[] = [];
  const failed: string[] = [];
  const deviceIds = Array.from(deviceConfigMap.keys());
  const onlineDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(devices.id, deviceIds),
        eq(devices.status, 'online')
      )
    );
  const onlineDeviceIds = new Set(onlineDevices.map((device) => device.id));

  for (const [deviceId, { configId, featureLinkId }] of deviceConfigMap) {
    if (!onlineDeviceIds.has(deviceId)) {
      skipped.push(deviceId);
      continue;
    }

    const result = await createManualBackupJobIfIdle({
      orgId,
      configId,
      featureLinkId,
      deviceId,
    });

    if (result?.created) {
      try {
        const { enqueueBackupDispatch } = await import('../../jobs/backupWorker');
        await enqueueBackupDispatch(result.job.id, configId, orgId, deviceId);
        created.push(result.job.id);
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Failed to enqueue backup dispatch';
        console.error('[BackupJobs] Failed to enqueue dispatch:', err);
        await markBackupJobDispatchFailed(result.job.id, error);
        failed.push(result.job.id);
      }
    } else {
      skipped.push(deviceId);
    }
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run_all',
    resourceType: 'backup_job',
    resourceId: null,
    details: { created: created.length, skipped: skipped.length, failed: failed.length },
    result: failed.length > 0 && created.length === 0 ? 'failure' : 'success',
  });

  return c.json({
    data: {
      created: created.length,
      skipped: skipped.length,
      failed: failed.length,
      jobIds: created,
      failedJobIds: failed,
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
  const orgId = resolveScopedOrgId(auth);
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
      errorLog: 'Canceled by user',
    })
    .where(eq(backupJobs.id, jobId))
    .returning();

  if (!row) {
    return c.json({ error: 'Job not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.cancel',
    resourceType: 'backup_job',
    resourceId: row.id,
    details: { deviceId: row.deviceId },
  });

  return c.json(toJobResponse(row));
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
    fileCount: row.fileCount ?? null,
    errorCount: row.errorCount ?? null,
    errorLog: row.errorLog ?? null,
  };
}
