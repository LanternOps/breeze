import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, ilike, desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
} from '../../db/schema';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { enqueueC2cRestore } from '../../jobs/c2cEnqueue';
import { c2cItemSearchSchema, c2cRestoreSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId } from './helpers';
import { PERMISSIONS } from '../../services/permissions';

export const c2cItemsRoutes = new Hono();
const requireC2cRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireC2cWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

// ── Search / browse items ───────────────────────────────────────────────────

c2cItemsRoutes.get(
  '/items',
  requireC2cRead,
  zValidator('query', c2cItemSearchSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const query = c.req.valid('query');
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const conditions = [eq(c2cBackupItems.orgId, orgId)];

    if (query.configId) conditions.push(eq(c2cBackupItems.configId, query.configId));
    if (query.userEmail) conditions.push(eq(c2cBackupItems.userEmail, query.userEmail));
    if (query.itemType) conditions.push(eq(c2cBackupItems.itemType, query.itemType));
    if (query.search) {
      conditions.push(ilike(c2cBackupItems.subjectOrName, `%${query.search}%`));
    }

    const rows = await db
      .select()
      .from(c2cBackupItems)
      .where(and(...conditions))
      .orderBy(desc(c2cBackupItems.createdAt))
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(c2cBackupItems)
      .where(and(...conditions));

    return c.json({
      data: rows.map(toItemResponse),
      total: countResult?.count ?? 0,
      limit,
      offset,
    });
  }
);

// ── Restore items ───────────────────────────────────────────────────────────

c2cItemsRoutes.post(
  '/restore',
  requireC2cWrite,
  requireMfa(),
  zValidator('json', c2cRestoreSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // Validate target connection if provided
    if (payload.targetConnectionId) {
      const [conn] = await db
        .select({ id: c2cConnections.id })
        .from(c2cConnections)
        .where(
          and(
            eq(c2cConnections.id, payload.targetConnectionId),
            eq(c2cConnections.orgId, orgId)
          )
        )
        .limit(1);

      if (!conn) return c.json({ error: 'Target connection not found' }, 404);
    }

    // Create a restore job record (reuse c2c_backup_jobs with restore status)
    const now = new Date();
    // Pick the configId from the first item for the restore job grouping
    const matchedItems = await db
      .select({ id: c2cBackupItems.id, configId: c2cBackupItems.configId })
      .from(c2cBackupItems)
      .where(
        and(
          eq(c2cBackupItems.orgId, orgId),
          sql`${c2cBackupItems.id} = ANY(${payload.itemIds}::uuid[])`
        )
      )
      .limit(payload.itemIds.length);

    if (matchedItems.length === 0) return c.json({ error: 'No matching items found' }, 404);
    if (matchedItems.length !== payload.itemIds.length) {
      return c.json({ error: 'One or more requested items were not found' }, 404);
    }

    const configIds = new Set(matchedItems.map((item) => item.configId));
    if (configIds.size > 1) {
      return c.json({ error: 'All restore items must belong to the same backup configuration' }, 400);
    }
    const firstItem = matchedItems[0]!;

    const [restoreJob] = await db
      .insert(c2cBackupJobs)
      .values({
        orgId,
        configId: firstItem.configId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!restoreJob) return c.json({ error: 'Failed to create restore job' }, 500);

    // Enqueue restore processing
    await enqueueC2cRestore(
      restoreJob.id,
      orgId,
      payload.itemIds,
      payload.targetConnectionId ?? null
    );

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.restore.trigger',
      resourceType: 'c2c_restore_job',
      resourceId: restoreJob.id,
      details: { itemCount: payload.itemIds.length },
    });

    return c.json(
      {
        id: restoreJob.id,
        status: restoreJob.status,
        itemCount: payload.itemIds.length,
        createdAt: restoreJob.createdAt.toISOString(),
      },
      201
    );
  }
);

// ── Get restore job status ──────────────────────────────────────────────────

c2cItemsRoutes.get(
  '/restore/:id',
  requireC2cRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(c2cBackupJobs)
      .where(and(eq(c2cBackupJobs.id, id), eq(c2cBackupJobs.orgId, orgId)))
      .limit(1);

    if (!row) return c.json({ error: 'Restore job not found' }, 404);

    return c.json({
      id: row.id,
      status: row.status,
      itemsProcessed: row.itemsProcessed,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      errorLog: row.errorLog,
      createdAt: row.createdAt.toISOString(),
    });
  }
);

// ── Dashboard stats ─────────────────────────────────────────────────────────

c2cItemsRoutes.get('/dashboard', requireC2cRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const [connCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(c2cConnections)
    .where(
      and(eq(c2cConnections.orgId, orgId), eq(c2cConnections.status, 'active'))
    );

  const [configCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(c2cBackupItems)
    .where(eq(c2cBackupItems.orgId, orgId));

  const [itemStats] = await db
    .select({
      totalItems: sql<number>`count(*)::int`,
      totalSize: sql<number>`coalesce(sum(${c2cBackupItems.sizeBytes}), 0)::bigint`,
    })
    .from(c2cBackupItems)
    .where(eq(c2cBackupItems.orgId, orgId));

  const [lastSync] = await db
    .select({ lastSyncAt: sql<string>`max(${c2cBackupJobs.completedAt})` })
    .from(c2cBackupJobs)
    .where(
      and(eq(c2cBackupJobs.orgId, orgId), eq(c2cBackupJobs.status, 'completed'))
    );

  return c.json({
    activeConnections: connCount?.count ?? 0,
    totalItemsBacked: itemStats?.totalItems ?? 0,
    totalStorageBytes: Number(itemStats?.totalSize ?? 0),
    lastSyncAt: lastSync?.lastSyncAt ?? null,
    configuredBackups: configCount?.count ?? 0,
  });
});

// ── Response mapper ─────────────────────────────────────────────────────────

function toItemResponse(row: typeof c2cBackupItems.$inferSelect) {
  return {
    id: row.id,
    configId: row.configId,
    jobId: row.jobId,
    itemType: row.itemType,
    externalId: row.externalId,
    userEmail: row.userEmail,
    subjectOrName: row.subjectOrName,
    parentPath: row.parentPath,
    storagePath: row.storagePath,
    sizeBytes: row.sizeBytes,
    itemDate: row.itemDate?.toISOString() ?? null,
    isDeleted: row.isDeleted,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  };
}
