import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
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
  sensitiveDataPolicies: {},
  sensitiveDataScans: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: {
    SENSITIVE_DATA_SCAN: 'sensitive_data_scan',
  },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/automationRuntime', () => ({
  isCronDue: vi.fn(),
}));

import { isCronDue } from '../services/automationRuntime';
import { shouldSchedulePolicy } from './sensitiveDataJobs';

describe('shouldSchedulePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for disabled or manual schedules', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    expect(shouldSchedulePolicy({ enabled: false, type: 'interval', intervalMinutes: 15 }, now)).toBe(false);
    expect(shouldSchedulePolicy({ enabled: true, type: 'manual' }, now)).toBe(false);
  });

  it('handles interval schedules with and without lastRunAt', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    expect(shouldSchedulePolicy({ enabled: true, type: 'interval', intervalMinutes: 15 }, now)).toBe(true);
    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'interval',
      intervalMinutes: 15,
      lastRunAt: '2026-02-26T11:40:00.000Z'
    }, now)).toBe(true);
    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'interval',
      intervalMinutes: 15,
      lastRunAt: '2026-02-26T11:50:30.000Z'
    }, now)).toBe(false);
  });

  it('evaluates cron schedules and avoids same-minute duplicates', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    vi.mocked(isCronDue).mockReturnValue(true);

    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'cron',
      cron: '*/5 * * * *',
      timezone: 'UTC'
    }, now)).toBe(true);
    expect(isCronDue).toHaveBeenCalledTimes(1);

    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'cron',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      lastRunAt: '2026-02-26T12:00:25.000Z'
    }, now)).toBe(false);
    expect(isCronDue).toHaveBeenCalledTimes(1);
  });
});
