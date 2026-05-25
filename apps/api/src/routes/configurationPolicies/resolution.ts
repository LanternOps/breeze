import type { Context } from 'hono';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { db } from '../../db';
import { devices } from '../../db/schema';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
} from '../../services/configurationPolicy';
import { diffSchema, deviceIdParamSchema } from './schemas';

export const resolutionRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

/**
 * Site-scope gate: partner-scope users restricted via `allowedSiteIds` must
 * not resolve config for devices in sites they cannot access. RLS does not
 * defend the site axis — mirrors PR #864/#868 (SP2 launch-readiness sweep).
 * Returns true when access is granted, false when denied.
 */
async function canAccessDeviceSite(c: Context, deviceId: string): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return { ok: false, status: 404 };
  const userPerms = c.get('permissions') as UserPermissions | undefined;
  if (userPerms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId))) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

// GET /effective/:deviceId — resolve effective configuration
resolutionRoutes.get(
  '/effective/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId } = c.req.valid('param');

    const access = await canAccessDeviceSite(c, deviceId);
    if (!access.ok) {
      if (access.status === 403) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

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

    const access = await canAccessDeviceSite(c, deviceId);
    if (!access.ok) {
      if (access.status === 403) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await previewEffectiveConfig(deviceId, changes, auth);
    if (!result) return c.json({ error: 'Device not found or access denied' }, 404);

    return c.json(result);
  }
);
