import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import type { StatusCode } from 'hono/utils/http-status';
import { db } from '../db';
import {
  incidentActions,
  incidentEvidence,
  incidents,
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { publishEvent } from '../services/eventBus';
import { writeRouteAudit } from '../services/auditEvents';
import {
  uuidParamSchema,
  containIncidentSchema,
  addEvidenceSchema,
  HIGH_RISK_CONTAINMENT_ACTIONS,
  EVIDENCE_HASH_ALGORITHM,
} from './incidents.validation';
import {
  getIncidentWithOrgCheck,
  isContainmentSuccess,
  canTransitionStatus,
  appendTimeline,
  isControlledEvidenceStoragePath,
  computeSha256FromBase64,
} from './incidents.helpers';

export const incidentActionRoutes = new Hono();

incidentActionRoutes.use('*', authMiddleware);

incidentActionRoutes.post(
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

incidentActionRoutes.post(
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
