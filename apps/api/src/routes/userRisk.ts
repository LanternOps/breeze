import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

import { authMiddleware, requirePermission, requireScope, resolveOrgAccess } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  assignSecurityTraining,
  getUserRiskDetail,
  getUserRiskOrgMembership,
  getOrCreateUserRiskPolicy,
  listUserRiskEvents,
  listUserRiskScores,
  updateUserRiskPolicy
} from '../services/userRiskScoring';

const listScoresQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  trendDirection: z.enum(['up', 'down', 'stable']).optional(),
  search: z.string().min(1).max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25)
});

const detailParamSchema = z.object({
  userId: z.string().uuid()
});

const detailQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

const eventsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  eventType: z.string().max(60).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50)
});

const policyPayloadSchema = z.object({
  orgId: z.string().uuid().optional(),
  weights: z.record(z.string(), z.number().min(0)).optional(),
  thresholds: z.record(z.string(), z.number()).optional(),
  interventions: z.record(z.string(), z.unknown()).optional()
});

const assignTrainingSchema = z.object({
  orgId: z.string().uuid().optional(),
  userId: z.string().uuid(),
  moduleId: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(500).optional()
});

function resolveWriteOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  },
  requestedOrgId?: string
): { orgId?: string; error?: string; status?: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this scope', status: 400 };
}

export const userRiskRoutes = new Hono();

userRiskRoutes.use('*', authMiddleware);
userRiskRoutes.use('*', requireScope('organization', 'partner', 'system'));

userRiskRoutes.get(
  '/scores',
  requirePermission('users', 'read'),
  zValidator('query', listScoresQuerySchema),
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
    const result = await listUserRiskScores({
      orgIds,
      siteId: query.siteId,
      minScore: query.minScore,
      maxScore: query.maxScore,
      trendDirection: query.trendDirection,
      search: query.search,
      limit: query.limit,
      offset
    });

    return c.json({
      data: result.rows,
      pagination: {
        total: result.total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit))
      },
      summary: {
        averageScore: result.rows.length > 0
          ? Math.round(result.rows.reduce((sum, row) => sum + row.score, 0) / result.rows.length)
          : 0,
        highRiskUsers: result.rows.filter((row) => row.score >= 70).length,
        criticalRiskUsers: result.rows.filter((row) => row.score >= 85).length
      }
    });
  }
);

userRiskRoutes.get(
  '/users/:userId',
  requirePermission('users', 'read'),
  zValidator('param', detailParamSchema),
  zValidator('query', detailQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { userId } = c.req.valid('param');
    const query = c.req.valid('query');

    const orgResolution = await resolveOrgAccess(auth, query.orgId);
    if (orgResolution.type === 'error') {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }

    if (orgResolution.type === 'multiple') {
      const memberships = await Promise.all(
        orgResolution.orgIds.map(async (orgId) => ({
          orgId,
          member: await getUserRiskOrgMembership(userId, orgId)
        }))
      );

      const matches = memberships.filter((entry) => entry.member).map((entry) => entry.orgId);
      if (matches.length === 0) {
        return c.json({ error: 'User not found in accessible organizations' }, 404);
      }
      if (matches.length > 1) {
        return c.json({ error: 'orgId is required for users mapped to multiple organizations' }, 400);
      }

      const detail = await getUserRiskDetail(matches[0], userId);
      if (!detail) return c.json({ error: 'No user risk data available for this user' }, 404);
      return c.json({ data: detail });
    }

    const resolvedOrgId = orgResolution.type === 'single'
      ? orgResolution.orgId
      : query.orgId;

    if (!resolvedOrgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const detail = await getUserRiskDetail(resolvedOrgId, userId);
    if (!detail) {
      return c.json({ error: 'No user risk data available for this user' }, 404);
    }

    return c.json({ data: detail });
  }
);

userRiskRoutes.get(
  '/events',
  requirePermission('users', 'read'),
  zValidator('query', eventsQuerySchema),
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
    const result = await listUserRiskEvents({
      orgIds,
      userId: query.userId,
      eventType: query.eventType,
      severity: query.severity,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
      offset
    });

    return c.json({
      data: result.rows,
      pagination: {
        total: result.total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit))
      }
    });
  }
);

userRiskRoutes.put(
  '/policy',
  requirePermission('users', 'write'),
  zValidator('json', policyPayloadSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const resolved = resolveWriteOrgId(auth, payload.orgId);
    if (!resolved.orgId) {
      return c.json({ error: resolved.error ?? 'Organization resolution failed' }, resolved.status ?? 400);
    }

    const policy = await updateUserRiskPolicy({
      orgId: resolved.orgId,
      updatedBy: auth.user.id,
      weights: payload.weights,
      thresholds: payload.thresholds,
      interventions: payload.interventions
    });

    writeRouteAudit(c, {
      orgId: resolved.orgId,
      action: 'user_risk.policy.update',
      resourceType: 'user_risk_policy',
      details: {
        orgId: resolved.orgId,
        updatedBy: auth.user.id
      }
    });

    return c.json({ data: policy });
  }
);

userRiskRoutes.get('/policy', requirePermission('users', 'read'), zValidator('query', z.object({ orgId: z.string().uuid().optional() })), async (c) => {
  const auth = c.get('auth');
  const { orgId } = c.req.valid('query');

  const resolved = resolveWriteOrgId(auth, orgId);
  if (!resolved.orgId) {
    return c.json({ error: resolved.error ?? 'Organization resolution failed' }, resolved.status ?? 400);
  }

  const policy = await getOrCreateUserRiskPolicy(resolved.orgId);
  return c.json({ data: policy });
});

userRiskRoutes.post(
  '/assign-training',
  requirePermission('users', 'write'),
  zValidator('json', assignTrainingSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const resolved = resolveWriteOrgId(auth, payload.orgId);
    if (!resolved.orgId) {
      return c.json({ error: resolved.error ?? 'Organization resolution failed' }, resolved.status ?? 400);
    }

    const assignment = await assignSecurityTraining({
      orgId: resolved.orgId,
      userId: payload.userId,
      moduleId: payload.moduleId,
      reason: payload.reason,
      assignedBy: auth.user.id
    });

    writeRouteAudit(c, {
      orgId: resolved.orgId,
      action: 'user_risk.training.assign',
      resourceType: 'user',
      resourceId: payload.userId,
      details: {
        moduleId: assignment.moduleId,
        reason: payload.reason ?? null
      }
    });

    return c.json({
      success: true,
      assignmentEventId: assignment.assignmentEventId,
      moduleId: assignment.moduleId,
      deduplicated: assignment.deduplicated,
      eventPublished: assignment.eventPublished
    }, 201);
  }
);
