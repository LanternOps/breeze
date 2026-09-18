/**
 * Rendering pin for `emailReportRun` / `emailReportFailure` (#4248 W03, Task 1).
 *
 * Written BEFORE the two functions moved out of `jobs/reportScheduleWorker.ts`
 * into `services/reportDelivery.ts`, and driven through the worker's public
 * entry point so the pin is of observable behaviour, not of a module path. The
 * extraction is provably inert only if this file passes with ZERO snapshot
 * churn on both sides of the move.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); close = vi.fn(); },
  Worker: class { close = vi.fn(); on = vi.fn(); },
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
    id: 'reports.id', orgId: 'reports.org_id', type: 'reports.type', schedule: 'reports.schedule',
    lastGeneratedAt: 'reports.last_generated_at', config: 'reports.config', updatedAt: 'reports.updated_at',
    executionScopeVersion: 'reports.execution_scope_version', executionScopeKind: 'reports.execution_scope_kind',
    executionScopeSiteIds: 'reports.execution_scope_site_ids', executionScopeUserId: 'reports.execution_scope_user_id',
    executionScopeFingerprint: 'reports.execution_scope_fingerprint', executionScopeCapturedAt: 'reports.execution_scope_captured_at',
    executionScopePrincipalKind: 'reports.execution_scope_principal_kind',
  },
  reportRuns: { id: 'report_runs.id', reportId: 'report_runs.report_id', status: 'report_runs.status' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id', settings: 'organizations.settings' },
  partners: { id: 'partners.id', timezone: 'partners.timezone', settings: 'partners.settings' },
  contacts: { id: 'contacts.id', orgId: 'contacts.org_id', email: 'contacts.email' },
  reportScheduleRecipients: {
    reportId: 'report_schedule_recipients.report_id', orgId: 'report_schedule_recipients.org_id',
    contactId: 'report_schedule_recipients.contact_id',
  },
}));

const generateReportMock = vi.fn();
vi.mock('../services/reportGenerationService', () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...(args as [])),
  assertReportExecutionPreflight: vi.fn(),
  previousBaselineFor: vi.fn(async () => undefined),
}));

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '44444444-4444-4444-8444-444444444444';
vi.mock('../services/siteScope', () => ({
  resolveLiveReportAuthority: vi.fn(async () => ({
    ok: true,
    authority: {
      principalKind: 'user',
      scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
      principalUserId: USER_ID,
      capturedAt: new Date('2026-07-25T12:00:00.000Z'),
      fingerprint: 'f'.repeat(64),
    },
  })),
  decodeSiteScope: vi.fn(() => ({ version: 1, kind: 'unrestricted', orgId: ORG_ID })),
  intersectSiteScopes: vi.fn(() => ({ version: 1, kind: 'unrestricted', orgId: ORG_ID })),
  siteScopeFingerprint: vi.fn(() => 'f'.repeat(64)),
  persistedSiteScopeValues: vi.fn(() => ({})),
}));

const emailState = vi.hoisted(() => ({ configured: true }));
const sendEmail = vi.fn(async (_params: unknown) => undefined);
vi.mock('../services/email', () => ({
  getEmailService: () => (emailState.configured ? { sendEmail } : null),
}));

vi.mock('../services/reportBranding', () => ({
  loadReportBrandingForOrg: vi.fn(async () => ({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null })),
}));

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

vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => false), getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../config/env', () => ({ breezeRole: () => 'all' }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { processRunScheduledReport } from '../jobs/reportScheduleWorker';

const REPORT_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '33333333-3333-3333-3333-333333333333';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}
function insertChain(rows: unknown[]) {
  const chain = { values: vi.fn(), returning: vi.fn(async () => rows) };
  chain.values.mockReturnValue(chain);
  return chain;
}
function updateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(async () => []);
  return chain;
}

const SMALL_ROWS = [
  { hostname: 'pc-1', os: 'Windows 11', status: 'online' },
  { hostname: 'pc-2', os: 'macOS 15', status: 'offline' },
];
// > 5 MiB of CSV: reportScheduleWorker.ts:454 gates csv on MAX_ATTACHMENT_BYTES.
const HUGE_ROWS = Array.from({ length: 60_000 }, (_, i) => ({
  hostname: `host-${i}`,
  note: 'x'.repeat(100),
}));

function reportRow(overrides: Record<string, unknown>) {
  return {
    id: REPORT_ID,
    orgId: ORG_ID,
    name: 'Nightly inventory',
    type: 'device_inventory',
    format: 'csv',
    schedule: 'daily',
    config: { schedule: { time: '09:00' } },
    lastGeneratedAt: null,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-07-24T12:00:00.000Z'),
    ...overrides,
  };
}

async function runScheduledReportForTest(args: {
  format: 'pdf' | 'csv';
  rows: unknown[];
  recipients: string[];
  summary?: Record<string, unknown>;
}) {
  selectMock.mockReturnValueOnce(selectChain([reportRow({ format: args.format, config: { emailRecipients: args.recipients } })]));
  selectMock.mockReturnValueOnce(selectChain([])); // contact recipients
  selectMock.mockReturnValueOnce(selectChain([])); // org/partner timezone
  selectMock.mockReturnValueOnce(selectChain([{ partnerId: PARTNER_ID }])); // org -> partner, for report.delivery
  insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
  updateMock.mockReturnValue(updateChain());
  generateReportMock.mockResolvedValueOnce({ rows: args.rows, rowCount: args.rows.length, summary: args.summary });
  await processRunScheduledReport({ type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 });
}

async function runFailedReportForTest(args: { recipients: string[]; error: Error }) {
  selectMock.mockReturnValueOnce(selectChain([reportRow({ config: { emailRecipients: args.recipients } })]));
  selectMock.mockReturnValueOnce(selectChain([])); // contact recipients (failure branch)
  insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
  updateMock.mockReturnValue(updateChain());
  generateReportMock.mockRejectedValueOnce(args.error);
  await expect(
    processRunScheduledReport(
      { type: 'run-scheduled-report', reportId: REPORT_ID, occurrenceKey: 202607010900 },
      { finalAttempt: true },
    ),
  ).rejects.toBe(args.error);
}

/** Attachments are binary; pin their identity (length + digest) rather than
 * dumping megabytes into the snapshot file. */
function pinnable(params: unknown) {
  const p = params as { attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> };
  return {
    ...p,
    attachments: p.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      bytes: a.content.byteLength,
      sha256: createHash('sha256').update(a.content).digest('hex'),
    })),
  };
}

describe('report email rendering is pinned before the reportDelivery extraction (#4248 W03)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-25T14:30:00.000Z'));
    sendEmail.mockClear();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    generateReportMock.mockReset();
    emailState.configured = true;
    pdfRender.shouldThrow = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pdf report with a small attachment', async () => {
    await runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const params = pinnable(sendEmail.mock.calls[0]![0]);
    expect(params.attachments).toHaveLength(1);
    expect(params.attachments![0]!.contentType).toBe('application/pdf');
    // jsPDF stamps the creation time and a per-document id, so the digest is
    // not stable across processes; pin the envelope and the decision instead.
    expect({ ...params, attachments: params.attachments!.map(({ sha256: _s, bytes: _b, ...rest }) => rest) }).toMatchSnapshot();
  });

  it('csv report', async () => {
    await runScheduledReportForTest({ format: 'csv', rows: SMALL_ROWS, recipients: ['a@example.com'] });
    expect(pinnable(sendEmail.mock.calls[0]![0])).toMatchSnapshot();
  });

  it('csv report with a posture trend line', async () => {
    await runScheduledReportForTest({
      format: 'csv',
      rows: SMALL_ROWS,
      recipients: ['a@example.com', 'b@example.com'],
      summary: { postureScore: 79 },
    });
    expect(pinnable(sendEmail.mock.calls[0]![0])).toMatchSnapshot();
  });

  it('oversize attachment falls back to a link', async () => {
    await runScheduledReportForTest({ format: 'csv', rows: HUGE_ROWS, recipients: ['a@example.com'] });
    const params = pinnable(sendEmail.mock.calls[0]![0]);
    expect(params.attachments).toEqual([]);
    expect(params).toMatchSnapshot();
  });

  it('pdf render failure falls back to link-only without throwing', async () => {
    pdfRender.shouldThrow = true;
    await expect(
      runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] }),
    ).resolves.not.toThrow();
    const params = pinnable(sendEmail.mock.calls[0]![0]);
    expect(params.attachments).toEqual([]);
    expect(params).toMatchSnapshot();
  });

  it('no email service configured is a silent no-op, not an error', async () => {
    // This is EXACTLY why a boolean "emailed_at" stamp is unsound (spec OD-8):
    // a no-op return would stamp "sent".
    emailState.configured = false;
    await expect(
      runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] }),
    ).resolves.not.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('failure mail omits the underlying error', async () => {
    await runFailedReportForTest({ recipients: ['a@example.com'], error: new Error('PG: relation "x" does not exist') });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const params = sendEmail.mock.calls[0]![0];
    expect(JSON.stringify(params)).not.toContain('relation "x"');
    expect(params).toMatchSnapshot();
  });
});
