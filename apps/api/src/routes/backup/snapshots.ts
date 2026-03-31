import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db';
import { backupSnapshotFiles, backupSnapshots } from '../../db/schema';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { snapshotListSchema } from './schemas';
import type { SnapshotTreeItem } from './types';

export const snapshotsRoutes = new Hono();

const snapshotIdParamSchema = z.object({ id: z.string().uuid() });

type SnapshotFileRow = {
  sourcePath: string;
  size: number | null;
  modifiedAt: Date | null;
};

function normalizeSourcePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function buildSnapshotTree(files: SnapshotFileRow[]): SnapshotTreeItem[] {
  const root: SnapshotTreeItem[] = [];

  const ensureDirectory = (container: SnapshotTreeItem[], name: string, path: string): SnapshotTreeItem => {
    const existing = container.find((entry) => entry.type === 'directory' && entry.path === path);
    if (existing) return existing;
    const next: SnapshotTreeItem = { name, path, type: 'directory', children: [] };
    container.push(next);
    return next;
  };

  for (const file of files) {
    const normalizedPath = normalizeSourcePath(file.sourcePath);
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let currentLevel = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      currentPath = `${currentPath}/${part}`.replace('//', '/');
      const isLeaf = index === parts.length - 1;

      if (isLeaf) {
        const existingLeafIndex = currentLevel.findIndex((entry) => entry.type === 'file' && entry.path === normalizedPath);
        const nextLeaf: SnapshotTreeItem = {
          name: part,
          path: normalizedPath,
          type: 'file',
          sizeBytes: file.size ?? undefined,
          modifiedAt: file.modifiedAt?.toISOString(),
        };
        if (existingLeafIndex >= 0) currentLevel[existingLeafIndex] = nextLeaf;
        else currentLevel.push(nextLeaf);
        continue;
      }

      const directory = ensureDirectory(currentLevel, part, currentPath);
      directory.children = directory.children ?? [];
      currentLevel = directory.children;
    }
  }

  const sortNodes = (nodes: SnapshotTreeItem[]): SnapshotTreeItem[] =>
    nodes
      .map((node) => ({
        ...node,
        children: node.children ? sortNodes(node.children) : undefined,
      }))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });

  return sortNodes(root);
}

snapshotsRoutes.get(
  '/snapshots',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
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

snapshotsRoutes.get('/snapshots/:id', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('param', snapshotIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
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

snapshotsRoutes.get('/snapshots/:id/browse', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), zValidator('param', snapshotIdParamSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
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

  const files = await db
    .select({
      sourcePath: backupSnapshotFiles.sourcePath,
      size: backupSnapshotFiles.size,
      modifiedAt: backupSnapshotFiles.modifiedAt,
    })
    .from(backupSnapshotFiles)
    .where(eq(backupSnapshotFiles.snapshotDbId, row.id))
    .orderBy(backupSnapshotFiles.sourcePath);

  const tree = buildSnapshotTree(files);
  const manifestUnavailable = files.length === 0 && (row.fileCount ?? 0) > 0;
  return c.json({
    snapshotId: row.id,
    manifestUnavailable,
    data: tree,
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
