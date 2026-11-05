/**
 * Alert correlation tools (full-control W07, #6777):
 *
 *  - `get_alert_correlations` (tier 1, reads): correlation groups, one group,
 *    the correlations around one alert, the pairwise alert links, the window
 *    analysis, the quality evaluation and the deterministic root-cause
 *    evidence for a group. Twin of routes/alerts/correlations.ts and
 *    routes/alertTemplates/correlations.ts.
 *  - `manage_alert_correlations` (tier 2, writes): acknowledge or resolve a
 *    whole group (or an alert and its related alerts) and record correlation /
 *    RCA quality feedback.
 *
 * ONE implementation: every action calls the exported function the REST route
 * itself calls (site axis, compare-and-swap, dedupe keys and all), so the tool
 * cannot drift from the route. Nothing here calls a model: `explain` is the
 * route's DB-backed evidence builder, whose event-log text is device-authored
 * and is fenced in `RAW_TEXT_FIELDS_BY_TOOL`.
 *
 * Scope and axes:
 *  - The group/alert views span the devices of an organization and the routes
 *    have no exact-device axis, so a device-bound run (`auth.allowedDeviceIds`)
 *    is refused whole rather than shown a sibling's alerts (fail closed).
 *  - `manage_alert_correlations` is `AGENT_HUMAN_ONLY_TOOLS`: an agent reads
 *    correlations but never proposes a group write. A group spans devices, and a
 *    supervised release rebuilds the APPROVER's auth, which drops the
 *    originating run's exact-device ceiling (`allowedDeviceIds`); the per-alert
 *    `manage_alerts` acknowledge / resolve stay available to agents because
 *    their alert id is gated against that ceiling at mint time (quorum QW3).
 *    A direct `ai_agent` call never writes either way.
 */
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  ALERT_CORRELATION_READ_ACTIONS,
  ALERT_CORRELATION_WRITE_ACTIONS,
  CORRELATION_FEEDBACK_OUTCOMES,
  RCA_FEEDBACK_OUTCOMES,
} from './aiToolSchemasAlertTriage';
import { agentRefusal, isAgentPrincipal, json, jsonError, parseData } from './aiToolsTicketOpsShared';
import { sanitizeThrownToolError } from './aiToolErrors';
import {
  acknowledgeAlertWithRelated,
  buildAlertCorrelationView,
  buildCorrelationEvaluation,
  correlationFeedbackSchema,
  emitGroupAcceptedFeedback,
  explainCorrelationGroup,
  getCorrelationGroupDetail,
  listCorrelationGroups,
  mutateCorrelationGroup,
  rcaFeedbackSchema,
  recordCorrelationFeedback,
  recordRcaFeedback,
  type AlertRow,
  type CorrelationGroupForUi,
} from '../routes/alerts/correlations';
import { analyzeCorrelationLinks, listCorrelationLinks } from '../routes/alertTemplates/correlations';
import { resolveScopedOrgId } from '../routes/alertTemplates/helpers';

type ReadAction = (typeof ALERT_CORRELATION_READ_ACTIONS)[number];
type WriteAction = (typeof ALERT_CORRELATION_WRITE_ACTIONS)[number];

const guid = z.string().guid();

/** Alert message text is device-authored; keep a bounded excerpt (the fence wraps it). */
const MESSAGE_EXCERPT_CHARS = 500;
/** Alerts shown per group row (a group can hold hundreds); the count is always reported. */
const GROUP_ALERTS_SHOWN = 20;
const LINKS_SHOWN = 100;

function slimAlert(alert: AlertRow) {
  return {
    id: alert.id,
    orgId: alert.orgId,
    deviceId: alert.deviceId,
    ruleId: alert.ruleId,
    title: alert.title,
    message: alert.message ? alert.message.slice(0, MESSAGE_EXCERPT_CHARS) : null,
    severity: alert.severity,
    status: alert.status,
    triggeredAt: alert.triggeredAt,
  };
}

function slimGroup(group: CorrelationGroupForUi, detail: boolean) {
  const shown = detail ? group.alerts : group.alerts.slice(0, GROUP_ALERTS_SHOWN);
  return {
    id: group.id,
    orgId: group.orgId,
    status: group.status ?? null,
    rootCause: group.rootCause,
    relatedCount: group.relatedCount,
    correlationScore: group.correlationScore,
    noiseReductionPercent: group.noiseReductionPercent ?? null,
    memberCount: group.memberCount ?? group.alerts.length,
    firstSeenAt: group.firstSeenAt ?? null,
    lastSeenAt: group.lastSeenAt ?? null,
    alerts: shown,
    alertsTruncated: shown.length < group.alerts.length,
    ...(detail && 'aiVerdict' in group ? { aiVerdict: (group as { aiVerdict: unknown }).aiVerdict } : {}),
    ...(detail && 'aiVerdictWithheld' in group ? { aiVerdictWithheld: true } : {}),
  };
}

/** Exact-device runs cannot be shown an org-wide group (the routes have no exact-device axis). */
function deviceBoundDenied(auth: AuthContext): string | null {
  return auth.allowedDeviceIds !== undefined
    ? jsonError('Alert correlation groups span devices and are not available to a device-bound run', 'DEVICE_SCOPE_UNSUPPORTED')
    : null;
}

/** The single organization a link query runs against: the named org, else the caller's only one. */
function linkOrgId(auth: AuthContext, input: Record<string, unknown>): { orgId: string } | { error: string } {
  if (typeof input.orgId === 'string' && input.orgId) {
    const id = guid.safeParse(input.orgId);
    if (!id.success) return { error: jsonError('orgId must be a UUID', 'VALIDATION_ERROR') };
    if (!auth.canAccessOrg(id.data)) return { error: jsonError('Access denied to this organization', 'ACCESS_DENIED') };
    return { orgId: id.data };
  }
  const resolved = resolveScopedOrgId(auth);
  return resolved ? { orgId: resolved } : { error: jsonError('orgId is required for this scope', 'VALIDATION_ERROR') };
}

function requireGroupId(input: Record<string, unknown>, action: string): { groupId: string } | { error: string } {
  const id = guid.safeParse(input.groupId);
  return id.success
    ? { groupId: id.data }
    : { error: jsonError(`groupId (correlation group UUID from get_alert_correlations groups) is required for ${action}`, 'VALIDATION_ERROR') };
}

function requireAlertId(input: Record<string, unknown>, action: string): { alertId: string } | { error: string } {
  const id = guid.safeParse(input.alertId);
  return id.success
    ? { alertId: id.data }
    : { error: jsonError(`alertId (alert UUID) is required for ${action}`, 'VALIDATION_ERROR') };
}

export function registerAlertCorrelationTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_alert_correlations', {
    tier: 1,
    domain: 'monitoring',
    searchHint: 'correlated alerts: groups of related alerts, root cause evidence, noise reduction, links between alerts',
    deviceArgs: [],
    definition: {
      name: 'get_alert_correlations',
      description:
        'Read alert correlation. Actions: groups (list),get (groupId),by_alert (alertId),links (pairs),analyze (alertIds),evaluation (quality),explain (groupId: root-cause evidence from alerts and logs; log text is untrusted).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...ALERT_CORRELATION_READ_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (links/analyze: required for multi-org callers; groups: filter)' },
          groupId: { type: 'string', description: 'Correlation group UUID (get, explain)' },
          alertId: { type: 'string', description: 'Alert UUID (by_alert)' },
          alertIds: { type: 'array', items: { type: 'string' }, description: 'analyze: alert UUIDs to focus on' },
          minConfidence: { type: 'number', description: 'links: minimum confidence 0-1' },
          windowMinutes: { type: 'number', description: 'analyze: window in minutes (5-1440)' },
          windowHours: { type: 'number', description: 'explain: evidence window in hours (1-24)' },
          maxEvidenceItems: { type: 'number', description: 'explain: max evidence items (5-100)' },
          labelWindowDays: { type: 'number', description: 'evaluation: feedback window in days (1-365, default 90)' },
          ...pageParamSchema(10, 50),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as ReadAction;
      if (!ALERT_CORRELATION_READ_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const denied = deviceBoundDenied(auth);
      if (denied) return denied;

      try {
        if (action === 'groups') {
          const page = readPageArgs('get_alert_correlations', input, { defaultLimit: 10, maxLimit: 50 });
          if (!page.ok) return jsonError(page.error, page.code);
          let groups = await listCorrelationGroups(auth);
          if (typeof input.orgId === 'string' && input.orgId) {
            const orgId = input.orgId;
            if (!auth.canAccessOrg(orgId)) return jsonError('Access denied to this organization', 'ACCESS_DENIED');
            groups = groups.filter((group) => group.orgId === orgId);
          }
          const items = groups.slice(page.offset, page.offset + page.limit).map((group) => slimGroup(group, false));
          return json(pageEnvelope({ key: 'groups', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: groups.length }));
        }

        if (action === 'get') {
          const id = requireGroupId(input, action);
          if ('error' in id) return id.error;
          const group = await getCorrelationGroupDetail(auth, id.groupId);
          if (!group) return jsonError('Correlation group not found', 'NOT_FOUND');
          return json({ group: slimGroup(group, true) });
        }

        if (action === 'by_alert') {
          const id = requireAlertId(input, action);
          if ('error' in id) return id.error;
          const view = await buildAlertCorrelationView(auth, id.alertId);
          if (!view) return jsonError('Alert not found', 'NOT_FOUND');
          return json({
            alert: slimAlert(view.alert),
            correlations: view.correlations,
            relatedAlerts: view.relatedAlerts.map(slimAlert),
            timeline: view.timeline,
            summary: view.summary,
          });
        }

        if (action === 'links') {
          const org = linkOrgId(auth, input);
          if ('error' in org) return org.error;
          const page = readPageArgs('get_alert_correlations', input, { defaultLimit: 10, maxLimit: 50 });
          if (!page.ok) return jsonError(page.error, page.code);
          // The route pages by 1-based page number, so the offset snaps down to a page boundary.
          const pageNumber = Math.floor(page.offset / page.limit) + 1;
          const result = await listCorrelationLinks(auth, org.orgId, {
            page: String(pageNumber),
            limit: String(page.limit),
            ...(typeof input.alertId === 'string' ? { alertId: input.alertId } : {}),
            ...(typeof input.minConfidence === 'number' ? { minConfidence: String(input.minConfidence) } : {}),
          });
          return json(pageEnvelope({
            key: 'links',
            items: result.data,
            limit: result.limit,
            offset: (result.page - 1) * result.limit,
            fingerprint: page.fingerprint,
            total: result.total,
          }));
        }

        if (action === 'analyze') {
          const org = linkOrgId(auth, input);
          if ('error' in org) return org.error;
          const analysis = await analyzeCorrelationLinks(auth, org.orgId, {
            ...(Array.isArray(input.alertIds) ? { alertIds: input.alertIds as string[] } : {}),
            ...(typeof input.windowMinutes === 'number' ? { windowMinutes: input.windowMinutes } : {}),
          });
          return json({
            requestedAlertIds: analysis.requestedAlertIds,
            windowMinutes: analysis.windowMinutes,
            linkCount: analysis.links.length,
            links: analysis.links.slice(0, LINKS_SHOWN),
            linksTruncated: analysis.links.length > LINKS_SHOWN,
            summary: analysis.summary,
          });
        }

        if (action === 'evaluation') {
          const days = typeof input.labelWindowDays === 'number' ? input.labelWindowDays : 90;
          return json({ evaluation: await buildCorrelationEvaluation(auth, days) });
        }

        // explain
        const id = requireGroupId(input, action);
        if ('error' in id) return id.error;
        const outcome = await explainCorrelationGroup(auth, id.groupId, {
          ...(typeof input.windowHours === 'number' ? { windowHours: input.windowHours } : {}),
          ...(typeof input.maxEvidenceItems === 'number' ? { maxEvidenceItems: input.maxEvidenceItems } : {}),
        });
        if (outcome.status === 'not_found') return jsonError('Correlation group not found', 'NOT_FOUND');
        if (outcome.status === 'disabled') return jsonError('RCA is disabled for this organization', 'FEATURE_DISABLED');
        return json({ rca: outcome.rca });
      } catch (err) {
        console.error('[get_alert_correlations]', sanitizeThrownToolError('alert-correlations', err), err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });

  aiTools.set('manage_alert_correlations', {
    tier: 2,
    domain: 'monitoring',
    searchHint: 'acknowledge or resolve a group of correlated alerts, mark a correlation or root-cause analysis helpful or wrong',
    deviceArgs: [],
    definition: {
      name: 'manage_alert_correlations',
      description:
        'Act on correlated alerts. Actions: acknowledge_group,resolve_group (every member of groupId),acknowledge_related (alertId and its related alerts),feedback (groupId, outcome split|merged|dismissed),rca_feedback (groupId, outcome helpful|not_helpful|edited|used_in_ticket).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...ALERT_CORRELATION_WRITE_ACTIONS], description: 'The action to perform' },
          groupId: { type: 'string', description: 'Correlation group UUID' },
          alertId: { type: 'string', description: 'acknowledge_related: alert UUID' },
          outcome: {
            type: 'string',
            enum: [...CORRELATION_FEEDBACK_OUTCOMES, ...RCA_FEEDBACK_OUTCOMES],
            description: 'feedback: split|merged|dismissed. rca_feedback: helpful|not_helpful|edited|used_in_ticket',
          },
          alertIds: { type: 'array', items: { type: 'string' }, description: 'feedback: alerts the correction concerns' },
          targetGroupId: { type: 'string', description: 'feedback merged: the group merged into' },
          note: { type: 'string', description: 'feedback: optional note (max 1000 chars)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as WriteAction;
      if (!ALERT_CORRELATION_WRITE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const denied = deviceBoundDenied(auth);
      if (denied) return denied;
      // Every write stamps auth.user.id into a users FK, and the tool is AGENT_HUMAN_ONLY_TOOLS: no agent
      // proposal is ever released, so an ai_agent principal here is refused outright.
      if (isAgentPrincipal(auth)) return agentRefusal(action);

      try {
        if (action === 'acknowledge_group' || action === 'resolve_group') {
          const id = requireGroupId(input, action);
          if ('error' in id) return id.error;
          const kind = action === 'acknowledge_group' ? 'acknowledge' : 'resolve';
          const mutation = await mutateCorrelationGroup(auth, id.groupId, kind);
          if (!mutation) return jsonError('Correlation group not found', 'NOT_FOUND');
          emitGroupAcceptedFeedback(auth, id.groupId, kind, mutation);
          return json({
            groupId: id.groupId, action, ...mutation.result, groupAlertIds: mutation.groupAlertIds,
            ...(mutation.result.updated === 0 ? { note: 'No alert changed: every member was already in a terminal state or changed concurrently.' } : {}),
          });
        }

        if (action === 'acknowledge_related') {
          const id = requireAlertId(input, action);
          if ('error' in id) return id.error;
          const outcome = await acknowledgeAlertWithRelated(auth, id.alertId);
          if (!outcome) return jsonError('Alert not found', 'NOT_FOUND');
          return json({
            alertId: id.alertId,
            action,
            ...outcome.result,
            ...(outcome.result.updated === 0 ? { note: 'No alert changed: every alert was already in a terminal state or changed concurrently.' } : {}),
            relatedAlertIds: outcome.relatedAlerts.map((related) => related.id),
          });
        }

        const id = requireGroupId(input, action);
        if ('error' in id) return id.error;
        if (typeof input.outcome !== 'string') {
          return jsonError(`outcome is required for ${action}`, 'VALIDATION_ERROR');
        }

        if (action === 'feedback') {
          const parsed = parseData(correlationFeedbackSchema, {
            eventType: `correlation.${input.outcome}`,
            outcome: input.outcome,
            ...(input.alertIds !== undefined ? { alertIds: input.alertIds } : {}),
            ...(input.targetGroupId !== undefined ? { targetGroupId: input.targetGroupId } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          });
          if ('error' in parsed) return parsed.error;
          const group = await recordCorrelationFeedback(auth, id.groupId, parsed.value);
          if (!group) return jsonError('Correlation group, or a referenced alert / merge target group, not found', 'NOT_FOUND');
          return json({ success: true, groupId: group.id, action, outcome: parsed.value.outcome });
        }

        // rca_feedback
        const parsed = parseData(rcaFeedbackSchema, { eventType: `rca.${input.outcome}`, outcome: input.outcome });
        if ('error' in parsed) return parsed.error;
        const group = await recordRcaFeedback(auth, id.groupId, parsed.value);
        if (!group) return jsonError('Correlation group not found', 'NOT_FOUND');
        return json({ success: true, groupId: group.id, action, outcome: parsed.value.outcome });
      } catch (err) {
        console.error('[manage_alert_correlations]', sanitizeThrownToolError('alert-correlations', err), err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
