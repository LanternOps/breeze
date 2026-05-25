import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import { listStatusQuerySchema, deviceIdParamSchema } from './schemas';
import { getPagination, paginate, listStatusRows, toStatusResponse } from './helpers';

export const statusRoutes = new Hono();

statusRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listStatusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);

    let results = statuses;

    if (query.providerId) {
      results = results.filter((status) => status.providerId === query.providerId);
    }

    if (query.status) {
      results = results.filter((status) => status.status === query.status);
    }

    if (query.riskLevel) {
      results = results.filter((status) => status.riskLevel === query.riskLevel);
    }

    if (query.os) {
      results = results.filter((status) => status.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((status) => {
        const providerName = status.provider.name.toLowerCase();
        return (
          status.deviceName.toLowerCase().includes(term) ||
          status.deviceId.toLowerCase().includes(term) ||
          providerName.includes(term)
        );
      });
    }

    const response = paginate(results, page, limit);
    return c.json(response);
  }
);

statusRoutes.get(
  '/status/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);
    const status = statuses.find((item) => item.deviceId === deviceId);

    if (!status) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Site-scope gate: partner-scope users restricted via `allowedSiteIds`
    // must not see status for devices in sites they cannot access. RLS does
    // not defend the site axis — mirrors PR #864/#868.
    let userPerms = c.get('permissions') as UserPermissions | undefined;
    if (!userPerms) {
      const fetched = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined,
      });
      userPerms = fetched || undefined;
    }
    if (userPerms?.allowedSiteIds) {
      const [device] = await db
        .select({ siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!device || typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
    }

    return c.json({ data: status });
  }
);
