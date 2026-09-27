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
import type { AiTool } from './aiTools';
import { sanitizeThrownToolError } from './aiToolErrors';
import { findAlertWithAccess } from './aiToolsAlerts';
import { deviceIdSiteDenied } from './aiToolsSiteScope';
import { resolveOrgPartnerId } from './fixMemory/catalog';
import { lookupFixes } from './fixMemory/lookup';
import { signatureForSource, type FixSourceRef } from './fixMemory/signatureLoader';
import { shouldProduceMlOutput } from './mlFeatureFlags';

export const findProvenFixesInputSchema = z.object({
  alertId: z.string().guid().optional(),
  anomalyEpisodeId: z.string().guid().optional(),
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
    searchHint: 'fixes proven on this same alert or anomaly across your clients, with track records',
    definition: {
      name: 'find_proven_fixes',
      description: 'Find fixes proven by observed outcomes on this same problem (an alert or anomaly episode) across your clients, with their track records. Returns proven fixes and similar ones; never another client\'s private details.',
      input_schema: {
        type: 'object',
        properties: {
          alertId: { type: 'string', description: 'Alert UUID (give this or anomalyEpisodeId)' },
          anomalyEpisodeId: { type: 'string', description: 'Metric anomaly episode UUID (give this or alertId)' },
          limit: { type: 'number', description: 'Maximum fixes per group (default 5, max 20)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      const parsed = findProvenFixesInputSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      const { alertId, anomalyEpisodeId, limit = 5 } = parsed.data;
      if (Boolean(alertId) === Boolean(anomalyEpisodeId)) {
        return JSON.stringify({ error: 'Provide exactly one of alertId or anomalyEpisodeId' });
      }
      try {
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
        return JSON.stringify(await lookupFixes({ orgId, partnerId, signature: resolved.signature, limit }));
      } catch (error) {
        return JSON.stringify({ error: sanitizeThrownToolError('find_proven_fixes', error) });
      }
    },
  });
}
