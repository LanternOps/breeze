import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219): the terminal-wake fan-in. The wake must reach the
 * flow-runs queue ONLY after the transaction that terminalized the intent has
 * committed — a rolled-back terminal transition must never wake the run.
 * `runAfterDbContextCommit` is the commit-only deferral (db/index.ts #7277);
 * this double models it with an explicit commit/rollback switch.
 */
const { deferred, enqueueFlowRunSlice } = vi.hoisted(() => ({
  deferred: [] as Array<{ label: string; work: () => unknown }>,
  enqueueFlowRunSlice: vi.fn(async () => 'job-1'),
}));

vi.mock('../../db', () => ({
  runAfterDbContextCommit: (label: string, work: () => unknown) => { deferred.push({ label, work }); },
}));
vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice }));

import { scheduleFlowRunWake } from './wake';

const RUN_ID = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000001';

async function commit(): Promise<void> {
  const tasks = deferred.splice(0);
  for (const t of tasks) await t.work();
}
function rollback(): void {
  deferred.splice(0);
}

describe('scheduleFlowRunWake', () => {
  beforeEach(() => {
    deferred.length = 0;
    enqueueFlowRunSlice.mockClear();
  });

  it('defers the enqueue to after commit under a label naming the run', async () => {
    scheduleFlowRunWake(RUN_ID);
    expect(enqueueFlowRunSlice).not.toHaveBeenCalled();
    // A failed post-commit enqueue is logged with the label: it must name the run.
    expect(deferred.map((d) => d.label)).toEqual([`flow-run-wake:${RUN_ID}`]);
    await commit();
    expect(enqueueFlowRunSlice).toHaveBeenCalledTimes(1);
    expect(enqueueFlowRunSlice).toHaveBeenCalledWith(RUN_ID);
  });

  it('the enqueue runs only after commit (rollback ⇒ none)', async () => {
    scheduleFlowRunWake(RUN_ID);
    rollback();
    await commit();
    expect(enqueueFlowRunSlice).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid run id loudly instead of enqueueing garbage', () => {
    expect(() => scheduleFlowRunWake('run-1')).toThrow(/runId/);
    expect(deferred).toHaveLength(0);
  });
});
