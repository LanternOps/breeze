import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { db } from '../db';
import {
  devices,
  incidentActions,
  incidentEvidence,
  incidents,
  type IncidentTimelineEntry,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { publishEvent } from '../services/eventBus';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS, canAccessSite, hasPermission, type UserPermissions } from '../services/permissions';
import {
  createIncidentSchema,
  listIncidentFeedSchema,
  listIncidentsSchema,
  uuidParamSchema,
  closeIncidentSchema,
} from './incidents.validation';
import {
  buildIncidentFeed,
  canTransitionStatus,
  appendTimeline,
  FeedScopeError,
  normalizeTimelineWithSort,
  getPagination,
  resolveOrgFilter,
  getIncidentWithOrgCheck,
} from './incidents.helpers';
import { incidentActionRoutes } from './incidentActions';
import { isPgUniqueViolation } from '../utils/pgErrors';

export const incidentRoutes = new Hono();
const requireIncidentRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireIncidentWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

incidentRoutes.use('*', authMiddleware);

// Resolve the device IDs a site-restricted caller may read within their org,
// narrowed by `permissions.allowedSiteIds`. Returns null when the caller has no
// site restriction (no narrowing needed). Site is an app-layer concept only —
// Postgres RLS does NOT defend it — so a site-restricted org user must not read
// EDR finding rows (or device hostnames) for devices in other sites within the
// same org. Mirrors sentinelOne.ts / browserSecurity.ts `resolveSiteAllowedDeviceIds`.
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  permissions: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!permissions?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => typeof d.siteId === 'string' && canAccessSite(permissions, d.siteId))
    .map((d) => d.id);
}

incidentRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireIncidentWrite,
  requireMfa(),
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

    let incident;
    try {
      [incident] = await db
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
          sourceType: data.sourceType,
          sourceRef: data.sourceRef,
        })
        .returning();
    } catch (err) {
      // Promoting the same EDR finding twice collides on the partial unique
      // index `incidents_source_ref_unique` (org_id, source_type, source_ref).
      // Surface a clean 409 instead of leaking the raw Postgres 23505 as a 500.
      // Match the specific constraint so an unrelated 23505 still throws.
      if (isPgUniqueViolation(err, 'incidents_source_ref_unique')) {
        return c.json({ error: 'This finding has already been promoted to an incident' }, 409);
      }
      throw err;
    }

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
  requireIncidentRead,
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
  '/feed',
  requireScope('organization', 'partner', 'system'),
  requireIncidentRead,
  zValidator('query', listIncidentFeedSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const limit = query.limit;
    const offset = (query.page - 1) * limit;

    // The route-level gate stays `alerts:read` (requireIncidentRead, which also
    // populated `permissions`). The raw EDR finding legs additionally expose
    // device telemetry, so they require `devices:read`; a caller with only
    // alerts:read sees native tracked incidents and no raw Huntress/S1 findings.
    const perms = c.get('permissions') as UserPermissions | undefined;
    const hasDevicesRead = perms
      ? hasPermission(perms, PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action)
      : false;

    // Site is an app-layer authz axis Postgres RLS cannot defend. A site-
    // restricted org caller must not read EDR findings for devices outside their
    // site allowlist via the feed. Resolve the allowed device ids exactly as GET
    // /huntress/incidents and /sentinelone/threats do; partner/system callers
    // carry no site restriction (allowedSiteIds undefined → null → no narrowing).
    let allowedDeviceIds: string[] | null = null;
    if (hasDevicesRead && perms?.allowedSiteIds && auth.scope === 'organization' && auth.orgId) {
      allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
    }

    try {
      const { rows, total } = await buildIncidentFeed(auth, {
        orgId: query.orgId,
        kind: query.kind,
        source: query.source,
        limit,
        offset,
        hasDevicesRead,
        allowedDeviceIds,
      });
      return c.json({
        data: rows,
        pagination: { page: query.page, limit, total },
      });
    } catch (err) {
      if (err instanceof FeedScopeError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      throw err;
    }
  }
);

incidentRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireIncidentRead,
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
        .where(and(eq(incidentEvidence.incidentId, id), eq(incidentEvidence.orgId, incident.orgId)))
        .orderBy(desc(incidentEvidence.collectedAt), desc(incidentEvidence.createdAt)),
      db
        .select()
        .from(incidentActions)
        .where(and(eq(incidentActions.incidentId, id), eq(incidentActions.orgId, incident.orgId)))
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
  requireIncidentWrite,
  requireMfa(),
  zValidator('param', uuidParamSchema),
  zValidator('json', closeIncidentSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const result = await db.transaction(async (tx) => {
      const conditions: SQL[] = [eq(incidents.id, id)];
      const orgCondition = auth.orgCondition(incidents.orgId);
      if (orgCondition) {
        conditions.push(orgCondition);
      }

      const [incident] = await tx
        .select()
        .from(incidents)
        .where(and(...conditions))
        .limit(1);

      if (!incident) {
        return { error: 'Incident not found', status: 404 as const };
      }

      if (!canTransitionStatus(incident.status, 'closed')) {
        return { error: `Cannot transition incident from ${incident.status} to closed`, status: 400 as const };
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

      const [updated] = await tx
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
        return { error: 'Failed to close incident', status: 500 as const };
      }

      return { incident, updated };
    });

    if ('error' in result) {
      return c.json({ error: result.error }, result.status);
    }

    const { incident, updated } = result;

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
  requireIncidentRead,
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
        .where(and(eq(incidentEvidence.incidentId, incident.id), eq(incidentEvidence.orgId, incident.orgId)))
        .orderBy(desc(incidentEvidence.collectedAt)),
      db
        .select()
        .from(incidentActions)
        .where(and(eq(incidentActions.incidentId, incident.id), eq(incidentActions.orgId, incident.orgId)))
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
