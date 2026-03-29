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
import { incidents, incidentEvidence, incidentActions } from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { resolveWritableToolOrgId } from './aiTools';
import { queueCommandForExecution } from './commandQueue';
import { publishEvent } from './eventBus';
import type { IncidentTimelineEntry } from '../db/schema/incidentResponse';

type AiToolTier = 1 | 2 | 3 | 4;

async function findIncidentWithAccess(incidentId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(incidents.id, incidentId)];
  const orgCond = auth.orgCondition(incidents.orgId);
  if (orgCond) conditions.push(orgCond);
  const [incident] = await db.select().from(incidents).where(and(...conditions)).limit(1);
  return incident || null;
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
          type: 'created',
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
        const message = err instanceof Error ? err.message : 'Unknown error';
        return JSON.stringify({ error: `Failed to create incident: ${message}` });
      }
    },
  });

  // ============================================
  // execute_containment — Tier 3 (high risk, requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
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

      const incident = await findIncidentWithAccess(input.incidentId as string, auth);
      if (!incident) return JSON.stringify({ error: 'Incident not found or access denied' });

      const payload = {
        incidentId: input.incidentId as string,
        actionType: input.actionType as string,
        parameters: (input.parameters as Record<string, unknown>) ?? {},
        approvalRef: (input.approvalRef as string) ?? undefined,
      };

      const result = await queueCommandForExecution(
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

      const payload = {
        incidentId: input.incidentId as string,
        evidenceTypes: input.evidenceTypes as string[],
      };

      const result = await queueCommandForExecution(
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

      return JSON.stringify({
        incident: {
          id: incident.id,
          title: incident.title,
          classification: incident.classification,
          severity: incident.severity,
          status: incident.status,
          summary: incident.summary,
          relatedAlerts: incident.relatedAlerts,
          affectedDevices: incident.affectedDevices,
          detectedAt: incident.detectedAt,
          containedAt: incident.containedAt,
          resolvedAt: incident.resolvedAt,
          closedAt: incident.closedAt,
        },
        timeline: incident.timeline,
        actions: actions.map((a) => ({
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
        evidence: evidence.map((e) => ({
          id: e.id,
          evidenceType: e.evidenceType,
          description: e.description,
          collectedAt: e.collectedAt,
          collectedBy: e.collectedBy,
          hash: e.hash,
          metadata: e.metadata,
        })),
      });
    },
  });

  // ============================================
  // generate_incident_report — Tier 1 (read-only, low risk)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
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
          affectedDevices: incident.affectedDevices,
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
}
