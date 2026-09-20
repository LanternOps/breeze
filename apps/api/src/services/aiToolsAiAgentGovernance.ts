/**
 * AI Agent GOVERNANCE tools (P2-5, #4192).
 *
 * Deliberately NOT named `aiToolsAgentMgmt.ts` — that module is ENDPOINT-agent
 * management (`query_agent_versions` / `trigger_agent_upgrade` /
 * `trigger_agent_restart`, i.e. the Go agent running on a device). This module
 * governs the AUTONOMOUS AI agents: today, granting one a pre-authorized
 * ("supervised") action key at the ORGANIZATION level.
 *
 * `manage_ai_agents` is Tier 3 / four_eyes and HUMAN-ONLY:
 *
 *  - four_eyes because the grant is an authority change, not a device action:
 *    it converts "this agent must ask a human for `<opKey>`" into "this agent
 *    may run `<opKey>` unattended for this org, from now on". Reviewing that
 *    and authorising it are separate responsibilities, so it is registered in
 *    BOTH `TIER3_FOUR_EYES_ACTIONS` and the whole-tool `TIER3_FOUR_EYES_TOOLS`
 *    fail-safe — a future action of this tool defaults to four_eyes rather
 *    than silently landing on the weaker `supervised` scope.
 *  - human-only because an agent that could call it would be able to grant
 *    ITSELF new unattended authority. `checkAgentGuardrails` denies the
 *    `ai_agent` principal outright (see `aiGuardrails.ts`).
 *
 * `orgId` IS an argument, and it is an ADDRESS rather than an authority.
 * It exists for exactly one reason: the effect-digest resolver
 * (`actionIntents/effectDigest.ts`) receives `(args, database)` and nothing
 * else, and both release paths recompute the digest inside
 * `withSystemDbAccessContext`, which carries no ambient org — so without the
 * argument the grant's authority set could not be pinned at all, and an
 * approver would be signing off on a key list free to move underneath them.
 *
 * It is never trusted:
 *
 *  - the creation route sets it from the AUTHENTICATED org, and creation
 *    rejects `args.orgId !== intent.orgId` (Task 15) — so it can only ever
 *    name the org the intent is already tenanted to;
 *  - the executor re-asserts the same equality under the graduation advisory
 *    lock before it writes anything, so a row edited between creation and
 *    release cannot redirect the grant;
 *  - the agent itself is still resolved server-side from (org, kind) — never
 *    named by the model — and `manage_ai_agents` is denied to the `ai_agent`
 *    principal outright, so a model cannot reach this tool at all.
 */

import { AI_AGENT_KINDS, AI_AGENT_RUN_STATUSES, type AiAgentKind, type AiAgentRunStatus } from '@breeze/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { actionIntents, aiAgentRuns, aiAgents, aiToolExecutions, devices } from '../db/schema';
import { listAgents } from './aiAgents/agentService';
import { buildRunTrace } from './aiAgents/runTrace';
import { runSiteScopeCondition } from './aiAgentRunSiteScope';
import { deviceScopeCondition, resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';

import {
  authorizeSupervisedKey,
  SupervisedKeyGrantError,
} from './aiAgents/supervisedKeyGrant';
import type { AiTool, AiToolTier } from './aiTools';
import {
  canMutateOrgWideGovernance,
  SITE_CEILING_WRITE_DENIED_MESSAGE,
} from './siteCeilingAccess';

/**
 * The three structural facts only the DISPATCH site can establish, checked
 * before the executor is reached. Each is a `SupervisedKeyGrantError`, so the
 * catch below renders it exactly like a refusal from the executor itself.
 *
 * `orgId` here is the EXECUTING context's org. On both release paths that is
 * `intent.org_id` verbatim (`buildAuthContextForIntent` builds the release
 * AuthContext with `orgId: intent.orgId`, `scope: 'organization'`,
 * `accessibleOrgIds: [intent.orgId]`), which is what makes comparing the
 * ARGUMENT against it the "`args.orgId !== intent.orgId` is rejected" rule —
 * and the executor re-derives the same comparison from the intent row itself,
 * so neither side is load-bearing alone.
 */
function assertReleaseContext(
  argsOrgId: unknown,
  authOrgId: string | null,
  principalKind: string,
  actionIntentId: string | undefined,
): { orgId: string; intentId: string } {
  if (principalKind === 'ai_agent') {
    throw new SupervisedKeyGrantError(
      'non_human_origin',
      'Supervised keys are never granted on behalf of an AI agent principal',
    );
  }
  if (!actionIntentId) {
    throw new SupervisedKeyGrantError(
      'no_authorizing_intent',
      'This action may only run as the release of an approved four-eyes action intent',
    );
  }
  if (!authOrgId || typeof argsOrgId !== 'string' || argsOrgId !== authOrgId) {
    throw new SupervisedKeyGrantError(
      'org_mismatch',
      'orgId must name the organization this request is authorized for',
    );
  }
  return { orgId: authOrgId, intentId: actionIntentId };
}

export function registerAiAgentGovernanceTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_ai_agents', {
    tier: 1, domain: 'ai', deviceArgs: [],
    searchHint: 'AI agents configured for a partner or customer, enabled state, kind, schedule',
    definition: {
      name: 'list_ai_agents',
      description: 'List accessible AI agents with their name, kind, enabled state and organization or partner ownership.',
      input_schema: {
        type: 'object', properties: {
          includeDisabled: { type: 'boolean', description: 'Include soft-disabled agents (default false)' },
        },
      },
    },
    handler: async (input, auth) => {
      const rows = await listAgents(auth, { includeDisabled: input.includeDisabled === true });
      // AiAgentRow has no profile: profiles belong to individual runs.
      const agents = rows.map(({ id, name, kind, enabled, orgId, partnerId, createdAt }) =>
        ({ id, name, kind, enabled, orgId, partnerId, createdAt }));
      return JSON.stringify({ agents, showing: agents.length });
    },
  });

  aiTools.set('list_ai_agent_runs', {
    tier: 1, domain: 'ai', deviceArgs: [],
    searchHint: 'recent AI agent runs, run status, verdicts, cost by agent or customer',
    definition: {
      name: 'list_ai_agent_runs',
      description: 'List recent AI agent runs with status, verdict, model and cost. Status: queued, running, awaiting_approval, completed, failed, cancelled, expired, skipped.',
      input_schema: {
        type: 'object', properties: {
          agentId: { type: 'string', description: 'Agent UUID' },
          orgId: { type: 'string', description: 'Organization UUID' },
          status: { type: 'string', enum: [...AI_AGENT_RUN_STATUSES], description: 'Run status: queued, running, awaiting_approval, completed, failed, cancelled, expired, skipped' },
          limit: { type: 'number', description: 'Maximum rows (default 25, maximum 50)' },
        },
      },
    },
    handler: async (input, auth) => {
      const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
      if (orgId && !auth.canAccessOrg(orgId)) {
        return JSON.stringify({ error: 'Access to this organization denied' });
      }
      if (auth.allowedSiteIds?.length === 0 || auth.allowedDeviceIds?.length === 0 ||
          (auth.scope === 'partner' && !auth.accessibleOrgIds?.length)) {
        return JSON.stringify({ runs: [], showing: 0 });
      }
      const conditions = [auth.orgCondition(aiAgentRuns.orgId), runSiteScopeCondition(auth), deviceScopeCondition(auth, aiAgentRuns.deviceId)];
      if (typeof input.agentId === 'string') conditions.push(eq(aiAgentRuns.agentId, input.agentId));
      if (typeof input.status === 'string') conditions.push(eq(aiAgentRuns.status, input.status as AiAgentRunStatus));
      if (orgId) conditions.push(eq(aiAgentRuns.orgId, orgId));
      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.min(50, Math.max(1, Math.floor(input.limit))) : 25;
      const runs = await db.select({
        id: aiAgentRuns.id, agentId: aiAgentRuns.agentId, orgId: aiAgentRuns.orgId,
        status: aiAgentRuns.status, profile: aiAgentRuns.profile,
        startedAt: aiAgentRuns.startedAt, finishedAt: aiAgentRuns.finishedAt,
        resolvedModel: aiAgentRuns.resolvedModel, costCents: aiAgentRuns.costCents,
        runVerdict: sql<string | null>`${aiAgentRuns.outcome}->>'runVerdict'`,
      }).from(aiAgentRuns).where(and(...conditions)).orderBy(desc(aiAgentRuns.startedAt)).limit(limit);
      return JSON.stringify({ runs, showing: runs.length });
    },
  });

  aiTools.set('get_ai_agent_run', {
    tier: 1, domain: 'ai', deviceArgs: [],
    searchHint: 'one AI agent run: trace, findings, tool calls, outcome summary',
    definition: {
      name: 'get_ai_agent_run',
      description: 'Get an accessible AI agent run with a safe trace, findings, tool execution ledger and action intent summaries.',
      input_schema: {
        type: 'object', properties: { runId: { type: 'string', description: 'Run UUID' } }, required: ['runId'],
      },
    },
    handler: async (input, auth) => {
      const id = z.string().guid().safeParse(input.runId);
      if (!id.success || auth.allowedSiteIds?.length === 0 || auth.allowedDeviceIds?.length === 0 ||
          (auth.scope === 'partner' && !auth.accessibleOrgIds?.length)) {
        return JSON.stringify({ error: 'Run not found' });
      }
      // Raw outcome is consumed ONLY by buildRunTrace, never serialized directly.
      const [run] = await db.select({
        id: aiAgentRuns.id, agentId: aiAgentRuns.agentId, orgId: aiAgentRuns.orgId,
        deviceId: aiAgentRuns.deviceId, alertId: aiAgentRuns.alertId,
        anomalyIncidentId: aiAgentRuns.anomalyIncidentId, sessionId: aiAgentRuns.sessionId,
        triggerKind: aiAgentRuns.triggerKind, modeAtStart: aiAgentRuns.modeAtStart,
        status: aiAgentRuns.status, summary: aiAgentRuns.summary,
        scheduleId: aiAgentRuns.scheduleId, triggerRef: aiAgentRuns.triggerRef,
        reportRunId: aiAgentRuns.reportRunId, computeCents: aiAgentRuns.computeCents,
        outcome: aiAgentRuns.outcome, intentIds: aiAgentRuns.intentIds,
        turnCount: aiAgentRuns.turnCount, costCents: aiAgentRuns.costCents,
        errorCode: aiAgentRuns.errorCode, queuedAt: aiAgentRuns.queuedAt,
        startedAt: aiAgentRuns.startedAt, finishedAt: aiAgentRuns.finishedAt,
        agentName: aiAgents.name, agentKind: aiAgents.kind, deviceHostname: devices.hostname,
      }).from(aiAgentRuns)
        .leftJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
        .leftJoin(devices, eq(aiAgentRuns.deviceId, devices.id))
        .where(and(eq(aiAgentRuns.id, id.data), auth.orgCondition(aiAgentRuns.orgId), runSiteScopeCondition(auth), deviceScopeCondition(auth, aiAgentRuns.deviceId)))
        .limit(1);
      if (!run) return JSON.stringify({ error: 'Run not found' });
      const ledgerRows = run.sessionId ? await db.select({
        toolName: aiToolExecutions.toolName, status: aiToolExecutions.status,
        durationMs: aiToolExecutions.durationMs, createdAt: aiToolExecutions.createdAt,
        completedAt: aiToolExecutions.completedAt, errorMessage: aiToolExecutions.errorMessage,
      }).from(aiToolExecutions).where(eq(aiToolExecutions.sessionId, run.sessionId))
        .orderBy(asc(aiToolExecutions.createdAt)) : [];
      // The run and an intent can target different devices. Resolve both axes
      // inside the run's org before reading its intent summaries.
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(run.orgId, auth);
      const intents = await db.select({
        id: actionIntents.id, status: actionIntents.status, actionName: actionIntents.actionName,
        approvalScope: actionIntents.approvalScope, decidedVia: actionIntents.decidedVia,
      }).from(actionIntents).where(and(
        eq(actionIntents.requestingAgentRunId, run.id), eq(actionIntents.orgId, run.orgId),
        auth.orgCondition(actionIntents.orgId),
        allowedDeviceIds === null ? undefined : inArray(actionIntents.scopeDeviceId, allowedDeviceIds),
      ));
      const agent = run.agentName !== null && run.agentKind !== null
        ? { name: run.agentName, kind: run.agentKind } : null;
      return JSON.stringify({ trace: buildRunTrace(
        run, agent, run.deviceHostname ? { hostname: run.deviceHostname } : null, ledgerRows, intents,
      ) });
    },
  });

  aiTools.set('manage_ai_agents', {
    tier: 3 as AiToolTier,
    domain: 'ai',
    searchHint: 'autonomous AI agent governance: authorize a supervised action key with a second approver',
    deviceArgs: [],
    definition: {
      name: 'manage_ai_agents',
      description:
        'Govern the autonomous AI agents for the current organization. Action: authorize_supervised_key — grant the ' +
        'organization\'s agent of the given kind a pre-authorized action key (`opKey`, e.g. "manage_services:restart") ' +
        'so future runs may execute it without raising an approval. The key must already be inside the partner ' +
        'baseline ceiling and the agent must have earned it on recent evidence. Requires a SECOND approver (four-eyes) ' +
        'and is never available to an AI agent itself. `orgId` must be the CURRENT organization — a request naming any ' +
        'other organization is rejected outright, both when the approval is raised and again before it executes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['authorize_supervised_key'],
          },
          kind: {
            type: 'string',
            enum: [...AI_AGENT_KINDS],
            description: 'Which agent to grant the key to (triage, patch, helpdesk)',
          },
          opKey: {
            type: 'string',
            description: 'The tool:action key to pre-authorize, e.g. "manage_services:restart"',
          },
          orgId: {
            type: 'string',
            description:
              'The CURRENT organization\'s id. Not a target selector — it must equal the organization the request is ' +
              'already authenticated for, and any other value is rejected. It is required because the approval pins ' +
              'that organization\'s authorized-key list, so a change during the approval window fails the release.',
          },
        },
        required: ['action', 'kind', 'opKey', 'orgId'],
      },
    },
    /**
     * The grant itself lives in `services/aiAgents/supervisedKeyGrant.ts`;
     * this is only the dispatch seam.
     *
     * A refusal is RETURNED, not thrown: `isReturnedToolError`
     * (jobs/intentReleaseWorker.ts) treats a parsed object carrying `error`
     * and no `success`/`data`/`configured` key as a FAILED release, so the
     * intent terminalizes `failed:tool_returned_error` with the reason
     * recorded — a thrown error would land as the opaque `execution_error`,
     * and a plain success shape would record a grant that never happened.
     * (`googleHelpers.errorString` is deliberately NOT used — it belongs to
     * the Google/M365 tool families.)
     */
    handler: async (input, auth, context) => {
      try {
        const { orgId, intentId } = assertReleaseContext(
          input.orgId,
          auth.orgId,
          auth.principal?.kind ?? 'unknown',
          context?.actionIntentId,
        );
        // SITE CEILING (audit §1.1). The grant converts "ask a human" into
        // "run unattended for this ORG", fanning out across every site — there
        // is nothing to narrow for a caller who holds only part of the org, so
        // a site or exact-device ceiling fails closed exactly as it does for
        // every other org-wide governance object. Enforced here rather than in
        // `assertReleaseContext` so it applies to the caller's context on BOTH
        // paths: the chat raise, and the release, which re-runs this handler
        // under the requester's LIVE site restriction
        // (`buildAuthContextForIntent`, actionIntents/actorContext.ts).
        // Returned, not thrown, for the same reason every other refusal here
        // is: `isReturnedToolError` must see `{error}` to terminalize the
        // intent as `failed:tool_returned_error`.
        if (!canMutateOrgWideGovernance(auth)) {
          return JSON.stringify({
            error: 'site_ceiling',
            message: SITE_CEILING_WRITE_DENIED_MESSAGE,
          });
        }
        const result = await authorizeSupervisedKey({
          orgId,
          kind: input.kind as AiAgentKind,
          opKey: String(input.opKey),
          intentId,
          actorUserId: auth.user.id,
        });
        return JSON.stringify({
          success: true,
          data: {
            agentId: result.agentId,
            orgAgentId: result.orgAgentId,
            supervisedActionKeys: result.keys,
          },
        });
      } catch (err) {
        if (err instanceof SupervisedKeyGrantError) {
          return JSON.stringify({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  });
}
