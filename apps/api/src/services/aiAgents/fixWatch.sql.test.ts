// apps/api/src/services/aiAgents/fixWatch.sql.test.ts
/**
 * P2-5 (#4192, closes #4206) — the two fix-watch inserts compiled against the
 * REAL schema and dialect.
 *
 * Both of `ai_agent_fix_watches`'s uniqueness guarantees became PARTIAL
 * indexes in `2026-10-01-100000-ai-agents-graduation-evidence.sql`
 * (`run_id WHERE source_kind = 'act_run'`, `intent_id WHERE intent_id IS NOT
 * NULL`), and Postgres cannot infer a partial unique index as an ON CONFLICT
 * arbiter unless the statement repeats its predicate. A conflict clause that
 * silently lost the predicate does not fail a mocked-builder test — it fails
 * at runtime, as a 42P10 on the very redelivery the clause exists to absorb.
 * So the clause is asserted as compiled SQL here, the way
 * `opEvidence.test.ts` pins its own exactly-once ON CONFLICT (repo's
 * vacuous-Drizzle-assertion trap). `../../db` is deliberately NOT mocked:
 * `.toSQL()` compiles through the dialect and never opens a connection.
 */
import { describe, expect, it } from 'vitest';
import { insertFixWatchRowQuery, insertIntentFixWatchRowQuery } from './fixWatch';

const ORG_ID = '00000000-0000-4000-8000-0000000000f1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000f2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000f3';
const RUN_ID = '00000000-0000-4000-8000-0000000000f4';
const ALERT_ID = '00000000-0000-4000-8000-0000000000f5';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000f6';
const INTENT_ID = '00000000-0000-4000-8000-0000000000f7';

const base = {
  orgId: ORG_ID,
  partnerId: PARTNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  alertId: ALERT_ID,
  ruleId: null,
  deviceId: DEVICE_ID,
  configItemName: null,
  state: 'pending' as const,
};

describe('insertFixWatchRowQuery — the act-run watch', () => {
  it('arbitrates on the PARTIAL run_id index, predicate and all', () => {
    const { sql } = insertFixWatchRowQuery({ ...base, sourceKind: 'act_run', opKeys: [] }).toSQL();

    expect(sql).toMatch(/^insert into "ai_agent_fix_watches"/);
    expect(sql).toMatch(/on conflict \("run_id"\) where/);
    expect(sql).toContain(`"ai_agent_fix_watches"."source_kind" = 'act_run'`);
    expect(sql).toMatch(/do nothing/);
    expect(sql).toMatch(/returning "id"/);
  });
});

describe('insertIntentFixWatchRowQuery — the intent-anchored watch', () => {
  it('arbitrates on the PARTIAL intent_id index, predicate and all', () => {
    const { sql } = insertIntentFixWatchRowQuery({
      ...base, intentId: INTENT_ID, sourceKind: 'intent', opKeys: ['manage_services:restart'],
    }).toSQL();

    expect(sql).toMatch(/^insert into "ai_agent_fix_watches"/);
    expect(sql).toMatch(/on conflict \("intent_id"\) where/);
    expect(sql).toContain(`"ai_agent_fix_watches"."intent_id" is not null`);
    expect(sql).toMatch(/do nothing/);
    expect(sql).toMatch(/returning "id"/);
  });

  it('never arbitrates on run_id — N intent watches legitimately share one run', () => {
    const { sql } = insertIntentFixWatchRowQuery({
      ...base, intentId: INTENT_ID, sourceKind: 'intent', opKeys: [],
    }).toSQL();

    expect(sql).not.toMatch(/on conflict \("run_id"\)/);
  });
});
