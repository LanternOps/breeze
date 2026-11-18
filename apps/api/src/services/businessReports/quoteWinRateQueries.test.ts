import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  QUOTE_LINEAGE_MAX_DEPTH,
  lineageByCurrencyQuery,
  lineageCte,
  lineageDetailQuery,
  lineageDiagnosticsQuery,
  lineageGroupedMoneyQuery,
  lineageGroupedQuery,
  lineageOverallQuery,
} from './quoteWinRateQueries';

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const START = new Date('2026-08-01T00:00:00.000Z');
const END = new Date('2026-09-01T00:00:00.000Z');

const partnerArgs = { partnerId: PARTNER, orgIds: [ORG_A, ORG_B], periodStart: START, periodEnd: END };
const orgArgs = { partnerId: null, orgIds: [ORG_A], periodStart: START, periodEnd: END };
const cteArgs = (a: typeof partnerArgs | typeof orgArgs) => ({ ...a, asOfUtcDate: '2026-09-15' });

describe('lineageCte', () => {
  it('traverses revision lineage with a recursive CTE anchored on roots', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('WITH RECURSIVE walk');
    expect(sql).toContain('revision_of_quote_id IS NULL');
    expect(sql).toContain('c.revision_of_quote_id = w.id');
  });

  it('partner scope binds partner_id AND the org allowlist in the anchor, and the step repeats the org predicate', () => {
    const { sql, params } = compile(lineageCte(cteArgs(partnerArgs)));
    const [anchor, step] = sql.split('UNION ALL');
    expect(anchor).toContain('q.org_id = ANY(');
    expect(anchor).toContain('q.partner_id = ');
    expect(step).toContain('c.org_id = w.org_id');
    expect(step).toContain('c.partner_id = ');
    expect(params).toEqual(expect.arrayContaining([PARTNER, ORG_A, ORG_B]));
    // partner id is bound as a parameter, never interpolated
    expect(sql).not.toContain(PARTNER);
    expect(sql).not.toContain(ORG_A);
  });

  it('org scope binds the single org allowlist and no partner predicate', () => {
    const { sql, params } = compile(lineageCte(cteArgs(orgArgs)));
    const [anchor, step] = sql.split('UNION ALL');
    expect(anchor).toContain('q.org_id = ANY(');
    expect(anchor).not.toContain('q.partner_id');
    expect(step).toContain('c.org_id = w.org_id');
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(PARTNER);
  });

  it('an empty org allowlist still binds an empty uuid[] (nothing reachable), never drops the predicate', () => {
    const { sql } = compile(lineageCte(cteArgs({ ...partnerArgs, orgIds: [] })));
    expect(sql).toContain('q.org_id = ANY(ARRAY[]::uuid[])');
  });

  it('the depth guard is bound as 50', () => {
    expect(QUOTE_LINEAGE_MAX_DEPTH).toBe(50);
    const { sql, params } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('w.depth < $');
    expect(params).toContain(50);
  });

  it('selects the cohort by FIRST sent_at in [start, end), not the terminal version\'s', () => {
    const { sql, params } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('MIN(q.sent_at) AS first_sent_at');
    expect(sql).toMatch(/p\.first_sent_at >= \$\d+ AND p\.first_sent_at < \$\d+/);
    expect(params).toEqual(expect.arrayContaining([START.toISOString(), END.toISOString()]));
  });

  it('a never-sent lineage drops out: first_sent_at NULL fails the cohort predicate and drafts are never terminal', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain("q.status <> 'draft'");
    expect(sql).toContain('DISTINCT ON (w.root_id)');
    expect(sql).toContain('ORDER BY w.root_id, q.revision_number DESC');
  });

  it('decline → revise → accept is one won lineage: outcome comes from the highest-revision non-draft version', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain("WHEN t.status IN ('converted', 'accepted') THEN 'won'");
    expect(sql).toContain("WHEN t.status = 'declined' THEN 'lost'");
    // one row per root: the lineage CTE joins per_root to terminal on root_id
    expect(sql).toContain('JOIN terminal t ON t.root_id = p.root_id');
  });

  it('a stale sent/viewed quote past expiry_date is expired at read time (the isQuoteExpired rule, UTC day bound)', () => {
    const { sql, params } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain("WHEN t.status IN ('sent', 'viewed') AND t.expiry_date < ");
    expect(sql).toMatch(/t\.expiry_date < \$\d+::date THEN 'expired'/);
    expect(params).toContain('2026-09-15');
  });

  it('a terminal superseded status (impossible by construction) is an anomaly, never won/lost/expired/open', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain("ELSE 'anomaly'");
  });

  it('values come from the terminal version: one_time_total and monthly + annual/12, never total', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('t.one_time_total');
    expect(sql).toContain('(t.monthly_recurring_total + t.annual_recurring_total / 12) AS monthly_recurring_value');
    expect(sql).not.toMatch(/t\.total\b/);
  });

  it('author is the ROOT\'s created_by, with an Unknown user fallback', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('r.created_by');
    expect(sql).toContain("COALESCE(u.name, 'Unknown user')");
  });

  it('outcome date: won accepted_at/converted_at, lost declined_at, expired expiry_date', () => {
    const { sql } = compile(lineageCte(cteArgs(partnerArgs)));
    expect(sql).toContain('COALESCE(t.accepted_at, t.converted_at)');
    expect(sql).toContain('t.declined_at');
    expect(sql).toContain('t.expiry_date::timestamp');
  });
});

describe('lineageDiagnosticsQuery', () => {
  it('reports unreachable sent quotes and depth-capped lineages, fenced by the same scope predicates', () => {
    const { sql, params } = compile(lineageDiagnosticsQuery(partnerArgs));
    expect(sql).toContain('WITH RECURSIVE walk');
    expect(sql).toContain('AS unreachable');
    expect(sql).toContain('AS depth_capped');
    expect(sql).toContain('x.partner_id = ');
    expect(sql).toContain('x.org_id = ANY(');
    expect(sql).toContain('x.id NOT IN (SELECT id FROM walk)');
    expect(params).toEqual(expect.arrayContaining([PARTNER, ORG_A, ORG_B, 50]));
  });

  it('org scope has no partner predicate', () => {
    const { sql } = compile(lineageDiagnosticsQuery(orgArgs));
    expect(sql).not.toContain('partner_id');
  });
});

describe('statements over the lineage CTE', () => {
  const cte = lineageCte(cteArgs(partnerArgs));

  it('every statement embeds the scoped CTE (anchor binds the org allowlist)', () => {
    for (const q of [
      lineageOverallQuery(cte),
      lineageGroupedQuery(cte, 'organization'),
      lineageGroupedMoneyQuery(cte, 'organization'),
      lineageByCurrencyQuery(cte),
      lineageDetailQuery(cte, 5001),
    ]) {
      const { sql } = compile(q);
      expect(sql).toContain('WITH RECURSIVE walk');
      expect(sql).toContain('q.org_id = ANY(');
    }
  });

  it('counts exclude anomalies from rates but report them; money excludes anomalies', () => {
    const { sql } = compile(lineageByCurrencyQuery(cte));
    expect(sql).toContain("outcome <> 'anomaly'");
    const counts = compile(lineageOverallQuery(cte)).sql;
    expect(counts).toContain("COUNT(*) FILTER (WHERE l.outcome = 'anomaly')::int AS anomalies");
  });

  it('medians are percentile_cont(0.5) over days from first send to outcome', () => {
    const { sql } = compile(lineageOverallQuery(cte));
    expect(sql).toContain('percentile_cont(0.5)');
    expect(sql).toContain('EXTRACT(EPOCH FROM (l.outcome_at - l.first_sent_at)) / 86400');
  });

  it('grouping axes: organization, author (root created_by) and currency', () => {
    expect(compile(lineageGroupedQuery(cte, 'organization')).sql).toContain('l.org_id::text AS group_key');
    expect(compile(lineageGroupedQuery(cte, 'author')).sql).toContain('l.author_key AS group_key');
    expect(compile(lineageGroupedQuery(cte, 'currency')).sql).toContain('l.currency_code AS group_key');
  });

  it('detail is ordered by first_sent_at, quote_number and limited (cap + 1 is the caller\'s call)', () => {
    const { sql, params } = compile(lineageDetailQuery(cte, 5001));
    expect(sql).toContain('ORDER BY l.first_sent_at, l.quote_number');
    expect(sql).toMatch(/LIMIT \$\d+/);
    expect(params).toContain(5001);
  });
});
