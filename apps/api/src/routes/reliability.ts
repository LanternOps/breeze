import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import {
  getDeviceReliability,
  getDeviceReliabilityHistory,
  getOrgReliabilitySummary,
  evaluateReliabilityScores,
  listReliabilityDevices,
  type ReliabilityScoreRange,
} from '../services/reliabilityScoring';
import { emitDeviceReliabilityFeedback } from '../services/mlFeedbackEmitters';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './devices/helpers';

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  scoreRange: z.string().optional(),
  trendDirection: z.enum(['improving', 'stable', 'degrading']).optional(),
  issueType: z.enum(['crashes', 'hangs', 'hardware', 'services', 'uptime']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const deviceIdParamSchema = z.object({
  deviceId: z.string().guid(),
});

const orgIdParamSchema = z.object({
  orgId: z.string().guid(),
});

const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

const evaluationQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  atRiskMaxScore: z.coerce.number().int().min(0).max(100).default(70),
  labelWindowDays: z.coerce.number().int().min(1).max(365).default(90),
});

const feedbackBodySchema = z.object({
  outcome: z.enum(['failure_confirmed', 'replaced', 'false_alarm']),
  occurredAt: z.coerce.date().optional(),
  sourceEventId: z.string().guid().optional(),
  snapshotComputedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
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

function reliabilityFeedbackDedupeKey(options: {
  outcome: 'failure_confirmed' | 'replaced' | 'false_alarm';
  sourceEventId?: string;
  snapshotComputedAt?: string;
}): string {
  if (options.sourceEventId) {
    return `source:${options.sourceEventId}:${options.outcome}`;
  }
  return `snapshot:${options.snapshotComputedAt ?? 'unknown'}:${options.outcome}`;
}

export const reliabilityRoutes = new Hono();
const requireReliabilityRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

reliabilityRoutes.use('*', authMiddleware);

function canAccessDeviceSite(device: { siteId?: string | null }, permissions: UserPermissions | undefined): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId);
}

reliabilityRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
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
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds && query.siteId && !canAccessSite(permissions, query.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    const { total, rows } = await listReliabilityDevices({
      orgIds,
      siteId: query.siteId ?? (permissions?.allowedSiteIds?.length === 1 ? permissions.allowedSiteIds[0] : undefined),
      scoreRange: parseScoreRange(query.scoreRange),
      trendDirection: query.trendDirection,
      issueType: query.issueType,
      minScore: query.minScore,
      maxScore: query.maxScore,
      limit: query.limit,
      offset,
    });
    const visibleRows = permissions?.allowedSiteIds
      ? rows.filter((row) => canAccessDeviceSite(row, permissions))
      : rows;

    const averageScore = visibleRows.length > 0
      ? Math.round(visibleRows.reduce((sum, row) => sum + row.reliabilityScore, 0) / visibleRows.length)
      : 0;

    return c.json({
      data: visibleRows,
      pagination: {
        total: permissions?.allowedSiteIds && !query.siteId ? visibleRows.length : total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil((permissions?.allowedSiteIds && !query.siteId ? visibleRows.length : total) / query.limit)),
      },
      summary: {
        averageScore,
        criticalDevices: visibleRows.filter((row) => row.reliabilityScore <= 50).length,
        degradingDevices: visibleRows.filter((row) => row.trendDirection === 'degrading').length,
      },
    });
  }
);

reliabilityRoutes.get(
  '/evaluation',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('query', evaluationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }
    if (permissions?.allowedSiteIds && query.siteId && !canAccessSite(permissions, query.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const orgIds = query.orgId
      ? [query.orgId]
      : auth.orgId
        ? [auth.orgId]
        : (auth.accessibleOrgIds?.length ? auth.accessibleOrgIds : undefined);

    if (!orgIds && auth.scope !== 'system') {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const summary = await evaluateReliabilityScores({
      orgIds,
      siteId: query.siteId,
      siteIds: query.siteId ? undefined : permissions?.allowedSiteIds,
      atRiskMaxScore: query.atRiskMaxScore,
      labelWindowDays: query.labelWindowDays,
    });

    return c.json({ summary });
  }
);

reliabilityRoutes.get(
  '/org/:orgId/summary',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('param');

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const siteIds = permissions?.allowedSiteIds;
    const [summary, worstDevices] = await Promise.all([
      getOrgReliabilitySummary(orgId, { siteIds }),
      listReliabilityDevices({ orgId, siteIds, limit: 10, offset: 0 }),
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
  requireReliabilityRead,
  zValidator('param', deviceIdParamSchema),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const { days } = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
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

reliabilityRoutes.post(
  '/:deviceId/feedback',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', feedbackBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const snapshot = await getDeviceReliability(deviceId);
    if (!snapshot) {
      return c.json({ error: 'No reliability snapshot available for this device yet' }, 404);
    }

    const eventType = body.outcome === 'failure_confirmed'
      ? 'device.failure_confirmed'
      : body.outcome === 'replaced'
        ? 'device.replaced'
        : 'device.false_alarm';

    await emitDeviceReliabilityFeedback({
      orgId: device.orgId,
      deviceId,
      eventType,
      dedupeKey: reliabilityFeedbackDedupeKey({
        outcome: body.outcome,
        sourceEventId: body.sourceEventId,
        snapshotComputedAt: body.snapshotComputedAt ?? snapshot.computedAt,
      }),
      outcome: body.outcome,
      actorUserId: auth.user?.id,
      occurredAt: body.occurredAt,
      metadata: {
        ...body.metadata,
        reliabilityScore: snapshot.reliabilityScore,
        topIssues: snapshot.topIssues,
        computedAt: snapshot.computedAt,
      },
    });

    return c.json({
      success: true,
      feedback: {
        deviceId,
        eventType,
        outcome: body.outcome,
      },
    });
  }
);

reliabilityRoutes.get(
  '/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
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
