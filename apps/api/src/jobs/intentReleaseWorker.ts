import { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { actionIntents, type ActionIntent } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { recordActionIntentEvent, recordActionIntentMetric } from '../services/actionIntents/metrics';
import { transitionIntent } from '../services/actionIntents/intentService';
import { revalidateApprovedIntentForRelease } from '../services/actionIntents/revalidateRelease';
import { executeTool, requiresLiveSession } from '../services/aiTools';
import { dbAccessContextFromAuth } from '../middleware/auth';
import { getToolTimeout, withToolTimeout } from '../services/toolTimeouts';
import {
  isHeadlessGoogleTool,
  executeGoogleToolHeadless,
  GoogleConnectionUnavailableError,
} from '../services/googleToolsHeadless';
import {
  isHeadlessM365Tool,
  executeM365ToolHeadless,
  M365ConnectionUnavailableError,
} from '../services/m365ToolsHeadless';
import { sealActionResultSecrets, TEMP_PASSWORD_ENC_KEY } from '../services/actionIntents/resultSecrets';

/**
 * Durable release worker (spec
 * docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md
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
 * Job data: `{ intentId, eventType }`. Only `eventType === 'intent_approved'`
 * is acted on; anything else is acknowledged as a no-op (forward-compat with
 * `intent_created`, which this worker does not consume).
 *
 * CAS-idempotent by construction: the `approved -> executing` transition at
 * step 1 is a single-use release guard (mirrors the PAM `actuating` pattern).
 * A duplicate delivery of the same job (BullMQ jobId dedupe normally
 * prevents this, but retries happen) finds the intent already
 * `executing`/terminal, the CAS returns zero rows, and the handler exits
 * without calling `executeTool` a second time.
 */

const ACTION_INTENTS_QUEUE_NAME = 'action-intents';
const MAX_RESULT_BYTES = 64 * 1024; // 64 KiB (spec §5 step 4)

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
 * CAS `executing -> failed` with the given `error_code`, then (only if the
 * CAS actually won) writes the failure audit/metric. `executed: true` also
 * stamps `executedAt` — used only for `execution_error`, where a real
 * attempt was made; the earlier revalidation stops (digest/tier/actor/org)
 * never touched execution, so they leave `executedAt` null.
 */
async function failIntent(
  intent: ActionIntent,
  errorCode: string,
  options: { details?: Record<string, unknown>; executed?: boolean } = {},
): Promise<void> {
  const won = await transitionIntent(intent.id, 'executing', 'failed', {
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
 * Processes one `intent_approved` job end to end. Exported for direct
 * testing without spinning up a real BullMQ Worker.
 */
export async function releaseApprovedIntent(intentId: string): Promise<void> {
  // Step 1 (spec §5.1): the single-use release guard. Zero rows = lost race
  // (expiry, cancel, a prior delivery of this exact job, or the stale-
  // executing reaper already claimed it) — exit silently. This is what
  // makes repeated/duplicate `intent_approved` enqueues safe.
  // requireNotExpired folds the deadline into the claim: an intent approved
  // just before expires_at cannot be claimed for execution once past it (the
  // 30s expiry reaper terminalizes the leftover approved row). Without this an
  // action could execute after its authorization window closed.
  const claimed = await transitionIntent(
    intentId,
    'approved',
    'executing',
    { executedAt: null, executionStartedAt: new Date() },
    { requireNotExpired: true },
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
    await failIntent(intent, revalidation.errorCode, { details: revalidation.details });
    return;
  }
  const { auth } = revalidation;

  // Phase-1 deferral: the headless worker still cannot run session-aware M365
  // Delegant/inline tools. Google Tier-3 tools ARE headless-executable
  // (org-keyed connection, resolved by intent.orgId) as of Phase 2, and M365
  // Tier-3 tools (m365_disable_user, m365_reset_password) ARE ALSO
  // headless-executable as of Phase 2 via the control-plane
  // customer-graph-actions executor (executeM365ToolHeadless) — so gate the
  // session_required fail on "not a headless Google tool AND not a headless
  // M365 tool". See docs/superpowers/specs/
  // 2026-07-19-action-intents-phase2-google-headless-design.md.
  if (
    !isHeadlessGoogleTool(intent.actionName)
    && !isHeadlessM365Tool(intent.actionName)
    && requiresLiveSession(intent.actionName)
  ) {
    await failIntent(intent, 'session_required', { details: { actionName: intent.actionName } });
    return;
  }

  // Step 3: execute with the rebuilt context. Escape any inherited DB context,
  // then open the SAME org-scoped context a live request would use, bounded by
  // the same per-tool timeout. Headless Google tools resolve their per-tenant
  // OAuth connection by intent.orgId (fresh + re-authorized at execution);
  // headless M365 tools resolve their customer-graph-actions connection the
  // same way via the control-plane write-action service; everything else runs
  // through executeTool.
  const invoke = isHeadlessGoogleTool(intent.actionName)
    ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
    : isHeadlessM365Tool(intent.actionName)
    ? () => executeM365ToolHeadless(intent.actionName, intent.arguments, intent.orgId, intent.id)
    : () => executeTool(intent.actionName, intent.arguments, auth);

  let rawResult: string;
  try {
    rawResult = await withToolTimeout(
      runOutsideDbContext(() =>
        withDbAccessContext(dbAccessContextFromAuth(auth), invoke),
      ),
      getToolTimeout(intent.actionName),
      intent.actionName,
    );
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
  // still counts as a completion, never a failure.
  const resultBytes = Buffer.byteLength(rawResult, 'utf8');
  const truncated = resultBytes > MAX_RESULT_BYTES;
  const storedResult: Record<string, unknown> = truncated ? { truncated: true } : normalizeToolResult(rawResult);

  // A tool that returned an error body (not a throw) is a FAILED release, not a
  // completion — mirrors the chat SDK's isError handling. Store the result for
  // diagnosis but terminalize as failed:tool_returned_error.
  if (!truncated && isReturnedToolError(rawResult)) {
    const failed = await transitionIntent(intent.id, 'executing', 'failed', {
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
  let finalResult = sealActionResultSecrets(storedResult);
  if (Buffer.byteLength(JSON.stringify(finalResult), 'utf8') > MAX_RESULT_BYTES) {
    if (TEMP_PASSWORD_ENC_KEY in finalResult) {
      console.warn(
        `[IntentReleaseWorker] Dropping sealed credential for intent ${intent.id} — result exceeded the size cap`,
      );
    }
    finalResult = { truncated: true };
  }
  const completed = await transitionIntent(intent.id, 'executing', 'completed', {
    executedAt: new Date(),
    result: finalResult,
  });

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
 * One job's worth of dispatch logic, factored out of the Worker processor so
 * it can be unit tested without spinning up a real BullMQ Worker. Only
 * `intent_approved` is a release trigger — `intent_created` (also published
 * to this same queue by intentOutboxPublisher.ts, which this worker shares
 * a queue with but not a consumer role) is acknowledged as a no-op rather
 * than thrown on, so it doesn't retry forever.
 */
export async function processIntentReleaseJob(data: IntentReleaseJobData): Promise<{ released: boolean }> {
  if (data.eventType !== 'intent_approved') {
    return { released: false };
  }
  await releaseApprovedIntent(data.intentId);
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
