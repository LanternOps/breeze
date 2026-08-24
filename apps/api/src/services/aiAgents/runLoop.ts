/**
 * The headless agent run loop (AI agents wave 3c, Task 4).
 *
 * This is the only place a Breeze AI agent actually thinks. It drives the
 * Claude Agent SDK's `query()` directly — deliberately NOT through
 * `streamingSessionManager`, which is the SSE/browser session state machine
 * (input controllers, partial-message streaming, resume) and serves nothing a
 * headless run needs. What genuinely IS shared is shared: the same in-process
 * MCP tool server (`createBreezeMcpServer`), the same guardrail machinery, the
 * same child-env builder.
 *
 * ## Where authority comes from
 *
 * Tool authority on this path is STRUCTURAL and comes from exactly one call:
 * `checkAgentGuardrails(toolName, input, policy)`, where `policy` is derived
 * from the run's IMMUTABLE `policy_snapshot` — not from the agent's current
 * row, and never from tool input. `checkToolPermission` is never called: an
 * agent has no user role to authorize against, and the RBAC helpers fail OPEN
 * for a token-less principal. Nothing the model reads — operator instructions,
 * a file on a device, an alert body — can reach that call: prose is not a
 * parameter of it. See `runnerPrompt.ts` for the prompt-side half.
 *
 * ## Why this module is not in `jobs/aiAgentRunner.ts`
 *
 * Deliberate deviation from the plan's file list. `jobs/aiAgentRunner.ts` owns
 * BullMQ durability; putting the loop there would (a) push that file past 600
 * lines mixing two concerns, and (b) force every service-level test of the
 * hooks — the red-team contract suite most of all — to drag BullMQ and Redis
 * into its module graph just to reach a pure function. `executeAgentRun` is
 * still re-exported from `jobs/aiAgentRunner.ts`, so the queue processor's
 * contract is unchanged.
 *
 * ## DB context
 *
 * The BullMQ processor holds NO ambient DB context on purpose (a run can last
 * the full 600s wall-clock ceiling; holding a pooled connection
 * idle-in-transaction for that long is the #1105 pool-exhaustion shape). Every
 * DB touch here self-contexts, and the SDK loop itself runs under
 * `runOutsideDbContext` so the SDK's tool handlers never inherit one.
 */
import { eq } from 'drizzle-orm';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AiAgentKind,
  AiAgentMode,
  AiAgentPolicy,
  AiAgentPolicySnapshot,
  AiAgentRecipients,
  AiAgentTriggerKind,
} from '@breeze/shared';
import { envFlag } from '../../config/env';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — see the same note in runService.
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { alerts } from '../../db/schema/alerts';
import { devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { createActionIntent } from '../actionIntents/intentService';
import { BREEZE_MCP_TOOL_NAMES, createBreezeMcpServer } from '../aiAgentSdkTools';
import type { PostToolUseCallback, PreToolUseCallback } from '../aiAgentSdkTools';
import { calculateCostCents, recordUsage } from '../aiCostTracker';
import type { AiBillingSource } from '../aiCostTracker';
import {
  checkAgentGuardrails,
  TOOL_ACTION_INPUT_KEYS,
  type AgentGuardrailPolicy,
} from '../aiGuardrails';
import { publishEvent } from '../eventBus';
import { resolveLlmConfigForOrg } from '../llm/llmConfigResolver';
import type { UsableLlmConfig } from '../llm/llmConfigResolver';
import { buildClaudeSdkChildEnv } from '../streamingSessionManager';
import { createNotification } from '../userNotifications';
import type { AuthContext } from '../../middleware/auth';
import { AgentRunOwnershipError, buildAgentAuthContext } from './agentAuthContext';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import { resolveRecipientUserIds } from './recipients';
import { transitionRunStatus } from './runService';
import {
  buildAgentRunSystemPrompt,
  buildAgentRunTaskPrompt,
  type AgentRunPromptContext,
} from './runnerPrompt';

/** `ai_agent_runs.summary` is `text`, but a reviewer reads the first screen. */
const RUN_SUMMARY_MAX_CHARS = 2000;

/**
 * What the model gets back when a mutation is intercepted. Worded as SUCCESS on
 * purpose: a model that reads "denied" here retries with different arguments or
 * hunts for another tool that does the same thing, which is exactly the
 * behaviour shadow mode exists to avoid.
 */
export const PROPOSAL_RECORDED_TEXT =
  'Recorded as a proposal (shadow mode) — this is the expected outcome, not an error. '
  + 'A human will review it. Do not retry this call and do not look for another way to '
  + 'perform it.';

export interface OutcomeProposedAction {
  tool: string;
  action?: string;
  args: Record<string, unknown>;
  /** Set for Tier-3 proposals that reached `action_intents`. */
  intentId?: string;
  /** Set instead when the intent could not be created (e.g. no eligible approvers). */
  intentError?: string;
}

export interface OutcomeExecutedAction {
  tool: string;
  action?: string;
  /**
   * '(inline)' for wave 3: an agent tool call executes inside the MCP handler
   * and has no `ai_tool_executions` row of its own yet (that ledger is written
   * by the chat session path). Wave 6's transcript work gives these real ids.
   */
  executionId: string;
  result: 'ok' | 'failed';
  durationMs: number;
}

export interface AgentRunOutcome {
  /**
   * Reserved for structured findings. Nothing populates it in wave 3 — the
   * narrative lives in `run.summary` and the transcript work that would produce
   * structured findings is wave 6. Kept as a declared key so the shape of the
   * jsonb does not change under reviewers when it lands.
   */
  findings: unknown[];
  proposedActions: OutcomeProposedAction[];
  executedActions: OutcomeExecutedAction[];
  deniedActions: Array<{ tool: string; reason: string }>;
  /** Tool calls that actually EXECUTED (denials and proposals excluded). */
  toolExecutionCount: number;
  budgetExceeded?: boolean;
  wallClockExceeded?: boolean;
}

/** Error carrying the short code that lands in `ai_agent_runs.error_code` (varchar(64)). */
export class AgentRunError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'AgentRunError';
    this.errorCode = errorCode;
  }
}

interface RunRow {
  id: string;
  agentId: string;
  orgId: string;
  deviceId: string | null;
  alertId: string | null;
  status: string;
  modeAtStart: Exclude<AiAgentMode, 'off'>;
  triggerKind: AiAgentTriggerKind;
  policySnapshot: AiAgentPolicySnapshot;
}

interface AgentRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  kind: AiAgentKind;
  recipients: Partial<AiAgentRecipients>;
}

interface RunContext {
  run: RunRow;
  agent: AgentRow;
  orgPartnerId: string;
  device: { id: string; siteId: string; hostname: string; osType: string } | null;
  alert: { title: string; severity: string; message: string | null } | null;
}

/**
 * Same skip-if-already-system shape as `runService.inSystemDbContext`: a bare
 * system wrapper is a no-op inside an ambient request context (so exit first),
 * and re-entering from an already-system context would take a SECOND pooled
 * connection while the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** Observability must never turn a finished run into a failed one. */
async function safePublish(
  type: Parameters<typeof publishEvent>[0],
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, 'ai-agent-runner');
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to publish run event', { type, orgId, error });
  }
}

async function loadRunContext(runId: string): Promise<RunContext | null> {
  return inSystemDbContext(async () => {
    const [run] = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        orgId: aiAgentRuns.orgId,
        deviceId: aiAgentRuns.deviceId,
        alertId: aiAgentRuns.alertId,
        status: aiAgentRuns.status,
        modeAtStart: aiAgentRuns.modeAtStart,
        triggerKind: aiAgentRuns.triggerKind,
        policySnapshot: aiAgentRuns.policySnapshot,
      })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, runId))
      .limit(1);
    if (!run) return null;

    const [agent] = await db
      .select({
        id: aiAgents.id,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        name: aiAgents.name,
        kind: aiAgents.kind,
        recipients: aiAgents.recipients,
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    if (!agent) return null;

    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, run.orgId))
      .limit(1);
    if (!org?.partnerId) return null;

    // The device's CURRENT site, always read here and never taken from tool
    // input: it is what bounds the agent's blast radius (spec §3.2), and a run
    // admitted before a device moved sites must follow the device.
    let device: RunContext['device'] = null;
    if (run.deviceId) {
      const [row] = await db
        .select({
          id: devices.id,
          siteId: devices.siteId,
          hostname: devices.hostname,
          osType: devices.osType,
        })
        .from(devices)
        .where(eq(devices.id, run.deviceId))
        .limit(1);
      device = row ?? null;
    }

    let alert: RunContext['alert'] = null;
    if (run.alertId) {
      const [row] = await db
        .select({ title: alerts.title, severity: alerts.severity, message: alerts.message })
        .from(alerts)
        .where(eq(alerts.id, run.alertId))
        .limit(1);
      alert = row ?? null;
    }

    return { run: run as RunRow, agent: agent as AgentRow, orgPartnerId: org.partnerId, device, alert };
  });
}

function readToolAction(toolName: string, input: Record<string, unknown>): string | undefined {
  const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The pre-tool-use hook: 3b's tri-state guardrail is the ONLY authority.
 *
 * Exported so the red-team contract suite can drive it directly and assert that
 * no RBAC helper is ever reached from an agent run.
 */
export function createAgentRunPreToolUse(args: {
  run: Pick<RunRow, 'id' | 'orgId'>;
  agentName: string;
  agentAuth: AuthContext;
  guardrailPolicy: AgentGuardrailPolicy;
  outcome: AgentRunOutcome;
  intentIds: string[];
  /** Per-tool count of calls the gate ALLOWED, consumed by the post hook. */
  allowedPending: Map<string, number>;
}): PreToolUseCallback {
  const { run, agentName, agentAuth, guardrailPolicy, outcome, intentIds, allowedPending } = args;

  return async (toolName, input) => {
    const check = checkAgentGuardrails(toolName, input, guardrailPolicy);

    if (check.disposition === 'deny') {
      const reason = check.reason ?? 'Denied by agent guardrails';
      outcome.deniedActions.push({ tool: toolName, reason });
      return { allowed: false, error: reason };
    }

    if (check.disposition === 'propose') {
      const action = readToolAction(toolName, input);
      const entry: OutcomeProposedAction = {
        tool: toolName,
        ...(action ? { action } : {}),
        args: input,
      };

      // Tier gate, not a shortcut: createActionIntent throws
      // ActionIntentTierError('tool_not_tier3') for anything tier <= 2, so a
      // runner that funnelled every mutation through it would turn ordinary
      // Tier-2 proposals into errors. Tier 2 proposals are recorded and stop
      // there — there is no approval object for them.
      let intentError: string | undefined;
      if (check.tier === 3) {
        try {
          const intent = await createActionIntent(agentAuth, {
            toolName,
            input,
            source: 'ai_agent',
            orgId: run.orgId,
            reason: `Proposed by ${agentName} for run ${run.id}`,
          });
          entry.intentId = intent.id;
          intentIds.push(intent.id);
        } catch (error) {
          // no_eligible_approvers, agent_policy_denied, … The PROPOSAL is still
          // recorded — a reviewer needs to see what the agent wanted to do even
          // when no approval will ever arrive — and the model is told why.
          intentError = error instanceof Error ? error.message : String(error);
          entry.intentError = intentError;
          console.warn('[aiAgentRunLoop] proposal could not be submitted for approval', {
            runId: run.id, toolName, error,
          });
        }
      }

      outcome.proposedActions.push(entry);
      return {
        allowed: false,
        error: intentError
          ? `Proposal recorded but not submitted for approval: ${intentError}. Do not retry.`
          : PROPOSAL_RECORDED_TEXT,
      };
    }

    allowedPending.set(toolName, (allowedPending.get(toolName) ?? 0) + 1);
    return { allowed: true };
  };
}

/**
 * The post-tool-use hook. `makeHandler` fires postToolUse for REFUSED calls too
 * (with `isError: true`), so the counter written by the pre hook is what
 * separates a real execution from the echo of a denial or a proposal — without
 * it every denial would be recorded as a failed execution.
 */
export function createAgentRunPostToolUse(args: {
  outcome: AgentRunOutcome;
  allowedPending: Map<string, number>;
}): PostToolUseCallback {
  const { outcome, allowedPending } = args;

  return async (toolName, input, _output, isError, durationMs) => {
    const remaining = allowedPending.get(toolName) ?? 0;
    if (remaining <= 0) return;
    allowedPending.set(toolName, remaining - 1);

    const action = readToolAction(toolName, input);
    outcome.executedActions.push({
      tool: toolName,
      ...(action ? { action } : {}),
      executionId: '(inline)',
      result: isError ? 'failed' : 'ok',
      durationMs,
    });
    outcome.toolExecutionCount += 1;
  };
}

interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Same precedence as `recordUsageFromSdkResult`: trust the SDK's self-reported
 * cost, and price the tokens ourselves only when it reports zero against a
 * non-zero token count (issue #1326 — the SDK cannot price a model id newer
 * than its bundled table).
 */
function resultCostCents(
  totalCostUsd: number,
  usage: SdkUsage,
  model: string | undefined,
): number {
  const reported = Math.round(totalCostUsd * 100 * 100) / 100;
  if (reported > 0) return reported;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const anyTokens = usage.input_tokens > 0 || usage.output_tokens > 0 || cacheRead > 0 || cacheWrite > 0;
  if (!anyTokens || !model) return 0;
  return calculateCostCents(model, usage.input_tokens, usage.output_tokens, cacheRead, cacheWrite);
}

function extractAssistantText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function promptContext(ctx: RunContext, effective: AiAgentPolicy): AgentRunPromptContext {
  return {
    agent: { name: ctx.agent.name, kind: ctx.agent.kind },
    run: { id: ctx.run.id, mode: ctx.run.modeAtStart, triggerKind: ctx.run.triggerKind },
    device: ctx.device
      ? { id: ctx.device.id, hostname: ctx.device.hostname, osType: ctx.device.osType }
      : null,
    alert: ctx.alert,
    instructions: effective.instructions,
  };
}

async function notifyRunFinished(
  ctx: RunContext,
  finished: { status: string; summary: string; intentIds: string[] },
): Promise<void> {
  try {
    const userIds = await resolveRecipientUserIds(
      { orgId: ctx.agent.orgId, partnerId: ctx.agent.partnerId, recipients: ctx.agent.recipients },
      ctx.run.orgId,
    );
    if (userIds.length === 0) return;

    const firstLine = finished.summary.split('\n')[0]?.trim() ?? '';
    // AFTER the status commit and outside any held transaction (#1105).
    await inSystemDbContext(async () => {
      for (const userId of userIds) {
        await createNotification({
          userId,
          orgId: ctx.run.orgId,
          type: 'ai',
          title: 'Agent run finished',
          message: `${ctx.agent.name}: ${firstLine || finished.status}`,
          // There is no run-detail page until wave 6; link to the approvals
          // queue only when there is actually something waiting there.
          link: finished.intentIds.length > 0 ? '/approvals' : null,
          metadata: {
            runId: ctx.run.id,
            agentId: ctx.agent.id,
            intentIds: finished.intentIds,
            status: finished.status,
          },
          dedupeKey: `agent-run:${ctx.run.id}`,
        });
      }
    });
  } catch (error) {
    // A notification failure must never redefine the run's outcome.
    console.error('[aiAgentRunLoop] failed to notify run recipients', {
      runId: ctx.run.id, error,
    });
  }
}

interface LoopResult {
  summary: string;
  costCents: number;
  turnCount: number;
  outcome: AgentRunOutcome;
  intentIds: string[];
  /**
   * Set when the SDK loop itself threw. Carried back rather than rethrown so
   * the tokens already burned still land on the run row — a crashed run that
   * recorded `cost_cents: 0` would make the agent's daily budget cap
   * under-count real spend. Setup failures BEFORE any spend still throw.
   */
  failure?: { errorCode: string; message: string };
}

async function driveSdkLoop(ctx: RunContext, effective: AiAgentPolicy): Promise<LoopResult> {
  const { run } = ctx;
  const limits = effective.limits;

  const llm = await resolveLlmConfigForOrg(run.orgId);
  if (llm.source === 'unavailable') {
    throw new AgentRunError('llm_unavailable', `AI is unavailable for org ${run.orgId}`);
  }
  const usableLlm: UsableLlmConfig = llm;
  const billingSource: AiBillingSource = llm.source === 'partner' ? 'partner_key' : 'platform';
  const model = effective.model ?? llm.model;

  // THE run's policy, not the agent's current one: `mode_at_start` and the
  // release-time revalidation in 3b both reason about this snapshot, and an
  // operator narrowing the allowlist mid-run must not change what a proposal
  // already recorded means. The current-policy stop-gate ran before this.
  const guardrailPolicy: AgentGuardrailPolicy = {
    enabled: effective.enabled,
    mode: run.modeAtStart,
    toolAllowlist: effective.toolAllowlist,
    protectedResources: effective.protectedResources,
    deviceId: run.deviceId,
    deviceSiteId: ctx.device?.siteId ?? null,
  };

  // Throws AgentRunOwnershipError if the agent does not own this org.
  const agentAuth = buildAgentAuthContext(
    {
      id: ctx.agent.id,
      orgId: ctx.agent.orgId,
      partnerId: ctx.agent.partnerId,
      name: ctx.agent.name,
      kind: ctx.agent.kind,
    },
    {
      id: run.id,
      orgId: run.orgId,
      deviceId: run.deviceId,
      deviceSiteId: ctx.device?.siteId ?? null,
    },
    { id: run.orgId, partnerId: ctx.orgPartnerId },
  );

  const outcome: AgentRunOutcome = {
    findings: [],
    proposedActions: [],
    executedActions: [],
    deniedActions: [],
    toolExecutionCount: 0,
  };
  const intentIds: string[] = [];
  const allowedPending = new Map<string, number>();

  const preToolUse = createAgentRunPreToolUse({
    run, agentName: ctx.agent.name, agentAuth, guardrailPolicy, outcome, intentIds, allowedPending,
  });
  const postToolUse = createAgentRunPostToolUse({ outcome, allowedPending });

  // No getActiveSession: a headless run has no ActiveSession, and the
  // session-aware tools (M365/Google) correctly refuse without one.
  const mcpServer = createBreezeMcpServer(() => agentAuth, preToolUse, postToolUse);

  const prompt = promptContext(ctx, effective);
  const abortController = new AbortController();
  let wallClockExceeded = false;
  let budgetExceeded = false;
  const wallClockMs = Math.max(1, Math.round(limits.wallClockSeconds * 1000));
  const wallClockTimer = setTimeout(() => {
    wallClockExceeded = true;
    abortController.abort();
  }, wallClockMs);
  // The run's own status row is the durable record; never hold the event loop.
  wallClockTimer.unref?.();

  let summary = '';
  let failure: LoopResult['failure'];
  let costCents = 0;
  let turnCount = 0;
  const usage: SdkUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  try {
    await runOutsideDbContext(async () => {
      const sdkQuery = query({
        prompt: buildAgentRunTaskPrompt(prompt),
        options: {
          systemPrompt: buildAgentRunSystemPrompt(prompt),
          model,
          maxTurns: Math.max(1, limits.maxTurnsPerRun),
          // Belt to the mid-stream braces below: the SDK stops itself, and the
          // loop stops the SDK if a result lands over budget anyway.
          maxBudgetUsd: limits.maxBudgetCentsPerRun / 100,
          tools: [],
          allowedTools: BREEZE_MCP_TOOL_NAMES,
          mcpServers: { breeze: mcpServer },
          abortController,
          env: buildClaudeSdkChildEnv(usableLlm),
          // No transcript persistence in wave 3 — `run.session_id` stays NULL
          // and `summary`/`outcome` carry what a reviewer needs (wave 6).
          persistSession: false,
          settingSources: [],
          thinking: { type: 'disabled' },
        },
      });

      try {
        for await (const message of sdkQuery) {
          if (message.type === 'assistant') {
            const text = extractAssistantText(message);
            if (text) summary = text;
            continue;
          }
          if (message.type !== 'result') continue;

          turnCount += message.num_turns;
          const messageUsage = message.usage as unknown as SdkUsage;
          usage.input_tokens += messageUsage.input_tokens ?? 0;
          usage.output_tokens += messageUsage.output_tokens ?? 0;
          usage.cache_read_input_tokens =
            (usage.cache_read_input_tokens ?? 0) + (messageUsage.cache_read_input_tokens ?? 0);
          usage.cache_creation_input_tokens =
            (usage.cache_creation_input_tokens ?? 0) + (messageUsage.cache_creation_input_tokens ?? 0);
          costCents += resultCostCents(message.total_cost_usd, messageUsage, model);

          if (message.subtype === 'success' && typeof message.result === 'string' && message.result.trim()) {
            summary = message.result.trim();
          }

          if (costCents > limits.maxBudgetCentsPerRun) {
            budgetExceeded = true;
            abortController.abort();
            break;
          }
        }
      } finally {
        // Order matters: abort (if any) has already happened, and killing the
        // subprocess before aborting crashes the process.
        try {
          sdkQuery.close();
        } catch (error) {
          console.warn('[aiAgentRunLoop] SDK query close failed (non-fatal)', { runId: run.id, error });
        }
      }
    });
  } catch (error) {
    // An abort we asked for is a controlled stop, not a crash.
    if (wallClockExceeded || budgetExceeded) {
      console.warn('[aiAgentRunLoop] SDK loop aborted', {
        runId: run.id, wallClockExceeded, budgetExceeded,
      });
    } else {
      console.error('[aiAgentRunLoop] SDK loop failed', { runId: run.id, error });
      failure = {
        errorCode: 'sdk_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    clearTimeout(wallClockTimer);
  }

  if (wallClockExceeded) outcome.wallClockExceeded = true;
  if (budgetExceeded) outcome.budgetExceeded = true;

  // Org-level AI spend rollup, so `checkBudget` at admission is not blind to
  // agent traffic. Priced by the shared sessionless helper from plain token
  // counts; the run row carries the SDK's authoritative figure. Unifying the two
  // needs `recordUsageFromSdkResult`, which requires an `ai_sessions` row the
  // run does not have until wave 6. Best-effort: never fails the run.
  if (usage.input_tokens > 0 || usage.output_tokens > 0) {
    try {
      await recordUsage(
        null, run.orgId, model, usage.input_tokens, usage.output_tokens, false, billingSource,
      );
    } catch (error) {
      console.error('[aiAgentRunLoop] failed to record org AI usage', { runId: run.id, error });
    }
  }

  return {
    summary: summary.slice(0, RUN_SUMMARY_MAX_CHARS),
    costCents: Math.round(costCents),
    turnCount,
    outcome,
    intentIds,
    ...(failure ? { failure } : {}),
  };
}

/**
 * Execute one agent run. The BullMQ processor's only job.
 *
 * Never throws for an expected failure — the run row's terminal status IS the
 * report, and there are no retries (a crashed run may already have invoked
 * tools; replaying it would re-invoke them with no human in the loop).
 */
export async function executeAgentRun(runId: string): Promise<void> {
  const ctx = await loadRunContext(runId);
  if (!ctx) {
    // Missing run/agent/org row. Nothing to transition, nothing to report to.
    console.error('[aiAgentRunLoop] agent run context could not be loaded', { runId });
    return;
  }
  const { run, agent } = ctx;

  // 1. Compare-and-set out of `queued`. `enqueueAgentRunJob` removes a terminal
  //    leftover job and re-adds under the same id, so a re-triggered run id can
  //    be delivered twice; losing this CAS means another executor owns the run.
  const started = await transitionRunStatus(runId, 'queued', 'running', { startedAt: new Date() });
  if (!started) {
    console.info('[aiAgentRunLoop] run was not queued — duplicate delivery ignored', { runId });
    return;
  }
  await safePublish('ai.agent.run.started', run.orgId, {
    runId, agentId: run.agentId, deviceId: run.deviceId,
  });

  // 2. Stop-gate. The queue can deliver minutes after admission, and the kill
  //    switch or the operator's policy may have changed since. This decides
  //    only WHETHER to start — the loop itself runs on the run's immutable
  //    snapshot (see driveSdkLoop).
  const stopped = await isStoppedBeforeStart(run.orgId, agent.kind);
  if (stopped) {
    await transitionRunStatus(runId, 'running', 'skipped', {
      errorCode: 'policy_revoked_before_start',
      finishedAt: new Date(),
    });
    await safePublish('ai.agent.run.skipped', run.orgId, {
      runId, agentId: run.agentId, reason: 'policy_revoked_before_start',
    });
    return;
  }

  const effective = run.policySnapshot.effective;

  try {
    const result = await driveSdkLoop(ctx, effective);
    const { outcome, intentIds } = result;

    // The loop threw after spending: record what it cost and what it managed to
    // do, then fail. `finishRun` writes cost/turns/outcome on every terminal
    // status, which the bare `failed` transition in the catch below cannot.
    if (result.failure) {
      await finishRun(ctx, 'failed', result.failure.errorCode, result);
      return;
    }

    // A run that hit a ceiling before producing anything a human can act on is
    // a FAILURE, not a quiet success: the reviewer needs to know the agent was
    // cut off, not that it found nothing. A run that was cut off after doing
    // useful work finishes normally, with the flag in `outcome`.
    const producedSomething =
      outcome.executedActions.length > 0
      || outcome.proposedActions.length > 0
      || result.summary.trim().length > 0;

    if (!producedSomething && (outcome.wallClockExceeded || outcome.budgetExceeded)) {
      const errorCode = outcome.wallClockExceeded ? 'wall_clock_exceeded' : 'budget_exceeded';
      await finishRun(ctx, 'failed', errorCode, result);
      return;
    }

    // Awaiting approval is a REAL terminal-ish state for the run: the agent is
    // done thinking and a human now owns the decision. Release of an approved
    // intent is 3b's machinery, not a continuation of this run.
    await finishRun(ctx, intentIds.length > 0 ? 'awaiting_approval' : 'completed', null, result);
  } catch (error) {
    const errorCode = error instanceof AgentRunError
      ? error.errorCode
      : error instanceof AgentRunOwnershipError
        ? 'ownership_mismatch'
        : 'run_failed';
    console.error('[aiAgentRunLoop] agent run failed', { runId, errorCode, error });
    const moved = await transitionRunStatus(runId, 'running', 'failed', {
      errorCode,
      finishedAt: new Date(),
    });
    if (moved) {
      await safePublish('ai.agent.run.failed', run.orgId, {
        runId, agentId: run.agentId, errorCode,
      });
    }
  }
}

const TERMINAL_EVENT = {
  completed: 'ai.agent.run.completed',
  awaiting_approval: 'ai.agent.run.awaiting_approval',
  failed: 'ai.agent.run.failed',
} as const;

async function finishRun(
  ctx: RunContext,
  status: keyof typeof TERMINAL_EVENT,
  errorCode: string | null,
  result: LoopResult,
): Promise<void> {
  const moved = await transitionRunStatus(ctx.run.id, 'running', status, {
    summary: result.summary || null,
    outcome: result.outcome as unknown as Record<string, unknown>,
    intentIds: result.intentIds,
    turnCount: result.turnCount,
    costCents: result.costCents,
    ...(errorCode ? { errorCode } : {}),
    finishedAt: new Date(),
  });
  if (!moved) {
    // Someone cancelled the run (or a second executor got there first) while
    // the loop was running. Do not keep writing to it.
    console.warn('[aiAgentRunLoop] run left `running` before it could be finished', {
      runId: ctx.run.id, status,
    });
    return;
  }

  await safePublish(TERMINAL_EVENT[status], ctx.run.orgId, {
    runId: ctx.run.id,
    agentId: ctx.run.agentId,
    deviceId: ctx.run.deviceId,
    intentIds: result.intentIds,
    costCents: result.costCents,
    ...(errorCode ? { errorCode } : {}),
  });

  await notifyRunFinished(ctx, {
    status,
    summary: result.summary,
    intentIds: result.intentIds,
  });
}

/** Kill switch + current effective policy. True means "do not start". */
async function isStoppedBeforeStart(orgId: string, kind: AiAgentKind): Promise<boolean> {
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return true;
  try {
    const current = await resolveEffectiveAgentSystem(orgId, kind);
    if (!current) return true;
    return !current.effective.enabled || current.effective.mode === 'off';
  } catch (error) {
    console.error('[aiAgentRunLoop] could not re-resolve the effective policy', { orgId, kind, error });
    return true;
  }
}
