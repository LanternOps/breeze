/**
 * `selectStaleScheduledJobIds` window semantics, against a real DB (#1733).
 *
 * The orphan-recovery sweep keys its [maxAge, minAge) window off
 * COALESCE(scheduledAt, createdAt) — the job's intended run time, NOT createdAt.
 * That distinction is the whole safety design:
 *   - the 2-minute grace window (minAge) keeps the sweep from racing a fresh
 *     enqueue (re-enqueuing a job whose Redis job is still mid-creation), and
 *   - the 45-day bound (maxAge) keeps it from firing a long-stale window, and
 *   - keying on scheduledAt (not createdAt) keeps a future-scheduled POST-route
 *     job (created now, due in the future) from being treated as "stale" 2
 *     minutes after creation — which would otherwise fire it up to 45 days
 *     early.
 *
 * A Drizzle mock returns whatever rows we fabricate and never runs the WHERE,
 * so this must be exercised against a real DB to actually verify the predicate.
 * The function reads cross-tenant patch_jobs through the breeze_app pool, so it
 * runs under withSystemDbAccessContext exactly as the scheduler invokes it.
 *
 * Prerequisites (from apps/api):
 *   pnpm test:docker:up
 * Run (from apps/api):
 *   pnpm test:integration -- src/__tests__/integration/patchJobReconcileWindow.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { patchJobs } from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { selectStaleScheduledJobIds } from '../../jobs/patchJobExecutor';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const MIN_AGE_MS = 2 * 60 * 1000; // RECONCILE_MIN_AGE_MS
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000; // RECONCILE_MAX_AGE_MS

let jobSeq = 0;
async function seedJob(
  orgId: string,
  status: 'scheduled' | 'running' | 'completed',
  scheduledAt: Date | null,
  createdAt: Date
): Promise<string> {
  jobSeq++;
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(patchJobs)
    .values({
      orgId,
      name: `reconcile-window-${jobSeq}`,
      status,
      scheduledAt,
      createdAt,
      devicesTotal: 1,
      devicesPending: 1,
    })
    .returning({ id: patchJobs.id });
  if (!row) throw new Error('seedJob: no row returned');
  return row.id;
}

describe('selectStaleScheduledJobIds window (#1733)', () => {
  let orgId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
  });

  it('selects only scheduled rows whose run time is in [maxAge, minAge)', async () => {
    // Inside the grace window (run time 1 min ago) — excluded (likely mid-enqueue).
    const tooFresh = await seedJob(orgId, 'scheduled', new Date(NOW.getTime() - 60 * 1000), NOW);
    // Comfortably stale (run time 10 min ago) — included.
    const stale = await seedJob(
      orgId,
      'scheduled',
      new Date(NOW.getTime() - 10 * 60 * 1000),
      new Date(NOW.getTime() - 10 * 60 * 1000)
    );
    // Older than the max-age bound (run time 46 days ago) — excluded.
    const tooOld = await seedJob(
      orgId,
      'scheduled',
      new Date(NOW.getTime() - MAX_AGE_MS - 24 * 60 * 60 * 1000),
      new Date(NOW.getTime() - MAX_AGE_MS - 24 * 60 * 60 * 1000)
    );
    // Stale run time but NOT scheduled status — excluded.
    const running = await seedJob(
      orgId,
      'running',
      new Date(NOW.getTime() - 10 * 60 * 1000),
      new Date(NOW.getTime() - 10 * 60 * 1000)
    );

    const result = await withSystemDbAccessContext(() => selectStaleScheduledJobIds(NOW));
    const ids = result.map((r) => r.id);

    expect(ids).toContain(stale);
    expect(ids).not.toContain(tooFresh);
    expect(ids).not.toContain(tooOld);
    expect(ids).not.toContain(running);
  });

  it('keys the window off scheduledAt, not createdAt — a future-scheduled fresh job is excluded', async () => {
    // POST-route shape: created now, scheduled 1h in the future. createdAt is
    // well past the 2-min grace, but the run time has NOT arrived, so the sweep
    // must NOT pick it up (otherwise it would fire ~1h early).
    const futureScheduled = await seedJob(
      orgId,
      'scheduled',
      new Date(NOW.getTime() + 60 * 60 * 1000),
      new Date(NOW.getTime() - 10 * 60 * 1000)
    );

    const result = await withSystemDbAccessContext(() => selectStaleScheduledJobIds(NOW));
    const ids = result.map((r) => r.id);

    expect(ids).not.toContain(futureScheduled);
  });

  it('falls back to createdAt when scheduledAt is null (legacy rows stay recoverable)', async () => {
    // No scheduledAt; createdAt is 10 min ago → COALESCE makes it stale-eligible.
    const nullScheduled = await seedJob(
      orgId,
      'scheduled',
      null,
      new Date(NOW.getTime() - 10 * 60 * 1000)
    );

    const result = await withSystemDbAccessContext(() => selectStaleScheduledJobIds(NOW));
    const match = result.find((r) => r.id === nullScheduled);

    expect(match).toBeDefined();
    expect(match?.scheduledAt).toBeNull();
  });

  it('returns scheduledAt alongside id so the caller can preserve the delay', async () => {
    const sched = new Date(NOW.getTime() - 5 * 60 * 1000);
    const id = await seedJob(orgId, 'scheduled', sched, sched);

    const result = await withSystemDbAccessContext(() => selectStaleScheduledJobIds(NOW));
    const match = result.find((r) => r.id === id);

    expect(match?.scheduledAt?.getTime()).toBe(sched.getTime());
    // sanity: minAge boundary constant referenced so the intent is documented
    expect(MIN_AGE_MS).toBe(120000);
  });
});
