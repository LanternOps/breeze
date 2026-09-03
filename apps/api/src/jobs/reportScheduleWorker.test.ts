import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const queueAddMock = vi.fn(async (..._args: unknown[]) => undefined);

// Only the queued-path test (Redis available) ever constructs a Queue; a real
// bullmq Queue would try to actually connect using the fake `{}` connection
// object `getBullMQConnection()` returns below, so it's faked the same way
// every other worker test file in this directory fakes it (see alertQueue.test.ts).
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddMock;
    close = vi.fn();
  },
  Worker: class {
    close = vi.fn();
    on = vi.fn();
  },
  Job: class {},
}));

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
    // P2-3 (#4190) — the column A7's exclusion predicate names.
    type: 'reports.type',
    createdBy: 'reports.created_by',
    schedule: 'reports.schedule',
    lastGeneratedAt: 'reports.last_generated_at',
    config: 'reports.config',
    updatedAt: 'reports.updated_at',
    executionScopeVersion: 'reports.execution_scope_version',
    executionScopeKind: 'reports.execution_scope_kind',
    executionScopeSiteIds: 'reports.execution_scope_site_ids',
    executionScopeUserId: 'reports.execution_scope_user_id',
    executionScopeFingerprint: 'reports.execution_scope_fingerprint',
    executionScopeCapturedAt: 'reports.execution_scope_captured_at',
    executionScopePrincipalKind: 'reports.execution_scope_principal_kind',
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
const reportExecutionPreflightMock = vi.fn();
const previousBaselineForMock = vi.fn<
  (reportId: string, fingerprint: string) => Promise<PreviousBaseline>
>(async () => undefined);
vi.mock('../services/reportGenerationService', () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...(args as [])),
  assertReportExecutionPreflight: (...args: unknown[]) =>
    reportExecutionPreflightMock(...args),
  previousBaselineFor: (...args: unknown[]) =>
    previousBaselineForMock(...(args as [string, string])),
}));

const scopeState = vi.hoisted(() => ({
  liveResult: null as any,
  decodedScope: null as any,
  intersection: null as any,
  decodeError: null as Error | null,
}));
const resolveLiveReportAuthorityMock = vi.fn(
  async (_userId: string, _orgId: string, _action: 'read') => scopeState.liveResult,
);
const decodeSiteScopeMock = vi.fn((_row: unknown, _orgId: string) => {
  if (scopeState.decodeError) throw scopeState.decodeError;
  return scopeState.decodedScope;
});
const intersectSiteScopesMock = vi.fn(
  (_persistedScope: unknown, _currentScope: unknown) => scopeState.intersection,
);
vi.mock('../services/siteScope', () => ({
  resolveLiveReportAuthority: (...args: unknown[]) =>
    resolveLiveReportAuthorityMock(...(args as [string, string, 'read'])),
  decodeSiteScope: (...args: unknown[]) =>
    decodeSiteScopeMock(...(args as [unknown, string])),
  intersectSiteScopes: (...args: unknown[]) =>
    intersectSiteScopesMock(...(args as [unknown, unknown])),
  siteScopeFingerprint: vi.fn((scope: { kind: string }) =>
    scope.kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64)
  ),
  persistedSiteScopeValues: vi.fn((authority: any) => ({
    executionScopeVersion: 1,
    executionScopeKind: authority.scope.kind,
    executionScopeSiteIds:
      authority.scope.kind === 'restricted' ? authority.scope.siteIds : null,
    executionScopeUserId: authority.principalUserId,
    executionScopeFingerprint: authority.fingerprint,
    executionScopeCapturedAt: authority.capturedAt,
    executionScopePrincipalKind: 'user',
  })),
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

// Defaults to 'all' so every pre-existing test (written against the
// single-process shape) keeps exercising the inline path unchanged; role-gate
// tests below flip this per-test and restore it in their own finally.
const breezeRoleState = vi.hoisted(() => ({ role: 'all' as 'all' | 'api' | 'worker' }));
vi.mock('../config/env', () => ({
  breezeRole: () => breezeRoleState.role,
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
  buildOccurrenceClaimCas,
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
  const chain = {
    values: vi.fn(),
    returning: vi.fn(async () => rows),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

function updateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(async () => []);
  return chain;
}

/** For the CAS claim: `.update().set().where().returning()` — `rows` mimics
 * what Postgres would RETURNING: one row on a won claim, none on a lost one. */
function claimUpdateChain(rows: Array<{ id: string }>) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => rows);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  breezeRoleState.role = 'all';
  selectMock.mockReset();
  insertMock.mockReset();
  updateMock.mockReset();
  generateReportMock.mockReset();
  reportExecutionPreflightMock.mockReset();
  previousBaselineForMock.mockReset();
  sendEmailMock.mockReset();
  loadReportBrandingForOrgMock.mockReset();
  loadReportBrandingForOrgMock.mockResolvedValue({
    name: 'Olive MSP',
    logoDataUrl: null,
    logoAspect: null,
  });
  pdfRender.shouldThrow = false;
  previousBaselineForMock.mockResolvedValue(undefined);
  scopeState.decodeError = null;
  scopeState.decodedScope = {
    version: 1,
    kind: 'unrestricted',
    orgId: ORG_ID,
  };
  scopeState.intersection = {
    version: 1,
    kind: 'unrestricted',
    orgId: ORG_ID,
  };
  scopeState.liveResult = {
    ok: true,
    authority: {
      principalKind: 'user',
      scope: {
        version: 1,
        kind: 'unrestricted',
        orgId: ORG_ID,
      },
      principalUserId: '44444444-4444-4444-8444-444444444444',
      capturedAt: new Date('2026-07-25T12:00:00.000Z'),
      fingerprint: 'f'.repeat(64),
    },
  };
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
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));

    const due = await findDueReports(now);
    // lastGeneratedAt is the OBSERVED value at discovery time — the inline CAS
    // claim (processCheckSchedules) uses it to detect a concurrent claim.
    expect(due).toEqual([{ id: REPORT_ID, occurrenceKey: 202607010900, lastGeneratedAt: null }]);
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
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));

    expect(await findDueReports(now)).toEqual([]);
  });

  it('observes legacy/null schedules skipped by the complete-scope polling gate', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ count: 2 }]));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(await findDueReports(new Date('2026-07-01T15:00:00Z')))
        .toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('scope reauthorization'),
        expect.objectContaining({ count: 2 }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

// ─── Occurrence CAS + all-role gating (inline fallback) ─────────────────────

describe('processCheckSchedules inline fallback (occurrence CAS + role gate)', () => {
  function dueRow(overrides: Partial<{ id: string; lastGeneratedAt: Date | null }> = {}) {
    return {
      id: REPORT_ID,
      schedule: 'daily',
      lastGeneratedAt: null,
      config: { schedule: { time: '09:00' } },
      orgSettings: null,
      partnerTimezone: null,
      partnerSettings: null,
      ...overrides,
    };
  }

  it.each(['worker', 'api'] as const)(
    "role %s: skips the inline fallback entirely (even with Redis down) — never claims, never generates",
    async (role) => {
      breezeRoleState.role = role;
      selectMock.mockReturnValueOnce(selectChain([dueRow()]));
      selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(processCheckSchedules()).resolves.toBeUndefined();
        expect(consoleWarn).toHaveBeenCalledWith(
          expect.stringContaining(`Redis unavailable outside 'all' role`),
        );
      } finally {
        consoleWarn.mockRestore();
      }

      expect(updateMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
      expect(generateReportMock).not.toHaveBeenCalled();
    },
  );

  it("'all' role claims the occurrence via CAS before running it", async () => {
    selectMock.mockReturnValueOnce(selectChain([dueRow({ lastGeneratedAt: null })]));
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));
    const claim = claimUpdateChain([{ id: REPORT_ID }]);
    updateMock.mockReturnValueOnce(claim);
    // processRunScheduledReport's own path after the claim.
    selectMock.mockReturnValueOnce(selectChain([{
      id: REPORT_ID,
      orgId: ORG_ID,
      name: 'Nightly inventory',
      type: 'device_inventory',
      format: 'csv',
      schedule: 'daily',
      config: {},
      lastGeneratedAt: null,
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: '44444444-4444-4444-8444-444444444444',
      executionScopeFingerprint: 'f'.repeat(64),
      executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
    }]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()); // reportRuns -> completed
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processCheckSchedules()).resolves.toBeUndefined();

    expect(claim.where).toHaveBeenCalledTimes(1);
    expect(generateReportMock).toHaveBeenCalledTimes(1);
    // Only ONE update happened inside processRunScheduledReport (the reportRuns
    // completion) — the claim's own update already stamped lastGeneratedAt, so
    // processRunScheduledReport must not have stamped it again.
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("'all' role threads a NON-NULL observed lastGeneratedAt into the claim (not a hardcoded null)", async () => {
    // Every other CAS test in this describe block uses `lastGeneratedAt: null`,
    // so a mutation that hardcodes `claimReportOccurrence(item.id, null)` in
    // processCheckSchedules would pass them unnoticed (null replaced with null
    // is a no-op there). This case observes a previously-generated report and
    // asserts the CAS predicate actually threads that observed Date through —
    // as opposed to always claiming via `IS NULL`.
    const observed = new Date('2026-06-30T09:00:00.000Z');
    selectMock.mockReturnValueOnce(selectChain([dueRow({ lastGeneratedAt: observed })]));
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));
    const claim = claimUpdateChain([{ id: REPORT_ID }]);
    updateMock.mockReturnValueOnce(claim);
    // processRunScheduledReport's own path after the claim.
    selectMock.mockReturnValueOnce(selectChain([{
      id: REPORT_ID,
      orgId: ORG_ID,
      name: 'Nightly inventory',
      type: 'device_inventory',
      format: 'csv',
      schedule: 'daily',
      config: {},
      lastGeneratedAt: observed,
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: '44444444-4444-4444-8444-444444444444',
      executionScopeFingerprint: 'f'.repeat(64),
      executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
    }]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain()); // reportRuns -> completed
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processCheckSchedules()).resolves.toBeUndefined();

    expect(claim.where).toHaveBeenCalledTimes(1);
    const casArg = (claim.where as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // The predicate actually used must equal the CAS built from the OBSERVED
    // value (equality against the timestamp) and must NOT equal the CAS built
    // from null (an IS NULL claim) — that distinguishes a genuine thread from
    // a hardcoded-null mutation.
    expect(casArg).toEqual(buildOccurrenceClaimCas(REPORT_ID, observed));
    expect(casArg).not.toEqual(buildOccurrenceClaimCas(REPORT_ID, null));
  });

  it("a lost claim (concurrent tick already won it) skips the report without generating", async () => {
    selectMock.mockReturnValueOnce(selectChain([dueRow({ lastGeneratedAt: null })]));
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));
    updateMock.mockReturnValueOnce(claimUpdateChain([])); // lost the race — no row returned
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(processCheckSchedules()).resolves.toBeUndefined();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('already claimed by a concurrent check'),
      );
    } finally {
      consoleWarn.mockRestore();
    }

    expect(insertMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('the queued (Redis-available) path stays byte-identical: no claim, jobId dedup, real retry attempts', async () => {
    const { isRedisAvailable } = await import('../services/redis');
    vi.mocked(isRedisAvailable).mockReturnValue(true);

    try {
      selectMock.mockReturnValueOnce(selectChain([dueRow({ id: REPORT_ID, lastGeneratedAt: null })]));
      selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));

      await expect(processCheckSchedules()).resolves.toBeUndefined();

      // No CAS claim, no inline execution — the queue absorbs the dedup/retry.
      expect(updateMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
      expect(generateReportMock).not.toHaveBeenCalled();
      // occurrenceKey is computed from the real current time (findDueReports
      // is called with `new Date()`), so it isn't hard-coded here — only its
      // presence and consistent use in both the payload and the jobId matter.
      expect(queueAddMock).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queueAddMock.mock.calls[0]!;
      expect(name).toBe('run-scheduled-report');
      expect(payload).toMatchObject({ type: 'run-scheduled-report', reportId: REPORT_ID });
      const occurrenceKey = (payload as { occurrenceKey: number }).occurrenceKey;
      expect(opts).toEqual(
        expect.objectContaining({
          jobId: `report-sched-run-${REPORT_ID}-${occurrenceKey}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
        }),
      );
    } finally {
      vi.mocked(isRedisAvailable).mockReturnValue(false);
    }
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
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: '44444444-4444-4444-8444-444444444444',
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
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

    expect(resolveLiveReportAuthorityMock).toHaveBeenCalledWith(
      report.executionScopeUserId,
      ORG_ID,
      'read',
    );
    expect(generateReportMock).toHaveBeenCalledWith(
      'device_inventory',
      ORG_ID,
      report.config,
      expect.objectContaining({
        principalKind: 'user',
        scope: expect.objectContaining({ kind: 'unrestricted', orgId: ORG_ID }),
        principalUserId: report.executionScopeUserId,
        fingerprint: 'f'.repeat(64),
      }),
    );
    expect(runInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        executionScopeVersion: 1,
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: null,
        executionScopeUserId: report.executionScopeUserId,
        executionScopeFingerprint: 'f'.repeat(64),
        executionScopeCapturedAt: expect.any(Date),
        requestedByKind: 'user',
        requestedByUserId: report.executionScopeUserId,
        requestedByPortalUserId: null,
      }),
    );
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

  it('skips its own lastGeneratedAt stamp when the caller already claimed the occurrence', async () => {
    selectMock.mockReturnValueOnce(selectChain([{ ...report, config: {} }]));
    const runInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(runInsert);
    const runCompleteUpdate = updateChain();
    updateMock.mockReturnValueOnce(runCompleteUpdate);
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processRunScheduledReport(
      { type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 },
      { occurrenceClaimed: true },
    );

    // Exactly one update — the reportRuns completion. If the stamp update also
    // fired, updateMock would have been called twice, same as the unclaimed
    // test above.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(runCompleteUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('rejects an out-of-authority saved config before running insert, baseline, generation, update, or delivery', async () => {
    const restricted = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: ORG_ID,
      siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    };
    const scopedReport = {
      ...report,
      config: {
        filters: { siteIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] },
      },
      executionScopeKind: 'restricted',
      executionScopeSiteIds: restricted.siteIds,
    };
    selectMock.mockReturnValueOnce(selectChain([scopedReport]));
    scopeState.decodedScope = restricted;
    scopeState.intersection = restricted;
    scopeState.liveResult = {
      ok: true,
      authority: {
        ...scopeState.liveResult.authority,
        scope: restricted,
      },
    };
    reportExecutionPreflightMock.mockImplementationOnce(() => {
      throw new Error('outside authority');
    });
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(reportExecutionPreflightMock).toHaveBeenCalled();
    expect(failedInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: 'scope_config_outside_authority',
    }));
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(previousBaselineForMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
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

  it('refuses a system-principal definition before resolving any authority', async () => {
    // P2-3 (#4190): the report scheduler has no acting user to reauthorize a
    // system-authored definition against, and must never invent one. A7 also
    // excludes the type from findDueReports; this is the defence in depth.
    selectMock.mockReturnValueOnce(
      selectChain([
        {
          ...report,
          executionScopeUserId: null,
          executionScopePrincipalKind: 'system',
        },
      ]),
    );
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: REPORT_ID,
        status: 'failed',
        errorMessage: 'system_principal_definition',
        requestedByKind: 'system',
        requestedByUserId: null,
        requestedByPortalUserId: null,
      }),
    );
    expect(decodeSiteScopeMock).not.toHaveBeenCalled();
    expect(resolveLiveReportAuthorityMock).not.toHaveBeenCalled();
    expect(intersectSiteScopesMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(previousBaselineForMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('refuses a portal-user definition before decoding or inventing a staff principal', async () => {
    selectMock.mockReturnValueOnce(selectChain([{
      ...report,
      executionScopeUserId: null,
      executionScopePrincipalKind: 'portal_user',
    }]));
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: REPORT_ID,
        status: 'failed',
        errorMessage: 'portal_user_principal_definition',
        requestedByKind: 'portal_user',
        requestedByUserId: null,
        requestedByPortalUserId: null,
      }),
    );
    expect(decodeSiteScopeMock).not.toHaveBeenCalled();
    expect(resolveLiveReportAuthorityMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy scope', { decodedScope: { version: 1, kind: 'legacy_unscoped', orgId: ORG_ID } }],
    ['unverifiable scope', { decodeError: new Error('partial scope') }],
  ])('does not forge user provenance when denying a definition with no execution user for %s', async (_name, state) => {
    selectMock.mockReturnValueOnce(selectChain([{
      ...report,
      executionScopeUserId: null,
      executionScopePrincipalKind: null,
    }]));
    if ('decodedScope' in state) scopeState.decodedScope = state.decodedScope;
    if ('decodeError' in state) scopeState.decodeError = state.decodeError;
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        requestedByKind: null,
        requestedByUserId: null,
        requestedByPortalUserId: null,
      }),
    );
    expect(resolveLiveReportAuthorityMock).not.toHaveBeenCalled();
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it.each([
    ['inactive creator', { ok: false, reason: 'user_inactive' }],
    ['removed membership', { ok: false, reason: 'membership_removed' }],
    ['removed report permission', { ok: false, reason: 'permission_removed' }],
    ['restricted-empty live scope', { ok: false, reason: 'empty_scope' }],
  ])('fails closed for %s before generation, baseline, storage, delivery, or success audit', async (_name, liveResult) => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    scopeState.liveResult = liveResult;
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: REPORT_ID,
        status: 'failed',
        errorMessage: expect.stringMatching(/^scope_[a-z_]+$/),
      }),
    );
    const failedValues = failedInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(failedValues).not.toHaveProperty('result');
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(previousBaselineForMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loadReportBrandingForOrgMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy_unscoped definition', { decodedScope: { version: 1, kind: 'legacy_unscoped', orgId: ORG_ID } }],
    ['malformed partial definition scope', { decodeError: new Error('partial scope') }],
    ['empty persisted/current intersection', { intersection: { version: 1, kind: 'restricted', orgId: ORG_ID, siteIds: [] } }],
  ])('fails closed for %s before generation or delivery', async (_name, state) => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    if ('decodedScope' in state) scopeState.decodedScope = state.decodedScope;
    if ('decodeError' in state) scopeState.decodeError = state.decodeError;
    if ('intersection' in state) scopeState.intersection = state.intersection;
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(previousBaselineForMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('fails closed when live authority cannot be verified', async () => {
    selectMock.mockReturnValueOnce(selectChain([report]));
    resolveLiveReportAuthorityMock.mockRejectedValueOnce(new Error('database unavailable'));
    const failedInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(failedInsert);

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(failedInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'scope_unverifiable' }),
    );
    expect(generateReportMock).not.toHaveBeenCalled();
    expect(previousBaselineForMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('uses the narrowed immutable intersection for the run, baseline, and generator', async () => {
    const restricted = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: ORG_ID,
      siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    };
    scopeState.decodedScope = {
      ...restricted,
      siteIds: [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ],
    };
    scopeState.liveResult = {
      ok: true,
      authority: {
        ...scopeState.liveResult.authority,
        scope: restricted,
        fingerprint: 'a'.repeat(64),
      },
    };
    scopeState.intersection = restricted;
    selectMock.mockReturnValueOnce(selectChain([{ ...report, config: {} }]));
    const runInsert = insertChain([{ id: RUN_ID }]);
    insertMock.mockReturnValueOnce(runInsert);
    updateMock.mockReturnValueOnce(updateChain()).mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId: REPORT_ID,
      occurrenceKey: 202607010900,
    });

    expect(runInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        executionScopeKind: 'restricted',
        executionScopeSiteIds: restricted.siteIds,
        executionScopeFingerprint: 'a'.repeat(64),
      }),
    );
    expect(previousBaselineForMock).toHaveBeenCalledWith(REPORT_ID, 'a'.repeat(64));
    expect(generateReportMock).toHaveBeenCalledWith(
      'device_inventory',
      ORG_ID,
      {},
      expect.objectContaining({ scope: restricted, fingerprint: 'a'.repeat(64) }),
    );
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

    expect(previousBaselineForMock).toHaveBeenCalledWith(
      REPORT_ID,
      'f'.repeat(64),
    );
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
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: '44444444-4444-4444-8444-444444444444',
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
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
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }]));
    // report 1: CAS claim wins, then load -> throws during generation
    updateMock.mockReturnValueOnce(claimUpdateChain([{ id: report.id }]));
    selectMock.mockReturnValueOnce(selectChain([report]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain());
    generateReportMock.mockRejectedValueOnce(new Error('boom'));
    // report 2: CAS claim wins, then load -> succeeds
    updateMock.mockReturnValueOnce(claimUpdateChain([{ id: second.id }]));
    selectMock.mockReturnValueOnce(selectChain([second]));
    selectMock.mockReturnValueOnce(selectChain([])); // timezone lookup
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValueOnce(updateChain());
    generateReportMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(processCheckSchedules()).resolves.toBeUndefined();

    // The throwing report must not starve its neighbour.
    expect(generateReportMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

// ─── P2-3 (#4190): the report scheduler never touches a system-managed AI
//     narrative definition ────────────────────────────────────────────────────

/**
 * A narrative definition lives in `reports` with `schedule = 'weekly'`, so it
 * matches this worker's polling predicate on shape alone. It must not: its
 * occurrences are owned by the AGENT scheduler, it has no acting user to
 * reauthorize against, and its type has no generator at all.
 *
 * Two exclusions, and both are asserted here because they fail differently.
 * `findDueReports` keeps it out of the polling result AND out of the
 * "requires scope reauthorization" warning count — that warning is an operator
 * signal, and a narrative definition (execution_scope_user_id IS NULL by
 * construction) would inflate it forever with rows nobody can or should
 * reauthorize. `processRunScheduledReport` refuses it too, for a job already
 * on the queue when the exclusion shipped.
 */
describe('system-managed narrative definitions are outside this worker (P2-3)', () => {
  const report = {
    id: REPORT_ID,
    orgId: ORG_ID,
    name: 'Weekly AI operations narrative',
    type: 'device_inventory',
    format: 'csv',
    schedule: 'weekly',
    config: {},
    lastGeneratedAt: null,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: '44444444-4444-4444-8444-444444444444',
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
    executionScopePrincipalKind: 'user',
  };

  /** `selectChain` deliberately drops the condition; this variant keeps it. */
  function capturingSelectChain(rows: unknown[], sink: unknown[]) {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn((condition: unknown) => { sink.push(condition); return chain; });
    chain.limit = vi.fn(async () => rows);
    chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  }

  function mentions(condition: unknown, needle: string): boolean {
    const seen = new Set<unknown>();
    const walk = (node: unknown): boolean => {
      if (node === needle) return true;
      if (node === null || typeof node !== 'object') return false;
      if (seen.has(node)) return false;
      seen.add(node);
      return Object.values(node as Record<string, unknown>).some(walk);
    };
    return walk(condition);
  }

  it('excludes the narrative type from BOTH the due query and the reauthorization warning count', async () => {
    const wheres: unknown[] = [];
    selectMock
      .mockReturnValueOnce(capturingSelectChain([], wheres))
      .mockReturnValueOnce(capturingSelectChain([{ count: 0 }], wheres));

    await findDueReports(new Date('2026-07-01T15:00:00Z'));

    expect(wheres).toHaveLength(2);
    for (const [index, condition] of wheres.entries()) {
      expect(mentions(condition, 'reports.type'), `query ${index} must name reports.type`).toBe(true);
      expect(mentions(condition, 'ai_org_narrative'), `query ${index} must exclude the narrative type`)
        .toBe(true);
      // Non-vacuity: the pre-existing one_time exclusion is still there, so
      // this is an ADDED predicate rather than a replaced one.
      expect(mentions(condition, 'one_time')).toBe(true);
    }
  });

  it('refuses a stale queued narrative job WITHOUT writing a failed run row', async () => {
    // A failed `report_runs` row here would be worse than the no-op: it renders
    // in the org's report history under the narrative definition, next to the
    // real weekly artifacts, saying the weekly narrative failed. It did not —
    // this worker simply is not its owner.
    selectMock.mockReturnValueOnce(selectChain([{ ...report, type: 'ai_org_narrative' }]));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await processRunScheduledReport({
        type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900,
      });

      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(generateReportMock).not.toHaveBeenCalled();
      expect(decodeSiteScopeMock).not.toHaveBeenCalled();
      expect(resolveLiveReportAuthorityMock).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('agent scheduler'),
        expect.objectContaining({ reportId: REPORT_ID }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('CONTROL: an ordinary weekly definition still runs', async () => {
    selectMock.mockReturnValueOnce(selectChain([{ ...report, schedule: 'weekly' }]));
    insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
    updateMock.mockReturnValue(updateChain());
    generateReportMock.mockResolvedValue({ rows: [], rowCount: 0 });

    await processRunScheduledReport({
      type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900,
    });

    expect(generateReportMock).toHaveBeenCalled();
  });
});
