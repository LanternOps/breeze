import { Job, Worker } from 'bullmq';
import type { AiAgentRecipients } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { actionIntents, type ActionIntent } from '../db/schema/actionIntents';
import { aiAgentRuns, aiAgents } from '../db/schema/aiAgents';
import { approvalRequests } from '../db/schema/approvals';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { recordActionIntentEvent, recordActionIntentMetric } from '../services/actionIntents/metrics';
import { createNotification } from '../services/userNotifications';
import { resolveRecipientUserIds } from '../services/aiAgents/recipients';
import { transitionIntent, type ActionIntentTransitionPatch } from '../services/actionIntents/intentService';
import { canonicalPolicyKey } from '../services/actionIntents/canonicalPolicyKey';
import { insertOpEvidence, intentEvidenceSourceId } from '../services/aiAgents/opEvidence';
import { createIntentFixWatchRow } from '../services/aiAgents/fixWatch';
import { enqueueFixWatchPhase1 } from './fixWatchWorker';
import { attemptPolicyDecision, PolicyDecisionTransientError } from '../services/actionIntents/policyDecide';
import { revalidateApprovedIntentForRelease } from '../services/actionIntents/revalidateRelease';
import { readAiKillState } from '../services/aiKillState';
import { computeEffectDigestForRelease, hasPinnedDigest } from '../services/actionIntents/effectDigest';
import type { ToolExecutionContext } from '../services/toolExecutionContext';
import { executeTool, requiresLiveSession } from '../services/aiTools';
import { withAuthDbAccessContext } from '../middleware/auth';
import { getToolTimeout, withToolTimeout } from '../services/toolTimeouts';
import {
  isHeadlessGoogleTool,
  executeGoogleToolHeadless,
  executeGoogleSecretToolHeadless,
  GOOGLE_HEADLESS_SECRET_ACTIONS,
  GoogleConnectionUnavailableError,
} from '../services/googleToolsHeadless';
import {
  isHeadlessM365Tool,
  executeM365ToolHeadless,
  M365ConnectionUnavailableError,
} from '../services/m365ToolsHeadless';
import { sealActionResultSecrets, TEMP_PASSWORD_ENC_KEY } from '../services/actionIntents/resultSecrets';
import {
  sealToolSecrets,
  assertNoPlaintextSecret,
  SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE,
  MAX_RESULT_BYTES,
  type SecretToolResult,
} from '../services/actionIntents/secretBearingTools';

/**
 * Durable release worker (spec
 * docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §5 / §10.3 / §8) — consumes `intent_approved` jobs off the `action-intents`
 * BullMQ queue (populated by `jobs/intentOutboxPublisher.ts`) and, for each,
 * re-validates the approval is still good and RE-EXECUTES the tool through a
 * freshly rebuilt actor identity.
 *
 * SECURITY-CRITICAL trust boundary: a reconstructed identity is about to
 * execute a real, privileged Tier-3 action on behalf of a decision made
 * possibly minutes to (for `mcp_api` intents) a day earlier. Every step below
 * is fail-closed — any doubt CASes the intent straight to `failed` with a
 * categorized `error_code` and skips execution entirely. Never a silent
 * no-op, never a downgrade to "execute anyway."
 *
 * Job data: `{ intentId, eventType }`. `eventType === 'intent_approved'` is
 * the release trigger; `intent_created` is the wave 5 Part B (#3827)
 * policy-decide recovery hook (NOT flag-gated at this call site —
 * `attemptPolicyDecision` itself is the single source of truth for flag-off
 * inertness, see its own header); anything else is acknowledged as a no-op.
 *
 * CAS-idempotent by construction: the `approved -> executing` transition at
 * step 1 is a single-use release guard (mirrors the PAM `actuating` pattern).
 * A duplicate delivery of the same job (BullMQ jobId dedupe normally
 * prevents this, but retries happen) finds the intent already
 * `executing`/terminal, the CAS returns zero rows, and the handler exits
 * without calling `executeTool` a second time.
 */

const ACTION_INTENTS_QUEUE_NAME = 'action-intents';
// MAX_RESULT_BYTES (spec §5 step 4) is imported from secretBearingTools.ts,
// shared with the inline (chat-session) completion path in aiAgentSdk.ts, so
// the two paths that persist to the same action_intents.result column
// cannot drift apart on the size cap.

type IntentReleaseJobData = { intentId: string; eventType: string };

let releaseWorker: Worker<IntentReleaseJobData> | null = null;

/**
 * Minimal, dependency-free equivalent of `aiAgentSdk.ts`'s `safeParseJson`:
 * normalizes a tool's raw string result into a JSON object suitable for the
 * `action_intents.result` jsonb column. Deliberately NOT imported from
 * `aiAgentSdk.ts` — that module pulls in the entire chat-session dependency
 * graph (streaming session manager, cost tracker, M365 helpers, ...), which
 * has no business being a transitive dependency of the release worker for
 * the sake of one pure formatting helper. Same fallback shape as the chat
 * SDK's normalization (`{ value }` for non-object JSON, `{ raw }` for
 * non-JSON text) so a stored intent result and a stored ai_tool_executions
 * result look the same to anything reading either.
 */
function normalizeToolResult(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

/**
 * Wave-5A review fix (#3827): CAS `executing -> approved` (undoing the claim
 * `releaseApprovedIntent` took at step 1) instead of `failIntent`'s
 * `executing -> failed`. `agentReleaseAuthority.ts`'s 'kill_switch_engaged'
 * errorCode is deliberately distinct from 'agent_policy_denied' for exactly
 * this reason: a kill-derived denial (a real DB kill-switch flip, or the
 * fail-closed synthetic state a transient DB read failure produces) must
 * never terminally fail an already-human-approved intent. Leaving the row
 * `approved` means it stays claimable by the next `intent_approved` job
 * delivery/retry, and — if nothing ever releases it — is reaped into
 * `expired` by `jobs/intentExpiryReaper.ts` once its `release_by` lease
 * passes, same as any other still-`approved` intent. That is a normal,
 * non-destructive terminal state, unlike `failed`.
 *
 * Lost CAS (`won === false`) mirrors `failIntent`'s own race handling: some
 * other delivery already moved this row (e.g. the stale-executing reaper
 * already reaped it to `failed:execution_lost`) — nothing further to do.
 */
async function pauseIntentForKillSwitch(
  intent: ActionIntent,
  details?: Record<string, unknown>,
): Promise<void> {
  const won = await transitionIntent(intent.id, 'executing', 'approved');
  if (!won) return;
  const message = `[IntentReleaseWorker] intent ${intent.id} release paused — kill switch engaged`;
  console.warn(message, details);
  captureException(new Error(message));
}

/**
 * A tool handler can return successfully (no thrown error) but hand back a JSON
 * body that IS an error — validation failures, device/org access-denied, etc.
 * (`executeTool` returns `JSON.stringify({ error })` for these; see aiTools.ts).
 * The chat SDK's makeHandler (aiAgentSdkTools.ts) flags exactly these as
 * `isError`; the durable release worker MUST apply the SAME detection or a
 * returned error gets recorded as a successful completion (a real audit-integrity
 * bug — e.g. "device access revoked after approval" would read as success).
 * Kept as a local duplicate of the SDK predicate for the same dependency-graph
 * reason `normalizeToolResult` is (avoid dragging the chat-session graph into
 * this worker); the two must stay in lockstep.
 */
function isReturnedToolError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      !('success' in parsed) &&
      !('data' in parsed) &&
      !('configured' in parsed)
    );
  } catch {
    return false;
  }
}

/**
 * Writes the `action_intent.executed` audit row + Prometheus counter for a
 * FAILED release (any revalidation stop, or a thrown `executeTool`).
 *
 * Does NOT use `recordActionIntentEvent`: its `ActionIntentOutcome` enum
 * (services/actionIntents/metrics.ts) only treats `rejected` / `expired` /
 * `cancelled` as audit failures (`FAILURE_OUTCOMES`) — there is no "outcome
 * executed, but it failed" member, so recording outcome `'executed'` through
 * that helper would mis-file every release failure as `result: 'success'`.
 * This mirrors the exact fallback `jobs/intentExpiryReaper.ts`'s
 * `reapStaleExecutingIntents` already uses for the same enum gap: write the
 * audit row directly with `result: 'failure'`, then bump the Prometheus
 * counter separately via `recordActionIntentMetric` so `executed` totals
 * still include this path.
 */
function auditReleaseFailure(
  intent: ActionIntent,
  errorCode: string,
  details?: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: intent.orgId,
      action: 'action_intent.executed',
      resourceType: 'action_intent',
      resourceId: intent.id,
      actorType: 'system',
      actorId: null,
      result: 'failure',
      details: {
        actionName: intent.actionName,
        argumentDigest: intent.argumentDigest,
        source: intent.source,
        errorCode,
        ...details,
      },
    });
    recordActionIntentMetric(intent.source, intent.actionName, 'executed');
  } catch (err) {
    console.error(`[IntentReleaseWorker] Failed to write failure audit for intent ${intent.id}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * True iff this durable worker cannot release `toolName` because it requires
 * a live chat SSE session (services/aiTools.ts's requiresLiveSession) and has
 * no headless Google/M365 dispatch path (googleToolsHeadless.ts /
 * m365ToolsHeadless.ts). Exported so
 * jobs/intentReleaseWorker.durable.contract.test.ts (tier3-supervised-four-eyes
 * design task 9) can assert every four_eyes-classified tool is durably
 * releasable — a four_eyes intent's whole reason for existing is to survive
 * past the requesting chat session (a second approver may decide it minutes
 * or hours later), so if the tool is ALSO session_required here, an approved
 * four_eyes intent could sit forever with nothing able to execute it.
 */
export function isSessionRequiredForRelease(toolName: string): boolean {
  return (
    !isHeadlessGoogleTool(toolName)
    && !isHeadlessM365Tool(toolName)
    && requiresLiveSession(toolName)
  );
}

/**
 * The subset of `ActionIntentTransitionPatch` a TERMINAL write may carry.
 * Narrower than the full patch on purpose: `decided*` / `executionStartedAt`
 * belong to the decide and claim transitions, not to terminalization.
 */
type TerminalPatch = Pick<ActionIntentTransitionPatch, 'executedAt' | 'errorCode' | 'result'>;

/**
 * True iff this terminal write represents an ATTEMPTED operation — the one
 * discriminator the graduation ledger grades on (P2-5, #4192; spec §4.5).
 *
 * The discriminator is already in this file and already documented: a
 * terminal write stamps `executed_at` exactly when the provider-side effect
 * happened. `failIntent`'s `executed: true` option marks `execution_error`
 * and `secret_seal_invariant_violated` — "both of which mean a real attempt
 * was made … the earlier revalidation stops never touched execution" — and
 * the `tool_returned_error` and success CASes stamp it directly. There is
 * deliberately no second, hand-maintained list of "which branches count":
 * a new terminal exit is classified by whether it stamps `executedAt`, so
 * the two can never drift apart.
 */
function isAttemptedTerminal(patch: TerminalPatch): boolean {
  return patch.executedAt != null;
}

/**
 * What a written evidence row leaves behind for the verification lane: the
 * effective agent, the triggering alert (if any) an intent-anchored fix watch
 * would hang off, and the exact op key + source id the `verified` /
 * `recurred` row must reuse. Loaded once, inside the terminal transaction —
 * a second round trip for `alert_id` alone would be pure waste.
 */
interface IntentEvidenceAnchor {
  agentId: string;
  alertId: string | null;
  opKey: string;
  sourceId: string;
  runId: string;
}

/**
 * Writes the ONE `ai_agent_op_evidence` row this terminal outcome earns
 * (P2-5, #4192), in a SAVEPOINT nested inside the terminal CAS's
 * transaction. `terminalizeIntent` is the only caller, and it is what opens
 * that transaction.
 *
 * **The evidence write is the side that yields.** The ledger is a grading
 * side-channel; the terminal state is the record of a real-world side effect
 * and outranks it. If an insert failure (a 23503 on the `agent_id` or the
 * composite `(run_id, org_id)` FK, a CHECK, a transient error) were allowed
 * to propagate, it would unwind an `executing -> completed` CAS for an action
 * that ALREADY RAN: the throw escapes `releaseApprovedIntent`, BullMQ
 * redelivers, the claim CAS `approved -> executing` loses because the row is
 * still `executing`, and the stale-executing reaper terminalizes it
 * `failed:execution_lost` — a successful action permanently recorded as a
 * failure, with no result stored, no success audit and no notification. So a
 * failure here rolls back to the SAVEPOINT and is captured, never rethrown.
 * The happy path is still a single atomic commit, which is what the plan
 * asks for; only the losing side changed.
 *
 * The SAVEPOINT must actually RECEIVE the statements, which is why the
 * executor is threaded explicitly instead of using the ambient `db` proxy:
 * postgres-js records the first failed query of a transaction scope in that
 * scope's `uncaughtError` and rethrows it when the scope ends, EVEN IF the
 * caller caught the rejection (`postgres/src/index.js`'s `scope()`), so a
 * statement issued through the OUTER scope would abort the outer transaction
 * no matter how it is wrapped. `insertOpEvidence`'s second parameter exists
 * for exactly this.
 *
 * Only AGENT-originated intents produce evidence: a human/chat/MCP release
 * has no agent to grade, and `requesting_agent_run_id` is the column that
 * says so. The run row is loaded predicated by BOTH `id` AND `org_id` (RLS
 * passes unconditionally under a system context, so the org predicate is the
 * real isolation here), which also yields the EFFECTIVE agent id the run
 * recorded — `ai_agent_runs.agent_id` is the partner-baseline row, which is
 * exactly the grain graduation tracks. A run that is not readable in this
 * org writes nothing rather than guessing an agent id.
 *
 * `alert_id` rides along on the same read: the released-intent fix watch
 * (Task 5) is anchored to the triggering alert and must not pay for a second
 * round trip inside the same transaction. That is what the RETURN value is —
 * the anchor `watchReleasedIntent` needs. It is null whenever no ledger row
 * was written (a human intent, an unreadable run, or a failed insert), which
 * deliberately suppresses the watch too: a `verified` / `recurred` row whose
 * `executed` counterpart never landed would read to `graduationService` as a
 * verification of an operation that never happened.
 *
 * Leak rules: identifiers only — `op_key`, ids, timestamps. Never a tool
 * result, an error message, or any model-authored text.
 */
async function recordIntentTerminalEvidence(
  intent: ActionIntent,
  metric: 'executed' | 'failed',
): Promise<IntentEvidenceAnchor | null> {
  const runId = intent.requestingAgentRunId;
  if (!runId) return null;

  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ agentId: aiAgentRuns.agentId, alertId: aiAgentRuns.alertId })
        .from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, intent.orgId)))
        .limit(1);
      if (!run) return null;

      const anchor: IntentEvidenceAnchor = {
        agentId: run.agentId,
        alertId: run.alertId,
        // The SHARED resolver, never a second ad hoc parse of `arguments` —
        // the graduation ledger and the policy-decide registry must agree on
        // what "this operation" is called or a promoted key grades the wrong
        // evidence (services/actionIntents/canonicalPolicyKey.ts).
        opKey: canonicalPolicyKey(intent.actionName, intent.arguments),
        sourceId: intentEvidenceSourceId(intent.id),
        runId,
      };

      await insertOpEvidence(
        [
          {
            orgId: intent.orgId,
            agentId: anchor.agentId,
            namespace: 'policy_key',
            opKey: anchor.opKey,
            ruleId: null,
            sourceKind: 'intent',
            sourceId: anchor.sourceId,
            metric,
            runId,
            occurredAt: new Date(),
          },
        ],
        tx,
      );
      return anchor;
    });
  } catch (error) {
    // Loud, but never at the cost of a terminal state that records a real
    // side effect. Identifiers only in the message — no tool result, no
    // model-authored text.
    captureException(
      new Error(
        `ai_agent_op_evidence write failed for intent ${intent.id} (metric ${metric}); terminal state kept`,
        { cause: error },
      ),
    );
    return null;
  }
}

/**
 * Opens the VERIFICATION episode for a successfully released intent (P2-5
 * Task 5, #4192 — closes #4206), in its OWN SAVEPOINT nested inside the
 * terminal CAS's transaction. Returns the watch id whose phase-1 job the
 * caller must enqueue AFTER that transaction commits, or null when there is
 * nothing to enqueue.
 *
 * A separate savepoint from the ledger write on purpose: the `executed` row
 * is already earned, and a watch insert that trips a constraint must not roll
 * it back — nor, per `recordIntentTerminalEvidence`'s own header, the
 * terminal state of an action that already ran.
 *
 * Three outcomes, and the difference between them is the whole point:
 *  - a watch row exists → return its id; the watch will grade this operation
 *    `verified` or `recurred` (Task 6), so nothing is credited now;
 *  - no watch is POSSIBLE (the run has no triggering alert, or that alert is
 *    no longer readable in this org) → credit `verified` on the same source
 *    id, in the same transaction. C4: an operation no watch will ever look at
 *    must not sit un-gradeable forever;
 *  - the attempt FAILED → credit nothing. An operation whose verification
 *    lane was lost is not "verified", and the ledger is immutable.
 */
async function watchReleasedIntent(
  intent: ActionIntent,
  anchor: IntentEvidenceAnchor | null,
): Promise<string | null> {
  if (!anchor) return null;

  try {
    return await db.transaction(async (tx) => {
      if (anchor.alertId) {
        const watchId = await createIntentFixWatchRow(
          {
            intentId: intent.id,
            orgId: intent.orgId,
            runId: anchor.runId,
            agentId: anchor.agentId,
            alertId: anchor.alertId,
            opKey: anchor.opKey,
          },
          tx,
        );
        if (watchId) return watchId;
      }

      await insertOpEvidence(
        [
          {
            orgId: intent.orgId,
            agentId: anchor.agentId,
            namespace: 'policy_key',
            opKey: anchor.opKey,
            ruleId: null,
            sourceKind: 'intent',
            sourceId: anchor.sourceId,
            metric: 'verified',
            runId: anchor.runId,
            occurredAt: new Date(),
          },
        ],
        tx,
      );
      return null;
    });
  } catch (error) {
    captureException(
      new Error(
        `fix watch for released intent ${intent.id} could not be opened; terminal state kept`,
        { cause: error },
      ),
    );
    return null;
  }
}

/**
 * Runs a terminal CAS and, only when it WINS, the evidence write, inside ONE
 * outer system transaction (P2-5, #4192).
 *
 * `transitionIntent` opens its own `withSystemDbAccessContext`
 * (intentService.ts), and a nested context JOINS an ambient one
 * (db/index.ts's `withDbAccessContext`: `if (dbContextStorage.getStore())
 * return fn()`), so the CAS and the evidence row land in the same commit.
 * That atomicity is the point in ONE direction: an evidence row can only
 * exist for an outcome that actually became terminal, so a rolled-back CAS
 * can never leave a phantom row behind. It is deliberately NOT symmetric —
 * the evidence insert runs in its own SAVEPOINT and a failure there is
 * captured, not rethrown (see `recordIntentTerminalEvidence`): the ledger is
 * a grading side-channel, while the terminal state is the record of a
 * real-world side effect, and rolling a completed action back to
 * `executing` to protect a counter trades a permanent, silent
 * `failed:execution_lost` for a missing row that Sentry names out loud.
 *
 * NEVER wraps `executeTool` — the worker deliberately executes outside any
 * DB context so a slow external call cannot pin a pooled connection
 * idle-in-transaction. The audit/metric writes stay OUTSIDE too, exactly
 * where they were: they are best-effort reporting, and a failing audit must
 * not undo a committed terminal state.
 *
 * `onWon` is the in-transaction extension hook — Task 5's released-intent fix
 * watch hangs off it. It runs AFTER the evidence insert and only when the CAS
 * won, and receives whatever that insert resolved (the effective agent, the
 * triggering alert, the op key) so it needs no second read of its own.
 */
async function terminalizeIntent(
  intent: ActionIntent,
  to: 'completed' | 'failed',
  patch: TerminalPatch,
  onWon?: (anchor: IntentEvidenceAnchor | null) => Promise<void>,
): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const won = await transitionIntent(intent.id, 'executing', to, patch);
    if (!won) return false;
    let anchor: IntentEvidenceAnchor | null = null;
    if (isAttemptedTerminal(patch)) {
      anchor = await recordIntentTerminalEvidence(intent, to === 'completed' ? 'executed' : 'failed');
    }
    if (onWon) await onWon(anchor);
    return true;
  });
}

/**
 * CAS `executing -> failed` with the given `error_code`, then (only if the
 * CAS actually won) writes the failure audit/metric. `executed: true` also
 * stamps `executedAt` — used for `execution_error` and
 * `secret_seal_invariant_violated`, both of which mean a real attempt was
 * made (the provider-side call happened); the earlier revalidation stops
 * (digest/tier/actor/org) never touched execution, so they leave
 * `executedAt` null.
 */
async function failIntent(
  intent: ActionIntent,
  errorCode: string,
  options: { details?: Record<string, unknown>; executed?: boolean } = {},
): Promise<void> {
  // Routed through `terminalizeIntent` so `executed: true` — the ONE
  // attempted-ness discriminator — also writes the `failed` evidence row in
  // the same transaction as the CAS. The non-attempted stops (every
  // revalidation/digest/session refusal) pass no `executedAt` and so write
  // nothing, which is the whole point: an agent is never graded down for an
  // action it was refused permission to try.
  const won = await terminalizeIntent(intent, 'failed', {
    errorCode,
    ...(options.executed ? { executedAt: new Date() } : {}),
  });
  if (!won) {
    // Lost the race — e.g. the stale-executing reaper (jobs/intentExpiryReaper.ts)
    // already flipped this intent to failed:execution_lost, or a duplicate
    // job delivery got here first. The intent is terminal either way; avoid
    // a duplicate audit write for an event that already happened once.
    return;
  }
  auditReleaseFailure(intent, errorCode, options.details);
}

/**
 * `assertNoPlaintextSecret` is defense-in-depth that should never fire in
 * practice — `sealToolSecrets`/`sealActionResultSecrets` always either seal
 * the credential or drop it (fail closed) before a result reaches either
 * persistence call site. If it DOES fire, that means a bug let a plaintext
 * credential reach the persistence boundary — and by that point the
 * provider-side action already happened (the password WAS reset; this is
 * not a validation stop that ran before execution). Two things follow from
 * that, both required by the "fail closed on confidentiality" + "tell the
 * operator to re-reset" global constraints:
 *
 * 1. `executed: true` MUST be passed to `failIntent` so `executedAt` gets
 *    stamped. Without it, the stale-executing reaper later reaps this intent
 *    to `failed:execution_lost` with `executedAt` still null — which the
 *    reaper's own contract defines as "the worker died mid-flight, unknown
 *    whether the tool ran." That is false here (it definitely ran) and is
 *    the OPPOSITE of the fail-closed signal an operator needs on the one
 *    action class where "did the reset actually happen" matters most. It
 *    would also delay any signal at all for up to the reaper's full sweep
 *    window instead of failing immediately.
 * 2. No `result` (i.e. not the guarded value itself) is ever passed as
 *    `details` — `failIntent` already never sets `result`, and this
 *    deliberately omits it from `details` too, so neither the intent's
 *    `result` column nor the audit event's `details` column can carry the
 *    plaintext this guard exists to keep out of both. `err.message` IS safe
 *    to log/capture as-is: `assertNoPlaintextSecret`'s thrown messages are
 *    static text plus the tool name only — they never interpolate the
 *    offending value.
 */
async function failOnPlaintextSecretGuard(intent: ActionIntent, err: unknown): Promise<void> {
  console.error(
    `[IntentReleaseWorker] plaintext-secret guard tripped for intent ${intent.id} — refusing to persist:`,
    err,
  );
  captureException(err instanceof Error ? err : new Error(String(err)));
  await failIntent(intent, SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE, {
    details: { actionName: intent.actionName },
    executed: true,
  });
}

/**
 * Processes one `intent_approved` job end to end. Exported for direct
 * testing without spinning up a real BullMQ Worker.
 */
export async function releaseApprovedIntent(intentId: string): Promise<void> {
  // Step 1 (spec §5.1): the single-use release guard. Zero rows = lost race
  // (expiry, cancel, a prior delivery of this exact job, or the stale-
  // executing reaper already claimed it) — exit silently. This is what
  // makes repeated/duplicate `intent_approved` enqueues safe.
  // requireNotExpired folds the deadline into the claim: an approved intent
  // cannot be claimed for execution once past its release_by lease (falling
  // back to expires_at for legacy rows with no lease — see
  // intentService.ts's transitionIntent). release_by, not
  // approval_expires_at, is what governs an already-approved intent — an
  // intent approved just before approval_expires_at gets a FRESH lease
  // starting at approval time (the "59:59 trap" — jobs/intentExpiryReaper.ts's
  // header), so it stays claimable here even though approval_expires_at has
  // since passed. Once release_by itself passes, the 30s expiry reaper
  // terminalizes the leftover approved row. Without this check an action
  // could execute after its authorization window closed.
  const claimed = await transitionIntent(
    intentId,
    'approved',
    'executing',
    { executedAt: null, executionStartedAt: new Date() },
    { requireNotExpired: 'release' },
  );
  if (!claimed) {
    return;
  }

  // Step 2: load the intent + its winning approval row. Both are fast local
  // reads with no external I/O, so they share one short system-scoped
  // transaction — mirrors intentOutboxPublisher.ts's phase discipline
  // (DB-only work gets its own short context; the network/tool-execution
  // step below runs in its own, entirely separate, context boundary so a
  // slow external call never pins a pooled connection idle-in-transaction).
  //
  // `intentRow` is a bare `select()` — every column rides along, including
  // Wave 5 Part B's (#3827) `policy_*` provenance columns and `decided_via`.
  // For a policy-decided intent `approvalRow` comes back null (there is no
  // `approval_requests` row by construction — see revalidateRelease.ts's
  // header), which is exactly what `revalidateApprovedIntentForRelease`
  // reads off `intent` itself to take its policy-evidence branch; no second
  // query is needed to "load the policy columns" separately.
  const { intent, winningApproval } = await withSystemDbAccessContext(async () => {
    const [intentRow] = await db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1);
    if (!intentRow) {
      return { intent: null as ActionIntent | null, winningApproval: null };
    }
    const [approvalRow] = await db
      .select({
        id: approvalRequests.id,
        status: approvalRequests.status,
        boundArgumentDigest: approvalRequests.boundArgumentDigest,
      })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.status, 'approved')))
      .limit(1);
    return { intent: intentRow, winningApproval: approvalRow ?? null };
  });

  if (!intent) {
    // Unreachable in practice — the CAS above requires the row to exist —
    // but there is nothing to CAS to failed if the row itself is gone, so
    // just log and stop rather than throwing out of a BullMQ processor.
    console.error(`[IntentReleaseWorker] intent ${intentId} not found after CAS to executing`);
    return;
  }

  // Revalidation chain (spec §5 step 2) — the SHARED fail-closed checks (digest
  // still bound, tier not escalated, actor still active + org-accessible, org
  // still active, actor still holds the tool's RBAC), identical to the inline
  // chat release path (services/aiAgentSdk.ts). Each stop CASes
  // executing -> failed with the exact error_code and returns WITHOUT ever
  // calling executeTool. The rebuilt `auth` is what this worker executes under.
  const revalidation = await revalidateApprovedIntentForRelease(intent, winningApproval);
  if (!revalidation.ok) {
    // Wave-5A review fix (#3827): a kill-derived denial PAUSES, never
    // terminally fails, an already-human-approved intent — see
    // `pauseIntentForKillSwitch`'s header. Every other revalidation stop
    // (digest mismatch, tier escalated, actor/org invalid, rbac denied, a
    // non-kill structural policy denial, …) is unchanged: CAS straight to
    // `failed`.
    if (revalidation.errorCode === 'kill_switch_engaged') {
      await pauseIntentForKillSwitch(intent, revalidation.details);
      return;
    }
    await failIntent(intent, revalidation.errorCode, { details: revalidation.details });
    return;
  }
  const { auth } = revalidation;

  // Effect-digest revalidation (tier3-supervised-four-eyes design §4.1,
  // services/actionIntents/effectDigest.ts) — the TOCTOU gap argumentDigest
  // alone cannot close: an approver approves a REFERENCE ("run script <id>",
  // "send quote <id>"), and the referenced content can drift during the
  // approval window while the intent's own arguments stay byte-identical.
  //
  // That window is NOT one number. `computeExpiresAt`
  // (services/actionIntents/intentService.ts) keys it off SOURCE first and
  // approval scope only second:
  //   - `CHAT_EXPIRY_MS` (5 min)            — source `chat`, supervised
  //   - `FOUR_EYES_CHAT_EXPIRY_MS` (60 min) — source `chat`, four_eyes
  //   - `MCP_EXPIRY_MS` (24 h)              — ANY non-chat source (`mcp_api`),
  //                                           whatever the scope
  // So the worst-case drift window this check has to cover is a full DAY (an
  // `mcp_api` four_eyes intent), not an hour — matching this file's header
  // ("possibly minutes to (for `mcp_api` intents) a day"). Do not restate the
  // chat numbers as if they were universal.
  //
  // A pinned digest is ABSENT only when no resolver existed for the intent's
  // tool/action at creation (`not_applicable`), or a resolver existed but
  // couldn't resolve the target (`unresolved` — legacy pre-pinning rows, or a
  // missing/deleted target); both skip this check by design. Approval scope
  // is NOT a factor: pinning is scope-independent (changed 2026-08-06, see
  // effectDigest.ts's header) — a SUPERVISED intent whose tool has a
  // resolver (run_script is the flagship case) IS pinned and DOES run this
  // check below, same as a four_eyes intent. It used to be skipped for every
  // supervised intent when pinning was gated on
  // `approvalScope === 'four_eyes'`; that gate is gone — don't assume it's
  // still there and conclude this branch is unreachable for supervised.
  // `hasPinnedDigest` is the SHARED predicate with the inline chat release
  // path (services/aiAgentSdk.ts): the two previously guarded the same
  // invariant with different predicates (`!== null` here, truthiness there),
  // which diverged on `undefined` (a narrower select shape) — this path
  // failed CLOSED (a recompute never equals `undefined`, so EVERY pinned
  // release would have been content_changed) while the SDK failed OPEN
  // (skipped the check entirely). One predicate, one behavior.
  //
  // A pinned digest that no longer matches the freshly-recomputed one means
  // the target changed underneath the approval — fail closed, never execute.
  //
  // #3409 PR4c-1: the recompute below does not just produce a digest — for
  // run_script it reads the script row and resolves the tenant variables. That
  // work is CARRIED to executeTool as `verifiedContext` instead of being
  // thrown away and redone inside the handler, because a second read reopens
  // the very window this check just closed (the digest proves the target was
  // unchanged AS OF THE READ; a later read proves nothing).
  let verifiedContext: ToolExecutionContext | undefined;
  if (hasPinnedDigest(intent)) {
    // Runs in its own short system-scoped context (same discipline as Step 2
    // above) — this point in the function is between DB contexts (Step 2's
    // box already closed), and `db` falls back to the raw, GUC-less pool
    // outside any withDbAccessContext/withSystemDbAccessContext, which RLS
    // would silently filter to zero rows rather than error on (see db/index.ts's
    // getCurrentDb). Without this wrap every resolver would read "not found"
    // and this check would fail EVERY pinned release, not just drifted ones.
    let recomputed: { digest: string | null; context?: ToolExecutionContext };
    try {
      recomputed = await withSystemDbAccessContext(() =>
        computeEffectDigestForRelease(intent.actionName, intent.arguments, db),
      );
    } catch (err) {
      // Fail closed with a categorized code, like every other step in this
      // worker. Left unwrapped, a transient DB fault here throws out of
      // `releaseApprovedIntent` AFTER the intent has already been CASed to
      // `executing`: BullMQ retries the job, the retry's claim CAS sees
      // `executing` and returns silently, and the row then sits untouched
      // until `reapStaleExecutingIntents` flips it to
      // `failed:execution_lost` at STALE_EXECUTING_TIMEOUT_MINUTES (20).
      // That code's contract is "the worker died mid-flight, unknown whether
      // the tool ran" — but nothing ran here, so the operator signal would
      // be actively wrong AND 20 minutes late. `executed` is deliberately
      // NOT set: the digest check runs strictly before execution, so
      // `executed_at` stays null (same as the other pre-execution stops).
      console.error(
        `[IntentReleaseWorker] effect-digest recompute failed for intent ${intent.id}:`,
        err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
      await failIntent(intent, 'digest_check_failed', {
        details: {
          actionName: intent.actionName,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    if (recomputed.digest !== intent.effectDigest) {
      await failIntent(intent, 'content_changed', { details: { actionName: intent.actionName } });
      return;
    }
    // Only a MATCHING digest licenses reuse: the material is what the approver
    // approved. On a mismatch we returned above and nothing is carried.
    verifiedContext = recomputed.context;
  }

  // Phase-1 deferral: the headless worker still cannot run session-aware M365
  // Delegant/inline tools. Google Tier-3 tools ARE headless-executable
  // (org-keyed connection, resolved by intent.orgId) as of Phase 2, and M365
  // Tier-3 tools (m365_disable_user, m365_reset_password) ARE ALSO
  // headless-executable as of Phase 2 via the control-plane
  // customer-graph-actions executor (executeM365ToolHeadless) — so gate the
  // session_required fail on "not a headless Google tool AND not a headless
  // M365 tool". See docs/superpowers/specs/
  // 2026-07-19-action-intents-phase2-google-headless-design.md.
  if (isSessionRequiredForRelease(intent.actionName)) {
    await failIntent(intent, 'session_required', { details: { actionName: intent.actionName } });
    return;
  }

  // Wave 5 Part B (#3827) final pre-effect kill read: one more fresh
  // `readAiKillState()` immediately before dispatch, for AGENT-ORIGINATED
  // releases only (review fix: an earlier version ran this unconditionally,
  // which reached human-approved chat/mcp_api releases that have never
  // consulted the kill switch and made the flag-off/human lane non-inert —
  // see the plan's dark-ship constraint). The kill switch governs autonomous
  // agent action (`checkAgentReleaseAuthority` is agent-only, and is the
  // only OTHER caller of `readAiKillState` on this path); a human who
  // clicked Approve is not "the agent" and this read must not be able to
  // pause their release. Scoped this way, everything above this line
  // (revalidation, the effect-digest recompute, its own I/O) can still take
  // real wall-clock time, during which an operator's emergency kill can land
  // — `checkAgentReleaseAuthority`'s own kill read (agentReleaseAuthority.ts)
  // only covers the window up through step 2's revalidation, not the gap
  // between there and the tool actually dispatching. Same pause semantics as
  // that read: a real kill (or a transient read failure, which
  // `readAiKillState` maps fail-closed to `killed: true`) PAUSES the intent
  // back to `approved` rather than terminally failing it — see
  // `pauseIntentForKillSwitch`'s header.
  if (intent.requestingAgentRunId) {
    const preDispatchKillState = await readAiKillState();
    if (preDispatchKillState.killed) {
      await pauseIntentForKillSwitch(intent, {
        epoch: preDispatchKillState.epoch,
        stage: 'pre_dispatch',
      });
      return;
    }
  }

  // Step 3: execute with the rebuilt context. Escape any inherited DB context,
  // then open the SAME org-scoped context a live request would use, bounded by
  // the same per-tool timeout. Headless Google tools resolve their per-tenant
  // OAuth connection by intent.orgId (fresh + re-authorized at execution);
  // headless M365 tools resolve their customer-graph-actions connection the
  // same way via the control-plane write-action service; everything else runs
  // through executeTool. A secret-bearing Google tool (google_reset_password)
  // is checked FIRST and dispatched through executeGoogleSecretToolHeadless,
  // which returns a SecretToolResult carrier instead of a plain string — this
  // is what lets Step 4 below seal the credential instead of storing the
  // tool's prose (`{raw: "...Temporary password: X..."}`) verbatim, which is
  // the confirmed plaintext leak this change closes.
  const secretAction = GOOGLE_HEADLESS_SECRET_ACTIONS[intent.actionName];

  let carrier: SecretToolResult | null = null;
  let rawResult: string;
  try {
    if (secretAction) {
      carrier = await withToolTimeout(
        withAuthDbAccessContext(auth, () =>
          executeGoogleSecretToolHeadless(intent.actionName, intent.arguments, intent.orgId),
        ),
        getToolTimeout(intent.actionName),
        intent.actionName,
      );
      rawResult = carrier.llmText;
    } else {
      const invoke = isHeadlessGoogleTool(intent.actionName)
        ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
        : isHeadlessM365Tool(intent.actionName)
        ? () => executeM365ToolHeadless(intent.actionName, intent.arguments, intent.orgId, intent.id)
        : // The options bag is passed ONLY when something was actually
          // verified, so every other release keeps the exact three-argument
          // call it has always made.
          () =>
            verifiedContext
              ? executeTool(intent.actionName, intent.arguments, auth, { context: verifiedContext })
              : executeTool(intent.actionName, intent.arguments, auth);
      rawResult = await withToolTimeout(
        withAuthDbAccessContext(auth, invoke),
        getToolTimeout(intent.actionName),
        intent.actionName,
      );
    }
  } catch (err) {
    if (err instanceof GoogleConnectionUnavailableError || err instanceof M365ConnectionUnavailableError) {
      // The org's Google/M365 connection is missing/rotated/inactive (or the
      // M365 write-action ladder refused for a connection-level reason:
      // disabled/rate-limited/executor-down) at release time — no API call
      // was made. Fail closed with a distinct, categorized code.
      await failIntent(intent, 'connection_unavailable', {
        details: { actionName: intent.actionName },
      });
      return;
    }
    console.error(`[IntentReleaseWorker] tool execution threw for intent ${intent.id}:`, err);
    await failIntent(intent, 'execution_error', {
      details: { error: err instanceof Error ? err.message : String(err) },
      executed: true,
    });
    return;
  }

  // Step 4: cap the result to 64 KiB; oversize -> {truncated:true}, which
  // still counts as a completion, never a failure. A carrier result (secret-
  // bearing Google tool) is sealed HERE via sealToolSecrets rather than
  // normalized as prose — this is the fix for the confirmed leak: previously
  // normalizeToolResult wrapped the carrier's llmText prose as {raw: "..."},
  // which sealActionResultSecrets below is a no-op on (its `result.action`
  // gate only matches the M365 structured shape), so the credential was
  // stored in the clear.
  const resultBytes = Buffer.byteLength(rawResult, 'utf8');
  const truncated = resultBytes > MAX_RESULT_BYTES;

  let storedResult: Record<string, unknown>;
  if (truncated) {
    storedResult = { truncated: true };
  } else if (carrier) {
    storedResult = sealToolSecrets(carrier).sealedResult;
  } else {
    storedResult = normalizeToolResult(rawResult);
  }

  // A tool that returned an error body (not a throw) is a FAILED release, not a
  // completion — mirrors the chat SDK's isError handling. Store the result for
  // diagnosis but terminalize as failed:tool_returned_error. For a carrier this
  // checks rawResult === carrier.llmText: an error carrier's llmText keeps the
  // errorString() JSON shape ({error, message}), so the existing detection
  // still applies unchanged.
  if (!truncated && isReturnedToolError(rawResult)) {
    try {
      assertNoPlaintextSecret(intent.actionName, storedResult);
    } catch (err) {
      await failOnPlaintextSecretGuard(intent, err);
      return;
    }
    const failed = await terminalizeIntent(intent, 'failed', {
      executedAt: new Date(),
      errorCode: 'tool_returned_error',
      result: storedResult,
    });
    if (failed) {
      auditReleaseFailure(intent, 'tool_returned_error', { returnedError: true });
    } else {
      // Lost the CAS after the tool ran — the side effect happened; surface it.
      console.error(
        `[IntentReleaseWorker] Lost the executing->failed CAS for intent ${intent.id} after a returned tool error`,
      );
    }
    return;
  }

  // Seal any secret fields (reset_password temporaryPassword) before storage.
  // Re-check the size cap afterwards: ciphertext is larger than plaintext.
  // sealActionResultSecrets is a no-op on an already-sealed carrier result
  // (its `result.action` gate does not match), so this cannot double-seal —
  // it still covers the M365 structured shape, which is sealed independently.
  let finalResult = sealActionResultSecrets(storedResult);
  if (Buffer.byteLength(JSON.stringify(finalResult), 'utf8') > MAX_RESULT_BYTES) {
    if (TEMP_PASSWORD_ENC_KEY in finalResult) {
      console.warn(
        `[IntentReleaseWorker] Dropping sealed credential for intent ${intent.id} — result exceeded the size cap`,
      );
    }
    finalResult = { truncated: true };
  }
  try {
    assertNoPlaintextSecret(intent.actionName, finalResult);
  } catch (err) {
    await failOnPlaintextSecretGuard(intent, err);
    return;
  }
  let fixWatchId: string | null = null;
  const completed = await terminalizeIntent(
    intent,
    'completed',
    { executedAt: new Date(), result: finalResult },
    async (anchor) => {
      fixWatchId = await watchReleasedIntent(intent, anchor);
    },
  );

  if (!completed) {
    // Lost the executing -> completed CAS AFTER the tool already ran (via
    // executeTool or executeGoogleToolHeadless) and had its real-world side
    // effect (e.g. the stale-executing reaper beat
    // us to failed:execution_lost on an extremely slow tool call, or a
    // duplicate delivery raced this one to the terminal state first). The
    // side effect already happened and cannot be undone; there is nothing
    // more to CAS, but this is worth surfacing — it means the result this
    // execution produced is not recorded anywhere on the intent.
    console.error(
      `[IntentReleaseWorker] Lost the executing->completed CAS for intent ${intent.id} — `
      + 'a reaper or duplicate delivery likely already terminalized it; the tool DID execute',
    );
    captureException(new Error(`intent ${intent.id} executed but lost the completed CAS`));
    return;
  }

  // STRICTLY after the terminal transaction closed: `bullmqQueue.ts`'s #1105
  // tripwire throws (in strict mode) on a `queue.add` inside a held DB
  // context, and pinning a pooled connection across a Redis round trip is
  // what that tripwire exists to prevent. Swallowed on failure for the same
  // reason `scheduleFixWatch` swallows: the watch row is committed, and
  // `recoverStrandedFixWatches` re-adds its job within PENDING_RECOVERY_MS —
  // failing an action that already had its real-world effect would be far
  // worse than a two-minute-late verification.
  if (fixWatchId) {
    try {
      await enqueueFixWatchPhase1(fixWatchId);
    } catch (err) {
      console.error(
        `[IntentReleaseWorker] Failed to enqueue the fix watch for intent ${intent.id} — the recovery sweep will re-add it:`,
        err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  try {
    recordActionIntentEvent({
      orgId: intent.orgId,
      intentId: intent.id,
      actionName: intent.actionName,
      argumentDigest: intent.argumentDigest,
      source: intent.source,
      outcome: 'executed',
      details: { truncated, resultBytes },
    });
  } catch (err) {
    console.error(`[IntentReleaseWorker] Failed to write success audit for intent ${intent.id}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * The run + agent behind an agent-originated intent, loaded under GENUINE
 * system scope. `runOutsideDbContext` first is load-bearing: a bare system
 * wrapper inside an ambient context is a passthrough (db/index.ts), and while
 * this worker normally runs contextless, the notify path must stay correct if
 * it is ever invoked from inside a request transaction.
 */
async function loadRunAndAgent(runId: string): Promise<{
  run: {
    id: string;
    agentId: string;
    /**
     * The MERGED recipient set from the run's immutable snapshot — the only
     * correct source. `ai_agents.recipients` on the row `run.agent_id` points
     * at is always the PARTNER BASELINE (resolveEffectiveAgentSystem pins
     * `agentId: partnerRow.id`), so using it silently drops every recipient an
     * organization added through its override, and notifies nobody at all when
     * only the override configured any. `mergeAgentPolicies` already unions
     * the two sets into `effective.recipients`.
     */
    recipients: Partial<AiAgentRecipients>;
  } | null;
  agent: {
    id: string;
    orgId: string | null;
    partnerId: string | null;
    recipients: Partial<AiAgentRecipients>;
  } | null;
}> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [run] = await db
        .select({
          id: aiAgentRuns.id,
          agentId: aiAgentRuns.agentId,
          policySnapshot: aiAgentRuns.policySnapshot,
        })
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.id, runId))
        .limit(1);
      if (!run) return { run: null, agent: null };
      const [agent] = await db
        .select({
          id: aiAgents.id,
          orgId: aiAgents.orgId,
          partnerId: aiAgents.partnerId,
          recipients: aiAgents.recipients,
        })
        .from(aiAgents)
        .where(eq(aiAgents.id, run.agentId))
        .limit(1);
      return {
        run: {
          id: run.id,
          agentId: run.agentId,
          recipients: run.policySnapshot?.effective?.recipients ?? {},
        },
        agent: agent ?? null,
      };
    }));
}

/**
 * Same status switch the requester path uses below — the copy MUST derive
 * from the freshly re-read `intent.status`, never the outbox event (see the
 * long rationale in notifyRequesterOfOutcome) — but worded for a recipient
 * who never asked for anything: an AGENT proposed this, a human decided it.
 */
function agentOutcomeCopy(intent: { targetSummary: string; status: string }): {
  title: string;
  message: string;
  priority: 'normal' | 'high';
} {
  const summary = intent.targetSummary;
  switch (intent.status) {
    case 'approved':
    case 'executing':
      return { title: 'Agent action approved', message: `${summary} was approved and is now running.`, priority: 'normal' };
    case 'completed':
      return { title: 'Agent action completed', message: `${summary} was approved and has finished.`, priority: 'normal' };
    case 'failed':
      // Approved but did not run. The distinction matters most here.
      return { title: 'Agent action failed', message: `${summary} was approved but could not run.`, priority: 'high' };
    case 'rejected':
      return { title: 'Agent proposal denied', message: `${summary} was denied and will not run.`, priority: 'normal' };
    case 'cancelled':
      return { title: 'Agent proposal cancelled', message: `${summary} was cancelled and will not run.`, priority: 'normal' };
    case 'expired':
      return { title: 'Agent proposal expired', message: `${summary} expired before anyone decided and will not run.`, priority: 'normal' };
    default:
      return { title: 'Agent proposal update', message: `${summary} changed state.`, priority: 'normal' };
  }
}

/**
 * Tell the requester how their intent ended.
 *
 * The point of doing this from the outbox rather than inline at decide time:
 * the requester's chat turn is usually long over by then
 * (aiAgentSdk.ts:1030-1040), which is exactly why they never learned the
 * outcome before wave 2.
 *
 * Reads the intent fresh instead of trusting the job payload. Outbox rows are
 * delivered at-least-once and can be processed well after the fact, so the
 * status on the row is the truth and the event is only a nudge to go look.
 */
async function notifyRequesterOfOutcome(
  intentId: string,
  eventType: 'intent_approved' | 'intent_rejected' | 'intent_expired',
): Promise<void> {
  const [intent] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: actionIntents.id,
        orgId: actionIntents.orgId,
        requestedByUserId: actionIntents.requestedByUserId,
        targetSummary: actionIntents.targetSummary,
        status: actionIntents.status,
        approvalScope: actionIntents.approvalScope,
        requestingAgentRunId: actionIntents.requestingAgentRunId,
        requestingClientLabel: actionIntents.requestingClientLabel,
      })
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1));

  if (!intent) {
    // Outboxed and then deleted: a genuine anomaly, not an expected case.
    captureException(new Error(`intent ${intentId} not found for outcome notification`));
    return;
  }
  // Agent-originated intent (wave 3b): a headless proposal has NO requester,
  // so "the requester was watching" is false at every approval scope — this
  // branch must run BEFORE both the four_eyes early-out and the
  // no-human-requester guard below, either of which would swallow it. Notify
  // the agent's validated recipients, resolved against LIVE membership
  // (resolveRecipientUserIds), never the raw stored ids. Copy derives from
  // the re-read intent.status exactly like the requester path, because the
  // outbox event may be late or release may have failed after approval.
  if (!intent.requestedByUserId && intent.requestingAgentRunId) {
    const { run, agent } = await loadRunAndAgent(intent.requestingAgentRunId);
    if (!run || !agent) return;
    // Merged set from the run snapshot, not the baseline agent row's column
    // (see loadRunAndAgent). resolveRecipientUserIds ignores the owner fields
    // of its first argument and re-derives membership against the intent org.
    const userIds = await resolveRecipientUserIds(
      { orgId: agent.orgId, partnerId: agent.partnerId, recipients: run.recipients },
      intent.orgId,
    );
    const { title, message, priority } = agentOutcomeCopy(intent);
    for (const userId of userIds) {
      // runOutsideDbContext first — a bare system wrapper inside an ambient
      // request context is a passthrough, and this is a cross-user insert.
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          createNotification({
            userId,
            orgId: intent.orgId,
            type: 'ai',
            priority,
            title,
            message: `${intent.requestingClientLabel ?? 'AI agent'}: ${message}`,
            link: '/approvals',
            metadata: { intentId: intent.id, agentId: agent.id, agentRunId: run.id, status: intent.status },
            // Status-scoped: a later, MORE ACCURATE status (approved -> failed)
            // must not be suppressed by the earlier notification's dedupe row.
            dedupeKey: `agent-intent-outcome:${intent.id}:${intent.status}`,
          })));
    }
    return;
  }

  // Defensive today: no creation path sets requestingApiKeyId yet —
  // createActionIntent attributes every intent to auth.user.id (see
  // actorContext.ts). When API-key-owned MCP intents land (Plan 2), those rows
  // have no human requester and correctly stay silent; agent-originated
  // intents (wave 3b) were routed to recipients above, before this early
  // return. org_id is NOT NULL in the schema, so it is deliberately not
  // checked here.
  if (!intent.requestedByUserId) return;

  // A SUPERVISED intent's requester is also its only approver. Every
  // supervised intent today is chat-sourced, so the requester was watching the
  // chat stream that created it — the inline timeout already told them.
  // Notifying here would put a bell row on every abandoned 5-minute chat
  // intent, which is easily the highest-volume producer of this new type, and
  // would train people to ignore the bell. Only four-eyes has a requester who
  // genuinely could not see the outcome. Mirrors the same scope gate the push
  // path uses at intentService.ts. Revisit when supervised mcp_api intents
  // exist: those get a 24h window with NO inline channel (computeExpiresAt,
  // intentService.ts), so the "they were watching" rationale won't hold there.
  if (intent.approvalScope !== 'four_eyes') return;

  // Copy comes from the intent's CURRENT status, not from the event type.
  //
  // This is the whole reason the status column is selected. `releaseApprovedIntent`
  // returns void and has around a dozen early-return paths that mean it did NOT
  // run — revalidation stopped it, the release_by deadline had passed, it lost
  // the approved->executing CAS, the tool threw. Deriving the copy from
  // `eventType` told the requester "was approved and is now running" in every
  // one of those cases. For an intent that was failed closed because the
  // approver's permission had been revoked, that is an outright false statement
  // about a privileged action.
  //
  // Outbox delivery is also at-least-once and can land minutes late, by which
  // time an approved intent may well have completed, failed or expired.
  const summary = intent.targetSummary;
  const copy = ((): { title: string; message: string } => {
    switch (intent.status) {
      case 'approved':
      case 'executing':
        return { title: 'Approval granted', message: `${summary} was approved and is now running.` };
      case 'completed':
        return { title: 'Approval granted', message: `${summary} was approved and has finished.` };
      case 'failed':
        // Approved but did not run. The distinction matters most here.
        return { title: 'Action failed', message: `${summary} was approved but could not run.` };
      case 'rejected':
        return { title: 'Approval denied', message: `${summary} was denied and will not run.` };
      case 'cancelled':
        return { title: 'Request cancelled', message: `${summary} was cancelled and will not run.` };
      case 'expired':
        return { title: 'Approval expired', message: `${summary} expired before it was decided and will not run.` };
      default:
        // pending_approval, or a status added later: say only what is certain.
        return { title: 'Approval update', message: `${summary} changed state.` };
    }
  })();

  await withSystemDbAccessContext(() =>
    createNotification({
      userId: intent.requestedByUserId!,
      orgId: intent.orgId,
      type: 'approval',
      title: copy.title,
      message: copy.message,
      link: '/approvals',
      metadata: { intentId: intent.id, outcome: eventType, status: intent.status },
      // Scoped to the STATUS, not just the intent. A per-intent key meant that
      // once a premature "is now running" had been written, the later truthful
      // notification deduped to null and the person was never corrected.
      dedupeKey: `intent-outcome:${intent.id}:${intent.status}`,
    }));
}

/**
 * One job's worth of dispatch logic, factored out of the Worker processor so
 * it can be unit tested without spinning up a real BullMQ Worker.
 *
 * `intent_approved` is the release trigger AND an outcome to report.
 * `intent_rejected` / `intent_expired` are outcome-only. `intent_created` is
 * the policy-decide recovery hook (wave 5 Part B, #3827) — deliberately NOT
 * flag-gated at this call site (see the comment on that branch below for
 * why) and NOT unconditionally acknowledged: a DETERMINISTIC outcome from
 * `attemptPolicyDecision` (it returns normally either way) always acks, but
 * a TRANSIENT failure (it throws `PolicyDecisionTransientError`, review fix
 * #3827) is rethrown so BullMQ redelivers the job — this queue's outbox
 * publisher (intentOutboxPublisher.ts) is a separate producer role, not this
 * consumer's retry policy, but this IS the branch that relies on BullMQ's
 * own per-job retry policy to make that redelivery real.
 */
export async function processIntentReleaseJob(data: IntentReleaseJobData): Promise<{ released: boolean }> {
  if (data.eventType === 'intent_rejected' || data.eventType === 'intent_expired') {
    await notifyRequesterOfOutcome(data.intentId, data.eventType);
    return { released: false };
  }

  // Wave 5 Part B (#3827) — the outbox at-least-once recovery branch for a
  // policy-decide attempt that never ran (the creation-time fire-and-forget
  // trigger was dropped by a crash/restart), that only got as far as a
  // TRANSIENT failure (left `unattempted` on purpose — see
  // policyDecide.ts's header), or that never got attempted because the flag
  // was off at creation and has since been flipped back on.
  //
  // Deliberately NOT flag-gated here (review fix, #3827): this is the ONLY
  // durable caller of `attemptPolicyDecision` — the creation-time trigger is
  // fire-and-forget and does not survive a restart — so gating the call site
  // too would strand every intent left `unattempted` by an operator's
  // emergency flag-off: with nothing left to move it out of `unattempted`,
  // it would sit with zero `approval_requests` rows and zero notifications,
  // invisible until the expiry reaper eventually cancels it.
  // `attemptPolicyDecision` itself is the single source of truth for flag-off
  // behavior: it checks the intent is genuinely `unattempted` BEFORE reading
  // the flag, and degrades a flag-off `unattempted` intent to human review
  // rather than leaving it stranded. It also re-derives every other
  // precondition itself (status === 'pending_approval', agent-originated),
  // so a human-authored or already-decided intent's `intent_created` event
  // reaches it and no-ops — this call site does not need to duplicate those
  // checks.
  //
  // Review fix (#3827): a DETERMINISTIC outcome (every no-op above, a
  // degrade-to-human, or a clean authorize — `attemptPolicyDecision` returns
  // normally in all of them) still acks unconditionally, same as before. A
  // TRANSIENT failure now throws `PolicyDecisionTransientError` instead of
  // being swallowed — rethrown here rather than acked, this is what turns
  // "left `unattempted`" into REAL at-least-once recovery: BullMQ redelivers
  // the job per this job's retry policy instead of the event being marked
  // processed and gone forever. Any OTHER error shape reaching this catch
  // would mean `attemptPolicyDecision` grew an exit path that neither
  // returns nor throws the discriminated signal — a bug in that function,
  // not something retrying here can fix — so it stays logged-and-acked
  // rather than retried forever.
  if (data.eventType === 'intent_created') {
    // P2-4 Task A3 (#4191): a `decidedVia: 'ticket_autonomy'` row was
    // ALREADY approved inside `createActionIntent`'s own transaction — its
    // `policyDecisionState` is 'human_required' (the `resolvePolicyDecisionState`
    // stub forces that for every scoped intent), never 'unattempted', so
    // `attemptPolicyDecision`'s own precondition would silently no-op it
    // regardless. Route it straight to release instead: this `intent_created`
    // delivery is a SECOND, independent recovery path alongside the
    // `intent_approved` outbox row `createActionIntent` also wrote for it
    // (see that module's header) — a backstop for the case where that
    // sibling row's own publish is the one that gets stuck.
    const decidedVia = await loadIntentDecidedVia(data.intentId);
    if (decidedVia === 'ticket_autonomy') {
      return releaseAndNotify(data.intentId);
    }
    try {
      await attemptPolicyDecision(data.intentId);
    } catch (err) {
      if (err instanceof PolicyDecisionTransientError) {
        console.error(
          `[IntentReleaseWorker] attemptPolicyDecision transient failure for intent ${data.intentId} — rethrowing for BullMQ retry:`,
          err,
        );
        throw err;
      }
      console.error(`[IntentReleaseWorker] attemptPolicyDecision failed for intent ${data.intentId}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
    return { released: false };
  }

  if (data.eventType !== 'intent_approved') {
    return { released: false };
  }

  return releaseAndNotify(data.intentId);
}

/**
 * Narrow, defensive read used ONLY to route the `intent_created` recovery
 * branch above — `null` (missing row, or any read fault) falls through to
 * the ordinary `attemptPolicyDecision` call, which is itself a safe no-op
 * for a row it does not recognize as `unattempted`.
 */
async function loadIntentDecidedVia(intentId: string): Promise<string | null> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ decidedVia: actionIntents.decidedVia })
      .from(actionIntents)
      .where(eq(actionIntents.id, intentId))
      .limit(1),
  );
  return row?.decidedVia ?? null;
}

/**
 * Shared release + best-effort outcome notification, extracted so the
 * `intent_approved` release trigger and the `ticket_autonomy` `intent_created`
 * recovery branch above run the IDENTICAL sequence. `releaseApprovedIntent`
 * is itself CAS-guarded (`approved -> executing`), so calling this twice for
 * the same intent (once from each event) is safe — the loser finds the
 * intent already claimed and returns without executing anything twice.
 */
async function releaseAndNotify(intentId: string): Promise<{ released: boolean }> {
  await releaseApprovedIntent(intentId);

  // AFTER the release, and deliberately not allowed to undo it. The release
  // already committed; throwing here would retry the whole job and re-run
  // releaseApprovedIntent, which is why the notification is swallowed and the
  // CAS inside the release path is what makes a retry safe.
  try {
    await notifyRequesterOfOutcome(intentId, 'intent_approved');
  } catch (err) {
    console.error(`[IntentReleaseWorker] outcome notification failed for intent ${intentId}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  return { released: true };
}

function createWorker(): Worker<IntentReleaseJobData> {
  return new Worker<IntentReleaseJobData>(
    ACTION_INTENTS_QUEUE_NAME,
    async (job: Job<IntentReleaseJobData>) => {
      try {
        return await processIntentReleaseJob(job.data);
      } catch (err) {
        console.error(`[IntentReleaseWorker] Job ${job.id} (intent ${job.data.intentId}) failed:`, err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      // Unlike the reapers (concurrency: 1 — cheap, purely-DB sweeps), this
      // worker's executeTool step can block on slow external calls (M365/
      // Google APIs, agent command round-trips, ticketing systems). Modest
      // parallelism so one slow release doesn't stall the whole queue, while
      // staying well below a level that could hammer downstream systems.
      concurrency: 5,
    },
  );
}

export async function initializeIntentReleaseWorker(): Promise<void> {
  if (releaseWorker) return;

  releaseWorker = createWorker();
  releaseWorker.on('error', (error) => {
    console.error('[IntentReleaseWorker] Worker error:', error);
    captureException(error);
  });
  releaseWorker.on('failed', (job, error) => {
    console.error(`[IntentReleaseWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  console.log('[IntentReleaseWorker] Initialized');
}

export async function shutdownIntentReleaseWorker(): Promise<void> {
  const worker = releaseWorker;
  releaseWorker = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[IntentReleaseWorker] Error closing worker:', err);
    }
  }
}
