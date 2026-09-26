import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
// backupWorker uses `import * as dbModule from '../db'` then `const { db } = dbModule`,
// so the mock must expose every export the module touches at load time.
const { selectDistinctMock, selectMock, updateSetMock, systemContexts } = vi.hoisted(() => ({
  selectDistinctMock: vi.fn(),
  selectMock: vi.fn(),
  updateSetMock: vi.fn(),
  // #6597: models withSystemDbAccessContext as a transaction that COMMITS when
  // its callback resolves (a nested call joins the outer one, like the real
  // helper). `stack` is the open top-level contexts, `committed` the finished.
  systemContexts: { seq: 0, stack: [] as number[], committed: new Set<number>() },
}));

function makeChain(result: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

vi.mock('../db', () => ({
  db: {
    selectDistinct: (...args: unknown[]) => selectDistinctMock(...(args as [])),
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: () => ({
      set: (values: unknown) => {
        updateSetMock(values);
        return { where: () => Promise.resolve([]) };
      },
    }),
  },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    if (systemContexts.stack.length > 0) return fn();
    const id = ++systemContexts.seq;
    systemContexts.stack.push(id);
    try {
      return await fn();
    } finally {
      systemContexts.stack.pop();
      systemContexts.committed.add(id);
    }
  }),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

const resolveAllBackupAssignedDevicesMock = vi.fn();
vi.mock('../services/featureConfigResolver', () => ({
  resolveAllBackupAssignedDevices: (...args: unknown[]) =>
    resolveAllBackupAssignedDevicesMock(...(args as [])),
}));

const createScheduledBackupJobIfAbsentMock = vi.fn();
vi.mock('../services/backupJobCreation', () => ({
  createScheduledBackupJobIfAbsent: (...args: unknown[]) =>
    createScheduledBackupJobIfAbsentMock(...(args as [])),
  deviceHelperQueues: vi.fn().mockResolvedValue(true),
}));

const enqueueBackupDispatchMock = vi.fn();
vi.mock('./backupEnqueue', () => ({
  getBackupQueue: vi.fn(),
  closeBackupQueue: vi.fn(),
  enqueueBackupDispatch: (...args: unknown[]) => enqueueBackupDispatchMock(...(args as [])),
  enqueueBackupResults: vi.fn(),
  removeQueuedBackupDispatch: vi.fn(),
}));

const { __testOnly } = await import('./backupWorker');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const LINK_ID = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '55555555-5555-4555-8555-555555555555';

const SCHEDULE = { frequency: 'daily' as const, time: '01:00' };

function primeOrgLookup() {
  // 1. distinct orgs with active backup policies
  selectDistinctMock.mockReturnValueOnce(makeChain([{ orgId: ORG_ID }]));
  // 2. distinct partner-wide (org_id NULL) backup policies — none
  selectDistinctMock.mockReturnValueOnce(makeChain([]));
}

describe('processCheckSchedules — backup profile fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T01:00:30Z'));
    createScheduledBackupJobIfAbsentMock.mockResolvedValue({
      created: true,
      job: { id: 'job-1', configId: CONFIG_ID },
    });
    enqueueBackupDispatchMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates NO job and logs an error when a link has a profile that expands to no selections', async () => {
    primeOrgLookup();
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: DEVICE_ID,
        featureLinkId: LINK_ID,
        configId: CONFIG_ID,
        settings: {
          schedule: SCHEDULE,
          backupProfileId: PROFILE_ID,
          backupMode: 'file',
        },
        // Profile row unreachable / selections empty or malformed.
        selectionSpecs: null,
        resolvedTimezone: 'UTC',
      },
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await __testOnly.processCheckSchedules();

    expect(createScheduledBackupJobIfAbsentMock).not.toHaveBeenCalled();
    expect(enqueueBackupDispatchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: 0 });

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(DEVICE_ID);
    expect(logged).toContain(ORG_ID);
    expect(logged).toContain(LINK_ID);
    expect(logged).toContain(PROFILE_ID);
    errorSpy.mockRestore();
  });

  it('still creates exactly one job for a legacy (no profile) link', async () => {
    primeOrgLookup();
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: DEVICE_ID,
        featureLinkId: LINK_ID,
        configId: CONFIG_ID,
        settings: {
          schedule: SCHEDULE,
          backupProfileId: null,
          backupMode: 'file',
        },
        selectionSpecs: null,
        resolvedTimezone: 'UTC',
      },
    ]);

    const result = await __testOnly.processCheckSchedules();

    expect(createScheduledBackupJobIfAbsentMock).toHaveBeenCalledTimes(1);
    const arg = createScheduledBackupJobIfAbsentMock.mock.calls[0]![0];
    expect(arg).toMatchObject({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      configId: CONFIG_ID,
      featureLinkId: LINK_ID,
    });
    // Legacy path passes no backupMode/modeTargets (dispatch falls back to settings).
    expect(arg).not.toHaveProperty('backupMode');
    expect(result).toEqual({ enqueued: 1 });
  });

  it('creates one job per enabled selection when the profile expands', async () => {
    primeOrgLookup();
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: DEVICE_ID,
        featureLinkId: LINK_ID,
        configId: CONFIG_ID,
        settings: {
          schedule: SCHEDULE,
          backupProfileId: PROFILE_ID,
          backupMode: 'file',
        },
        selectionSpecs: [
          { backupMode: 'file', targets: { paths: ['C:\\data'], excludes: [] } },
          { backupMode: 'system_image', targets: { includeSystemState: true } },
        ],
        resolvedTimezone: 'UTC',
      },
    ]);

    const result = await __testOnly.processCheckSchedules();

    expect(createScheduledBackupJobIfAbsentMock).toHaveBeenCalledTimes(2);
    expect(createScheduledBackupJobIfAbsentMock.mock.calls.map((call) => call[0].backupMode)).toEqual([
      'file',
      'system_image',
    ]);
    expect(result).toEqual({ enqueued: 2 });
  });

  // #6597 — the dispatch worker reads the job row on its own connection. A row
  // created inside a still-open transaction is invisible to it: the worker then
  // resolved the job as a pathless file backup, "failed" a row it could not
  // see, and the committed row sat `pending` until the stale reaper failed it
  // with "Backup dispatch never completed". The whole sweep used to run in ONE
  // system transaction, so every scheduled job was enqueued before it existed.
  it('commits each scheduled job row before enqueueing its dispatch (#6597)', async () => {
    systemContexts.seq = 0;
    systemContexts.stack.length = 0;
    systemContexts.committed.clear();
    const createdIn = new Map<string, number | undefined>();
    const committedAtEnqueue = new Map<string, boolean>();
    let n = 0;
    createScheduledBackupJobIfAbsentMock.mockImplementation(async () => {
      const id = `job-${++n}`;
      createdIn.set(id, systemContexts.stack.at(-1));
      return { created: true, job: { id, configId: CONFIG_ID } };
    });
    enqueueBackupDispatchMock.mockImplementation(async (jobId: string) => {
      const ctx = createdIn.get(jobId);
      committedAtEnqueue.set(jobId, ctx !== undefined && systemContexts.committed.has(ctx));
    });
    primeOrgLookup();
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: DEVICE_ID,
        featureLinkId: LINK_ID,
        configId: CONFIG_ID,
        settings: { schedule: SCHEDULE, backupProfileId: PROFILE_ID, backupMode: 'file' },
        selectionSpecs: [
          { backupMode: 'file', targets: { paths: ['C:\\data'], excludes: [] } },
          { backupMode: 'system_image', targets: { includeSystemState: true } },
        ],
        resolvedTimezone: 'UTC',
      },
    ]);

    // Called with NO ambient context, exactly as the worker now calls it: the
    // sweep owns its contexts instead of running inside one blanket one.
    const result = await __testOnly.processCheckSchedules();

    expect(result).toEqual({ enqueued: 2 });
    expect(createdIn.size).toBe(2);
    for (const [jobId, ctx] of createdIn) {
      expect(ctx, `${jobId} was created outside any DB context`).toBeDefined();
      expect(committedAtEnqueue.get(jobId), `${jobId} was enqueued before its row committed`).toBe(true);
    }
  });

  it('fails a committed scheduled job whose dispatch cannot be enqueued (#6597)', async () => {
    enqueueBackupDispatchMock.mockRejectedValueOnce(new Error('Redis unavailable'));
    primeOrgLookup();
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: DEVICE_ID,
        featureLinkId: LINK_ID,
        configId: CONFIG_ID,
        settings: { schedule: SCHEDULE, backupProfileId: null, backupMode: 'file' },
        selectionSpecs: null,
        resolvedTimezone: 'UTC',
      },
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await __testOnly.processCheckSchedules();

    expect(result).toEqual({ enqueued: 0 });
    // The row committed before the enqueue was attempted, so it must be
    // settled here — otherwise it waits an hour for the stale reaper.
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorLog: expect.stringContaining('Redis unavailable') }),
    );
    errorSpy.mockRestore();
  });
});

// #5080 W02: the schedule scan enumerates through the EFFECTIVE view, so an org
// whose only backup configuration is inherited from a partner-wide baseline is
// still discovered. Asserted by object identity against the real schema exports
// (this suite does not stub '../db/schema'), so a lookalike cannot satisfy it.
describe('processCheckSchedules — reads effective feature links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins config_policy_effective_feature_links, not the authored table', async () => {
    const joined: unknown[] = [];
    const recordingChain = (result: unknown) => {
      const chain: Record<string, any> = {};
      for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.innerJoin = vi.fn((table: unknown) => {
        joined.push(table);
        return chain;
      });
      chain.then = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled);
      return chain;
    };
    // Both distinct scans (org-owned, then partner-wide) run before anything else.
    selectDistinctMock.mockImplementation(() => recordingChain([]));
    selectMock.mockImplementation(() => recordingChain([]));

    await __testOnly.processCheckSchedules();

    const { configPolicyEffectiveFeatureLinks, configPolicyFeatureLinks } = await import('../db/schema');
    expect(joined).toContain(configPolicyEffectiveFeatureLinks);
    expect(joined).not.toContain(configPolicyFeatureLinks);
  });
});
