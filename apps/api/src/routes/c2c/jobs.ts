import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { db } from '../../db';
import { c2cBackupJobs, c2cBackupConfigs } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { enqueueC2cSync } from '../../jobs/c2cEnqueue';
import { c2cJobListSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId } from './helpers';
import { createC2cSyncJobIfIdle } from '../../services/c2cJobCreation';

export const c2cJobsRoutes = new Hono();

// ── List jobs ───────────────────────────────────────────────────────────────

c2cJobsRoutes.get('/jobs', zValidator('query', c2cJobListSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const query = c.req.valid('query');
  const conditions = [eq(c2cBackupJobs.orgId, orgId)];

  if (query.configId) conditions.push(eq(c2cBackupJobs.configId, query.configId));
  if (query.status) conditions.push(eq(c2cBackupJobs.status, query.status));
  if (query.from) conditions.push(gte(c2cBackupJobs.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(c2cBackupJobs.createdAt, new Date(query.to)));

  const rows = await db
    .select()
    .from(c2cBackupJobs)
    .where(and(...conditions))
    .orderBy(desc(c2cBackupJobs.createdAt))
    .limit(100);

  return c.json({ data: rows.map(toJobResponse) });
});

// ── Get single job ──────────────────────────────────────────────────────────

c2cJobsRoutes.get('/jobs/:id', zValidator('param', idParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const { id } = c.req.valid('param');
  const [row] = await db
    .select()
    .from(c2cBackupJobs)
    .where(and(eq(c2cBackupJobs.id, id), eq(c2cBackupJobs.orgId, orgId)))
    .limit(1);

  if (!row) return c.json({ error: 'Job not found' }, 404);
  return c.json(toJobResponse(row));
});

// ── Trigger immediate sync ──────────────────────────────────────────────────

c2cJobsRoutes.post(
  '/configs/:id/run',
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id: configId } = c.req.valid('param');

    // Verify config belongs to org
    const [config] = await db
      .select()
      .from(c2cBackupConfigs)
      .where(
        and(eq(c2cBackupConfigs.id, configId), eq(c2cBackupConfigs.orgId, orgId))
      )
      .limit(1);

    if (!config) return c.json({ error: 'Config not found' }, 404);

    const created = await createC2cSyncJobIfIdle({
      orgId,
      configId,
    });
    const job = created?.job;
    if (!job) return c.json({ error: 'Failed to create job' }, 500);
    if (!created.created) {
      return c.json(
        {
          error: 'A C2C sync job is already pending or running for this configuration',
          jobId: job.id,
        },
        409
      );
    }

    await enqueueC2cSync(job.id, configId, orgId);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.job.trigger',
      resourceType: 'c2c_backup_job',
      resourceId: job.id,
      details: { configId, configName: config.name },
    });

    return c.json(toJobResponse(job), 201);
  }
);

// ── Response mapper ─────────────────────────────────────────────────────────

function toJobResponse(row: typeof c2cBackupJobs.$inferSelect) {
  return {
    id: row.id,
    configId: row.configId,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    itemsProcessed: row.itemsProcessed,
    itemsNew: row.itemsNew,
    itemsUpdated: row.itemsUpdated,
    itemsDeleted: row.itemsDeleted,
    bytesTransferred: row.bytesTransferred,
    errorLog: row.errorLog,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
