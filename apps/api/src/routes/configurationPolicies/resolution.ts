import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
} from '../../services/configurationPolicy';
import { diffSchema, deviceIdParamSchema } from './schemas';

export const resolutionRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

// GET /effective/:deviceId — resolve effective configuration
resolutionRoutes.get(
  '/effective/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId } = c.req.valid('param');

    const result = await resolveEffectiveConfig(deviceId, auth);
    if (!result) return c.json({ error: 'Device not found or access denied' }, 404);

    return c.json(result);
  }
);

// POST /effective/:deviceId/diff — preview changes
resolutionRoutes.post(
  '/effective/:deviceId/diff',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', diffSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId } = c.req.valid('param');
    const changes = c.req.valid('json');

    const result = await previewEffectiveConfig(deviceId, changes, auth);
    if (!result) return c.json({ error: 'Device not found or access denied' }, 404);

    return c.json(result);
  }
);
