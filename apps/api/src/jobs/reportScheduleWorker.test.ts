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

type PreviousBaseline = { generatedAt: string | null; summary?: Record<string, unknown> } | undefined;

const generateReportMock = vi.fn();
const previousBaselineForMock = vi.fn<() => Promise<PreviousBaseline>>(async () => undefined);
vi.mock('../services/reportGenerationService', () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...(args as [])),
  previousBaselineFor: (...args: unknown[]) => previousBaselineForMock(...(args as [])),
}));

const sendEmailMock = vi.fn();
vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock })),
}));

const loadReportBrandingForOrgMock = vi.fn(async () => ({
  name: 'Olive MSP',
  logoDataUrl: null,
  logoAspect: null,
}));
vi.mock('../services/reportBranding', () => ({
  loadReportBrandingForOrg: (...args: unknown[]) => loadReportBrandingForOrgMock(...(args as [])),
}));

// Passthrough mock of the shared PDF renderer with a failure switch: by default
// it delegates to the REAL buildReportPdf (so the %PDF magic-byte test stays a
// genuine end-to-end Node render proof); flipping `shouldThrow` simulates a
// render bug to verify delivery degrades to a link-only email instead of failing.
const pdfRender = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock('@breeze/shared/reportPdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breeze/shared/reportPdf')>();
  return {
    ...actual,
    buildReportPdf: (...args: Parameters<typeof actual.buildReportPdf>) => {
      if (pdfRender.shouldThrow) throw new Error('render exploded');
      return actual.buildReportPdf(...args);
    },
  };
});

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false),
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

const captureExceptionMock = vi.fn();
vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

import {
  lastOccurrenceKey,
  isDue,
  wallClockIn,
  findDueReports,
  processCheckSchedules,
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
  pdfRender.shouldThrow = false;
  previousBaselineForMock.mockResolvedValue(undefined);
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
    selectMock.mockReturnValueOnce(selectChain([])); // org/partner timezone lookup
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
    // No org/partner timezone select here: generateReport throws before the
    // recipients branch (where the tz lookup now lives) is ever reached.
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

  it('includes a trend line in the email when a previous baseline exists', async () => {
    const postureReport = {
      ...report,
      type: 'security_compliance_posture',
      config: { emailRecipients: ['ops@example.com'] },
    };
    selectMock.mockReturnValueOnce(selectChain([postureReport]));
    selectMock.mockReturnValueOnce(selectChain([])); // org/partner timezone lookup
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    const updates = [updateChain(), updateChain()];
    updateMock.mockReturnValueOnce(updates[0]).mockReturnValueOnce(updates[1]);
    generateReportMock.mockResolvedValueOnce({
      rows: [{ hostname: 'PC-1' }],
      rowCount: 1,
      summary: { postureScore: 79 },
    });
    previousBaselineForMock.mockResolvedValueOnce({
      generatedAt: '2026-06-01T09:00:00Z',
      summary: { postureScore: 74 },
    });

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    expect(previousBaselineForMock).toHaveBeenCalledWith(REPORT_ID);
    // The stored snapshot carries the baseline forward so the download path
    // (and any future re-render) reflects the same trend as this email.
    expect(updates[1]!.set).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          previous: { generatedAt: '2026-06-01T09:00:00Z', summary: { postureScore: 74 } },
        }),
      }),
    );
    const mail = sendEmailMock.mock.calls[0]![0] as { html: string; text: string };
    expect(mail.html).toContain('up from 74');
    expect(mail.text).toContain('up from 74');
  });

  it('attaches a real branded PDF for pdf-format reports (end-to-end Node render, not mocked)', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([{ ...report, format: 'pdf', config: { emailRecipients: ['a@b.co'] } }]),
    );
    selectMock.mockReturnValueOnce(
      selectChain([{ orgSettings: {}, partnerTimezone: 'UTC', partnerSettings: {} }]), // org/partner timezone lookup
    );
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'PC-1' }], rowCount: 1 });

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    expect(loadReportBrandingForOrgMock).toHaveBeenCalledWith(ORG_ID);
    const mail = sendEmailMock.mock.calls[0]![0] as {
      attachments: Array<{ filename: string; content: Buffer; contentType?: string }>;
    };
    expect(mail.attachments).toHaveLength(1);
    const attachment = mail.attachments[0]!;
    expect(attachment.filename).toMatch(/device_inventory-report-.*\.pdf$/);
    expect(attachment.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(attachment.content)).toBe(true);
    expect(attachment.content.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('falls back to a link-only email (run still completed) when the PDF render throws', async () => {
    pdfRender.shouldThrow = true;
    selectMock.mockReturnValueOnce(
      selectChain([{ ...report, format: 'pdf', config: { emailRecipients: ['a@b.co'] } }]),
    );
    selectMock.mockReturnValueOnce(
      selectChain([{ orgSettings: {}, partnerTimezone: 'UTC', partnerSettings: {} }]), // org/partner timezone lookup
    );
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    const updates = [updateChain(), updateChain()];
    updateMock.mockReturnValueOnce(updates[0]).mockReturnValueOnce(updates[1]);
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'PC-1' }], rowCount: 1 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });
      // Prove the render actually failed (vs. silently succeeding): the catch
      // block logs the fallback before sending the link-only email.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('PDF render failed; sending link-only email'),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }

    // A render failure must not block delivery: the email still goes out,
    // link-only, and the run row is still marked completed.
    expect(updates[1]!.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0]![0] as { attachments: unknown[]; html: string; text: string };
    expect(mail.attachments).toHaveLength(0);
    expect(mail.html).toContain('Open Breeze to view and download the formatted report.');
    expect(mail.text).toContain('Open Breeze to view and download the formatted report.');
  });

  it('does not query branding when there are no valid recipients', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([{ ...report, format: 'pdf', config: { emailRecipients: ['not-an-email'] } }]),
    );
    // No org/partner timezone select here either: with zero valid recipients
    // the recipients branch (where both the tz lookup and branding load now
    // live) never runs.
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'pc-1' }], rowCount: 1 });

    await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });

    expect(loadReportBrandingForOrgMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('still emails (unbranded) when the branding load throws', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([{ ...report, format: 'csv', config: { emailRecipients: ['a@b.co'] } }]),
    );
    selectMock.mockReturnValueOnce(
      selectChain([{ orgSettings: {}, partnerTimezone: 'UTC', partnerSettings: {} }]), // org/partner timezone lookup
    );
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'PC-1' }], rowCount: 1 });
    loadReportBrandingForOrgMock.mockRejectedValueOnce(new Error('branding query failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Branding load failed; sending unbranded'),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }

    // A branding lookup failure must not drop the whole email — it still
    // goes out (unbranded), same as a PDF render failure degrading to link-only.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0]![0] as { attachments: Array<{ filename: string }> };
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toMatch(/device_inventory-report-.*\.csv/);
  });

  it('warns when an attachment exceeds 5MB and sends link-only', async () => {
    const bigHostname = 'x'.repeat(6 * 1024 * 1024);
    selectMock.mockReturnValueOnce(
      selectChain([{ ...report, format: 'csv', config: { emailRecipients: ['a@b.co'] } }]),
    );
    selectMock.mockReturnValueOnce(
      selectChain([{ orgSettings: {}, partnerTimezone: 'UTC', partnerSettings: {} }]), // org/partner timezone lookup
    );
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: bigHostname }], rowCount: 1 });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Attachment exceeds 5MB; sending link-only'),
        expect.objectContaining({ reportName: report.name, bytes: expect.any(Number) }),
      );
    } finally {
      consoleWarn.mockRestore();
    }

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0]![0] as { attachments: unknown[] };
    expect(mail.attachments).toHaveLength(0);
  });
});

// ─── Failure handling ────────────────────────────────────────────────────────

describe('scheduled report failure handling', () => {
  const report = {
    id: REPORT_ID,
    orgId: ORG_ID,
    name: 'Nightly inventory',
    type: 'device_inventory',
    format: 'csv',
    schedule: 'daily',
    config: { schedule: { time: '09:00' }, emailRecipients: ['ops@example.com'] },
    lastGeneratedAt: null,
  };

  const arrangeFailingRun = () => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockRejectedValueOnce(new Error('boom'));
  };

  it('tells recipients when the last attempt fails, without leaking the raw error', async () => {
    arrangeFailingRun();

    await expect(
      processRunScheduledReport(
        { type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 },
        { finalAttempt: true },
      ),
    ).rejects.toThrow('boom');

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0]![0] as { to: string[]; subject: string; html: string };
    expect(mail.to).toEqual(['ops@example.com']);
    expect(mail.subject).toContain('Nightly inventory');
    // The run row keeps the raw message for operators; the customer-facing
    // email must not carry it (it can hold Zod/PG internals).
    expect(mail.html).not.toContain('boom');
  });

  it('stays quiet on a non-final attempt so a retry can still succeed', async () => {
    arrangeFailingRun();

    await expect(
      processRunScheduledReport(
        { type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 },
        { finalAttempt: false },
      ),
    ).rejects.toThrow('boom');

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('keeps running the rest of the due batch when one inline report throws', async () => {
    const second = { ...report, id: '44444444-4444-4444-4444-444444444444', name: 'Second' };
    // findDueReports: both reports due (never generated).
    selectMock.mockReturnValueOnce(
      selectChain([
        { id: report.id, schedule: 'daily', lastGeneratedAt: null, config: report.config, orgSettings: null, partnerTimezone: null, partnerSettings: null },
        { id: second.id, schedule: 'daily', lastGeneratedAt: null, config: second.config, orgSettings: null, partnerTimezone: null, partnerSettings: null },
      ]),
    );
    // report 1: load -> throws during generation
    selectMock.mockReturnValueOnce(selectChain([report]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockRejectedValueOnce(new Error('boom'));
    // report 2: load -> succeeds
    selectMock.mockReturnValueOnce(selectChain([second]));
    selectMock.mockReturnValueOnce(selectChain([])); // timezone lookup
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processCheckSchedules()).resolves.toBeUndefined();

    // The throwing report must not starve its neighbour.
    expect(generateReportMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
