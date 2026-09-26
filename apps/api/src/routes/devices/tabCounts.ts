import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
  AI_OPERATOR_TASK_LIVE_STATES,
  aiOperatorTasks,
  alerts,
  automationPolicyCompliance,
  metricAnomalies,
  serviceProcessCheckResults,
  tickets,
} from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { alertTopologySiteGate } from '../alerts/helpers';

/**
 * GET /devices/:id/tab-counts — one "needs attention" count per signal tab on
 * the device detail page (Alerts, Anomalies, Tickets, Operator Tasks,
 * Monitoring, Compliance). The page uses these to badge / promote tabs that
 * are otherwise empty by default, so each count is "how many rows warrant a
 * look", not "how many rows exist":
 *
 *   alerts        active + acknowledged (not resolved/suppressed/dismissed)
 *   anomalies     status = open
 *   tickets       not resolved/closed (and not soft-deleted)
 *   operatorTasks live states (queued/running/waiting/paused)
 *   monitoring    latest result per (watchType, name) that is not `running`
 *   compliance    non_compliant + error
 *
 * Read-only, device-scoped, RLS-backed; the org/site gate is the same helper
 * every other `/devices/:id/*` sub-resource uses.
 */
export const tabCountsRoutes = new Hono();

tabCountsRoutes.use('*', authMiddleware);

export type DeviceTabCounts = {
  alerts: number;
  anomalies: number;
  tickets: number;
  operatorTasks: number;
  monitoring: number;
  compliance: number;
};

const countExpr = sql<number>`count(*)`;

async function countRows(query: PromiseLike<Array<{ count: number | string }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.count ?? 0);
}

tabCountsRoutes.get(
  '/:id/tab-counts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [alertCount, anomalyCount, ticketCount, operatorTaskCount, monitoringRows, complianceCount] =
      await Promise.all([
        countRows(
          db.select({ count: countExpr }).from(alerts).where(
            and(eq(alerts.deviceId, deviceId), inArray(alerts.status, ['active', 'acknowledged']), alertTopologySiteGate(auth.allowedSiteIds)),
          ),
        ),
        countRows(
          db.select({ count: countExpr }).from(metricAnomalies).where(
            and(eq(metricAnomalies.deviceId, deviceId), eq(metricAnomalies.status, 'open')),
          ),
        ),
        countRows(
          db.select({ count: countExpr }).from(tickets).where(
            and(
              eq(tickets.deviceId, deviceId),
              isNull(tickets.deletedAt),
              inArray(tickets.status, ['new', 'open', 'pending', 'on_hold']),
            ),
          ),
        ),
        countRows(
          db.select({ count: countExpr }).from(aiOperatorTasks).where(
            and(
              eq(aiOperatorTasks.deviceId, deviceId),
              inArray(aiOperatorTasks.state, [...AI_OPERATOR_TASK_LIVE_STATES]),
            ),
          ),
        ),
        // Latest result per (watchType, name) — same dedupe as
        // GET /monitoring/results/:deviceId/summary, done in SQL via
        // DISTINCT ON so it is one round trip regardless of history depth.
        db
          .selectDistinctOn([serviceProcessCheckResults.watchType, serviceProcessCheckResults.name], {
            watchType: serviceProcessCheckResults.watchType,
            name: serviceProcessCheckResults.name,
            status: serviceProcessCheckResults.status,
          })
          .from(serviceProcessCheckResults)
          .where(eq(serviceProcessCheckResults.deviceId, deviceId))
          .orderBy(
            serviceProcessCheckResults.watchType,
            serviceProcessCheckResults.name,
            desc(serviceProcessCheckResults.timestamp),
          ),
        countRows(
          db.select({ count: countExpr }).from(automationPolicyCompliance).where(
            and(
              eq(automationPolicyCompliance.deviceId, deviceId),
              inArray(automationPolicyCompliance.status, ['non_compliant', 'error']),
            ),
          ),
        ),
      ]);

    // Defensive dedupe — DISTINCT ON already guarantees one row per watch.
    const seen = new Set<string>();
    let monitoringCount = 0;
    for (const r of monitoringRows) {
      const key = `${r.watchType}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.status !== 'running') monitoringCount += 1;
    }

    const data: DeviceTabCounts = {
      alerts: alertCount,
      anomalies: anomalyCount,
      tickets: ticketCount,
      operatorTasks: operatorTaskCount,
      monitoring: monitoringCount,
      compliance: complianceCount,
    };
    return c.json({ data });
  },
);
