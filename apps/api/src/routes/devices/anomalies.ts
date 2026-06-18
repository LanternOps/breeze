import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db';
import { metricAnomalies } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { emitAnomalyFeedback } from '../../services/mlFeedbackEmitters';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const anomaliesRoutes = new Hono();

anomaliesRoutes.use('*', authMiddleware);

const anomaliesQuerySchema = z.object({
  status: z.enum(['open', 'dismissed', 'promoted', 'resolved', 'all']).optional().default('open'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

const anomalyStatusSchema = z.object({
  status: z.enum(['dismissed', 'promoted', 'resolved']),
  note: z.string().max(500).optional(),
});

function serializeAnomaly(row: typeof metricAnomalies.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    sourceTable: row.sourceTable,
    metricType: row.metricType,
    metricName: row.metricName,
    anomalyType: row.anomalyType,
    status: row.status,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    bucketSeconds: row.bucketSeconds,
    observedValue: row.observedValue,
    baselineValue: row.baselineValue,
    baselineMin: row.baselineMin,
    baselineMax: row.baselineMax,
    score: row.score,
    confidence: row.confidence,
    sampleCount: row.sampleCount,
    baselineSummary: row.baselineSummary,
    evidence: row.evidence,
    linkedAlertId: row.linkedAlertId,
    linkedCorrelationGroupId: row.linkedCorrelationGroupId,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

anomaliesRoutes.get(
  '/:id/anomalies',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', anomaliesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const conditions = [
      eq(metricAnomalies.orgId, device.orgId),
      eq(metricAnomalies.deviceId, deviceId),
    ];
    if (query.status !== 'all') {
      conditions.push(eq(metricAnomalies.status, query.status));
    }

    const rows = await db
      .select()
      .from(metricAnomalies)
      .where(and(...conditions))
      .orderBy(desc(metricAnomalies.detectedAt))
      .limit(query.limit);

    return c.json({ data: rows.map(serializeAnomaly) });
  }
);

anomaliesRoutes.patch(
  '/:id/anomalies/:anomalyId/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action),
  zValidator('json', anomalyStatusSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const anomalyId = c.req.param('anomalyId');
    const input = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const now = new Date();
    const [updated] = await db
      .update(metricAnomalies)
      .set({
        status: input.status,
        resolvedAt: input.status === 'resolved' ? now : null,
        updatedAt: now,
      })
      .where(and(
        eq(metricAnomalies.id, anomalyId),
        eq(metricAnomalies.orgId, device.orgId),
        eq(metricAnomalies.deviceId, deviceId),
      ))
      .returning();

    if (!updated) {
      return c.json({ error: 'Anomaly not found' }, 404);
    }

    await emitAnomalyFeedback({
      orgId: updated.orgId,
      anomalyId: updated.id,
      eventType: `anomaly.${input.status}`,
      outcome: input.status,
      actorUserId: auth.user.id,
      metadata: {
        route: 'devices.anomalies.status',
        metricName: updated.metricName,
        anomalyType: updated.anomalyType,
        note: input.note,
      },
    });

    return c.json({ data: serializeAnomaly(updated) });
  }
);
