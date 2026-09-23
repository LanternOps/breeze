import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { EPISODE_ACTIONS, EPISODE_LIST_STATUSES, METRIC_ANOMALY_STATUSES } from '@breeze/shared';
import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '../../db';
import { metricAnomalies } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { applyEpisodeAction } from '../../services/metricAnomalyEpisodeActions';
import {
  getDeviceEpisodeDetail,
  getDeviceEpisodeDto,
  listDeviceEpisodes,
} from '../../services/metricAnomalyEpisodeQueries';
import { promoteMetricAnomalyToAlert } from '../../services/metricAnomalyPromotion';
import { emitAnomalyFeedback } from '../../services/mlFeedbackEmitters';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const anomaliesRoutes = new Hono();

anomaliesRoutes.use('*', authMiddleware);

const anomaliesQuerySchema = z.object({
  // `cleared` = closed by episode auto-resolve (metric anomaly episodes W01).
  // PATCH below deliberately still refuses it: a human never sets `cleared`.
  status: z.enum([...METRIC_ANOMALY_STATUSES, 'all']).optional().default('open'),
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

    if (input.status === 'promoted') {
      const result = await promoteMetricAnomalyToAlert({
        orgId: device.orgId,
        deviceId,
        anomalyId,
        actorUserId: auth.user.id,
        requireCreateAlertsFlag: false,
      });

      if (result.status === 'not_found') {
        return c.json({ error: 'Anomaly not found' }, 404);
      }
      if (result.status === 'disabled') {
        return c.json({ error: 'Anomaly alert promotion is disabled' }, 409);
      }

      await emitAnomalyFeedback({
        orgId: result.anomaly.orgId,
        anomalyId: result.anomaly.id,
        eventType: 'anomaly.promoted',
        dedupeKey: result.alertId ? `promoted:alert:${result.alertId}` : 'promoted',
        outcome: 'promoted',
        actorUserId: auth.user.id,
        occurredAt: result.anomaly.updatedAt,
        metadata: {
          route: 'devices.anomalies.status',
          metricName: result.anomaly.metricName,
          anomalyType: result.anomaly.anomalyType,
          linkedAlertId: result.alertId,
          createdAlert: result.created,
          note: input.note,
        },
      });

      return c.json({ data: serializeAnomaly(result.anomaly) });
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
        ne(metricAnomalies.status, input.status),
      ))
      .returning();

    if (!updated) {
      const [existing] = await db
        .select()
        .from(metricAnomalies)
        .where(and(
          eq(metricAnomalies.id, anomalyId),
          eq(metricAnomalies.orgId, device.orgId),
          eq(metricAnomalies.deviceId, deviceId),
        ))
        .limit(1);
      if (!existing) {
        return c.json({ error: 'Anomaly not found' }, 404);
      }
      return c.json({ data: serializeAnomaly(existing) });
    }

    await emitAnomalyFeedback({
      orgId: updated.orgId,
      anomalyId: updated.id,
      eventType: `anomaly.${input.status}`,
      dedupeKey: `status:${input.status}`,
      outcome: input.status,
      actorUserId: auth.user.id,
      occurredAt: updated.updatedAt,
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

// ── Metric anomaly EPISODES (spec §8, §12 — W02) ─────────────────────────
// Registered here, not in a new module: the per-row anomaly routes and these
// share one resource family and one MCP_COVERAGE gap (#6141) — see the W02
// plan's spec deviation D-3.

const episodeListQuerySchema = z.object({
  status: z.enum(EPISODE_LIST_STATUSES).optional().default('open'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  ref: z.string().guid().optional(),
});

const episodeParamSchema = z.object({
  id: z.string(),
  episodeId: z.string().guid(),
});

const episodeActionSchema = z.object({
  action: z.enum(EPISODE_ACTIONS),
  note: z.string().trim().max(500).optional(),
  resolveAlert: z.boolean().optional().default(true),
});

anomaliesRoutes.get(
  '/:id/anomaly-episodes',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', episodeListQuerySchema),
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

    const result = await listDeviceEpisodes({
      orgId: device.orgId,
      deviceId,
      status: query.status,
      limit: query.limit,
      ref: query.ref,
    });
    return c.json(result);
  }
);

anomaliesRoutes.get(
  '/:id/anomaly-episodes/:episodeId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', episodeParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, episodeId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const detail = await getDeviceEpisodeDetail({ orgId: device.orgId, deviceId, episodeId });
    if (!detail) {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    return c.json({ data: detail });
  }
);

anomaliesRoutes.patch(
  '/:id/anomaly-episodes/:episodeId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action),
  zValidator('param', episodeParamSchema),
  zValidator('json', episodeActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, episodeId } = c.req.valid('param');
    const input = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await applyEpisodeAction({
      orgId: device.orgId,
      deviceId,
      episodeId,
      action: input.action,
      // A whitespace-only note trims to "" — treat it as no note, never overwrite one with "".
      note: input.note || undefined,
      resolveAlert: input.resolveAlert,
      actorUserId: auth.user.id,
    });

    if (result.status === 'not_found') {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    if (result.status === 'conflict') {
      return c.json({ error: result.message, reason: result.reason }, 409);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: `device.anomaly_episode.${input.action}`,
      resourceType: 'metric_anomaly_episode',
      resourceId: episodeId,
      details: {
        deviceId,
        labelledMembers: result.labelledMemberIds.length,
        alertId: result.alertId,
        alertResolved: result.alertResolved,
        resolveAlert: input.resolveAlert,
      },
    });

    const data = await getDeviceEpisodeDto({ orgId: device.orgId, deviceId, episodeId });
    if (!data) {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    return c.json({
      data,
      meta: {
        alertId: result.alertId,
        alertResolved: result.alertResolved,
        labelledMembers: result.labelledMemberIds.length,
      },
    });
  }
);
