import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { localVaults } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import {
  vaultCreateSchema,
  vaultUpdateSchema,
  vaultListSchema,
  vaultSyncSchema,
} from './schemas';

export const vaultRoutes = new Hono();

const vaultIdParam = z.object({ id: z.string().uuid() });

// GET /vault — list vaults for org (optional ?deviceId filter)
vaultRoutes.get('/', zValidator('query', vaultListSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { deviceId } = c.req.valid('query');

  const conditions = [eq(localVaults.orgId, orgId)];
  if (deviceId) {
    conditions.push(eq(localVaults.deviceId, deviceId));
  }

  const rows = await db
    .select()
    .from(localVaults)
    .where(and(...conditions));

  return c.json({ data: rows.map(toVaultResponse) });
});

// POST /vault — create vault config
vaultRoutes.post('/', zValidator('json', vaultCreateSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const now = new Date();

  const [row] = await db
    .insert(localVaults)
    .values({
      orgId,
      deviceId: payload.deviceId,
      vaultPath: payload.vaultPath,
      vaultType: payload.vaultType,
      retentionCount: payload.retentionCount,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) {
    return c.json({ error: 'Failed to create vault' }, 500);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.vault.create',
    resourceType: 'local_vault',
    resourceId: row.id,
    details: {
      deviceId: row.deviceId,
      vaultPath: row.vaultPath,
      vaultType: row.vaultType,
    },
  });

  return c.json(toVaultResponse(row), 201);
});

// PATCH /vault/:id — update vault config
vaultRoutes.patch(
  '/:id',
  zValidator('param', vaultIdParam),
  zValidator('json', vaultUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.vaultPath !== undefined) updateData.vaultPath = payload.vaultPath;
    if (payload.vaultType !== undefined) updateData.vaultType = payload.vaultType;
    if (payload.retentionCount !== undefined) updateData.retentionCount = payload.retentionCount;
    if (payload.isActive !== undefined) updateData.isActive = payload.isActive;

    const [row] = await db
      .update(localVaults)
      .set(updateData)
      .where(and(eq(localVaults.id, id), eq(localVaults.orgId, orgId)))
      .returning();

    if (!row) {
      return c.json({ error: 'Vault not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.vault.update',
      resourceType: 'local_vault',
      resourceId: row.id,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toVaultResponse(row));
  }
);

// DELETE /vault/:id — soft delete (set isActive=false)
vaultRoutes.delete('/:id', zValidator('param', vaultIdParam), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id } = c.req.valid('param');

  const [row] = await db
    .update(localVaults)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(localVaults.id, id), eq(localVaults.orgId, orgId)))
    .returning();

  if (!row) {
    return c.json({ error: 'Vault not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.vault.delete',
    resourceType: 'local_vault',
    resourceId: row.id,
  });

  return c.json({ deleted: true, id: row.id });
});

// POST /vault/:id/sync — trigger manual sync
vaultRoutes.post(
  '/:id/sync',
  zValidator('param', vaultIdParam),
  zValidator('json', vaultSyncSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [vault] = await db
      .select()
      .from(localVaults)
      .where(and(eq(localVaults.id, id), eq(localVaults.orgId, orgId)))
      .limit(1);

    if (!vault) {
      return c.json({ error: 'Vault not found' }, 404);
    }

    if (!vault.isActive) {
      return c.json({ error: 'Vault is inactive' }, 400);
    }

    // Update sync status to pending
    await db
      .update(localVaults)
      .set({
        lastSyncStatus: 'pending',
        lastSyncSnapshotId: payload.snapshotId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(localVaults.id, id));

    writeRouteAudit(c, {
      orgId,
      action: 'backup.vault.sync',
      resourceType: 'local_vault',
      resourceId: vault.id,
      details: { deviceId: vault.deviceId, snapshotId: payload.snapshotId },
    });

    // The actual sync command will be dispatched to the agent via the
    // command queue (vault_sync command type). The caller should dispatch
    // this separately or the job processor handles it.
    return c.json({
      id: vault.id,
      status: 'pending',
      deviceId: vault.deviceId,
      snapshotId: payload.snapshotId ?? null,
    });
  }
);

// GET /vault/:id/status — get vault sync status
vaultRoutes.get('/:id/status', zValidator('param', vaultIdParam), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const { id } = c.req.valid('param');

  const [vault] = await db
    .select()
    .from(localVaults)
    .where(and(eq(localVaults.id, id), eq(localVaults.orgId, orgId)))
    .limit(1);

  if (!vault) {
    return c.json({ error: 'Vault not found' }, 404);
  }

  return c.json({
    id: vault.id,
    deviceId: vault.deviceId,
    isActive: vault.isActive,
    lastSyncAt: vault.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: vault.lastSyncStatus,
    lastSyncSnapshotId: vault.lastSyncSnapshotId,
    syncSizeBytes: vault.syncSizeBytes,
  });
});

function toVaultResponse(row: typeof localVaults.$inferSelect) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    vaultPath: row.vaultPath,
    vaultType: row.vaultType,
    isActive: row.isActive,
    retentionCount: row.retentionCount,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncSnapshotId: row.lastSyncSnapshotId,
    syncSizeBytes: row.syncSizeBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
