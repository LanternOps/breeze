/**
 * `manage_topology_monitoring` (full-control W08, #6778): the AI twin of
 * routes/topology/policies.ts, targets.ts and settings.ts — a site's recurring
 * monitoring policies, probe targets and effective settings.
 *
 * Actions and classes (aiGuardrails.ts, plan W08):
 *  - `list_policies`, `list_targets`, `get_settings` — tier 1 reads (`read`).
 *  - `upsert_*`, `delete_*` (capability `configure`) and `patch_settings`
 *    (`write`) — tier 2: the route's own revision compare-and-swap makes them
 *    retryable, and ARMING a policy stays human-only (`monitoringArms`); a
 *    configuration change here never arms anything. Recorded for Todd: the
 *    quorum asked for supervised (a change that touches an armed policy
 *    disarms it, and re-arming is a human step) — the wave brief says tier 2.
 *
 * Reads project by allowlist (no authority digests, frozen arming records or
 * routing contexts). The user-authored definitions are returned as written —
 * they are what a person edits through this tool.
 */
import { topologySiteSettingsPatchSchema } from '@breeze/shared';
import type { AiTool } from './aiTools';
import { TOPOLOGY_MONITORING_ACTIONS } from './aiToolSchemasTopologyOps';
import { sanitizeThrownToolError } from './aiToolErrors';
import { agentRefusal, boundedJson, committedJson, isAgentPrincipal, jsonError, requireFields, topologySite, topologyThrown } from './aiToolsTopologyShared';
import {
  deleteTopologyConfigurationObject, listTopologyConfigurationObjects, topologyConfigurationDeleteSchema,
  topologyConfigurationPageSchema, topologyPolicyWriteSchema, topologyTargetWriteSchema,
  upsertTopologyMonitoringPolicy, upsertTopologyProbeTarget,
} from './topology/configurationObjects';
import { readTopologySiteSettings } from './topology/siteSettings';
import { updateTopologySiteConfiguration } from './topology/siteConfiguration';
import type { TopologyRequestContext } from './topology/access';

type Action = (typeof TOPOLOGY_MONITORING_ACTIONS)[number];

const WRITE_ACTIONS: ReadonlySet<Action> = new Set(['upsert_policy', 'delete_policy', 'upsert_target', 'delete_target', 'patch_settings']);

/** Allowlist view of a stored policy or target row (no authority digests, arming records or routing state). */
function configurationRowView(row: Record<string, unknown>) {
  const pick = ['id', 'key', 'revision', 'enabled', 'definition', 'blockedReason', 'armedAt', 'nextScheduledAt', 'updatedAt'] as const;
  return Object.fromEntries(pick.filter((key) => key in row).map((key) => [key, row[key]]));
}

async function listRows(ctx: TopologyRequestContext, kind: 'policies' | 'targets', input: Record<string, unknown>) {
  const page = await listTopologyConfigurationObjects(ctx, kind, topologyConfigurationPageSchema.parse({
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  }));
  return { items: page.items.map((row) => configurationRowView(row as unknown as Record<string, unknown>)), nextCursor: page.nextCursor };
}

async function settingsView(ctx: TopologyRequestContext) {
  const settings = await readTopologySiteSettings(ctx);
  return {
    siteId: settings.siteId,
    settingsRevision: settings.settingsRevision,
    flags: settings.flags,
    resolved: settings.resolved,
    binding: settings.binding,
    permissions: settings.permissions,
  };
}

export function registerTopologyMonitoringTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_topology_monitoring', {
    tier: 1,
    domain: 'network',
    searchHint: 'site network monitoring policies, probe targets and topology settings: list, create, change, delete',
    deviceArgs: [],
    captureExempt: true,
    definition: {
      name: 'manage_topology_monitoring',
      description:
        'Topology monitoring at a site. Actions: list_policies,list_targets,get_settings,upsert_policy,upsert_target,delete_policy,delete_target,patch_settings. Upserts take key, definition, expectedRevision (id to change); deletes take id.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_MONITORING_ACTIONS], description: 'The action to perform' },
          siteId: { type: 'string', description: 'Site UUID' },
          id: { type: 'string', description: 'upsert (to change) / delete: policy or target UUID' },
          key: { type: 'string', description: 'upsert: stable key, lowercase letters, digits, - and _ (max 64)' },
          definition: { type: 'object', description: 'upsert: the policy or target definition (validated server-side)' },
          overrides: { type: 'object', description: 'patch_settings: the site configuration layer (validated server-side)' },
          expectedRevision: { type: 'string', description: 'upsert/delete/patch_settings: the revision you last read (settingsRevision); a stale value is refused' },
          cursor: { type: 'string', description: 'list: continuation cursor' },
          limit: { type: 'number', description: 'Max rows per list page (default 100, max 200)' },
        },
        required: ['action', 'siteId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TOPOLOGY_MONITORING_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const write = WRITE_ACTIONS.has(action);
      if (write && isAgentPrincipal(auth)) return agentRefusal(action);
      const capability = action === 'patch_settings' ? 'write' : write ? 'configure' : 'read';
      const site = await topologySite(auth, input.siteId, capability);
      if ('error' in site) return site.error;
      const ctx = site.ctx;
      try {
        switch (action) {
          case 'list_policies':
            return boundedJson(await listRows(ctx, 'policies', input));
          case 'list_targets':
            return boundedJson(await listRows(ctx, 'targets', input));
          case 'get_settings':
            return boundedJson(await settingsView(ctx));
          case 'upsert_policy':
          case 'upsert_target': {
            const missing = requireFields(input, ['key', 'definition', 'expectedRevision'], action);
            if (missing) return missing;
            const id = typeof input.id === 'string' ? input.id : undefined;
            const row = action === 'upsert_policy'
              ? await upsertTopologyMonitoringPolicy(ctx, topologyPolicyWriteSchema.parse({ expectedRevision: input.expectedRevision, key: input.key, definition: input.definition }), id)
              : await upsertTopologyProbeTarget(ctx, topologyTargetWriteSchema.parse({ expectedRevision: input.expectedRevision, key: input.key, definition: input.definition }), id);
            return committedJson(configurationRowView(row as unknown as Record<string, unknown>));
          }
          case 'delete_policy':
          case 'delete_target': {
            const missing = requireFields(input, ['id', 'expectedRevision'], action);
            if (missing) return missing;
            return committedJson(await deleteTopologyConfigurationObject(
              ctx, action === 'delete_policy' ? 'policies' : 'targets', String(input.id),
              topologyConfigurationDeleteSchema.parse({ expectedRevision: input.expectedRevision }),
            ));
          }
          case 'patch_settings': {
            const missing = requireFields(input, ['overrides', 'expectedRevision'], action);
            if (missing) return missing;
            const patch = topologySiteSettingsPatchSchema.parse({ expectedRevision: input.expectedRevision, overrides: input.overrides });
            await updateTopologySiteConfiguration(ctx, patch.overrides, patch.expectedRevision);
            try {
              return committedJson(await settingsView(ctx));
            } catch (readBackError) {
              // The patch committed; a failed read-back must not read as a failed write (the model would retry on a stale revision).
              console.error('[manage_topology_monitoring] settings read-back failed after commit', sanitizeThrownToolError('topology-settings-readback', readBackError));
              return JSON.stringify({ success: true, committed: true, readBackFailed: true, note: 'The settings were saved; read them back with get_settings.' });
            }
          }
        }
      } catch (error) {
        return topologyThrown('manage_topology_monitoring', error);
      }
    },
  });
}
