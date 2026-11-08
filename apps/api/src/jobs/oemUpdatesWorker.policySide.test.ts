import { beforeEach, describe, expect, it, vi } from 'vitest';

// #11242: the worker's policy-side stage and its targeted refresh job.

const h = vi.hoisted(() => ({
  added: [] as Array<{ name: string; data: unknown; opts: Record<string, unknown> }>,
  addError: null as Error | null,
  processor: null as null | ((job: { name: string; data: unknown }) => Promise<unknown>),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(() => ({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) }) })) },
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function () { return {
    add: vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
      if (h.addError) throw h.addError;
      h.added.push({ name, data, opts });
      return { repeatJobKey: 'tick-key' };
    }),
    getRepeatableJobs: vi.fn(async () => []),
    close: vi.fn(),
  }; }),
  Worker: vi.fn(function (_name: string, processor: (job: { name: string; data: unknown }) => Promise<unknown>) {
    h.processor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
  Job: vi.fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/oemUpdates/alerts', () => ({ emitDeviceNotReturnedAlert: vi.fn(), resolveReturnedDeviceAlerts: vi.fn() }));
vi.mock('../services/oemUpdates/candidates', () => ({
  decideScheduledRun: vi.fn(),
  maxDispatchPerTick: vi.fn(() => 200),
  selectDueDevices: vi.fn(async () => []),
}));
vi.mock('../services/oemUpdates/dispatch', () => ({ dispatchOemUpdateRun: vi.fn() }));
vi.mock('../services/oemUpdates/resolver', () => ({ resolveOemUpdatesLinkForDevice: vi.fn() }));
vi.mock('../services/oemUpdates/rebootSweep', () => ({ runOemRebootSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/overdueSweep', () => ({ runOemOverdueSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/releaseSweep', () => ({ runOemReleaseSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/policySideStore', () => ({
  refreshOemPolicySide: vi.fn(async () => ({ upserted: 0, pages: 1, failedPages: 0 })),
}));
vi.mock('../services/oemUpdates/policySideRefreshTrigger', () => ({
  resolveOemPolicySideRefreshScope: vi.fn(async (target: unknown) => target),
}));

import { captureException } from '../services/sentry';
import { runOemOverdueSweep } from '../services/oemUpdates/overdueSweep';
import { runOemReleaseSweep } from '../services/oemUpdates/releaseSweep';
import { refreshOemPolicySide } from '../services/oemUpdates/policySideStore';
import { resolveOemPolicySideRefreshScope } from '../services/oemUpdates/policySideRefreshTrigger';
import { initializeOemUpdatesWorker, requestOemPolicySideRefresh, runOemUpdatesTick } from './oemUpdatesWorker';

const NOW = new Date('2027-01-21T02:00:00.000Z');

beforeEach(() => {
  h.added = [];
  h.addError = null;
  vi.mocked(refreshOemPolicySide).mockClear();
  vi.mocked(refreshOemPolicySide).mockResolvedValue({ upserted: 0, pages: 1, failedPages: 0 });
  vi.mocked(runOemOverdueSweep).mockClear();
  vi.mocked(runOemReleaseSweep).mockClear();
  vi.mocked(captureException).mockClear();
  vi.mocked(resolveOemPolicySideRefreshScope).mockClear();
});

describe('runOemUpdatesTick: the policy side stage', () => {
  it('the tick runs the policy side stage before overdue alerts, due rows first', async () => {
    await runOemUpdatesTick(NOW);

    const calls = vi.mocked(refreshOemPolicySide).mock.calls.map(([opts]) => opts);
    expect(calls).toEqual([{ now: NOW, dueOnly: true, source: 'tick' }, { now: NOW, source: 'tick' }]);
    const order = vi.mocked(refreshOemPolicySide).mock.invocationCallOrder;
    expect(order[1]!).toBeLessThan(vi.mocked(runOemReleaseSweep).mock.invocationCallOrder[0]!);
    expect(order[1]!).toBeLessThan(vi.mocked(runOemOverdueSweep).mock.invocationCallOrder[0]!);
  });

  it('a failing policy side stage does not stop the others', async () => {
    vi.mocked(refreshOemPolicySide).mockRejectedValueOnce(new Error('db down'));

    await runOemUpdatesTick(NOW);

    expect(runOemOverdueSweep).toHaveBeenCalledWith(NOW);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ stage: 'policy side' }));
  });
});

describe('requestOemPolicySideRefresh', () => {
  it('requestOemPolicySideRefresh dedupes per scope', async () => {
    await requestOemPolicySideRefresh({ partnerId: 'p1' });
    await requestOemPolicySideRefresh({ partnerId: 'p1' });
    await requestOemPolicySideRefresh({ orgId: 'o1' });

    expect(h.added.map(({ name }) => name)).toEqual(['policy-side-refresh', 'policy-side-refresh', 'policy-side-refresh']);
    const ids = h.added.map(({ opts }) => (opts.deduplication as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    for (const { opts, data } of h.added) {
      expect(opts).toMatchObject({ delay: 5_000, deduplication: { keepLastIfActive: true }, removeOnComplete: true });
      expect((opts.deduplication as { id: string }).id).not.toContain(':');
      expect(data).toMatchObject({ type: 'policy-side-refresh' });
    }
  });

  it('a queue error is reported, never thrown: the tick covers the device anyway', async () => {
    h.addError = new Error('redis down');
    await expect(requestOemPolicySideRefresh({ orgId: 'o1' })).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalled();
  });
});

describe('the worker processor', () => {
  it('routes a policy-side-refresh job to a scoped refresh, and a tick to the tick', async () => {
    await initializeOemUpdatesWorker();
    expect(h.processor).toBeTypeOf('function');

    await h.processor!({ name: 'policy-side-refresh', data: { type: 'policy-side-refresh', partnerId: 'p1' } });
    expect(refreshOemPolicySide).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshOemPolicySide).mock.calls[0]![0]).toMatchObject({ scope: { partnerId: 'p1' } });
    expect(runOemOverdueSweep).not.toHaveBeenCalled();

    await h.processor!({ name: 'tick', data: { type: 'tick' } });
    expect(runOemOverdueSweep).toHaveBeenCalledTimes(1);
  });

  it('a refresh job with a failed page fails, so the queue records it', async () => {
    await initializeOemUpdatesWorker();
    vi.mocked(refreshOemPolicySide).mockResolvedValueOnce({ upserted: 10, pages: 3, failedPages: 1 });

    await expect(h.processor!({ name: 'policy-side-refresh', data: { type: 'policy-side-refresh', orgId: 'o1' } }))
      .rejects.toThrow(/1 page\(s\) failed/);
    expect(vi.mocked(refreshOemPolicySide).mock.calls[0]![0]).toMatchObject({ scope: { orgId: 'o1' }, source: 'policy-write' });
  });

  it('a policy id resolving to nothing refreshes nothing', async () => {
    await initializeOemUpdatesWorker();
    vi.mocked(resolveOemPolicySideRefreshScope).mockResolvedValueOnce(null);

    await h.processor!({ name: 'policy-side-refresh', data: { type: 'policy-side-refresh', configPolicyId: 'gone' } });

    expect(refreshOemPolicySide).not.toHaveBeenCalled();
  });
});
