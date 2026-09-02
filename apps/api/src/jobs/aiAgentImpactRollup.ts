/**
 * AI Agent Impact Rollup Worker (Phase 2 wave P2-6, #4193 task A5).
 *
 * Nightly producer + per-org fan-out for `ai_agent_impact_daily`, the
 * value-accounting rollup the Impact page reads. Shape mirrors
 * `jobs/metricRollups.ts` and `jobs/aiAgentSweepScheduler.ts`: one BullMQ
 * queue, two job shapes —
 *
 *  - `scan` — a repeatable job on the registry-allocated daily slot
 *    (`scheduleRegistry.ts`, `'ai-agent-impact-rollup'`). Finds every org
 *    with ANY impact-relevant fact in the last `IMPACT_NIGHTLY_TRAILING_DAYS`
 *    complete UTC days and enqueues one `rebuild-org-range` job per org —
 *    the trailing 7-day window for an already-bootstrapped org, or the full
 *    `AI_AGENT_IMPACT_REBUILD_DAYS` (90-day) window the first time an org is
 *    seen, so a brand-new org's page is not truthfully-but-uselessly all
 *    zero until 90 nightly passes fill it in one day at a time.
 *
 *  - `rebuild-org-range` — one `rebuildOrgImpactRange(orgId, fromDay, toDay)`
 *    call. Deterministic jobId (`buildImpactRollupJobId`) makes a duplicate
 *    enqueue for the same (org, range) a natural BullMQ no-op while the
 *    first is still waiting/delayed/active — this is what makes the manual
 *    `POST /ai/agents/impact/rebuild` endpoint safe to call repeatedly.
 *
 * Per-org error boundary (fix round 1, review finding): `processImpactScan`
 * wraps each org's bootstrap-check + job-spec build in its own try/catch,
 * exactly like `jobs/aiAgentSweepScheduler.ts:256-303`'s per-baseline
 * boundary — "One partner must never be able to stop the scan for every
 * other partner". A single `needsImpactBootstrap` rejection (a bad row, a
 * transient DB blip) used to propagate out of the whole `for` loop before
 * `addBulk` ever ran, losing the night's rollup fleet-wide. The scan is a
 * once-a-day repeatable with no `attempts`/backoff (unlike the 5-minute
 * sweeper), so a lost pass here is a lost DAY, not a lost 5 minutes — the
 * boundary matters more here, not less.
 *
 * Manual-refresh dedup (fix round 1, review finding): `enqueueImpactRollupForOrgs`
 * (the `POST /ai/agents/impact/rebuild` producer) uses `enqueueOrReplaceStale`
 * (`services/bullmqUtils.ts`) instead of a bare `addBulk` with a fixed
 * `jobId`. BullMQ's jobId dedup keys on "a record with this id exists in
 * Redis", not "a job with this id is pending" — a completed job stays keyed
 * under its `jobId` for as long as `removeOnComplete` retains it, so a
 * second manual rebuild for the same (org, range) *after the first one
 * finished* was also silently swallowed: `addBulk` returned the stale
 * completed job, the route reported success, and nothing re-ran. This is
 * the exact hazard `bullmqUtils.ts`'s own docstring describes and
 * `jobs/tenantErasure.ts`/`jobs/orgMerge.ts` already fix the same way:
 * reuse a job that is genuinely still waiting/active/delayed (so a rapid
 * double-click on Refresh still coalesces into one run), remove-and-re-add
 * one that has already completed or failed. The nightly scan fan-out
 * in `processImpactScan` keeps the plain `addBulk` shape the task brief
 * specifies unchanged — `through` shifts every day, so the same-range
 * replay this hazard describes cannot happen there.
 *
 * No worker-level system DB context, deliberately. `rebuildOrgImpactRange`,
 * `findImpactSourceOrgIds` and `needsImpactBootstrap` (`services/aiAgents/
 * impactRollup.ts`) each own one short-lived LABELLED system context per
 * call, preceded by their own `runOutsideDbContext` escape — see that
 * module's header for why. Wrapping this worker's calls in an outer context
 * would not be joined (the escape defeats it); it would only pin a second
 * idle-in-transaction connection for the whole pass, exactly the
 * `alertWorker`/#3216 trap `jobs/metricRollups.ts:122-128` documents. The
 * `runOutsideDbContext` call below on the `rebuild-org-range` branch is the
 * same belt-and-braces precedent as that file's — against a future ambient
 * context on this path, not because one exists today.
 *
 * Producer gate: `processImpactScan` re-reads `envFlag('BREEZE_AI_AGENTS_ENABLED',
 * false)` at CALL time, never a module-scope const — same convention as
 * `aiAgentSweepScheduler.ts:247-252` — so flipping the flag resumes nightly
 * rollups without a process restart. No new env flag is introduced (spec
 * §7 / plan Deviation 7): this is the existing switch, read the same way.
 */
import { Job, Queue, Worker } from 'bullmq';
import { AI_AGENT_IMPACT_REBUILD_DAYS } from '@breeze/shared';

import { envFlag } from '../config/env';
import { runOutsideDbContext } from '../db';
import {
  findImpactSourceOrgIds,
  lastCompleteUtcDay,
  needsImpactBootstrap,
  rebuildOrgImpactRange,
  shiftUtcDay,
  type UtcDay,
} from '../services/aiAgents/impactRollup';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { getBullMQConnection } from '../services/redis';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

export const AI_AGENT_IMPACT_ROLLUP_QUEUE = 'ai-agent-impact-rollup';

/** Trailing complete-day window rebuilt every night for an already-bootstrapped org. */
export const IMPACT_NIGHTLY_TRAILING_DAYS = 7;

export type ImpactRollupJobData =
  | { type: 'scan'; queuedAt?: string }
  | { type: 'rebuild-org-range'; orgId: string; fromDay: string; toDay: string; queuedAt: string };

/**
 * Deterministic — a second enqueue of the same (org, range) is a natural
 * no-op while the first is waiting/delayed/active, which is what makes the
 * manual Refresh safe to spam.
 */
export function buildImpactRollupJobId(orgId: string, fromDay: string, toDay: string): string {
  return `impact:${orgId}:${fromDay}:${toDay}`;
}

let impactRollupQueue: Queue<ImpactRollupJobData> | null = null;
let impactRollupWorker: Worker<ImpactRollupJobData> | null = null;

export function getAiAgentImpactRollupQueue(): Queue<ImpactRollupJobData> {
  if (!impactRollupQueue) {
    impactRollupQueue = new Queue<ImpactRollupJobData>(AI_AGENT_IMPACT_ROLLUP_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return impactRollupQueue;
}

interface RebuildJobSpec {
  name: 'rebuild-org-range';
  data: { type: 'rebuild-org-range'; orgId: string; fromDay: UtcDay; toDay: UtcDay; queuedAt: string };
  opts: {
    jobId: string;
    removeOnComplete: { count: number };
    removeOnFail: { count: number };
  };
}

function rebuildJobSpec(orgId: string, fromDay: UtcDay, toDay: UtcDay, queuedAt: string): RebuildJobSpec {
  return {
    name: 'rebuild-org-range',
    data: { type: 'rebuild-org-range', orgId, fromDay, toDay, queuedAt },
    opts: {
      jobId: buildImpactRollupJobId(orgId, fromDay, toDay),
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  };
}

/**
 * One nightly scan. See this module's header for the bootstrap-vs-nightly
 * window selection and the producer gate.
 *
 * `now` is injectable for tests only; production always passes the real clock.
 */
export async function processImpactScan(now: Date = new Date()): Promise<{ scanned: number; enqueued: number }> {
  // Producer gate — read at CALL time. See module header.
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return { scanned: 0, enqueued: 0 };

  const through = lastCompleteUtcDay(now);
  const nightlyFrom = shiftUtcDay(through, -(IMPACT_NIGHTLY_TRAILING_DAYS - 1));

  const orgIds = await findImpactSourceOrgIds(nightlyFrom, through);
  if (orgIds.length === 0) return { scanned: 0, enqueued: 0 };

  const queuedAt = now.toISOString();
  const jobs: RebuildJobSpec[] = [];
  for (const orgId of orgIds) {
    // Per-org error boundary. One org's bad state must never stop the scan
    // for every other org sharing this pass — same reasoning as the
    // per-baseline boundary in `aiAgentSweepScheduler.ts:256-303`. This
    // scan is a once-a-day repeatable with no `attempts`/backoff, so an
    // uncaught rejection here would lose the whole night's rollup
    // fleet-wide, not just this org's.
    try {
      const bootstrap = await needsImpactBootstrap(orgId, through);
      const from = bootstrap ? shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1)) : nightlyFrom;
      jobs.push(rebuildJobSpec(orgId, from, through, queuedAt));
    } catch (error) {
      console.error('[AiAgentImpactRollupWorker] scan failed for one org — continuing the scan', {
        orgId,
        error,
      });
    }
  }

  // Enqueue OUTSIDE any DB context: a BullMQ add is a Redis round trip, and
  // holding a pooled Postgres connection across it is the pool-exhaustion
  // trap `runService.ts` step 10 and `aiAgentSweepScheduler.ts` both call
  // out. Nothing here holds one — `findImpactSourceOrgIds` and
  // `needsImpactBootstrap` each already close their own short-lived system
  // context before returning.
  if (jobs.length > 0) {
    await getAiAgentImpactRollupQueue().addBulk(jobs);
  }

  return { scanned: orgIds.length, enqueued: jobs.length };
}

/**
 * Used by `POST /ai/agents/impact/rebuild`. Returns how many orgs were
 * enqueued-or-reused. Same deterministic jobId as the nightly scan, so a
 * manual rebuild for a range the scan is already mid-flight on reuses that
 * job rather than racing it.
 *
 * Deliberately NOT a bare `addBulk` with a fixed `jobId` (fix round 1,
 * review finding) — see this module's header for why that made every
 * manual Refresh AFTER the first one's completion a silent no-op.
 * `enqueueOrReplaceStale` (`services/bullmqUtils.ts`) reuses a job that is
 * still waiting/active/delayed and removes-then-re-adds one that has
 * already completed or failed, so a genuine repeat Refresh actually
 * rebuilds while a rapid double-click still coalesces into one run.
 */
export async function enqueueImpactRollupForOrgs(
  orgIds: readonly string[],
  fromDay: string,
  toDay: string,
): Promise<number> {
  if (orgIds.length === 0) return 0;

  const queue = getAiAgentImpactRollupQueue();
  const queuedAt = new Date().toISOString();

  await Promise.all(
    orgIds.map((orgId) =>
      enqueueOrReplaceStale(
        queue,
        'rebuild-org-range',
        buildImpactRollupJobId(orgId, fromDay, toDay),
        { type: 'rebuild-org-range' as const, orgId, fromDay, toDay, queuedAt },
        {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
        },
        '[AiAgentImpactRollupWorker]',
      ),
    ),
  );

  return orgIds.length;
}

export function createAiAgentImpactRollupWorker(): Worker<ImpactRollupJobData> {
  return new Worker<ImpactRollupJobData>(
    AI_AGENT_IMPACT_ROLLUP_QUEUE,
    async (job: Job<ImpactRollupJobData>) => {
      if (job.data.type === 'scan') return processImpactScan();

      const data = job.data;
      // No worker-level system context here — see module header.
      return runOutsideDbContext(() => rebuildOrgImpactRange(data.orgId, data.fromDay, data.toDay));
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
    },
  );
}

async function scheduleImpactScan(): Promise<void> {
  const queue = getAiAgentImpactRollupQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan',
    { type: 'scan' },
    {
      jobId: 'ai-agent-impact-rollup-scan',
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ
      // anchors `every` to the Unix epoch, so every 24h job fires at
      // 00:00:00.000 UTC together (see jobs/scheduleRegistry.ts).
      repeat: { pattern: jobSchedule('ai-agent-impact-rollup') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    },
  );
}

export async function initializeAiAgentImpactRollupWorker(): Promise<void> {
  impactRollupWorker = createAiAgentImpactRollupWorker();
  attachWorkerObservability(impactRollupWorker, 'aiAgentImpactRollupWorker');
  await scheduleImpactScan();
  console.log('[AiAgentImpactRollupWorker] Impact rollup worker initialized');
}

export async function shutdownAiAgentImpactRollupWorker(): Promise<void> {
  if (impactRollupWorker) {
    await impactRollupWorker.close();
    impactRollupWorker = null;
  }
  if (impactRollupQueue) {
    await impactRollupQueue.close();
    impactRollupQueue = null;
  }
}
