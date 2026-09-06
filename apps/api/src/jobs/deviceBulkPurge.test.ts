import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const DEV_1 = '11111111-1111-4111-8111-111111111111';
const DEV_2 = '22222222-2222-4222-8222-222222222222';

const { QueueMockCtor, WorkerMockCtor } = vi.hoisted(() => ({
  // Function expressions (not arrows) so `new Queue()` / `new Worker()` are
  // constructible under vitest's mock implementation.
  QueueMockCtor: vi.fn(function QueueMock() {
    return { add: vi.fn(), getJob: vi.fn(), close: vi.fn() };
  }),
  WorkerMockCtor: vi.fn(function WorkerMock() {
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock('bullmq', () => ({ Queue: QueueMockCtor, Worker: WorkerMockCtor }));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  getRedis: vi.fn(() => ({ __redis: true })),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/bullmqUtils', () => ({
  enqueueOrReplaceStale: vi.fn(async () => ({ id: 'enqueued' })),
}));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn(async () => undefined) }));
vi.mock('../services/agentOrgRateLimit', () => ({
  invalidateOrgDeviceCount: vi.fn(async () => undefined),
}));
vi.mock('../services/deviceLifecycle', () => ({
  purgeRemovedDevice: vi.fn(async () => ({ linkGroupId: null, linkGroupDissolved: false })),
  DeviceLifecycleError: class DeviceLifecycleError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'DeviceLifecycleError';
    }
    get status() {
      return this.code === 'NOT_FOUND' ? 404 : 409;
    }
  },
}));

/** Org id the fake `SELECT org_id ... FOR UPDATE` reports per device. */
const lockedOrgByDevice = new Map<string, string | null>();

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        execute: vi.fn(async (q: unknown) => {
          const text = JSON.stringify(q);
          // The worker's ownership re-check: SELECT org_id ... FOR UPDATE.
          const deviceId = [...lockedOrgByDevice.keys()].find((id) => text.includes(id));
          if (!deviceId) return [];
          const orgId = lockedOrgByDevice.get(deviceId);
          return orgId === null ? [] : [{ org_id: orgId }];
        }),
      }),
    ),
  },
}));

import {
  processDeviceBulkPurgeJob,
  enqueueDeviceBulkPurge,
  createDeviceBulkPurgeWorker,
  DEVICE_BULK_PURGE_MAX_TARGETS,
  type DeviceBulkPurgeJobPayload,
  type DeviceBulkPurgeResult,
} from './deviceBulkPurge';
import { purgeRemovedDevice, DeviceLifecycleError } from '../services/deviceLifecycle';
import { createAuditLog } from '../services/auditService';
import { invalidateOrgDeviceCount } from '../services/agentOrgRateLimit';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';

function payload(overrides: Partial<DeviceBulkPurgeJobPayload> = {}): DeviceBulkPurgeJobPayload {
  return {
    jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targets: [
      { deviceId: DEV_1, orgId: ORG_A, hostname: 'host-1' },
      { deviceId: DEV_2, orgId: ORG_A, hostname: 'host-2' },
    ],
    actorUserId: 'user-1',
    actorEmail: 'tech@example.com',
    partnerId: 'partner-1',
    ...overrides,
  };
}

function fakeJob(data: DeviceBulkPurgeJobPayload, name = 'device-bulk-purge') {
  const progress: unknown[] = [];
  const job = {
    name,
    id: `device-bulk-purge-${data.jobId}`,
    data,
    updateProgress: vi.fn(async (p: unknown) => {
      progress.push(p);
    }),
  };
  return { job, progress };
}

beforeEach(() => {
  vi.clearAllMocks();
  lockedOrgByDevice.clear();
  lockedOrgByDevice.set(DEV_1, ORG_A);
  lockedOrgByDevice.set(DEV_2, ORG_A);
  vi.mocked(purgeRemovedDevice).mockResolvedValue({ linkGroupId: null, linkGroupDissolved: false });
});

describe('processDeviceBulkPurgeJob', () => {
  /**
   * The payload carries the org each device belonged to when the operator
   * confirmed. A device moved to another org (or restored) between confirm and
   * execution must be SKIPPED, never deleted under stale authorisation — the
   * job runs in a SYSTEM db context, so nothing else would stop it.
   */
  it('skips a device whose org changed after enqueue and never purges it', async () => {
    lockedOrgByDevice.set(DEV_1, ORG_B);

    const { job } = fakeJob(payload());
    const result = (await processDeviceBulkPurgeJob(job as never)) as DeviceBulkPurgeResult;

    expect(result.skipped).toEqual([{ deviceId: DEV_1, code: 'ORG_CHANGED' }]);
    expect(result.purged).toEqual([DEV_2]);
    expect(vi.mocked(purgeRemovedDevice).mock.calls.map((c) => c[1])).toEqual([DEV_2]);
  });

  it('skips a device that vanished before the worker reached it (NOT_FOUND)', async () => {
    lockedOrgByDevice.set(DEV_1, null); // lock returns zero rows

    const { job } = fakeJob(payload());
    const result = (await processDeviceBulkPurgeJob(job as never)) as DeviceBulkPurgeResult;

    expect(result.skipped).toEqual([{ deviceId: DEV_1, code: 'NOT_FOUND' }]);
    expect(result.purged).toEqual([DEV_2]);
  });

  it('maps a DeviceLifecycleError to its code in skipped', async () => {
    vi.mocked(purgeRemovedDevice).mockImplementation(async (_tx, id) => {
      if (id === DEV_1) throw new DeviceLifecycleError('UNINSTALL_PENDING', 'queued');
      if (id === DEV_2) throw new DeviceLifecycleError('NOT_REMOVED', 'restored');
      return { linkGroupId: null, linkGroupDissolved: false };
    });

    const { job } = fakeJob(payload());
    const result = (await processDeviceBulkPurgeJob(job as never)) as DeviceBulkPurgeResult;

    expect(result.purged).toEqual([]);
    expect(result.skipped).toEqual([
      { deviceId: DEV_1, code: 'UNINSTALL_PENDING' },
      { deviceId: DEV_2, code: 'NOT_REMOVED' },
    ]);
    // A refusal is not a job failure: the other devices still ran.
    expect(purgeRemovedDevice).toHaveBeenCalledTimes(2);
  });

  it('records an unexpected error as ERROR and keeps going', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(purgeRemovedDevice).mockImplementation(async (_tx, id) => {
        if (id === DEV_1) throw new Error('connection terminated');
        return { linkGroupId: null, linkGroupDissolved: false };
      });

      const { job } = fakeJob(payload());
      const result = (await processDeviceBulkPurgeJob(job as never)) as DeviceBulkPurgeResult;

      expect(result.skipped).toEqual([{ deviceId: DEV_1, code: 'ERROR' }]);
      expect(result.purged).toEqual([DEV_2]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('audits every purged device with the bulk job id and invalidates each org once', async () => {
    const { job } = fakeJob(
      payload({
        targets: [
          { deviceId: DEV_1, orgId: ORG_A, hostname: 'host-1' },
          { deviceId: DEV_2, orgId: ORG_B, hostname: 'host-2' },
        ],
      }),
    );
    lockedOrgByDevice.set(DEV_2, ORG_B);

    await processDeviceBulkPurgeJob(job as never);

    // The device row is GONE, so the audit entry is the only durable record
    // that this destructive operation happened at all.
    expect(createAuditLog).toHaveBeenCalledTimes(2);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_A,
        action: 'device.permanent_delete',
        resourceId: DEV_1,
        resourceName: 'host-1',
        actorId: 'user-1',
        details: expect.objectContaining({ bulkJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        result: 'success',
      }),
    );
    // Once per touched ORG, not once per device — the cache key is the org's.
    expect(invalidateOrgDeviceCount).toHaveBeenCalledTimes(2);
    const orgs = vi.mocked(invalidateOrgDeviceCount).mock.calls.map((c) => c[1]);
    expect(new Set(orgs)).toEqual(new Set([ORG_A, ORG_B]));
  });

  /**
   * #2787 review — the worker discarded `PurgeResult` entirely, so a bulk purge
   * that dissolved a link group left NO trace of it. That matters more in bulk
   * than in the single route: dissolving a group unlinks sibling devices that
   * were never in the selection, and the operator who ran a 200-device purge
   * has no other way to find out it happened.
   */
  it('records a dissolved link group in the per-device audit entry', async () => {
    vi.mocked(purgeRemovedDevice).mockImplementation(async (_tx, id) =>
      id === DEV_1
        ? { linkGroupId: 'grp-vm-1', linkGroupDissolved: true }
        : { linkGroupId: null, linkGroupDissolved: false },
    );

    const { job } = fakeJob(payload());
    await processDeviceBulkPurgeJob(job as never);

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: DEV_1,
        details: expect.objectContaining({ linkGroupId: 'grp-vm-1', linkGroupDissolved: true }),
      }),
    );
  });

  it('omits the link-group fields for a device that was never in a group', async () => {
    // The negative half: a blanket `linkGroupId: null` on every entry would
    // pass the test above while making the field meaningless in the trail.
    const { job } = fakeJob(payload());
    await processDeviceBulkPurgeJob(job as never);

    const details = vi.mocked(createAuditLog).mock.calls.map((c) => c[0].details ?? {});
    expect(details).toHaveLength(2);
    for (const d of details) {
      expect(d).not.toHaveProperty('linkGroupId');
      expect(d).not.toHaveProperty('linkGroupDissolved');
    }
  });

  it('does not invalidate a device-count cache for an org whose devices were all skipped', async () => {
    vi.mocked(purgeRemovedDevice).mockRejectedValue(
      new DeviceLifecycleError('UNINSTALL_PENDING', 'queued'),
    );
    const { job } = fakeJob(payload());
    await processDeviceBulkPurgeJob(job as never);
    expect(invalidateOrgDeviceCount).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('reports progress after every device', async () => {
    const { job, progress } = fakeJob(payload());
    await processDeviceBulkPurgeJob(job as never);
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  /**
   * The validator's 500 cap is enforced by whichever process wrote the job.
   * The payload then sits in Redis and is executed later, possibly by an older
   * or newer build — so the ceiling is re-applied HERE, where the deleting
   * happens.
   */
  it('re-enforces the 500-target ceiling on the payload', async () => {
    const targets = Array.from({ length: DEVICE_BULK_PURGE_MAX_TARGETS + 10 }, (_v, i) => ({
      deviceId: `dev-${i}`,
      orgId: ORG_A,
      hostname: `host-${i}`,
    }));
    for (const t of targets) lockedOrgByDevice.set(t.deviceId, ORG_A);

    const { job, progress } = fakeJob(payload({ targets }));
    const result = (await processDeviceBulkPurgeJob(job as never)) as DeviceBulkPurgeResult;

    expect(result.purged).toHaveLength(DEVICE_BULK_PURGE_MAX_TARGETS);
    expect(progress).toHaveLength(DEVICE_BULK_PURGE_MAX_TARGETS);
  });

  it('ignores a job posted under a different name', async () => {
    const { job } = fakeJob(payload(), 'some-other-job');
    const result = await processDeviceBulkPurgeJob(job as never);
    expect(result).toEqual({ skipped: true });
    expect(purgeRemovedDevice).not.toHaveBeenCalled();
  });

  it('never audits a device it did not actually purge', async () => {
    lockedOrgByDevice.set(DEV_1, ORG_B);
    const { job } = fakeJob(payload());
    await processDeviceBulkPurgeJob(job as never);
    const auditedIds = vi.mocked(createAuditLog).mock.calls.map((c) => c[0].resourceId);
    expect(auditedIds).toEqual([DEV_2]);
  });
});

describe('enqueueDeviceBulkPurge', () => {
  it('keys the job on device-bulk-purge-<uuid> and disables retries', async () => {
    await enqueueDeviceBulkPurge(payload());

    expect(enqueueOrReplaceStale).toHaveBeenCalledTimes(1);
    const [, jobName, jobId, sent, options] = vi.mocked(enqueueOrReplaceStale).mock.calls[0]!;
    expect(jobName).toBe('device-bulk-purge');
    expect(jobId).toBe('device-bulk-purge-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(sent).toMatchObject({ partnerId: 'partner-1' });
    // attempts: 1 — a retry would re-run a half-finished purge list against
    // devices whose state has moved on since the first pass.
    expect(options).toMatchObject({ attempts: 1 });
  });
});

describe('createDeviceBulkPurgeWorker', () => {
  it('constructs a single-concurrency worker on the device-bulk-purge queue', () => {
    createDeviceBulkPurgeWorker();
    expect(WorkerMockCtor).toHaveBeenCalledTimes(1);
    const [queueName, , options] = vi.mocked(WorkerMockCtor).mock.calls[0] as unknown as [
      string,
      unknown,
      { concurrency: number },
    ];
    expect(queueName).toBe('device-bulk-purge');
    // Concurrency 1: the cascade takes wide row locks across ~40 tables, and
    // two of these racing on the same org is contention for no throughput win.
    expect(options.concurrency).toBe(1);
  });
});
