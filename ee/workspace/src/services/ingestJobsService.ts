// W3: ingestJobsService — the in-request state machine behind productized
// ingest. There is NO background worker: every advancement (claim → work a
// budget → release) runs inside an authenticated request (see the runner in a
// later task). All timestamp math uses the DATABASE clock (now()); host clocks
// never enter a comparison that decides which job is due or stale.
//
// Structure mirrors crawlRunsService.ts: a factory over the org-scoped Drizzle
// handle, raw `sql` fragments, and an explicit org_id in every WHERE (belt to
// RLS's suspenders). The one-live-job-per-(org, source) invariant is enforced
// by the partial unique index wsp_ingest_jobs_one_active_idx — ensureJob works
// with that index, it does not re-check it in application code.
import { sql } from 'drizzle-orm';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import type { WorkspaceDatabase } from '../hostTypes';
import type { IngestTrigger, IngestPhase, IngestJobStatus } from '../schema/ingestJobs';

/** source_id IS NULL (org-wide) collapses to this key in the partial unique index. */
export const ORG_WIDE_SOURCE_KEY = '00000000-0000-0000-0000-000000000000';
/** A 'running' job un-heartbeated this long is presumed dead and reclaimable.
 *  claimDue interpolates this constant into its stale-reclaim interval. */
export const STALE_JOB_MINUTES = 5;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 1_800_000;

/** Deterministic exponential backoff (no jitter): min(BASE * 2**(attempts-1), CAP). */
export function backoffMs(attempts: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (attempts - 1);
  return Math.min(raw, BACKOFF_CAP_MS);
}

export interface IngestJobRow {
  id: string;
  orgId: string;
  sourceId: string | null;
  crawlRunId: string | null;
  trigger: IngestTrigger;
  phase: IngestPhase;
  status: IngestJobStatus;
  force: boolean;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  cursor: string | null;
  stats: Record<string, unknown>;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReleaseOutcome =
  | { kind: 'yield' }
  | { kind: 'phase_complete'; nextPhase: IngestPhase }
  | { kind: 'complete' }
  | { kind: 'transient_error'; error: string }
  | { kind: 'fatal_error'; error: string };

type Raw = Record<string, unknown>;

function rawRows(res: unknown): Raw[] {
  return res as unknown as Raw[];
}

function firstRaw(res: unknown): Raw | null {
  return rawRows(res)[0] ?? null;
}

// Raw `sql`.execute() returns unmapped driver values: timestamptz comes back as
// a string (int/bool/jsonb are already native), so timestamps are coerced to
// Date here to honor the IngestJobRow contract.
function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}
function toDateOrNull(v: unknown): Date | null {
  return v == null ? null : toDate(v);
}

function mapRow(r: Raw): IngestJobRow {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    sourceId: (r.source_id as string | null) ?? null,
    crawlRunId: (r.crawl_run_id as string | null) ?? null,
    trigger: r.trigger as IngestTrigger,
    phase: r.phase as IngestPhase,
    status: r.status as IngestJobStatus,
    force: r.force as boolean,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextAttemptAt: toDate(r.next_attempt_at),
    cursor: (r.cursor as string | null) ?? null,
    stats: (r.stats as Record<string, unknown>) ?? {},
    lastError: (r.last_error as string | null) ?? null,
    startedAt: toDateOrNull(r.started_at),
    finishedAt: toDateOrNull(r.finished_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function createIngestJobsService(db: WorkspaceDatabase) {
  const d = db;

  async function ensureJob(
    orgId: string,
    opts: { sourceId?: string | null; crawlRunId?: string | null; trigger: IngestTrigger; force?: boolean },
  ): Promise<{ job: IngestJobRow; created: boolean }> {
    const sourceId = opts.sourceId ?? null;
    const crawlRunId = opts.crawlRunId ?? null;
    const force = opts.force ?? false;

    // The partial unique index is not expressible as ON CONFLICT (partial
    // predicate), so we INSERT ... WHERE NOT EXISTS and fall back to a select.
    // A concurrent racer that slips past NOT EXISTS is caught by the index
    // (23505) and lands in the same fallback. Bounded retry covers the rare
    // case where the live job completes between our skip and our select.
    for (let attempt = 0; attempt < 3; attempt++) {
      let inserted: Raw | null = null;
      try {
        // A failed insert must roll back its savepoint before the fallback SELECT.
        // The host holds an outer org-scoped transaction for the request.
        inserted = firstRaw(await d.transaction((tx) => tx.execute(sql`
          INSERT INTO workspace_ingest_jobs (org_id, source_id, crawl_run_id, trigger, force)
          SELECT ${orgId}::uuid, ${sourceId}::uuid, ${crawlRunId}::uuid,
                 ${opts.trigger}::workspace_ingest_trigger, ${force}
          WHERE NOT EXISTS (
            SELECT 1 FROM workspace_ingest_jobs
            WHERE org_id = ${orgId}
              AND COALESCE(source_id, ${ORG_WIDE_SOURCE_KEY}::uuid)
                  = COALESCE(${sourceId}::uuid, ${ORG_WIDE_SOURCE_KEY}::uuid)
              AND status IN ('pending', 'running')
          )
          RETURNING *`)));
      } catch (err) {
        if (!isPgUniqueViolation(err)) throw err;
        inserted = null;
      }
      if (inserted) return { job: mapRow(inserted), created: true };

      const existingRaw = firstRaw(await d.execute(sql`
        SELECT * FROM workspace_ingest_jobs
        WHERE org_id = ${orgId}
          AND COALESCE(source_id, ${ORG_WIDE_SOURCE_KEY}::uuid)
              = COALESCE(${sourceId}::uuid, ${ORG_WIDE_SOURCE_KEY}::uuid)
          AND status IN ('pending', 'running')
        ORDER BY created_at
        LIMIT 1`));
      if (!existingRaw) continue; // live job vanished mid-race — retry the insert

      const existing = mapRow(existingRaw);
      if (force && !existing.force) {
        // A re-ingest request upgrades a live job to force in place.
        const upgraded = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs SET force = true, updated_at = now()
          WHERE org_id = ${orgId} AND id = ${existing.id}
          RETURNING *`));
        if (!upgraded) continue; // job completed under us — retry
        return { job: mapRow(upgraded), created: false };
      }
      return { job: existing, created: false };
    }
    throw new Error('ensureJob: could not settle the active ingest job');
  }

  async function claimDue(orgId: string): Promise<IngestJobRow | null> {
    // Single-statement atomic claim. FOR UPDATE SKIP LOCKED lets concurrent
    // requests each grab a distinct due job without an advisory lock. Budgets
    // are ≤ ~5s, so a 'running' row older than 5 minutes is a dead holder.
    const r = firstRaw(await d.execute(sql`
      UPDATE workspace_ingest_jobs
      SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = (
        SELECT id FROM workspace_ingest_jobs
        WHERE org_id = ${orgId} AND (
          (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'running' AND updated_at < now() - (${STALE_JOB_MINUTES} * interval '1 minute'))
        )
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`));
    return r ? mapRow(r) : null;
  }

  async function recordProgress(
    orgId: string,
    jobId: string,
    patch: {
      cursor?: string | null;
      /** Absolute keys: overwrite-merged into stats (e.g. `remaining`). */
      statsPatch?: Record<string, unknown>;
      /** Delta keys: accumulated SQL-side so multi-batch advances sum, not
       *  overwrite (e.g. `ingested`, `ingestErrors`). */
      counterPatch?: Record<string, number>;
    },
  ): Promise<void> {
    const setCursor = patch.cursor !== undefined;
    const hasStats = patch.statsPatch !== undefined;
    const hasCounters = patch.counterPatch !== undefined;

    // Compose one stats mutation expression: statsPatch keys overwrite-merge
    // (`stats || patch`); each counterPatch key then accumulates via jsonb_set,
    // reading its base from the ORIGINAL `stats` column so counters are
    // independent of the overwrite-merge and of one another. A job spanning >1
    // batch therefore SUMS per-batch deltas instead of showing only the last.
    let statsExpr = sql`stats`;
    if (hasStats) {
      statsExpr = sql`${statsExpr} || ${JSON.stringify(patch.statsPatch)}::jsonb`;
    }
    if (hasCounters) {
      for (const [key, delta] of Object.entries(patch.counterPatch!)) {
        statsExpr = sql`jsonb_set(${statsExpr}, ARRAY[${key}], to_jsonb(COALESCE((stats->>${key})::bigint, 0) + ${delta}))`;
      }
    }
    const setStats = hasStats || hasCounters;
    // updated_at is the claim heartbeat, so it bumps on every progress write.
    await d.execute(sql`
      UPDATE workspace_ingest_jobs
      SET updated_at = now()
        ${setCursor ? sql`, cursor = ${patch.cursor}` : sql``}
        ${setStats ? sql`, stats = ${statsExpr}` : sql``}
      WHERE org_id = ${orgId} AND id = ${jobId}`);
  }

  async function release(
    orgId: string,
    jobId: string,
    outcome: ReleaseOutcome,
  ): Promise<IngestJobRow | null> {
    // Every branch guards WHERE status = 'running': 0 rows means someone else
    // reclaimed this job (stale-takeover) and the caller must drop it.
    switch (outcome.kind) {
      case 'yield': {
        const r = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs
          SET status = 'pending', next_attempt_at = now(), updated_at = now()
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
          RETURNING *`));
        return r ? mapRow(r) : null;
      }
      case 'phase_complete': {
        const r = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs
          SET status = 'pending', phase = ${outcome.nextPhase}::workspace_ingest_phase,
              cursor = NULL, attempts = 0, next_attempt_at = now(), updated_at = now()
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
          RETURNING *`));
        return r ? mapRow(r) : null;
      }
      case 'complete': {
        const r = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs
          SET status = 'complete', finished_at = now(), updated_at = now()
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
          RETURNING *`));
        return r ? mapRow(r) : null;
      }
      case 'fatal_error': {
        const r = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs
          SET status = 'failed', last_error = ${outcome.error}, finished_at = now(), updated_at = now()
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
          RETURNING *`));
        return r ? mapRow(r) : null;
      }
      case 'transient_error': {
        // Read the live attempt count so the pending-vs-failed decision (and the
        // backoff exponent) is made in JS from backoffMs — the single source of
        // truth for the schedule. The read is guarded on running so a reclaimed
        // job releases as null.
        const probe = firstRaw(await d.execute(sql`
          SELECT attempts, max_attempts FROM workspace_ingest_jobs
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'`));
        if (!probe) return null;
        const newAttempts = Number(probe.attempts) + 1;
        const maxAttempts = Number(probe.max_attempts);
        if (newAttempts >= maxAttempts) {
          const r = firstRaw(await d.execute(sql`
            UPDATE workspace_ingest_jobs
            SET attempts = ${newAttempts}, last_error = ${outcome.error},
                status = 'failed', finished_at = now(), updated_at = now()
            WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
            RETURNING *`));
          return r ? mapRow(r) : null;
        }
        const delay = backoffMs(newAttempts);
        const r = firstRaw(await d.execute(sql`
          UPDATE workspace_ingest_jobs
          SET attempts = ${newAttempts}, last_error = ${outcome.error}, status = 'pending',
              next_attempt_at = now() + (${delay} * interval '1 millisecond'), updated_at = now()
          WHERE org_id = ${orgId} AND id = ${jobId} AND status = 'running'
          RETURNING *`));
        return r ? mapRow(r) : null;
      }
    }
  }

  async function list(orgId: string, limit = 50): Promise<IngestJobRow[]> {
    const clamped = Math.max(1, Math.min(50, Math.floor(limit)));
    return rawRows(await d.execute(sql`
      SELECT * FROM workspace_ingest_jobs
      WHERE org_id = ${orgId}
      ORDER BY created_at DESC
      LIMIT ${clamped}`)).map(mapRow);
  }

  async function get(orgId: string, jobId: string): Promise<IngestJobRow | null> {
    const r = firstRaw(await d.execute(sql`
      SELECT * FROM workspace_ingest_jobs
      WHERE org_id = ${orgId} AND id = ${jobId}
      LIMIT 1`));
    return r ? mapRow(r) : null;
  }

  return { ensureJob, claimDue, recordProgress, release, list, get };
}
