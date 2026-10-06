import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';

import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import {
  recommendationsQuerySchema,
  recommendationActionSchema,
  recommendationActionQuerySchema
} from './schemas';
import {
  getPagination,
  paginate,
  getPolicyOrgId,
  getRecommendationStatusMap,
  buildBe9Recommendations
} from './helpers';
import { requireSecurityReadAccess } from './readAuthorization';
import { markRequestAuditWritten } from '../../services/auditRequestTracking';
import type { AuthContext } from '../../middleware/auth';

// The org a complete/dismiss is recorded against: the caller-selected ?orgId
// (validated for access), else the token's single org. A multi-org partner
// user has auth.orgId === null, so without honouring ?orgId these actions
// always 400'd (#8086).
function resolveActionOrgId(
  auth: AuthContext,
  requestedOrgId: string | undefined
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: requestedOrgId };
  }
  const orgId = getPolicyOrgId(auth);
  if (!orgId) {
    return { error: 'Unable to determine organization context', status: 400 };
  }
  return { orgId };
}

export const recommendationsRoutes = new Hono();

recommendationsRoutes.get(
  '/recommendations',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', recommendationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const recommendationsResult = await buildBe9Recommendations(auth, query.orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendationStatusMap = await getRecommendationStatusMap(auth, query.orgId);

    let recommendations = recommendationsResult.recommendations.map((rec) => ({
      ...rec,
      status: recommendationStatusMap.get(rec.id) ?? 'open'
    }));

    if (query.priority) {
      recommendations = recommendations.filter((rec) => rec.priority === query.priority);
    }

    if (query.category) {
      recommendations = recommendations.filter((rec) => rec.category === query.category);
    }

    if (query.status) {
      recommendations = recommendations.filter((rec) => rec.status === query.status);
    }

    const all = recommendationsResult.recommendations.map((rec) => ({
      ...rec,
      status: recommendationStatusMap.get(rec.id) ?? 'open'
    }));

    return c.json({
      ...paginate(recommendations, page, limit),
      summary: {
        total: all.length,
        open: all.filter((rec) => rec.status === 'open').length,
        completed: all.filter((rec) => rec.status === 'completed').length,
        dismissed: all.filter((rec) => rec.status === 'dismissed').length,
        criticalAndHigh: all.filter((rec) => rec.priority === 'critical' || rec.priority === 'high').length
      }
    });
  }
);

recommendationsRoutes.post(
  '/recommendations/:id/complete',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', recommendationActionSchema),
  zValidator('query', recommendationActionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const resolved = resolveActionOrgId(auth, c.req.valid('query').orgId);
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { orgId } = resolved;

    const recommendationsResult = await buildBe9Recommendations(auth, orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendation = recommendationsResult.recommendations.find((item) => item.id === id);
    if (!recommendation) {
      return c.json({ error: 'Recommendation not found' }, 404);
    }

    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'security.recommendation.complete',
      resourceType: 'security_recommendation',
      resourceName: id,
      details: { recommendationId: id },
      result: 'success'
    });
    markRequestAuditWritten();

    return c.json({ data: { id, status: 'completed' } });
  }
);

recommendationsRoutes.post(
  '/recommendations/:id/dismiss',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', recommendationActionSchema),
  zValidator('query', recommendationActionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const resolved = resolveActionOrgId(auth, c.req.valid('query').orgId);
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { orgId } = resolved;

    const recommendationsResult = await buildBe9Recommendations(auth, orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendation = recommendationsResult.recommendations.find((item) => item.id === id);
    if (!recommendation) {
      return c.json({ error: 'Recommendation not found' }, 404);
    }

    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'security.recommendation.dismiss',
      resourceType: 'security_recommendation',
      resourceName: id,
      details: { recommendationId: id },
      result: 'success'
    });
    markRequestAuditWritten();

    return c.json({ data: { id, status: 'dismissed' } });
  }
);
