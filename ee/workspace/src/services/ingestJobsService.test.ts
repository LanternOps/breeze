import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import {
  createIngestJobsService, backoffMs, ORG_WIDE_SOURCE_KEY,
  STALE_JOB_MINUTES, BACKOFF_BASE_MS, BACKOFF_CAP_MS,
} from './ingestJobsService';

const ORG = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222-2222-2222-2222-222222222222';

// Render the static SQL text of a drizzle `sql` template (params drop out —
// they are not part of the fragment we assert on). Mirrors the sqlText walk in
// crawlRunsService.test.ts.
function sqlText(value: unknown): string {
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (!value || typeof value !== 'object') return '';
  const c = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Array.isArray(c.value) && c.value.every((p) => typeof p === 'string')
    ? c.value.join('')
    : '';
  return own + (c.queryChunks ?? []).map(sqlText).join('');
}

// Flatten the bound param values of a drizzle SQL object.
function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (item && typeof item === 'object' ? boundValues(item) : [item]));
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [
    ...own,
    ...(candidate.queryChunks ?? []).flatMap((item) =>
      (item && typeof item === 'object' ? boundValues(item) : [item])),
  ];
}

function rawJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB, org_id: ORG, source_id: null, crawl_run_id: null,
    trigger: 'manual', phase: 'ingest', status: 'running', force: false,
    attempts: 0, max_attempts: 8, next_attempt_at: new Date('2026-07-19T00:00:00Z'),
    cursor: null, stats: {}, last_error: null,
    started_at: new Date('2026-07-19T00:00:00Z'), finished_at: null,
    created_at: new Date('2026-07-19T00:00:00Z'), updated_at: new Date('2026-07-19T00:00:00Z'),
    ...over,
  };
}

function makeDb(results: unknown[][] = []) {
  const calls: unknown[] = [];
  let i = 0;
  const db = {
    execute: vi.fn(async (q: unknown) => { calls.push(q); return results[i++] ?? []; }),
  };
  const transactionalDb = { ...db, transaction: vi.fn(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db)) };
  return { db: transactionalDb as unknown as WorkspaceDatabase, calls, raw: transactionalDb };
}

describe('ingestJobsService', () => {
  it('exports the produced constants verbatim', () => {
    expect(ORG_WIDE_SOURCE_KEY).toBe('00000000-0000-0000-0000-000000000000');
    expect(STALE_JOB_MINUTES).toBe(5);
    expect(BACKOFF_BASE_MS).toBe(30_000);
    expect(BACKOFF_CAP_MS).toBe(1_800_000);
  });

  it('backoffMs doubles per attempt and caps at 30 minutes', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(5)).toBe(480_000);
    expect(backoffMs(10)).toBe(1_800_000);
  });

  it('release yield → pending, next_attempt_at now(), guarded on running', async () => {
    const h = makeDb([[rawJob({ status: 'pending' })]]);
    const row = await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'yield' });
    const text = sqlText(h.calls[0]);
    expect(text).toContain("status = 'pending'");
    expect(text).toContain('next_attempt_at = now()');
    expect(text).toContain('updated_at = now()');
    expect(text).toContain("status = 'running'"); // WHERE guard
    expect(row?.status).toBe('pending');
  });

  it('release phase_complete → pending, phase set, cursor null, attempts reset', async () => {
    const h = makeDb([[rawJob({ status: 'pending', phase: 'enrich', attempts: 0 })]]);
    await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'phase_complete', nextPhase: 'enrich' });
    const text = sqlText(h.calls[0]);
    expect(text).toContain("status = 'pending'");
    expect(text).toContain('phase =');
    expect(text).toContain('cursor = NULL');
    expect(text).toContain('attempts = 0');
    expect(text).toContain('next_attempt_at = now()');
    expect(boundValues(h.calls[0])).toContain('enrich');
  });

  it('release complete → complete, finished_at now()', async () => {
    const h = makeDb([[rawJob({ status: 'complete' })]]);
    await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'complete' });
    const text = sqlText(h.calls[0]);
    expect(text).toContain("status = 'complete'");
    expect(text).toContain('finished_at = now()');
  });

  it('release fatal_error → failed, finished_at now(), records error', async () => {
    const h = makeDb([[rawJob({ status: 'failed' })]]);
    await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'fatal_error', error: 'boom' });
    const text = sqlText(h.calls[0]);
    expect(text).toContain("status = 'failed'");
    expect(text).toContain('last_error =');
    expect(text).toContain('finished_at = now()');
    expect(boundValues(h.calls[0])).toContain('boom');
  });

  it('release transient_error (attempts+1 < max) → pending with backoff', async () => {
    const h = makeDb([
      [{ attempts: 0, max_attempts: 8 }],          // status/attempts probe
      [rawJob({ status: 'pending', attempts: 1 })], // UPDATE returning
    ]);
    const row = await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'transient_error', error: 'net' });
    expect(h.raw.execute).toHaveBeenCalledTimes(2);
    const upd = sqlText(h.calls[1]);
    expect(upd).toContain("status = 'pending'");
    expect(upd).toContain('next_attempt_at = now() + (');
    expect(upd).toContain('attempts =');
    // backoffMs(1) === 30_000 must be the bound delay
    expect(boundValues(h.calls[1])).toContain(30_000);
    expect(row?.attempts).toBe(1);
  });

  it('release transient_error (attempts+1 >= max) → failed, finished_at now()', async () => {
    const h = makeDb([
      [{ attempts: 7, max_attempts: 8 }],
      [rawJob({ status: 'failed', attempts: 8 })],
    ]);
    await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'transient_error', error: 'net' });
    const upd = sqlText(h.calls[1]);
    expect(upd).toContain("status = 'failed'");
    expect(upd).toContain('finished_at = now()');
  });

  it('release transient_error returns null (no UPDATE) when the job is not running', async () => {
    const h = makeDb([[]]); // probe finds no running row
    const row = await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'transient_error', error: 'x' });
    expect(row).toBeNull();
    expect(h.raw.execute).toHaveBeenCalledTimes(1);
  });

  it('release returns null when the guarded UPDATE touches zero rows', async () => {
    const h = makeDb([[]]);
    expect(await createIngestJobsService(h.db).release(ORG, JOB, { kind: 'yield' })).toBeNull();
  });

  it('claimDue emits a single atomic claim with FOR UPDATE SKIP LOCKED', async () => {
    const h = makeDb([[rawJob({ status: 'running' })]]);
    const row = await createIngestJobsService(h.db).claimDue(ORG);
    const text = sqlText(h.calls[0]);
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain("status = 'running'");
    expect(text).toContain('next_attempt_at <= now()');
    expect(text).toContain("interval '1 minute'"); // stale reclaim, scaled by the constant
    expect(boundValues(h.calls[0])).toContain(STALE_JOB_MINUTES); // interpolated, not a literal
    expect(row?.id).toBe(JOB);
  });

  it('claimDue returns null when nothing is due', async () => {
    const h = makeDb([[]]);
    expect(await createIngestJobsService(h.db).claimDue(ORG)).toBeNull();
  });

  it('recordProgress merges stats, sets cursor, and heartbeats updated_at', async () => {
    const h = makeDb([[]]);
    await createIngestJobsService(h.db).recordProgress(ORG, JOB, { cursor: 'p2', statsPatch: { seen: 3 } });
    const text = sqlText(h.calls[0]);
    expect(text).toContain('updated_at = now()');
    expect(text).toContain('cursor =');
    expect(text).toContain('stats = stats ||');
    expect(boundValues(h.calls[0])).toEqual(expect.arrayContaining([ORG, JOB, 'p2']));
  });

  it('recordProgress accumulates counterPatch keys in SQL while overwrite-merging statsPatch', async () => {
    const h = makeDb([[]]);
    await createIngestJobsService(h.db).recordProgress(ORG, JOB, {
      counterPatch: { ingested: 3, ingestErrors: 1 },
      statsPatch: { remaining: 5 },
    });
    const text = sqlText(h.calls[0]);
    // statsPatch keeps overwrite-merge...
    expect(text).toContain('stats || ');
    // ...while each counterPatch key accumulates COALESCE(current,0)+delta via jsonb_set.
    expect(text).toContain('jsonb_set(');
    expect(text).toContain('COALESCE((stats->>');
    expect(text).toContain('::bigint, 0) +');
    expect(text).toContain('updated_at = now()');
    // both counter keys and their deltas are bound params (no literal injection).
    expect(boundValues(h.calls[0])).toEqual(
      expect.arrayContaining([ORG, JOB, 'ingested', 'ingestErrors', 3, 1]),
    );
  });

  it('list clamps the limit to [1,50] and orders newest first', async () => {
    const wide = makeDb([[]]);
    await createIngestJobsService(wide.db).list(ORG, 999);
    expect(sqlText(wide.calls[0])).toContain('ORDER BY created_at DESC');
    expect(boundValues(wide.calls[0])).toContain(50);

    const narrow = makeDb([[]]);
    await createIngestJobsService(narrow.db).list(ORG, 0);
    expect(boundValues(narrow.calls[0])).toContain(1);
  });

  it('ensureJob returns created:true when the insert lands a row', async () => {
    const h = makeDb([[rawJob({ status: 'pending' })]]);
    const res = await createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'manual' });
    expect(res.created).toBe(true);
    expect(res.job.id).toBe(JOB);
    expect(sqlText(h.calls[0])).toContain('WHERE NOT EXISTS');
  });

  it('ensureJob returns the existing live job when the insert is skipped', async () => {
    const h = makeDb([[], [rawJob({ status: 'running', force: false })]]);
    const res = await createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'manual' });
    expect(res.created).toBe(false);
    expect(res.job.id).toBe(JOB);
  });

  it.each(['raw', 'wrapped'])('ensureJob recovers a %s unique race after rolling back the insert savepoint', async (shape) => {
    const h = makeDb([[rawJob({ status: 'running' })]]);
    const pg = Object.assign(new Error('duplicate job'), { code: '23505' });
    const error = shape === 'wrapped' ? new DrizzleQueryError('INSERT', [], pg) : pg;
    h.raw.execute.mockRejectedValueOnce(error);
    const res = await createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'manual' });
    expect(res.created).toBe(false);
    expect(res.job.id).toBe(JOB);
    expect(h.raw.transaction).toHaveBeenCalledTimes(1);
    expect(h.raw.execute).toHaveBeenCalledTimes(2);
    expect(boundValues(h.calls[0])).toContain(ORG);
  });

  it('ensureJob retries when the winning job disappears before the fallback read', async () => {
    const h = makeDb([[], [rawJob()]]);
    h.raw.execute.mockRejectedValueOnce(new DrizzleQueryError('INSERT', [],
      Object.assign(new Error('duplicate job'), { code: '23505' })));
    const res = await createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'manual' });
    expect(res.created).toBe(true);
    expect(h.raw.transaction).toHaveBeenCalledTimes(2);
  });

  it('ensureJob propagates other wrapped errors without retrying', async () => {
    const h = makeDb();
    const error = new DrizzleQueryError('INSERT', [], Object.assign(new Error('denied'), { code: '42501' }));
    h.raw.execute.mockRejectedValueOnce(error);
    await expect(createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'manual' })).rejects.toBe(error);
    expect(h.raw.execute).toHaveBeenCalledTimes(1);
  });

  it('ensureJob force-upgrades a live non-force job', async () => {
    const h = makeDb([
      [],                                              // insert skipped
      [rawJob({ status: 'running', force: false })],   // existing live job
      [rawJob({ status: 'running', force: true })],    // upgraded
    ]);
    const res = await createIngestJobsService(h.db).ensureJob(ORG, { trigger: 'reingest', force: true });
    expect(res.created).toBe(false);
    expect(res.job.force).toBe(true);
    expect(h.raw.execute).toHaveBeenCalledTimes(3);
    expect(sqlText(h.calls[2])).toContain('force = true');
  });

  it('get returns null when the row is absent', async () => {
    const h = makeDb([[]]);
    expect(await createIngestJobsService(h.db).get(ORG, JOB)).toBeNull();
  });
});
