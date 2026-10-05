import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderDueToday, reminderStep, runInvoiceReminderSweep } from './reminderSweep';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { STALE_REMINDER_REASON } from './reminderValidation';

const input = {
  dueDate: '2026-10-08', today: '2026-10-05', beforeDueDays: 3,
  repeatDays: null, overdueEveryDays: 7, lastSentSeq: 0,
};

describe('reminderDueToday', () => {
  it.each([
    ['2026-10-04', null],
    ['2026-10-05', { kind: 'payment_reminder', seq: 1 }],
    ['2026-10-06', null],
    ['2026-10-08', null],
    ['2026-10-09', null],
    ['2026-10-14', null],
    ['2026-10-15', { kind: 'payment_overdue', seq: 1 }],
    ['2026-10-22', { kind: 'payment_overdue', seq: 2 }],
  ])('evaluates %s with no upcoming repeats', (today, expected) => {
    expect(reminderDueToday({ ...input, today: today as string })).toEqual(expected);
  });
  it.each([
    ['2026-10-01', 1], ['2026-10-03', 2], ['2026-10-05', 3], ['2026-10-07', 4],
  ])('numbers upcoming repeats on %s', (today, seq) => {
    expect(reminderDueToday({ ...input, today, beforeDueDays: 7, repeatDays: 2 }))
      .toEqual({ kind: 'payment_reminder', seq });
  });
  it('does not backfill a missed tick or send on the due date', () => {
    expect(reminderDueToday({ ...input, today: '2026-10-04', beforeDueDays: 7, repeatDays: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: input.dueDate, repeatDays: 1 })).toBeNull();
  });
  it('suppresses allocated sequences after retry or cadence edits', () => {
    expect(reminderDueToday({ ...input, lastSentSeq: 1 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-15', lastSentSeq: 2 })).toBeNull();
    expect(reminderDueToday({ ...input, today: '2026-10-29', lastSentSeq: 2 }))
      .toEqual({ kind: 'payment_overdue', seq: 3 });
  });
  it.each([
    ['2028-03-01', '2028-02-29'],
    ['2026-11-02', '2026-11-01'],
    ['2027-01-01', '2026-12-31'],
  ])('uses UTC calendar days across %s', (dueDate, today) => {
    expect(reminderDueToday({ ...input, dueDate, today, beforeDueDays: 1 }))
      .toEqual({ kind: 'payment_reminder', seq: 1 });
  });
  it.each([
    { dueDate: '2026-02-30' }, { today: '2026-10-05T00:00:00Z' },
    { beforeDueDays: 0 }, { beforeDueDays: 32 }, { repeatDays: 0 },
    { repeatDays: 1.5 }, { overdueEveryDays: 32 }, { lastSentSeq: -1 },
  ])('rejects corrupt inputs %j', (patch) => {
    expect(() => reminderDueToday({ ...input, ...patch })).toThrow(RangeError);
  });
});

describe('reminderStep', () => {
  it.each([
    ['2026-10-04', null],
    ['2026-10-05', { kind: 'payment_reminder', seq: 1, onDay: true }],
    ['2026-10-06', { kind: 'payment_reminder', seq: 1, onDay: false }],
    ['2026-10-08', null],
    ['2026-10-14', null],
    ['2026-10-15', { kind: 'payment_overdue', seq: 1, onDay: true }],
    ['2026-10-16', { kind: 'payment_overdue', seq: 1, onDay: false }],
    ['2026-10-22', { kind: 'payment_overdue', seq: 2, onDay: true }],
  ])('places %s on the latest cadence step', (today, expected) => {
    expect(reminderStep({ ...input, today: today as string })).toEqual(expected);
  });
  it('numbers repeating upcoming steps between ticks', () => {
    expect(reminderStep({ ...input, today: '2026-10-04', beforeDueDays: 7, repeatDays: 2 }))
      .toEqual({ kind: 'payment_reminder', seq: 2, onDay: false });
  });
  it('agrees with reminderDueToday on every cadence day', () => {
    for (let day = 1; day <= 31; day++) {
      const today = `2026-10-${String(day).padStart(2, '0')}`;
      const step = reminderStep({ ...input, today, beforeDueDays: 7, repeatDays: 2 });
      expect(reminderDueToday({ ...input, today, beforeDueDays: 7, repeatDays: 2 }))
        .toEqual(step?.onDay ? { kind: step.kind, seq: step.seq } : null);
    }
  });
});

import { invoices, organizations, billingNoticeOutbox } from '../../db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';

type Query = { table?: unknown; predicate?: unknown; limit?: number; locked?: boolean; order?: unknown };
const mock = vi.hoisted(() => ({
  queries: [] as Query[], respond: undefined as undefined | ((query: Query) => unknown[]),
  results: [] as unknown[][], predicates: [] as unknown[], locks: vi.fn(),
  settings: vi.fn(), enqueue: vi.fn(), render: vi.fn(), link: vi.fn(), system: vi.fn(), capture: vi.fn(),
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => { mock.system(); return fn(); },
  db: { select: () => {
    const chain: Record<string, unknown> = {};
    const query: Query = {};
    chain.innerJoin = () => chain;
    chain.from = (table: unknown) => { query.table = table; return chain; };
    chain.orderBy = (order: unknown) => { query.order = order; return chain; };
    chain.limit = (limit: number) => { query.limit = limit; return chain; };
    chain.where = (predicate: unknown) => { query.predicate = predicate; mock.predicates.push(predicate); return chain; };
    chain.for = (...args: unknown[]) => { query.locked = true; mock.locks(...args); return chain; };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      (mock.queries.push(query), Promise.resolve(mock.respond ? mock.respond(query) : mock.results.shift() ?? []).then(resolve, reject));
    return chain;
  } },
}));
vi.mock('../sentry', () => ({ captureException: mock.capture }));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: mock.settings }));
vi.mock('./noticeOutbox', () => ({ enqueueBillingNotice: mock.enqueue }));
vi.mock('./renderBillingNotice', () => ({ renderBillingNotice: mock.render }));
vi.mock('../invoiceLinkToken', () => ({
  getOrMintInvoiceLink: mock.link,
  buildPublicInvoiceUrl: (token: string) => `https://portal.example.test/invoice/${token}`,
}));
vi.mock('../invoicePdf', () => ({
  resolveBillingEmail: (raw: { email?: string } | null) => raw?.email ?? null,
}));

const org = {
  id: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  name: 'Org', partnerName: 'MSP', partnerSettings: {}, billingContact: { email: 'billing@example.test' },
};
const invoice = {
  id: '33333333-3333-4333-8333-333333333333', orgId: org.id, partnerId: org.partnerId,
  dueDate: '2026-10-08', invoiceNumber: 'INV-1', balance: '25.05', currencyCode: 'EUR',
};
const now = new Date('2026-10-05T06:18:00Z');
function seedMock(rows = [invoice], maxSeq = 0) {
  mock.results.push([org], rows.map(({ id }) => ({ id })));
  for (const row of rows) mock.results.push([row], [{ seq: maxSeq }]);
  mock.results.push([], []); // final invoice page, final org page
}

describe('runInvoiceReminderSweep', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mock.queries.length = 0; mock.respond = undefined; mock.results.length = 0; mock.predicates.length = 0;
    mock.settings.mockResolvedValue({
      remindersEnabled: { value: true, source: 'partner' },
      reminderBeforeDueDays: { value: 3, source: 'default' },
      reminderRepeatDays: { value: null, source: 'default' },
      overdueReminderEveryDays: { value: 7, source: 'default' },
    });
    mock.enqueue.mockResolvedValue({ id: 'outbox', created: true });
    mock.render.mockResolvedValue({ subject: 'Reminder', html: '<p>Reminder</p>', text: 'Reminder', frozen: {} });
    mock.link.mockResolvedValue({ token: 'opaque', expiresAt: new Date('2030-01-01'), origin: 'minted' });
  });
  it('resolves once per org and enqueues both partial balances', async () => {
    seedMock([invoice, { ...invoice, id: '44444444-4444-4444-8444-444444444444' }]);
    await expect(runInvoiceReminderSweep(now)).resolves.toEqual({ enqueued: 2, skippedNoContact: 0 });
    expect(mock.settings).toHaveBeenCalledTimes(1);
    expect(mock.settings).toHaveBeenCalledWith(expect.anything(), { partnerId: org.partnerId, orgId: org.id });
    expect(mock.locks).toHaveBeenCalledWith('update');
    expect(mock.system.mock.calls.length).toBeGreaterThan(2);
    expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: org.id, partnerId: org.partnerId, invoiceId: invoice.id,
      kind: 'payment_reminder', seq: 1, toEmail: 'billing@example.test',
      dedupeKey: `invoice:${invoice.id}:payment_reminder:1`,
    }));
    expect(mock.render).toHaveBeenCalledWith('payment_reminder', expect.objectContaining({
      data: expect.objectContaining({ balance: '25.05', currency: 'EUR' }),
    }));
  });
  it('compiles open-AR, lifecycle, balance and all active-schedule exclusions without a rollout gate', async () => {
    seedMock(); await runInvoiceReminderSweep(now);
    const dialect = new PgDialect();
    const queries = mock.predicates.map((where) => dialect.sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0]));
    const text = queries.map(q => q.sql).join('\n');
    const params = queries.flatMap(q => q.params);
    expect(text).toContain('public_link_live_org');
    expect(text).toContain("IN ('sent','partially_paid','overdue')");
    expect(text).toContain('invoice_autopay_schedules');
    expect(text).toMatch(/NOT EXISTS/i);
    expect(text).toContain('balance');
    for (const state of ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled']) {
      expect(params).toContain(state);
    }
    expect(text).not.toContain('autopay_enabled');
  });
  it('counts conflict insertion as zero and does not count an allocated sequence again', async () => {
    seedMock(); mock.enqueue.mockResolvedValue({ id: 'existing', created: false });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 0 });
    mock.enqueue.mockClear(); seedMock([invoice], 1);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'missing', 'invalid'])('skips %s before enumerating eligible invoices', async (guard) => {
    let orgReads = 0;
    let invoiceReads = 0;
    mock.respond = (query) => {
      if (query.table === organizations) return orgReads++ === 0 ? [{ ...org,
        billingContact: guard === 'missing' ? null : { email: guard === 'invalid' ? '@' : 'billing@example.test' },
      }] : [];
      if (query.table === invoices) return query.locked ? [invoice] : invoiceReads++ === 0 ? [{ id: invoice.id }] : [];
      return [{ seq: 0 }];
    };
    if (guard === 'disabled') mock.settings.mockResolvedValueOnce({ remindersEnabled: { value: false, source: 'org' } });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: guard === 'disabled' ? 0 : 1 });
    expect(mock.settings).toHaveBeenCalledOnce();
    expect(mock.queries.filter(q => q.table === invoices)).toHaveLength(0);
    expect(mock.enqueue).not.toHaveBeenCalled();
    expect(mock.link).not.toHaveBeenCalled();
  });
  it('rechecks after a payment removes the locked candidate', async () => {
    mock.results.push([org], [{ id: invoice.id }], [], [], []);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it('continues after a failed invoice, then rejects for a safe job retry', async () => {
    seedMock([invoice, { ...invoice, id: '44444444-4444-4444-8444-444444444444' }]);
    mock.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(runInvoiceReminderSweep(now)).rejects.toThrow('Invoice reminder sweep failed');
    expect(mock.enqueue).toHaveBeenCalledTimes(2);
    expect(mock.capture).toHaveBeenCalledWith(expect.any(Error), undefined,
      expect.objectContaining({ orgId: org.id, invoiceId: invoice.id }));
  });
  it('constrains history by invoice, org and kind independently', async () => {
    seedMock(); await runInvoiceReminderSweep(now);
    const history = mock.queries.find(q => q.table === billingNoticeOutbox)!;
    const query = new PgDialect().sqlToQuery(history.predicate as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(query.sql).toMatch(/"invoice_id" = \$1/);
    expect(query.sql).toMatch(/"org_id" = \$2/);
    expect(query.sql).toMatch(/"kind" = \$3/);
    expect(query.params).toEqual([invoice.id, org.id, 'payment_reminder']);
  });
  it('counts only enabled orgs without contacts and warns once without PII', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.results.push([
      { ...org, billingContact: null }, { ...org, billingContact: { email: 'private-invalid' } },
      { ...org, billingContact: null },
    ], []);
    mock.settings.mockResolvedValueOnce({ remindersEnabled: { value: false } });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 2 });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[invoiceReminderSweep] missing billing contact', { skippedNoContact: 2 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-invalid');
    warn.mockRestore();
  });
  it('reports every poison invoice with ids, caps aggregate errors and finishes its page', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = Array.from({ length: 102 }, (_, i) => ({ ...invoice, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    seedMock(rows);
    for (let i = 0; i < 101; i++) mock.enqueue.mockRejectedValueOnce(new Error('private bearer URL'));
    const error = await runInvoiceReminderSweep(now).catch(error => error) as AggregateError;
    expect(error.message).toBe('Invoice reminder sweep failed for 101 items');
    expect(error.errors).toHaveLength(100);
    expect(mock.enqueue).toHaveBeenCalledTimes(102);
    expect(mock.capture).toHaveBeenCalledTimes(101);
    expect(log).toHaveBeenCalledTimes(101);
    expect(log).toHaveBeenCalledWith('[invoiceReminderSweep] item failed', expect.objectContaining({ orgId: org.id, invoiceId: rows[0]!.id }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private bearer URL');
    expect(mock.capture.mock.calls.every(([error]) => !error.message.includes('private bearer URL'))).toBe(true);
    log.mockRestore();
  });
  it('handles an empty fleet', async () => {
    mock.results.push([]);
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(mock.settings).not.toHaveBeenCalled();
  });

  it('rechecks every eligibility predicate in the locked query', async () => {
    seedMock();
    await runInvoiceReminderSweep(now);
    const locked = mock.queries.filter(q => q.locked);
    expect(locked).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(locked[0]!.predicate as Parameters<PgDialect['sqlToQuery']>[0]);
    expect(query.sql).toContain("IN ('sent','partially_paid','overdue')");
    expect(query.sql).toContain('public_link_live_org');
    expect(query.sql).toMatch(/"invoices"\."balance" > /);
    expect(query.sql).toContain('"invoices"."due_date" is not null');
    expect(query.sql).toMatch(/NOT EXISTS/i);
    expect(query.sql).toContain('invoice_autopay_schedules');
    expect(query.params).toEqual(expect.arrayContaining([
      invoice.id, org.id, org.partnerId, '0',
      'awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled',
    ]));
  });
  it('crosses 100-org and 250-invoice boundaries with UUID cursors and no repeats', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const orgs = Array.from({ length: 101 }, (_, i) => ({ ...org, id: uuid(i + 1) }));
    const rows = orgs.flatMap((o, i) => Array.from({ length: i === 0 ? 251 : 1 }, (_, j) => ({
      ...invoice, orgId: o.id, id: uuid(1000 + i * 1000 + j),
    })));
    const dialect = new PgDialect();
    const params = (q: Query) => dialect.sqlToQuery(q.predicate as Parameters<PgDialect['sqlToQuery']>[0]).params;
    mock.respond = q => {
      const values = params(q);
      if (q.table === organizations) {
        const cursor = values.find(v => orgs.some(o => o.id === v)) as string | undefined;
        return orgs.filter(o => !cursor || o.id > cursor).slice(0, q.limit);
      }
      if (q.table === billingNoticeOutbox) return [{ seq: 0 }];
      if (q.locked) return rows.filter(r => r.id === values[0]);
      const cursor = values.find(v => rows.some(r => r.id === v)) as string | undefined;
      return rows.filter(r => r.orgId === values[0] && (!cursor || r.id > cursor)).slice(0, q.limit).map(r => ({ id: r.id }));
    };
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 351, skippedNoContact: 0 });
    expect(mock.settings).toHaveBeenCalledTimes(101);
    const orgPages = mock.queries.filter(q => q.table === organizations);
    expect(orgPages).toHaveLength(3);
    expect(orgPages.every(q => q.limit === 100 && q.order === organizations.id)).toBe(true);
    expect(params(orgPages[1]!)).toContain(orgs[99]!.id);
    expect(params(orgPages[2]!)).toContain(orgs[100]!.id);
    const invoicePages = mock.queries.filter(q => q.table === invoices && !q.locked);
    expect(invoicePages.every(q => q.limit === 250 && q.order === invoices.id)).toBe(true);
    const firstOrgPages = invoicePages.filter(q => params(q)[0] === orgs[0]!.id);
    expect(firstOrgPages).toHaveLength(3);
    expect(params(firstOrgPages[1]!)).toContain(rows[249]!.id);
    expect(params(firstOrgPages[2]!)).toContain(rows[250]!.id);
    expect(mock.enqueue.mock.calls.map(call => call[1].invoiceId).sort()).toEqual(rows.map(r => r.id).sort());
    expect(mock.queries.filter(q => q.locked)).toHaveLength(351);
  });
  it('excludes invoices with a reserving collection attempt in discovery and in the locked recheck', async () => {
    seedMock(); await runInvoiceReminderSweep(now);
    const dialect = new PgDialect();
    const candidates = mock.queries.filter(q => q.table === organizations || q.table === invoices);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const q of candidates) {
      const query = dialect.sqlToQuery(q.predicate as Parameters<PgDialect['sqlToQuery']>[0]);
      expect(query.sql).toContain('invoice_collection_attempts');
      expect(query.params).toEqual(expect.arrayContaining([...RESERVING_COLLECTION_ATTEMPT_STATES]));
    }
  });
  describe('stale reminder replacement', () => {
    const overdue = { ...invoice, dueDate: '2026-09-28' }; // every 7 days: 10-05 is overdue step 1
    function respond(today: { prior?: Record<string, unknown> | null; history: Record<string, unknown> }) {
      let orgReads = 0; let pageReads = 0;
      mock.respond = q => {
        if (q.table === organizations) return orgReads++ === 0 ? [org] : [];
        if (q.table === invoices) return q.locked ? [overdue] : pageReads++ === 0 ? [{ id: overdue.id }] : [];
        if (q.table === billingNoticeOutbox) {
          const params = new PgDialect().sqlToQuery(q.predicate as Parameters<PgDialect['sqlToQuery']>[0]).params;
          if (String(params[0]).startsWith('invoice:')) return today.prior ? [today.prior] : [];
          return [today.history];
        }
        return [];
      };
    }
    it('replaces a stale step on its own cadence day with a revision key', async () => {
      respond({ history: { seq: 0, atStep: 1 } });
      expect(await runInvoiceReminderSweep(new Date('2026-10-05T07:30:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
      expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        kind: 'payment_overdue', seq: 1, dedupeKey: `invoice:${overdue.id}:payment_overdue:1:r1` }));
    });
    it('replaces a stale step on the next off-cadence sweep with current values', async () => {
      respond({ prior: { status: 'cancelled', lastError: STALE_REMINDER_REASON }, history: { seq: 0, atStep: 1 } });
      expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
      expect(mock.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        kind: 'payment_overdue', seq: 1, dedupeKey: `invoice:${overdue.id}:payment_overdue:1:r1` }));
      expect(mock.render).toHaveBeenCalledWith('payment_overdue', expect.objectContaining({
        frozen: expect.objectContaining({ daysOverdue: 8 }) }));
      const lookup = mock.queries.find(q => q.table === billingNoticeOutbox)!;
      expect(new PgDialect().sqlToQuery(lookup.predicate as Parameters<PgDialect['sqlToQuery']>[0]).params)
        .toEqual([`invoice:${overdue.id}:payment_overdue:1`, org.id]);
    });
    it.each([
      ['no notice was allocated (missed tick)', null],
      ['the step was sent', { status: 'sent', lastError: null }],
      ['the step was cancelled for another reason', { status: 'cancelled', lastError: 'Payment in progress' }],
    ])('does not backfill an off-cadence step when %s', async (_label, prior) => {
      respond({ prior, history: { seq: 0, atStep: 1 } });
      expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
      expect(mock.enqueue).not.toHaveBeenCalled();
    });
    it('does not replace a stale step that a later revision already covers', async () => {
      respond({ prior: { status: 'cancelled', lastError: STALE_REMINDER_REASON }, history: { seq: 1, atStep: 2 } });
      expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
      expect(mock.enqueue).not.toHaveBeenCalled();
    });
  });
});
