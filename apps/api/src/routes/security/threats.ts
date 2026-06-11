import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';

import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import {
  listThreatsQuerySchema,
  deviceIdParamSchema,
  threatIdParamSchema,
  providerCatalog
} from './schemas';
import {
  getPagination,
  paginate,
  parseDateRange,
  matchDateRange,
  listStatusRows,
  listThreatRows,
  queueThreatAction
} from './helpers';

export const threatsRoutes = new Hono();

threatsRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let threats = await listThreatRows(auth, undefined, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.deviceName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const mapped = threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    }));

    const response = paginate(mapped, page, limit);
    return c.json({
      ...response,
      summary: {
        total: threats.length,
        active: threats.filter((t) => t.status === 'active').length,
        quarantined: threats.filter((t) => t.status === 'quarantined').length,
        critical: threats.filter((t) => t.severity === 'critical').length
      }
    });
  }
);

threatsRoutes.get(
  '/threats/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const statuses = await listStatusRows(auth);
    if (!statuses.some((row) => row.deviceId === deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Site-scope gate: partner-scope users restricted via `allowedSiteIds`
    // must not see threats for devices in sites they cannot access. RLS does
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

    let threats = await listThreatRows(auth, deviceId, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    })), page, limit);

    return c.json(response);
  }
);

threatsRoutes.post(
  '/threats/:id/quarantine',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'quarantine')
);

threatsRoutes.post(
  '/threats/:id/remove',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'remove')
);

threatsRoutes.post(
  '/threats/:id/restore',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'restore')
);
