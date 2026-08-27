/**
 * runFinishedNotify — the run-finished notification delivery body (AI agents
 * wave 4a, Task 6, #3826).
 *
 * Pulled out of `runLoop.ts`'s old inline `notifyRunFinished` into its own
 * leaf module for two reasons:
 *
 * 1. Both the normal in-loop path (`runLoop.ts`'s `finishRun`, immediately
 *    after the run's terminal status CAS commits) and the durable BullMQ
 *    retry lane (`jobs/agentNotifyRetryWorker.ts`) need to call the SAME
 *    notify body by `runId` alone — the retry worker has no in-memory
 *    `RunContext`, only the id its job payload carries, so it re-reads the
 *    run + agent + policy snapshot from the DB fresh. The run row is
 *    immutable by the time either caller reaches this: `finishRun`'s status
 *    CAS has already committed.
 * 2. `runLoop.ts`'s own header explicitly keeps BullMQ out of its module
 *    graph ("so that the guardrail hooks it builds can be driven by
 *    service-level tests ... without dragging BullMQ and Redis into their
 *    module graph"). A module imported by BOTH `runLoop.ts` and the BullMQ
 *    worker must itself stay BullMQ-free, or the two files become circular
 *    imports of each other (the worker needs the notify body FROM the loop;
 *    the loop needs the enqueue function FROM the worker). This module has
 *    zero BullMQ/Redis dependency, which is also what keeps
 *    `agentNotifyRetryWorker`'s import closure short enough to land
 *    `placement: 'global'` in the worker registry (see
 *    `workerEntrypointClosure.contract.test.ts`) instead of inheriting
 *    `runLoop.ts`'s full SDK-tool `socket-owner` graph.
 *
 * Throws on ANY failure (DB read, recipient resolution, notification write)
 * — deliberately, unlike the old inline `notifyRunFinished`, which caught
 * everything itself. The two callers now own that decision differently:
 * `finishRun` catches it and enqueues ONE durable retry job (a notify
 * failure must never redefine the run's terminal status); the retry
 * worker's job processor lets it propagate so BullMQ's own `attempts` +
 * backoff (set at enqueue time) handles repeated failures — no manual
 * re-enqueue loop here.
 */
import { eq } from 'drizzle-orm';
import type { AiAgentPolicySnapshot } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same note as runLoop.ts.
import { aiAgents, aiAgentRuns } from '../../db/schema/aiAgents';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';

/** The only statuses `finishRun` ever commits before calling this. A run
 *  read back in any other status (e.g. a stale/duplicate retry-job delivery
 *  racing an as-yet-uncommitted transition) has nothing to notify about yet. */
const TERMINAL_STATUSES = new Set(['completed', 'awaiting_approval', 'failed']);

interface FinishedRunRow {
  id: string;
  orgId: string;
  agentId: string;
  status: string;
  summary: string | null;
  outcome: Record<string, unknown>;
  intentIds: string[];
  policySnapshot: AiAgentPolicySnapshot;
}

interface NotifyAgentRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
}

/**
 * Same skip-if-already-system shape as `runLoop.ts`'s own `inSystemDbContext`
 * — duplicated rather than imported so this module's only DB dependency stays
 * `../../db` itself (see the header comment on why this file must not import
 * `runLoop.ts`).
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function loadFinishedRun(
  runId: string,
): Promise<{ run: FinishedRunRow; agent: NotifyAgentRow } | null> {
  return inSystemDbContext(async () => {
    const [run] = await db
      .select({
        id: aiAgentRuns.id,
        orgId: aiAgentRuns.orgId,
        agentId: aiAgentRuns.agentId,
        status: aiAgentRuns.status,
        summary: aiAgentRuns.summary,
        outcome: aiAgentRuns.outcome,
        intentIds: aiAgentRuns.intentIds,
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
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    if (!agent) return null;

    return { run: run as FinishedRunRow, agent: agent as NotifyAgentRow };
  });
}

/**
 * Delivers the "agent run finished" notification to every resolved recipient
 * of the given run, re-reading the run/agent/policy snapshot from the DB.
 *
 * Silent (logged, not thrown) no-ops: the run or its agent no longer exists,
 * the run is not (yet) in a terminal status, or zero recipients resolve —
 * none of these are failures the durable retry lane exists for. Anything
 * else THROWS; see the header comment for why callers must not swallow it
 * inside this function.
 */
export async function deliverRunFinishedNotifications(runId: string): Promise<void> {
  const loaded = await loadFinishedRun(runId);
  if (!loaded) {
    console.warn('[runFinishedNotify] run or its agent no longer exists — nothing to notify', { runId });
    return;
  }
  const { run, agent } = loaded;

  if (!TERMINAL_STATUSES.has(run.status)) {
    console.warn('[runFinishedNotify] run is not (yet) in a terminal status — skipping', {
      runId, status: run.status,
    });
    return;
  }

  // The run's immutable snapshot, NOT the agent row's raw `recipients`
  // column — see `mergeAgentPolicies`/`resolveRecipientUserIds` for why the
  // merged, RUN-org-derived set is the correct input (the agent row loaded
  // by `run.agent_id` is always the PARTNER BASELINE and silently drops any
  // recipient an organization added through its own override).
  const userIds = await resolveRecipientUserIds(
    {
      orgId: agent.orgId,
      partnerId: agent.partnerId,
      recipients: run.policySnapshot.effective.recipients,
    },
    run.orgId,
  );
  if (userIds.length === 0) {
    console.warn('[runFinishedNotify] no recipients resolved for finished run', { runId });
    return;
  }

  const firstLine = (run.summary ?? '').split('\n')[0]?.trim() ?? '';
  const executedActionCount =
    typeof run.outcome?.toolExecutionCount === 'number' ? (run.outcome.toolExecutionCount as number) : 0;

  // AFTER the status commit and outside any held transaction (#1105).
  await inSystemDbContext(async () => {
    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: run.orgId,
        type: 'ai',
        title: 'Agent run finished',
        message: `${agent.name}: ${firstLine || run.status}`,
        // There is no run-detail page until wave 6; link to the approvals
        // queue only when there is actually something waiting there.
        link: run.intentIds.length > 0 ? '/approvals' : null,
        metadata: {
          runId: run.id,
          agentId: agent.id,
          intentIds: run.intentIds,
          status: run.status,
          executedActionCount,
          // Part B fills this in with the verification verdict; nothing
          // populates it yet.
          verdict: null,
        },
        dedupeKey: `agent-run:${run.id}`,
      });
    }
  });
}
