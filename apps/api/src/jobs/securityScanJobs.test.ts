import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, addBulkMock, closeMock, getRepeatableJobsMock, removeRepeatableByKeyMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(() => Promise.resolve([])),
  removeRepeatableByKeyMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    close = closeMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {},
  devices: {},
  securityScans: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: {
    SECURITY_SCAN: 'security_scan',
  },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/cronDue', () => ({
  isCronDue: vi.fn(),
}));

vi.mock('../services/featureConfigResolver', () => ({
  resolveSecurityScanSettingsForDevice: vi.fn(),
  resolveAllSecurityScanScheduledDevices: vi.fn(),
  resolvePartnerTimezoneForOrg: vi.fn(),
}));

import { db } from '../db';
import { queueCommandForExecution } from '../services/commandQueue';
import { isCronDue } from '../services/cronDue';
import { resolveSecurityScanSettingsForDevice } from '../services/featureConfigResolver';
import {
  processDispatchScan,
  shouldScheduleSecurityScan,
  schedulePolicyScans,
} from './securityScanJobs';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';

function chain(rows: unknown): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'limit', 'for', 'returning', 'orderBy']) {
    result[method] = () => result;
  }
  return result;
}

describe('processDispatchScan', () => {
  const setMock = vi.fn();

  const queuedScan = {
    id: '22222222-2222-4222-8222-222222222222',
    orgId: 'org-1',
    deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    scanType: 'full',
    status: 'queued',
    deviceOrgId: 'org-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    setMock.mockReset().mockImplementation(() => chain([{ id: queuedScan.id }]));
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'pending' } } as any);
    vi.mocked(resolveSecurityScanSettingsForDevice).mockResolvedValue({
      ...SECURITY_SCAN_SETTINGS_DEFAULTS,
      exclusions: ['C:\\Backups'],
      maxFileSizeMb: 64,
      scanTimeoutMinutes: 30,
      autoQuarantine: false,
      scanType: 'full',
    });
  });

  it('does nothing when the scan row has vanished', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([]));

    await expect(processDispatchScan({
      type: 'dispatch-scan', scanId: '11111111-1111-4111-8111-111111111111', origin: 'manual',
    })).resolves.toEqual({ dispatched: false, commandId: null });
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('queues a security_scan command carrying the resolved settings', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([queuedScan])) // scan lookup
      .mockReturnValueOnce(chain([{ count: 0 }])) // org running
      .mockReturnValueOnce(chain([{ count: 0 }])) // device running
      .mockReturnValueOnce(chain([{ count: 0 }])); // device pending commands

    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: queuedScan.id, origin: 'manual',
    });

    expect(result.dispatched).toBe(true);
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      queuedScan.deviceId,
      'security_scan',
      expect.objectContaining({
        scanRecordId: queuedScan.id,
        scanType: 'full',
        exclusions: ['C:\\Backups'],
        maxFileSizeMb: 64,
        timeoutMinutes: 30,
        autoQuarantine: false,
      }),
      expect.anything(),
    );
  });

  it('refuses to dispatch a scan whose row is no longer queued (concurrent claim)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([queuedScan]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ count: 0 }]));
    // The claiming UPDATE ... WHERE status = 'queued' returns zero rows —
    // another worker claimed it first.
    setMock.mockImplementation(() => chain([]));

    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: queuedScan.id, origin: 'manual',
    });
    expect(result).toEqual({ dispatched: false, commandId: null });
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('requeues instead of dispatching when the org is at its running-scan cap', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([queuedScan]))
      .mockReturnValueOnce(chain([{ count: 40 }])); // org cap hit
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'retry-job' });

    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: queuedScan.id, origin: 'manual',
    });
    expect(result.dispatched).toBe(false);
    expect(addMock).toHaveBeenCalled();
    expect(queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('marks a scheduled scan failed when the device has moved org since it was created', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      chain([{ ...queuedScan, deviceOrgId: 'org-2' }]),
    );

    const result = await processDispatchScan({
      type: 'dispatch-scan',
      scanId: queuedScan.id,
      origin: 'policy_scheduler',
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      occurrenceIso: '2026-09-18T02:00:00.000Z',
    });
    expect(result.dispatched).toBe(false);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});

describe('shouldScheduleSecurityScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is false when scheduling is off', () => {
    expect(shouldScheduleSecurityScan(
      { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scheduledScans: false },
      'UTC',
      new Date('2026-09-18T02:00:00Z'),
    )).toBe(false);
    expect(isCronDue).not.toHaveBeenCalled();
  });

  it('delegates to isCronDue with the five-field cron and timezone', () => {
    vi.mocked(isCronDue).mockReturnValue(true);
    const settings = { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scanMinute: '0', scanHour: '2' };
    expect(shouldScheduleSecurityScan(settings, 'America/New_York', new Date('2026-09-18T06:00:00Z'))).toBe(true);
    expect(isCronDue).toHaveBeenCalledWith('0 2 * * *', 'America/New_York', new Date('2026-09-18T06:00:00Z'));
  });
});

describe('schedulePolicyScans', () => {
  const entry = {
    configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orgId: null,
    partnerId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
    settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS },
    deviceIds: ['d1', 'd2'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    addBulkMock.mockResolvedValue(undefined);
  });

  it('creates one scan row per device, each taking the DEVICE org, not the policy org', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([{ id: 'scan-d1' }, { id: 'scan-d2' }]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-of-d1' }, { id: 'd2', orgId: 'org-of-d2' }])) // device rows
      .mockReturnValueOnce(chain([{ count: 0 }])) // getOrgQueuedScans org-of-d1
      .mockReturnValueOnce(chain([{ count: 0 }])) // getOrgQueuedScans org-of-d2
      .mockReturnValueOnce(chain([])); // busy query

    const created = await schedulePolicyScans(entry as any, new Date('2026-09-18T02:00:00Z'));

    expect(created).toBe(2);
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: 'd1', orgId: 'org-of-d1', initiatedBy: null }),
      expect.objectContaining({ deviceId: 'd2', orgId: 'org-of-d2', initiatedBy: null }),
    ]);
    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'dispatch-scan',
        data: expect.objectContaining({ origin: 'policy_scheduler', occurrenceIso: '2026-09-18T02:00:00.000Z' }),
      }),
      expect.objectContaining({
        name: 'dispatch-scan',
        data: expect.objectContaining({ origin: 'policy_scheduler', occurrenceIso: '2026-09-18T02:00:00.000Z' }),
      }),
    ]);
  });

  it('skips a device that already has a queued or running scan', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-of-d1' }]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ deviceId: 'd1' }])); // busy: d1 already running

    const created = await schedulePolicyScans(
      { ...entry, deviceIds: ['d1'] } as any,
      new Date('2026-09-18T02:00:00Z'),
    );
    expect(created).toBe(0);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('skips backpressured orgs but still schedules the rest', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([{ id: 'scan-d2' }]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-a' }, { id: 'd2', orgId: 'org-b' }]))
      .mockReturnValueOnce(chain([{ count: 500 }])) // org-a backpressured
      .mockReturnValueOnce(chain([{ count: 0 }])) // org-b admitted
      .mockReturnValueOnce(chain([])); // busy query

    const created = await schedulePolicyScans(entry as any, new Date('2026-09-18T02:00:00Z'));
    expect(created).toBe(1);
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: 'd2', orgId: 'org-b' }),
    ]);
  });

  it('returns 0 without touching the DB when the entry has no devices', async () => {
    const created = await schedulePolicyScans({ ...entry, deviceIds: [] } as any, new Date());
    expect(created).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});
