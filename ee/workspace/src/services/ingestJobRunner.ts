// W3: ingestJobRunner — the budgeted, in-request phase pipeline that drives one
// claimed ingest job through ingest → enrich → crosswalk → complete.
//
// There is NO background worker, queue, or timer: advance() is invoked from an
// authenticated agent/admin request handler (Tasks 5/6). It claims the single
// due job for the org, works a wall-clock budget in batches, and hands the job
// back to `pending` so the next request continues it. Because a phase_complete
// release flips the job back to `pending`, each advance() call carries a job
// through at most ONE phase; the caller (or the next poke) re-claims it in the
// next phase.
//
// All staleness / due / backoff decisions live in jobsService against the DB
// clock. The injectable `clock` here bounds ONLY the in-memory work budget and
// is faked in unit tests; it never enters a persisted timestamp comparison.
import type { IngestJobRow, createIngestJobsService } from './ingestJobsService';
import type { IngestRunResult } from './contentIngestService';
import { isTransientIngestError } from './ingestErrors';

export const DEFAULT_ADVANCE_BUDGET_MS = 4_000;
export const AGENT_POKE_BUDGET_MS = 3_000;
export const DEFAULT_BATCH = 8;
// Kept at 2 (not 4): advance()'s budget is checked only BETWEEN batches, so one
// batch against a slow SMB share can overrun the poke budget by up to a full
// batch inside a single GET /crawl-config. The Go agent's crawl-config HTTP
// client caps that request at 30s (agent/internal/workspaceindex/client.go
// requestTimeout), and per-file SMB reads are bounded at 8s
// (WORKSPACE_CONTENT_SMB_TIMEOUT_MS), so 2 files keeps the worst-case overrun
// comfortably inside the agent's timeout.
export const AGENT_POKE_BATCH = 2;

/** The enrichment pass's per-run result shape (mirrors enrichmentService.run). */
export interface EnrichRunResult {
  processed: number;
  remaining: number;
  errors: Array<{ fileIndexId: string; relPath: string; error: string }>;
  /**
   * Set when the run stopped on a PERMANENT AI failure — no provider on this
   * deployment, AI switched off for the org, a partner plan without AI, or an
   * unpriced model id. `remaining` is reported as 0 so this phase drains and
   * the job advances; the flag exists so a caller that asked for enrichment
   * EXPLICITLY (the admin enrich-run route) can still answer honestly instead
   * of "0 files, all done", and so `advance()` can leave a stats crumb saying
   * why the phase produced nothing.
   */
  aiUnavailable?: true;
}

export interface AdvanceResult {
  advanced: boolean;
  job: IngestJobRow | null;
}

export function createIngestJobRunner(deps: {
  jobs: ReturnType<typeof createIngestJobsService>;
  contentIngest: {
    run(orgId: string, batch: number, opts?: { force?: boolean; forceSince?: Date }): Promise<IngestRunResult>;
  };
  enrichment: { run(orgId: string, batch: number): Promise<EnrichRunResult> };
  crosswalk: { run(orgId: string): Promise<unknown> };
  getSettings(orgId: string): Promise<{ contentEnabled: boolean }>;
  log(msg: string): void;
  clock?: () => number; // injectable for budget tests; default Date.now
}): { advance(orgId: string, opts?: { budgetMs?: number; batch?: number }): Promise<AdvanceResult> } {
  const clock = deps.clock ?? Date.now;

  async function advance(
    orgId: string,
    opts?: { budgetMs?: number; batch?: number },
  ): Promise<AdvanceResult> {
    const budgetMs = opts?.budgetMs ?? DEFAULT_ADVANCE_BUDGET_MS;
    const batch = opts?.batch ?? DEFAULT_BATCH;

    // 1. Content disabled for this org: any queued job sits pending and
    //    harmless (it still surfaces on the dashboard). Never claim.
    const { contentEnabled } = await deps.getSettings(orgId);
    if (!contentEnabled) return { advanced: false, job: null };

    // 2. Atomically claim the single due job (or reclaim a stale running one).
    const job = await deps.jobs.claimDue(orgId);
    if (!job) return { advanced: false, job: null };

    const t0 = clock();
    // Never-drains tracking for the enrich phase. `prevEnrichRemaining` scopes
    // to consecutive batches within THIS advance() call; `persistedEnrichBaseline`
    // (from stats.lastEnrichRemaining, written after each enrich batch) carries
    // the baseline ACROSS advance() calls, so a budget that permits only one
    // enrich batch per poke still detects a wedge instead of re-burning LLM
    // calls forever.
    let prevEnrichRemaining = Number.POSITIVE_INFINITY;
    const rawEnrichBaseline = job.stats?.lastEnrichRemaining;
    const persistedEnrichBaseline =
      typeof rawEnrichBaseline === 'number' ? rawEnrichBaseline : Number.POSITIVE_INFINITY;

    try {
      // 3. Work the current phase in batches until the budget is spent. Every
      //    phase transition (or terminal state) releases and returns, so the
      //    phase is invariant across this loop's lifetime.
      while (clock() - t0 < budgetMs) {
        if (job.phase === 'ingest') {
          const r = await deps.contentIngest.run(
            orgId,
            batch,
            job.force ? { force: true, forceSince: job.startedAt ?? undefined } : undefined,
          );
          if (r.transient) {
            // Source likely down: back the whole job off, leave files pending.
            deps.log(`ingest job ${job.id}: transient (${r.transient.reason}) — backing off`);
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'transient_error',
              error: r.transient.reason,
            });
            return { advanced: true, job: released };
          }
          await deps.jobs.recordProgress(orgId, job.id, {
            // ingested/ingestErrors are running totals — accumulate them so a
            // multi-batch ingest doesn't reset to the last batch's counts.
            counterPatch: { ingested: r.processed, ingestErrors: r.errors.length },
            statsPatch: { remaining: r.remaining },
          });
          if (r.remaining === 0) {
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'phase_complete',
              nextPhase: 'enrich',
            });
            return { advanced: true, job: released };
          }
          // Degenerate-sweep guard: a batch that advanced nothing (processed 0)
          // and is not a source-down transient (those return above) can never
          // progress on a re-poke — the same files would be re-selected forever.
          // Complete the phase so a force/reingest job whose remaining is
          // non-zero yet unworkable can't loop across pokes. (The r.remaining===0
          // check above already handles the normal drained case.)
          if (r.processed === 0 && !r.transient) {
            deps.log(`ingest job ${job.id}: no progress this batch — completing ingest phase`);
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'phase_complete',
              nextPhase: 'enrich',
            });
            return { advanced: true, job: released };
          }
          continue;
        }

        if (job.phase === 'enrich') {
          const r = await deps.enrichment.run(orgId, batch);
          if (r.aiUnavailable) {
            // A drained-because-AI-is-unavailable phase is otherwise
            // INDISTINGUISHABLE from an empty queue: same remaining 0, same
            // phase_complete, and nothing on the job saying why not one file
            // was enriched. Mirror the enrichSkipped crumb below so the
            // dashboard and an operator reading job stats can tell "nothing to
            // do" from "this org has no usable AI provider".
            deps.log(`enrich job ${job.id}: ai_unavailable for this org — draining enrich phase`);
            await deps.jobs.recordProgress(orgId, job.id, {
              statsPatch: { enrichSkippedReason: 'ai_unavailable' },
            });
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'phase_complete',
              nextPhase: 'crosswalk',
            });
            return { advanced: true, job: released };
          }
          if (r.remaining === 0) {
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'phase_complete',
              nextPhase: 'crosswalk',
            });
            return { advanced: true, job: released };
          }
          // Never-drains guard: a batch that "processed" files without shrinking
          // the pending set, where every processed file errored, is wedged on
          // permanently-unclassifiable rows (their enrichment row stays
          // model=NULL, so they never leave the pending predicate). Skipping the
          // phase keeps the job moving; those files stay re-enrichable by the
          // legacy admin loop, by design. We compare the fresh batch against
          // BOTH baselines — the in-advance one (consecutive batches this call)
          // and the persisted one (across advance() calls) — so single-batch
          // budgets still trip the guard instead of re-burning LLM calls.
          const madeNoProgress = r.processed > 0 && r.errors.length === r.processed;
          if (
            madeNoProgress &&
            (r.remaining >= prevEnrichRemaining || r.remaining >= persistedEnrichBaseline)
          ) {
            deps.log(`enrich job ${job.id}: ${r.remaining} unclassifiable — skipping to crosswalk`);
            await deps.jobs.recordProgress(orgId, job.id, {
              statsPatch: { enrichSkipped: r.remaining },
            });
            const released = await deps.jobs.release(orgId, job.id, {
              kind: 'phase_complete',
              nextPhase: 'crosswalk',
            });
            return { advanced: true, job: released };
          }
          // Persist the baseline so the NEXT advance() can detect a wedge even
          // when this poke only had budget for a single enrich batch.
          await deps.jobs.recordProgress(orgId, job.id, {
            statsPatch: { lastEnrichRemaining: r.remaining },
          });
          prevEnrichRemaining = r.remaining;
          continue;
        }

        // phase === 'crosswalk': recompute the org's crosswalk once, then done.
        await deps.crosswalk.run(orgId);
        const released = await deps.jobs.release(orgId, job.id, { kind: 'complete' });
        return { advanced: true, job: released };
      }

      // 4. Budget spent with work still pending — hand the job back to pending.
      const released = await deps.jobs.release(orgId, job.id, { kind: 'yield' });
      return { advanced: true, job: released };
    } catch (e) {
      // 5. Any throw is contained: callers are request handlers and must never
      //    see a 500 from ingest advancement. A TransientIngestError (e.g. the
      //    enrich pass hitting a provider rate cap) backs off; anything else
      //    fails the job so one bad state can't wedge the loop forever.
      if (isTransientIngestError(e)) {
        deps.log(`ingest job ${job.id}: transient throw (${e.message}) — backing off`);
        const released = await deps.jobs.release(orgId, job.id, {
          kind: 'transient_error',
          error: e.message,
        });
        return { advanced: true, job: released };
      }
      deps.log(`ingest job ${job.id}: fatal — ${String(e).slice(0, 500)}`);
      const released = await deps.jobs.release(orgId, job.id, {
        kind: 'fatal_error',
        error: String(e).slice(0, 500),
      });
      return { advanced: true, job: released };
    }
  }

  return { advance };
}
