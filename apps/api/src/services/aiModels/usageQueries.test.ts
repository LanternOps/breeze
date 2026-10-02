import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildUsageQuery, defaultUsageRange, toUsageRow, type UsageQueryInput } from './usageQueries';

const render = (q: ReturnType<typeof buildUsageQuery>) => new PgDialect().sqlToQuery(q);
const base = (over: Partial<UsageQueryInput> = {}): UsageQueryInput => ({
  groupBy: 'model', from: '2026-10-01', to: '2026-10-31', orgId: null, accessibleOrgIds: null, ...over,
});
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';

describe('W09 failovers', () => {
  it('counts rows served by a failover hop', () => {
    const text = render(buildUsageQuery(base({ groupBy: 'model' }))).sql;
    expect(text).toContain('FILTER (WHERE i.failover_hop > 0)');
    expect(text).toMatch(/g\.fallbacks, g\.failovers/);
    expect(render(buildUsageQuery(base({ groupBy: 'surface' }))).sql).toContain('FILTER (WHERE i.failover_hop > 0)');
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '4', cost_cents: '1', input_tokens: '1', output_tokens: '1', refusals: '0', fallbacks: '0', failovers: '2' }).failovers).toBe(2);
  });
});

describe('buildUsageQuery', () => {
  it('counts only authoritative ledger rows', () => {
    expect(render(buildUsageQuery(base())).sql).toContain(`i.ledger_mode = 'authoritative'`);
  });
  it('treats `to` as inclusive (created_at < to + 1 day)', () => {
    const { sql, params } = render(buildUsageQuery(base({ groupBy: 'surface' })));
    expect(params).toContain('2026-10-01T00:00:00.000Z');
    expect(params).toContain('2026-11-01T00:00:00.000Z');
    expect(sql).toMatch(/i\.created_at < \$\d+::timestamptz/);
  });
  it('filters by org only when orgId is given', () => {
    expect(render(buildUsageQuery(base({ groupBy: 'org', orgId: null }))).sql).not.toMatch(/i\.org_id = \$\d+::uuid/);
    const withOrg = render(buildUsageQuery(base({ groupBy: 'org', orgId: O1 })));
    expect(withOrg.sql).toMatch(/i\.org_id = \$\d+::uuid/);
    expect(withOrg.params).toContain(O1);
  });

  describe('caller org scoping (defence in depth beside RLS)', () => {
    it('system callers (accessibleOrgIds null) are not narrowed', () => {
      const { sql } = render(buildUsageQuery(base({ accessibleOrgIds: null })));
      expect(sql).not.toMatch(/i\.org_id IN/);
      expect(sql).not.toMatch(/AND false/);
    });
    it('partner callers are narrowed to their accessible orgs', () => {
      const { sql, params } = render(buildUsageQuery(base({ accessibleOrgIds: [O1, O2] })));
      expect(sql).toMatch(/i\.org_id IN \(\$\d+::uuid, \$\d+::uuid\)/);
      expect(params).toEqual(expect.arrayContaining([O1, O2]));
    });
    it('a single-org caller is narrowed to that org', () => {
      const { sql, params } = render(buildUsageQuery(base({ accessibleOrgIds: [O1] })));
      expect(sql).toMatch(/i\.org_id IN \(\$\d+::uuid\)/);
      expect(params).toContain(O1);
    });
    it('a caller with no accessible orgs matches nothing', () => {
      expect(render(buildUsageQuery(base({ accessibleOrgIds: [] }))).sql).toMatch(/AND false/);
    });
  });

  it.each(['model', 'surface', 'user', 'org'] as const)('groups by %s with a stable key expression', (groupBy) => {
    expect(render(buildUsageQuery(base({ groupBy }))).sql).toMatch(/GROUP BY/i);
  });

  it('groups by the model that SERVED the leg (served_model per funding/connection), never by offering_id', () => {
    const { sql } = render(buildUsageQuery(base({ groupBy: 'model' })));
    expect(sql).toMatch(/GROUP BY i\.funding_source, i\.connection_id, i\.served_model/);
    expect(sql).not.toMatch(/offering_id/);
  });
  // W03 soft-disconnect keeps the connection as provenance; the model row says so.
  it('groupBy=model flags a row whose serving connection is disconnected (LEFT JOIN, false for platform rows)', () => {
    const { sql } = render(buildUsageQuery(base({ groupBy: 'model' })));
    expect(sql).toMatch(/LEFT JOIN partner_ai_connections gc ON gc\.id = g\.connection_id/);
    expect(sql).toMatch(/COALESCE\(gc\.status = 'disconnected', false\) AS connection_disconnected/);
  });
  it.each(['surface', 'user', 'org'] as const)('groupBy=%s carries no disconnected flag', (groupBy) => {
    const { sql } = render(buildUsageQuery(base({ groupBy })));
    expect(sql).not.toMatch(/connection_disconnected|partner_ai_connections/);
  });
  it('orders by cost then invocations and caps at 200 rows', () => {
    const { sql } = render(buildUsageQuery(base({ groupBy: 'user' })));
    expect(sql).toMatch(/ORDER BY SUM\(i\.cost_cents\) DESC NULLS LAST, COUNT\(\*\) DESC\s+LIMIT 200/);
  });
});

describe('toUsageRow', () => {
  it('computes refusalRate and coerces numerics', () => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '4', cost_cents: '12.5', input_tokens: '100', output_tokens: '50', refusals: '1', fallbacks: '0', failovers: '0' }))
      .toEqual({ key: 'k', label: 'L', invocations: 4, costCents: 12.5, inputTokens: 100, outputTokens: 50, refusals: 1, refusalRate: 0.25, fallbacks: 0, failovers: 0 });
  });
  it('refusalRate is 0 with no invocations', () => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '0', cost_cents: null, input_tokens: null, output_tokens: null, refusals: '0', fallbacks: '0', failovers: '0' }).refusalRate).toBe(0);
  });
  it.each([[true, true], [false, false]])('maps connection_disconnected %s → connectionDisconnected %s (model rows)', (raw, flag) => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '1', cost_cents: '0', input_tokens: '0', output_tokens: '0', refusals: '0', fallbacks: '0', failovers: '0', connection_disconnected: raw }))
      .toMatchObject({ connectionDisconnected: flag });
  });
  it('a row without the column (non-model groupings, totals) has no connectionDisconnected key', () => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '1', cost_cents: '0', input_tokens: '0', output_tokens: '0', refusals: '0', fallbacks: '0', failovers: '0' }))
      .not.toHaveProperty('connectionDisconnected');
  });
  it('falls back to the key when no label resolved', () => {
    expect(toUsageRow({ key: 'k', label: null, invocations: '1', cost_cents: '0', input_tokens: '0', output_tokens: '0', refusals: '0', fallbacks: '0', failovers: '0' }).label).toBe('k');
  });
});

describe('defaultUsageRange', () => {
  it('is the first of the UTC month through today', () => {
    expect(defaultUsageRange(new Date('2026-10-17T05:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-17' });
  });
});
