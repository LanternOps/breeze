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
import { executeTool } from '../services/aiTools';
import { dbAccessContextFromAuth } from '../middleware/auth';

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
    { executedAt: null },
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

  // Step 3: execute through the existing dispatch (guardrails, device
  // gates, and whatever per-tool audit/ledger writes the handler itself
  // makes) with the rebuilt context. Escape any inherited DB context first,
  // then open the SAME org-scoped context a live request would run this
  // call under (mirrors services/aiAgentSdkTools.ts's makeHandler /
  // sessionHandler) so the tool handler's own `auth.orgCondition`-filtered
  // reads see exactly the rebuilt actor's tenant scope — never a system-wide
  // view, and never the short-lived system context the revalidation reads
  // above used.
  let rawResult: string;
  try {
    rawResult = await runOutsideDbContext(() =>
      withDbAccessContext(dbAccessContextFromAuth(auth), () =>
        executeTool(intent.actionName, intent.arguments, auth),
      ),
    );
  } catch (err) {
    console.error(`[IntentReleaseWorker] executeTool threw for intent ${intent.id}:`, err);
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

  const completed = await transitionIntent(intent.id, 'executing', 'completed', {
    executedAt: new Date(),
    result: storedResult,
  });

  if (!completed) {
    // Lost the executing -> completed CAS AFTER executeTool already ran and
    // had its real-world side effect (e.g. the stale-executing reaper beat
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
