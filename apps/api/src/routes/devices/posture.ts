import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { buildDeviceScope } from './scope';
import {
  MANAGEMENT_POSTURE_CATEGORIES,
  getManagementPostureSummary,
  getPostureDevices,
} from '../../services/managementPostureReport';

/**
 * Fleet management-posture report routes (#3244).
 *
 * GET /devices/management-posture/summary — per-org, per-product, per-status
 * counts over the whole accessible fleet in ONE request (replaces the
 * migration toolkit's N+1 loop over GET /devices/:id/management-posture).
 * GET /devices/management-posture/devices — the drill-down behind a count.
 *
 * Mounted BEFORE coreRoutes so the static `/management-posture/...` paths are
 * not eaten by the `/:id` matcher (same convention as /stats, /network).
 *
 * Scoping mirrors GET /devices/stats: org narrowing via auth.orgCondition,
 * optional ?orgId (403 when inaccessible), site-restricted users narrowed to
 * their allowedSiteIds (empty allowlist => empty report, deliberately
 * indistinguishable from an empty fleet).
 */
export const postureRoutes = new Hono();

postureRoutes.use('*', authMiddleware);

const baseQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  category: z.enum(MANAGEMENT_POSTURE_CATEGORIES).default('rmm'),
  stalenessDays: z.coerce.number().int().min(1).max(365).default(7),
});

const devicesQuerySchema = baseQuerySchema.extend({
  product: z.string().min(1).max(255),
  status: z.enum(['active', 'installed', 'unknown']).optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

postureRoutes.get(
  '/management-posture/summary',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', baseQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    const scoped = buildDeviceScope(auth, permissions, query.orgId);
    if ('forbidden' in scoped) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    if ('emptyAllowlist' in scoped) {
      return c.json({
        data: {
          category: query.category,
          stalenessDays: query.stalenessDays,
          totals: {
            totalDevices: 0, neverScanned: 0, stale: 0,
            scannedNoneDetected: 0, detectedDevices: 0, freshDetectedDevices: 0,
          },
          orgs: [],
        },
      });
    }

    const summary = await getManagementPostureSummary({
      category: query.category,
      stalenessDays: query.stalenessDays,
      scope: scoped.scope,
    });

    return c.json({ data: summary });
  }
);

postureRoutes.get(
  '/management-posture/devices',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', devicesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    const scoped = buildDeviceScope(auth, permissions, query.orgId);
    if ('forbidden' in scoped) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    if ('emptyAllowlist' in scoped) {
      return c.json({ data: { devices: [], total: 0, page, limit } });
    }

    const result = await getPostureDevices({
      category: query.category,
      stalenessDays: query.stalenessDays,
      scope: scoped.scope,
      product: query.product,
      detectionStatus: query.status,
      limit,
      offset,
    });

    return c.json({ data: { ...result, page, limit } });
  }
);
