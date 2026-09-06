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
import { and, eq } from 'drizzle-orm';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRunVerdict,
  AiAgentKind,
  AiAgentPolicy,
  AiAgentRunProfile,
  AiSweepKind,
} from '@breeze/shared';
import { AI_SWEEP_KINDS } from '@breeze/shared';
import { envFlag } from '../../config/env';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — see the same note in runService.
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { alertCorrelationGroups, alerts } from '../../db/schema/alerts';
import { devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { createActionIntent } from '../actionIntents/intentService';
import { BREEZE_MCP_TOOL_NAMES, createBreezeMcpServer } from '../aiAgentSdkTools';
import type { PostToolUseCallback, PreToolUseCallback } from '../aiAgentSdkTools';
import { calculateCostCents, recordSessionlessSdkUsage } from '../aiCostTracker';
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
import type { ToolExecutionContext } from '../toolExecutionContext';
import type { AuthContext } from '../../middleware/auth';
import { AgentRunOwnershipError, buildAgentAuthContext } from './agentAuthContext';
import { resolveActOperation, type ActTarget } from './actManifest';
import {
  revalidateActExecution,
  type ActAssetPin,
  type ActReservationState,
} from './actRevalidation';
import { actTargetSummary, recordActVerifyFailureAlert, verifyActExecution } from './actVerify';
import { executeBuiltInPlaybookForRun } from './playbookActExecutor';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import { loadTicketContext, type TicketRunContext } from './ticketContext';
import { loadAnomalyContext, type AnomalyRunContext } from './anomalyContext';
import { getCachedAiKillStateSnapshot, readAiKillState } from '../aiKillState';
import {
  closeAgentRunSession,
  completeToolExecution,
  createAgentRunSession,
  reconcileHungExecutions,
  startToolExecution,
} from './executionLedger';
import { deliverRunFinishedNotifications } from './runFinishedNotify';
import { transitionRunStatus } from './runService';
// jobs/, not services/ — the durable retry lane for a notify failure (Task 6,
// #3826). BullMQ-touching but harmless to import here: `enqueueAgentNotifyRetry`
// itself lazily constructs its Queue only when actually called (services/redis.ts
// never connects at import time), and this module does NOT import runLoop.ts
// back — see runFinishedNotify.ts's header for why that direction would cycle.
import { enqueueAgentNotifyRetry } from '../../jobs/agentNotifyRetryWorker';
// Same "harmless to import here" reasoning as `enqueueAgentNotifyRetry` above
// (jobs/, not services/): the fix-watch Queue is constructed lazily and this
// module does not import runLoop.ts back — see fixWatchWorker.ts's header.
import { scheduleFixWatch } from '../../jobs/fixWatchWorker';
import { actEvidenceSourceId, insertOpEvidence, type OpEvidenceInsert } from './opEvidence';
import {
  buildAgentRunSystemPrompt,
  buildAgentRunTaskPrompt,
  type AgentRunAnomalyPromptContext,
  type AgentRunNarrativePromptContext,
  type AgentRunPromptContext,
  type AgentRunSweepPromptContext,
  type AgentRunTicketPromptContext,
} from './runnerPrompt';
import {
  buildOutcomeSdkTools,
  isOutcomeTool,
  OUTCOME_MCP_TOOL_NAMES,
  outcomeToolsForProfile,
  validateOutcomeToolInput,
} from './outcomeTools';
import { isVerdictProfile, verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { isSweepProfile, sweepLimits, sweepToolAllowlist } from './sweepProfile';
import { isNarrativeProfile, narrativeLimits, narrativeToolAllowlist } from './narrativeProfile';
import { isTriageProfile, triageLimits, triageToolAllowlist } from './triageProfile';
import {
  finalizeNarrative,
  finalizeSweep,
  finalizeTicketTriage,
  finalizeVerdict,
} from './runFinalizers';
import type {
  AgentRow,
  AgentRunOutcome,
  LoopResult,
  OutcomeExecutedAction,
  OutcomeProposedAction,
  RunContext,
  RunRow,
} from './runLoopTypes';

/**
 * Re-exported (issue #4451) so every existing importer of the run outcome
 * shape keeps its current `./runLoop` path after the types moved into
 * `runLoopTypes.ts`.
 */
export type {
  AgentRunOutcome,
  OutcomeExecutedAction,
  OutcomeProposedAction,
  TicketProposalOutcome,
} from './runLoopTypes';
import { loadSweepEvidence } from './sweepEvidence';
import { loadNarrativeContext } from './narrativeContext';

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

/** Error carrying the short code that lands in `ai_agent_runs.error_code` (varchar(64)). */
export class AgentRunError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'AgentRunError';
    this.errorCode = errorCode;
  }
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
        ticketId: aiAgentRuns.ticketId,
        anomalyIncidentId: aiAgentRuns.anomalyIncidentId,
        status: aiAgentRuns.status,
        modeAtStart: aiAgentRuns.modeAtStart,
        triggerKind: aiAgentRuns.triggerKind,
        policySnapshot: aiAgentRuns.policySnapshot,
        profile: aiAgentRuns.profile,
        correlationGroupId: aiAgentRuns.correlationGroupId,
        scheduleId: aiAgentRuns.scheduleId,
        triggerRef: aiAgentRuns.triggerRef,
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
    //
    // The `org_id` predicate is NOT redundant with the run row: this select
    // runs in a SYSTEM context (full RLS bypass), so the tenant boundary has to
    // be written out by hand. A device can leave this org between admission and
    // delivery — moveOrg re-stamps the device (and `alerts`, which is in
    // CORE_DEVICE_ORG_DENORMALIZED_TABLES) into the NEW org while the run
    // deliberately stays home — and an unpinned read would then feed another
    // tenant's hostname/OS/site into this org's prompt and run summary. Missing
    // (moved or deleted) reads as "no device", which the prompt handles.
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
        .where(and(eq(devices.id, run.deviceId), eq(devices.orgId, run.orgId)))
        .limit(1);
      device = row ?? null;
      if (!row) {
        console.warn('[aiAgentRunLoop] run device is not (or no longer) in the run org', {
          runId, orgId: run.orgId, deviceId: run.deviceId,
        });
      }
    }

    let alert: RunContext['alert'] = null;
    if (run.alertId) {
      const [row] = await db
        .select({ title: alerts.title, severity: alerts.severity, message: alerts.message })
        .from(alerts)
        .where(and(eq(alerts.id, run.alertId), eq(alerts.orgId, run.orgId)))
        .limit(1);
      alert = row ?? null;
      if (!row) {
        console.warn('[aiAgentRunLoop] run alert is not (or no longer) in the run org', {
          runId, orgId: run.orgId, alertId: run.alertId,
        });
      }
    }

    // Same "moved/deleted reads as absent" posture as device/alert above —
    // this read is ALSO org-pinned inside `loadTicketContext` itself (it
    // runs under this same system context), for the identical reason: a
    // ticket can move org between admission and delivery.
    let ticket: RunContext['ticket'] = null;
    if (run.ticketId) {
      try {
        ticket = await loadTicketContext(run.ticketId, run.orgId);
      } catch (error) {
        console.error('[aiAgentRunLoop] failed to load ticket context', {
          runId, orgId: run.orgId, ticketId: run.ticketId, error,
        });
      }
      if (!ticket) {
        console.warn('[aiAgentRunLoop] run ticket is not (or no longer) in the run org', {
          runId, orgId: run.orgId, ticketId: run.ticketId,
        });
      }
    }

    // Same "moved/deleted reads as absent" posture as device/alert/ticket
    // above — this read is ALSO org-pinned inside `loadAnomalyContext` itself
    // (it runs under this same system context), for the identical reason: an
    // incident can move org between admission and delivery.
    let anomaly: RunContext['anomaly'] = null;
    if (run.anomalyIncidentId) {
      try {
        anomaly = await loadAnomalyContext(run.anomalyIncidentId, run.orgId);
      } catch (error) {
        console.error('[aiAgentRunLoop] failed to load anomaly context', {
          runId, orgId: run.orgId, anomalyIncidentId: run.anomalyIncidentId, error,
        });
      }
      if (!anomaly) {
        console.warn('[aiAgentRunLoop] run anomaly incident is not (or no longer) in the run org', {
          runId, orgId: run.orgId, anomalyIncidentId: run.anomalyIncidentId,
        });
      }
    }

    // Phase 2 wave P2-1 (alert verdicts). Same "missing reads as null, never
    // as a hard failure" shape as the device/alert reads above — a group can
    // be deleted or its org can drift between admission and delivery.
    let correlationGroup: RunContext['correlationGroup'] = null;
    if (run.correlationGroupId) {
      const [row] = await db
        .select({
          id: alertCorrelationGroups.id,
          memberCount: alertCorrelationGroups.memberCount,
          noiseReductionPercent: alertCorrelationGroups.noiseReductionPercent,
          rootAlertId: alertCorrelationGroups.rootAlertId,
          metadata: alertCorrelationGroups.metadata,
        })
        .from(alertCorrelationGroups)
        .where(and(
          eq(alertCorrelationGroups.id, run.correlationGroupId),
          eq(alertCorrelationGroups.orgId, run.orgId),
        ))
        .limit(1);
      if (row) {
        const metadata = row.metadata as Record<string, unknown> | null;
        const correlationTypes = Array.isArray(metadata?.correlationTypes)
          ? (metadata.correlationTypes as unknown[]).filter((s): s is string => typeof s === 'string')
          : [];
        correlationGroup = {
          id: row.id,
          memberCount: row.memberCount,
          noiseReductionPercent: row.noiseReductionPercent,
          rootAlertId: row.rootAlertId,
          correlationTypes,
        };
      } else {
        console.warn('[aiAgentRunLoop] run correlation group is not (or no longer) in the run org', {
          runId, orgId: run.orgId, correlationGroupId: run.correlationGroupId,
        });
      }
    }

    // Phase 2 wave P2-2 (scheduled sweeps). Runs INSIDE this same system
    // context (`loadSweepEvidence`'s own header states it manages none of its
    // own) — the `org_id = run.orgId` predicate every one of its statements
    // carries is therefore the only thing keeping one tenant's sweep out of
    // another's rows, exactly like the hand-written org pins above.
    //
    // Read defensively: `trigger_ref` is an untyped jsonb column, and a run
    // could reach here hand-enqueued, half-migrated, or written by an older
    // sweeper. Unknown kinds are DROPPED rather than passed through (a kind
    // with no loader would throw inside `loadSweepEvidence`); missing kinds
    // yield empty evidence, which the prompt renders as "these checks found
    // nothing" — never a failed run.
    let sweep: RunContext['sweep'] = null;
    if (isSweepProfile(run as RunRow)) {
      const ref = (run.triggerRef ?? {}) as { occurrenceKey?: unknown; sweepKinds?: unknown };
      const rawKinds = Array.isArray(ref.sweepKinds) ? ref.sweepKinds : [];
      const kinds = rawKinds.filter(
        (kind): kind is AiSweepKind => (AI_SWEEP_KINDS as readonly unknown[]).includes(kind),
      );
      if (kinds.length !== rawKinds.length) {
        console.warn('[aiAgentRunLoop] dropped unknown sweep kinds from trigger_ref', {
          runId, orgId: run.orgId, requested: rawKinds.length, kept: kinds.length,
        });
      }
      sweep = {
        scheduleId: run.scheduleId ?? '',
        occurrenceKey: typeof ref.occurrenceKey === 'string' ? ref.occurrenceKey : '',
        kinds,
        evidence: await loadSweepEvidence(run.orgId, kinds),
      };
    }

    // Phase 2 wave P2-3 (weekly org narrative). Runs INSIDE this same system
    // context, exactly like the sweep evidence above and for the same reason:
    // `loadNarrativeContext` manages no context of its own, so the `org_id`
    // predicate every one of its statements carries is the only thing keeping
    // one tenant's week out of another's report.
    //
    // Awaited directly, with no try/catch: `loadNarrativeContext` isolates
    // every one of its loaders internally (`Promise.allSettled`-style
    // `settled()` + a `reportLoaderFailure` warning), so a broken table
    // surfaces as an `unavailable` entry the prompt renders as "(not
    // measured)" — it does not throw. `trigger_ref` is read DEFENSIVELY for
    // the same reason the sweep block reads it that way: it is an untyped
    // jsonb column and a run could reach here hand-enqueued or written by an
    // older scheduler.
    let narrative: RunContext['narrative'] = null;
    if (isNarrativeProfile(run as RunRow)) {
      const ref = (run.triggerRef ?? {}) as { occurrenceKey?: unknown };
      narrative = {
        scheduleId: run.scheduleId ?? '',
        occurrenceKey: typeof ref.occurrenceKey === 'string' ? ref.occurrenceKey : '',
        context: await loadNarrativeContext(run.orgId),
      };
    }

    return {
      run: run as RunRow,
      agent: agent as AgentRow,
      orgPartnerId: org.partnerId,
      device,
      alert,
      ticket,
      anomaly,
      correlationGroup,
      sweep,
      narrative,
      sessionId: null,
    };
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
  run: Pick<RunRow, 'id' | 'orgId' | 'agentId' | 'profile'>;
  agentName: string;
  agentAuth: AuthContext;
  agentKind: AiAgentKind;
  guardrailPolicy: AgentGuardrailPolicy;
  outcome: AgentRunOutcome;
  intentIds: string[];
  /** Per-tool count of calls the gate ALLOWED, consumed by the post hook. */
  allowedPending: Map<string, number>;
  /** The run's execution-ledger session, or `null` if session creation itself failed. */
  sessionId: string | null;
  /**
   * Per-tool FIFO of `ai_tool_executions` ids (or `null` sentinels for a
   * failed/skipped ledger write), shifted by the post hook. Same ordering
   * assumption as `allowedPending`.
   */
  executionIdPending: Map<string, Array<string | null>>;
  /**
   * Per-tool FIFO of act-mode asset pins, pushed in LOCKSTEP with
   * `executionIdPending` (a `null` entry for every ordinary allowed call, a
   * real `ActAssetPin` only for one that dispatched through the act branch)
   * — the SAME tool name can be BOTH in one run (e.g. `disk_cleanup` preview
   * is a plain read-only allow, `disk_cleanup` execute is act-eligible), so
   * this cannot be a separate independently-sized queue.
   */
  actPinPending: Map<string, Array<ActAssetPin | null>>;
  /** In-run `maxActionsPerRun` reservation counter, shared across every
   *  act-mode call in this run (Task 3). */
  actReservation: ActReservationState;
  /**
   * Absolute epoch ms the run's wall-clock ceiling expires at (Global
   * Constraints: playbook executor wall-clock is bounded by the run's
   * REMAINING budget, not a fresh timer per playbook) — same value the SDK
   * loop's own `wallClockTimer` aborts on (see `driveSdkLoop`), threaded
   * through so `playbookActExecutor.ts` can enforce it independently of the
   * SDK's `abortController` (which this synchronous hook does not observe).
   */
  deadlineMs: number;
}): PreToolUseCallback {
  const {
    run, agentName, agentAuth, agentKind, guardrailPolicy, outcome, intentIds, allowedPending,
    sessionId, executionIdPending, actPinPending, actReservation, deadlineMs,
  } = args;

  /** Shared by the ordinary 'propose' disposition AND an act-mode downgrade
   *  (drift/cap-exhaustion) — both record the SAME shape and, for a tier-3
   *  call, submit the SAME action-intent approval. */
  async function recordProposal(
    check: { tier: number },
    toolName: string,
    input: Record<string, unknown>,
    downgradeReason?: string,
  ): Promise<{ allowed: false; error: string }> {
    const action = readToolAction(toolName, input);
    const entry: OutcomeProposedAction = {
      tool: toolName,
      ...(action ? { action } : {}),
      args: input,
      ...(downgradeReason ? { downgradeReason } : {}),
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
        // createActionIntent does NOT throw when nobody can approve: it
        // commits the intent and immediately cancels it with
        // `no_eligible_approvers`, returning that snapshot. Counting such an
        // id towards `awaiting_approval` would end the run in a state that
        // can never resolve, and point the recipients' notification at an
        // /approvals queue the intent will never appear in. Only a genuinely
        // pending intent is something a human still owns.
        if (intent.status === 'pending_approval') {
          intentIds.push(intent.id);
        } else {
          intentError = intent.errorCode ?? `intent ${intent.status}`;
          entry.intentError = intentError;
          console.warn('[aiAgentRunLoop] proposal intent was not left pending approval', {
            runId: run.id, toolName, intentId: intent.id, status: intent.status,
            errorCode: intent.errorCode,
          });
        }
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

  /** Shared by the ordinary 'allow' tail AND an act-mode 'ok' revalidation —
   *  both write the SAME ledger row and per-tool FIFOs; only `actPin` (and
   *  therefore the returned `context`) differs. */
  async function recordAllowedExecution(
    toolName: string,
    input: Record<string, unknown>,
    actPin: ActAssetPin | null,
  ): Promise<{ allowed: true; context?: ToolExecutionContext }> {
    allowedPending.set(toolName, (allowedPending.get(toolName) ?? 0) + 1);

    // Ledger write is best-effort: the tool call is already decided ALLOWED
    // above, and a failure here must never turn that into a denial. A failed
    // (or skipped, when the session itself never got created) write pushes a
    // `null` sentinel so the post hook's FIFO stays aligned with the calls
    // that actually happened.
    let executionId: string | null = null;
    if (sessionId) {
      try {
        executionId = await startToolExecution({ sessionId, toolName, toolInput: input });
      } catch (error) {
        console.error('[aiAgentRunLoop] execution-ledger write failed — tool call still executes', {
          runId: run.id, toolName, error,
        });
        executionId = null;
      }
    }
    const pending = executionIdPending.get(toolName) ?? [];
    pending.push(executionId);
    executionIdPending.set(toolName, pending);

    const pinQueue = actPinPending.get(toolName) ?? [];
    pinQueue.push(actPin);
    actPinPending.set(toolName, pinQueue);

    return actPin?.toolExecutionContext
      ? { allowed: true, context: actPin.toolExecutionContext }
      : { allowed: true };
  }

  return async (toolName, input) => {
    // Outcome tools (Phase 2 wave P2-1, spec §9): checked FIRST, before
    // `checkAgentGuardrails` below, because that guardrail has no allowlist
    // entry for an outcome tool — it isn't in `aiTools`/`TOOL_TIERS` at all —
    // and would deny it as an unknown tool. `submit_alert_verdict` is only
    // ever exposed to the SDK on a verdict-profile run (see the `allowedTools`
    // computation in `driveSdkLoop`), so a full-profile run reaching here is
    // either a stale prompt/tool cache or a hostile attempt to call it
    // anyway — denied and recorded either way.
    if (isOutcomeTool(toolName)) {
      // Review fix (wave P2-1 fix round 1): this branch sits AHEAD of
      // `checkAgentGuardrails`, which is where the env-flag + DB kill switch
      // are normally enforced — an outcome tool bypassed both entirely.
      // Same two checks, same deny reasons, so a kill-switched run cannot
      // record a verdict either.
      if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) {
        const reason = 'Autonomous AI agents are disabled';
        outcome.deniedActions.push({ tool: toolName, reason });
        return { allowed: false, error: reason };
      }
      const killState = getCachedAiKillStateSnapshot();
      if (killState.killed) {
        const reason = `Autonomous AI agents are kill-switched (epoch ${killState.epoch})`;
        outcome.deniedActions.push({ tool: toolName, reason });
        return { allowed: false, error: reason };
      }
      // Generalized in wave P2-2 (task 6) from "verdict runs only" to "the
      // tool this run's profile owns": `outcomeToolsForProfile` is the SAME
      // function that decides SDK exposure and post-hook capture below, so a
      // sweep run can never record a verdict (or vice versa) even if a stale
      // tool cache offers the wrong name. The deny reason names the profile
      // because that is the mismatch a reviewer needs to see.
      if (!outcomeToolsForProfile(run.profile).includes(toolName)) {
        outcome.deniedActions.push({
          tool: toolName,
          reason: `outcome tool ${toolName} is not available to ${run.profile}-profile runs`,
        });
        return { allowed: false, error: 'not available on this run' };
      }
      try {
        validateOutcomeToolInput(toolName, input);
      } catch (e) {
        return { allowed: false, error: `invalid ${toolName} input: ${(e as Error).message}` };
      }
      return { allowed: true };
    }

    const check = checkAgentGuardrails(toolName, input, guardrailPolicy);

    if (check.disposition === 'deny') {
      const reason = check.reason ?? 'Denied by agent guardrails';
      outcome.deniedActions.push({ tool: toolName, reason });
      return { allowed: false, error: reason };
    }

    // Review fix (wave P2-1 fix round 1, PLAN CHANGE; reordered review round
    // 2, Minor 2): a verdict run is read-only, full stop — a 'propose' or an
    // 'act' the ordinary guardrail would otherwise record or execute is
    // denied outright instead. This sits BELOW the `check.disposition ===
    // 'deny'` branch above (not merged into it) so a REAL guardrail deny —
    // kill switch, site scope, protected resource, disabled/off, an unknown
    // action — keeps ITS OWN specific reason instead of being overwritten
    // with the generic "verdict runs are read-only"; only 'propose'/'act'
    // ever reach this branch now, since 'deny' and 'allow' have already
    // returned above. Defense in depth on top of `guardrailPolicy.toolAllowlist`
    // already being built from the verdict floor in `driveSdkLoop` (which
    // makes an unlisted mutation deny for the allowlist reason before this
    // is even reached) — this catches anything that reasoning missed, e.g.
    // a read-only-looking tool with a mutating action this list didn't
    // anticipate.
    // Wave P2-2 (task 6): generalized from verdict-only to every READ-ONLY
    // profile. A sweep run is read-only by the same construction (its floor
    // is read-only tools, and `sweepLimits` pins `maxActionsPerRun: 0`), so
    // a 'propose'/'act' disposition on one is the same class of miss this
    // branch was added to catch. The rendered message is unchanged for a
    // verdict run (`run.profile` IS 'verdict' there).
    //
    // Wave P2-3 (task 6): the narrative profile joins them, and is the
    // STRONGEST case of the three — its tool floor is EMPTY
    // (`narrativeProfile.ts`) and `narrativeLimits` pins `maxActionsPerRun:
    // 0`, so a mutating call reaching here at all already means something
    // upstream is wrong. Denying it outright rather than recording a proposal
    // matters because a narrative run has no proposal surface at all: nothing
    // reads `outcome.proposedActions` for this profile, so a recorded
    // proposal would be a mutation request nobody would ever see.
    //
    // Wave P2-4 (task A6): triage joins them, on the SAME footing as
    // narrative — its tool floor (`TRIAGE_TOOL_ALLOWLIST`) is empty too, so
    // no mutating tool is ever exposed to a triage run in the first place;
    // this is defense in depth against anything upstream reaching here
    // anyway. A triage run's real output channel is `submit_ticket_proposal`
    // (an outcome tool, handled above this branch, never reaching here) —
    // nothing reads `outcome.proposedActions` for this profile either.
    if (
      (isVerdictProfile(run) || isSweepProfile(run) || isNarrativeProfile(run) || isTriageProfile(run))
      && check.disposition !== 'allow'
    ) {
      const reason = `${run.profile} runs are read-only`;
      outcome.deniedActions.push({ tool: toolName, reason });
      return { allowed: false, error: reason };
    }

    if (check.disposition === 'propose') {
      return recordProposal(check, toolName, input);
    }

    if (check.disposition === 'act') {
      // Same pure resolver `checkAgentGuardrails` already called to reach
      // 'act' — deterministic on the same (toolName, input), so this can
      // only be non-null. The null branch below is defense in depth, never
      // exercised by real dispatch: never let an 'act' disposition reach the
      // execution tail without a manifest match backing it.
      const op = resolveActOperation(toolName, input);
      if (!op) {
        const reason = `Act-mode dispatch could not re-resolve a manifest match for "${toolName}"`;
        console.error('[aiAgentRunLoop] act disposition without a manifest match — denying', {
          runId: run.id, toolName,
        });
        outcome.deniedActions.push({ tool: toolName, reason });
        return { allowed: false, error: reason };
      }

      // Device-less mutations are denied far upstream inside
      // `checkAgentGuardrails` itself (before the act branch is even
      // reached), so `guardrailPolicy.deviceId` is guaranteed non-null here
      // — this check is defense in depth, not the primary gate.
      if (!guardrailPolicy.deviceId) {
        const reason = 'Act-mode execution requires a device-bound run';
        outcome.deniedActions.push({ tool: toolName, reason });
        return { allowed: false, error: reason };
      }

      const revalidated = await revalidateActExecution({
        run: {
          id: run.id,
          orgId: run.orgId,
          agentId: run.agentId,
          agentKind,
          deviceId: guardrailPolicy.deviceId,
          deviceSiteId: guardrailPolicy.deviceSiteId ?? null,
        },
        op,
        toolName,
        input,
        reserved: actReservation,
      });

      if ('deny' in revalidated) {
        outcome.deniedActions.push({ tool: toolName, reason: revalidated.deny });
        return { allowed: false, error: revalidated.deny };
      }

      if ('downgrade' in revalidated) {
        // Drift (act → shadow) or a cap-exhausted reservation — falls into
        // the EXACT same recording path as an ordinary unmatched-mutation
        // proposal under act mode (aiGuardrails.ts's own act branch). Also
        // covers a CUSTOM (non-built-in) `execute_playbook` call: `pinPlaybook`
        // (actRevalidation.ts) downgrades those to a proposal before this
        // function is ever reached, so the executor below only ever sees a
        // playbookId already proven built-in. `revalidated.reason` (#3826
        // cheap nonblocking fix) is set only for a missing/malformed-identity
        // normalizeTarget downgrade — threaded through so the proposal a
        // human reviews carries WHY it wasn't auto-executed.
        return recordProposal(check, toolName, input, revalidated.reason);
      }

      if (op.key === 'execute_playbook') {
        // Task 5 (#3826): the ONLY op where the manifest owns execution. The
        // ordinary `execute_playbook` tool is a STUB that hands the model the
        // step list to run turn-by-turn — never a rule-equivalent shape for
        // unattended act mode. The deterministic executor replaces it
        // entirely: it does NOT dispatch through `recordAllowedExecution`
        // (the SDK tool never runs), so `actPinPending`/`executionIdPending`
        // never see an entry for this call and the post-hook's FIFO guard
        // (`remaining <= 0`) makes its no-op safe. The outcome is recorded
        // here, directly, in the SAME shape the post-hook would have used.
        const target = revalidated.pin.target as Extract<ActTarget, { kind: 'playbook' }>;
        const playbookDigest = revalidated.pin.playbookDigest;
        if (!playbookDigest) {
          // Defense in depth: `pinPlaybook` always sets this on an `ok`
          // pin — never reachable via real dispatch.
          const reason = 'Act-mode playbook execution has no pinned digest to execute against';
          console.error('[aiAgentRunLoop] execute_playbook pin missing playbookDigest', { runId: run.id });
          outcome.deniedActions.push({ tool: toolName, reason });
          return { allowed: false, error: reason };
        }

        const dispatchStartedAt = Date.now();
        const result = await executeBuiltInPlaybookForRun({
          run: {
            id: run.id,
            orgId: run.orgId,
            agentId: run.agentId,
            agentKind,
            deviceId: guardrailPolicy.deviceId,
            deviceSiteId: guardrailPolicy.deviceSiteId ?? null,
          },
          agentAuth,
          playbookId: target.playbookId,
          expectedDigest: playbookDigest,
          variables: (input.variables as Record<string, unknown> | undefined) ?? {},
          reserved: actReservation,
          deadlineMs,
        });
        const durationMs = Date.now() - dispatchStartedAt;

        outcome.executedActions.push({
          tool: toolName,
          executionId: '(inline)',
          result: result.execution === 'succeeded' ? 'ok' : 'failed',
          durationMs,
          execution: result.execution,
          verification: result.verification,
          ...(result.verifyDetail ? { verifyDetail: result.verifyDetail } : {}),
          actOpKey: op.key,
          actTargetName: actTargetSummary(target),
        });
        outcome.toolExecutionCount += 1;

        if (result.verification === 'failed') {
          await recordActVerifyFailureAlert({
            run: { id: run.id, orgId: run.orgId, deviceId: guardrailPolicy.deviceId, agentId: run.agentId },
            op: { key: op.key },
            target,
            detail: result.verifyDetail,
          });
        }

        // Worded as success, matching PROPOSAL_RECORDED_TEXT's convention —
        // the playbook already ran; a model reading "denied" here would retry.
        return { allowed: false, error: result.summary };
      }

      // ok: the ONLY remaining path that actually dispatches — through the
      // normal tool implementation, exactly like a plain 'allow'.
      return recordAllowedExecution(toolName, input, revalidated.pin);
    }

    return recordAllowedExecution(toolName, input, null);
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
  executionIdPending: Map<string, Array<string | null>>;
  actPinPending: Map<string, Array<ActAssetPin | null>>;
  run: { id: string; orgId: string; agentId: string; deviceId: string | null; profile: AiAgentRunProfile };
  /** For `verifyActExecution`'s `executeCommand` calls — attribution only. */
  agentUserId: string;
}): PostToolUseCallback {
  const { outcome, allowedPending, executionIdPending, actPinPending, run, agentUserId } = args;

  return async (toolName, input, output, isError, durationMs) => {
    // Outcome tools (Phase 2 wave P2-1): never went through
    // `recordAllowedExecution` in the pre-hook, so they never touch
    // `allowedPending`/the execution ledger/the act pipeline — capture the
    // validated verdict and stop, before any of the ordinary accounting below.
    if (isOutcomeTool(toolName)) {
      // Stored BY TOOL NAME (wave P2-2, task 6), gated on the same
      // `outcomeToolsForProfile` the pre-hook denies against — so a name the
      // pre-hook refused can never still land in the outcome via this path.
      if (!isError && outcomeToolsForProfile(run.profile).includes(toolName)) {
        switch (toolName) {
          case 'submit_alert_verdict':
            outcome.alertVerdict = validateOutcomeToolInput(toolName, input);
            break;
          case 'submit_sweep_findings':
            outcome.sweepFindings = validateOutcomeToolInput(toolName, input);
            break;
          // Wave P2-3: what lands here is the SERVER-BUILT `NarrativeOutcome`
          // (titles attached, sections re-ordered, markdown derived), not the
          // model's submission — see `validateOutcomeToolInput`'s narrative
          // overload.
          case 'submit_narrative':
            outcome.narrative = validateOutcomeToolInput(toolName, input);
            break;
          // Phase 2 wave P2-4 (ticket triage, #4191), task A6 — what lands
          // here IS the model's raw (validated) submission, unlike
          // `submit_narrative`: `TicketProposalOutcome` is a type alias onto
          // the shared `TicketTriageProposal` with no server-owned rebuild
          // step (see `TicketProposalOutcome`'s docstring). Turning this into
          // `manage_tickets` intents/`ticket_drafts` rows happens downstream
          // in `finishRun` (task A8), never here.
          case 'submit_ticket_proposal':
            outcome.ticketProposal = validateOutcomeToolInput(toolName, input);
            break;
          default: {
            const exhaustive: never = toolName;
            throw new Error(`[aiAgentRunLoop] unhandled outcome tool: ${String(exhaustive)}`);
          }
        }
      }
      return;
    }

    const remaining = allowedPending.get(toolName) ?? 0;
    if (remaining <= 0) return;
    allowedPending.set(toolName, remaining - 1);

    let executionId: string | null = null;
    const pending = executionIdPending.get(toolName);
    if (pending && pending.length > 0) {
      executionId = pending.shift() ?? null;
    }
    if (executionId) {
      try {
        await completeToolExecution({ executionId, isError, durationMs });
      } catch (error) {
        console.error('[aiAgentRunLoop] failed to complete execution-ledger row (non-fatal)', {
          toolName, executionId, error,
        });
      }
    }

    let actPin: ActAssetPin | null = null;
    const pinQueue = actPinPending.get(toolName);
    if (pinQueue && pinQueue.length > 0) {
      actPin = pinQueue.shift() ?? null;
    }

    const action = readToolAction(toolName, input);
    const entry: OutcomeExecutedAction = {
      tool: toolName,
      ...(action ? { action } : {}),
      executionId: executionId ?? '(inline)',
      result: isError ? 'failed' : 'ok',
      durationMs,
    };

    // Recorded BEFORE the verification await below, not after: this whole
    // hook runs under `safePostToolUse`'s POST_TOOL_USE_TIMEOUT_MS cap
    // (aiAgentSdkTools.ts), which is independent of — and can be shorter
    // than — `verifyActExecution`'s own per-read budget. If the outer cap
    // fires while a verify read is still in flight, the entry must already
    // be in `outcome.executedActions` (the action really did execute) rather
    // than lost entirely. The object is mutated in place as verification
    // resolves, never pushed twice.
    outcome.executedActions.push(entry);
    outcome.toolExecutionCount += 1;

    if (actPin && run.deviceId) {
      try {
        const verified = await verifyActExecution({
          pin: actPin,
          toolOutput: output,
          isError,
          run: { id: run.id, orgId: run.orgId, agentId: run.agentId, deviceId: run.deviceId },
          agentUserId,
        });
        entry.execution = verified.execution;
        entry.verification = verified.verification;
        if (verified.verifyDetail) entry.verifyDetail = verified.verifyDetail;
        entry.actOpKey = actPin.op.key;
        entry.actTargetName = actTargetSummary(actPin.target);

        if (verified.verification === 'failed') {
          await recordActVerifyFailureAlert({
            run: { id: run.id, orgId: run.orgId, deviceId: run.deviceId, agentId: run.agentId },
            op: { key: actPin.op.key },
            target: actPin.target,
            detail: verified.verifyDetail,
          });
        }
      } catch (error) {
        // verifyActExecution already catches its own read-back failures —
        // this is a genuinely unexpected bug in the verify path itself.
        // Never let it turn a completed tool call into a crashed run.
        console.error('[aiAgentRunLoop] act verification failed unexpectedly (non-fatal)', {
          runId: run.id, toolName, error,
        });
        entry.execution = 'unknown';
        entry.verification = 'inconclusive';
        entry.actOpKey = actPin.op.key;
        entry.actTargetName = actTargetSummary(actPin.target);
      }
    }
  };
}

/**
 * Run-level verdict rollup, computed once at finish over every executed
 * action's (execution, verification) pair — see `AgentRunOutcome.runVerdict`.
 * Pure; exported for direct unit coverage.
 */
export function computeRunVerdict(
  outcome: Pick<AgentRunOutcome, 'executedActions' | 'proposedActions'>,
): AgentRunVerdict {
  const acted = outcome.executedActions.filter((a) => a.verification !== undefined);
  if (acted.length === 0) return 'no_action';
  // The rollup is over the (execution, verification) PAIR, not verification
  // alone: a dispatch that itself failed/timed out/is unknown is not "clean"
  // even when its read-back reports 'passed' (rare, but not proof), and a
  // read-back that never ran ('skipped' — e.g. dispatch failed before the
  // script could produce an exit code) must not roll up as a quiet success
  // just because it isn't literally 'failed'/'inconclusive'.
  const allClean = acted.every((a) => a.verification === 'passed' && a.execution === 'succeeded');
  if (!allClean) return 'needs_attention';
  return outcome.proposedActions.length > 0 ? 'partial' : 'remediated';
}

interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * How a terminal SDK result maps onto this run's outcome.
 *
 * `SDKResultMessage` is `SDKResultSuccess | SDKResultError`, and only the
 * success branch carries a `result` string. Branching on `subtype === 'success'`
 * alone — and doing nothing else — recorded an Anthropic 500 mid-run as a
 * `completed` run with a NULL error code and an empty summary: the async
 * iterator ends normally after an error result, so nothing threw, and the
 * recipients were told "Agent run finished" about an alert nobody triaged.
 *
 * Two of the error subtypes are CEILINGS, not crashes, and reuse the flags the
 * local guards already set (a run that produced proposals before hitting one
 * still finishes normally, with the flag in `outcome`). Note that
 * `error_max_budget_usd` is the PRIMARY budget stop: the SDK halts at
 * `maxBudgetUsd`, so the local `costCents > maxBudgetCentsPerRun` guard —
 * strict `>`, evaluated only after a result lands — is the backstop, not the
 * other way round.
 *
 * Anything else, including a subtype added by a future SDK release, is a hard
 * failure: unknown means "we do not know that this run did its job".
 */
type ResultDisposition =
  | { kind: 'success' }
  | { kind: 'ceiling'; flag: 'budgetExceeded' | 'maxTurnsExceeded' }
  | { kind: 'failure'; errorCode: string };

const RESULT_DISPOSITIONS: Record<string, ResultDisposition> = {
  success: { kind: 'success' },
  error_max_budget_usd: { kind: 'ceiling', flag: 'budgetExceeded' },
  error_max_turns: { kind: 'ceiling', flag: 'maxTurnsExceeded' },
  error_during_execution: { kind: 'failure', errorCode: 'sdk_error' },
  error_max_structured_output_retries: { kind: 'failure', errorCode: 'sdk_output_error' },
};

export function dispositionForResultSubtype(subtype: string): ResultDisposition {
  return RESULT_DISPOSITIONS[subtype] ?? { kind: 'failure', errorCode: 'sdk_error' };
}

/**
 * Phase 2 wave P2-4 (#4191), Task A8 — whether a run that created one or
 * more intents still has a human decision pending. `true` iff at least one
 * id in `intentIds` is NOT also in `decidedIntentIds`.
 *
 * Before this task, `executeAgentRun` used `intentIds.length > 0` directly:
 * correct because every existing finalizer (`finalizeVerdict`/
 * `finalizeSweep`) and every in-loop proposal path (`recordProposal`) only
 * ever links a `pending_approval` intent id — a cancelled/errored one is
 * never pushed (see `alertVerdicts.ts`'s header on why linking a cancelled
 * id would be wrong). `finalizeTicketTriage` breaks that invariant on
 * purpose: a creation-time `ticket_autonomy` grant produces a genuinely
 * live intent whose status is ALREADY `approved` — nobody is waiting on it,
 * so counting it toward `awaiting_approval` would leave the run in a status
 * that reads as "needs a human" when it does not.
 *
 * `decidedIntentIds` defaults to empty, so for every other profile this is
 * exactly `intentIds.length > 0` — unchanged behavior.
 *
 * Exported for direct unit coverage (same precedent as `computeRunVerdict`)
 * rather than only reachable through the full SDK-loop harness.
 */
export function classifyIntentAwaitingApproval(
  intentIds: string[],
  decidedIntentIds: string[] | undefined,
): boolean {
  if (intentIds.length === 0) return false;
  const decided = new Set(decidedIntentIds ?? []);
  return intentIds.some((id) => !decided.has(id));
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

function ticketPromptContext(ticket: TicketRunContext): AgentRunTicketPromptContext {
  return {
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    tags: ticket.tags,
    dueDate: ticket.dueDate,
    comments: ticket.comments,
    // P2-4 (#4191) Task 7 — both already sanitized/whitelist-filtered by
    // `ticketContext.ts`'s `assembleTicketContext`; passed through as-is.
    linkedDevice: ticket.linkedDevice,
    // P2-4 (#4191) Task 7 review follow-up — the "unavailable ≠ zero" flags;
    // passed through as-is (present/`true` only when set, matching
    // `TicketRunContext`'s own optional-`true` contract).
    linkedDeviceUnavailable: ticket.linkedDeviceUnavailable,
    similarResolvedTickets: ticket.similarResolvedTickets,
    similarResolvedTicketsUnavailable: ticket.similarResolvedTicketsUnavailable,
    truncated: ticket.truncated,
  };
}

function anomalyPromptContext(anomaly: AnomalyRunContext): AgentRunAnomalyPromptContext {
  return {
    anomalyType: anomaly.anomalyType,
    bucketSeconds: anomaly.bucketSeconds,
    windowStart: anomaly.windowStart,
    firstSeenAt: anomaly.firstSeenAt,
    lastSeenAt: anomaly.lastSeenAt,
    peakScore: anomaly.peakScore,
    rowCount: anomaly.rowCount,
    metricNames: anomaly.metricNames,
    siblings: anomaly.siblings,
    truncated: anomaly.truncated,
  };
}

function sweepPromptContext(sweep: NonNullable<RunContext['sweep']>): AgentRunSweepPromptContext {
  return {
    scheduleId: sweep.scheduleId,
    occurrenceKey: sweep.occurrenceKey,
    kinds: sweep.kinds,
    evidence: sweep.evidence,
  };
}

/**
 * Named-field projection, like `sweepPromptContext` above: the prompt context
 * gets exactly what the task turn may render, so a field added to
 * `RunContext.narrative` cannot reach the model until someone puts it here
 * too. `context` is passed by reference (it is already bounded and sanitized
 * by `narrativeContext.ts`) and the renderer reads scalars off it — it is
 * never serialized. See `buildNarrativeTaskPrompt`.
 */
function narrativePromptContext(
  narrative: NonNullable<RunContext['narrative']>,
): AgentRunNarrativePromptContext {
  return {
    scheduleId: narrative.scheduleId,
    occurrenceKey: narrative.occurrenceKey,
    context: narrative.context,
  };
}

function promptContext(ctx: RunContext, effective: AiAgentPolicy): AgentRunPromptContext {
  return {
    agent: { name: ctx.agent.name, kind: ctx.agent.kind },
    run: { id: ctx.run.id, mode: ctx.run.modeAtStart, triggerKind: ctx.run.triggerKind },
    device: ctx.device
      ? { id: ctx.device.id, hostname: ctx.device.hostname, osType: ctx.device.osType }
      : null,
    alert: ctx.alert,
    ticket: ctx.ticket ? ticketPromptContext(ctx.ticket) : null,
    anomaly: ctx.anomaly ? anomalyPromptContext(ctx.anomaly) : null,
    instructions: effective.instructions,
    profile: ctx.run.profile,
    correlationGroup: ctx.correlationGroup,
    sweep: ctx.sweep ? sweepPromptContext(ctx.sweep) : null,
    narrative: ctx.narrative ? narrativePromptContext(ctx.narrative) : null,
  };
}

async function driveSdkLoop(ctx: RunContext, effective: AiAgentPolicy): Promise<LoopResult> {
  const { run } = ctx;
  const limits = effective.limits;
  // Phase 2 wave P2-1 (alert verdicts). Computed FIRST — before
  // `guardrailPolicy` and the execution-ledger session below — so both can
  // read off it. `verdictLimits`'s output is used ONLY for the SDK `query()`
  // options further down (`maxTurns`/`maxBudgetUsd`) and the local budget
  // backstop — never re-validated through `aiAgentLimitsSchema` (its
  // `maxActionsPerRun: 0` is below that schema's `min(1)`) and never written
  // back into `run.policySnapshot`. `profileAllowlist` is `null` for a
  // `full`-profile run (nothing to narrow); for a verdict run it is
  // `verdictToolAllowlist`'s pinned floor, reused below for BOTH
  // `guardrailPolicy.toolAllowlist` (review fix, wave P2-1 fix round 1 —
  // supersedes the original "intersects the agent's allowlist" design: a
  // bare `manage_alerts` entry in the agent's OWN allowlist must never let
  // `acknowledge`/`resolve`/`suppress` reach `checkAgentGuardrails`'s
  // allowlist gate on a verdict run) and the SDK's `allowedTools` exposure —
  // one computation, one source of truth for what a verdict run can reach.
  //
  // Wave P2-2 (task 6) generalized this from verdict-only to a single
  // profile branch covering `full | verdict | sweep`: `profileAllowlist` is
  // `null` for `full` (nothing to narrow) and otherwise the profile's pinned
  // floor, reused below for BOTH `guardrailPolicy.toolAllowlist` and the
  // SDK's `allowedTools`/`onlyTools` exposure — one computation, one source
  // of truth for what this run can reach, whichever profile it is.
  //
  // Wave P2-3 (task 6) added the fourth arm. A narrative run's
  // `profileAllowlist` is the outcome tool ALONE (its drill-down floor is
  // empty), so the same one computation makes `guardrailPolicy.toolAllowlist`,
  // `allowedTools` and `onlyTools` all agree that this run can reach nothing
  // but its own submission channel.
  //
  // Wave P2-4 (task A6) added the fifth arm. A triage run's
  // `profileAllowlist` is ALSO the outcome tool alone (`TRIAGE_TOOL_ALLOWLIST`
  // is empty, same design as narrative) — but `triageLimits`, unlike its
  // three siblings, does NOT zero `maxActionsPerRun`: see `triageProfile.ts`'s
  // `triageLimits` docstring for why that field is a deliberate passthrough
  // here (task A8's post-run minting cap).
  const verdict = isVerdictProfile(run);
  const sweep = isSweepProfile(run);
  const narrative = isNarrativeProfile(run);
  const triage = isTriageProfile(run);
  const runLimits = verdict
    ? verdictLimits(limits)
    : sweep
      ? sweepLimits(limits)
      : narrative
        ? narrativeLimits(limits)
        : triage
          ? triageLimits(limits)
          : limits;
  const profileAllowlist = verdict
    ? verdictToolAllowlist(effective.toolAllowlist)
    : sweep
      ? sweepToolAllowlist(effective.toolAllowlist)
      : narrative
        ? narrativeToolAllowlist(effective.toolAllowlist)
        : triage
          ? triageToolAllowlist(effective.toolAllowlist)
          : null;
  // Computed here (not by the SDK-loop timer below) so the pre-hook's
  // act-mode playbook executor (Task 5, #3826) can enforce the SAME
  // wall-clock ceiling independently of the SDK's `abortController` — a
  // synchronous tool-use hook does not observe that abort while it's still
  // awaiting inside `executeBuiltInPlaybookForRun`.
  const wallClockMs = Math.max(1, Math.round(limits.wallClockSeconds * 1000));
  const deadlineMs = Date.now() + wallClockMs;

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
    toolAllowlist: profileAllowlist ?? effective.toolAllowlist,
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

  // Execution-ledger session: created here — AFTER the ownership check above
  // can no longer throw, so an ownership_mismatch failure never leaks an
  // orphaned `active` session row nothing will ever close (that failure path
  // returns straight to `executeAgentRun`'s catch block, not `finishRun`).
  // Stored on `ctx` so `finishRun` can reconcile and close it once the loop
  // below is done. Best-effort: a failure here must not fail the run — it
  // just means every tool call below skips its ledger row (see the pre-hook's
  // `sessionId` guard) and falls back to the `'(inline)'` executionId, same as
  // before wave 4a.
  try {
    ctx.sessionId = await createAgentRunSession({
      runId: run.id,
      agentId: ctx.agent.id,
      orgId: run.orgId,
      deviceId: run.deviceId,
      model,
      maxTurns: Math.max(1, runLimits.maxTurnsPerRun),
    });
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to create the execution-ledger session', {
      runId: run.id, error,
    });
  }

  const outcome: AgentRunOutcome = {
    proposedActions: [],
    executedActions: [],
    deniedActions: [],
    toolExecutionCount: 0,
  };
  const intentIds: string[] = [];
  const allowedPending = new Map<string, number>();
  const executionIdPending = new Map<string, Array<string | null>>();
  const actPinPending = new Map<string, Array<ActAssetPin | null>>();
  // Shared across every act-mode call in THIS run — see actRevalidation.ts.
  const actReservation: ActReservationState = { count: 0 };

  const preToolUse = createAgentRunPreToolUse({
    run, agentName: ctx.agent.name, agentAuth, agentKind: ctx.agent.kind, guardrailPolicy, outcome,
    intentIds, allowedPending, sessionId: ctx.sessionId, executionIdPending, actPinPending,
    actReservation, deadlineMs,
  });
  const postToolUse = createAgentRunPostToolUse({
    outcome, allowedPending, executionIdPending, actPinPending,
    run: { id: run.id, orgId: run.orgId, agentId: run.agentId, deviceId: run.deviceId, profile: run.profile },
    agentUserId: agentAuth.user.id,
  });

  // `exposedNames` governs SDK-level tool EXPOSURE for a verdict run, not a
  // second guardrail — `checkAgentGuardrails` (via `guardrailPolicy` above)
  // is still the sole authority for anything the model does manage to call;
  // see `verdictToolAllowlist`'s own docstring. Reuses `profileAllowlist`
  // computed at the top of this function — the SAME list that narrowed
  // `guardrailPolicy.toolAllowlist` above, so exposure and authority can
  // never drift apart.
  const exposedNames = profileAllowlist
    ? profileAllowlist.map((name) => (
      isOutcomeTool(name) ? OUTCOME_MCP_TOOL_NAMES[name] : `mcp__breeze__${name.split(':')[0]}`
    ))
    : BREEZE_MCP_TOOL_NAMES;

  // F2 fix (P2-1 second live check): `allowedTools` above only gates
  // PERMISSION to call a tool — the MCP server still sends every REGISTERED
  // tool's full schema to the model on every turn regardless of
  // `allowedTools`. `onlyTools` (createBreezeMcpServer's 6th param) narrows
  // what gets registered in the first place. Reuses `profileAllowlist` again
  // — same source of truth as `exposedNames`/`guardrailPolicy.toolAllowlist`
  // above — collapsed to bare tool names (`manage_alerts:list` and
  // `manage_alerts:get` both collapse to `manage_alerts`) with the outcome
  // tool excluded: an outcome tool is never in the registry `tools`
  // array to begin with (see outcomeTools.ts) — it rides on `extraTools`
  // below instead, which `createBreezeMcpServer` always includes regardless
  // of `onlyTools`. Full runs pass no `onlyTools` and keep registering the
  // whole registry, unchanged.
  const onlyTools = profileAllowlist
    ? new Set(profileAllowlist.map((name) => name.split(':')[0]!).filter((name) => !isOutcomeTool(name)))
    : undefined;

  // No getActiveSession: a headless run has no ActiveSession, and the
  // session-aware tools (M365/Google) correctly refuse without one. The
  // profile's outcome tool (`submit_alert_verdict` for verdict,
  // `submit_sweep_findings` for sweep) is passed as `extraTools`; `full`
  // gets an EMPTY array from `outcomeToolsForProfile`, so it never even
  // registers one on the MCP server, let alone exposes it via
  // `allowedTools`.
  const mcpServer = createBreezeMcpServer(() => agentAuth, preToolUse, postToolUse, undefined,
    buildOutcomeSdkTools(outcomeToolsForProfile(run.profile)),
    onlyTools ? { onlyTools } : undefined);

  const prompt = promptContext(ctx, effective);
  const abortController = new AbortController();
  let wallClockExceeded = false;
  let budgetExceeded = false;
  const wallClockTimer = setTimeout(() => {
    wallClockExceeded = true;
    abortController.abort();
  }, wallClockMs);
  // The run's own status row is the durable record; never hold the event loop.
  wallClockTimer.unref?.();

  let summary = '';
  let failure: LoopResult['failure'];
  let maxTurnsExceeded = false;
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
          maxTurns: Math.max(1, runLimits.maxTurnsPerRun),
          // Belt to the mid-stream braces below: the SDK stops itself, and the
          // loop stops the SDK if a result lands over budget anyway.
          maxBudgetUsd: runLimits.maxBudgetCentsPerRun / 100,
          tools: [],
          allowedTools: [...new Set(exposedNames)],
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

          // Exhaustive on purpose — see RESULT_DISPOSITIONS. `is_error` on a
          // 'success' subtype is treated as a failure too: the SDK's own
          // is_error flag is the broader signal of the two.
          const disposition = dispositionForResultSubtype(message.subtype);
          if (disposition.kind === 'ceiling') {
            if (disposition.flag === 'budgetExceeded') budgetExceeded = true;
            else maxTurnsExceeded = true;
            abortController.abort();
            break;
          }
          if (disposition.kind === 'failure' || message.is_error === true) {
            const errors = (message as unknown as { errors?: unknown }).errors;
            const detail = Array.isArray(errors) && errors.length > 0
              ? errors.map((e) => String(e)).join('; ')
              : `SDK returned ${message.subtype}`;
            failure = {
              errorCode: disposition.kind === 'failure' ? disposition.errorCode : 'sdk_error',
              message: detail,
            };
            console.error('[aiAgentRunLoop] SDK returned a terminal error result', {
              runId: run.id, subtype: message.subtype, detail,
            });
            abortController.abort();
            break;
          }

          if (costCents > runLimits.maxBudgetCentsPerRun) {
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
    // An abort we asked for is a controlled stop, not a crash — including the
    // abort issued for an SDK error result, whose `failure` is already set and
    // must not be overwritten by the AbortError it provokes.
    if (wallClockExceeded || budgetExceeded || maxTurnsExceeded || failure) {
      console.warn('[aiAgentRunLoop] SDK loop aborted', {
        runId: run.id, wallClockExceeded, budgetExceeded, maxTurnsExceeded,
        errorCode: failure?.errorCode ?? null,
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
  if (maxTurnsExceeded) outcome.maxTurnsExceeded = true;

  // Org-level AI spend accounting, so neither budget gate is blind to agent
  // traffic. `recordUsage(null, …)` used to stand here and was wrong twice
  // over: it re-priced from plain input/output counters (dropping the cache
  // tokens that are most of an agent prompt, and discarding the SDK's
  // authoritative cost this run row stores), and it deducts NO platform AI
  // credits — so a platform-billed run was effectively free and `checkBudget`
  // kept admitting runs after the credits were gone. Best-effort: an accounting
  // failure never redefines the run's outcome.
  try {
    await recordSessionlessSdkUsage(
      run.orgId,
      {
        costCents,
        usage,
        numTurns: turnCount,
        toolExecutionCount: outcome.toolExecutionCount,
        model,
      },
      billingSource,
    );
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to record org AI usage', { runId: run.id, error });
  }

  return {
    summary: summary.slice(0, RUN_SUMMARY_MAX_CHARS),
    costCents: Math.round(costCents),
    turnCount,
    outcome,
    intentIds,
    agentAuth,
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
  const stopped = await isStoppedBeforeStart(run.orgId, agent.kind, run.agentId);
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

  // Tracks what to log the ledger session as closing under (see
  // `cleanupExecutionLedger`) — defaults to 'failed' so a throw anywhere below,
  // including one before this is ever reassigned, closes it correctly.
  let ledgerOutcome: 'completed' | 'failed' = 'failed';

  try {
    const result = await driveSdkLoop(ctx, effective);
    const { outcome, intentIds } = result;
    // Computed once here so every terminal path below (failure, ceiling, or
    // normal finish) carries the same rollup — `finishRun` serializes
    // `result.outcome` verbatim into the DB row.
    outcome.runVerdict = computeRunVerdict(outcome);

    // Phase 2 wave P2-1 (alert verdicts), Task 8 — review round 1
    // (IMPORTANT 3): verdict persistence + suggestion→intent linking runs
    // HERE, before the awaiting_approval/completed decision further down,
    // so a newly created pending intent is counted by
    // `intentIds.length > 0` — a verdict run whose suggestion produced a
    // pending approval must itself finish `awaiting_approval`, like any
    // other run with a pending intent. `verdictErrorCode` is applied ONLY
    // at the normal-finish `finishRun` call below (not to the `failure`/
    // `ceiling` branches, which already carry a real, more specific code —
    // see `finalizeVerdict`'s own docstring for why).
    const verdictErrorCode = await finalizeVerdict(ctx, result);
    // Task A7 (wave P2-2) — the sweep sibling, same placement and for the
    // same reason: proposal→intent conversion must happen BEFORE the
    // awaiting_approval/completed decision below so a freshly created pending
    // intent is counted by `intentIds.length > 0`. A run is either a verdict
    // run or a sweep run, never both, so at most one of these two codes is
    // ever non-null.
    const sweepErrorCode = await finalizeSweep(ctx, result);
    // Task A7 (wave P2-3) — third in the same row and for the same reason: it
    // persists the narrative as a system-authored report artifact and links
    // `ai_agent_runs.report_run_id` BEFORE the awaiting_approval/completed
    // decision below, and — the ordering that actually matters here — before
    // `finishRun` emits the notification that POINTS AT that artifact. A run
    // is exactly one of verdict / sweep / narrative, so at most one of the
    // three error codes below is ever non-null.
    const narrativeErrorCode = await finalizeNarrative(ctx, result);
    // Task A8 (wave P2-4) — fourth in the same row, same reason: a triage
    // run's proposal->intent conversion must happen BEFORE the
    // awaiting_approval/completed decision below so a freshly created
    // pending (or creation-time `ticket_autonomy`-approved) intent is
    // counted correctly. A run is exactly one of verdict / sweep /
    // narrative / triage, so at most one of the four error codes below is
    // ever non-null.
    const ticketTriageErrorCode = await finalizeTicketTriage(ctx, result);

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
    // useful work finishes normally, with the flag in `outcome`. A verdict
    // run's "useful work" IS `outcome.alertVerdict` (review fix, wave P2-1 fix
    // round 1) — without this, a verdict run that called `submit_alert_verdict`
    // and then hit `error_max_turns` with no further prose would finish
    // `failed('max_turns_exceeded')` despite having done its ONE job, wrongly
    // counting against the agent's circuit breaker (`recordRunTerminal`).
    //
    // `outcome.budgetExceeded` itself is relative to THIS run's effective
    // budget (`runLimits.maxBudgetCentsPerRun` above) — for a verdict-profile
    // run that's `verdictBudgetCentsPerRun` (5 cents by default, see
    // `verdictProfile.ts`'s `verdictLimits`), not the agent's top-level
    // `maxBudgetCentsPerRun` (50 cents by default). Don't read a verdict run's
    // `budgetExceeded: true` as "spent close to 50 cents" — it means the run
    // crossed its own, much smaller, profile ceiling.
    const producedSomething =
      outcome.executedActions.length > 0
      || outcome.proposedActions.length > 0
      || outcome.alertVerdict !== undefined
      // Same rule for a sweep run's ONE job (wave P2-2, task 6): a run that
      // called `submit_sweep_findings` and only then hit `error_max_turns`
      // has produced exactly what it was admitted to produce, and must not
      // be counted a ceiling failure against the agent's circuit breaker.
      || outcome.sweepFindings !== undefined
      // Same rule again for a narrative run's ONE job (wave P2-3, task 6),
      // and it bites harder here than for either sibling: `narrativeMaxTurns`
      // is 3 by default, so a run that submits on its last turn and then has
      // no turn left to write a closing sentence is the COMMON case, not an
      // edge one. Without this it would finish `failed('max_turns_exceeded')`
      // holding a complete, publishable narrative.
      || outcome.narrative !== undefined
      // Same rule again for a triage run's ONE job (wave P2-4, task A6): a
      // run that called `submit_ticket_proposal` and only then hit
      // `error_max_turns` has produced exactly what it was admitted to
      // produce (a proposal task A8 still has to turn into anything), and
      // must not be counted a ceiling failure against the circuit breaker.
      || outcome.ticketProposal !== undefined
      || result.summary.trim().length > 0;

    const ceiling = outcome.wallClockExceeded
      ? 'wall_clock_exceeded'
      : outcome.budgetExceeded
        ? 'budget_exceeded'
        : outcome.maxTurnsExceeded
          ? 'max_turns_exceeded'
          : null;
    if (!producedSomething && ceiling) {
      await finishRun(ctx, 'failed', ceiling, result);
      return;
    }

    // Awaiting approval is a REAL terminal-ish state for the run: the agent is
    // done thinking and a human now owns the decision. Release of an approved
    // intent is 3b's machinery, not a continuation of this run.
    //
    // Task A8 (wave P2-4): a plain `intentIds.length > 0` check is no longer
    // sufficient — a triage run's `ticket_autonomy` grant can create intents
    // that are ALREADY decided (`approved`, no human fan-out ever ran) at
    // the moment they're minted. `classifyIntentAwaitingApproval` excludes
    // those (`result.decidedIntentIds`) from the count; every other
    // profile's finalizer only ever links a `pending_approval` id, so
    // `decidedIntentIds` stays empty and this is behaviorally IDENTICAL to
    // the old check for verdict/sweep/narrative/full runs.
    ledgerOutcome = 'completed';
    await finishRun(
      ctx,
      classifyIntentAwaitingApproval(intentIds, result.decidedIntentIds) ? 'awaiting_approval' : 'completed',
      verdictErrorCode ?? sweepErrorCode ?? narrativeErrorCode ?? ticketTriageErrorCode,
      result,
    );
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
  } finally {
    // Fires on every path that got far enough to create a session — the
    // normal finish, the `!moved` early return inside `finishRun`, AND a throw
    // between session creation and `finishRun` (see `cleanupExecutionLedger`'s
    // docstring). A crashed process (SIGKILL) is the one path this cannot
    // cover; `reapStalledAgentRuns` (`runService.ts`) covers that one instead.
    await cleanupExecutionLedger(ctx, ledgerOutcome);
  }
}

const TERMINAL_EVENT = {
  completed: 'ai.agent.run.completed',
  awaiting_approval: 'ai.agent.run.awaiting_approval',
  failed: 'ai.agent.run.failed',
} as const;

/**
 * Act-execution op evidence (Task 6, P2-5, #4192) — one `executed`/`failed`
 * row per executed action carrying an `actOpKey`, keyed by the action's
 * INDEX in `executedActions` (`actEvidenceSourceId`, Deviation #4:
 * `executionId` falls back to the literal `'(inline)'` when the execution-
 * ledger write itself failed, so it is not unique within a run — the index
 * is). The ONLY caller is `finishRun`, after its terminal CAS already won,
 * so this runs at most once per winning executor. Unconditional on `status`/
 * `watches` on purpose: an action can genuinely execute before a run later
 * fails for an unrelated reason, and that execution still earns evidence.
 *
 * `watchId === null` means no watch will EVER verify this run — either
 * `scheduleFixWatch` was never even attempted (`watches` false, or `status`
 * not `'completed'`: exactly the runs the extensive comments above document
 * as executing nothing, so this is a no-op for them in practice) or it WAS
 * attempted and came back null (an ineligible run, or a genuinely failed
 * `createFixWatchRow` — see `scheduleFixWatch`'s own header for why null
 * means exactly that and nothing else after Task 5). Either way, every
 * `executed` action whose own verification did NOT fail is credited an
 * immediate `verified` row on the SAME source id, since no later watch
 * verdict will ever supply one. A non-null `watchId` means a watch row
 * exists and `checkFixWatchPhase2` (fixWatch.ts) will supply
 * `verified`/`recurred` later — this function credits nothing extra in
 * that case.
 *
 * Best-effort and non-fatal, like every other post-CAS side effect in this
 * function (`deliverRunFinishedNotifications` above): a ledger write
 * failure must never retroactively change how this run's terminal outcome
 * is reported.
 */
async function recordActExecutionEvidence(
  run: RunRow,
  executedActions: OutcomeExecutedAction[],
  watchId: string | null,
): Promise<void> {
  const rows: OpEvidenceInsert[] = [];
  const occurredAt = new Date();
  const pushRow = (opKey: string, sourceId: string, metric: 'executed' | 'failed' | 'verified') => {
    rows.push({
      orgId: run.orgId,
      agentId: run.agentId,
      namespace: 'act_op',
      opKey,
      ruleId: null,
      sourceKind: 'act_execution',
      sourceId,
      metric,
      runId: run.id,
      occurredAt,
    });
  };

  for (const [index, action] of executedActions.entries()) {
    if (!action.actOpKey) continue;

    // Plan line 84 (C4 amendment) defines `executed` and `failed` as TWO
    // INDEPENDENT rules, not an if/else — the UNIQUE constraint is
    // `(source_kind, source_id, metric)`, so the same sourceId can legally
    // carry both metrics. `executed` = "attempted AND the executor reported
    // success" (`execution === 'succeeded'`), full stop. `failed` = an
    // ATTEMPTED failure: the dispatch itself failed, OR it dispatched but
    // never resolved cleanly (`timeout`/`unknown` — `isFixWatchEligible`,
    // fixWatch.ts, already documents these as "not clean"), OR it dispatched
    // successfully but its own verification failed (the disk-cleanup shape:
    // the command ran, but the check that grades it failed). A dispatch that
    // succeeded AND whose verification failed therefore earns BOTH rows —
    // the executor did its job; the outcome was still bad.
    const isExecuted = action.execution === 'succeeded';
    const isFailedAttempt =
      action.execution === 'failed' ||
      action.execution === 'timeout' ||
      action.execution === 'unknown' ||
      action.verification === 'failed';
    if (!isExecuted && !isFailedAttempt) continue;

    const sourceId = actEvidenceSourceId(run.id, index);
    if (isExecuted) pushRow(action.actOpKey, sourceId, 'executed');
    if (isFailedAttempt) pushRow(action.actOpKey, sourceId, 'failed');

    // No watch will ever verify this run, so a successfully-dispatched
    // action is credited immediately — UNLESS its own inline verification
    // already failed, in which case it must never be credited `verified`
    // even though the dispatch itself succeeded (it also just earned a
    // `failed` row above).
    if (isExecuted && watchId === null && action.verification !== 'failed') {
      pushRow(action.actOpKey, sourceId, 'verified');
    }
  }
  if (rows.length === 0) return;

  try {
    await inSystemDbContext(() => insertOpEvidence(rows));
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to write act-execution op evidence (non-fatal)', {
      runId: run.id, error,
    });
  }
}

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

  // Ledger cleanup happens in `executeAgentRun`'s `finally`, not here — this
  // function is skipped entirely on the `!moved` branch above (another
  // executor or `reapStalledAgentRuns` already owns this run), which is
  // exactly the case the ledger cleanup exists for. See the note there.

  // `deliverRunFinishedNotifications` re-reads the run row it just committed
  // above (Task 6, #3826) rather than taking `status`/`result` in-process —
  // see runFinishedNotify.ts's header for why the retry worker needs the
  // SAME by-id entry point. A failure here must never redefine the run's
  // terminal status, so it's caught here and durably retried instead of
  // left to just fail silently as the old inline version did.
  //
  // Review fix (wave P2-1 fix round 1): a verdict run is skipped entirely —
  // its "finished" surface is the alert badge/classification, not a run
  // notification a technician has to act on, and `scheduleFixWatch` just
  // below is act-lane only (a verdict run never executes anything to watch
  // for regression). Both are best-effort/failure-tolerant machinery built
  // for `full`-profile runs; there is nothing here for a verdict run to skip
  // INTO a gap — this is a deliberate no-op, not a missing feature.
  //
  // Wave P2-2 (task 6) SPLIT the two: a SWEEP run does notify. Nobody is
  // watching a 06:00 cron occurrence, and unlike a verdict it leaves no
  // badge on an alert row a technician was already looking at — the
  // run-finished notification IS the surface for it. It still schedules no
  // fix-watch: a sweep executes nothing, so there is no fix whose
  // regression could be watched for.
  //
  // Wave P2-3 (task 6): a NARRATIVE run lands on the same side of both splits
  // as a sweep, for the same two reasons — nobody is watching a Monday 07:00
  // occurrence and it leaves no badge on a row someone was already looking
  // at (so it notifies), and it executes nothing (so there is no fix to
  // watch). Task A7 re-points the notification's title/link at the stored
  // report artifact; the DECISION to notify at all is this line.
  //
  // Wave P2-4 (task A6): `notifies` is left as-is here — a triage run is not
  // excluded (only `verdict` is), so it already falls on the "does notify"
  // side; what that notification actually SAYS for a triage run is task A9's
  // job in `runFinishedNotify.ts`, not this line. `watches` DOES gain the
  // triage exclusion: a triage run's tool floor is empty
  // (`TRIAGE_TOOL_ALLOWLIST`), so — exactly like sweep and narrative — it
  // executes nothing, and there is no fix whose regression `scheduleFixWatch`
  // could watch for.
  const notifies = !isVerdictProfile(ctx.run);
  const watches = !isVerdictProfile(ctx.run) && !isSweepProfile(ctx.run) && !isNarrativeProfile(ctx.run)
    && !isTriageProfile(ctx.run);

  if (notifies) {
    try {
      await deliverRunFinishedNotifications(ctx.run.id);
    } catch (error) {
      console.error('[aiAgentRunLoop] failed to notify run recipients — enqueuing durable retry', {
        runId: ctx.run.id, error,
      });
      await enqueueAgentNotifyRetry(ctx.run.id);
    }
  }

  // Fix-held watch scheduling (wave 6 PR 2, Task 3, #3828) — best-effort and
  // deliberately never affects this run's own status: `scheduleFixWatch`
  // swallows every failure internally (see its header). Only a clean
  // `completed` finish is eligible at all (`awaiting_approval`/`failed` never
  // are — `isFixWatchEligible` would reject them anyway via `modeAtStart`/
  // `verification`, but gating on `status` here avoids the query entirely on
  // the common non-completed paths).
  let watchId: string | null = null;
  if (watches && status === 'completed') {
    watchId = await scheduleFixWatch(
      { id: ctx.run.id, orgId: ctx.run.orgId, agentId: ctx.run.agentId, alertId: ctx.run.alertId, modeAtStart: ctx.run.modeAtStart },
      result.outcome,
    );
  }

  // Act-execution op evidence (Task 6, P2-5, #4192) — see
  // `recordActExecutionEvidence`'s own header for why this is unconditional
  // on `watches`/`status` rather than nested inside the block above.
  await recordActExecutionEvidence(ctx.run, result.outcome.executedActions, watchId);
}

/**
 * Best-effort execution-ledger cleanup, called from `executeAgentRun`'s
 * `finally` so it fires on EVERY path out of a run that got as far as
 * creating a session — not just the happy in-process finish. Covers:
 *  - `finishRun`'s `!moved` branch (another executor, or `reapStalledAgentRuns`,
 *    already transitioned this run out of `running`);
 *  - a throw between session creation and `finishRun` (e.g. `createBreezeMcpServer`
 *    or `transitionRunStatus` itself throwing), caught by `executeAgentRun`'s
 *    own catch block;
 *  - the normal path, where `finishRun` already committed the terminal status.
 *
 * `outcome` only distinguishes 'completed'/'failed' for `closeAgentRunSession`'s
 * log line — the same two-way collapse `finishRun` used to do inline
 * (`awaiting_approval` reads as 'completed': the agent is done thinking either
 * way, a human owning the follow-up is not the session continuing).
 */
async function cleanupExecutionLedger(
  ctx: RunContext,
  outcome: 'completed' | 'failed',
): Promise<void> {
  if (!ctx.sessionId) return;
  const sessionId = ctx.sessionId;
  try {
    const hungCount = await reconcileHungExecutions(sessionId);
    if (hungCount > 0) {
      console.warn('[aiAgentRunLoop] reconciled tool executions left in-flight at run finish', {
        runId: ctx.run.id, sessionId, hungCount,
      });
    }
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to reconcile hung executions (non-fatal)', {
      runId: ctx.run.id, sessionId, error,
    });
  }
  try {
    await closeAgentRunSession(sessionId, outcome);
  } catch (error) {
    console.error('[aiAgentRunLoop] failed to close the execution-ledger session (non-fatal)', {
      runId: ctx.run.id, sessionId, error,
    });
  }
}

/**
 * Kill switch + current effective policy. True means "do not start".
 *
 * `agentId` is not decoration. `resolveEffectiveAgentSystem` re-resolves by
 * (org, kind) and always reports the CURRENT partner baseline, so without this
 * comparison the gate could clear a run using a DIFFERENT agent's live policy:
 * disable agent A (the intended "stop it now"), create replacement B of the
 * same kind, and A's queued run sails through the gate and executes minutes
 * later under A's snapshot and A's wider allowlist. Identity has to match for
 * "still enabled" to mean anything.
 *
 * An org OVERRIDE does not trip this: the resolver reports the baseline id
 * either way, so ordinary org-level policy edits still reach the run through
 * the enabled/mode check alone.
 */
async function isStoppedBeforeStart(
  orgId: string,
  kind: AiAgentKind,
  agentId: string,
): Promise<boolean> {
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return true;

  // Wave 5A Task 2 (#3827): refresh the DB kill-state cache here, at
  // admission, so the run's whole tool-dispatch loop — which reads the
  // cached snapshot synchronously through `checkAgentGuardrails` — starts
  // from state at most 5s stale (`aiKillState.ts`'s own staleness-bound
  // note). Gate admission on it directly too, matching this function's own
  // "kill switch" doc comment and the env-flag check immediately above:
  // belt-and-suspenders with the guardrail's per-dispatch check, not a
  // replacement for it.
  const killState = await readAiKillState();
  if (killState.killed) {
    console.warn('[aiAgentRunLoop] AI kill switch is engaged — refusing to start', {
      orgId, kind, agentId, epoch: killState.epoch,
    });
    return true;
  }

  try {
    const current = await resolveEffectiveAgentSystem(orgId, kind);
    if (!current) return true;
    if (current.agentId !== agentId) {
      console.warn('[aiAgentRunLoop] the run\'s agent is no longer the effective agent', {
        orgId, kind, runAgentId: agentId, currentAgentId: current.agentId,
      });
      return true;
    }
    return !current.effective.enabled || current.effective.mode === 'off';
  } catch (error) {
    console.error('[aiAgentRunLoop] could not re-resolve the effective policy', { orgId, kind, error });
    return true;
  }
}
