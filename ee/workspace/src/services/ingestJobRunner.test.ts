import { describe, expect, it, vi } from 'vitest';
import { createIngestJobRunner, DEFAULT_BATCH, type EnrichRunResult } from './ingestJobRunner';
import type { IngestJobRow, createIngestJobsService } from './ingestJobsService';
import type { IngestRunResult } from './contentIngestService';
import { TransientIngestError } from './ingestErrors';

const ORG = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222-2222-2222-2222-222222222222';

function makeJob(over: Partial<IngestJobRow> = {}): IngestJobRow {
  return {
    id: JOB, orgId: ORG, sourceId: null, crawlRunId: null,
    trigger: 'manual', phase: 'ingest', status: 'running', force: false,
    attempts: 0, maxAttempts: 8, nextAttemptAt: new Date('2026-07-19T00:00:00Z'),
    cursor: null, stats: {}, lastError: null,
    startedAt: new Date('2026-07-19T00:00:00Z'), finishedAt: null,
    createdAt: new Date('2026-07-19T00:00:00Z'), updatedAt: new Date('2026-07-19T00:00:00Z'),
    ...over,
  };
}

// A jobs-service double: only the methods the runner touches carry behavior.
function mockJobs(over: Record<string, unknown> = {}) {
  const jobs = {
    claimDue: vi.fn(async () => null as IngestJobRow | null),
    release: vi.fn(async () => makeJob({ status: 'pending' })),
    recordProgress: vi.fn(async () => {}),
    ensureJob: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    ...over,
  };
  return jobs as unknown as ReturnType<typeof createIngestJobsService> & typeof jobs;
}

function ingestResult(over: Partial<IngestRunResult> = {}): IngestRunResult {
  return { processed: 0, remaining: 0, errors: [], transient: null, ...over };
}

// Clock that walks a fixed sequence and then holds its last value (so a loop
// that keeps polling after the sequence never spins on an undefined budget).
function seqClock(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    jobs: mockJobs(),
    contentIngest: { run: vi.fn(async () => ingestResult()) },
    enrichment: { run: vi.fn(async (): Promise<EnrichRunResult> => ({ processed: 0, remaining: 0, errors: [] })) },
    crosswalk: { run: vi.fn(async () => ({ mined: 0 })) },
    getSettings: vi.fn(async () => ({ contentEnabled: true })),
    log: vi.fn(),
    clock: () => 0,
    ...over,
  };
}

describe('ingestJobRunner.advance', () => {
  it('no-ops when content is disabled for the org (never claims)', async () => {
    const deps = baseDeps({ getSettings: vi.fn(async () => ({ contentEnabled: false })) });
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res).toEqual({ advanced: false, job: null });
    expect(deps.jobs.claimDue).not.toHaveBeenCalled();
  });

  it('no-ops when no job is due', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(null);
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res).toEqual({ advanced: false, job: null });
    expect(deps.contentIngest.run).not.toHaveBeenCalled();
  });

  it('drives ingest → enrich → crosswalk → complete across advance() calls', async () => {
    const deps = baseDeps();
    // advance #1: ingest phase drains in one batch.
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'ingest' }));
    deps.contentIngest.run.mockResolvedValueOnce(ingestResult({ processed: 3, remaining: 0 }));
    const runner = createIngestJobRunner(deps as never);

    const r1 = await runner.advance(ORG);
    expect(r1.advanced).toBe(true);
    expect(deps.contentIngest.run).toHaveBeenCalledWith(ORG, DEFAULT_BATCH, undefined);
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      counterPatch: { ingested: 3, ingestErrors: 0 },
      statsPatch: { remaining: 0 },
    });
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'enrich',
    });

    // advance #2: enrich phase drains in one batch.
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich' }));
    deps.enrichment.run.mockResolvedValueOnce({ processed: 2, remaining: 0, errors: [] });
    const r2 = await runner.advance(ORG);
    expect(r2.advanced).toBe(true);
    expect(deps.enrichment.run).toHaveBeenCalledWith(ORG, DEFAULT_BATCH);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'crosswalk',
    });

    // advance #3: crosswalk recompute then complete.
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'crosswalk' }));
    const r3 = await runner.advance(ORG);
    expect(r3.advanced).toBe(true);
    expect(deps.crosswalk.run).toHaveBeenCalledWith(ORG);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, { kind: 'complete' });
  });

  it('passes force + forceSince from the job into the ingest run', async () => {
    const started = new Date('2026-07-19T12:00:00Z');
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'ingest', force: true, startedAt: started }));
    deps.contentIngest.run.mockResolvedValueOnce(ingestResult({ processed: 1, remaining: 0 }));
    const runner = createIngestJobRunner(deps as never);
    await runner.advance(ORG);
    expect(deps.contentIngest.run).toHaveBeenCalledWith(ORG, DEFAULT_BATCH, {
      force: true, forceSince: started,
    });
  });

  it('force ingest does NOT phase-complete while the force-aware remaining is > 0', async () => {
    // A force sweep over an estate larger than one batch: the first batch
    // re-walks `batch` files (processed 8) but the force-aware remaining still
    // reports 42 unvisited files, so the phase must NOT complete. Only a later
    // batch whose force-aware remaining hits 0 phase-completes. This is the
    // estate-sized-batch convergence bug: before the fix, remaining came from
    // the non-force snapshot count (already 0) and the job silently completed
    // after visiting only the first batch.
    const deps = baseDeps({ clock: seqClock([0, 0, 0, 4000]) });
    deps.jobs.claimDue.mockResolvedValueOnce(
      makeJob({ phase: 'ingest', force: true, startedAt: new Date('2026-07-19T00:00:00Z') }),
    );
    deps.contentIngest.run
      .mockResolvedValueOnce(ingestResult({ processed: 8, remaining: 42 }))
      .mockResolvedValueOnce(ingestResult({ processed: 8, remaining: 0 }));
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG, { budgetMs: 4000 });
    expect(res.advanced).toBe(true);
    // Two batches ran; the first (remaining 42) did not complete the phase.
    expect(deps.contentIngest.run).toHaveBeenCalledTimes(2);
    // Only ONE phase_complete release — from the batch that reached remaining 0.
    const releaseCalls = deps.jobs.release.mock.calls as unknown as Array<[string, string, { kind: string }]>;
    const completeCalls = releaseCalls.filter(([, , rel]) => rel.kind === 'phase_complete');
    expect(completeCalls).toHaveLength(1);
    expect(deps.jobs.release).toHaveBeenLastCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'enrich',
    });
  });

  it('force ingest completes the phase when a batch makes no progress (degenerate sweep guard)', async () => {
    // A force sweep whose batch processes nothing (every file already visited /
    // wedged) but reports remaining > 0 must not loop across pokes forever:
    // processed 0 with no transient completes the ingest phase.
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(
      makeJob({ phase: 'ingest', force: true, startedAt: new Date('2026-07-19T00:00:00Z') }),
    );
    deps.contentIngest.run.mockResolvedValueOnce(ingestResult({ processed: 0, remaining: 7 }));
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res.advanced).toBe(true);
    expect(deps.contentIngest.run).toHaveBeenCalledTimes(1);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'enrich',
    });
  });

  it('releases transient_error when ingest reports a transient (no progress record)', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'ingest' }));
    deps.contentIngest.run.mockResolvedValueOnce(
      ingestResult({ processed: 2, remaining: 5, transient: { reason: 'smb_read_refused', abortedAfter: 2 } }),
    );
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res.advanced).toBe(true);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'transient_error', error: 'smb_read_refused',
    });
    expect(deps.jobs.recordProgress).not.toHaveBeenCalled();
  });

  it('releases transient_error when enrich throws a TransientIngestError', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich' }));
    deps.enrichment.run.mockRejectedValueOnce(new TransientIngestError('enrich_provider_429'));
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res.advanced).toBe(true);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'transient_error', error: 'enrich_provider_429',
    });
  });

  it('yields with progress recorded when the budget is exhausted mid-ingest', async () => {
    const deps = baseDeps({ clock: seqClock([0, 0, 4000]) });
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'ingest' }));
    deps.contentIngest.run.mockResolvedValueOnce(ingestResult({ processed: 8, remaining: 5 }));
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG, { budgetMs: 4000 });
    expect(res.advanced).toBe(true);
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      counterPatch: { ingested: 8, ingestErrors: 0 },
      statsPatch: { remaining: 5 },
    });
    expect(deps.contentIngest.run).toHaveBeenCalledTimes(1);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, { kind: 'yield' });
  });

  it('skips a wedged enrich phase (never-drains) to crosswalk with enrichSkipped', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich' }));
    // Same non-draining result every batch: 3 files processed, all errored,
    // remaining stuck at 3 (permanently-unclassifiable, model stays NULL).
    const stuck = {
      processed: 3, remaining: 3,
      errors: [
        { fileIndexId: 'a', relPath: 'a', error: 'x' },
        { fileIndexId: 'b', relPath: 'b', error: 'x' },
        { fileIndexId: 'c', relPath: 'c', error: 'x' },
      ],
    };
    deps.enrichment.run.mockResolvedValue(stuck);
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res.advanced).toBe(true);
    // Baseline iteration + trip iteration.
    expect(deps.enrichment.run).toHaveBeenCalledTimes(2);
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      statsPatch: { enrichSkipped: 3 },
    });
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'crosswalk',
    });
  });

  it('persists the never-drains baseline across advance() calls (single-batch budget wedge)', async () => {
    // Budget permits exactly one enrich batch per advance: t0=0, one loop
    // iteration, then the clock jumps past the budget so the loop exits.
    const deps = baseDeps({ clock: seqClock([0, 0, 4000]) });
    const stuck = {
      processed: 3, remaining: 3,
      errors: [
        { fileIndexId: 'a', relPath: 'a', error: 'x' },
        { fileIndexId: 'b', relPath: 'b', error: 'x' },
        { fileIndexId: 'c', relPath: 'c', error: 'x' },
      ],
    };
    deps.enrichment.run.mockResolvedValue(stuck);
    const runner = createIngestJobRunner(deps as never);

    // advance #1: fresh enrich job (no baseline in stats) — one batch runs, the
    // in-advance guard can't fire yet, so it records the baseline and yields.
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich', stats: {} }));
    const r1 = await runner.advance(ORG, { budgetMs: 4000 });
    expect(r1.advanced).toBe(true);
    expect(deps.enrichment.run).toHaveBeenCalledTimes(1);
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      statsPatch: { lastEnrichRemaining: 3 },
    });
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, { kind: 'yield' });

    // advance #2: same job re-claimed carrying the persisted baseline. The very
    // first batch makes no net progress (remaining >= baseline, all errored) →
    // skip to crosswalk with enrichSkipped, WITHOUT a second in-advance batch.
    deps.jobs.claimDue.mockResolvedValueOnce(
      makeJob({ phase: 'enrich', stats: { lastEnrichRemaining: 3 } }),
    );
    const r2 = await runner.advance(ORG, { budgetMs: 4000 });
    expect(r2.advanced).toBe(true);
    expect(deps.enrichment.run).toHaveBeenCalledTimes(2); // exactly one more batch, not a re-burn loop
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      statsPatch: { enrichSkipped: 3 },
    });
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'crosswalk',
    });
  });

  it('records WHY the enrich phase drained when AI is unavailable for the org', async () => {
    // The drained-AI path used to be indistinguishable from a genuinely empty
    // queue: enrichment.run reports remaining 0, the phase completes, and the
    // job's stats say nothing at all. An operator looking at a fleet where no
    // file ever gets enriched had no signal to follow — so mirror the
    // enrichSkipped precedent and leave both a log line and a stats crumb.
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich' }));
    deps.enrichment.run.mockResolvedValueOnce({
      processed: 0, remaining: 0, errors: [], aiUnavailable: true,
    });
    const runner = createIngestJobRunner(deps as never);

    const res = await runner.advance(ORG);

    expect(res.advanced).toBe(true);
    expect(deps.jobs.recordProgress).toHaveBeenCalledWith(ORG, JOB, {
      statsPatch: { enrichSkippedReason: 'ai_unavailable' },
    });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('ai_unavailable'));
    // Still drains: the job must advance to crosswalk, not stall.
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'crosswalk',
    });
  });

  it('records nothing extra when the enrich phase drains normally', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'enrich' }));
    deps.enrichment.run.mockResolvedValueOnce({ processed: 4, remaining: 0, errors: [] });
    const runner = createIngestJobRunner(deps as never);

    await runner.advance(ORG);

    expect(deps.jobs.recordProgress).not.toHaveBeenCalled();
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, {
      kind: 'phase_complete', nextPhase: 'crosswalk',
    });
  });

  it('releases fatal_error and does not throw on an unexpected failure', async () => {
    const deps = baseDeps();
    deps.jobs.claimDue.mockResolvedValueOnce(makeJob({ phase: 'ingest' }));
    deps.contentIngest.run.mockRejectedValueOnce(new Error('boom'));
    const runner = createIngestJobRunner(deps as never);
    const res = await runner.advance(ORG);
    expect(res.advanced).toBe(true);
    expect(deps.jobs.release).toHaveBeenCalledWith(ORG, JOB, expect.objectContaining({
      kind: 'fatal_error',
      error: expect.stringContaining('boom'),
    }));
  });
});
