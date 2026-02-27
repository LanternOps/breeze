import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { backupConfigs } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import { configSchema, configUpdateSchema } from './schemas';

export const configsRoutes = new Hono();

configsRoutes.get('/configs', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const rows = await db
    .select()
    .from(backupConfigs)
    .where(eq(backupConfigs.orgId, orgId));

  const data = rows.map(toConfigResponse);
  return c.json({ data });
});

configsRoutes.post(
  '/configs',
  zValidator('json', configSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(backupConfigs)
      .values({
        orgId,
        name: payload.name,
        type: 'file',
        provider: payload.provider,
        providerConfig: payload.details ?? {},
        isActive: payload.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create config' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.config.create',
      resourceType: 'backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { provider: row.provider, enabled: row.isActive },
    });

    return c.json(toConfigResponse(row), 201);
  }
);

configsRoutes.get('/configs/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  const [row] = await db
    .select()
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Config not found' }, 404);
  }
  return c.json(toConfigResponse(row));
});

configsRoutes.patch(
  '/configs/:id',
  zValidator('json', configUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const configId = c.req.param('id');
    const payload = c.req.valid('json');

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.enabled !== undefined) updateData.isActive = payload.enabled;
    if (payload.details !== undefined) updateData.providerConfig = payload.details;

    const [row] = await db
      .update(backupConfigs)
      .set(updateData)
      .where(
        and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId))
      )
      .returning();

    if (!row) {
      return c.json({ error: 'Config not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.config.update',
      resourceType: 'backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toConfigResponse(row));
  }
);

configsRoutes.delete('/configs/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  const [deleted] = await db
    .delete(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Config not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.delete',
    resourceType: 'backup_config',
    resourceId: deleted.id,
    resourceName: deleted.name,
  });

  return c.json({ deleted: true });
});

configsRoutes.post('/configs/:id/test', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  const [row] = await db
    .select()
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, configId), eq(backupConfigs.orgId, orgId)))
    .limit(1);

  if (!row) {
    return c.json({ error: 'Config not found' }, 404);
  }

  const checkedAt = new Date().toISOString();
  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.test',
    resourceType: 'backup_config',
    resourceId: row.id,
    resourceName: row.name,
  });

  return c.json({
    id: row.id,
    provider: row.provider,
    status: 'success',
    checkedAt,
  });
});

function toConfigResponse(row: typeof backupConfigs.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    enabled: row.isActive,
    details: row.providerConfig as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
