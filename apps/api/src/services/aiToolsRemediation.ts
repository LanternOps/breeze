import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { remediationSuggestions } from '../db/schema/remediationSuggestions';
import type { AiTool } from './aiTools';
import { resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import { sanitizeThrownToolError } from './aiToolErrors';

// Named scalar columns only: evidence, parameters and targetDeviceIds stay out of model context.
const SAFE_SUGGESTION_PROJECTION = {
  id: remediationSuggestions.id,
  orgId: remediationSuggestions.orgId,
  sourceType: remediationSuggestions.sourceType,
  sourceId: remediationSuggestions.sourceId,
  deviceId: remediationSuggestions.deviceId,
  alertId: remediationSuggestions.alertId,
  anomalyId: remediationSuggestions.anomalyId,
  correlationGroupId: remediationSuggestions.correlationGroupId,
  rcaId: remediationSuggestions.rcaId,
  targetType: remediationSuggestions.targetType,
  scriptId: remediationSuggestions.scriptId,
  playbookId: remediationSuggestions.playbookId,
  title: remediationSuggestions.title,
  rationale: remediationSuggestions.rationale,
  expectedAction: remediationSuggestions.expectedAction,
  riskTier: remediationSuggestions.riskTier,
  status: remediationSuggestions.status,
  confidence: remediationSuggestions.confidence,
  elevationRequestId: remediationSuggestions.elevationRequestId,
  toolExecutionId: remediationSuggestions.toolExecutionId,
  scriptExecutionId: remediationSuggestions.scriptExecutionId,
  playbookExecutionId: remediationSuggestions.playbookExecutionId,
  failureMessage: remediationSuggestions.failureMessage,
  createdAt: remediationSuggestions.createdAt,
  updatedAt: remediationSuggestions.updatedAt,
  acceptedAt: remediationSuggestions.acceptedAt,
  rejectedAt: remediationSuggestions.rejectedAt,
  executedAt: remediationSuggestions.executedAt,
};

const listSuggestionInputSchema = z.object({
  orgId: z.string().guid().optional(),
  sourceType: z.enum(['alert', 'anomaly', 'correlation', 'rca']).optional(),
  sourceId: z.string().min(1).max(255).optional(),
  deviceId: z.string().guid().optional(),
  status: z.enum(['all', 'suggested', 'accepted', 'edited', 'rejected', 'executed', 'failed']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export function registerRemediationTools(tools: Map<string, AiTool>): void {
  const registerTool = (tool: AiTool) => tools.set(tool.definition.name, tool);
  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'AI remediation suggestions for alerts and anomalies, proposed fixes, accepted/rejected/executed status',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'list_remediation_suggestions',
      description: 'List remediation suggestions by organization, source, device and status. Returns proposed fixes and execution status without evidence or execution parameters.',
      input_schema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'Organization UUID' },
          sourceType: { type: 'string', enum: ['alert', 'anomaly', 'correlation', 'rca'], description: 'Source: alert, anomaly, correlation or rca' },
          sourceId: { type: 'string', description: 'Source identifier (1–255 characters)' },
          deviceId: { type: 'string', description: 'Device UUID' },
          status: { type: 'string', enum: ['all', 'suggested', 'accepted', 'edited', 'rejected', 'executed', 'failed'], description: 'Status: all (default), suggested, accepted, edited, rejected, executed or failed' },
          limit: { type: 'number', description: 'Maximum rows (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      const parsed = listSuggestionInputSchema.safeParse({
        ...input,
        limit: typeof input.limit === 'number' ? Math.min(100, Math.max(1, input.limit)) : input.limit,
      });
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid suggestion filters' });
      const { orgId, sourceType, sourceId, deviceId, status = 'all', limit = 25 } = parsed.data;
      if (!['organization', 'partner', 'system'].includes(auth.scope)) {
        return JSON.stringify({ error: 'Organization, partner or system scope required' });
      }
      if (auth.scope === 'organization' && !auth.orgId) {
        return JSON.stringify({ error: 'Organization context required' });
      }
      if (orgId && (!auth.canAccessOrg(orgId) || (auth.scope === 'organization' && orgId !== auth.orgId))) {
        return JSON.stringify({ error: 'Access to this organization denied' });
      }
      if ((auth.scope === 'partner' && (auth.accessibleOrgIds ?? []).length === 0) || auth.allowedSiteIds?.length === 0) {
        return JSON.stringify({ suggestions: [], showing: 0 });
      }
      const conditions: SQL[] = [];
      const orgCond = orgId ? eq(remediationSuggestions.orgId, orgId) : auth.orgCondition(remediationSuggestions.orgId);
      if (orgCond) conditions.push(orgCond);
      if (sourceType) conditions.push(eq(remediationSuggestions.sourceType, sourceType));
      if (sourceId) conditions.push(eq(remediationSuggestions.sourceId, sourceId));
      if (deviceId) conditions.push(eq(remediationSuggestions.deviceId, deviceId));
      if (status !== 'all') conditions.push(eq(remediationSuggestions.status, status));
      try {
        const rows = await db.select(SAFE_SUGGESTION_PROJECTION).from(remediationSuggestions)
          .where(and(...conditions)).orderBy(desc(remediationSuggestions.createdAt)).limit(limit);
        // The helper takes one org, not a list of device ids. Keep each org's
        // reachable set separate; null means unrestricted, [] means no devices.
        const reachableByOrg = new Map<string, Set<string> | null>();
        if (auth.allowedSiteIds || auth.allowedDeviceIds) {
          for (const rowOrgId of new Set(rows.filter((row) => row.deviceId).map((row) => row.orgId))) {
            const reachable = await resolveSiteAllowedDeviceIds(rowOrgId, auth);
            reachableByOrg.set(rowOrgId, reachable === null ? null : new Set(reachable));
          }
        }
        const suggestions = rows.filter((row) => {
          const reachable = reachableByOrg.get(row.orgId);
          return !row.deviceId || reachable == null || reachable.has(row.deviceId);
        });
        return JSON.stringify({ suggestions, showing: suggestions.length });
      } catch (error) {
        return JSON.stringify({ error: sanitizeThrownToolError('list_remediation_suggestions', error) });
      }
    },
  });
}
