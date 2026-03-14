import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import { backupJobs, backupConfigs, backupPolicies } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import { jobListSchema } from './schemas';
import type { BackupPolicyTargets } from './types';

export const jobsRoutes = new Hono();

jobsRoutes.get('/jobs', zValidator('query', jobListSchema), async (c) => {
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
    .select()
    .from(backupJobs)
    .where(and(...conditions))
    .orderBy(desc(backupJobs.createdAt));

  return c.json({ data: rows.map(toJobResponse) });
});

jobsRoutes.get('/jobs/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id');
  const [row] = await db
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json(toJobResponse(row));
});

jobsRoutes.post('/jobs/run/:deviceId', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const deviceId = c.req.param('deviceId');

  // Find a policy targeting this device, or a default config
  const policies = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.orgId, orgId));

  const policy = policies.find((p) => {
    const targets = p.targets as BackupPolicyTargets;
    return targets?.deviceIds?.includes(deviceId);
  });

  let configId = policy?.configId;
  if (!configId) {
    const [fallbackConfig] = await db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(eq(backupConfigs.orgId, orgId))
      .limit(1);
    configId = fallbackConfig?.id;
  }

  if (!configId) {
    return c.json({ error: 'No backup config available' }, 400);
  }

  const now = new Date();
  const [row] = await db
    .insert(backupJobs)
    .values({
      orgId,
      configId,
      policyId: policy?.id ?? null,
      deviceId,
      status: 'pending',
      type: 'manual',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) {
    return c.json({ error: 'Failed to create job' }, 500);
  }

  // Enqueue BullMQ job to dispatch to agent
  try {
    const { enqueueBackupDispatch } = await import(
      '../../jobs/backupWorker'
    );
    await enqueueBackupDispatch(row.id, row.configId, orgId, deviceId);
  } catch (err) {
    console.error('[BackupJobs] Failed to enqueue dispatch:', err);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.job.run',
    resourceType: 'backup_job',
    resourceId: row.id,
    details: { deviceId, configId, policyId: policy?.id ?? null },
  });

  return c.json(toJobResponse(row), 201);
});

jobsRoutes.post('/jobs/:id/cancel', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const jobId = c.req.param('id');
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
