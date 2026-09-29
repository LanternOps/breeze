/**
 * Multi-org report series W02 — the schedule worker's series gate, series
 * recipients and repair sweep (spec §3.3, §3.5; §5 W02 "Worker test").
 * db is faked positionally; the schema and drizzle are real so recorded WHERE
 * clauses compile to the SQL Postgres would receive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const q = vi.hoisted(() => ({
  selects: [] as unknown[][],
  wheres: [] as unknown[],
  inserts: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  ambient: 0,
  ambientAtSweep: null as number | null,
  processor: null as null | ((job: unknown) => Promise<unknown>),
  redis: false,
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); close = vi.fn(); },
  Worker: class {
    close = vi.fn();
    on = vi.fn();
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) { q.processor = processor; }
  },
  Job: class {},
}));
vi.mock('../db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit']) c[m] = () => c;
    c.where = (w: unknown) => { q.wheres.push(w); return c; };
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: vi.fn(() => { q.order.push('select'); return chain(q.selects.shift() ?? []); }),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          q.inserts.push(values);
          const done = Promise.resolve([{ id: 'run-1', ...values }]);
          return {
            returning: () => done,
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done.then(resolve, reject),
          };
        },
      })),
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => {
      q.ambient += 1;
      try { return await fn(); } finally { q.ambient -= 1; }
    }),
  };
});
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => q.redis), getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../config/env', () => ({ breezeRole: () => 'all' }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../services/sentry', () => sentry);

const series = vi.hoisted(() => ({ gate: vi.fn(), sweep: vi.fn(), childRecipients: vi.fn() }));
vi.mock('../services/reportSeries/reconcile', () => ({
  seriesChildGate: series.gate,
  reconcileAllSeries: series.sweep,
}));
vi.mock('../services/reportSeries/recipients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/reportSeries/recipients')>()),
  resolveSeriesChildRecipients: series.childRecipients,
}));

import { SeriesAuthorityUnverifiableError } from '../services/reportSeries/authority';
import {
  initializeReportScheduleWorker,
  processCheckSchedules,
  processRunScheduledReport,
  resolveRunRecipientSets,
  resolveScheduledReportRecipients,
  runCheckSchedulesTick,
  shutdownReportScheduleWorker,
} from './reportScheduleWorker';

const REPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SERIES_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const job = { type: 'run-scheduled-report' as const, reportId: REPORT_ID, occurrenceKey: 202610010900 };

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID, orgId: ORG_ID, partnerId: null, name: 'Monthly summary', type: 'executive_summary',
    schedule: 'monthly', format: 'pdf', config: {}, seriesId: SERIES_ID, seriesRevision: 1, archivedAt: null,
    executionScopePrincipalKind: 'user', executionScopeUserId: USER_ID, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  q.selects = [];
  q.wheres = [];
  q.inserts = [];
  q.order = [];
  q.ambient = 0;
  q.ambientAtSweep = null;
  q.processor = null;
  q.redis = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  series.sweep.mockImplementation(async () => { q.order.push('sweep'); q.ambientAtSweep = q.ambient; });
});

describe('processRunScheduledReport — series gate', () => {
  it.each([
    ['skip_untargeted', 'series_skip_untargeted'],
    ['skip_disabled', 'series_skip_disabled'],
    ['skip_archived', 'series_skip_archived'],
    ['blocked_no_authority', 'series_blocked_no_authority'],
  ])('a child the gate answers %s is recorded as a skip and never generated', async (decision, reason) => {
    series.gate.mockResolvedValue(decision);
    q.selects = [[child()]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(series.gate).toHaveBeenCalledWith({
      id: REPORT_ID, orgId: ORG_ID, seriesId: SERIES_ID, seriesRevision: 1, archivedAt: null,
    });
    expect(q.inserts).toEqual([expect.objectContaining({
      reportId: REPORT_ID, status: 'failed', errorMessage: reason, requestedByKind: null,
    })]);
    expect(q.order).toEqual(['select']);
  });

  it("on 'run' the worker re-reads the row and runs the CURRENT definition", async () => {
    series.gate.mockResolvedValue('run');
    // The re-read row is system-principal: the worker's early deny proves the
    // fresh row (not the queued one) is what runs.
    q.selects = [[child()], [child({ executionScopePrincipalKind: 'system', executionScopeUserId: null })]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(q.order).toEqual(['select', 'select']);
    expect(q.inserts[0]).toMatchObject({ errorMessage: 'system_principal_definition' });
  });

  it('a transient authority failure propagates for a BullMQ retry: no skip row, no failed run', async () => {
    series.gate.mockRejectedValue(new SeriesAuthorityUnverifiableError());
    q.selects = [[child()]];
    await expect(processRunScheduledReport(job, { finalAttempt: false }))
      .rejects.toBeInstanceOf(SeriesAuthorityUnverifiableError);
    expect(q.inserts).toEqual([]);
    expect(q.order).toEqual(['select']);
  });

  it('an ordinary report never reaches the series gate', async () => {
    q.selects = [[child({ seriesId: null, seriesRevision: null, executionScopePrincipalKind: 'system', executionScopeUserId: null })]];
    await processRunScheduledReport(job, { finalAttempt: true });
    expect(series.gate).not.toHaveBeenCalled();
    expect(q.inserts[0]).toMatchObject({ errorMessage: 'system_principal_definition' });
  });
});

describe('runCheckSchedulesTick — repair sweep', () => {
  it('runs the sweep before the due scan, with NO ambient DB context', async () => {
    q.selects = [[], [{ count: 0 }]];
    await runCheckSchedulesTick();
    expect(q.order).toEqual(['sweep', 'select', 'select']);
    expect(q.ambientAtSweep).toBe(0);
  });

  // Review Focus 5.
  it('still scans due reports when the sweep rejects, and reports the failure', async () => {
    const boom = new Error('sweep down');
    series.sweep.mockRejectedValue(boom);
    q.selects = [[], [{ count: 0 }]];
    await expect(runCheckSchedulesTick()).resolves.toBeUndefined();
    expect(q.order).toEqual(['select', 'select']);
    expect(sentry.captureException).toHaveBeenCalledWith(boom);
  });

  it('processCheckSchedules itself never runs the sweep', async () => {
    q.selects = [[], [{ count: 0 }]];
    await processCheckSchedules();
    expect(series.sweep).not.toHaveBeenCalled();
  });
});

describe('BullMQ handler — sweep placement', () => {
  it("'check-schedules' sweeps outside runWithSystemDbAccess; the due scan runs inside it", async () => {
    q.redis = true;
    q.selects = [[], [{ count: 0 }]];
    await initializeReportScheduleWorker();
    try {
      await q.processor!({ data: { type: 'check-schedules' }, opts: {}, attemptsMade: 0 });
      expect(q.ambientAtSweep).toBe(0);
      expect(q.order).toEqual(['sweep', 'select', 'select']);
    } finally {
      await shutdownReportScheduleWorker();
    }
  });
});

describe('resolveRunRecipientSets', () => {
  it('a series child: customer = rule/overrides, cc = internal CC, recipients = deduped union', async () => {
    q.selects = [[{ recipientRule: { primaryContact: true, roles: ['billing'] } }]];
    series.childRecipients.mockResolvedValue({ customer: ['a@acme.test'], cc: ['noc@msp.test', 'A@acme.test'], dropped: 1 });
    const out = await resolveRunRecipientSets({
      reportId: REPORT_ID, seriesId: SERIES_ID, orgId: ORG_ID, config: { emailRecipients: ['noc@msp.test'] },
    });
    expect(series.childRecipients).toHaveBeenCalledWith({
      reportId: REPORT_ID, orgId: ORG_ID, rule: { primaryContact: true, roles: ['billing'] }, internalCc: ['noc@msp.test'],
    });
    // recipient_count (INDEX ruling) is customer.length = 1: the CC is not a customer.
    expect(out).toEqual({
      customer: ['a@acme.test'],
      cc: ['noc@msp.test', 'A@acme.test'],
      recipients: ['a@acme.test', 'noc@msp.test'],
      dropped: 1,
    });
  });

  it('a series child over the 50 cap truncates the union and counts the overflow as dropped', async () => {
    q.selects = [[{ recipientRule: {} }]];
    const customer = Array.from({ length: 52 }, (_, i) => `c${i}@acme.test`);
    series.childRecipients.mockResolvedValue({ customer, cc: [], dropped: 0 });
    const out = await resolveRunRecipientSets({
      reportId: REPORT_ID, seriesId: SERIES_ID, orgId: ORG_ID, config: {},
    });
    expect(out.recipients).toHaveLength(50);
    expect(out.dropped).toBe(2);
  });

  it("an ordinary report returns W01's sets unchanged (cc always empty)", async () => {
    q.selects = [[]];
    const out = await resolveRunRecipientSets({
      reportId: REPORT_ID, seriesId: null, orgId: ORG_ID, config: { emailRecipients: ['ops@x.test'] },
    });
    expect(out).toEqual({ customer: ['ops@x.test'], cc: [], recipients: ['ops@x.test'], dropped: 0 });
    expect(series.childRecipients).not.toHaveBeenCalled();
  });

  // Review Focus 2 (belt): a 'remove' row is never read as a recipient.
  it("resolveScheduledReportRecipients reads only mode = 'add' rows", async () => {
    q.selects = [[]];
    await resolveScheduledReportRecipients({ reportId: REPORT_ID, orgId: ORG_ID, config: {} });
    const { sql, params } = new PgDialect().sqlToQuery(q.wheres[0] as SQL);
    expect(sql).toContain('"report_schedule_recipients"."mode" = $');
    expect(params).toContain('add');
  });
});
