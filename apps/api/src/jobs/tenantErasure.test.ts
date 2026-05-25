/**
 * Unit tests for the tenant-erasure BullMQ worker (Task 30).
 *
 * Mirrors the auditRetention.test.ts mocking pattern. End-to-end
 * cascade behavior is exercised by
 * `__tests__/integration/tenantCascade.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  queueCloseMock,
  workerCloseMock,
  cascadeDeleteOrgMock,
  createAuditLogMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  cascadeDeleteOrgMock: vi.fn(),
  createAuditLogMock: vi.fn(),
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

vi.mock('../services/tenantCascade', () => ({
  cascadeDeleteOrg: (...args: unknown[]) => cascadeDeleteOrgMock(...(args as [])),
}));

vi.mock('../services/auditService', () => ({
  createAuditLog: (...args: unknown[]) => createAuditLogMock(...(args as [])),
}));

import {
  __testOnly,
  createTenantErasureWorker,
  enqueueTenantErasure,
  getTenantErasureQueue,
  initializeTenantErasureWorker,
  shutdownTenantErasureWorker,
} from './tenantErasure';

describe('tenantErasure worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    addMock.mockResolvedValue({ id: 'tenant-erasure:org-xyz' });
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    cascadeDeleteOrgMock.mockResolvedValue({
      orgId: 'org-xyz',
      performedBy: 'admin-1',
      startedAt: '2026-05-25T00:00:00.000Z',
      durationMs: 5,
      tablesDeleted: { devices: 2 },
      totalRowsDeleted: 2,
    });
    createAuditLogMock.mockResolvedValue(undefined);
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownTenantErasureWorker();
  });

  it('exposes constant QUEUE_NAME and JOB_NAME', () => {
    expect(__testOnly.QUEUE_NAME).toBe('tenant-erasure');
    expect(__testOnly.JOB_NAME).toBe('tenant-erasure');
  });

  it('enqueueTenantErasure adds a job with a stable per-org jobId', async () => {
    const result = await enqueueTenantErasure({
      orgId: 'org-xyz',
      performedBy: 'admin-1',
      performedByEmail: 'admin@example.com',
    });
    expect(addMock).toHaveBeenCalledWith(
      'tenant-erasure',
      { orgId: 'org-xyz', performedBy: 'admin-1', performedByEmail: 'admin@example.com' },
      expect.objectContaining({
        jobId: 'tenant-erasure:org-xyz',
        attempts: 1,
      }),
    );
    expect(result.id).toBeDefined();
  });

  it('initializeTenantErasureWorker registers an error/failed handler', async () => {
    await initializeTenantErasureWorker();
    expect(capturedWorkerProcessor.current).not.toBeNull();
  });

  it('worker processor invokes cascadeDeleteOrg with the job payload', async () => {
    createTenantErasureWorker();
    const processor = capturedWorkerProcessor.current!;
    const result = await processor({
      name: 'tenant-erasure',
      id: 'tenant-erasure:org-xyz',
      data: { orgId: 'org-xyz', performedBy: 'admin-1', performedByEmail: 'admin@example.com' },
    });
    expect(cascadeDeleteOrgMock).toHaveBeenCalledWith('org-xyz', 'admin-1', 'admin@example.com');
    expect(result).toMatchObject({
      orgId: 'org-xyz',
      totalRowsDeleted: 2,
      jobId: 'tenant-erasure:org-xyz',
    });
  });

  it('worker processor skips jobs with an unknown name', async () => {
    createTenantErasureWorker();
    const processor = capturedWorkerProcessor.current!;
    const result = await processor({
      name: 'something-else',
      id: 'x',
      data: { orgId: 'org-xyz', performedBy: 'admin-1' },
    });
    expect(cascadeDeleteOrgMock).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
  });

  it('worker processor writes a tenant.erasure.failed audit row on failure', async () => {
    cascadeDeleteOrgMock.mockRejectedValueOnce(new Error('cascade boom'));
    createTenantErasureWorker();
    const processor = capturedWorkerProcessor.current!;

    await expect(
      processor({
        name: 'tenant-erasure',
        id: 'tenant-erasure:org-xyz',
        data: { orgId: 'org-xyz', performedBy: 'admin-1' },
      }),
    ).rejects.toThrow(/cascade boom/);

    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.erasure.failed',
        resourceId: 'org-xyz',
        result: 'failure',
      }),
    );
  });

  it('shutdownTenantErasureWorker closes worker + queue', async () => {
    await initializeTenantErasureWorker();
    // Touch the queue so it gets created (and then closed).
    getTenantErasureQueue();
    await shutdownTenantErasureWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
  });
});
