import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
// backupWorker uses `import * as dbModule from '../db'` then `const { db } = dbModule`,
// so the mock must expose every export the module touches at load time.
const { selectDistinctMock, selectMock } = vi.hoisted(() => ({
  selectDistinctMock: vi.fn(),
  selectMock: vi.fn(),
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
  },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
});
