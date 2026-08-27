/**
 * Unit tests for the org-merge BullMQ worker (org-lifecycle Wave 2, Task 4).
 *
 * Mirrors `tenantErasure.test.ts`'s mocking pattern. End-to-end merge
 * behavior is exercised by the `orgMerge*.integration.test.ts` suites (Task
 * 3); this file only proves the job's own Phase-C orchestration: it calls
 * `executeOrgMerge`, then on success writes the completion audit, hands off
 * to `enqueueTenantErasure`, writes the erasure-enqueued audit, and does the
 * best-effort organization-order cleanup — and, on failure, does none of
 * that and lets BullMQ record the failure untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getJobMock,
  queueCloseMock,
  workerCloseMock,
  executeOrgMergeMock,
  enqueueTenantErasureMock,
  createAuditLogMock,
  removeOrgFromPartnerOrderMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  executeOrgMergeMock: vi.fn(),
  enqueueTenantErasureMock: vi.fn(),
  createAuditLogMock: vi.fn(),
  removeOrgFromPartnerOrderMock: vi.fn(),
  capturedWorkerProcessor: {
    current: null as null | ((job: unknown) => Promise<unknown>),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (...args: unknown[]) => addMock(...(args as []));
    getJob = (...args: unknown[]) => getJobMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/orgMerge', () => ({
  executeOrgMerge: (...args: unknown[]) => executeOrgMergeMock(...(args as [])),
}));

vi.mock('./tenantErasure', () => ({
  enqueueTenantErasure: (...args: unknown[]) => enqueueTenantErasureMock(...(args as [])),
}));

vi.mock('../services/auditService', () => ({
  createAuditLog: (...args: unknown[]) => createAuditLogMock(...(args as [])),
}));

vi.mock('../services/orgOrdering', () => ({
  removeOrgFromPartnerOrder: (...args: unknown[]) => removeOrgFromPartnerOrderMock(...(args as [])),
}));

import {
  __testOnly,
  createOrgMergeWorker,
  enqueueOrgMerge,
  getOrgMergeQueue,
  initializeOrgMergeWorker,
  shutdownOrgMergeWorker,
} from './orgMerge';

const PAYLOAD = {
  loserOrgId: 'org-loser',
  survivorOrgId: 'org-survivor',
  partnerId: 'partner-1',
  performedBy: 'admin-1',
  performedByEmail: 'admin@example.com',
};

const MERGE_RESULT = {
  tables: { devices: { moved: 3, dropped: 0 } },
  warnings: ['duplicate portal_users email under the survivor'],
  summary: { devices: { moved: 3, dropped: 0 } },
  mergeEventId: 'event-1',
};

describe('orgMerge worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    addMock.mockResolvedValue({ id: 'org-merge-org-loser' });
    getJobMock.mockResolvedValue(null);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    executeOrgMergeMock.mockResolvedValue(MERGE_RESULT);
    enqueueTenantErasureMock.mockResolvedValue({ id: 'tenant-erasure-org-loser' });
    createAuditLogMock.mockResolvedValue(undefined);
    removeOrgFromPartnerOrderMock.mockResolvedValue(undefined);
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownOrgMergeWorker();
  });

  it('exposes constant QUEUE_NAME and JOB_NAME', () => {
    expect(__testOnly.QUEUE_NAME).toBe('org-merge');
    expect(__testOnly.JOB_NAME).toBe('org-merge');
  });

  it('enqueueOrgMerge adds a job with a stable per-loser jobId', async () => {
    const result = await enqueueOrgMerge(PAYLOAD);
    expect(addMock).toHaveBeenCalledWith(
      'org-merge',
      PAYLOAD,
      expect.objectContaining({
        jobId: 'org-merge-org-loser',
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      }),
    );
    expect(result.id).toBeDefined();
  });

  /**
   * The wedge these three pin (I2). BullMQ's jobId dedup keys on "a record with
   * this id exists", not "a job with this id is pending". With `attempts: 1` and
   * `removeOnFail: { count: 50 }` a FAILED merge leaves its record behind, so a
   * bare `queue.add` under the same jobId was silently discarded — the route
   * still got a job id back and nothing ever ran again for that org. Since
   * `executeOrgMerge` unfences the loser on failure, the org looks perfectly
   * mergeable and the admin gets no signal at all.
   */
  describe('enqueueOrgMerge re-enqueue semantics', () => {
    const stubJob = (state: string) => ({
      id: 'org-merge-org-loser',
      getState: vi.fn().mockResolvedValue(state),
      remove: vi.fn().mockResolvedValue(undefined),
    });

    it('re-enqueues a FRESH job when the prior run for this org failed', async () => {
      const stale = stubJob('failed');
      getJobMock.mockResolvedValue(stale);

      const result = await enqueueOrgMerge(PAYLOAD);

      expect(stale.remove).toHaveBeenCalledTimes(1);
      expect(addMock).toHaveBeenCalledTimes(1);
      expect(addMock).toHaveBeenCalledWith(
        'org-merge',
        PAYLOAD,
        expect.objectContaining({ jobId: 'org-merge-org-loser', attempts: 1 }),
      );
      expect(result.id).toBe('org-merge-org-loser');
    });

    it.each(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])(
      'reuses the existing job without re-adding when it is %s',
      async (state) => {
        const live = stubJob(state);
        getJobMock.mockResolvedValue(live);

        const result = await enqueueOrgMerge(PAYLOAD);

        // A merge that is genuinely in flight must never be restarted
        // underneath itself — Phase B holds advisory locks and Phase A has
        // already fenced the loser.
        expect(live.remove).not.toHaveBeenCalled();
        expect(addMock).not.toHaveBeenCalled();
        expect(result.id).toBe('org-merge-org-loser');
      },
    );

    it('re-enqueues after a COMPLETED prior run so the engine, not the queue, refuses it', async () => {
      // A completed merge for this loser can only be re-requested against a
      // DIFFERENT survivor; `loadAndValidate` refuses the same pair on the
      // merits. Swallowing it here would also make the refusal depend on how
      // many other merges have run since (removeOnComplete: { count: 50 }).
      const done = stubJob('completed');
      getJobMock.mockResolvedValue(done);

      await enqueueOrgMerge(PAYLOAD);

      expect(done.remove).toHaveBeenCalledTimes(1);
      expect(addMock).toHaveBeenCalledTimes(1);
    });

    it('still enqueues when removing the stale record fails', async () => {
      const stale = stubJob('failed');
      stale.remove.mockRejectedValue(new Error('redis blip'));
      getJobMock.mockResolvedValue(stale);

      await expect(enqueueOrgMerge(PAYLOAD)).resolves.toEqual({ id: 'org-merge-org-loser' });
      expect(addMock).toHaveBeenCalledTimes(1);
    });
  });

  it('initializeOrgMergeWorker registers an error/failed handler', async () => {
    await initializeOrgMergeWorker();
    expect(capturedWorkerProcessor.current).not.toBeNull();
  });

  it('worker processor skips jobs with an unknown name', async () => {
    createOrgMergeWorker();
    const processor = capturedWorkerProcessor.current!;
    const result = await processor({ name: 'something-else', id: 'x', data: PAYLOAD });
    expect(executeOrgMergeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
  });

  describe('happy path', () => {
    it('calls executeOrgMerge, then completed audit, then erasure enqueue, then erasure audit, then ordering cleanup — in order', async () => {
      const order: string[] = [];
      executeOrgMergeMock.mockImplementation(async () => {
        order.push('executeOrgMerge');
        return MERGE_RESULT;
      });
      createAuditLogMock.mockImplementation(async (entry: { action: string }) => {
        order.push(`audit:${entry.action}`);
      });
      enqueueTenantErasureMock.mockImplementation(async () => {
        order.push('enqueueTenantErasure');
        return { id: 'tenant-erasure-org-loser' };
      });
      removeOrgFromPartnerOrderMock.mockImplementation(async () => {
        order.push('removeOrgFromPartnerOrder');
      });

      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(order).toEqual([
        'executeOrgMerge',
        'audit:org.merge.completed',
        'enqueueTenantErasure',
        'audit:org.merge.erasure_enqueued',
        'removeOrgFromPartnerOrder',
      ]);
    });

    it('passes the merge payload through to executeOrgMerge', async () => {
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(executeOrgMergeMock).toHaveBeenCalledWith({
        loserOrgId: 'org-loser',
        survivorOrgId: 'org-survivor',
        partnerId: 'partner-1',
        performedBy: 'admin-1',
        performedByEmail: 'admin@example.com',
      });
    });

    it('writes an org-less org.merge.completed audit with per-table counts and warnings', async () => {
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(createAuditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: null,
          action: 'org.merge.completed',
          resourceType: 'organization',
          resourceId: 'org-loser',
          result: 'success',
          details: expect.objectContaining({
            survivorOrgId: 'org-survivor',
            tables: MERGE_RESULT.tables,
            warnings: MERGE_RESULT.warnings,
          }),
        }),
      );
    });

    it('hands off to enqueueTenantErasure with the loser org and the original actor', async () => {
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(enqueueTenantErasureMock).toHaveBeenCalledWith({
        orgId: 'org-loser',
        performedBy: 'admin-1',
        performedByEmail: 'admin@example.com',
      });
    });

    it('writes an org-less org.merge.erasure_enqueued audit', async () => {
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(createAuditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: null,
          action: 'org.merge.erasure_enqueued',
          resourceType: 'organization',
          resourceId: 'org-loser',
          result: 'success',
        }),
      );
    });

    it('cleans up the partner organization ordering best-effort', async () => {
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;
      await processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD });

      expect(removeOrgFromPartnerOrderMock).toHaveBeenCalledWith('partner-1', 'org-loser');
    });

    it('does not let an ordering-cleanup failure fail the job', async () => {
      removeOrgFromPartnerOrderMock.mockRejectedValueOnce(new Error('ordering boom'));
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;

      await expect(
        processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD }),
      ).resolves.toBeDefined();
    });
  });

  describe('failure path', () => {
    it('propagates the executeOrgMerge failure and enqueues NO erasure', async () => {
      executeOrgMergeMock.mockRejectedValueOnce(new Error('merge boom'));
      createOrgMergeWorker();
      const processor = capturedWorkerProcessor.current!;

      await expect(
        processor({ name: 'org-merge', id: 'org-merge-org-loser', data: PAYLOAD }),
      ).rejects.toThrow(/merge boom/);

      expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
      expect(createAuditLogMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'org.merge.completed' }),
      );
      expect(createAuditLogMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'org.merge.erasure_enqueued' }),
      );
      expect(removeOrgFromPartnerOrderMock).not.toHaveBeenCalled();
    });
  });

  it('shutdownOrgMergeWorker closes worker + queue', async () => {
    await initializeOrgMergeWorker();
    getOrgMergeQueue();
    await shutdownOrgMergeWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
  });
});
