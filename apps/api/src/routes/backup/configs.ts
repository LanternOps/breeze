import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { writeRouteAudit } from '../../services/auditEvents';
import type { BackupConfig } from './types';
import { resolveScopedOrgId } from './helpers';
import { backupConfigs, configOrgById } from './store';
import { configSchema, configUpdateSchema } from './schemas';

export const configsRoutes = new Hono();

configsRoutes.get('/configs', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  return c.json({ data: backupConfigs.filter((config) => configOrgById.get(config.id) === orgId) });
});

configsRoutes.post('/configs', zValidator('json', configSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const payload = c.req.valid('json');
  const now = new Date().toISOString();
  const config: BackupConfig = {
    id: randomUUID(),
    name: payload.name,
    provider: payload.provider,
    enabled: payload.enabled ?? true,
    details: payload.details ?? {},
    createdAt: now,
    updatedAt: now
  };

  backupConfigs.push(config);
  configOrgById.set(config.id, orgId);
  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.create',
    resourceType: 'backup_config',
    resourceId: config.id,
    resourceName: config.name,
    details: { provider: config.provider, enabled: config.enabled }
  });
  return c.json(config, 201);
});

configsRoutes.get('/configs/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  if (configOrgById.get(configId) !== orgId) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const config = backupConfigs.find((item) => item.id === configId);
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }
  return c.json(config);
});

configsRoutes.patch('/configs/:id', zValidator('json', configUpdateSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  if (configOrgById.get(configId) !== orgId) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const config = backupConfigs.find((item) => item.id === configId);
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }

  const payload = c.req.valid('json');
  if (payload.name !== undefined) config.name = payload.name;
  if (payload.enabled !== undefined) config.enabled = payload.enabled;
  if (payload.details !== undefined) {
    config.details = { ...config.details, ...payload.details };
  }
  config.updatedAt = new Date().toISOString();

  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.update',
    resourceType: 'backup_config',
    resourceId: config.id,
    resourceName: config.name,
    details: { changedFields: Object.keys(payload) }
  });

  return c.json(config);
});

configsRoutes.delete('/configs/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  if (configOrgById.get(configId) !== orgId) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const index = backupConfigs.findIndex((item) => item.id === configId);
  if (index === -1) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const [deleted] = backupConfigs.splice(index, 1);
  if (deleted) {
    configOrgById.delete(deleted.id);
  }
  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.delete',
    resourceType: 'backup_config',
    resourceId: deleted?.id,
    resourceName: deleted?.name
  });
  return c.json({ deleted: true });
});

configsRoutes.post('/configs/:id/test', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const configId = c.req.param('id');
  if (configOrgById.get(configId) !== orgId) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const config = backupConfigs.find((item) => item.id === configId);
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const checkedAt = new Date().toISOString();
  config.lastTestedAt = checkedAt;
  writeRouteAudit(c, {
    orgId,
    action: 'backup.config.test',
    resourceType: 'backup_config',
    resourceId: config.id,
    resourceName: config.name
  });
  return c.json({
    id: config.id,
    provider: config.provider,
    status: 'success',
    checkedAt
  });
});
