/**
 * `run_topology_diagnostic` (full-control W08, #6778): the AI twin of
 * routes/topology/diagnostics.ts — eligible collectors, start, read and cancel
 * one fixed-recipe connectivity run.
 *
 * Classes (aiGuardrails.ts, plan W08):
 *  - `collectors`, `get` — tier 1 reads (site `read` capability).
 *  - `start`, `cancel` — tier 2. `start` dispatches a bounded probe to a device
 *    (topology:execute + devices:execute); it runs INLINE under the person's
 *    own session, so the service's MFA claim and its refusal of an `ai_agent`
 *    principal are real. It is deliberately NOT supervised: a durable release
 *    synthesises `mfa: true`, which is why `diagnose_connectivity` (the
 *    investigation's approved start) has its own verified path with a fresh
 *    approver factor. This tool is never a supervised class, so it is never
 *    released from an intent; the handler also refuses an approver-substituted
 *    release context and an `ai_agent` principal.
 *
 * The device gate (`deviceArgs: ['originDeviceId']`) runs centrally when the
 * caller pins an origin; the site axis is `topologySite(…, 'execute')`.
 */
import { createHash } from 'node:crypto';
import { createTopologyDiagnosticSchema, topologyCollectorsQuerySchema } from '@breeze/shared';
import type { AiTool } from './aiTools';
import { TOPOLOGY_DIAGNOSTIC_ACTIONS, TOPOLOGY_RECIPES } from './aiToolSchemasTopologyOps';
import { agentRefusal, boundedJson, committedJson, defined, isAgentPrincipal, jsonError, requireFields, topologySite, topologyThrown } from './aiToolsTopologyShared';
import { readTopologyAiDiagnosticRun } from './topology/aiRead';
import { cancelTopologyDiagnosticRun, createTopologyDiagnosticRun } from './topology/diagnosticRuns';
import { selectTopologyOrigins } from './topology/originEligibility';
import type { ToolExecutionContext } from './toolExecutionContext';

type Action = (typeof TOPOLOGY_DIAGNOSTIC_ACTIONS)[number];

function planRequest(input: Record<string, unknown>) {
  return createTopologyDiagnosticSchema.parse(defined({
    recipeId: input.recipeId,
    recipeVersion: 1,
    subject: { kind: input.subjectKind, id: input.subjectId },
    graphRevision: input.graphRevision,
    originDeviceId: input.originDeviceId,
    contextKey: input.contextKey,
    family: input.family,
    ...(input.maxHops !== undefined || input.probesPerHop !== undefined
      ? { trace: { maxHops: input.maxHops ?? 16, probesPerHop: input.probesPerHop ?? 1 } }
      : {}),
  }));
}

export function registerTopologyDiagnosticTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('run_topology_diagnostic', {
    tier: 1,
    domain: 'network',
    searchHint: 'run a gateway, DNS, internet or trace-route check from a device at a site; check on it or cancel it',
    deviceArgs: ['originDeviceId'],
    captureExempt: true,
    definition: {
      name: 'run_topology_diagnostic',
      description:
        'Topology connectivity checks at a site. Actions: collectors,get (runId),start,cancel (runId). collectors and start take recipeId, subjectKind, subjectId and graphRevision; start probes from a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_DIAGNOSTIC_ACTIONS], description: 'The action to perform' },
          siteId: { type: 'string', description: 'Site UUID' },
          recipeId: { type: 'string', enum: [...TOPOLOGY_RECIPES], description: 'collectors/start: the fixed check recipe' },
          subjectKind: { type: 'string', enum: ['node', 'relationship', 'destination'], description: 'collectors/start: what the check is about' },
          subjectId: { type: 'string', description: 'collectors/start: node, link or destination UUID' },
          graphRevision: { type: 'string', description: 'collectors/start: graph revision the request is based on (from get_topology_graph)' },
          originDeviceId: { type: 'string', description: 'start: device UUID to probe from; omitted, the server picks an eligible collector' },
          contextKey: { type: 'string', description: 'collectors/start: optional network context key' },
          family: { type: 'string', enum: ['ipv4', 'ipv6'], description: 'collectors/start: optional address family' },
          maxHops: { type: 'number', description: 'start trace_route: max hops 1-30 (default 16)' },
          probesPerHop: { type: 'number', description: 'start trace_route: probes per hop 1-2 (default 1)' },
          idempotencyKey: { type: 'string', description: 'start: optional key; a retry with the same key returns the same run' },
          runId: { type: 'string', description: 'get/cancel: diagnostic run UUID' },
        },
        required: ['action', 'siteId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      const action = input.action as Action;
      if (!TOPOLOGY_DIAGNOSTIC_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const write = action === 'start' || action === 'cancel';
      if (write) {
        // Never from a durable release (synthesised MFA) and never for an agent principal.
        if (isAgentPrincipal(auth)) return agentRefusal(action);
        if (context?.approverRelease) return jsonError('Topology diagnostics run only inline in your own session', 'INLINE_ONLY');
      }
      const site = await topologySite(auth, input.siteId, write ? 'execute' : 'read');
      if ('error' in site) return site.error;
      const ctx = site.ctx;
      try {
        switch (action) {
          case 'collectors': {
            const parsed = topologyCollectorsQuerySchema.parse(defined({
              recipe: input.recipeId, subjectKind: input.subjectKind, subjectId: input.subjectId,
              graphRevision: input.graphRevision, contextKey: input.contextKey, family: input.family,
            }));
            const items = await selectTopologyOrigins(ctx, createTopologyDiagnosticSchema.parse(defined({
              recipeId: parsed.recipe, recipeVersion: 1, subject: { kind: parsed.subjectKind, id: parsed.subjectId },
              graphRevision: parsed.graphRevision, contextKey: parsed.contextKey, family: parsed.family,
            })));
            return boundedJson({
              items: items.slice(0, 100).map((entry) => ({
                deviceId: entry.origin.deviceId, nodeId: entry.origin.nodeId, contextKey: entry.origin.contextKey,
                eligible: entry.eligible, reasons: entry.reasons, families: entry.families, rank: entry.rank,
              })),
            });
          }
          case 'get': {
            const missing = requireFields(input, ['runId'], action);
            if (missing) return missing;
            return boundedJson(await readTopologyAiDiagnosticRun(ctx, { runId: String(input.runId) }));
          }
          case 'start': {
            const missing = requireFields(input, ['recipeId', 'subjectKind', 'subjectId', 'graphRevision'], action);
            if (missing) return missing;
            const request = planRequest(input);
            const key = typeof input.idempotencyKey === 'string'
              ? input.idempotencyKey
              : `ai-${createHash('sha256').update(JSON.stringify({ u: auth.user.id, s: ctx.scope.siteId, r: request, t: Math.floor(Date.now() / 60_000) })).digest('hex').slice(0, 40)}`;
            const run = await createTopologyDiagnosticRun(ctx, request, key);
            return committedJson({
              runId: run.id, state: run.state, recipeId: (run.plan as { recipeId?: string }).recipeId ?? request.recipeId,
              queuedAt: run.queuedAt, next: 'Read the outcome with action get and this runId.',
            });
          }
          case 'cancel': {
            const missing = requireFields(input, ['runId'], action);
            if (missing) return missing;
            const run = await cancelTopologyDiagnosticRun(ctx, String(input.runId));
            return boundedJson({ runId: run.id, state: run.state });
          }
        }
      } catch (error) {
        return topologyThrown('run_topology_diagnostic', error);
      }
    },
  });
}
