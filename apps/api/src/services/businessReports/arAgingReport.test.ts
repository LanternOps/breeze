import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Same harness as ticketSlaReport.test.ts: the DB mock models which context
 * each statement ran in; `runInReportScope` is real. Statements are routed by
 * the `/* ar:<name> *\/` marker each one carries, so a test states the rows
 * each statement returns without depending on statement order.
 */
const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  systemOpens: 0,
  timeZone: 'UTC',
}));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
    ctx.systemOpens += 1;
    const previous = ctx.current;
    ctx.current = { scope: 'system' };
    try {
      return await fn();
    } finally {
      ctx.current = previous;
    }
  },
}));
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => ctx.timeZone),
  resolvePartnerTimezone: vi.fn(async () => ctx.timeZone),
}));

import type { ArAgingSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { reportTypeDef } from '../reportRegistry';
import { SITE_RESTRICTED_NOTE } from './common';
import { generateArAgingReport } from './arAgingReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();
type Call = { name: string; sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];
type Rows = Partial<Record<'org_name' | 'grouped' | 'by_currency' | 'other_open' | 'detail' | 'paid_in_period', unknown[]>>;

function respond(rows: Rows = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    const name = /\/\* ar:(\w+) \*\//.exec(compiled.sql)?.[1] ?? 'unknown';
    calls.push({ name, sql: compiled.sql, params: compiled.params, contextScope: ctx.current?.scope });
    return (rows as Record<string, unknown[] | undefined>)[name] ?? [];
  }) as never);
}
const call = (name: string) => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`statement ${name} was not run; ran ${calls.map((c) => c.name).join(', ')}`);
  return found;
};

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };

function moneyRow(key: string, label: string, currency: string, over: Partial<Record<string, string>> = {}, count = 1) {
  return {
    group_key: key, group_label: label, currency_code: currency,
    current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90_plus: '0.00', no_due_date: '0.00',
    open_total: '0.00', invoice_count: count, ...over,
  };
}
function detailRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `inv-${i}`, invoice_number: `INV-${i}`, org_id: ORG_A, org_name: 'Acme', currency_code: 'USD',
    status: 'overdue', issue_date: '2026-07-01', due_date: '2026-07-31', total: '100.00',
    amount_paid: '0.00', balance: '100.00', days_overdue: 52, bucket: 'd31_60', last_payment_at: null,
    ...over,
  };
}

const summaryOf = (r: { summary?: unknown }) => r.summary as ArAgingSummary;

describe('generateArAgingReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
    ctx.timeZone = 'UTC';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buckets on date - date with the documented boundaries (0 current; 1-30; 31-60; 61-90; 91+)', async () => {
    respond();
    await generateArAgingReport(orgScope, { asOf: '2026-09-21' }, orgAuthority);
    const text = call('grouped').sql;
    const asOfParam = call('grouped').params.indexOf('2026-09-21') + 1;
    expect(asOfParam).toBeGreaterThan(0);
    expect(text).toContain(`ELSE ($${asOfParam}::date - i.due_date)::int END AS days_overdue`);
    expect(text).toContain("WHEN s.due_date IS NULL THEN 'no_due_date'");
    expect(text).toContain("WHEN s.days_overdue <= 0 THEN 'current'");
    expect(text).toContain("WHEN s.days_overdue BETWEEN 1 AND 30 THEN 'd1_30'");
    expect(text).toContain("WHEN s.days_overdue BETWEEN 31 AND 60 THEN 'd31_60'");
    expect(text).toContain("WHEN s.days_overdue BETWEEN 61 AND 90 THEN 'd61_90'");
    expect(text).toContain("ELSE 'd90_plus'");
    // The NULL-due-date arm is FIRST, so a NULL due date can never fall to current.
    expect(text.indexOf("'no_due_date'")).toBeLessThan(text.indexOf("'current'"));
  });

  it('uses the AR-open set (INCLUDING overdue) for the buckets, and requires balance > 0', async () => {
    respond();
    await generateArAgingReport(orgScope, {}, orgAuthority);
    for (const name of ['grouped', 'by_currency', 'detail']) {
      expect(call(name).sql).toContain("s.status IN ('sent','partially_paid','overdue')");
      expect(call(name).sql).toContain('i.balance > 0');
    }
    expect(call('other_open').sql).toContain("NOT (s.status IN ('sent','partially_paid','overdue'))");
    expect(call('other_open').sql).toContain('i.balance > 0');
  });

  it('carries money as numeric strings per currency and never combines currencies', async () => {
    respond({
      grouped: [moneyRow(ORG_A, 'Acme', 'EUR', { current: '50.00', open_total: '50.00' }),
        moneyRow(ORG_A, 'Acme', 'USD', { d1_30: '120.50', open_total: '120.50' })],
      by_currency: [moneyRow('EUR', 'EUR', 'EUR', { current: '50.00', open_total: '50.00' }),
        moneyRow('USD', 'USD', 'USD', { d1_30: '120.50', open_total: '120.50' })],
    });
    const s = summaryOf(await generateArAgingReport(partnerScope(), {}, partnerAuthority));
    expect(s.byCurrency.map((r) => [r.currencyCode, r.openTotal])).toEqual([['EUR', '50.00'], ['USD', '120.50']]);
    expect(s.byCurrency[1]!.buckets).toEqual({
      current: '0.00', d1_30: '120.50', d31_60: '0.00', d61_90: '0.00', d90_plus: '0.00', no_due_date: '0.00',
    });
    expect(typeof s.groups[0]!.buckets.current).toBe('string');
    expect(s.groups).toHaveLength(2);
    // No combined total anywhere: every money-bearing object carries a currency.
    expect(Object.keys(s)).not.toContain('total');
    expect(Object.keys(s)).not.toContain('openTotal');
    expect(call('by_currency').sql).toMatch(/GROUP BY b\.currency_code/);
    expect(call('by_currency').sql).toContain('::numeric(14,2)');
  });

  it('lists out-of-set open balances on the reconciliation line and discloses them', async () => {
    respond({
      by_currency: [moneyRow('USD', 'USD', 'USD', { current: '100.00', open_total: '100.00' })],
      other_open: [{ currency_code: 'USD', amount: '40.00' }],
    });
    const s = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(s.otherOpenBalance).toEqual([{ currencyCode: 'USD', amount: '40.00' }]);
    expect(s.notes.join(' ')).toMatch(/outside the AR-open set \(draft, paid or void\)/);
  });

  it('omits the reconciliation note when there is no out-of-set open balance', async () => {
    respond();
    const s = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(s.otherOpenBalance).toEqual([]);
    expect(s.notes.join(' ')).not.toMatch(/outside the AR-open set/);
  });

  it('as-of defaults to TODAY in the owner timezone: the date line decides the bound date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T12:30:00Z')); // 00:30 on the 22nd in Auckland, 02:30 on the 21st in Honolulu

    ctx.timeZone = 'Pacific/Auckland';
    respond();
    const nz = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(nz.asOf).toBe('2026-09-22');
    expect(nz.timeZone).toBe('Pacific/Auckland');
    expect(call('grouped').params).toContain('2026-09-22');

    calls.length = 0;
    ctx.timeZone = 'Pacific/Honolulu';
    respond();
    const hi = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(hi.asOf).toBe('2026-09-21');
    expect(call('grouped').params).toContain('2026-09-21');
    expect(hi.notes).toContain('As of 2026-09-21 in Pacific/Honolulu.');
  });

  it('an unusable owner timezone ages in UTC and says so (logged, noted)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.timeZone = 'Mars/Olympus';
    respond();
    const s = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(s.timeZone).toBe('UTC');
    expect(s.notes.join(' ')).toMatch(/Mars\/Olympus.*UTC/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an explicit asOf wins over the clock and is disclosed as current-balance aging', async () => {
    respond();
    const s = summaryOf(await generateArAgingReport(orgScope, { asOf: '2026-08-31' }, orgAuthority));
    expect(s.asOf).toBe('2026-08-31');
    expect(call('detail').params).toContain('2026-08-31');
    expect(s.notes.join(' ')).toMatch(/current balance; the as-of date moves only the aging reference date/);
  });

  it('aggregates over ALL matching invoices; only the detail rows are capped at 5000', async () => {
    respond({
      by_currency: [moneyRow('USD', 'USD', 'USD', { d31_60: '600000.00', open_total: '600000.00' }, 6000)],
      detail: Array.from({ length: 5001 }, (_, i) => detailRow(i)),
    });
    const result = await generateArAgingReport(orgScope, {}, orgAuthority);
    const s = summaryOf(result);
    expect(call('detail').params).toContain(5001);
    expect(call('by_currency').sql).not.toContain('LIMIT');
    expect(result.rows).toHaveLength(5000);
    expect(result.rowCount).toBe(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 6000, truncated: true });
    expect(s.byCurrency[0]!.openTotal).toBe('600000.00');
    expect(s.byCurrency[0]!.invoiceCount).toBe(6000);
  });

  it('lastPaymentAt is MAX(invoice_payments.received_at) as a YYYY-MM-DD date, null when unpaid', async () => {
    respond({
      detail: [detailRow(1, { last_payment_at: '2026-09-02' }), detailRow(2)],
    });
    const s = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    expect(call('detail').sql).toContain('MAX(p.received_at)::text AS last_payment_at');
    expect(call('detail').sql).toContain('WHERE p.invoice_id = b.id');
    expect(s.rows.map((r) => r.lastPaymentAt)).toEqual(['2026-09-02', null]);
    expect(s.rows[0]).toEqual({
      invoiceId: 'inv-1', invoiceNumber: 'INV-1', orgId: ORG_A, orgName: 'Acme', currencyCode: 'USD',
      status: 'overdue', issueDate: '2026-07-01', dueDate: '2026-07-31', total: '100.00', amountPaid: '0.00',
      balance: '100.00', daysOverdue: 52, bucket: 'd31_60', lastPaymentAt: '2026-09-02',
    });
  });

  it('detail rows are ordered oldest-debt first, deterministically', async () => {
    respond();
    await generateArAgingReport(orgScope, {}, orgAuthority);
    expect(call('detail').sql).toContain('ORDER BY b.days_overdue DESC NULLS FIRST, b.balance DESC, b.id');
  });

  it('partner scope binds the partner id AND the org allowlist in every invoice statement', async () => {
    respond();
    await generateArAgingReport(partnerScope(), { includePaidInPeriod: true }, partnerAuthority);
    expect(calls.map((c) => c.name).sort()).toEqual(['by_currency', 'detail', 'grouped', 'other_open', 'paid_in_period']);
    for (const c of calls) {
      expect(c.sql).toMatch(/i\.partner_id = \$\d+ AND i\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)/);
      expect(c.params).toEqual(expect.arrayContaining([PARTNER, ORG_A, ORG_B]));
    }
  });

  it('org scope binds the single org id — no ARRAY, never a partner id', async () => {
    respond({ org_name: [{ name: 'Acme' }] });
    const s = summaryOf(await generateArAgingReport(orgScope, {}, orgAuthority));
    for (const c of calls.filter((x) => x.name !== 'org_name')) {
      expect(c.sql).toMatch(/i\.org_id = \$\d+/);
      expect(c.sql).not.toContain('ANY(');
      expect(c.params).toContain(ORG_A);
      expect(c.params).not.toContain(PARTNER);
    }
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
  });

  it('groupBy: organization (default) keys on org and labels with the org name; currency keys on currency', async () => {
    respond();
    const byOrg = summaryOf(await generateArAgingReport(partnerScope(), {}, partnerAuthority));
    expect(byOrg.groupBy).toBe('organization');
    expect(call('grouped').sql).toContain("b.org_id::text AS group_key, COALESCE(org.name, 'Unknown organization') AS group_label");

    calls.length = 0;
    respond();
    const byCur = summaryOf(await generateArAgingReport(partnerScope(), { groupBy: 'currency' }, partnerAuthority));
    expect(byCur.groupBy).toBe('currency');
    expect(call('grouped').sql).toContain('b.currency_code::text AS group_key, b.currency_code::text AS group_label');
  });

  it('includePaidInPeriod adds a notes-only collected line for month-to-date; it never adds a bucket statement', async () => {
    respond({ paid_in_period: [{ currency_code: 'USD', invoice_count: 3, amount: '900.00' }] });
    const s = summaryOf(await generateArAgingReport(orgScope, { asOf: '2026-09-21', includePaidInPeriod: true }, orgAuthority));
    const paid = call('paid_in_period');
    expect(paid.sql).toContain("i.status = 'paid'");
    expect(paid.sql).toMatch(/i\.paid_at >= \$\d+ AND i\.paid_at < \$\d+/);
    expect(paid.params).toEqual(expect.arrayContaining(['2026-09-01T00:00:00.000Z', '2026-09-22T00:00:00.000Z']));
    expect(s.notes.join(' ')).toMatch(/2026-09-01 to 2026-09-21.*3 invoices.*900\.00 USD/);
    const paidNote = s.notes.find((n) => n.includes('900.00 USD'))!;
    expect(paidNote.startsWith('Invoices fully paid month-to-date')).toBe(true);
    expect(paidNote).toMatch(/invoice totals/);
    expect(paidNote).not.toMatch(/Collected/);

    calls.length = 0;
    respond();
    await generateArAgingReport(orgScope, { asOf: '2026-09-21' }, orgAuthority);
    expect(calls.map((c) => c.name)).not.toContain('paid_in_period');
  });

  it('prints the mandatory notes', async () => {
    respond();
    const s = summaryOf(await generateArAgingReport(orgScope, { asOf: '2026-09-21' }, orgAuthority));
    expect(s.notes).toContain('As of 2026-09-21 in UTC.');
    expect(s.notes).toContain('Invoices with no due date are reported in their own bucket and are never counted as current.');
    expect(s.notes).toContain('Totals are reported per currency; no FX conversion is applied.');
    expect(s.notes.join(' ')).not.toMatch(/suspended/i);
  });

  it('discloses the partner org-list filter at partner scope', async () => {
    respond();
    const s = summaryOf(await generateArAgingReport(partnerScope(), {}, partnerAuthority));
    expect(s.notes.join(' ')).toMatch(/suspended.*archived.*excluded/i);
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 2 });
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    respond();
    await generateArAgingReport(partnerScope(), {}, partnerAuthority);
    expect(ctx.systemOpens).toBe(1);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['system']));
  });

  it('runs IN an ambient partner context that can see the partner, opening no second context', async () => {
    ctx.current = { scope: 'partner', accessiblePartnerIds: [PARTNER], accessibleOrgIds: [ORG_A, ORG_B] };
    respond();
    await generateArAgingReport(partnerScope(), {}, partnerAuthority);
    expect(ctx.systemOpens).toBe(0);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['partner']));
  });

  it('refuses an ambient org context that cannot see the org, before any query', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    respond();
    await expect(generateArAgingReport(orgScope, {}, orgAuthority)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a partner with no active organizations short-circuits without an invoice query (P5)', async () => {
    respond();
    const result = await generateArAgingReport(partnerScope([]), {}, partnerAuthority);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(s.byCurrency).toEqual([]);
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations/i);
  });

  it('a site-restricted authority (with sites) queries NOTHING — invoices have no site axis (T7a)', async () => {
    respond({ by_currency: [moneyRow('USD', 'USD', 'USD', { current: '1.00', open_total: '1.00' })] });
    const restricted: ReportGenerationAuthority = {
      principalKind: 'user', principalUserId: USER,
      scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
      capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'b'.repeat(64),
    };
    const result = await generateArAgingReport(orgScope, {}, restricted);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    expect(result.rows).toEqual([]);
    expect(s.byCurrency).toEqual([]);
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    // Same cap as the P5 no-orgs branch and a real run: the registry's.
    expect(s.detail).toEqual({ cap: reportTypeDef('ar_aging').detailRowCap, stored: 0, available: 0, truncated: false });
    expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ['unknown groupBy', { groupBy: 'site' }],
    ['a timestamp asOf', { asOf: '2026-09-21T00:00:00Z' }],
    ['an impossible date', { asOf: '2026-02-30' }],
  ])('rejects %s before any query', async (_label, config) => {
    respond();
    await expect(generateArAgingReport(orgScope, config, orgAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
