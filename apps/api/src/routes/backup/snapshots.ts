import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db';
import { backupConfigs, backupSnapshotFiles, backupSnapshots } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  applyBackupSnapshotImmutability,
  checkBackupProviderCapabilities,
} from '../../services/backupSnapshotStorage';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  snapshotImmutabilityApplySchema,
  snapshotListSchema,
  snapshotProtectionReasonSchema,
} from './schemas';
import type { SnapshotTreeItem } from './types';

export const snapshotsRoutes = new Hono();

const snapshotIdParamSchema = z.object({ id: z.string().uuid() });
type SnapshotProtectionState = {
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldSource: 'policy' | 'manual' | null;
  isImmutable: boolean;
  immutableUntil: string | null;
  immutabilityEnforcement: string | null;
  requestedImmutabilityEnforcement: string | null;
  immutabilityFallbackReason: string | null;
  retentionBlockedReason: 'legal_hold' | 'immutable_until' | null;
};

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

function computeImmutableUntilFromNow(immutableDays: number): Date {
  const immutableUntil = new Date();
  immutableUntil.setUTCDate(immutableUntil.getUTCDate() + immutableDays);
  return immutableUntil;
}

function normalizeSnapshotMetadata(
  metadata: unknown,
): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function resolveLegalHoldSource(
  metadata: unknown,
): 'policy' | 'manual' | null {
  const normalized = normalizeSnapshotMetadata(metadata);
  const protection =
    normalized.snapshotProtection && typeof normalized.snapshotProtection === 'object' && !Array.isArray(normalized.snapshotProtection)
      ? normalized.snapshotProtection as Record<string, unknown>
      : null;
  return protection?.legalHoldSource === 'policy' || protection?.legalHoldSource === 'manual'
    ? protection.legalHoldSource
    : null;
}

function withLegalHoldSource(
  metadata: unknown,
  source: 'policy' | 'manual' | null,
): Record<string, unknown> {
  const normalized = normalizeSnapshotMetadata(metadata);
  const protection =
    normalized.snapshotProtection && typeof normalized.snapshotProtection === 'object' && !Array.isArray(normalized.snapshotProtection)
      ? { ...(normalized.snapshotProtection as Record<string, unknown>) }
      : {};

  return {
    ...normalized,
    snapshotProtection: {
      ...protection,
      legalHoldSource: source,
    },
  };
}

function computeRetentionBlockedReason(
  row: typeof backupSnapshots.$inferSelect,
): 'legal_hold' | 'immutable_until' | null {
  if (row.legalHold === true) {
    return 'legal_hold';
  }
  if (row.isImmutable === true && row.immutableUntil && row.immutableUntil > new Date()) {
    return 'immutable_until';
  }
  return null;
}

function toProtectionState(row: typeof backupSnapshots.$inferSelect): SnapshotProtectionState {
  return {
    legalHold: row.legalHold === true,
    legalHoldReason: row.legalHoldReason ?? null,
    legalHoldSource: resolveLegalHoldSource(row.metadata),
    isImmutable: row.isImmutable === true,
    immutableUntil: row.immutableUntil?.toISOString() ?? null,
    immutabilityEnforcement: row.immutabilityEnforcement ?? null,
    requestedImmutabilityEnforcement: row.requestedImmutabilityEnforcement ?? null,
    immutabilityFallbackReason: row.immutabilityFallbackReason ?? null,
    retentionBlockedReason: computeRetentionBlockedReason(row),
  };
}

async function resolveSnapshotStorageConfig(
  configId: string | null | undefined,
): Promise<{ provider: string | null; providerConfig: unknown } | null> {
  if (!configId) return null;

  const [row] = await db
    .select({
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);

  return row ?? null;
}

snapshotsRoutes.get(
  '/snapshots',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
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

snapshotsRoutes.get('/snapshots/:id', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', snapshotIdParamSchema), async (c) => {
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

snapshotsRoutes.get('/snapshots/:id/browse', requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action), zValidator('param', snapshotIdParamSchema), async (c) => {
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

snapshotsRoutes.post(
  '/snapshots/:id/legal-hold',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const [updated] = await db
      .update(backupSnapshots)
      .set({
        legalHold: true,
        legalHoldReason: payload.reason.trim(),
        metadata: withLegalHoldSource(before.metadata, 'manual'),
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.snapshot.legal_hold.apply',
      resourceType: 'backup_snapshot',
      resourceId: updated.id,
      resourceName: updated.label ?? updated.snapshotId,
      details: {
        snapshotIds: [updated.id],
        reason: payload.reason.trim(),
        before: toProtectionState(before),
        after: toProtectionState(updated),
      },
    });

    return c.json(toSnapshotResponse(updated));
  },
);

async function releaseLegalHold(c: any) {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id: snapshotId } = c.req.valid('param');
  const payload = c.req.valid('json');

  const [before] = await db
    .select()
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
    .limit(1);

  if (!before) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const [updated] = await db
    .update(backupSnapshots)
    .set({
      legalHold: false,
      legalHoldReason: null,
      metadata: withLegalHoldSource(before.metadata, null),
    })
    .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
    .returning();

  if (!updated) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.snapshot.legal_hold.release',
    resourceType: 'backup_snapshot',
    resourceId: updated.id,
    resourceName: updated.label ?? updated.snapshotId,
    details: {
      snapshotIds: [updated.id],
      reason: payload.reason.trim(),
      before: toProtectionState(before),
      after: toProtectionState(updated),
    },
  });

  return c.json(toSnapshotResponse(updated));
}

snapshotsRoutes.post(
  '/snapshots/:id/legal-hold/release',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  releaseLegalHold,
);

snapshotsRoutes.delete(
  '/snapshots/:id/legal-hold',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  releaseLegalHold,
);

snapshotsRoutes.post(
  '/snapshots/:id/immutability',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotImmutabilityApplySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const [updated] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const immutableUntil = payload.extendUntil
      ? new Date(payload.extendUntil)
      : computeImmutableUntilFromNow(payload.immutableDays ?? 0);
    if (Number.isNaN(immutableUntil.getTime())) {
      return c.json({ error: 'extendUntil must be a valid ISO-8601 timestamp' }, 400);
    }
    if (immutableUntil <= new Date()) {
      return c.json({ error: 'Immutability must end in the future' }, 400);
    }

    if (before.immutableUntil && immutableUntil <= before.immutableUntil) {
      return c.json({
        error: 'Immutability can only be extended forward. Use the release endpoint to weaken application protection.',
      }, 409);
    }

    let immutabilityEnforcement: 'application' | 'provider' =
      before.immutabilityEnforcement === 'provider'
        ? 'provider'
        : payload.enforcement;

    if (payload.enforcement === 'provider') {
      const storage = await resolveSnapshotStorageConfig(updated.configId ?? null);
      if (!storage) {
        return c.json({ error: 'Snapshot storage configuration is unavailable' }, 409);
      }
      const capability = await checkBackupProviderCapabilities({
        provider: storage.provider,
        providerConfig: storage.providerConfig,
      });
      if (!capability.objectLock.supported) {
        return c.json({
          error: capability.objectLock.error ?? 'Bucket object lock is not enabled',
        }, 409);
      }
      try {
        await applyBackupSnapshotImmutability({
          provider: storage.provider,
          providerConfig: storage.providerConfig,
          snapshotId: updated.snapshotId,
          metadata: updated.metadata,
          retainUntil: immutableUntil,
        });
      } catch (err) {
        return c.json({
          error: err instanceof Error ? err.message : 'Failed to apply provider-enforced immutability',
        }, 409);
      }
      immutabilityEnforcement = 'provider';
    }

    const [saved] = await db
      .update(backupSnapshots)
      .set({
        isImmutable: true,
        immutableUntil,
        immutabilityEnforcement,
        requestedImmutabilityEnforcement: immutabilityEnforcement,
        immutabilityFallbackReason: null,
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!saved) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: `backup.snapshot.immutability.apply.${immutabilityEnforcement}`,
      resourceType: 'backup_snapshot',
      resourceId: saved.id,
      resourceName: saved.label ?? saved.snapshotId,
      details: {
        snapshotIds: [saved.id],
        reason: payload.reason.trim(),
        immutableDays: payload.immutableDays,
        before: toProtectionState(before),
        requestedEnforcement: payload.enforcement,
        after: toProtectionState(saved),
      },
    });

    return c.json(toSnapshotResponse(saved));
  },
);

snapshotsRoutes.post(
  '/snapshots/:id/immutability/release',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', snapshotIdParamSchema),
  zValidator('json', snapshotProtectionReasonSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id: snapshotId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [before] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!before) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    if (before.immutabilityEnforcement === 'provider') {
      return c.json({ error: 'Provider-enforced immutability must be released by the storage provider' }, 409);
    }

    const [updated] = await db
      .update(backupSnapshots)
      .set({
        isImmutable: false,
        immutableUntil: null,
        immutabilityEnforcement: null,
        requestedImmutabilityEnforcement: null,
        immutabilityFallbackReason: null,
      })
      .where(and(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.orgId, orgId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.snapshot.immutability.release',
      resourceType: 'backup_snapshot',
      resourceId: updated.id,
      resourceName: updated.label ?? updated.snapshotId,
      details: {
        snapshotIds: [updated.id],
        reason: payload.reason.trim(),
        before: toProtectionState(before),
        after: toProtectionState(updated),
      },
    });

    return c.json(toSnapshotResponse(updated));
  },
);

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
    expiresAt: row.expiresAt?.toISOString() ?? null,
    legalHold: row.legalHold === true,
    legalHoldReason: row.legalHoldReason ?? null,
    legalHoldSource: resolveLegalHoldSource(row.metadata),
    isImmutable: row.isImmutable === true,
    immutableUntil: row.immutableUntil?.toISOString() ?? null,
    immutabilityEnforcement: row.immutabilityEnforcement ?? null,
    requestedImmutabilityEnforcement: row.requestedImmutabilityEnforcement ?? null,
    immutabilityFallbackReason: row.immutabilityFallbackReason ?? null,
    retentionBlockedReason: computeRetentionBlockedReason(row),
  };
}
