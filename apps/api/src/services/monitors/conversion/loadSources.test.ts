import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { dbMock, queries, reset } = vi.hoisted(() => {
  let queue: unknown[][] = [];
  const queries: Array<{ predicates: unknown[] }> = [];
  const dbMock = {
    select: vi.fn(() => {
      const result = queue.shift() ?? [];
      const query = { predicates: [] as unknown[] };
      queries.push(query);
      const chain: any = {
        from: vi.fn(() => chain), innerJoin: vi.fn((_table, predicate) => { query.predicates.push(predicate); return chain; }),
        leftJoin: vi.fn((_table, predicate) => { query.predicates.push(predicate); return chain; }),
        where: vi.fn((predicate) => { query.predicates.push(predicate); return chain; }),
        orderBy: vi.fn(() => chain), groupBy: vi.fn(() => chain), limit: vi.fn(() => chain),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    }),
  };
  return { dbMock, queries, reset: (rows: unknown[][]) => { queue = [...rows]; queries.length = 0; dbMock.select.mockClear(); } };
});
vi.mock('../../../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn(() => { throw new Error('conversion must retain caller context'); }),
  withSystemDbAccessContext: vi.fn(() => { throw new Error('conversion must not elevate scope'); }),
}));
import { countPendingConversions, loadPolicySources, OPEN_ALERT_STATUSES } from './loadSources';

const dialect = new PgDialect();
function predicates(index: number) {
  return queries[index]!.predicates.map((p) => dialect.sqlToQuery(p as SQL));
}
const policy = { id: 'policy1', name: 'Policy', orgId: 'o1', partnerId: null, parentPolicyId: 'parent1' };

describe('loadPolicySources', () => {
  beforeEach(() => reset([]));
  it('loads own unretired sources, normalized targeted automations, open alerts and parent state', async () => {
    const inlineRules = [{ id: 'r1' }];
    const watches = [{ id: 'w1' }];
    const targeted = { id: 'a1', trigger: { type: 'event', event: 'alert.triggered', filter: { configPolicyAlertRuleId: 'r1' } } };
    reset([[policy], [
      { id: 'lr', featureType: 'alert_rule' }, { id: 'lw', featureType: 'monitoring' },
      { id: 'la', featureType: 'automation' }, { id: 'lm', featureType: 'monitors', inlineSettings: { inheritance: 'replace', items: [] } },
    ], inlineRules, [{ id: 'settings1' }], watches,
    [{ id: 'pa1', triggerType: 'event', eventType: 'alert.triggered' }, { id: 'pa2', triggerType: 'schedule' }],
    [targeted, { trigger: { type: 'event', eventType: 'alert.triggered', filter: { configPolicyAlertRuleId: 'foreign' } } },
      { trigger: { type: 'event', eventType: 'device.online' } }, { trigger: { type: 'manual' } }, { trigger: null }],
    [{ sourceId: 'r1', count: 2 }], [{ n: 1 }]]);
    expect(await loadPolicySources('policy1')).toEqual({
      policy, links: { alertRule: 'lr', monitoring: 'lw', monitoringSettingsId: 'settings1', monitors: { id: 'lm', inheritance: 'replace', items: [] } },
      inlineRules, watches, policyAutomations: [{ id: 'pa1', triggerType: 'event', eventType: 'alert.triggered' }],
      standaloneAutomations: [targeted], openAlertsBySource: new Map([['r1', 2]]), parentUnconverted: true,
    });
    for (const index of [2, 4, 5, 6]) expect(predicates(index)[0]!.sql).toContain('"retired_at" is null');
    expect(predicates(6)[0]!.params).toContain('o1');
    expect(predicates(7)[0]!.params).toEqual(['r1', ...OPEN_ALERT_STATUSES]);
    expect(predicates(8).map((p) => p.sql).join(' ')).toContain('"retired_at" is null');
  });
  it.each(['monitoring', 'monitors'])('loads normalized watches from a %s settings link', async (featureType) => {
    reset([[{ ...policy, parentPolicyId: null }], [{ id: 'watch-link', featureType }],
      [{ id: 'settings1' }], [{ id: 'watch1', settingsId: 'settings1' }]]);
    const result = await loadPolicySources('policy1');
    expect(result?.watches).toEqual([{ id: 'watch1', settingsId: 'settings1' }]);
    expect(predicates(2)[0]!.params).toEqual(['watch-link']);
    expect(predicates(3)[0]!.params).toEqual(['settings1']);
    expect(predicates(3)[0]!.sql).toContain('"retired_at" is null');
  });
  it('loads watches from both settings rows when an old-link duplicate survived re-keying', async () => {
    const watches = [{ id: 'old-watch', settingsId: 'old-settings' }, { id: 'new-watch', settingsId: 'new-settings' }];
    reset([[{ ...policy, parentPolicyId: null }], [
      { id: 'old-link', featureType: 'monitoring' }, { id: 'new-link', featureType: 'monitors' },
    ], [{ id: 'old-settings' }, { id: 'new-settings' }], watches]);
    expect((await loadPolicySources('policy1'))?.watches).toEqual(watches);
    expect(predicates(2)[0]!.params).toEqual(['old-link', 'new-link']);
    expect(predicates(3)[0]!.params).toEqual(['old-settings', 'new-settings']);
  });
  it('returns null for missing or RLS-invisible policies without reading sources', async () => {
    reset([[]]);
    expect(await loadPolicySources('foreign')).toBeNull();
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });
  it('handles no links and no parent', async () => {
    reset([[{ ...policy, parentPolicyId: null }], []]);
    expect(await loadPolicySources('policy1')).toMatchObject({
      links: { alertRule: null, monitoring: null, monitoringSettingsId: null, monitors: null },
      inlineRules: [], watches: [], policyAutomations: [], standaloneAutomations: [], openAlertsBySource: new Map(), parentUnconverted: false,
    });
    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });
  it('uses the supplied executor and the source policy partner owner', async () => {
    reset([[{ ...policy, orgId: null, partnerId: 'p1', parentPolicyId: null }], [{ id: 'lr', featureType: 'alert_rule' }], [{ id: 'r1' }], [], []]);
    const executor = { select: vi.fn(dbMock.select) };
    await loadPolicySources('policy1', executor as unknown as NonNullable<Parameters<typeof loadPolicySources>[1]>);
    expect(executor.select).toHaveBeenCalledTimes(5);
    expect(predicates(3)[0]!.sql).toContain('"org_id" is null');
    expect(predicates(3)[0]!.params).toEqual(['p1']);
  });
});

describe('countPendingConversions', () => {
  it('deduplicates policies and sums the three grouped row counts and standalone rules', async () => {
    reset([[{ policyId: 'p1', policyName: 'Zulu', count: 2 }], [{ policyId: 'p1', policyName: 'Zulu', count: 3 }, { policyId: 'p2', policyName: 'Alpha', count: 1 }], [{ policyId: 'p2', policyName: 'Alpha', count: 4 }], [{ count: 5 }]]);
    expect(await countPendingConversions({ orgId: 'o1', partnerId: 'p1', includePartnerWide: true })).toEqual({
      policies: 2, rows: 10, standaloneRules: 5, networkChecks: 0,
      // Same rows as the count, deduplicated and sorted by name (#6644 review 5).
      pendingPolicies: [{ id: 'p2', name: 'Alpha' }, { id: 'p1', name: 'Zulu' }],
    });
    for (const index of [0, 1, 2, 3]) {
      const predicate = predicates(index).at(-1)!;
      expect(predicate.sql).toContain('"retired_at" is null');
      expect(predicate.params).toContain('o1');
      expect(predicate.params).toContain('p1');
      if (index < 3) expect(predicate.params).toContain('active');
    }
    expect(predicates(2).at(-1)!.params).toEqual(expect.arrayContaining(['event', 'alert.triggered']));
    expect(predicates(3).at(-1)!.sql).toContain('"managed_by_monitor_id" is null');
  });
  it('does not include partner-wide rows for org scope without opt-in', async () => {
    reset([[], [], [], []]);
    expect(await countPendingConversions({ orgId: 'o1', partnerId: 'p1', includePartnerWide: false })).toEqual({ policies: 0, rows: 0, standaloneRules: 0, networkChecks: 0, pendingPolicies: [] });
    for (const query of queries) {
      const compiled = dialect.sqlToQuery(query.predicates.at(-1) as SQL);
      expect(compiled.params).not.toContain('p1');
      expect(compiled.sql).not.toContain('"partner_id"');
    }
  });
  it.each([false, true])('counts all partner orgs with partner-wide opt-in %s', async (includePartnerWide) => {
    reset([[], [], [], []]);
    await countPendingConversions({ orgId: null, partnerId: 'partner1', includePartnerWide });
    for (const query of queries.slice(0, 4)) {
      const compiled = dialect.sqlToQuery(query.predicates.at(-1) as SQL);
      expect(compiled.sql).toContain('in (select "organizations"."id" from "organizations" where "organizations"."partner_id" =');
      expect(compiled.params.filter((p) => p === 'partner1')).toHaveLength(includePartnerWide ? 2 : 1);
      expect(compiled.sql.includes('"org_id" is null')).toBe(includePartnerWide);
    }
  });
  it.each([
    [{ orgId: 'o1', partnerId: 'p1', includePartnerWide: true }, ['o1']],
    [{ orgId: null, partnerId: 'p1', includePartnerWide: true }, ['p1']],
  ])('counts pending network checks separately using only the org axis: %j', async (scope, params) => {
    reset([[], [], [], [], [{ count: 7 }]]);
    expect(await countPendingConversions(scope)).toMatchObject({ rows: 0, policies: 0, networkChecks: 7 });
    const query = predicates(4).at(-1)!;
    expect(query.params).toEqual(params);
    expect(query.sql).toContain('"network_monitors"."managed_by_monitor_id" is null');
    expect(query.sql).toContain('"network_monitors"."retired_at" is null');
    expect(query.sql).not.toContain('"network_monitors"."org_id" is null');
    expect(query.sql).not.toContain('"network_monitors"."partner_id"');
  });
  it('fails closed when neither owner axis is provided', async () => {
    reset([[], [], [], []]);
    expect(await countPendingConversions({ orgId: null, partnerId: null, includePartnerWide: true })).toEqual({ policies: 0, rows: 0, standaloneRules: 0, networkChecks: 0, pendingPolicies: [] });
    for (const query of queries) expect(dialect.sqlToQuery(query.predicates.at(-1) as SQL).sql).toContain('false');
  });
});
