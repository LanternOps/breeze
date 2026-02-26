import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { db } from '../db';
import {
  incidentActions,
  incidentEvidence,
  incidents,
  type IncidentTimelineEntry,
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { publishEvent } from '../services/eventBus';
import { writeRouteAudit } from '../services/auditEvents';

const incidentSeveritySchema = z.enum(['p1', 'p2', 'p3', 'p4']);
const incidentStatusSchema = z.enum(['detected', 'analyzing', 'contained', 'recovering', 'closed']);
const incidentEvidenceTypeSchema = z.enum(['file', 'log', 'screenshot', 'memory', 'network']);
const incidentActorSchema = z.enum(['user', 'brain', 'system']);
const incidentActionStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
type IncidentStatus = z.infer<typeof incidentStatusSchema>;
type IncidentActionStatus = z.infer<typeof incidentActionStatusSchema>;

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

const createIncidentSchema = z.object({
  orgId: z.string().uuid().optional(),
  title: z.string().min(3).max(500),
  classification: z.string().min(2).max(40),
  severity: incidentSeveritySchema,
  summary: z.string().max(10_000).optional(),
  relatedAlerts: z.array(z.string().uuid()).max(1000).optional(),
  affectedDevices: z.array(z.string().uuid()).max(5000).optional(),
  assignedTo: z.string().uuid().optional(),
  detectedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['detected', 'analyzing']).optional(),
});

const listIncidentsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  classification: z.string().max(40).optional(),
  assignedTo: z.string().uuid().optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
});

const containIncidentSchema = z.object({
  actionType: z.string().min(2).max(40),
  description: z.string().min(3).max(10_000),
  executedBy: incidentActorSchema.optional(),
  status: incidentActionStatusSchema.optional(),
  result: z.record(z.unknown()).optional(),
  reversible: z.boolean().optional(),
  approvalRef: z.string().max(128).optional(),
  executedAt: z.string().datetime({ offset: true }).optional(),
});

const addEvidenceSchema = z.object({
  evidenceType: incidentEvidenceTypeSchema,
  description: z.string().max(10_000).optional(),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  collectedBy: incidentActorSchema.optional(),
  hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  contentBase64: z.string().max(5_000_000).optional(),
  storagePath: z.string().min(1).max(5000),
  metadata: z.record(z.unknown()).optional(),
});

const closeIncidentSchema = z.object({
  summary: z.string().min(3).max(15_000),
  lessonsLearned: z.string().max(15_000).optional(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
});

const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  detected: ['analyzing', 'contained'],
  analyzing: ['contained', 'recovering'],
  contained: ['recovering', 'closed'],
  recovering: ['contained', 'closed'],
  closed: [],
};

const HIGH_RISK_CONTAINMENT_ACTIONS = new Set([
  'network_isolation',
  'account_disable',
  'usb_block',
]);

const ALLOWED_EVIDENCE_STORAGE_SCHEMES = new Set(
  (process.env.EVIDENCE_STORAGE_ALLOWED_SCHEMES ?? 's3,gs,r2,azblob,immutable,https')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
);
const EVIDENCE_HASH_ALGORITHM = 'sha256';

function canTransitionStatus(
  from: IncidentStatus,
  to: IncidentStatus
): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

function asTimeline(value: unknown): IncidentTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as IncidentTimelineEntry[];
}

function appendTimeline(
  current: unknown,
  entry: IncidentTimelineEntry
): IncidentTimelineEntry[] {
  const timeline = asTimeline(current);
  return [...timeline, entry];
}

function normalizeTimelineWithSort(value: unknown): IncidentTimelineEntry[] {
  const timeline = asTimeline(value);
  return [...timeline].sort((a, b) => a.at.localeCompare(b.at));
}

function isControlledEvidenceStoragePath(storagePath: string): boolean {
  if (storagePath.includes('..')) {
    return false;
  }

  const match = storagePath.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) {
    return false;
  }

  const scheme = match[1].toLowerCase();
  return ALLOWED_EVIDENCE_STORAGE_SCHEMES.has(scheme);
}

function computeSha256FromBase64(contentBase64: string): string {
  const trimmed = contentBase64.replace(/\s+/g, '');
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('Invalid base64 content');
  }
  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0) {
    throw new Error('Invalid base64 content');
  }
  return createHash('sha256').update(buffer).digest('hex');
}

function isContainmentSuccess(status: IncidentActionStatus): boolean {
  return status === 'completed';
}

function getPagination(query: z.infer<typeof listIncidentsSchema>): { page: number; limit: number; offset: number } {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function resolveOrgFilter(
  auth: AuthContext,
  queryOrgId: string | undefined,
  column: PgColumn
): { condition?: SQL; error?: { message: string; status: number } } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: { message: 'Organization context required', status: 403 } };
    }
    if (queryOrgId && queryOrgId !== auth.orgId) {
      return { error: { message: 'Access to this organization denied', status: 403 } };
    }
    return { condition: eq(column, auth.orgId) };
  }

  if (auth.scope === 'partner') {
    if (queryOrgId) {
      if (!auth.canAccessOrg(queryOrgId)) {
        return { error: { message: 'Access to this organization denied', status: 403 } };
      }
      return { condition: eq(column, queryOrgId) };
    }

    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return { condition: eq(column, '00000000-0000-0000-0000-000000000000') };
    }
    return { condition: inArray(column, orgIds) };
  }

  if (auth.scope === 'system' && queryOrgId) {
    return { condition: eq(column, queryOrgId) };
  }

  return {};
}

async function getIncidentWithOrgCheck(incidentId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(incidents.id, incidentId)];
  const orgCondition = auth.orgCondition(incidents.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [incident] = await db
    .select()
    .from(incidents)
    .where(and(...conditions))
    .limit(1);

  return incident ?? null;
}

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
      return c.json({ error: orgFilter.error.message }, orgFilter.error.status);
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
  '/:id/contain',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  zValidator('json', containIncidentSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const incident = await getIncidentWithOrgCheck(id, auth);

    if (!incident) {
      return c.json({ error: 'Incident not found' }, 404);
    }

    if (HIGH_RISK_CONTAINMENT_ACTIONS.has(data.actionType) && !data.approvalRef) {
      return c.json({ error: 'High-risk containment actions require an approvalRef' }, 400);
    }

    const actionStatus = data.status ?? 'completed';
    if (isContainmentSuccess(actionStatus) && !canTransitionStatus(incident.status, 'contained')) {
      return c.json({ error: `Cannot transition incident from ${incident.status} to contained` }, 400);
    }

    const executedAt = data.executedAt ? new Date(data.executedAt) : new Date();
    const timeline = appendTimeline(incident.timeline, {
      at: new Date().toISOString(),
      type: isContainmentSuccess(actionStatus) ? 'containment_executed' : 'containment_attempted',
      actor: data.executedBy ?? 'user',
      summary: data.description,
      metadata: {
        actionType: data.actionType,
        actionStatus,
        approvalRef: data.approvalRef,
      },
    });

    const transactionResult = await db.transaction(async (tx) => {
      const [action] = await tx
        .insert(incidentActions)
        .values({
          incidentId: incident.id,
          orgId: incident.orgId,
          actionType: data.actionType,
          description: data.description,
          executedBy: data.executedBy ?? 'user',
          status: actionStatus,
          result: data.result,
          reversible: data.reversible ?? false,
          approvalRef: data.approvalRef,
          executedAt,
        })
        .returning();

      if (!action) {
        throw new Error('Failed to create containment action');
      }

      const incidentUpdate: Partial<typeof incidents.$inferInsert> = {
        timeline,
        updatedAt: new Date(),
      };
      if (isContainmentSuccess(actionStatus)) {
        incidentUpdate.status = 'contained';
        incidentUpdate.containedAt = executedAt;
      }

      const [updatedIncident] = await tx
        .update(incidents)
        .set(incidentUpdate)
        .where(eq(incidents.id, incident.id))
        .returning();

      if (!updatedIncident) {
        throw new Error('Failed to update incident after containment');
      }

      return { action, updatedIncident };
    });

    const { action, updatedIncident } = transactionResult;

    if (!action || !updatedIncident) {
      return c.json({ error: 'Failed to apply containment' }, 500);
    }

    if (isContainmentSuccess(actionStatus)) {
      try {
        await publishEvent(
          'incident.contained',
          incident.orgId,
          {
            incidentId: incident.id,
            actionId: action.id,
            actionType: action.actionType,
            executedBy: action.executedBy,
            status: action.status,
          },
          'incidents-route',
          { userId: auth.user.id }
        );
      } catch (error) {
        console.error('[IncidentsRoute] Failed to publish incident.contained event:', error);
      }
    }

    writeRouteAudit(c, {
      orgId: incident.orgId,
      action: 'incident.contain',
      resourceType: 'incident',
      resourceId: incident.id,
      resourceName: incident.title,
      details: {
        actionType: action.actionType,
        approvalRef: action.approvalRef,
      },
    });

    return c.json({
      incident: updatedIncident,
      action,
    });
  }
);

incidentRoutes.post(
  '/:id/evidence',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', uuidParamSchema),
  zValidator('json', addEvidenceSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const incident = await getIncidentWithOrgCheck(id, auth);

    if (!incident) {
      return c.json({ error: 'Incident not found' }, 404);
    }

    if (incident.status === 'closed') {
      return c.json({ error: 'Cannot attach evidence to a closed incident' }, 400);
    }

    if (!isControlledEvidenceStoragePath(data.storagePath)) {
      return c.json({ error: 'Evidence storagePath must use an approved URI scheme' }, 400);
    }

    const collectedAt = data.collectedAt ? new Date(data.collectedAt) : new Date();
    const providedHash = data.hash?.toLowerCase();
    let computedHash: string | undefined;

    if (data.contentBase64) {
      try {
        computedHash = computeSha256FromBase64(data.contentBase64);
      } catch {
        return c.json({ error: 'Invalid contentBase64 payload' }, 400);
      }
    }

    if (providedHash && computedHash && providedHash !== computedHash) {
      return c.json({ error: 'Provided hash does not match contentBase64 sha256 digest' }, 400);
    }

    const finalHash = computedHash ?? providedHash;
    if (!finalHash) {
      return c.json({ error: 'Either hash or contentBase64 is required for evidence integrity' }, 400);
    }

    const { evidence } = await db.transaction(async (tx) => {
      const [createdEvidence] = await tx
        .insert(incidentEvidence)
        .values({
          incidentId: incident.id,
          orgId: incident.orgId,
          evidenceType: data.evidenceType,
          description: data.description,
          collectedAt,
          collectedBy: data.collectedBy ?? 'user',
          hash: finalHash,
          hashAlgorithm: EVIDENCE_HASH_ALGORITHM,
          storagePath: data.storagePath,
          metadata: data.metadata,
        })
        .returning();

      if (!createdEvidence) {
        throw new Error('Failed to store evidence');
      }

      const timeline = appendTimeline(incident.timeline, {
        at: new Date().toISOString(),
        type: 'evidence_collected',
        actor: createdEvidence.collectedBy,
        summary: createdEvidence.description ?? `Collected ${createdEvidence.evidenceType} evidence`,
        metadata: {
          evidenceId: createdEvidence.id,
          evidenceType: createdEvidence.evidenceType,
          storagePath: createdEvidence.storagePath,
          hash: createdEvidence.hash,
          hashAlgorithm: createdEvidence.hashAlgorithm,
        },
      });

      await tx
        .update(incidents)
        .set({
          timeline,
          updatedAt: new Date(),
        })
        .where(eq(incidents.id, incident.id));

      return { evidence: createdEvidence };
    });

    writeRouteAudit(c, {
      orgId: incident.orgId,
      action: 'incident.evidence.add',
      resourceType: 'incident',
      resourceId: incident.id,
      resourceName: incident.title,
      details: {
        evidenceId: evidence.id,
        evidenceType: evidence.evidenceType,
      },
    });

    return c.json(evidence, 201);
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
