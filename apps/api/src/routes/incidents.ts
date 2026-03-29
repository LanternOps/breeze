import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { db } from '../db';
import {
  incidentActions,
  incidentEvidence,
  incidents,
  type IncidentTimelineEntry,
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { publishEvent } from '../services/eventBus';
import { writeRouteAudit } from '../services/auditEvents';
import {
  createIncidentSchema,
  listIncidentsSchema,
  uuidParamSchema,
  closeIncidentSchema,
} from './incidents.validation';
import {
  canTransitionStatus,
  appendTimeline,
  normalizeTimelineWithSort,
  getPagination,
  resolveOrgFilter,
  getIncidentWithOrgCheck,
} from './incidents.helpers';
import { incidentActionRoutes } from './incidentActions';

export const incidentRoutes = new Hono();

incidentRoutes.use('*', authMiddleware);

incidentRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createIncidentSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required for system scope' }, 400);
    }

    const detectedAt = data.detectedAt ? new Date(data.detectedAt) : new Date();
    const nowIso = new Date().toISOString();
    const initialTimeline: IncidentTimelineEntry[] = [{
      at: nowIso,
      type: 'incident_created',
      actor: 'user',
      summary: 'Incident created',
      metadata: {
        relatedAlerts: data.relatedAlerts?.length ?? 0,
        affectedDevices: data.affectedDevices?.length ?? 0,
      },
    }];

    const [incident] = await db
      .insert(incidents)
      .values({
        orgId: orgId!,
        title: data.title,
        classification: data.classification,
        severity: data.severity,
        status: data.status ?? 'detected',
        summary: data.summary,
        relatedAlerts: data.relatedAlerts ?? [],
        affectedDevices: data.affectedDevices ?? [],
        timeline: initialTimeline,
        assignedTo: data.assignedTo,
        detectedAt,
      })
      .returning();

    if (!incident) {
      return c.json({ error: 'Failed to create incident' }, 500);
    }

    try {
      await publishEvent(
        'incident.created',
        incident.orgId,
        {
          incidentId: incident.id,
          severity: incident.severity,
          status: incident.status,
          classification: incident.classification,
          relatedAlerts: incident.relatedAlerts,
          affectedDevices: incident.affectedDevices,
        },
        'incidents-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[IncidentsRoute] Failed to publish incident.created event:', error);
    }

    writeRouteAudit(c, {
      orgId: incident.orgId,
      action: 'incident.create',
      resourceType: 'incident',
      resourceId: incident.id,
      resourceName: incident.title,
      details: {
        severity: incident.severity,
        classification: incident.classification,
      },
    });

    return c.json(incident, 201);
  }
);

incidentRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listIncidentsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: SQL[] = [];

    const orgFilter = resolveOrgFilter(auth, query.orgId, incidents.orgId);
    if (orgFilter.error) {
      return c.json({ error: orgFilter.error.message }, orgFilter.error.status as ContentfulStatusCode);
    }
    if (orgFilter.condition) {
      conditions.push(orgFilter.condition);
    }

    if (query.status) {
      conditions.push(eq(incidents.status, query.status));
    }

    if (query.severity) {
      conditions.push(eq(incidents.severity, query.severity));
    }

    if (query.classification) {
      conditions.push(eq(incidents.classification, query.classification));
    }

    if (query.assignedTo) {
      conditions.push(eq(incidents.assignedTo, query.assignedTo));
    }

    if (query.startDate) {
      conditions.push(gte(incidents.detectedAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(incidents.detectedAt, new Date(query.endDate)));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRows, rows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(incidents)
        .where(whereCondition),
      db
        .select()
        .from(incidents)
        .where(whereCondition)
        .orderBy(desc(incidents.detectedAt), desc(incidents.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return c.json({
      data: rows,
      pagination: {
        page,
        limit,
        total: Number(countRows[0]?.count ?? 0),
      },
    });
  }
);

incidentRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const incident = await getIncidentWithOrgCheck(id, auth);

    if (!incident) {
      return c.json({ error: 'Incident not found' }, 404);
    }

    const [evidence, actions] = await Promise.all([
      db
        .select()
        .from(incidentEvidence)
        .where(eq(incidentEvidence.incidentId, id))
        .orderBy(desc(incidentEvidence.collectedAt), desc(incidentEvidence.createdAt)),
      db
        .select()
        .from(incidentActions)
        .where(eq(incidentActions.incidentId, id))
        .orderBy(desc(incidentActions.executedAt), desc(incidentActions.createdAt)),
    ]);

    return c.json({
      incident,
      timeline: normalizeTimelineWithSort(incident.timeline),
      evidence,
      actions,
    });
  }
);

incidentRoutes.post(
  '/:id/close',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  zValidator('json', closeIncidentSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const incident = await getIncidentWithOrgCheck(id, auth);

    if (!incident) {
      return c.json({ error: 'Incident not found' }, 404);
    }

    if (!canTransitionStatus(incident.status, 'closed')) {
      return c.json({ error: `Cannot transition incident from ${incident.status} to closed` }, 400);
    }

    const resolvedAt = data.resolvedAt ? new Date(data.resolvedAt) : new Date();
    const closedAt = new Date();

    const timeline = appendTimeline(incident.timeline, {
      at: closedAt.toISOString(),
      type: 'incident_closed',
      actor: 'user',
      summary: data.summary,
      metadata: {
        lessonsLearned: data.lessonsLearned,
      },
    });

    const [updated] = await db
      .update(incidents)
      .set({
        status: 'closed',
        summary: data.summary,
        resolvedAt,
        closedAt,
        timeline,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, incident.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to close incident' }, 500);
    }

    try {
      await publishEvent(
        'incident.closed',
        incident.orgId,
        {
          incidentId: incident.id,
          closedAt: updated.closedAt?.toISOString(),
          resolvedAt: updated.resolvedAt?.toISOString(),
        },
        'incidents-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[IncidentsRoute] Failed to publish incident.closed event:', error);
    }

    writeRouteAudit(c, {
      orgId: incident.orgId,
      action: 'incident.close',
      resourceType: 'incident',
      resourceId: incident.id,
      resourceName: incident.title,
      details: {
        previousStatus: incident.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

incidentRoutes.get(
  '/:id/report',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const incident = await getIncidentWithOrgCheck(id, auth);

    if (!incident) {
      return c.json({ error: 'Incident not found' }, 404);
    }

    const [evidence, actions] = await Promise.all([
      db
        .select()
        .from(incidentEvidence)
        .where(eq(incidentEvidence.incidentId, incident.id))
        .orderBy(desc(incidentEvidence.collectedAt)),
      db
        .select()
        .from(incidentActions)
        .where(eq(incidentActions.incidentId, incident.id))
        .orderBy(desc(incidentActions.executedAt)),
    ]);

    const timeline = normalizeTimelineWithSort(incident.timeline);

    return c.json({
      incident: {
        id: incident.id,
        title: incident.title,
        classification: incident.classification,
        severity: incident.severity,
        status: incident.status,
        summary: incident.summary,
        detectedAt: incident.detectedAt,
        containedAt: incident.containedAt,
        resolvedAt: incident.resolvedAt,
        closedAt: incident.closedAt,
      },
      report: {
        generatedAt: new Date().toISOString(),
        timeline,
        evidenceSummary: {
          total: evidence.length,
          byType: evidence.reduce<Record<string, number>>((acc, item) => {
            acc[item.evidenceType] = (acc[item.evidenceType] ?? 0) + 1;
            return acc;
          }, {}),
        },
        actionSummary: {
          total: actions.length,
          completed: actions.filter((action) => action.status === 'completed').length,
          failed: actions.filter((action) => action.status === 'failed').length,
          reversible: actions.filter((action) => action.reversible).length,
        },
        lessonsLearned: timeline
          .filter((entry) => entry.type === 'incident_closed')
          .map((entry) => entry.metadata?.lessonsLearned)
          .find((value) => typeof value === 'string') ?? null,
      },
    });
  }
);

// Mount contain + evidence action routes
incidentRoutes.route('/', incidentActionRoutes);
