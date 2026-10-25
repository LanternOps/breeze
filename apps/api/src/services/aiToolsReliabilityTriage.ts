/**
 * Reliability triage (full-control W07, #6777): the extra `get_fleet_health`
 * actions and the `reliability_feedback` tool, twins of routes/reliability.ts.
 *
 *  - `get_fleet_health` keeps its fleet list as the default (`action` absent or
 *    `list`) and gains `history` (one device's score over time), `offenders`
 *    (the services / hardware / processes behind a device's score),
 *    `evaluation` (score quality over the caller's scope) and `org_summary`
 *    (one organization's rollup + worst devices). All four are reads.
 *  - `reliability_feedback` (tier 2) labels a device's reliability score
 *    (failure confirmed / replaced / false alarm). It is its own tool, not an
 *    action on `get_fleet_health`, so the read tool's MCP `readOnlyHint` stays
 *    true.
 *
 * Axes: `history` / `offenders` / `feedback` resolve the device through
 * `verifyDeviceAccess` (org + site + exact-device). `evaluation` and
 * `org_summary` aggregate a scope and the services take only org and site
 * filters, so an exact-device run (`auth.allowedDeviceIds`) is refused rather
 * than shown a sibling's data. Offender labels are service / hardware / process
 * names self-reported by the device and are fenced in `RAW_TEXT_FIELDS_BY_TOOL`.
 */
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { RELIABILITY_FEEDBACK_OUTCOMES } from './aiToolSchemasAlertTriage';
import { agentRefusal, isAgentPrincipal, json, jsonError } from './aiToolsTicketOpsShared';
import { approverReleaseMismatch } from './aiToolReleaseGuards';
import { siteAllowlistOf } from './aiToolsSiteScope';
import { sanitizeThrownToolError } from './aiToolErrors';
import {
  evaluateReliabilityScores,
  getDeviceReliabilityHistory,
  getDeviceReliabilityOffenders,
  getOrgReliabilitySummary,
  listReliabilityDevices,
} from './reliabilityScoring';
import type { ToolExecutionContext } from './toolExecutionContext';
import { feedbackBodySchema, recordDeviceReliabilityFeedback } from '../routes/reliability';

const guid = z.string().guid();

const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_OFFENDER_DAYS = 30;
const DEFAULT_OFFENDER_LIMIT = 5;
const DEFAULT_AT_RISK_MAX_SCORE = 70;
const DEFAULT_LABEL_WINDOW_DAYS = 90;
const ORG_SUMMARY_WORST_DEVICES = 10;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Aggregates over an org cannot be narrowed to an exact-device set, so those runs are refused whole. */
function deviceBoundAggregateDenied(auth: AuthContext): string | null {
  return auth.allowedDeviceIds !== undefined
    ? jsonError('This reliability view aggregates a whole scope and is not available to a device-bound run', 'DEVICE_SCOPE_UNSUPPORTED')
    : null;
}

/** The org filter the route derives: a named org, else the caller's own, else every accessible org. */
function orgIdsFor(auth: AuthContext, orgId: unknown): { orgIds: string[] | undefined } | { error: string } {
  if (typeof orgId === 'string' && orgId) {
    if (!auth.canAccessOrg(orgId)) return { error: jsonError('Access denied to this organization', 'ACCESS_DENIED') };
    return { orgIds: [orgId] };
  }
  const orgIds = auth.orgId
    ? [auth.orgId]
    : (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0 ? auth.accessibleOrgIds : undefined);
  if (!orgIds && auth.scope !== 'system') return { error: jsonError('Organization context required', 'VALIDATION_ERROR') };
  return { orgIds };
}

/**
 * The non-list `get_fleet_health` actions. Returns the JSON string to send, or
 * `null` when `action` is the default fleet list (the caller handles that one).
 */
export async function runFleetHealthAction(input: Record<string, unknown>, auth: AuthContext): Promise<string | null> {
  const action = input.action;
  if (action === undefined || action === 'list') return null;

  try {
    if (action === 'history' || action === 'offenders') {
      const deviceId = guid.safeParse(input.deviceId);
      if (!deviceId.success) return jsonError(`deviceId (device UUID) is required for ${action}`, 'VALIDATION_ERROR');
      const access = await verifyDeviceAccess(deviceId.data, auth);
      if ('error' in access) return jsonError(access.error, 'NOT_FOUND');

      if (action === 'history') {
        const days = Math.min(365, Math.max(1, Math.trunc(num(input.days, DEFAULT_HISTORY_DAYS))));
        const points = await getDeviceReliabilityHistory(deviceId.data, days);
        return json({ deviceId: deviceId.data, days, points });
      }
      const days = Math.min(365, Math.max(1, Math.trunc(num(input.days, DEFAULT_OFFENDER_DAYS))));
      const topN = Math.min(20, Math.max(1, Math.trunc(num(input.topN, DEFAULT_OFFENDER_LIMIT))));
      const offenders = await getDeviceReliabilityOffenders(deviceId.data, days, topN);
      return json({ deviceId: deviceId.data, days, offenders });
    }

    if (action === 'evaluation') {
      const denied = deviceBoundAggregateDenied(auth);
      if (denied) return denied;
      const orgs = orgIdsFor(auth, input.orgId);
      if ('error' in orgs) return orgs.error;
      const siteId = typeof input.siteId === 'string' && input.siteId ? input.siteId : undefined;
      if (siteId && auth.canAccessSite && !auth.canAccessSite(siteId)) {
        return jsonError('Access to this site denied', 'ACCESS_DENIED');
      }
      const summary = await evaluateReliabilityScores({
        orgIds: orgs.orgIds,
        siteId,
        siteIds: siteId ? undefined : (siteAllowlistOf(auth) as string[] | undefined),
        atRiskMaxScore: Math.min(100, Math.max(0, Math.trunc(num(input.atRiskMaxScore, DEFAULT_AT_RISK_MAX_SCORE)))),
        labelWindowDays: Math.min(365, Math.max(1, Math.trunc(num(input.labelWindowDays, DEFAULT_LABEL_WINDOW_DAYS)))),
      });
      return json({ summary });
    }

    if (action === 'org_summary') {
      const denied = deviceBoundAggregateDenied(auth);
      if (denied) return denied;
      const orgId = guid.safeParse(input.orgId);
      if (!orgId.success) return jsonError('orgId (organization UUID) is required for org_summary', 'VALIDATION_ERROR');
      if (!auth.canAccessOrg(orgId.data)) return jsonError('Access denied to this organization', 'ACCESS_DENIED');
      const siteIds = siteAllowlistOf(auth) as string[] | undefined;
      const [summary, worstDevices] = await Promise.all([
        getOrgReliabilitySummary(orgId.data, { siteIds }),
        listReliabilityDevices({ orgId: orgId.data, siteIds, limit: ORG_SUMMARY_WORST_DEVICES, offset: 0 }),
      ]);
      return json({ summary, worstDevices: worstDevices.rows.map(({ topIssues, drivers: _drivers, enrolledAt: _enrolledAt, ...row }) => ({
        ...row,
        topIssueCount: Array.isArray(topIssues) ? topIssues.length : 0,
      })) });
    }

    return jsonError(`Unknown action: ${String(action)}`);
  } catch (err) {
    console.error('[fleet:get_fleet_health]', sanitizeThrownToolError('reliability', err), err);
    return jsonError('Operation failed. Check server logs for details.');
  }
}

export function registerReliabilityTriageTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('reliability_feedback', {
    tier: 2,
    domain: 'devices',
    searchHint: 'label a device reliability score: failure confirmed, device replaced, or false alarm',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'reliability_feedback',
      description:
        'Label a device\'s reliability score: failure_confirmed, replaced, or false_alarm. Improves future scoring; changes nothing on the device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID' },
          outcome: { type: 'string', enum: [...RELIABILITY_FEEDBACK_OUTCOMES], description: 'What actually happened' },
          occurredAt: { type: 'string', description: 'Optional ISO timestamp the event happened' },
          sourceEventId: { type: 'string', description: 'Optional UUID of the event being labelled (dedupes repeats)' },
          snapshotComputedAt: { type: 'string', description: 'Optional computedAt of the score being labelled' },
        },
        required: ['deviceId', 'outcome'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      // The label stamps auth.user.id into ml_feedback_events.actor_user_id (a users FK). A supervised or
      // tier-2 agent proposal is released AS THE APPROVER (USER_OWNED_RELEASE_ACTIONS); a direct agent call never writes.
      if (isAgentPrincipal(auth) && !context?.approverRelease) return agentRefusal('reliability_feedback');
      if (approverReleaseMismatch(auth, context)) return jsonError('Approver release mismatch', 'APPROVER_RELEASE_MISMATCH');

      const deviceId = guid.safeParse(input.deviceId);
      if (!deviceId.success) return jsonError('deviceId (device UUID) is required', 'VALIDATION_ERROR');
      const parsed = feedbackBodySchema.safeParse({
        outcome: input.outcome,
        ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
        ...(input.sourceEventId !== undefined ? { sourceEventId: input.sourceEventId } : {}),
        ...(input.snapshotComputedAt !== undefined ? { snapshotComputedAt: input.snapshotComputedAt } : {}),
      });
      if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');

      try {
        // org + site + exact-device axes, the route's getDeviceWithOrgAndSiteCheck.
        const access = await verifyDeviceAccess(deviceId.data, auth);
        if ('error' in access) return jsonError(access.error, 'NOT_FOUND');
        const outcome = await recordDeviceReliabilityFeedback({
          orgId: access.device.orgId,
          deviceId: deviceId.data,
          actorUserId: auth.user.id,
          body: parsed.data,
        });
        if (outcome.status === 'no_snapshot') {
          return jsonError('No reliability snapshot available for this device yet', 'NOT_FOUND');
        }
        return json({ success: true, feedback: outcome.feedback });
      } catch (err) {
        console.error('[reliability_feedback]', sanitizeThrownToolError('reliability', err), err);
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
