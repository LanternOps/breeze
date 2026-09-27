import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  workerProcessor: undefined as undefined | ((job: any) => Promise<unknown>),
  reconcileMock: vi.fn(),
  dispatchPendingMock: vi.fn(),
  now: 1_900_000_000_000,
  // Order-tracking spy for the pool-double-hold regression test: records
  // when the ambient system context is open/closed relative to when
  // dispatchDrPendingWork runs.
  events: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    close = shared.closeMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
    constructor(_queue: string, processor: (job: any) => Promise<unknown>) {
      shared.workerProcessor = processor;
    }
  },
  Job: class {},
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    shared.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      shared.events.push('ctx:exit');
    }
  }),
  assertOutsideHeldDbContext: vi.fn(),
}));

vi.mock('../services/drExecutionService', () => ({
  reconcileDrExecution: shared.reconcileMock,
  dispatchDrPendingWork: shared.dispatchPendingMock,
}));

import {
  enqueueDrExecutionReconcile,
  processDrExecutionReconcileJob,
  shutdownDrExecutionWorker,
} from './drExecutionWorker';
import { DelayedError } from 'bullmq';

describe('dr execution queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    shared.workerProcessor = undefined;
    shared.reconcileMock.mockReset();
    shared.dispatchPendingMock.mockReset();
    shared.dispatchPendingMock.mockImplementation(async () => {
      shared.events.push('dispatchDrPendingWork');
    });
    shared.events = [];
    vi.spyOn(Date, 'now').mockReturnValue(shared.now);
    await shutdownDrExecutionWorker();
  });

  it('uses a stable BullMQ job id for DR execution reconcile', async () => {
    await enqueueDrExecutionReconcile('exec-1', 1234);

    expect(shared.addMock).toHaveBeenCalledWith(
      'reconcile-execution',
      expect.objectContaining({
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: expect.objectContaining({ actorType: 'system' }),
      }),
      expect.objectContaining({
        jobId: 'dr-execution-exec-1',
        delay: 1234,
        attempts: 3,
      }),
    );
  });

  it('reuses an active DR execution reconcile job for the same execution id', async () => {
    const changeDelay = vi.fn().mockResolvedValue(undefined);
    shared.getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
      changeDelay,
    });

    const jobId = await enqueueDrExecutionReconcile('exec-1');

    expect(shared.addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-job');
  });

  it('wakes an existing delayed reconcile instead of leaving result work asleep', async () => {
    const changeDelay = vi.fn().mockResolvedValue(undefined);
    shared.getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
      changeDelay,
    });

    await enqueueDrExecutionReconcile('exec-1');

    expect(changeDelay).toHaveBeenCalledWith(0);
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('moves its active stable job to delayed only after reconcile commits', async () => {
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    shared.reconcileMock.mockResolvedValue({
      execution: { id: 'exec-1', status: 'running' },
      nextDelayMs: 10_000,
      pending: [],
    });
    await expect(processDrExecutionReconcileJob({
      id: 'dr-execution-exec-1',
      name: 'reconcile-execution',
      token: 'worker-token',
      data: {
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: { actorType: 'system', actorId: null, source: 'test' },
      },
      moveToDelayed,
    } as any)).rejects.toBeInstanceOf(DelayedError);

    expect(shared.reconcileMock).toHaveBeenCalledWith('exec-1');
    expect(moveToDelayed).toHaveBeenCalledWith(shared.now + 10_000, 'worker-token');
  });

  it('does not schedule another cycle for a durably denied execution', async () => {
    const moveToDelayed = vi.fn();
    shared.reconcileMock.mockResolvedValue({
      execution: { id: 'exec-1', status: 'failed', authorizationState: 'denied' },
      nextDelayMs: null,
      pending: [],
    });
    await expect(processDrExecutionReconcileJob({
      id: 'dr-execution-exec-1',
      name: 'reconcile-execution',
      token: 'worker-token',
      data: {
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: { actorType: 'system', actorId: null, source: 'test' },
      },
      moveToDelayed,
    } as any)).resolves.toEqual({ executionId: 'exec-1', status: 'failed' });

    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('rejects malformed DR execution jobs before enqueueing', async () => {
    await expect(enqueueDrExecutionReconcile('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  // #242 pool-double-hold regression: dispatch must never run while the
  // reconcile tick's ambient system context is still open — that shape held
  // two pooled connections at once and produced #2417 and #6671.
  it('dispatches pending work only after the reconcile transaction has closed', async () => {
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    shared.reconcileMock.mockResolvedValue({
      execution: { id: 'exec-1', status: 'running' },
      nextDelayMs: 10_000,
      pending: [{ kind: 'command', groupId: 'g1', groupName: 'Tier 1', deviceId: 'device-1', commandType: 'vm_restore_from_backup', payload: {}, expectedOrgId: 'org-1' }],
    });

    await expect(processDrExecutionReconcileJob({
      id: 'dr-execution-exec-1',
      name: 'reconcile-execution',
      token: 'worker-token',
      data: {
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: { actorType: 'system', actorId: null, source: 'test' },
      },
      moveToDelayed,
    } as any)).rejects.toBeInstanceOf(DelayedError);

    expect(shared.events).toEqual(['ctx:enter', 'ctx:exit', 'dispatchDrPendingWork']);
    expect(shared.dispatchPendingMock).toHaveBeenCalledWith('exec-1', [
      expect.objectContaining({ deviceId: 'device-1' }),
    ]);
  });

  it('dispatches nothing when the tick recorded no pending work (e.g. a rolled-back/lost CAS tick)', async () => {
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    shared.reconcileMock.mockResolvedValue({
      execution: { id: 'exec-1', status: 'running' },
      nextDelayMs: 2_000,
      pending: [],
    });

    await expect(processDrExecutionReconcileJob({
      id: 'dr-execution-exec-1',
      name: 'reconcile-execution',
      token: 'worker-token',
      data: {
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: { actorType: 'system', actorId: null, source: 'test' },
      },
      moveToDelayed,
    } as any)).rejects.toBeInstanceOf(DelayedError);

    expect(shared.dispatchPendingMock).not.toHaveBeenCalled();
  });
});
