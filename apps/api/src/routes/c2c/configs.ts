import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  C2C_CONFIG_HAS_HISTORY_MESSAGE,
  createC2cConfig,
  deleteC2cConfig,
  listC2cConfigs,
  toC2cConfigResponse,
  updateC2cConfig,
  type C2cConfigErrorCode,
} from '../../services/c2cConfigService';
import { PERMISSIONS } from '../../services/permissions';
import { PROTECTED_ORG_ERROR } from '../../services/unassignedPool/orgType';
import { createC2cConfigSchema, updateC2cConfigSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId } from './helpers';

export const c2cConfigsRoutes = new Hono();
const requireC2cRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireC2cWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

function configErrorResponse(c: { json: (body: unknown, status: 404 | 409) => Response }, code: C2cConfigErrorCode): Response {
  switch (code) {
    case 'PROTECTED_ORG':
      return c.json(PROTECTED_ORG_ERROR, 409);
    case 'CONFIG_HAS_HISTORY':
      return c.json({ error: C2C_CONFIG_HAS_HISTORY_MESSAGE, code }, 409);
    case 'CONNECTION_NOT_FOUND':
      return c.json({ error: 'Connection not found' }, 404);
    case 'STORAGE_NOT_FOUND':
      return c.json({ error: 'Storage config not found' }, 404);
    case 'NOT_FOUND':
      return c.json({ error: 'Config not found' }, 404);
  }
}

// ── List configs ────────────────────────────────────────────────────────────

c2cConfigsRoutes.get('/configs', requireC2cRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const rows = await listC2cConfigs(orgId);

  return c.json({ data: rows.map(toC2cConfigResponse) });
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

    const result = await createC2cConfig(orgId, c.req.valid('json'));
    if (!result.ok) return configErrorResponse(c, result.code);
    const row = result.value;

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.config.create',
      resourceType: 'c2c_backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { scope: row.backupScope, connectionId: row.connectionId },
    });

    return c.json(toC2cConfigResponse(row), 201);
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

    const result = await updateC2cConfig(orgId, id, payload);
    if (!result.ok) return configErrorResponse(c, result.code);
    const row = result.value;

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.config.update',
      resourceType: 'c2c_backup_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toC2cConfigResponse(row));
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
    const result = await deleteC2cConfig(orgId, id);
    if (!result.ok) return configErrorResponse(c, result.code);
    const deleted = result.value;

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
