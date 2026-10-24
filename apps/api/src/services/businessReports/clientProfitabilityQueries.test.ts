import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  hoursQuery,
  invoiceDetailQuery,
  invoiceLineFoldQuery,
  localPeriodDates,
} from './clientProfitabilityQueries';
import { effectiveCoverageSql } from './common';
import { resolveReportPeriod } from './period';
import { sql } from 'drizzle-orm';

/**
 * #9828 W3 Task 3.1 — the client-profitability statements, compiled with the
 * real Postgres dialect so assertions read the real SQL text and the real
 * bound parameters. Behaviour against real rows is proven by
 * __tests__/integration/clientProfitabilityQueries.integration.test.ts (the SQL
 * fold equals the TypeScript reference fold); these pin the contract clauses
 * and the tenancy predicates one by one.
 */

const PARTNER = '44444444-4444-4444-8444-444444444444';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);
const flat = (s: string) => s.replace(/\s+/g, ' ');

const partnerScope = { kind: 'partner' as const, partnerId: PARTNER, orgIds: [ORG_A, ORG_B] };
const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const AUGUST = { periodStartDate: '2026-08-01', periodEndDate: '2026-09-01' };

const fold = (scope: typeof partnerScope | typeof orgScope = partnerScope) => {
  const c = compile(invoiceLineFoldQuery({ scope, ...AUGUST }));
  return { sql: flat(c.sql), params: c.params };
};

describe('invoiceLineFoldQuery', () => {
  it('top-level only — bundle cost counted once (T1)', () => {
    const { sql: s } = fold();
    expect(s).toContain('il.parent_line_id IS NULL');
    expect(s).toContain('il.customer_visible');
  });

  it('NULL cost is unknown, not zero: cost sums only known lines; nothing COALESCEs cost_basis to 0 (T2)', () => {
    const { sql: s } = fold();
    expect(s).not.toMatch(/COALESCE\(\s*il\.cost_basis/);
    expect(s).toMatch(/il\.cost_basis IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM invoice_lines c WHERE c\.parent_line_id = il\.id AND c\.invoice_id = il\.invoice_id AND c\.org_id = il\.org_id AND c\.cost_basis IS NULL\)/);
    expect(s).toMatch(/SUM\(ROUND\(l\.quantity \* l\.cost_basis, .+?\)\) FILTER \(WHERE l\.known_cost\)/);
    expect(s).toMatch(/COALESCE\(SUM\(l\.line_total\) FILTER \(WHERE l\.known_cost\), 0\)::text AS cost_bearing_revenue/);
    expect(s).toMatch(/\(SUM\(l\.line_total\) - COALESCE\(SUM\(l\.line_total\) FILTER \(WHERE l\.known_cost\), 0\)\)::text AS unknown_cost_revenue/);
    expect(s).toContain('COUNT(*) FILTER (WHERE NOT l.known_cost)::int AS lines_missing_cost');
  });

  it('partial-cost bundle counted unknown and tallied (T10)', () => {
    const { sql: s } = fold();
    expect(s).toMatch(/il\.cost_basis IS NOT NULL AND EXISTS \(SELECT 1 FROM invoice_lines c WHERE c\.parent_line_id = il\.id .*?c\.cost_basis IS NULL\)\) AS partial_bundle/);
    expect(s).toContain('COUNT(*) FILTER (WHERE l.partial_bundle)::int AS partial_cost_bundles');
  });

  it('block-overage contract line is labor, not recurring: its arm comes first in the CASE', () => {
    const { sql: s } = fold();
    expect(s).toMatch(/^\/\* profitability:fold \*\/ WITH RECURSIVE block_overage_chain/);
    const overage = s.indexOf("WHEN il.source_type = 'contract' AND il.id IN (SELECT line_id FROM block_overage_lines) THEN 'labor'");
    const recurring = s.indexOf("WHEN il.source_type = 'contract' THEN 'recurring'");
    expect(overage).toBeGreaterThan(0);
    expect(recurring).toBeGreaterThan(overage);
    expect(s).toContain("WHEN il.source_type = 'time_entry' THEN 'labor'");
    expect(s).toContain("WHEN il.source_type = 'ai_usage' THEN 'ai'");
    expect(s).toContain("ELSE 'other' END AS category");
  });

  it('quote-accepted manual line with catalog_item_id is product', () => {
    const { sql: s } = fold();
    expect(s).toContain("WHEN il.source_type IN ('part', 'catalog', 'bundle') OR (il.source_type = 'manual' AND il.catalog_item_id IS NOT NULL) THEN 'product'");
  });

  it('JPY cost rounds per line at 0 dp: the ROUND scale is the invoice currency\'s minor unit', () => {
    const { sql: s, params } = fold();
    expect(s).toMatch(/ROUND\(l\.quantity \* l\.cost_basis, CASE WHEN l\.currency_code IN \((\$\d+, )*\$\d+\) THEN 0 ELSE 2 END\)/);
    expect(params).toContain('JPY');
  });

  it('draft and void invoices excluded; the period binds LOCAL dates against issue_date (T7)', () => {
    const { sql: s, params } = fold();
    expect(s).toContain("i.status IN ('sent', 'partially_paid', 'overdue', 'paid')");
    expect(s).toMatch(/i\.issue_date >= \$\d+::date AND i\.issue_date < \$\d+::date/);
    expect(params).toEqual(expect.arrayContaining(['2026-08-01', '2026-09-01']));
  });

  it('partner scope: explicit org allowlist AND partner_id, in the block-overage invoice set too', () => {
    const { sql: s, params } = fold();
    const predicate = /i\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\) AND i\.partner_id = \$\d+/g;
    // Twice inside blockOverageLineIdsCte (it reads its invoiceIds sub-SELECT in
    // the chain anchor and in the candidates), once on the lines themselves.
    expect(s.match(predicate)).toHaveLength(3);
    expect(params).toContain(PARTNER);
    expect(params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
  });

  it('org scope: the one org, and the org\'s own partner (never a bound partner id)', () => {
    const { sql: s, params } = fold(orgScope);
    const predicate = /i\.org_id = \$\d+ AND i\.partner_id = \(SELECT o\.partner_id FROM organizations o WHERE o\.id = \$\d+\)/g;
    expect(s.match(predicate)).toHaveLength(3);
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(PARTNER);
  });

  it('groups per (org, currency, category)', () => {
    expect(fold().sql).toMatch(/GROUP BY l\.org_id, l\.currency_code, l\.category ORDER BY 1, 2, 3$/);
  });
});

describe('invoiceDetailQuery (org scope: one row per invoice)', () => {
  const c = compile(invoiceDetailQuery({ orgId: ORG_A, ...AUGUST, limit: 5001 }));
  const s = flat(c.sql);

  it('reads the same scoped line set as the fold and caps the rows', () => {
    expect(s).toContain('il.parent_line_id IS NULL');
    expect(s.match(/i\.org_id = \$\d+ AND i\.partner_id = \(SELECT o\.partner_id FROM organizations o WHERE o\.id = \$\d+\)/g)).toHaveLength(3);
    expect(s).toMatch(/GROUP BY l\.invoice_id, l\.invoice_number, l\.issue_date, l\.currency_code/);
    expect(s).toMatch(/COUNT\(\*\) OVER \(\)::int AS available/);
    expect(s).toMatch(/LIMIT \$\d+$/);
    expect(c.params[c.params.length - 1]).toBe(5001);
  });

  it('splits revenue by category per invoice', () => {
    for (const cat of ['recurring', 'labor', 'product', 'ai', 'other']) {
      expect(s).toContain(`COALESCE(SUM(l.line_total) FILTER (WHERE l.category = '${cat}'), 0)::text AS ${cat}_revenue`);
    }
  });
});

describe('hoursQuery', () => {
  const start = new Date('2026-08-01T04:00:00.000Z');
  const end = new Date('2026-09-01T04:00:00.000Z');

  it('running timers excluded; started_at binds INSTANTS; minutes split by effective coverage', () => {
    const c = compile(hoursQuery({ scope: partnerScope, periodStart: start, periodEnd: end }));
    const s = flat(c.sql);
    expect(s).toContain('te.ended_at IS NOT NULL');
    expect(s).toMatch(/te\.started_at >= \$\d+ AND te\.started_at < \$\d+/);
    expect(c.params).toEqual(expect.arrayContaining(['2026-08-01T04:00:00.000Z', '2026-09-01T04:00:00.000Z']));
    const coverage = flat(dialect.sqlToQuery(effectiveCoverageSql(sql`te`)).sql);
    expect(s).toContain(`COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'billable'), 0)::int AS billable_minutes`);
    expect(s).toContain(`COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'included'), 0)::int AS included_minutes`);
    expect(s).toContain(`COALESCE(SUM(te.duration_minutes) FILTER (WHERE ${coverage} = 'non_billable'), 0)::int AS non_billable_minutes`);
    expect(s).toMatch(/GROUP BY te\.org_id, te\.currency_code/);
  });

  it('partner scope adds the org_id IS NULL hours row, inside the partner axis', () => {
    const c = compile(hoursQuery({ scope: partnerScope, periodStart: start, periodEnd: end }));
    expect(flat(c.sql)).toMatch(/te\.partner_id = \$\d+ AND \(te\.org_id IS NULL OR te\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)\)/);
    expect(c.params).toContain(PARTNER);
  });

  it('org scope reads the one org only, never org-less time', () => {
    const c = compile(hoursQuery({ scope: orgScope, periodStart: start, periodEnd: end }));
    const s = flat(c.sql);
    expect(s).toMatch(/te\.org_id = \$\d+ AND te\.partner_id = \(SELECT o\.partner_id FROM organizations o WHERE o\.id = \$\d+\)/);
    expect(s).not.toContain('te.org_id IS NULL');
  });
});

describe('effectiveCoverageSql', () => {
  it('is coverage, falling back to the billable flag (the R2 rule)', () => {
    expect(dialect.sqlToQuery(effectiveCoverageSql(sql`te`)).sql)
      .toBe("COALESCE(te.coverage, CASE WHEN te.is_billable THEN 'billable' ELSE 'non_billable' END)");
  });
});

describe('localPeriodDates', () => {
  it('owner-timezone period bounds bind local dates for issue_date (Review Focus 5)', () => {
    // August 2026 in New York: [2026-08-01T04:00Z, 2026-09-01T04:00Z).
    const period = resolveReportPeriod({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }, 'America/New_York', new Date('2026-09-10T00:00:00Z'));
    expect(period.start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(localPeriodDates(period)).toEqual({ startDate: '2026-08-01', endDate: '2026-09-01' });
  });

  it('east of UTC: the local date, not the UTC date of the instant', () => {
    const period = resolveReportPeriod({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }, 'Pacific/Auckland', new Date('2026-09-10T00:00:00Z'));
    expect(period.start.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect(localPeriodDates(period)).toEqual({ startDate: '2026-08-01', endDate: '2026-09-01' });
  });
});
