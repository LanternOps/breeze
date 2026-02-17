import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { recommendationsQuerySchema, recommendationActionSchema } from './schemas';
import {
  getPagination,
  paginate,
  getPolicyOrgId,
  getRecommendationStatusMap,
  buildBe9Recommendations
} from './helpers';

export const recommendationsRoutes = new Hono();

recommendationsRoutes.get(
  '/recommendations',
  requireScope('organization', 'partner', 'system'),
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
  zValidator('param', recommendationActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const orgId = getPolicyOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'Unable to determine organization context' }, 400);
    }

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

    return c.json({ data: { id, status: 'completed' } });
  }
);

recommendationsRoutes.post(
  '/recommendations/:id/dismiss',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', recommendationActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const orgId = getPolicyOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'Unable to determine organization context' }, 400);
    }

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

    return c.json({ data: { id, status: 'dismissed' } });
  }
);
