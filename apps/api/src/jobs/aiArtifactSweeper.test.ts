/**
 * Execution-plane W01 (spec §6.1 "sweeper deletes blob then row", §12). The
 * order is the whole contract: the row is the only index to the blob key, so a
 * row deleted first strands the bytes permanently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  deleted: [] as unknown[],
  calls: [] as string[],
  blobDelete: vi.fn(async (key: string) => { mocks.calls.push(`blob:${key}`); }),
  withSystem: vi.fn(),
  runOutside: vi.fn(),
  attach: vi.fn(),
  scheduleAdd: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = mocks.scheduleAdd; getRepeatableJobs = async () => []; close = async () => {}; },
  Worker: class { close = async () => {}; },
  Job: class {},
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(async () => mocks.rows.shift() ?? []) })) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { mocks.calls.push('row:delete'); mocks.deleted.push(w); }) })),
  },
  withSystemDbAccessContext: mocks.withSystem,
  runOutsideDbContext: mocks.runOutside,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.attach }));
vi.mock('../services/artifacts/blobStorage', () => ({ getBlobStorage: () => ({ delete: mocks.blobDelete }) }));

import {
  AI_ARTIFACT_SWEEP_BATCH,
  AI_ARTIFACT_SWEEPER_QUEUE,
  initializeAiArtifactSweeper,
  sweepExpiredArtifacts,
} from './aiArtifactSweeper';

beforeEach(() => {
  mocks.rows.length = 0; mocks.deleted.length = 0; mocks.calls.length = 0;
  mocks.blobDelete.mockClear().mockImplementation(async (key: string) => { mocks.calls.push(`blob:${key}`); });
  mocks.scheduleAdd.mockClear();
  mocks.withSystem.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.runOutside.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

const row = (id: string, key: string) => ({ id, blobKey: key });

describe('sweepExpiredArtifacts', () => {
  it('deletes the BLOB before the ROW for each expired artifact', async () => {
    mocks.rows.push([row('a1', 'us/2026/09/k1')], []);
    const stats = await sweepExpiredArtifacts();
    expect(mocks.calls).toEqual(['blob:us/2026/09/k1', 'row:delete']);
    expect(stats).toEqual({ blobsDeleted: 1, rowsDeleted: 1, failed: 0 });
  });

  it('pages in batches of 200 until a short page ends the sweep', async () => {
    const full = Array.from({ length: AI_ARTIFACT_SWEEP_BATCH }, (_, i) => row(`f${i}`, `us/2026/09/k${i}`));
    mocks.rows.push(full, [row('last', 'us/2026/09/kl')], []);
    const stats = await sweepExpiredArtifacts();
    expect(stats.rowsDeleted).toBe(AI_ARTIFACT_SWEEP_BATCH + 1);
  });

  it('LEAVES the row when its blob delete fails, counts it, and keeps sweeping', async () => {
    mocks.rows.push([row('bad', 'us/2026/09/boom'), row('good', 'us/2026/09/ok')], []);
    mocks.blobDelete.mockImplementation(async (key: string) => {
      mocks.calls.push(`blob:${key}`);
      if (key.endsWith('boom')) throw new Error('bucket down');
    });
    const stats = await sweepExpiredArtifacts();
    expect(stats).toEqual({ blobsDeleted: 1, rowsDeleted: 1, failed: 1 });
    // One row delete only — the failed artifact keeps its row so the NEXT
    // sweep can find the key again. That is what makes the sweep rerunnable.
    expect(mocks.calls.filter((c) => c === 'row:delete')).toHaveLength(1);
  });

  it('runs under a SYSTEM context (the scan is deliberately cross-org)', async () => {
    mocks.rows.push([], []);
    await sweepExpiredArtifacts();
    expect(mocks.withSystem).toHaveBeenCalled();
  });

  it('is a no-op when nothing has expired', async () => {
    mocks.rows.push([]);
    expect(await sweepExpiredArtifacts()).toEqual({ blobsDeleted: 0, rowsDeleted: 0, failed: 0 });
    expect(mocks.blobDelete).not.toHaveBeenCalled();
  });
});

describe('initializeAiArtifactSweeper', () => {
  it('registers the repeatable job on its allocated hourly slot', async () => {
    await initializeAiArtifactSweeper();
    const opts = mocks.scheduleAdd.mock.calls[0]![2] as { repeat: { pattern: string }; jobId: string };
    expect(opts.repeat.pattern).toBe('2 * * * *');
    expect(opts.jobId).toBe(AI_ARTIFACT_SWEEPER_QUEUE);
  });
});
