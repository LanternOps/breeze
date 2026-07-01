import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  reports: {
    id: 'reports.id',
    orgId: 'reports.org_id',
    schedule: 'reports.schedule',
    lastGeneratedAt: 'reports.last_generated_at',
    config: 'reports.config',
    updatedAt: 'reports.updated_at',
  },
  reportRuns: {
    id: 'report_runs.id',
    reportId: 'report_runs.report_id',
    status: 'report_runs.status',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partner_id',
    settings: 'organizations.settings',
  },
  partners: {
    id: 'partners.id',
    timezone: 'partners.timezone',
    settings: 'partners.settings',
  },
}));

const generateReportMock = vi.fn();
vi.mock('../services/reportGenerationService', () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...(args as [])),
}));

const sendEmailMock = vi.fn();
vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock })),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false),
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import {
  lastOccurrenceKey,
  isDue,
  wallClockIn,
  findDueReports,
  processRunScheduledReport,
} from './reportScheduleWorker';

const REPORT_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const RUN_ID = '33333333-3333-3333-3333-333333333333';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  // findDueReports awaits the chain after .where() (no .limit()).
  chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

function insertChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(async () => rows);
  return chain;
}

function updateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(async () => []);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Occurrence math (pure) ──────────────────────────────────────────────────

describe('lastOccurrenceKey', () => {
  // 2026-07-01T15:00:00Z = 10:00 in America/Chicago (CDT, UTC-5), a Wednesday.
  const now = new Date('2026-07-01T15:00:00Z');

  it('daily: uses today when the scheduled time has passed', () => {
    const key = lastOccurrenceKey(now, 'daily', { time: '09:00' }, 'America/Chicago');
    expect(key).toBe(202607010900);
  });

  it('daily: falls back to yesterday when the scheduled time is still ahead', () => {
    const key = lastOccurrenceKey(now, 'daily', { time: '17:30' }, 'America/Chicago');
    expect(key).toBe(202606301730);
  });

  it('daily: respects the timezone (same instant, different wall clock)', () => {
    // 15:00 UTC — a 16:00 UTC schedule hasn't happened yet today in UTC.
    const key = lastOccurrenceKey(now, 'daily', { time: '16:00' }, 'UTC');
    expect(key).toBe(202606301600);
  });

  it('weekly: most recent scheduled weekday, honoring time-of-day on the same day', () => {
    // now is Wednesday 10:00 Chicago.
    expect(lastOccurrenceKey(now, 'weekly', { time: '09:00', day: 'wednesday' }, 'America/Chicago')).toBe(202607010900);
    // Wednesday 11:00 hasn't happened yet → previous Wednesday.
    expect(lastOccurrenceKey(now, 'weekly', { time: '11:00', day: 'wednesday' }, 'America/Chicago')).toBe(202606241100);
    expect(lastOccurrenceKey(now, 'weekly', { time: '09:00', day: 'monday' }, 'America/Chicago')).toBe(202606290900);
  });

  it('monthly: clamps the 31st to short months', () => {
    // Feb 2026 has 28 days; asking for the 31st on Mar 1 resolves to Feb 28.
    const marchFirst = new Date('2026-03-01T12:00:00Z');
    const key = lastOccurrenceKey(marchFirst, 'monthly', { time: '09:00', date: '31' }, 'UTC');
    expect(key).toBe(202602280900);
  });

  it('monthly: rolls to the previous year in January', () => {
    const janFirst = new Date('2026-01-01T00:30:00Z');
    const key = lastOccurrenceKey(janFirst, 'monthly', { time: '09:00', date: '15' }, 'UTC');
    expect(key).toBe(202512150900);
  });

  it('defaults invalid time strings to 09:00 and invalid zones to UTC', () => {
    expect(lastOccurrenceKey(now, 'daily', { time: 'bogus' }, 'UTC')).toBe(202607010900);
    expect(lastOccurrenceKey(now, 'daily', { time: '09:00' }, 'Not/AZone')).toBe(202607010900);
  });
});

describe('isDue', () => {
  const occurrence = 202607010900; // Jul 1 2026, 09:00 wall clock

  it('never-generated reports are due', () => {
    expect(isDue(null, occurrence, 'UTC')).toBe(true);
  });

  it('due when last generation predates the occurrence', () => {
    expect(isDue(new Date('2026-06-30T09:05:00Z'), occurrence, 'UTC')).toBe(true);
  });

  it('not due when last generation is at/after the occurrence', () => {
    expect(isDue(new Date('2026-07-01T09:00:00Z'), occurrence, 'UTC')).toBe(false);
    expect(isDue(new Date('2026-07-01T12:00:00Z'), occurrence, 'UTC')).toBe(false);
  });

  it('compares in the schedule timezone, not UTC', () => {
    // 2026-07-01T13:30:00Z is 08:30 in Chicago — before the 09:00 occurrence.
    expect(isDue(new Date('2026-07-01T13:30:00Z'), occurrence, 'America/Chicago')).toBe(true);
    // 14:30Z is 09:30 Chicago — after it.
    expect(isDue(new Date('2026-07-01T14:30:00Z'), occurrence, 'America/Chicago')).toBe(false);
  });
});

describe('wallClockIn', () => {
  it('falls back to UTC for unknown zones', () => {
    const wc = wallClockIn(new Date('2026-07-01T15:04:00Z'), 'Invalid/Zone');
    expect(wc).toMatchObject({ y: 2026, m: 7, d: 1, hh: 15, mm: 4 });
  });
});

// ─── Due discovery ───────────────────────────────────────────────────────────

describe('findDueReports', () => {
  it('flags never-run schedules and skips fresh ones, resolving org tz', async () => {
    const now = new Date('2026-07-01T15:00:00Z'); // 10:00 Chicago
    selectMock.mockReturnValueOnce(
      selectChain([
        {
          id: REPORT_ID,
          schedule: 'daily',
          lastGeneratedAt: null, // never ran → due
          config: { schedule: { time: '09:00' } },
          orgSettings: { timezone: 'America/Chicago' },
          partnerTimezone: 'UTC',
          partnerSettings: {},
        },
        {
          id: ORG_ID,
          schedule: 'daily',
          lastGeneratedAt: new Date('2026-07-01T14:30:00Z'), // 09:30 Chicago → already ran
          config: { schedule: { time: '09:00' } },
          orgSettings: { timezone: 'America/Chicago' },
          partnerTimezone: 'UTC',
          partnerSettings: {},
        },
      ]),
    );

    const due = await findDueReports(now);
    expect(due).toEqual([{ id: REPORT_ID, occurrenceKey: 202607010900 }]);
  });

  it('falls back to the partner timezone when the org has none', async () => {
    // 03:00 UTC = 22:00 previous day in Chicago: a daily 09:00 Chicago report
    // last run yesterday 09:05 Chicago is NOT due yet.
    const now = new Date('2026-07-01T03:00:00Z');
    selectMock.mockReturnValueOnce(
      selectChain([
        {
          id: REPORT_ID,
          schedule: 'daily',
          lastGeneratedAt: new Date('2026-06-30T14:05:00Z'), // 09:05 Chicago Jun 30
          config: { schedule: { time: '09:00' } },
          orgSettings: {},
          partnerTimezone: 'America/Chicago',
          partnerSettings: {},
        },
      ]),
    );

    expect(await findDueReports(now)).toEqual([]);
  });
});

// ─── Execution ───────────────────────────────────────────────────────────────

describe('processRunScheduledReport', () => {
  const report = {
    id: REPORT_ID,
    orgId: ORG_ID,
    name: 'Nightly inventory',
    type: 'device_inventory',
    format: 'csv',
    schedule: 'daily',
    config: { schedule: { time: '09:00' }, emailRecipients: ['ops@example.com', 'not-an-email'] },
    lastGeneratedAt: null,
  };

  it('stores a completed run, stamps lastGeneratedAt, and emails valid recipients with a CSV', async () => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    const runInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(runInsert);
    const updates = [updateChain(), updateChain()];
    updateMock.mockReturnValueOnce(updates[0]).mockReturnValueOnce(updates[1]);
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'pc-1' }], rowCount: 1 });

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    expect(generateReportMock).toHaveBeenCalledWith('device_inventory', ORG_ID, report.config, undefined);
    // First update stamps reports.lastGeneratedAt, second completes the run.
    expect(updates[0]!.set).toHaveBeenCalledWith(expect.objectContaining({ lastGeneratedAt: expect.any(Date) }));
    expect(updates[1]!.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', rowCount: 1, result: { rows: [{ hostname: 'pc-1' }], rowCount: 1 } }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0]![0] as {
      to: string[];
      subject: string;
      attachments: Array<{ filename: string }>;
    };
    expect(mail.to).toEqual(['ops@example.com']); // invalid recipient filtered out
    expect(mail.subject).toContain('Nightly inventory');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toMatch(/device_inventory-report-.*\.csv/);
  });

  it('marks the run failed (and still stamps lastGeneratedAt) when generation throws', async () => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    const updates = [updateChain(), updateChain()];
    updateMock.mockReturnValueOnce(updates[0]).mockReturnValueOnce(updates[1]);
    generateReportMock.mockRejectedValueOnce(new Error('boom'));

    await expect(
      processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 }),
    ).rejects.toThrow('boom');

    expect(updates[1]!.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'boom' }),
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('no-ops when the report was deleted or switched to one_time', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    expect(insertMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('does not attach a CSV for pdf-format reports (link-only email)', async () => {
    selectMock.mockReturnValueOnce(selectChain([{ ...report, format: 'pdf' }]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'pc-1' }], rowCount: 1 });

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    const mail = sendEmailMock.mock.calls[0]![0] as { attachments: unknown[] };
    expect(mail.attachments).toHaveLength(0);
  });
});
