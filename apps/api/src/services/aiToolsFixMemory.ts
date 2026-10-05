/**
 * find_proven_fixes (AI Suggested Fixes W1): tier-1 read of fix memory for
 * chat, AI agents, Helper and MCP. Runs under the caller's RLS context (the
 * tool dispatcher's withDbAccessContext); lookupFixes additionally filters by
 * the SOURCE's org and that org's partner, so it never returns another org's
 * private rows. Output carries counts, ids and statuses only.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { metricAnomalyEpisodes } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { verifyDeviceAccess, type AiTool } from './aiTools';
import { sanitizeThrownToolError } from './aiToolErrors';
import { findAlertWithAccess } from './aiToolsAlerts';
import { deviceIdSiteDenied } from './aiToolsSiteScope';
import { resolveDeviceOs, resolveOrgPartnerId } from './fixMemory/catalog';
import { lookupFixes, type FixLookupResult } from './fixMemory/lookup';
import { FIX_PROBLEM_LEAF_TYPES, fixProblemSchema, signatureForProblem } from './fixMemory/problemSignature';
import { signatureForSource, type FixSourceRef } from './fixMemory/signatureLoader';
import { shouldProduceMlOutput } from './mlFeatureFlags';

/** Reviewed-step titles are human-authored text: ids and counts only reach model context. */
function toToolOutput(result: FixLookupResult): string {
  const strip = <T extends { instructionsTitle?: unknown }>(r: T): Omit<T, 'instructionsTitle'> => {
    const { instructionsTitle: _omit, ...rest } = r;
    return rest;
  };
  return JSON.stringify({ ...result, proven: result.proven.map(strip), similar: result.similar.map(strip) });
}

export const findProvenFixesInputSchema = z.object({
  alertId: z.string().guid().optional(),
  anomalyEpisodeId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  problem: fixProblemSchema.optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

async function findEpisodeWithAccess(episodeId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(metricAnomalyEpisodes.id, episodeId)];
  const orgCond = auth.orgCondition(metricAnomalyEpisodes.orgId);
  if (orgCond) conditions.push(orgCond);
  const [episode] = await db
    .select({ id: metricAnomalyEpisodes.id, orgId: metricAnomalyEpisodes.orgId, deviceId: metricAnomalyEpisodes.deviceId })
    .from(metricAnomalyEpisodes).where(and(...conditions)).limit(1);
  if (!episode) return null;
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(episode.deviceId)) return null;
  if (await deviceIdSiteDenied(auth, episode.deviceId)) return null;
  return episode;
}

export function registerFixMemoryTools(tools: Map<string, AiTool>): void {
  tools.set('find_proven_fixes', {
    tier: 1,
    domain: 'monitoring',
    deviceArgs: ['deviceId'],
    searchHint: 'fixes proven on this same alert or anomaly across your clients, with track records',
    definition: {
      name: 'find_proven_fixes',
      description: 'Find fixes proven by observed outcomes on this same problem (an alert, an anomaly episode, or a device plus a structured condition) across your clients, with their track records. Returns proven fixes and similar ones; never another client\'s private details.',
      input_schema: {
        type: 'object',
        properties: {
          alertId: { type: 'string', description: 'Alert UUID (give this, anomalyEpisodeId, or deviceId+problem)' },
          anomalyEpisodeId: { type: 'string', description: 'Metric anomaly episode UUID (give this, alertId, or deviceId+problem)' },
          deviceId: { type: 'string', description: 'Device UUID; give together with problem' },
          problem: {
            type: 'object',
            description: 'One structured alert condition, e.g. {"type":"service_stopped","serviceName":"Spooler"}. No free text.',
            properties: { type: { type: 'string', enum: [...FIX_PROBLEM_LEAF_TYPES] } },
            required: ['type'],
          },
          limit: { type: 'number', description: 'Maximum fixes per group (default 5, max 20)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      const parsed = findProvenFixesInputSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      const { alertId, anomalyEpisodeId, deviceId, problem, limit = 5 } = parsed.data;
      const sources = [Boolean(alertId), Boolean(anomalyEpisodeId), Boolean(deviceId || problem)].filter(Boolean).length;
      if (sources !== 1 || Boolean(deviceId) !== Boolean(problem)) {
        return JSON.stringify({ error: 'Provide exactly one of alertId, anomalyEpisodeId, or deviceId together with problem' });
      }
      try {
        if (deviceId) {
          const access = await verifyDeviceAccess(deviceId, auth);
          if ('error' in access) return JSON.stringify({ error: access.error });
          const orgId = access.device.orgId;
          if (!(await shouldProduceMlOutput(orgId, 'ml.remediation_suggestions.enabled'))) {
            return JSON.stringify({ disabled: true, proven: [], similar: [] });
          }
          const osFamily = await resolveDeviceOs(deviceId);
          const signature = osFamily ? signatureForProblem({ osFamily, problem: problem! }) : null;
          if (!signature) {
            return JSON.stringify({ signature: null, proven: [], similar: [], note: 'This problem has no structured signature; memory lookup skipped.' });
          }
          const partnerId = await resolveOrgPartnerId(orgId);
          if (!partnerId) return JSON.stringify({ error: 'Organization not found' });
          return toToolOutput(await lookupFixes({ orgId, partnerId, signature, limit }));
        }
        let orgId: string;
        let ref: FixSourceRef;
        if (alertId) {
          const alert = await findAlertWithAccess(alertId, auth);
          if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });
          orgId = alert.orgId;
          ref = { kind: 'alert', alertId: alert.id };
        } else {
          const episode = await findEpisodeWithAccess(anomalyEpisodeId!, auth);
          if (!episode) return JSON.stringify({ error: 'Anomaly episode not found or access denied' });
          orgId = episode.orgId;
          ref = { kind: 'anomaly', anomalyEpisodeId: episode.id };
        }
        if (!(await shouldProduceMlOutput(orgId, 'ml.remediation_suggestions.enabled'))) {
          return JSON.stringify({ disabled: true, proven: [], similar: [] });
        }
        const resolved = await signatureForSource(ref);
        if (!resolved) {
          return JSON.stringify({ signature: null, proven: [], similar: [], note: 'No structured signature for this problem; memory lookup skipped.' });
        }
        const partnerId = await resolveOrgPartnerId(orgId);
        if (!partnerId) return JSON.stringify({ error: 'Organization not found' });
        return toToolOutput(await lookupFixes({ orgId, partnerId, signature: resolved.signature, limit }));
      } catch (error) {
        return JSON.stringify({ error: sanitizeThrownToolError('find_proven_fixes', error) });
      }
    },
  });
}
