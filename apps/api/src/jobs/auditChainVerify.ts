/**
 * Audit-Chain Verification Worker (issue #916 bonus / #917 sub-item L-2)
 *
 * `audit_log_verify_chain(org_id)` (v2 — migration
 * 2026-06-11-h-audit-chain-seal-and-verify.sql) walks each org's audit
 * hash-chain in `chain_seq` order on the `audit_log_chain` side table and
 * returns one row `(broken_id, expected, actual)` per break — a checksum that
 * doesn't match the canonical re-computation. An empty result set means the
 * chain is intact.
 *
 * Until now that function was only ever called by tests: a forged or
 * truncated audit chain was *detectable* but never *observed* in production.
 * This worker runs the verifier per org once a day and raises a P1 security
 * incident for any org whose chain returns ≥1 break row, so tampering pages
 * an operator instead of sitting silent.
 *
 * Why we can trust a non-empty result now (issue #1002):
 *   Before #1002, concurrent same-org inserts could fork the chain and make
 *   verify_chain report *false-positive* breaks under load. The sibling
 *   migrations in this branch —
 *     2026-06-11-g-audit-chain-table.sql (creates the append-only
 *       `audit_log_chain` side table), and
 *     2026-06-11-h-audit-chain-seal-and-verify.sql (DEFERRABLE INITIALLY
 *       DEFERRED constraint trigger seals each audit row into the side table
 *       at COMMIT under a momentary per-org advisory lock; backfill sealed
 *       historical rows)
 *   — eliminate that false-positive source: linkage is sealed serially at
 *   commit, so a non-empty verify result is a real tamper/integrity signal
 *   worth paging on.
 *
 * #1105 long-transaction pitfall:
 *   `withSystemDbAccessContext` wraps its whole callback in a single
 *   transaction. We therefore read the org list inside one short system txn
 *   and then run the per-org verify sweep via `runOutsideDbContext` so the
 *   connection is NOT held idle-in-transaction across the (potentially long)
 *   per-org loop. Each per-org verify opens and closes its own short system
 *   txn. This mirrors the guidance in CLAUDE.md ("DB Access Context").
 *
 * Throughput: this is a once-a-day integrity sweep, not a hot path. Each org
 * verify is a single function call; we run them sequentially with a small
 * delay between orgs so a large fleet doesn't hammer the primary. Per-org
 * failures are isolated (try/catch + captureException) so one bad org can't
 * abort the whole pass — same isolation rationale as auditRetention.
 *
 * Schedule: daily at 04:15 UTC — offset from auditRetention (03:30) and
 * oauthCleanup (03:00) so the integrity crons don't pile onto one minute, and
 * late enough that the nightly retention prune (which re-anchors chain heads)
 * has already settled.
 *
 * Kill switch: `AUDIT_CHAIN_VERIFY_ENABLED=false` skips schedule registration
 * (the worker still drains manual `add()` calls for incident response).
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { incidents, type IncidentTimelineEntry } from '../db/schema/incidentResponse';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import { getBullMQConnection } from '../services/redis';

const QUEUE_NAME = 'audit-chain-verify';
const JOB_NAME = 'audit-chain-verify';
const REPEAT_JOB_ID = 'audit-chain-verify';
// Daily at 04:15 UTC — after retention (03:30) and oauthCleanup (03:00).
const DAILY_CRON = '15 4 * * *';
// Small breather between per-org verifies so a large fleet doesn't hammer the
// primary during the sweep. Daily job — latency is irrelevant.
const INTER_ORG_DELAY_MS = 50;

const INCIDENT_CLASSIFICATION = 'audit_integrity';
const INCIDENT_SEVERITY = 'p1' as const;
const EVENT_SOURCE = 'audit-chain-verify';

function isEnabled(): boolean {
  const raw = process.env.AUDIT_CHAIN_VERIFY_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[AuditChainVerify] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const runOutsideDbContext = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.runOutsideDbContext !== 'function') {
    // Without the helper we can still run, just not detached from any
    // ambient context — acceptable since this worker has no ambient txn.
    return fn();
  }
  return dbModule.runOutsideDbContext(fn);
};

export interface ChainVerifyStats {
  orgsChecked: number;
  orgsBroken: number;
  alertsRaised: number;
  errors: number;
  durationMs: number;
}

interface OrgRow {
  id: string;
}

interface ChainBreakRow {
  broken_id: string;
  expected: string | null;
  actual: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the verifier for one org in its own short system transaction and return
 * any break rows. Kept tiny so the txn is never held open across the loop.
 */
async function verifyOrgChain(orgId: string): Promise<ChainBreakRow[]> {
  return runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT broken_id, expected, actual
      FROM audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as ChainBreakRow[];
    return Array.isArray(rows) ? rows : [];
  });
}

/**
 * Raise a P1 security incident for an org whose audit chain is broken, then
 * publish `incident.created` so existing escalation/notification fans out.
 * Runs in its own system txn (separate from the verify read).
 */
async function raiseChainBreakIncident(orgId: string, breaks: ChainBreakRow[]): Promise<void> {
  const now = new Date();
  const firstBrokenId = breaks[0]?.broken_id ?? 'unknown';
  const breakCount = breaks.length;
  const title = 'Audit log hash-chain integrity break detected';
  const summary =
    `audit_log_verify_chain reported ${breakCount} break row(s) for this organization. ` +
    `First broken audit_log_chain.broken_id=${firstBrokenId}. A break means a stored checksum ` +
    `no longer matches the canonical re-computation — i.e. an audit row was altered, deleted, ` +
    `or inserted out of band. Investigate immediately. ` +
    `(#1002 deferred commit-time sealing is in place, so this is not a concurrency ` +
    `false-positive.)`;

  const timeline: IncidentTimelineEntry[] = [
    {
      at: now.toISOString(),
      type: 'incident_created',
      actor: 'system',
      summary: `Audit-chain verification sweep detected ${breakCount} break row(s).`,
      metadata: {
        firstBrokenId,
        breakCount,
        // Cap the embedded sample so a fully-rewritten chain can't bloat the row.
        sample: breaks.slice(0, 20).map((b) => ({
          brokenId: b.broken_id,
          expected: b.expected,
          actual: b.actual,
        })),
      },
    },
  ];

  const [incident] = await runWithSystemDbAccess(async () =>
    dbModule.db
      .insert(incidents)
      .values({
        orgId,
        title,
        classification: INCIDENT_CLASSIFICATION,
        severity: INCIDENT_SEVERITY,
        status: 'detected',
        summary,
        relatedAlerts: [],
        affectedDevices: [],
        timeline,
        detectedAt: now,
      })
      .returning(),
  );

  // Publish best-effort: a failure here must not lose the (already-persisted)
  // incident, but should still surface to Sentry.
  try {
    await publishEvent(
      'incident.created',
      orgId,
      {
        incidentId: incident?.id,
        title,
        classification: INCIDENT_CLASSIFICATION,
        severity: INCIDENT_SEVERITY,
        brokenId: firstBrokenId,
        breakCount,
      },
      EVENT_SOURCE,
    );
  } catch (err) {
    captureException(err);
    console.error(
      `[AuditChainVerify] incident raised (id=${incident?.id}) but incident.created publish failed for org=${orgId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Walk every active organization, verify its audit hash-chain, and raise a P1
 * incident for any org that returns break rows.
 *
 * Exported for direct invocation (tests, manual incident response). The worker
 * processor calls this and surfaces the stats in the job return value.
 */
export async function verifyAuditChains(): Promise<ChainVerifyStats> {
  const startedAt = Date.now();
  const stats: ChainVerifyStats = {
    orgsChecked: 0,
    orgsBroken: 0,
    alertsRaised: 0,
    errors: 0,
    durationMs: 0,
  };

  // Read the org list in one short system txn. We deliberately do NOT keep
  // this txn open across the per-org loop (#1105) — the loop runs detached.
  const orgs = await runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT id FROM organizations WHERE status = 'active'
    `)) as unknown as OrgRow[];
    return rows;
  });

  // Detach from any ambient db context so the per-org sweep can't hold a
  // connection idle-in-transaction across the whole loop.
  await runOutsideDbContext(async () => {
    for (const org of orgs) {
      try {
        const breaks = await verifyOrgChain(org.id);
        stats.orgsChecked += 1;

        if (breaks.length > 0) {
          stats.orgsBroken += 1;
          console.error(
            `[AuditChainVerify] CHAIN BREAK org=${org.id} breaks=${breaks.length} firstBrokenId=${breaks[0]?.broken_id}`,
          );
          await raiseChainBreakIncident(org.id, breaks);
          stats.alertsRaised += 1;
          // Surface to Sentry too so ops paging fires even if the incident
          // notification pipeline is degraded.
          captureException(
            new Error(
              `Audit hash-chain integrity break: org=${org.id} breaks=${breaks.length} firstBrokenId=${breaks[0]?.broken_id}`,
            ),
          );
        }
      } catch (err) {
        stats.errors += 1;
        captureException(err);
        console.error(
          `[AuditChainVerify] verify failed for org=${org.id}:`,
          err instanceof Error ? err.message : err,
        );
      }

      if (INTER_ORG_DELAY_MS > 0) {
        await sleep(INTER_ORG_DELAY_MS);
      }
    }
  });

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[AuditChainVerify] Verified ${stats.orgsChecked} org chain(s); ${stats.orgsBroken} broken, ${stats.alertsRaised} incident(s) raised in ${stats.durationMs}ms (errors=${stats.errors})`,
  );
  return stats;
}

let verifyQueue: Queue | null = null;
let verifyWorker: Worker | null = null;

export function getAuditChainVerifyQueue(): Queue {
  if (!verifyQueue) {
    verifyQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return verifyQueue;
}

export function createAuditChainVerifyWorker(): Worker {
  verifyWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[AuditChainVerify] Ignoring unknown job name: ${job.name}`);
        return { skipped: true, orgsChecked: 0 };
      }
      return verifyAuditChains();
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
  return verifyWorker;
}

export async function scheduleAuditChainVerify(
  queue: Queue = getAuditChainVerifyQueue(),
): Promise<void> {
  // Clear any prior repeatable so a cron-pattern change takes effect on
  // redeploy (BullMQ keys repeatables by the full option set).
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isEnabled()) {
    console.log(
      '[AuditChainVerify] AUDIT_CHAIN_VERIFY_ENABLED=false — skipping schedule registration',
    );
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      // Stable jobId gives BullMQ multi-replica dedup: only one replica wins
      // the scheduled-job insert per fire time.
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[AuditChainVerify] Scheduled daily verification (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeAuditChainVerifyWorker(): Promise<void> {
  try {
    createAuditChainVerifyWorker();

    verifyWorker?.on('error', (error) => {
      console.error('[AuditChainVerify] Worker error:', error);
      captureException(error);
    });

    verifyWorker?.on('failed', (job, error) => {
      console.error(`[AuditChainVerify] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleAuditChainVerify();
    console.log('[AuditChainVerify] Worker initialized');
  } catch (error) {
    console.error('[AuditChainVerify] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAuditChainVerifyWorker(): Promise<void> {
  if (verifyWorker) {
    await verifyWorker.close();
    verifyWorker = null;
  }
  if (verifyQueue) {
    await verifyQueue.close();
    verifyQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  INCIDENT_CLASSIFICATION,
  isEnabled,
};
