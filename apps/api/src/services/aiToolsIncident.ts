/**
 * AI Incident Response Tools
 *
 * Tools for managing security incidents, containment, evidence collection,
 * timeline viewing, and report generation.
 * - create_incident (Tier 2): Create a new security incident
 * - execute_containment (Tier 3): Execute containment actions on a device
 * - collect_evidence (Tier 2): Collect forensic evidence from a device
 * - get_incident_timeline (Tier 1): View full incident timeline
 * - generate_incident_report (Tier 1): Generate structured incident report
 */

import { db } from '../db';
import { devices, incidents, incidentEvidence, incidentActions } from '../db/schema';
import { eq, and, desc, gte, ilike, lte, count, sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { resolveWritableToolOrgId, verifyDeviceAccess } from './aiTools';
import { deviceScopeCondition, scopeDeviceIdsToCaller, siteScopeCondition } from './aiToolsSiteScope';
import { aiQueueCommandForExecution } from './aiDispatch';
import { publishEvent } from './eventBus';
import type { IncidentTimelineEntry } from '../db/schema/incidentResponse';
import { HIGH_RISK_CONTAINMENT_ACTIONS, listIncidentsSchema } from '../routes/incidents.validation';
import { sanitizeThrownToolError } from './aiToolErrors';

type AiToolTier = 1 | 2 | 3 | 4;

// Scalar-only list surface: never expose timeline or other incident jsonb.
const SAFE_INCIDENT_PROJECTION = {
  id: incidents.id, orgId: incidents.orgId, title: incidents.title,
  status: incidents.status, severity: incidents.severity, classification: incidents.classification,
  assignedTo: incidents.assignedTo, detectedAt: incidents.detectedAt, resolvedAt: incidents.resolvedAt,
  createdAt: incidents.createdAt, updatedAt: incidents.updatedAt,
};
const listIncidentInputSchema = listIncidentsSchema.omit({ page: true }).extend({
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

/**
 * The device ids on an incident that this caller may see.
 *
 * `null` for a caller restricted on NEITHER axis (no narrowing).
 * `incidents.affected_devices` is the incident's ONLY device axis — evidence and
 * action rows carry no device column — so it is what both the admission check
 * and the response filtering below key on.
 *
 * BOTH axes apply (`scopeDeviceIdsToCaller` = exact-device ∩ site). Keying on
 * `allowedDeviceIds` alone narrowed an agent run correctly and did nothing at
 * all for a site-restricted human (audit 2026-09-17 §1.1).
 */
async function scopedAffectedDevices(
  auth: AuthContext,
  orgId: string,
  affectedDevices: unknown,
): Promise<string[] | null> {
  return scopeDeviceIdsToCaller(auth, orgId, affectedDevices);
}

/**
 * Org axis + exact-device axis + SITE axis (#6096 #8; site added by the
 * 2026-09-17 audit §1.1).
 *
 * An incident is a device-attributable record: its timeline, its actions and
 * its forensic evidence are all ABOUT the affected devices. A device-bound
 * agent run — and a site-restricted technician — must therefore reach an
 * incident only when it touches at least one device they may see. An incident
 * naming none of them (including one naming no devices at all, which is not
 * attributable to either) fails closed. Reported as not-found by callers so it
 * doesn't leak existence.
 *
 * The scoped id list rides back on the returned row so the response filtering
 * does not re-run the device scan.
 */
async function findIncidentWithAccess(incidentId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(incidents.id, incidentId)];
  const orgCond = auth.orgCondition(incidents.orgId);
  if (orgCond) conditions.push(orgCond);
  const [incident] = await db.select().from(incidents).where(and(...conditions)).limit(1);
  if (!incident) return null;
  const scoped = await scopedAffectedDevices(auth, incident.orgId, incident.affectedDevices);
  if (scoped !== null && scoped.length === 0) return null;
  return { ...incident, scopedDeviceIds: scoped };
}

export function registerIncidentTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // create_incident — Tier 2 (medium risk, creates record)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    deviceArgs: ['affectedDeviceIds'],
    domain: 'monitoring',
    searchHint: 'security incident creation with initial investigation timeline',
    definition: {
      name: 'create_incident',
      description:
        'Create a new security incident. Inserts a record with an initial timeline entry and publishes an incident.created event.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Short title describing the incident',
          },
          classification: {
            type: 'string',
            enum: [
              'malware',
              'ransomware',
              'phishing',
              'data_breach',
              'unauthorized_access',
              'denial_of_service',
              'insider_threat',
              'other',
            ],
            description: 'Incident classification category',
          },
          severity: {
            type: 'string',
            enum: ['p1', 'p2', 'p3', 'p4'],
            description: 'Severity level (p1 = critical, p4 = low)',
          },
          summary: {
            type: 'string',
            description: 'Detailed summary of the incident (optional)',
          },
          relatedAlertIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'UUIDs of related alerts (optional)',
          },
          affectedDeviceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'UUIDs of affected devices (optional)',
          },
        },
        required: ['title', 'classification', 'severity'],
      },
    },
    handler: async (input, auth) => {
      if (!input.title) return JSON.stringify({ error: 'title is required' });
      if (!input.classification) return JSON.stringify({ error: 'classification is required' });
      if (!input.severity) return JSON.stringify({ error: 'severity is required' });

      const resolved = resolveWritableToolOrgId(auth);
      if (resolved.error || !resolved.orgId) {
        return JSON.stringify({ error: resolved.error ?? 'Organization context required' });
      }
      const orgId = resolved.orgId;

      const now = new Date();
      const initialTimeline: IncidentTimelineEntry[] = [
        {
          at: now.toISOString(),
          type: 'incident_created',
          actor: 'brain',
          summary: `Incident created: ${input.title as string}`,
        },
      ];

      try {
        const [incident] = await db
          .insert(incidents)
          .values({
            orgId,
            title: input.title as string,
            classification: input.classification as string,
            severity: input.severity as 'p1' | 'p2' | 'p3' | 'p4',
            status: 'detected',
            summary: (input.summary as string) ?? null,
            relatedAlerts: (input.relatedAlertIds as string[]) ?? [],
            affectedDevices: (input.affectedDeviceIds as string[]) ?? [],
            timeline: initialTimeline,
            detectedAt: now,
          })
          .returning();

        if (!incident) {
          return JSON.stringify({ error: 'Failed to create incident' });
        }

        let eventWarning: string | undefined;
        try {
          await publishEvent(
            'incident.created',
            orgId,
            {
              incidentId: incident.id,
              title: incident.title,
              classification: incident.classification,
              severity: incident.severity,
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish incident.created event:', error);
          eventWarning = 'Incident was created but event notification may be delayed';
        }

        return JSON.stringify({
          success: true,
          incidentId: incident.id,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          warning: eventWarning,
        });
      } catch (err: unknown) {
        const message = sanitizeThrownToolError('incident', err);
        return JSON.stringify({ error: `Failed to create incident: ${message}` });
      }
    },
  });

  // ============================================
  // execute_containment — Tier 3 (high risk, requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    deviceArgs: ['deviceId'],
    domain: 'monitoring',
    searchHint: 'incident containment actions on an affected device',
    definition: {
      name: 'execute_containment',
      description:
        'Execute a containment action on a device during an incident. High-risk action that requires explicit approval. Queues a command to the agent for execution.',
      input_schema: {
        type: 'object' as const,
        properties: {
          incidentId: {
            type: 'string',
            description: 'UUID of the incident',
          },
          deviceId: {
            type: 'string',
            description: 'UUID of the target device',
          },
          actionType: {
            type: 'string',
            enum: ['process_kill', 'network_isolation', 'account_disable', 'usb_block'],
            description: 'Type of containment action',
          },
          parameters: {
            type: 'object',
            description: 'Action-specific parameters (e.g., { pid: 1234 } for process_kill)',
          },
          approvalRef: {
            type: 'string',
            description: 'Approval reference (required for high-risk containment actions)',
          },
        },
        required: ['incidentId', 'deviceId', 'actionType'],
      },
    },
    handler: async (input, auth) => {
      if (!input.incidentId) return JSON.stringify({ error: 'incidentId is required' });
      if (!input.deviceId) return JSON.stringify({ error: 'deviceId is required' });
      if (!input.actionType) return JSON.stringify({ error: 'actionType is required' });

      if (HIGH_RISK_CONTAINMENT_ACTIONS.has(input.actionType as string) && !input.approvalRef) {
        return JSON.stringify({ error: 'High-risk containment actions require an approvalRef' });
      }

      const incident = await findIncidentWithAccess(input.incidentId as string, auth);
      if (!incident) return JSON.stringify({ error: 'Incident not found or access denied' });

      // The target device is supplied directly by the caller and reaches the
      // agent via queueCommandForExecution (which looks the device up by id
      // with NO tenant filter). Gate it through the org-scoped device check —
      // otherwise a user with an incident in their own org could dispatch
      // containment to a device in another tenant by id.
      const deviceAccess = await verifyDeviceAccess(input.deviceId as string, auth);
      if ('error' in deviceAccess) return JSON.stringify({ error: deviceAccess.error });

      const payload = {
        incidentId: input.incidentId as string,
        actionType: input.actionType as string,
        parameters: (input.parameters as Record<string, unknown>) ?? {},
        approvalRef: (input.approvalRef as string) ?? undefined,
      };

      const result = await aiQueueCommandForExecution(
        auth,
        'execute_containment',
        input.deviceId as string,
        'execute_containment',
        payload,
        { userId: auth.user.id }
      );

      if (result.error) {
        return JSON.stringify({ error: result.error });
      }

      // Record the action in the incident_actions table
      try {
        await db.insert(incidentActions).values({
          incidentId: input.incidentId as string,
          orgId: incident.orgId,
          actionType: input.actionType as string,
          description: `Containment: ${input.actionType as string} on device ${input.deviceId as string}`,
          executedBy: 'brain',
          status: 'in_progress',
          result: { commandId: result.command?.id },
          approvalRef: (input.approvalRef as string) ?? null,
          executedAt: new Date(),
        });
      } catch (err) {
        console.error('[AiTools] Failed to record containment action:', err);
      }

      return JSON.stringify({
        success: true,
        commandId: result.command?.id,
        commandStatus: result.command?.status ?? 'queued',
        incidentId: input.incidentId,
        actionType: input.actionType,
      });
    },
  });

  // ============================================
  // collect_evidence — Tier 2 (medium risk)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    deviceArgs: ['deviceId'],
    domain: 'monitoring',
    searchHint: 'forensic evidence collection from a device for an incident investigation',
    definition: {
      name: 'collect_evidence',
      description:
        'Collect forensic evidence from a device during an incident investigation. Queues a command to the agent to gather the requested evidence types.',
      input_schema: {
        type: 'object' as const,
        properties: {
          incidentId: {
            type: 'string',
            description: 'UUID of the incident',
          },
          deviceId: {
            type: 'string',
            description: 'UUID of the target device',
          },
          evidenceTypes: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['logs', 'processes', 'connections', 'screenshot'],
            },
            description: 'Types of evidence to collect',
          },
        },
        required: ['incidentId', 'deviceId', 'evidenceTypes'],
      },
    },
    handler: async (input, auth) => {
      if (!input.incidentId) return JSON.stringify({ error: 'incidentId is required' });
      if (!input.deviceId) return JSON.stringify({ error: 'deviceId is required' });
      if (!input.evidenceTypes || !Array.isArray(input.evidenceTypes) || input.evidenceTypes.length === 0) {
        return JSON.stringify({ error: 'evidenceTypes is required and must be a non-empty array' });
      }

      const incident = await findIncidentWithAccess(input.incidentId as string, auth);
      if (!incident) return JSON.stringify({ error: 'Incident not found or access denied' });

      // Gate the caller-supplied device through the org-scoped device check
      // before dispatch — queueCommandForExecution resolves the device by id
      // with no tenant filter, so without this a user could collect forensic
      // evidence (incl. screenshots) from a device in another tenant by id.
      const deviceAccess = await verifyDeviceAccess(input.deviceId as string, auth);
      if ('error' in deviceAccess) return JSON.stringify({ error: deviceAccess.error });

      const payload = {
        incidentId: input.incidentId as string,
        evidenceTypes: input.evidenceTypes as string[],
      };

      const result = await aiQueueCommandForExecution(
        auth,
        'collect_evidence',
        input.deviceId as string,
        'collect_evidence',
        payload,
        { userId: auth.user.id }
      );

      if (result.error) {
        return JSON.stringify({ error: result.error });
      }

      return JSON.stringify({
        success: true,
        commandId: result.command?.id,
        commandStatus: result.command?.status ?? 'queued',
        incidentId: input.incidentId,
        evidenceTypes: input.evidenceTypes,
      });
    },
  });

  // ============================================
  // get_incident_timeline — Tier 1 (read-only, low risk)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    domain: 'monitoring',
    searchHint: 'incident timeline, response actions and collected evidence',
    definition: {
      name: 'get_incident_timeline',
      description:
        'Get the full timeline of an incident including all actions and evidence. Returns the incident details, actions sorted by execution time, and collected evidence.',
      input_schema: {
        type: 'object' as const,
        properties: {
          incidentId: {
            type: 'string',
            description: 'UUID of the incident',
          },
          includeEvidenceMetadata: {
            type: 'boolean',
            description: 'Include the metadata object per evidence row (default false)',
          },
        },
        required: ['incidentId'],
      },
    },
    handler: async (input, auth) => {
      if (!input.incidentId) return JSON.stringify({ error: 'incidentId is required' });
      const includeEvidenceMetadata = input.includeEvidenceMetadata === true;

      const incident = await findIncidentWithAccess(input.incidentId as string, auth);
      if (!incident) return JSON.stringify({ error: 'Incident not found or access denied' });

      // Fetch actions
      const actionsConditions: SQL[] = [eq(incidentActions.incidentId, incident.id)];
      const actionsOrgCond = auth.orgCondition(incidentActions.orgId);
      if (actionsOrgCond) actionsConditions.push(actionsOrgCond);

      const actions = await db
        .select()
        .from(incidentActions)
        .where(and(...actionsConditions))
        .orderBy(desc(incidentActions.executedAt));

      // Fetch evidence
      const evidenceConditions: SQL[] = [eq(incidentEvidence.incidentId, incident.id)];
      const evidenceOrgCond = auth.orgCondition(incidentEvidence.orgId);
      if (evidenceOrgCond) evidenceConditions.push(evidenceOrgCond);

      const evidence = await db
        .select()
        .from(incidentEvidence)
        .where(and(...evidenceConditions))
        .orderBy(desc(incidentEvidence.collectedAt));

      // A-W05 (5c): cap actions/evidence/timeline so a long-running incident
      // can't blow the page budget; each carries the real count.
      const timeline = incident.timeline ?? [];
      return JSON.stringify({
        incident: {
          id: incident.id,
          title: incident.title,
          classification: incident.classification,
          severity: incident.severity,
          status: incident.status,
          summary: incident.summary,
          relatedAlerts: incident.relatedAlerts,
          affectedDevices: incident.scopedDeviceIds ?? incident.affectedDevices,
          detectedAt: incident.detectedAt,
          containedAt: incident.containedAt,
          resolvedAt: incident.resolvedAt,
          closedAt: incident.closedAt,
        },
        timeline: timeline.slice(0, 100),
        timelineCount: timeline.length,
        actions: actions.slice(0, 50).map((a) => ({
          id: a.id,
          actionType: a.actionType,
          description: a.description,
          executedBy: a.executedBy,
          status: a.status,
          result: a.result,
          reversible: a.reversible,
          reversed: a.reversed,
          executedAt: a.executedAt,
        })),
        actionCount: actions.length,
        evidence: evidence.slice(0, 50).map((e) => ({
          id: e.id,
          evidenceType: e.evidenceType,
          description: e.description,
          collectedAt: e.collectedAt,
          collectedBy: e.collectedBy,
          hash: e.hash,
          ...(includeEvidenceMetadata ? { metadata: e.metadata } : {}),
        })),
        evidenceCount: evidence.length,
      });
    },
  });

  // ============================================
  // generate_incident_report — Tier 1 (read-only, low risk)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    domain: 'monitoring',
    searchHint: 'incident report, response summary, action counts, evidence breakdown and timeline',
    definition: {
      name: 'generate_incident_report',
      description:
        'Generate a structured incident report with summaries, action counts, evidence breakdown, and full timeline. Useful for post-incident review and documentation.',
      input_schema: {
        type: 'object' as const,
        properties: {
          incidentId: {
            type: 'string',
            description: 'UUID of the incident',
          },
        },
        required: ['incidentId'],
      },
    },
    handler: async (input, auth) => {
      if (!input.incidentId) return JSON.stringify({ error: 'incidentId is required' });

      const incident = await findIncidentWithAccess(input.incidentId as string, auth);
      if (!incident) return JSON.stringify({ error: 'Incident not found or access denied' });

      // Fetch actions
      const actionsConditions: SQL[] = [eq(incidentActions.incidentId, incident.id)];
      const actionsOrgCond = auth.orgCondition(incidentActions.orgId);
      if (actionsOrgCond) actionsConditions.push(actionsOrgCond);

      const actions = await db
        .select()
        .from(incidentActions)
        .where(and(...actionsConditions))
        .orderBy(desc(incidentActions.executedAt));

      // Fetch evidence
      const evidenceConditions: SQL[] = [eq(incidentEvidence.incidentId, incident.id)];
      const evidenceOrgCond = auth.orgCondition(incidentEvidence.orgId);
      if (evidenceOrgCond) evidenceConditions.push(evidenceOrgCond);

      const evidence = await db
        .select()
        .from(incidentEvidence)
        .where(and(...evidenceConditions))
        .orderBy(desc(incidentEvidence.collectedAt));

      // Compute action statistics
      const totalActions = actions.length;
      const completedActions = actions.filter((a) => a.status === 'completed').length;
      const failedActions = actions.filter((a) => a.status === 'failed').length;
      const pendingActions = actions.filter((a) => a.status === 'pending' || a.status === 'in_progress').length;

      // Compute evidence breakdown by type
      const evidenceByType: Record<string, number> = {};
      for (const e of evidence) {
        evidenceByType[e.evidenceType] = (evidenceByType[e.evidenceType] || 0) + 1;
      }

      // Compute duration
      const detectedAt = incident.detectedAt ? new Date(incident.detectedAt) : null;
      const closedAt = incident.closedAt ? new Date(incident.closedAt) : null;
      let durationMinutes: number | null = null;
      if (detectedAt && closedAt) {
        durationMinutes = Math.round((closedAt.getTime() - detectedAt.getTime()) / 60000);
      }

      // Unique action types used
      const actionTypesUsed = [...new Set(actions.map((a) => a.actionType))];

      return JSON.stringify({
        report: {
          incidentId: incident.id,
          title: incident.title,
          classification: incident.classification,
          severity: incident.severity,
          status: incident.status,
          summary: incident.summary,
          detectedAt: incident.detectedAt,
          containedAt: incident.containedAt,
          resolvedAt: incident.resolvedAt,
          closedAt: incident.closedAt,
          durationMinutes,
          affectedDevices: incident.scopedDeviceIds ?? incident.affectedDevices,
          relatedAlerts: incident.relatedAlerts,
        },
        actionsSummary: {
          total: totalActions,
          completed: completedActions,
          failed: failedActions,
          pending: pendingActions,
          actionTypesUsed,
        },
        evidenceSummary: {
          total: evidence.length,
          byType: evidenceByType,
        },
        timeline: incident.timeline,
        actions: actions.map((a) => ({
          id: a.id,
          actionType: a.actionType,
          description: a.description,
          executedBy: a.executedBy,
          status: a.status,
          executedAt: a.executedAt,
        })),
        evidence: evidence.map((e) => ({
          id: e.id,
          evidenceType: e.evidenceType,
          description: e.description,
          collectedAt: e.collectedAt,
          collectedBy: e.collectedBy,
        })),
      });
    },
  });

  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'open incidents, incident list by customer, severity, status, assignee; security incident feed',
    deviceArgs: [],
    definition: {
      name: 'list_incidents',
      description: 'List security incidents by organization, status, severity, classification, assignee and detection date. Returns incident summaries and a total count.',
      input_schema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization UUID' },
          status: { type: 'string', enum: ['detected', 'analyzing', 'contained', 'recovering', 'closed'], description: 'Status: detected, analyzing, contained, recovering or closed' },
          severity: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4'], description: 'Severity: p1, p2, p3 or p4' },
          classification: { type: 'string', description: 'Case-insensitive classification pattern; % matches any sequence' },
          assignedTo: { type: 'string', description: 'Assigned user UUID' },
          startDate: { type: 'string', description: 'ISO-8601 detection date lower bound, inclusive' },
          endDate: { type: 'string', description: 'ISO-8601 detection date upper bound, inclusive' },
          limit: { type: 'number', description: 'Maximum rows (default 25, max 100)' },
          offset: { type: 'number', description: 'Rows to skip (default 0)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      const parsed = listIncidentInputSchema.safeParse({
        ...input,
        limit: typeof input.limit === 'number' ? Math.min(100, Math.max(1, input.limit)) : input.limit,
      });
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid incident filters' });
      const { orgId, status, severity, classification, assignedTo, startDate, endDate, limit, offset } = parsed.data;
      if (!['organization', 'partner', 'system'].includes(auth.scope)) {
        return JSON.stringify({ error: 'Organization, partner or system scope required' });
      }
      if (auth.scope === 'organization' && !auth.orgId) {
        return JSON.stringify({ error: 'Organization context required' });
      }
      if (orgId && (!auth.canAccessOrg(orgId) || (auth.scope === 'organization' && orgId !== auth.orgId))) {
        return JSON.stringify({ error: 'Access to this organization denied' });
      }
      if (auth.scope === 'partner' && (auth.accessibleOrgIds ?? []).length === 0) {
        return JSON.stringify({ incidents: [], total: 0, limit, offset });
      }
      if (auth.allowedSiteIds?.length === 0 || auth.allowedDeviceIds?.length === 0) {
        return JSON.stringify({ incidents: [], total: 0, limit, offset });
      }
      const conditions: SQL[] = [];
      const orgCond = orgId ? eq(incidents.orgId, orgId) : auth.orgCondition(incidents.orgId);
      if (orgCond) conditions.push(orgCond);
      // Stricter than GET /incidents: match the existing incident tools' admission
      // rule for site/device-bound callers. Apply before pagination AND counting.
      if (auth.allowedSiteIds || auth.allowedDeviceIds) {
        const reachableDevice = and(
          eq(devices.orgId, incidents.orgId),
          sql`${incidents.affectedDevices} @> jsonb_build_array(${devices.id}::text)`,
          siteScopeCondition(auth, devices.siteId),
          deviceScopeCondition(auth, devices.id),
        );
        conditions.push(sql`exists (select 1 from ${devices} where ${reachableDevice})`);
      }
      if (status) conditions.push(eq(incidents.status, status));
      if (severity) conditions.push(eq(incidents.severity, severity));
      if (classification) conditions.push(ilike(incidents.classification, classification));
      if (assignedTo) conditions.push(eq(incidents.assignedTo, assignedTo));
      if (startDate) conditions.push(gte(incidents.detectedAt, new Date(startDate)));
      if (endDate) conditions.push(lte(incidents.detectedAt, new Date(endDate)));
      const where = and(...conditions);
      try {
        const [rows, totals] = await Promise.all([
          db.select(SAFE_INCIDENT_PROJECTION).from(incidents).where(where)
            .orderBy(desc(incidents.detectedAt), desc(incidents.createdAt), desc(incidents.id))
            .limit(limit).offset(offset),
          db.select({ count: count() }).from(incidents).where(where),
        ]);
        return JSON.stringify({ incidents: rows, total: Number(totals[0]?.count ?? 0), limit, offset });
      } catch (error) {
        return JSON.stringify({ error: sanitizeThrownToolError('list_incidents', error) });
      }
    },
  });
}
