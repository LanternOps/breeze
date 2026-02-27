import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { backupSnapshots, restoreJobs } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import { restoreSchema } from './schemas';

export const restoreRoutes = new Hono();

restoreRoutes.post(
  '/restore',
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

    const now = new Date();
    const [row] = await db
      .insert(restoreJobs)
      .values({
        orgId,
        snapshotId: snapshot.id,
        deviceId: payload.deviceId ?? snapshot.deviceId,
        restoreType: 'selective',
        targetPath: payload.targetPath ?? null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create restore job' }, 500);
    }

    // Enqueue BullMQ job to dispatch restore to agent
    try {
      const { enqueueRestoreDispatch } = await import(
        '../../jobs/backupWorker'
      );
      await enqueueRestoreDispatch(
        row.id,
        snapshot.snapshotId,
        row.deviceId,
        orgId,
        row.targetPath ?? undefined
      );
    } catch (err) {
      console.error('[BackupRestore] Failed to enqueue dispatch:', err);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.restore.create',
      resourceType: 'restore_job',
      resourceId: row.id,
      details: {
        snapshotId: snapshot.id,
        deviceId: row.deviceId,
      },
    });

    return c.json(toRestoreResponse(row), 201);
  }
);

restoreRoutes.get('/restore/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const restoreId = c.req.param('id');
  const [row] = await db
    .select()
    .from(restoreJobs)
    .where(and(eq(restoreJobs.id, restoreId), eq(restoreJobs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Restore job not found' }, 404);
  }
  return c.json(toRestoreResponse(row));
});

function toRestoreResponse(row: typeof restoreJobs.$inferSelect) {
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    deviceId: row.deviceId,
    status: row.status,
    targetPath: row.targetPath ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    restoredSize: row.restoredSize ?? null,
    restoredFiles: row.restoredFiles ?? null,
  };
}
