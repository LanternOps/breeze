import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';
import { db } from '../../db';
import { alerts, alertRules, alertTemplates } from '../../db/schema';

export const alertsRoutes = new Hono();

alertsRoutes.use('*', authMiddleware);

const alertsQuerySchema = z.object({
  status: z.enum(['active', 'acknowledged', 'resolved', 'all']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
});

// GET /devices/:id/alerts - Get device alerts
alertsRoutes.get(
  '/:id/alerts',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', alertsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Build query conditions
    const conditions = [eq(alerts.deviceId, deviceId)];

    if (query.status && query.status !== 'all') {
      conditions.push(eq(alerts.status, query.status));
    }

    if (query.startDate) {
      conditions.push(gte(alerts.triggeredAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(alerts.triggeredAt, new Date(query.endDate)));
    }

    // Fetch alerts with rule and template info
    const deviceAlerts = await db
      .select({
        id: alerts.id,
        title: alerts.title,
        message: alerts.message,
        severity: alerts.severity,
        status: alerts.status,
        triggeredAt: alerts.triggeredAt,
        acknowledgedAt: alerts.acknowledgedAt,
        resolvedAt: alerts.resolvedAt,
        ruleName: alertRules.name,
        templateName: alertTemplates.name,
      })
      .from(alerts)
      .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
      .where(and(...conditions))
      .orderBy(desc(alerts.triggeredAt))
      .limit(query.limit);

    // Transform to match frontend expectations
    const data = deviceAlerts.map(alert => ({
      id: alert.id,
      message: alert.message || alert.title,
      summary: alert.title,
      severity: alert.severity,
      status: alert.status,
      createdAt: alert.triggeredAt?.toISOString(),
      timestamp: alert.triggeredAt?.toISOString(),
      acknowledgedAt: alert.acknowledgedAt?.toISOString(),
      resolvedAt: alert.resolvedAt?.toISOString(),
      ruleName: alert.ruleName,
      templateName: alert.templateName,
    }));

    return c.json({ data });
  }
);
