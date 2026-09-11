import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { alerts, alertCorrelations } from '../../db/schema';
import { eq, and, or, desc, inArray } from 'drizzle-orm';
import { requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { listCorrelationsSchema, analyzeCorrelationsSchema } from './schemas';
import { resolveScopedOrgId } from './helpers';
import { getPagination } from '../../utils/pagination';
import { deviceInSiteScope, filterAlertsBySiteScope } from '../tickets/siteScope';

export const correlationRoutes = new Hono();

const requireAlertRead = requirePermission(
  PERMISSIONS.ALERTS_READ.resource,
  PERMISSIONS.ALERTS_READ.action,
);

async function visibleOrgAlertIds(auth: AuthContext, orgId: string): Promise<string[]> {
  const orgAlerts = await db
    .select({ id: alerts.id, deviceId: alerts.deviceId })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));
  const visibleAlerts = await filterAlertsBySiteScope({ ...auth, orgId }, orgAlerts);
  return visibleAlerts.map((alert) => alert.id);
}

export function filterCorrelationsToVisibleAlerts<
  T extends { parentAlertId: string; childAlertId: string },
>(correlations: T[], visibleAlertIds: readonly string[]): T[] {
  const visible = new Set(visibleAlertIds);
  return correlations.filter(
    (correlation) => visible.has(correlation.parentAlertId) && visible.has(correlation.childAlertId),
  );
}

correlationRoutes.get(
  '/correlations',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', listCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');

      // Get all alert IDs for this org to scope correlations
      const orgAlertIds = await visibleOrgAlertIds(auth, orgId);

      if (orgAlertIds.length === 0) {
        return c.json({ data: [], page: 1, limit: 20, total: 0 });
      }

      const filterConditions = [
        inArray(alertCorrelations.parentAlertId, orgAlertIds),
        inArray(alertCorrelations.childAlertId, orgAlertIds),
      ];

      if (query.alertId) {
        filterConditions.push(
          or(
            eq(alertCorrelations.parentAlertId, query.alertId),
            eq(alertCorrelations.childAlertId, query.alertId)
          )!
        );
      }

      let allCorrelations = await db
        .select()
        .from(alertCorrelations)
        .where(and(...filterConditions))
        .orderBy(desc(alertCorrelations.createdAt));
      allCorrelations = filterCorrelationsToVisibleAlerts(allCorrelations, orgAlertIds);

      if (query.minConfidence) {
        const minConfidence = Number.parseFloat(query.minConfidence);
        if (!Number.isNaN(minConfidence)) {
          allCorrelations = allCorrelations.filter(
            link => Number(link.confidence) >= minConfidence
          );
        }
      }

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: allCorrelations.slice(offset, offset + limit),
        page,
        limit,
        total: allCorrelations.length
      });
    } catch (error) {
      console.error('[Correlations] Failed to list correlations', error);
      return c.json({ error: 'Failed to list correlations' }, 500);
    }
  }
);

correlationRoutes.get(
  '/correlations/groups',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      // Build correlation groups from real data:
      // Group alerts that share correlation links into clusters
      const allOrgAlerts = await db
        .select()
        .from(alerts)
        .where(eq(alerts.orgId, orgId));
      const orgAlerts = await filterAlertsBySiteScope({ ...auth, orgId }, allOrgAlerts);

      const orgAlertIds = orgAlerts.map(a => a.id);
      const alertMap = new Map(orgAlerts.map(a => [a.id, a]));

      if (orgAlertIds.length === 0) {
        return c.json({ data: [] });
      }

      const correlationRows = await db
        .select()
        .from(alertCorrelations)
        .where(and(
          inArray(alertCorrelations.parentAlertId, orgAlertIds),
          inArray(alertCorrelations.childAlertId, orgAlertIds)
        ))
        .orderBy(desc(alertCorrelations.createdAt));
      const scopedCorrelations = filterCorrelationsToVisibleAlerts(correlationRows, orgAlertIds);

      // Union-find to group correlated alerts
      const parent = new Map<string, string>();
      const find = (id: string): string => {
        if (!parent.has(id)) parent.set(id, id);
        if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
        return parent.get(id)!;
      };
      const union = (a: string, b: string) => {
        parent.set(find(a), find(b));
      };

      for (const corr of scopedCorrelations) {
        union(corr.parentAlertId, corr.childAlertId);
      }

      // Build groups
      const groupMap = new Map<string, string[]>();
      for (const corr of scopedCorrelations) {
        const root = find(corr.parentAlertId);
        if (!groupMap.has(root)) groupMap.set(root, []);
        const group = groupMap.get(root)!;
        if (!group.includes(corr.parentAlertId)) group.push(corr.parentAlertId);
        if (!group.includes(corr.childAlertId)) group.push(corr.childAlertId);
      }

      const groups = [...groupMap.entries()].map(([rootId, alertIds]) => {
        const groupAlerts = alertIds.map(id => alertMap.get(id)).filter(Boolean);
        const groupCorrelations = scopedCorrelations.filter(
          c => alertIds.includes(c.parentAlertId) || alertIds.includes(c.childAlertId)
        );
        const avgConfidence = groupCorrelations.length > 0
          ? groupCorrelations.reduce((sum, c) => sum + Number(c.confidence ?? 0), 0) / groupCorrelations.length
          : 0;

        return {
          id: rootId,
          title: `Correlated Alert Group (${groupAlerts.length} alerts)`,
          summary: `${groupAlerts.length} alerts correlated on the same device within a time window.`,
          correlationScore: Math.round(avgConfidence * 100) / 100,
          alerts: groupAlerts,
          createdAt: groupCorrelations[0]?.createdAt ?? new Date(),
        };
      });

      return c.json({ data: groups });
    } catch (error) {
      console.error('[Correlations] Failed to list correlation groups', error);
      return c.json({ error: 'Failed to list correlation groups' }, 500);
    }
  }
);

correlationRoutes.post(
  '/correlations/analyze',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('json', analyzeCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const data = c.req.valid('json');
      const windowMinutes = data.windowMinutes ?? 60;

      const orgAlertIdList = await visibleOrgAlertIds(auth, orgId);
      const orgAlertIdSet = new Set(orgAlertIdList);
      const requestedAlertIds = data.alertIds ?? [];
      const alertIds = requestedAlertIds.filter(id => orgAlertIdSet.has(id));

      if (orgAlertIdList.length === 0) {
        return c.json({
          data: {
            requestedAlertIds: alertIds,
            windowMinutes,
            links: [],
            summary: 'No alerts found for this organization.'
          }
        });
      }

      const scopeConditions = [
        inArray(alertCorrelations.parentAlertId, orgAlertIdList),
        inArray(alertCorrelations.childAlertId, orgAlertIdList),
      ];

      if (requestedAlertIds.length && alertIds.length > 0) {
        scopeConditions.push(
          or(
            inArray(alertCorrelations.parentAlertId, alertIds),
            inArray(alertCorrelations.childAlertId, alertIds)
          )!
        );
      }

      // A non-empty request that resolves entirely outside the caller's site
      // ceiling is an empty selection, not an implicit request for every
      // visible correlation in the organization.
      const linkRows = requestedAlertIds.length > 0 && alertIds.length === 0
        ? []
        : await db
          .select()
          .from(alertCorrelations)
          .where(and(...scopeConditions))
          .orderBy(desc(alertCorrelations.createdAt));
      const links = filterCorrelationsToVisibleAlerts(linkRows, orgAlertIdList);

      writeRouteAudit(c, {
        orgId,
        action: 'alert_correlation.analyze',
        resourceType: 'alert_correlation',
        details: {
          requestedAlertCount: alertIds.length,
          linkCount: links.length,
          windowMinutes,
        },
      });

      return c.json({
        data: {
          requestedAlertIds: alertIds,
          windowMinutes,
          links,
          summary: requestedAlertIds.length
            ? alertIds.length
              ? 'Correlation analysis complete for requested alerts.'
              : 'No visible requested alerts found.'
            : 'Returning all correlation data.'
        }
      });
    } catch (error) {
      console.error('[Correlations] Failed to analyze correlations', error);
      return c.json({ error: 'Failed to analyze correlations' }, 500);
    }
  }
);

correlationRoutes.get(
  '/correlations/:alertId',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const alertId = c.req.param('alertId')!;

      const [alert] = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId)))
        .limit(1);

      if (!alert || !(await deviceInSiteScope(auth, alert.deviceId))) {
        return c.json({ error: 'Alert not found' }, 404);
      }

      const correlations = await db
        .select()
        .from(alertCorrelations)
        .where(
          or(
            eq(alertCorrelations.parentAlertId, alertId),
            eq(alertCorrelations.childAlertId, alertId)
          )
        );

      // Get related alert IDs
      const relatedIds = new Set<string>();
      for (const corr of correlations) {
        relatedIds.add(corr.parentAlertId === alertId ? corr.childAlertId : corr.parentAlertId);
      }

      let relatedAlerts: typeof alerts.$inferSelect[] = [];
      if (relatedIds.size > 0) {
        const ids = [...relatedIds];
        relatedAlerts = await db
          .select()
          .from(alerts)
          .where(
            and(
              eq(alerts.orgId, orgId),
              inArray(alerts.id, ids)
            )
          );
        relatedAlerts = await filterAlertsBySiteScope({ ...auth, orgId }, relatedAlerts);
      }

      const visibleRelatedIds = new Set(relatedAlerts.map((related) => related.id));
      const visibleCorrelations = correlations.filter((correlation) => {
        const relatedId = correlation.parentAlertId === alertId
          ? correlation.childAlertId
          : correlation.parentAlertId;
        return visibleRelatedIds.has(relatedId);
      });

      return c.json({
        data: {
          alert,
          correlations: visibleCorrelations,
          relatedAlerts,
        }
      });
    } catch (error) {
      console.error('[Correlations] Failed to fetch correlations for alert', error);
      return c.json({ error: 'Failed to fetch correlations' }, 500);
    }
  }
);
