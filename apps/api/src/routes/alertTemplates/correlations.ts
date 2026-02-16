import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { listCorrelationsSchema, analyzeCorrelationsSchema } from './schemas';
import { correlationLinks, correlationGroups } from './data';
import { resolveScopedOrgId, paginate, getScopedCorrelationAlerts, getCorrelationLinksForAlert, getRelatedAlerts, getCorrelationGroupsForAlert } from './helpers';

export const correlationRoutes = new Hono();

correlationRoutes.get(
  '/correlations',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((alert) => alert.id));
      const query = c.req.valid('query');
      let data = correlationLinks.filter(
        (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
      );

      if (query.alertId) {
        data = data.filter(
          (link) => link.alertId === query.alertId || link.relatedAlertId === query.alertId
        );
      }

      if (query.minConfidence) {
        const minConfidence = Number.parseFloat(query.minConfidence);
        if (!Number.isNaN(minConfidence)) {
          data = data.filter((link) => link.confidence >= minConfidence);
        }
      }

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list correlations' }, 500);
    }
  }
);

correlationRoutes.get(
  '/correlations/groups',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlertIds = new Set(getScopedCorrelationAlerts(orgId).map((alert) => alert.id));
      const groups = correlationGroups
        .map((group) => ({
          ...group,
          alerts: group.alerts.filter((alert) => scopedAlertIds.has(alert.id))
        }))
        .filter((group) => group.alerts.length > 0);
      return c.json({ data: groups });
    } catch {
      return c.json({ error: 'Failed to list correlation groups' }, 500);
    }
  }
);

correlationRoutes.post(
  '/correlations/analyze',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', analyzeCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((alert) => alert.id));
      const data = c.req.valid('json');
      const alertIds = (data.alertIds ?? []).filter((alertId) => scopedAlertIds.has(alertId));
      const windowMinutes = data.windowMinutes ?? 60;

      const baseGroups = correlationGroups
        .map((group) => ({
          ...group,
          alerts: group.alerts.filter((alert) => scopedAlertIds.has(alert.id))
        }))
        .filter((group) => group.alerts.length > 0);
      const groups = alertIds.length
        ? baseGroups.filter((group) => group.alerts.some((alert) => alertIds.includes(alert.id)))
        : baseGroups;

      const scopedLinks = correlationLinks.filter(
        (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
      );
      const links = alertIds.length
        ? scopedLinks.filter(
          (link) => alertIds.includes(link.alertId) || alertIds.includes(link.relatedAlertId)
        )
        : scopedLinks;

      writeRouteAudit(c, {
        orgId,
        action: 'alert_correlation.analyze',
        resourceType: 'alert_correlation',
        details: {
          requestedAlertCount: alertIds.length,
          groupCount: groups.length,
          linkCount: links.length,
          windowMinutes,
        },
      });

      return c.json({
        data: {
          requestedAlertIds: alertIds,
          windowMinutes,
          groups,
          links,
          summary: alertIds.length
            ? 'Correlation analysis complete for requested alerts.'
            : 'Returning sample correlation analysis.'
        }
      });
    } catch {
      return c.json({ error: 'Failed to analyze correlations' }, 500);
    }
  }
);

correlationRoutes.get(
  '/correlations/:alertId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((item) => item.id));
      const alertId = c.req.param('alertId');
      const alert = scopedAlerts.find((item) => item.id === alertId);

      if (!alert) {
        return c.json({ error: 'Alert not found' }, 404);
      }

      return c.json({
        data: {
          alert,
          correlations: getCorrelationLinksForAlert(alertId).filter(
            (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
          ),
          relatedAlerts: getRelatedAlerts(alertId).filter((item) => scopedAlertIds.has(item.id)),
          groups: getCorrelationGroupsForAlert(alertId)
            .map((group) => ({
              ...group,
              alerts: group.alerts.filter((item) => scopedAlertIds.has(item.id))
            }))
            .filter((group) => group.alerts.length > 0)
        }
      });
    } catch {
      return c.json({ error: 'Failed to fetch correlations' }, 500);
    }
  }
);
