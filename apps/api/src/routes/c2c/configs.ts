import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { backupConfigs, c2cBackupConfigs, c2cConnections } from '../../db/schema';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { createC2cConfigSchema, updateC2cConfigSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId } from './helpers';

export const c2cConfigsRoutes = new Hono();
const requireC2cRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireC2cWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

async function verifyStorageConfigForOrg(storageConfigId: string | null | undefined, orgId: string) {
  if (!storageConfigId) return true;
  const [storageConfig] = await db
    .select({ id: backupConfigs.id })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, storageConfigId), eq(backupConfigs.orgId, orgId)))
    .limit(1);
  return Boolean(storageConfig);
}

// ── List configs ────────────────────────────────────────────────────────────

c2cConfigsRoutes.get('/configs', requireC2cRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const rows = await db
    .select()
    .from(c2cBackupConfigs)
    .where(eq(c2cBackupConfigs.orgId, orgId));

  return c.json({ data: rows.map(toConfigResponse) });
});

// ── Create config ───────────────────────────────────────────────────────────

c2cConfigsRoutes.post(
  '/configs',
  requireC2cWrite,
  requireMfa(),
  zValidator('json', createC2cConfigSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // Verify connection belongs to this org
    const [conn] = await db
      .select({ id: c2cConnections.id })
      .from(c2cConnections)
      .where(
        and(
          eq(c2cConnections.id, payload.connectionId),
          eq(c2cConnections.orgId, orgId)
        )
      )
      .limit(1);

    if (!conn) return c.json({ error: 'Connection not found' }, 404);
    if (!(await verifyStorageConfigForOrg(payload.storageConfigId, orgId))) {
      return c.json({ error: 'Storage config not found' }, 404);
    }

    const now = new Date();
    const [row] = await db
      .insert(c2cBackupConfigs)
      .values({
        orgId,
        connectionId: payload.connectionId,
        name: payload.name,
        backupScope: payload.backupScope,
        targetUsers: payload.targetUsers ?? [],
        storageConfigId: payload.storageConfigId ?? null,
        schedule: payload.schedule ?? null,
        retention: payload.retention ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) return c.json({ error: 'Failed to create config' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.config.create',
      resourceType: 'c2c_backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { scope: row.backupScope, connectionId: row.connectionId },
    });

    return c.json(toConfigResponse(row), 201);
  }
);

// ── Update config ───────────────────────────────────────────────────────────

c2cConfigsRoutes.patch(
  '/configs/:id',
  requireC2cWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateC2cConfigSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    if (!(await verifyStorageConfigForOrg(payload.storageConfigId, orgId))) {
      return c.json({ error: 'Storage config not found' }, 404);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.backupScope !== undefined) updateData.backupScope = payload.backupScope;
    if (payload.targetUsers !== undefined) updateData.targetUsers = payload.targetUsers;
    if (payload.storageConfigId !== undefined) updateData.storageConfigId = payload.storageConfigId;
    if (payload.schedule !== undefined) updateData.schedule = payload.schedule;
    if (payload.retention !== undefined) updateData.retention = payload.retention;
    if (payload.isActive !== undefined) updateData.isActive = payload.isActive;

    const [row] = await db
      .update(c2cBackupConfigs)
      .set(updateData)
      .where(and(eq(c2cBackupConfigs.id, id), eq(c2cBackupConfigs.orgId, orgId)))
      .returning();

    if (!row) return c.json({ error: 'Config not found' }, 404);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.config.update',
      resourceType: 'c2c_backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toConfigResponse(row));
  }
);

// ── Delete config ───────────────────────────────────────────────────────────

c2cConfigsRoutes.delete(
  '/configs/:id',
  requireC2cWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [deleted] = await db
      .delete(c2cBackupConfigs)
      .where(and(eq(c2cBackupConfigs.id, id), eq(c2cBackupConfigs.orgId, orgId)))
      .returning();

    if (!deleted) return c.json({ error: 'Config not found' }, 404);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.config.delete',
      resourceType: 'c2c_backup_config',
      resourceId: deleted.id,
      resourceName: deleted.name,
    });

    return c.json({ deleted: true });
  }
);

// ── Response mapper ─────────────────────────────────────────────────────────

function toConfigResponse(row: typeof c2cBackupConfigs.$inferSelect) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    backupScope: row.backupScope,
    targetUsers: row.targetUsers as string[],
    storageConfigId: row.storageConfigId,
    schedule: row.schedule as Record<string, unknown> | null,
    retention: row.retention as Record<string, unknown> | null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
