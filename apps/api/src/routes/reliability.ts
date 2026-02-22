import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

import { authMiddleware, requireScope } from '../middleware/auth';
import {
  getDeviceReliability,
  getDeviceReliabilityHistory,
  getOrgReliabilitySummary,
  listReliabilityDevices,
  type ReliabilityScoreRange,
} from '../services/reliabilityScoring';
import { getDeviceWithOrgCheck } from './devices/helpers';

const listQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  scoreRange: z.string().optional(),
  trendDirection: z.enum(['improving', 'stable', 'degrading']).optional(),
  issueType: z.enum(['crashes', 'hangs', 'hardware', 'services', 'uptime']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

const orgIdParamSchema = z.object({
  orgId: z.string().uuid(),
});

const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

function parseScoreRange(value: string | undefined): ReliabilityScoreRange | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'poor' || normalized === 'fair' || normalized === 'good') {
    return normalized;
  }

  // Backward-compatible format: "0-50", "51-70", etc.
  if (normalized === '0-50') return 'critical';
  if (normalized === '51-70') return 'poor';
  if (normalized === '71-85') return 'fair';
  if (normalized === '86-100') return 'good';
  return undefined;
}

export const reliabilityRoutes = new Hono();

reliabilityRoutes.use('*', authMiddleware);

reliabilityRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const orgIds = query.orgId
      ? [query.orgId]
      : auth.orgId
        ? [auth.orgId]
        : (auth.accessibleOrgIds?.length ? auth.accessibleOrgIds : undefined);

    if (!orgIds && auth.scope !== 'system') {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const offset = (query.page - 1) * query.limit;
    const { total, rows } = await listReliabilityDevices({
      orgIds,
      siteId: query.siteId,
      scoreRange: parseScoreRange(query.scoreRange),
      trendDirection: query.trendDirection,
      issueType: query.issueType,
      minScore: query.minScore,
      maxScore: query.maxScore,
      limit: query.limit,
      offset,
    });

    const averageScore = rows.length > 0
      ? Math.round(rows.reduce((sum, row) => sum + row.reliabilityScore, 0) / rows.length)
      : 0;

    return c.json({
      data: rows,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
      summary: {
        averageScore,
        criticalDevices: rows.filter((row) => row.reliabilityScore <= 50).length,
        degradingDevices: rows.filter((row) => row.trendDirection === 'degrading').length,
      },
    });
  }
);

reliabilityRoutes.get(
  '/org/:orgId/summary',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('param');

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const [summary, worstDevices] = await Promise.all([
      getOrgReliabilitySummary(orgId),
      listReliabilityDevices({ orgId, limit: 10, offset: 0 }),
    ]);

    return c.json({
      summary,
      worstDevices: worstDevices.rows,
    });
  }
);

reliabilityRoutes.get(
  '/:deviceId/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const { days } = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const points = await getDeviceReliabilityHistory(deviceId, days);
    return c.json({
      deviceId,
      days,
      points,
    });
  }
);

reliabilityRoutes.get(
  '/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [snapshot, history] = await Promise.all([
      getDeviceReliability(deviceId),
      getDeviceReliabilityHistory(deviceId, 30),
    ]);

    if (!snapshot) {
      return c.json({ error: 'No reliability snapshot available for this device yet' }, 404);
    }

    return c.json({
      snapshot,
      history,
    });
  }
);
