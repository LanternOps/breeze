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
import type { AgentRunVerdict, AiAgentPolicySnapshot } from '@breeze/shared';
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

const RUN_VERDICTS: ReadonlySet<AgentRunVerdict> = new Set([
  'remediated', 'needs_attention', 'partial', 'no_action',
]);

/** `run.outcome` is jsonb, read back untyped — never trust its shape. */
function readRunVerdict(outcome: Record<string, unknown>): AgentRunVerdict | null {
  const value = outcome.runVerdict;
  return typeof value === 'string' && RUN_VERDICTS.has(value as AgentRunVerdict)
    ? (value as AgentRunVerdict)
    : null;
}

interface ActSummary {
  opKey: string;
  verification: string;
  target: string;
}

/**
 * Sanitized per-op summaries for the notification: op key + target NAME
 * only, matching `actTargetSummary` (actVerify.ts) — never a raw tool
 * input/output or a full path list. Only entries that actually went through
 * the act branch (a `verification` field present) are included.
 */
function readActSummaries(outcome: Record<string, unknown>): ActSummary[] {
  const executedActions = Array.isArray(outcome.executedActions) ? outcome.executedActions : [];
  const summaries: ActSummary[] = [];
  for (const raw of executedActions) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.verification !== 'string') continue;
    summaries.push({
      opKey: typeof entry.actOpKey === 'string' ? entry.actOpKey : 'unknown',
      verification: entry.verification,
      target: typeof entry.actTargetName === 'string' ? entry.actTargetName : '',
    });
  }
  return summaries;
}

/**
 * Phase 2 wave P2-2 (scheduled sweeps), Task A7 — the sweep digest read off
 * `run.outcome.sweepFindings`. Nobody is watching a 06:00 cron occurrence and
 * a sweep leaves no badge on an alert row a technician was already looking at,
 * so this notification IS the surface for it (see `finishRun`'s notify/
 * fix-watch split). `null` for every run that produced no findings outcome,
 * which falls back to the generic title.
 *
 * `kinds` is the distinct set of kinds that actually PRODUCED a finding
 * (sorted, so the list is stable regardless of the order the model emitted
 * them) — not the kinds the schedule swept. Everything else on this
 * digest is an outcome count, and "what was found" is what a recipient acts
 * on; "what was checked" stays on the run-detail trace, which reads it off
 * `trigger_ref` (`projectSweep`).
 *
 * Read defensively at every step: `outcome` is jsonb with no compile-time
 * shape, and a pre-A7 row simply lacks these keys.
 */
interface SweepDigest {
  findings: number;
  critical: number;
  kinds: string[];
  summaryFirstLine: string;
}

function readSweepDigest(outcome: Record<string, unknown>): SweepDigest | null {
  const sweep = outcome.sweepFindings;
  if (!sweep || typeof sweep !== 'object') return null;
  const entry = sweep as Record<string, unknown>;
  const findings = Array.isArray(entry.findings) ? entry.findings : [];

  let critical = 0;
  const kinds = new Set<string>();
  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') continue;
    const finding = raw as Record<string, unknown>;
    if (finding.severity === 'critical') critical += 1;
    if (typeof finding.kind === 'string') kinds.add(finding.kind);
  }

  const summary = typeof entry.summary === 'string' ? entry.summary : '';
  return {
    findings: findings.length,
    critical,
    kinds: [...kinds].sort(),
    summaryFirstLine: summary.split('\n')[0]?.trim() ?? '',
  };
}

/** Only the two verdicts the plan names get a distinct title; `partial` and
 *  `no_action`/null keep the existing generic title (still carry `verdict`
 *  in metadata) — most orgs are not act-mode, and this keeps their
 *  notification copy unchanged. */
function verdictAwareTitle(agentName: string, verdict: AgentRunVerdict | null): string {
  if (verdict === 'remediated') return `Agent remediated an issue: ${agentName}`;
  if (verdict === 'needs_attention') return `Agent needs attention: ${agentName}`;
  return 'Agent run finished';
}

/** The only statuses `finishRun` ever commits before calling this. A run
 *  read back in any other status (e.g. a stale/duplicate retry-job delivery
 *  racing an as-yet-uncommitted transition) has nothing to notify about yet. */
const TERMINAL_STATUSES = new Set(['completed', 'awaiting_approval', 'failed']);

interface FinishedRunRow {
  id: string;
  orgId: string;
  agentId: string;
  /** Phase 2 wave P2-2, Task A7 — gates the sweep digest below. Optional
   *  because it can be absent on a row read back through an older
   *  mock/fixture; an absent value simply never matches `'sweep'` and keeps
   *  the generic copy. */
  profile?: string;
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
        profile: aiAgentRuns.profile,
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
  const verdict = readRunVerdict(run.outcome ?? {});
  const actSummary = readActSummaries(run.outcome ?? {});
  // Task A7 — a sweep run gets its own digest copy; every other profile (and
  // a sweep run that never produced findings) keeps the generic verdict-aware
  // title untouched.
  const sweep = run.profile === 'sweep' ? readSweepDigest(run.outcome ?? {}) : null;
  const title = sweep
    ? `Sweep finished: ${sweep.findings} finding(s)`
      + `${sweep.critical > 0 ? ` (${sweep.critical} critical)` : ''} — ${agent.name}`
    : verdictAwareTitle(agent.name, verdict);
  const message = sweep
    ? sweep.summaryFirstLine || `${agent.name}: ${firstLine || run.status}`
    : `${agent.name}: ${firstLine || run.status}`;
  // Anything critical escalates, exactly as `needs_attention` does for a
  // full-profile run — the two are mutually exclusive here (a sweep run never
  // produces a run verdict of its own).
  const priority = sweep ? (sweep.critical > 0 ? 'high' : null) : (verdict === 'needs_attention' ? 'high' : null);

  // AFTER the status commit and outside any held transaction (#1105).
  await inSystemDbContext(async () => {
    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: run.orgId,
        type: 'ai',
        title,
        message,
        // The run-detail page (wave 6.1) surfaces pending approvals itself,
        // so every run-finished notification links there unconditionally —
        // no more branching to '/approvals'.
        link: `/ai-agents/runs/${run.id}`,
        // Only 'needs_attention' (or, for a sweep, any critical finding)
        // escalates priority — every other verdict, including null, the
        // pre-Part-B/non-act-mode default, keeps the existing 'normal'
        // default createNotification already applies.
        ...(priority ? { priority: 'high' as const } : {}),
        metadata: {
          runId: run.id,
          agentId: agent.id,
          intentIds: run.intentIds,
          status: run.status,
          executedActionCount,
          verdict,
          ...(actSummary.length > 0 ? { actSummary } : {}),
          // `proposals` is the run's own pending-intent count: for a sweep
          // run every entry in `intent_ids` came from a converted proposal
          // (a sweep executes nothing and proposes nothing through the run
          // loop's own tool gate — `sweepLimits` pins `maxActionsPerRun: 0`).
          ...(sweep
            ? {
              sweep: {
                findings: sweep.findings,
                critical: sweep.critical,
                proposals: run.intentIds.length,
                kinds: sweep.kinds,
              },
            }
            : {}),
        },
        dedupeKey: `agent-run:${run.id}`,
      });
    }
  });
}
