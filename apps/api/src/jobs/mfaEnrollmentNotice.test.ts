import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  withSystemContext: vi.fn(),
  runOutside: vi.fn(),
  getEffectiveMfaPolicy: vi.fn(),
  resolveRecipientLocale: vi.fn(),
  sendEmail: vi.fn(),
  getEmailService: vi.fn(),
  captureException: vi.fn(),
  attachObservability: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    getRepeatableJobs = vi.fn().mockResolvedValue([]);
    removeRepeatableByKey = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
}));
// Real `vi.fn`s (not inline arrows) so the diagnostic `label` argument every
// system-context call passes can be asserted, following aiBudgetAlertDelivery.test.ts.
vi.mock('../db', () => ({
  db: { execute: mocks.execute },
  withSystemDbAccessContext: mocks.withSystemContext,
  runOutsideDbContext: mocks.runOutside,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: mocks.captureException }));
vi.mock('../services/mfaPolicy', () => ({ getEffectiveMfaPolicy: mocks.getEffectiveMfaPolicy }));
vi.mock('../services/recipientLocale', () => ({ resolveRecipientLocale: mocks.resolveRecipientLocale }));
// Deterministic, order-independent translation stand-in: the namespaced key
// plus its interpolation vars, so a test can assert which template rendered
// without depending on real English/Portuguese copy.
vi.mock('../i18n', () => ({
  tApi: (locale: string, key: string, vars?: Record<string, unknown>) =>
    `${locale}:${key}:${JSON.stringify(vars ?? {})}`,
}));
vi.mock('../services/email', () => ({ getEmailService: mocks.getEmailService }));
vi.mock('../services/c2cM365', () => ({ getFrontendBaseUrl: () => 'https://app.example.com' }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.attachObservability }));

import {
  MFA_ENROLLMENT_NOTICE_QUEUE,
  createMfaEnrollmentNoticeWorker,
  getMfaEnrollmentNoticeQueue,
  initializeMfaEnrollmentNoticeWorker,
  runMfaEnrollmentNoticeSweep,
  scheduleMfaEnrollmentNoticeJobs,
} from './mfaEnrollmentNotice';

const dialect = new PgDialect();

function renderSql(q: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(q as SQL);
  return { sql, params: params as unknown[] };
}

/** `vi.resetAllMocks()` wipes implementations, so context wrappers must be re-armed per test. */
function armContextMocks() {
  mocks.withSystemContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.runOutside.mockImplementation(async (fn: () => Promise<unknown>) => fn());
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeRow {
  id: string;
  email: string;
  name: string;
  partner_id: string;
  org_id: string | null;
  notice_sent_at: string | null;
  reminded_at: string | null;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'user-1',
    email: 'user1@example.com',
    name: 'Ada Lovelace',
    partner_id: 'partner-1',
    org_id: 'org-1',
    notice_sent_at: null,
    reminded_at: null,
    ...overrides,
  };
}

/** Dispatches `db.execute` by rendered SQL text, order-independent. */
function mockExecute(candidateRows: FakeRow[]) {
  mocks.execute.mockImplementation(async (q: unknown) => {
    const { sql: text } = renderSql(q);
    if (text.includes('FROM users') && text.includes('mfa_enrollment_deadline IS NOT NULL')) {
      return candidateRows;
    }
    // UPDATE claim statements and anything else: no rows.
    return [];
  });
}

function updateCalls(): string[] {
  return mocks.execute.mock.calls
    .map((call: unknown[]) => renderSql(call[0]).sql)
    .filter((text: string) => text.trim().startsWith('UPDATE users'));
}

describe('runMfaEnrollmentNoticeSweep', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
    mocks.getEmailService.mockReturnValue({ sendEmail: mocks.sendEmail });
    mocks.resolveRecipientLocale.mockResolvedValue('en');
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it('sends the start notice and claims only notice_sent_at when the window just opened', async () => {
    const row = makeRow();
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 10 * DAY_MS).toISOString() },
    });

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 1, skipped: 0, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]?.[0].to).toBe('user1@example.com');
    expect(mocks.sendEmail.mock.calls[0]?.[0].subject).toContain('mfaEnrollmentNotice.subject');

    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('mfa_enrollment_notice_sent_at = now()');
    expect(updates[0]).toContain('mfa_enrollment_notice_sent_at IS NULL');
    expect(updates[0]).not.toContain('reminded_at');

    // getEffectiveMfaPolicy is called with the row's own scope/ids, and the
    // scope derives from whether org_id is set.
    expect(mocks.getEffectiveMfaPolicy).toHaveBeenCalledWith({
      scope: 'organization',
      userId: 'user-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
    });
  });

  it('derives partner scope when org_id is null', async () => {
    const row = makeRow({ org_id: null });
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 10 * DAY_MS).toISOString() },
    });

    await runMfaEnrollmentNoticeSweep();

    expect(mocks.getEffectiveMfaPolicy).toHaveBeenCalledWith({
      scope: 'partner',
      userId: 'user-1',
      orgId: null,
      partnerId: 'partner-1',
    });
  });

  it('sends the T-3 reminder and claims only reminded_at when the notice was already sent', async () => {
    const row = makeRow({ notice_sent_at: new Date().toISOString(), reminded_at: null });
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 2 * DAY_MS).toISOString() },
    });

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 1, skipped: 0, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]?.[0].subject).toContain('mfaEnrollmentReminder.subject');

    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('mfa_enrollment_reminded_at = now()');
    expect(updates[0]).not.toContain('notice_sent_at');
  });

  it('skips and does not claim a user whose pendingEnrollment is null (window lapsed, factor enrolled, role force removed, or kill switch off)', async () => {
    const row = makeRow();
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({ pendingEnrollment: null });

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(updateCalls()).toHaveLength(0);
  });

  it('leaves the claim column untouched when the send fails, so the next sweep retries', async () => {
    const row = makeRow();
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 10 * DAY_MS).toISOString() },
    });
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 0, skipped: 0, failed: 1 });
    expect(updateCalls()).toHaveLength(0);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'smtp down' }));
  });

  it('sends only the reminder (never two emails) and claims BOTH stamps when both notices are due in the same run', async () => {
    // A short configured grace window: neither stamp is set yet, but the
    // authoritative deadline is already inside the T-3 window.
    const row = makeRow({ notice_sent_at: null, reminded_at: null });
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 1 * DAY_MS).toISOString() },
    });

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 1, skipped: 0, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]?.[0].subject).toContain('mfaEnrollmentReminder.subject');

    const updates = updateCalls();
    expect(updates).toHaveLength(2);
    expect(updates.some((u) => u.includes('mfa_enrollment_notice_sent_at = now()'))).toBe(true);
    expect(updates.some((u) => u.includes('mfa_enrollment_reminded_at = now()'))).toBe(true);
  });

  it('one user failing does not abort the rest of the sweep', async () => {
    const rowA = makeRow({ id: 'user-a', email: 'a@example.com' });
    const rowB = makeRow({ id: 'user-b', email: 'b@example.com' });
    mockExecute([rowA, rowB]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 10 * DAY_MS).toISOString() },
    });
    mocks.sendEmail.mockRejectedValueOnce(new Error('smtp down')).mockResolvedValueOnce(undefined);

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 2, sent: 1, skipped: 0, failed: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('treats a missing email service as a failure that never claims (retries next sweep)', async () => {
    const row = makeRow();
    mockExecute([row]);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({
      pendingEnrollment: { deadline: new Date(Date.now() + 10 * DAY_MS).toISOString() },
    });
    mocks.getEmailService.mockReturnValue(null);

    const result = await runMfaEnrollmentNoticeSweep();

    expect(result).toEqual({ candidates: 1, sent: 0, skipped: 0, failed: 1 });
    expect(updateCalls()).toHaveLength(0);
  });

  it('warns when the candidate read hits the row cap', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => makeRow({ id: `user-${i}`, email: `u${i}@example.com` }));
    mockExecute(rows);
    mocks.getEffectiveMfaPolicy.mockResolvedValue({ pendingEnrollment: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runMfaEnrollmentNoticeSweep();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('500-row cap'));
    warn.mockRestore();
  });
});

describe('BullMQ wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
    // The queue is a module-level singleton across this whole file — the
    // FIRST test to touch it constructs the fake Queue, and `resetAllMocks`
    // in every later `beforeEach` wipes that instance's own `mockResolvedValue`
    // defaults back to "resolves undefined" without reconstructing it. Re-arm
    // the default here so each test starts from a known "no repeatables yet"
    // state; a test that needs different behavior overrides it below.
    const queue = getMfaEnrollmentNoticeQueue();
    (queue.getRepeatableJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('creates a worker on the expected queue name', () => {
    const worker = createMfaEnrollmentNoticeWorker();
    expect(worker).toBeDefined();
    expect(MFA_ENROLLMENT_NOTICE_QUEUE).toBe('mfa-enrollment-notice-jobs');
  });

  it('schedules the daily repeatable sweep, clearing any existing repeatables first', async () => {
    const queue = getMfaEnrollmentNoticeQueue();
    (queue.getRepeatableJobs as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: 'stale-key' }]);

    await scheduleMfaEnrollmentNoticeJobs();

    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    expect(queue.add).toHaveBeenCalledWith(
      'sweep',
      { type: 'sweep' },
      expect.objectContaining({ repeat: { pattern: expect.any(String) } }),
    );
  });

  it('wires observability into the worker on initialize', async () => {
    await initializeMfaEnrollmentNoticeWorker();
    expect(mocks.attachObservability).toHaveBeenCalledWith(expect.anything(), 'mfaEnrollmentNoticeWorker');
  });
});
