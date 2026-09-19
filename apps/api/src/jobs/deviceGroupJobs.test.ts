/**
 * #4630 review finding 1 — the dynamic-group re-evaluation moved off the
 * request path onto a coalescing BullMQ queue. Covers:
 *   - per-device coalescing under the fixed `group-reeval-<deviceId>` jobId,
 *     including the union-merge of changed fields and the created-subsumes-
 *     updated rule;
 *   - the active-job follow-up branch and the stale-record replace branch;
 *   - `requestDeviceGroupReevaluation` never rejecting (a Redis outage must
 *     not surface on the agent heartbeat/enrollment path);
 *   - the processor re-reading the device's OWN org id instead of trusting the
 *     job payload, and no-oping for a device that vanished.
 *
 * Plus the three #5039 review fixes:
 *   - every job carries `delay: DEVICE_GROUP_REEVALUATION_DELAY_MS` so it
 *     cannot run before the enqueuing request's transaction commits, and
 *     `delayed` stays a coalescing state;
 *   - the processor THROWS when a handler rejected, so `attempts` retries;
 *   - the job refuses to run at all when `withSystemDbAccessContext` is
 *     unavailable, rather than evaluating with no DB access context.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQueueAdd,
  mockQueueGetJob,
  mockQueueClose,
  mockSelect,
  mockWithSystemDbAccessContext,
  mockEmitDeviceChange,
  mockInitializeDeviceEventHandlers,
  dbExports,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockQueueGetJob: vi.fn(),
  mockQueueClose: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
  mockWithSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  mockEmitDeviceChange: vi.fn().mockResolvedValue(undefined),
  mockInitializeDeviceEventHandlers: vi.fn(),
  // Mutable holder behind a getter on the '../db' mock, so one test can make
  // `withSystemDbAccessContext` disappear the way a partially-loaded module
  // would (#5039 review finding 3).
  dbExports: { withSystemDbAccessContext: undefined as unknown },
}));

vi.mock('bullmq', () => ({
  // `new Queue(...)` needs a constructible mock — an arrow-function
  // mockImplementation is not one.
  Queue: class {
    add = mockQueueAdd;
    getJob = mockQueueGetJob;
    close = mockQueueClose;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: mockSelect },
  get withSystemDbAccessContext() {
    return dbExports.withSystemDbAccessContext;
  },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId' },
}));

vi.mock('../events/deviceEvents', () => ({
  emitDeviceChange: mockEmitDeviceChange,
  initializeDeviceEventHandlers: mockInitializeDeviceEventHandlers,
  createDeviceChangeEvent: (
    type: string,
    deviceId: string,
    orgId: string,
    changedFields: string[],
  ) => ({ type, deviceId, orgId, changedFields, timestamp: new Date() }),
}));

import { isReusableState } from '../services/bullmqUtils';
import {
  DEVICE_GROUP_REEVALUATION_DELAY_MS,
  deviceGroupReevaluationJobId,
  mergeReevaluationRequests,
  processDeviceGroupReevaluation,
  requestDeviceGroupReevaluation,
  runDeviceGroupReevaluationJob,
  scheduleDeviceGroupReevaluation,
  shutdownDeviceGroupJobs,
  type DeviceGroupReevaluationJobData,
} from './deviceGroupJobs';

const DEVICE_ID = 'dddd0001-dddd-dddd-dddd-dddddddddddd';
const ORG_ID = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ORG_ID = 'bbbb0000-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function selectResolving(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function jobData(overrides: Partial<DeviceGroupReevaluationJobData> = {}): DeviceGroupReevaluationJobData {
  return {
    type: 'group-reevaluation',
    deviceId: DEVICE_ID,
    orgId: ORG_ID,
    eventType: 'device.updated',
    changedFields: ['hostname'],
    reason: 'heartbeat_device_change',
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await shutdownDeviceGroupJobs();
  vi.clearAllMocks();
  mockQueueAdd.mockResolvedValue({ id: 'job-new' });
  mockQueueGetJob.mockResolvedValue(undefined);
  mockWithSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  dbExports.withSystemDbAccessContext = mockWithSystemDbAccessContext;
});

describe('mergeReevaluationRequests', () => {
  it('unions the changed fields', () => {
    expect(mergeReevaluationRequests(
      { eventType: 'device.updated', changedFields: ['hostname'] },
      { eventType: 'device.updated', changedFields: ['osVersion', 'hostname'] },
    )).toEqual({ eventType: 'device.updated', changedFields: ['hostname', 'osVersion'] });
  });

  it('lets device.created win — it evaluates every group, so it is the superset', () => {
    expect(mergeReevaluationRequests(
      { eventType: 'device.updated', changedFields: ['hostname'] },
      { eventType: 'device.created', changedFields: [] },
    ).eventType).toBe('device.created');

    expect(mergeReevaluationRequests(
      { eventType: 'device.created', changedFields: [] },
      { eventType: 'device.updated', changedFields: ['hostname'] },
    ).eventType).toBe('device.created');
  });
});

describe('scheduleDeviceGroupReevaluation', () => {
  it('adds a new job under the per-device coalescing jobId', async () => {
    const id = await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['hostname', 'hostname'],
      reason: 'heartbeat_device_change',
    });

    expect(id).toBe('job-new');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, payload, options] = mockQueueAdd.mock.calls[0]!;
    expect(name).toBe('group-reevaluation');
    expect(payload).toMatchObject({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });
    expect(options.jobId).toBe(`group-reeval-${DEVICE_ID}`);
    expect(deviceGroupReevaluationJobId(DEVICE_ID)).toBe(`group-reeval-${DEVICE_ID}`);
    // #5039 review finding 1: the caller enqueues from inside its own open
    // transaction, so the job must not be runnable until that has committed.
    expect(options.delay).toBe(DEVICE_GROUP_REEVALUATION_DELAY_MS);
    expect(DEVICE_GROUP_REEVALUATION_DELAY_MS).toBeGreaterThan(0);
  });

  it('delays the follow-up job too — it is enqueued from a request path as well', async () => {
    mockQueueGetJob.mockResolvedValue({
      id: 'job-active',
      data: jobData(),
      getState: vi.fn().mockResolvedValue('active'),
      updateData: vi.fn(),
    });
    mockQueueAdd.mockResolvedValue({ id: 'job-follow-up' });

    await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['hostname'],
      reason: 'heartbeat_device_change',
    });

    expect(mockQueueAdd.mock.calls[0]![2].delay).toBe(DEVICE_GROUP_REEVALUATION_DELAY_MS);
  });

  it('still coalesces while the job sits DELAYED — delayed is a reusable state', async () => {
    // The delay window is also the coalescing window, so `delayed` has to stay
    // in isReusableState or every change inside it would add a duplicate job.
    expect(isReusableState('delayed')).toBe(true);

    const updateData = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJob.mockResolvedValue({
      id: 'job-delayed',
      data: jobData({ changedFields: ['hostname'] }),
      getState: vi.fn().mockResolvedValue('delayed'),
      updateData,
    });

    const id = await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['osBuild'],
      reason: 'heartbeat_device_change',
    });

    expect(id).toBe('job-delayed');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({
      changedFields: ['hostname', 'osBuild'],
    }));
  });

  it('coalesces into a waiting job instead of enqueuing a second one', async () => {
    const updateData = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJob.mockResolvedValue({
      id: 'job-existing',
      data: jobData({ changedFields: ['hostname'] }),
      getState: vi.fn().mockResolvedValue('waiting'),
      updateData,
    });

    const id = await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.created',
      changedFields: ['osVersion'],
      reason: 'device_provisioned',
    });

    expect(id).toBe('job-existing');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'device.created',
      changedFields: ['hostname', 'osVersion'],
      reason: 'device_provisioned',
    }));
  });

  it('queues a distinct follow-up when the coalescing job is already running', async () => {
    // An active job's snapshot of the device predates this change, so merging
    // into it would silently drop the change.
    mockQueueGetJob.mockResolvedValue({
      id: 'job-active',
      data: jobData(),
      getState: vi.fn().mockResolvedValue('active'),
      updateData: vi.fn(),
    });
    mockQueueAdd.mockResolvedValue({ id: 'job-follow-up' });

    const id = await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['osBuild'],
      reason: 'heartbeat_device_change',
    });

    expect(id).toBe('job-follow-up');
    const options = mockQueueAdd.mock.calls[0]![2];
    expect(options.jobId).toMatch(new RegExp(`^group-reeval-${DEVICE_ID}-follow-up-`));
  });

  it('removes and replaces a spent (failed) record under the same jobId', async () => {
    // BullMQ's jobId dedup keys on "a record exists", so a retained failure
    // would swallow every later add forever (services/bullmqUtils.ts).
    const remove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJob.mockResolvedValue({
      id: 'job-failed',
      data: jobData(),
      getState: vi.fn().mockResolvedValue('failed'),
      remove,
    });

    await scheduleDeviceGroupReevaluation({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['hostname'],
      reason: 'heartbeat_device_change',
    });

    expect(remove).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0]![2].jobId).toBe(`group-reeval-${DEVICE_ID}`);
  });
});

describe('requestDeviceGroupReevaluation', () => {
  it('never rejects — a Redis outage must not surface on the heartbeat path', async () => {
    mockQueueGetJob.mockRejectedValue(new Error('redis down'));
    const original = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      await expect(requestDeviceGroupReevaluation({
        deviceId: DEVICE_ID,
        orgId: ORG_ID,
        eventType: 'device.updated',
        changedFields: ['hostname'],
        reason: 'heartbeat_device_change',
      })).resolves.toBeNull();
    } finally {
      console.error = original;
    }
    expect(String(errors[0])).toContain(DEVICE_ID);
  });
});

describe('processDeviceGroupReevaluation', () => {
  it('emits the change with the device\'s OWN org id, never the payload\'s', async () => {
    mockSelect.mockReturnValue(selectResolving([{ orgId: ORG_ID }]));

    const result = await processDeviceGroupReevaluation(jobData({ orgId: OTHER_ORG_ID }));

    expect(result).toEqual({ evaluated: true, orgId: ORG_ID });
    expect(mockInitializeDeviceEventHandlers).toHaveBeenCalled();
    expect(mockEmitDeviceChange).toHaveBeenCalledWith(expect.objectContaining({
      type: 'device.updated',
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      changedFields: ['hostname'],
    }));
  });

  it('no-ops when the device is gone (deleted between enqueue and run)', async () => {
    mockSelect.mockReturnValue(selectResolving([]));

    const result = await processDeviceGroupReevaluation(jobData());

    expect(result).toEqual({ evaluated: false, orgId: null });
    expect(mockEmitDeviceChange).not.toHaveBeenCalled();
  });

  // #5039 round-3 review: on device.created the row MUST exist — its absence
  // means the enrolling transaction is still open (a slow mTLS issuance can hold
  // it past the 5s delay) or rolled back. Completing silently would drop the
  // device's first-ever evaluation with no retry; throw so `attempts` retries
  // and a true rollback ends in removeOnFail retention, visible.
  it('THROWS when a device.created job finds no row — retry, never a silent no-op', async () => {
    mockSelect.mockReturnValue(selectResolving([]));

    await expect(
      processDeviceGroupReevaluation(jobData({ eventType: 'device.created', changedFields: [] })),
    ).rejects.toThrow(/device\.created/);
    expect(mockEmitDeviceChange).not.toHaveBeenCalled();
  });

  // #5039 review finding 2. emitDeviceChange used to swallow handler
  // rejections, so `attempts: 5` never fired: a 40P01 deadlock inside the
  // membership evaluation completed the job and left membership stale.
  it('propagates an emitDeviceChange failure so BullMQ retries the job', async () => {
    mockSelect.mockReturnValue(selectResolving([{ orgId: ORG_ID }]));
    const deadlock = new AggregateError([new Error('deadlock detected')], 'handlers failed');
    mockEmitDeviceChange.mockRejectedValueOnce(deadlock);

    await expect(processDeviceGroupReevaluation(jobData())).rejects.toBe(deadlock);
  });
});

describe('runDeviceGroupReevaluationJob — the exact function the worker runs', () => {
  it('runs the evaluation inside a system DB access context', async () => {
    mockSelect.mockReturnValue(selectResolving([{ orgId: ORG_ID }]));

    const result = await runDeviceGroupReevaluationJob(jobData());

    expect(result).toEqual({ evaluated: true, orgId: ORG_ID });
    expect(mockWithSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  // #5039 review finding 3. Falling back to a bare fn() is not a degraded
  // mode: under forced RLS the evaluation reads zero groups and the job
  // reports success having changed nothing.
  it('THROWS rather than evaluating without a DB access context', async () => {
    dbExports.withSystemDbAccessContext = undefined;
    mockSelect.mockReturnValue(selectResolving([{ orgId: ORG_ID }]));

    await expect(runDeviceGroupReevaluationJob(jobData()))
      .rejects.toThrow(/withSystemDbAccessContext is unavailable/);
    // And it refused BEFORE touching the database.
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockEmitDeviceChange).not.toHaveBeenCalled();
  });
});
