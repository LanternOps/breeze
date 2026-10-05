import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

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

import type { AiUsageByClientSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { reportTypeDef } from '../reportRegistry';
import { SITE_RESTRICTED_NOTE } from './common';
import { generateAiUsageByClientReport } from './aiUsageByClientReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();
type Call = { name: string; sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];
type Rows = Partial<Record<'org_name' | 'overall' | 'grouped' | 'grouped_money' | 'by_currency' | 'detail' | 'detail_count', unknown[]>>;

function respond(rows: Rows = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    const name = /\/\* ai:(\w+) \*\//.exec(compiled.sql)?.[1] ?? 'unknown';
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
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const AUGUST = { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } };

function totalsRow(over: Record<string, unknown> = {}) {
  return {
    requests: 4, input_tokens: '4000', output_tokens: '800', cache_read_tokens: '40', cache_write_tokens: '20',
    cost_usd: '15.90', included_cost_usd: '5.00', unpriced_requests: 1, ...over,
  };
}
const groupedRow = (key: string, label: string, over: Record<string, unknown> = {}) =>
  ({ group_key: key, group_label: label, ...totalsRow(over) });
const moneyRow = (key: string | null, currency: string, amount: string, billed: string, unbilled: string) =>
  ({ group_key: key, currency_code: currency, amount, billed, unbilled });

const summaryOf = (r: { summary?: unknown }) => r.summary as AiUsageByClientSummary;

describe('generateAiUsageByClientReport', () => {
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

  it('reads only AUTHORITATIVE ledger rows, in every statement', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    for (const name of ['overall', 'grouped', 'grouped_money', 'by_currency', 'detail']) {
      expect(call(name).sql, name).toContain("i.ledger_mode = 'authoritative'");
    }
  });

  it('binds the period window [start, end) on ai_invocations.created_at in the owner timezone', async () => {
    ctx.timeZone = 'America/Chicago';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    const grouped = call('grouped');
    expect(grouped.sql).toMatch(/i\.created_at >= \$\d+ AND i\.created_at < \$\d+/);
    // Aug 1 00:00 and Sep 1 00:00 in CDT (UTC-5).
    expect(grouped.params).toEqual(expect.arrayContaining(['2026-08-01T05:00:00.000Z', '2026-09-01T05:00:00.000Z']));
    expect(s.period).toMatchObject({ kind: 'custom', timeZone: 'America/Chicago', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z' });
  });

  it('prints the UTC-month caveat naming the owner timezone, and the per-currency / Breeze-cost notes', async () => {
    ctx.timeZone = 'America/Chicago';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes).toContain(
      'Charges bill by UTC calendar month of the ledger write; this report\'s period is in America/Chicago so month-edge rows can differ from the invoice.',
    );
    expect(s.notes.join(' ')).toMatch(/no FX conversion is applied/);
    expect(s.notes.join(' ')).toMatch(/Breeze cost.*not the amount charged/i);
  });

  it('says unbilled also holds amounts that will never be invoiced (rounded to zero, older than the lookback)', async () => {
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    const billed = s.notes.find((n) => n.startsWith('Billed means'));
    expect(billed).toMatch(/Unbilled covers charges not yet invoiced and usage not yet aggregated into a charge/);
    expect(billed).toMatch(/rounded to zero/);
    expect(billed).toMatch(/older than the 92-day billing lookback/);
    expect(billed).toMatch(/will not be invoiced/);
  });

  it('an unusable owner timezone resolves in UTC and says so (logged, noted)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.timeZone = 'Mars/Olympus';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.period.timeZone).toBe('UTC');
    expect(s.notes.join(' ')).toMatch(/Mars\/Olympus.*UTC/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('chargeable money is summed exactly in SQL (::text) and rounded ONCE in TypeScript per currency', async () => {
    respond({
      grouped_money: [
        moneyRow(ORG_A, 'USD', '15.445678', '12.345678', '3.100000'),
        moneyRow(ORG_B, 'EUR', '20.005000', '0.000000', '20.005000'),
        moneyRow(ORG_B, 'JPY', '1234.567800', '0.000000', '1234.567800'),
      ],
      by_currency: [
        moneyRow(null, 'EUR', '20.005000', '0.000000', '20.005000'),
        moneyRow(null, 'JPY', '1234.567800', '0.000000', '1234.567800'),
        moneyRow(null, 'USD', '15.445678', '12.345678', '3.100000'),
      ],
      grouped: [groupedRow(ORG_A, 'Acme'), groupedRow(ORG_B, 'Globex')],
    });
    const s = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.overall.charges).toEqual([
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'JPY', amount: '1235.00', billed: '0.00', unbilled: '1235.00' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    expect(s.groups.find((g) => g.groupKey === ORG_A)!.charges).toEqual([
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    // Never a combined, currency-less money figure.
    expect(Object.keys(s.overall)).not.toContain('amount');
    expect(call('by_currency').sql).toContain('::text');
    expect(call('by_currency').sql).not.toMatch(/ROUND\(/i);
  });

  it('chargeable = billable coverage AND chargeable AND a stamped amount; billed/unbilled come from the claim join', async () => {
    respond();
    await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority);
    const money = call('grouped_money').sql;
    expect(money).toContain("b.chargeable AND b.charge_coverage = 'billable'");
    expect(money).toContain('b.charge_amount IS NOT NULL');
    expect(money).toContain("b.billing_status = 'billed'");
    expect(money).toContain("b.billing_status IS DISTINCT FROM 'billed'");
    const base = call('overall').sql;
    expect(base).toContain('LEFT JOIN ai_usage_charge_claims cl ON cl.invocation_id = i.id');
    expect(base).toContain('LEFT JOIN ai_usage_charges ch ON ch.id = cl.charge_id AND ch.org_id = i.org_id');
  });

  it('Breeze cost is SUM(cost_cents)/100 as numeric(14,2) text; included cost filters on coverage', async () => {
    respond({ overall: [totalsRow({ requests: 6, cost_usd: '31.90' })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(call('overall').sql).toContain('(COALESCE(SUM(b.cost_cents), 0) / 100)::numeric(14,2)::text AS cost_usd');
    expect(call('overall').sql).toContain("FILTER (WHERE b.charge_coverage = 'included')");
    expect(s.overall).toMatchObject({
      requests: 6, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
      costUsd: '31.90', includedCostUsd: '5.00', unpricedRequests: 1,
    });
    expect(typeof s.overall.inputTokens).toBe('number');
  });

  it('counts unpriced requests and discloses them in the notes, never as free', async () => {
    respond({ overall: [totalsRow({ unpriced_requests: 3 })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(call('overall').sql).toContain("b.chargeable AND b.charge_basis = 'unpriced'");
    expect(s.notes.join(' ')).toMatch(/3 requests.*no rate.*counted as unpriced/i);
  });

  it('omits the unpriced note when nothing was unpriced', async () => {
    respond({ overall: [totalsRow({ unpriced_requests: 0 })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes.join(' ')).not.toMatch(/counted as unpriced/i);
  });

  it('partner scope binds ONLY the org allowlist (never the partner id) in every statement', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(calls.map((c) => c.name).sort()).toEqual(['by_currency', 'detail', 'grouped', 'grouped_money', 'overall']);
    for (const c of calls) {
      expect(c.sql).toMatch(/i\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)/);
      expect(c.params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
      expect(c.params).not.toContain(PARTNER);
    }
  });

  it('org scope binds the single org id: no ARRAY, no ANY', async () => {
    respond({ org_name: [{ name: 'Acme' }] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    for (const c of calls.filter((x) => x.name !== 'org_name')) {
      expect(c.sql).toMatch(/i\.org_id = \$\d+/);
      expect(c.sql).not.toContain('ANY(');
      expect(c.params).toContain(ORG_A);
    }
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
  });

  it('groupBy defaults by scope (organization at partner scope, model at org scope) and an explicit value wins', async () => {
    respond();
    const partnerDefault = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(partnerDefault.groupBy).toBe('organization');
    expect(call('grouped').sql).toContain("b.org_id::text AS group_key, COALESCE(org.name, 'Unknown organization') AS group_label");

    calls.length = 0;
    respond();
    const orgDefault = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(orgDefault.groupBy).toBe('model');
    expect(call('grouped').sql).toContain('b.served_model AS group_key, b.served_model AS group_label');

    calls.length = 0;
    respond();
    const forced = summaryOf(await generateAiUsageByClientReport(orgScope, { ...AUGUST, groupBy: 'organization' }, orgAuthority));
    expect(forced.groupBy).toBe('organization');
  });

  it('detail rows are org x model x charge currency, capped at the registry cap; aggregates are never capped', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => ({
      org_id: ORG_A, org_name: 'Acme', model: `model-${i}`, currency_code: 'USD',
      ...totalsRow({ requests: 1 }), amount: '1.234500', billed: null, unbilled: '1.234500',
    }));
    respond({ detail, detail_count: [{ n: 6000 }], overall: [totalsRow({ requests: 6000 })] });
    const result = await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority);
    const s = summaryOf(result);
    expect(reportTypeDef('ai_usage_by_client').detailRowCap).toBe(5000);
    expect(call('detail').params).toContain(5001);
    expect(call('overall').sql).not.toContain('LIMIT');
    expect(result.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 6000, truncated: true });
    expect(call('detail').sql).toContain('GROUP BY b.org_id, org.name, b.served_model, b.charge_currency');
    // billed is NULL in SQL when no row of the group was billed; a priced row reports 0.00, not null.
    expect(s.rows[0]).toMatchObject({ currencyCode: 'USD', amount: '1.23', billed: '0.00', unbilled: '1.23' });
  });

  it('a detail row with no chargeable amount carries null money, not zero', async () => {
    respond({
      detail: [{
        org_id: ORG_B, org_name: 'Globex', model: 'model-beta', currency_code: null,
        ...totalsRow({ requests: 2 }), amount: null, billed: null, unbilled: null,
      }],
    });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.rows[0]).toMatchObject({ currencyCode: null, amount: null, billed: null, unbilled: null });
    expect(s.detail).toMatchObject({ stored: 1, available: 1, truncated: false });
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(ctx.systemOpens).toBe(1);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['system']));
  });

  it('runs IN an ambient partner context that can see the partner, opening no second context', async () => {
    ctx.current = { scope: 'partner', accessiblePartnerIds: [PARTNER], accessibleOrgIds: [ORG_A, ORG_B] };
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(ctx.systemOpens).toBe(0);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['partner']));
  });

  it('refuses an ambient org context that cannot see the org, before any query', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    respond();
    await expect(generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a partner with no active organizations short-circuits without an invocation query', async () => {
    respond();
    const result = await generateAiUsageByClientReport(partnerScope([]), AUGUST, partnerAuthority);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations/i);
    expect(s.detail.cap).toBe(5000);
  });

  it('discloses the partner org-list filter at partner scope', async () => {
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.notes.join(' ')).toMatch(/suspended.*archived.*excluded/i);
  });

  it('a site-restricted authority queries NOTHING (AI invocations have no site axis)', async () => {
    respond({ overall: [totalsRow()] });
    const restricted: ReportGenerationAuthority = {
      principalKind: 'user', principalUserId: USER,
      scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
      capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'b'.repeat(64),
    };
    const result = await generateAiUsageByClientReport(orgScope, {}, restricted);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    expect(result.rows).toEqual([]);
    expect(s.overall.requests).toBe(0);
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(s.detail).toEqual({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it.each([
    ['unknown groupBy', { groupBy: 'site' }],
    ['an impossible custom period', { period: { kind: 'custom', start: '2026-02-30', end: '2026-03-01' } }],
    ['a refused org selector', { orgIds: ['11111111-1111-4111-8111-111111111111'] }],
    ['a refused date range', { dateRange: { preset: 'last_30_days' } }],
  ])('rejects %s before any query', async (_label, config) => {
    respond();
    await expect(generateAiUsageByClientReport(orgScope, config as Record<string, unknown>, orgAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
