// apps/api/src/services/aiModels/qualityQueries.test.ts
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: m.execute } }));

import {
  AUTO_FLAG_REASON_PREFIXES,
  QualityQueryTimeoutError,
  buildQualityQuery,
  queryAiQualityBreakdown,
  toQualityMetrics,
  type QualityQueryInput,
} from './qualityQueries';

const render = (input: QualityQueryInput, sources = { failover: true, continuation: true }) =>
  new PgDialect().sqlToQuery(buildQualityQuery(input, sources));
const base = (over: Partial<QualityQueryInput> = {}): QualityQueryInput => ({
  groupBy: 'model', from: '2026-10-01', to: '2026-10-31', orgId: null, accessibleOrgIds: null, ...over,
});
const O1 = '11111111-1111-4111-8111-111111111111';

describe('buildQualityQuery', () => {
  it('reuses the spend view scope: authoritative rows, inclusive range, caller org list', () => {
    const { sql, params } = render(base({ accessibleOrgIds: [O1] }));
    expect(sql).toContain(`i.ledger_mode = 'authoritative'`);
    expect(sql).toMatch(/i\.org_id IN \(\$\d+::uuid\)/);
    expect(params).toEqual(expect.arrayContaining([O1, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']));
  });
  it('a caller with no accessible orgs matches nothing', () => {
    expect(render(base({ accessibleOrgIds: [] })).sql).toMatch(/AND false/);
  });
  it('groups a model row by the CHOSEN offering: the failover origin when W09 records one', () => {
    expect(render(base()).sql).toContain('COALESCE(i.failover_from_offering_id, i.offering_id)');
  });
  it.each([
    ['surface', 'i.surface'],
    ['prompt_profile', `COALESCE(i.prompt_profile, 'unrecorded')`],
    ['prompt_variant', `i.surface || '/' || i.prompt_profile || '@base'`],
  ] as const)('groupBy %s keys on %s', (groupBy, expr) => {
    expect(render(base({ groupBy })).sql).toContain(expr);
  });
  it('an optional surface filter narrows the ledger', () => {
    const { sql, params } = render(base({ groupBy: 'prompt_variant', surfaces: ['chat', 'ai_agents'] }));
    expect(sql).toMatch(/i\.surface IN \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['chat', 'ai_agents']));
  });
  it('conversationsOnly drops sessionless calls (ticket drafts never get a variant)', () => {
    expect(render(base({ groupBy: 'prompt_variant', conversationsOnly: true })).sql)
      .toContain('AND (i.session_id IS NOT NULL OR i.agent_run_id IS NOT NULL)');
    expect(render(base({ groupBy: 'prompt_variant' })).sql).not.toContain('i.session_id IS NOT NULL OR');
  });
  it('automatic flags are recognised by the writers\' reason prefixes', () => {
    const { sql, params } = render(base());
    expect(sql).toMatch(/starts_with\(s\.flag_reason, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining([...AUTO_FLAG_REASON_PREFIXES]));
  });
  it('orders a conversation by turn time, not insert time', () => {
    const { sql } = render(base());
    expect(sql).toContain('COALESCE(i.occurred_at, i.created_at) AS at');
    expect(sql).toMatch(/PARTITION BY conv ORDER BY at, id/);
    expect(sql).not.toMatch(/ORDER BY created_at/);
  });
  it('caps the groups at 200, ordered by cost then calls', () => {
    expect(render(base()).sql).toMatch(/ORDER BY SUM\(cost_cents\) DESC NULLS LAST, COUNT\(\*\) DESC\s+LIMIT 200/);
  });

  it('left_conversations is a distinct union of switched-away and continued conversations', () => {
    expect(render(base()).sql).toMatch(/UNION\s+SELECT gkey, conv FROM facts WHERE continued/);
  });

  describe('sources off (W05 / W09 not merged)', () => {
    const off = { failover: false, continuation: false };
    it('names no failover or continuation column', () => {
      const { sql } = render(base(), off);
      expect(sql).not.toMatch(/i\.failover_/);
      expect(sql).not.toMatch(/continued_from/);
      expect(sql).toContain('NULL::smallint AS failover_hop');
      expect(sql).toMatch(/i\.offering_id AS chosen_offering_id/);
    });
    it('each source switches independently', () => {
      expect(render(base(), { failover: true, continuation: false }).sql).not.toMatch(/continued_from/);
      expect(render(base(), { failover: false, continuation: true }).sql).not.toMatch(/i\.failover_/);
    });
  });
});

const raw = (over: Record<string, string | null> = {}) => ({
  key: 'k', label: null, connection_name: null,
  invocations: '10', cost_cents: '100', refusals: '2', failovers: '1', touched: '4', conversation_cost: '80',
  conversations: '3', sessions: '2', flagged: '1', auto_flagged: '1', continued: '1',
  resolved_sessions: '1', median_turns: '3.5', agent_runs: '1', agent_runs_completed: '1', switched_away: '1',
  left_conversations: '2', ...over,
});

describe('toQualityMetrics', () => {
  it('computes rates over their own denominators', () => {
    expect(toQualityMetrics(raw(), { failover: true, continuation: true })).toEqual({
      invocations: 10, costCents: 100, refusals: 2, refusalRate: 0.2,
      failovers: 1, failoverRate: 0.1,
      conversations: 3, costPerConversationCents: 20,
      sessions: 2, flagged: 1, autoFlagged: 1, flagRate: 0.5,
      switchedAway: 1, continued: 1, leftRate: 0.5,
      resolvedSessions: 1, medianTurnsToResolution: 3.5,
      agentRuns: 1, agentRunsCompleted: 1, agentCompletionRate: 1,
    });
  });
  it('reports null, never 0, for a source this server does not record', () => {
    const m2 = toQualityMetrics(raw(), { failover: false, continuation: false });
    expect([m2.failovers, m2.failoverRate, m2.continued]).toEqual([null, null, null]);
  });
  it('leftRate is distinct left conversations over touched ones (never switched + continued)', () => {
    // 1 switched and 1 continued, but the SAME conversation: the SQL union reports 1.
    expect(toQualityMetrics(raw({ touched: '2', switched_away: '1', continued: '1', left_conversations: '1' }), { failover: true, continuation: true }).leftRate).toBe(0.5);
  });
  it('null rates with no denominator', () => {
    const m3 = toQualityMetrics(raw({ invocations: '0', refusals: '0', touched: '0', sessions: '0', agent_runs: '0', median_turns: null }), { failover: true, continuation: true });
    expect(m3).toMatchObject({ refusalRate: 0, failoverRate: null, costPerConversationCents: null, flagRate: null, leftRate: null, agentCompletionRate: null, medianTurnsToResolution: null });
  });
});

describe('queryAiQualityBreakdown', () => {
  it('runs the grouped and total queries under the statement budget and shapes the DTO', async () => {
    m.execute.mockReset();
    m.execute
      .mockResolvedValueOnce([{ prior_ms: '0', applied: '15000ms' }]) // tighten
      .mockResolvedValueOnce([raw({ key: 'off-1', label: 'Sonnet 5.5', connection_name: null })])
      .mockResolvedValueOnce([raw({ key: 'total' })])
      .mockResolvedValueOnce([]); // restore
    const dto = await queryAiQualityBreakdown({ ...base(), groupBy: 'model' }, { failover: false, continuation: true });
    expect(dto).toMatchObject({
      groupBy: 'model', from: '2026-10-01', to: '2026-10-31', orgId: null,
      sources: { failovers: false, continuations: true },
      rows: [{ key: 'off-1', label: 'Sonnet 5.5', connectionName: null, failovers: null }],
      totals: { invocations: 10 },
    });
  });
  it('maps a statement timeout (57014) to QualityQueryTimeoutError', async () => {
    m.execute.mockReset();
    m.execute
      .mockResolvedValueOnce([{ prior_ms: '0', applied: '15000ms' }])
      .mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await expect(queryAiQualityBreakdown({ ...base(), groupBy: 'surface' }, { failover: false, continuation: false }))
      .rejects.toBeInstanceOf(QualityQueryTimeoutError);
  });
});
