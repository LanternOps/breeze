import { describe, expect, it, vi } from 'vitest';
import type { db } from '../../db';
import {
  actEvidenceSourceId,
  insertOpEvidence,
  insertOpEvidenceQuery,
  intentEvidenceSourceId,
  type OpEvidenceInsert,
  upsertVerdictFeedbackEvidence,
  upsertVerdictFeedbackEvidenceQuery,
  verdictEvidenceSourceId,
  watchEvidenceSourceId,
} from './opEvidence';

/**
 * P2-5 (#4192) — exactly-once evidence writer. The ON CONFLICT clause IS the
 * exactly-once contract (BullMQ redelivery relies on it silently absorbing a
 * duplicate), so its compiled SQL is asserted directly against the REAL
 * schema/dialect rather than a mocked builder object (repo's vacuous-Drizzle
 * trap — see `ticketPush.sql.test.ts`, `alertService.ackCasSql.test.ts`).
 * `../../db` is intentionally NOT mocked for those assertions: `.toSQL()`
 * only compiles the query through the dialect, it never opens a connection.
 */

const occurredAt = new Date('2026-09-01T12:00:00.000Z');

function makeRow(overrides: Partial<OpEvidenceInsert> = {}): OpEvidenceInsert {
  return {
    orgId: '00000000-0000-4000-8000-000000000001',
    agentId: '00000000-0000-4000-8000-000000000002',
    namespace: 'policy_key',
    opKey: 'manage_services:restart',
    ruleId: null,
    sourceKind: 'intent',
    sourceId: 'intent-1',
    metric: 'executed',
    runId: null,
    occurredAt,
    ...overrides,
  };
}

describe('insertOpEvidenceQuery — compiled SQL (vacuous-Drizzle trap)', () => {
  it('conflict target is exactly (source_kind, source_id, metric), DO NOTHING', () => {
    const { sql } = insertOpEvidenceQuery([makeRow()]).toSQL();
    expect(sql).toMatch(/on conflict \("source_kind","source_id","metric"\) do nothing/);
    expect(sql).toMatch(/^insert into "ai_agent_op_evidence"/);
    expect(sql).toMatch(/returning "id"/);
  });

  it('a second call with identical inputs produces byte-identical SQL and params', () => {
    const rowsA = [makeRow(), makeRow({ sourceId: 'intent-2', metric: 'verified' })];
    const rowsB = [makeRow(), makeRow({ sourceId: 'intent-2', metric: 'verified' })];
    const first = insertOpEvidenceQuery(rowsA).toSQL();
    const second = insertOpEvidenceQuery(rowsB).toSQL();
    expect(second).toEqual(first);
  });

  it('one row per input, values list matches row count', () => {
    const { sql } = insertOpEvidenceQuery([makeRow(), makeRow({ sourceId: 'intent-2' })]).toSQL();
    const valuesClause = sql.split(' on conflict ')[0] ?? '';
    const rowTuples = valuesClause.match(/\(default, \$/g);
    expect(rowTuples).toHaveLength(2);
  });
});

describe('insertOpEvidence — return value (row-count semantics)', () => {
  function fakeDatabase(resolvedRows: Array<{ id: string }>) {
    const returning = vi.fn().mockResolvedValue(resolvedRows);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    return { insert } as unknown as Pick<typeof db, 'insert'>;
  }

  it('returns rows.length on a fresh insert', async () => {
    const database = fakeDatabase([{ id: 'e1' }, { id: 'e2' }]);
    const count = await insertOpEvidence([makeRow(), makeRow({ sourceId: 'intent-2' })], database);
    expect(count).toBe(2);
  });

  it('returns 0 when the DB returns no rows (ON CONFLICT DO NOTHING absorbed every row)', async () => {
    const database = fakeDatabase([]);
    const count = await insertOpEvidence([makeRow()], database);
    expect(count).toBe(0);
  });

  it('returns 0 for an empty input without calling the DB', async () => {
    const database = fakeDatabase([{ id: 'unexpected' }]);
    const count = await insertOpEvidence([], database);
    expect(count).toBe(0);
    expect(database.insert).not.toHaveBeenCalled();
  });
});

describe('upsertVerdictFeedbackEvidenceQuery — compiled SQL (vacuous-Drizzle trap)', () => {
  it('conflicts on source_id, guarded to the verdict_feedback partial index, updates metric', () => {
    const { sql, params } = upsertVerdictFeedbackEvidenceQuery(
      makeRow({ namespace: 'alert_verdict', sourceKind: 'verdict_feedback', sourceId: 'verdict-1', metric: 'feedback_up' }),
    ).toSQL();
    expect(sql).toMatch(/on conflict \("source_id"\)/);
    expect(sql).toMatch(/where\s+(?:"[\w]+"\.)?"source_kind" = 'verdict_feedback'/);
    expect(sql).toMatch(/do update set "metric" = \$\d+/);
    expect(params).toContain('feedback_up');
  });
});

describe('upsertVerdictFeedbackEvidence — behavior', () => {
  it('resolves without throwing given a working DB stub', async () => {
    const returning = vi.fn();
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate, then: (resolve: (v: undefined) => void) => resolve(undefined) });
    const insert = vi.fn().mockReturnValue({ values });
    const database = { insert } as unknown as Pick<typeof db, 'insert'>;

    await expect(
      upsertVerdictFeedbackEvidence(
        makeRow({ namespace: 'alert_verdict', sourceKind: 'verdict_feedback', sourceId: 'verdict-1', metric: 'feedback_down' }),
        database,
      ),
    ).resolves.toBeUndefined();
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('stable source-id helpers', () => {
  it('intentEvidenceSourceId is the bare intent id', () => {
    expect(intentEvidenceSourceId('intent-1')).toBe('intent-1');
  });

  it('watchEvidenceSourceId is `${watchId}:${opKey}` — avoids colliding N op_keys onto one unique tuple', () => {
    expect(watchEvidenceSourceId('w1', 'manage_services:restart')).toBe('w1:manage_services:restart');
  });

  it('actEvidenceSourceId is `${runId}:${actionIndex}` — executionId is not unique within a run', () => {
    expect(actEvidenceSourceId('r1', 0)).toBe('r1:0');
    expect(actEvidenceSourceId('r1', 3)).toBe('r1:3');
  });

  it('verdictEvidenceSourceId is the bare verdict id', () => {
    expect(verdictEvidenceSourceId('verdict-1')).toBe('verdict-1');
  });
});
