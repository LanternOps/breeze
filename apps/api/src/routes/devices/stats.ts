import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { z } from 'zod';

export const statsRoutes = new Hono();

statsRoutes.use('*', authMiddleware);

const statsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
});

/**
 * GET /devices/stats — fleet-wide device counts by status.
 *
 * The dashboard previously derived these numbers client-side from the first
 * page of GET /devices (default limit 500), so totals silently went wrong
 * past 500 devices. This endpoint does the COUNT in SQL so the numbers are
 * exact at any fleet size and the dashboard doesn't have to pull the whole
 * device list just to show four numbers.
 *
 * Scoping mirrors the device list's DEFAULT behavior (core.ts GET /): org
 * narrowing via auth.orgCondition plus optional ?orgId (403 when
 * inaccessible), site-restricted users narrowed to their allowedSiteIds,
 * decommissioned devices excluded. (The list also has opt-in
 * includeDecommissioned and multi-value org/site filters this endpoint
 * doesn't need.) Note: a user with an empty site allowlist gets all-zero
 * counts — deliberately indistinguishable from an empty fleet, matching
 * what the device list would show them.
 */
statsRoutes.get(
  '/stats',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', statsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    const conditions: SQL[] = [sql`${devices.status} != 'decommissioned'`];

    const orgFilter = auth.orgCondition(devices.orgId);
    if (orgFilter) {
      conditions.push(orgFilter);
    }

    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    }

    const allowedSiteIds = permissions?.allowedSiteIds;
    if (allowedSiteIds) {
      if (allowedSiteIds.length === 0) {
        return c.json({ data: { total: 0, online: 0, offline: 0, byStatus: {} } });
      }
      conditions.push(inArray(devices.siteId, allowedSiteIds));
    }

    const rows = await db
      .select({ status: devices.status, count: sql<number>`count(*)` })
      .from(devices)
      .where(and(...conditions))
      .groupBy(devices.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.count);
      byStatus[row.status] = n;
      total += n;
    }

    const online = byStatus.online ?? 0;

    return c.json({
      data: {
        total,
        online,
        // "offline" here means "not currently online" (offline, maintenance,
        // updating, quarantined, pending) — the tech-facing complement of the
        // online count, not just status='offline'. byStatus has the raw split.
        offline: total - online,
        byStatus,
      },
    });
  }
);
