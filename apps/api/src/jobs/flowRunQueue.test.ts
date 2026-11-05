import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runRows, enqueueOrReplaceStale, fakeQueue } = vi.hoisted(() => ({
  runRows: [] as Array<Array<{ status: string; resumeSeq: number }>>,
  enqueueOrReplaceStale: vi.fn(async (_q: unknown, _n: string, jobId: string) => ({ id: jobId })),
  fakeQueue: { name: 'flow-runs' },
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => runRows.shift() ?? [] }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/bullmqQueue', () => ({ createInstrumentedQueue: vi.fn(() => fakeQueue) }));
vi.mock('../services/bullmqUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/bullmqUtils')>()),
  enqueueOrReplaceStale,
}));

import { FLOW_RUNS_QUEUE, enqueueFlowRunSlice } from './flowRunQueue';

const RUN_ID = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000001';

describe('flow-runs queue producer', () => {
  beforeEach(() => {
    runRows.length = 0;
    enqueueOrReplaceStale.mockClear();
  });

  it('is the flow-runs queue', () => {
    expect(FLOW_RUNS_QUEUE).toBe('flow-runs');
  });

  it('enqueues one slice keyed by (run, resume_seq) with no colon in the job id', async () => {
    runRows.push([{ status: 'awaiting_approval', resumeSeq: 3 }]);
    const id = await enqueueFlowRunSlice(RUN_ID);
    expect(enqueueOrReplaceStale).toHaveBeenCalledTimes(1);
    const [queue, name, jobId, payload, opts] = enqueueOrReplaceStale.mock.calls[0]! as unknown as [unknown, string, string, unknown, Record<string, unknown>];
    expect(queue).toBe(fakeQueue);
    expect(name).toBe('flow-run-slice');
    expect(jobId).toBe(`flow-run-${RUN_ID}-3`);
    expect(jobId).not.toContain(':');
    expect(payload).toEqual({ runId: RUN_ID });
    expect(opts).toMatchObject({ removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } });
    expect(id).toBe(jobId);
  });

  it('passes a delay through for a timed wake', async () => {
    runRows.push([{ status: 'waiting', resumeSeq: 1 }]);
    await enqueueFlowRunSlice(RUN_ID, { delayMs: 5_000 });
    expect((enqueueOrReplaceStale.mock.calls[0]! as unknown as unknown[])[4]).toMatchObject({ delay: 5_000 });
  });

  it.each(['completed', 'failed', 'cancelled', 'expired'])('does not enqueue a slice for a %s run', async (status) => {
    runRows.push([{ status, resumeSeq: 4 }]);
    expect(await enqueueFlowRunSlice(RUN_ID)).toBeNull();
    expect(enqueueOrReplaceStale).not.toHaveBeenCalled();
  });

  it('does not enqueue for a missing run', async () => {
    runRows.push([]);
    expect(await enqueueFlowRunSlice(RUN_ID)).toBeNull();
    expect(enqueueOrReplaceStale).not.toHaveBeenCalled();
  });
});
