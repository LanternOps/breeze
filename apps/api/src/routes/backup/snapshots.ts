import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db';
import { backupSnapshots } from '../../db/schema';
import { resolveScopedOrgId } from './helpers';
import { snapshotListSchema } from './schemas';
import type { SnapshotTreeItem } from './types';

export const snapshotsRoutes = new Hono();

snapshotsRoutes.get(
  '/snapshots',
  zValidator('query', snapshotListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const conditions = [eq(backupSnapshots.orgId, orgId)];

    if (query.deviceId) {
      conditions.push(eq(backupSnapshots.deviceId, query.deviceId));
    }
    if (query.configId) {
      conditions.push(eq(backupSnapshots.configId, query.configId));
    }

    const rows = await db
      .select()
      .from(backupSnapshots)
      .where(and(...conditions))
      .orderBy(desc(backupSnapshots.timestamp));

    return c.json({ data: rows.map(toSnapshotResponse) });
  }
);

snapshotsRoutes.get('/snapshots/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('id');
  const [row] = await db
    .select()
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.id, snapshotId),
        eq(backupSnapshots.orgId, orgId)
      )
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }
  return c.json(toSnapshotResponse(row));
});

snapshotsRoutes.get('/snapshots/:id/browse', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('id');
  const [row] = await db
    .select()
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.id, snapshotId),
        eq(backupSnapshots.orgId, orgId)
      )
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const metadata = row.metadata as { files?: SnapshotTreeItem[] } | null;
  return c.json({
    snapshotId: row.id,
    data: metadata?.files ?? [],
  });
});

function toSnapshotResponse(row: typeof backupSnapshots.$inferSelect) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    configId: row.configId ?? null,
    jobId: row.jobId,
    createdAt: row.timestamp.toISOString(),
    sizeBytes: row.size ?? null,
    fileCount: row.fileCount ?? null,
    label: row.label ?? null,
    location: row.location ?? null,
  };
}
