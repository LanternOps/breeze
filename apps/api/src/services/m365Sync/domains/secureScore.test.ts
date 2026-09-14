import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { executeMock, contextMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  contextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: contextMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { persistSecureScore } from './secureScore';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

function compiled(call = 0): { sql: string; params: unknown[] } {
  const out = new PgDialect().sqlToQuery(executeMock.mock.calls[call]![0] as never);
  return { sql: out.sql, params: out.params };
}

function ctx() {
  return {
    orgId: ORG, tenantId: TENANT,
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 2,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

function score(overrides: Record<string, unknown> = {}) {
  return {
    id: 'score-1',
    createdDateTime: '2026-09-07T02:00:00.000Z',
    currentScore: 412.5,
    maxScore: 600,
    activeUserCount: 120,
    licensedUserCount: 150,
    controlScores: [{ controlName: 'MFA', score: 10, maxScore: 20, implementationStatus: 'partial' }],
    ...overrides,
  };
}

function result(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    success: true as const, kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
    sources: { secureScores: 'ok' as const, controlProfiles: 'ok' as const },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue([{ inserted: 1, updated: 0 }]);
});

describe('persistSecureScore', () => {
  it('keys the row on the UTC date of the Graph createdDateTime, computed in SQL', async () => {
    await persistSecureScore(ctx(), result([score()]));
    const { sql, params } = compiled();
    expect(sql).toContain("at time zone 'UTC'");
    expect(sql).toContain('on conflict (org_id, score_date)');
    expect(params).toContain('2026-09-07T02:00:00.000Z');
    // the fetch day must never be bound as a score date
    expect(params).not.toContain('2026-09-08');
  });

  it('runs inside its own system DB context', async () => {
    await persistSecureScore(ctx(), result([score()]));
    expect(contextMock).toHaveBeenCalledOnce();
  });

  it('binds the org and the connection tenant on every row', async () => {
    await persistSecureScore(ctx(), result([score(), score({ id: 'score-2', createdDateTime: '2026-09-06T02:00:00.000Z' })]));
    const { params } = compiled();
    expect(params.filter((p) => p === TENANT)).toHaveLength(2);
    expect(params.filter((p) => p === ORG)).toHaveLength(2);
  });

  it('reports secure_score and secure_score_max from the NEWEST score', async () => {
    const out = await persistSecureScore(ctx(), result([
      score({ id: 'old', createdDateTime: '2026-09-01T02:00:00.000Z', currentScore: 100, maxScore: 600 }),
      score({ id: 'new', createdDateTime: '2026-09-07T02:00:00.000Z', currentScore: 412.5, maxScore: 600 }),
      score({ id: 'mid', createdDateTime: '2026-09-04T02:00:00.000Z', currentScore: 300, maxScore: 600 }),
    ]));
    expect(out.counts).toEqual({ secure_score: 412.5, secure_score_max: 600 });
    expect(out.inserted).toBe(1);
  });

  it('collapses two scores from the same Graph day to one row (newest wins)', async () => {
    await persistSecureScore(ctx(), result([
      score({ id: 'a', createdDateTime: '2026-09-07T02:00:00.000Z', currentScore: 400 }),
      score({ id: 'b', createdDateTime: '2026-09-07T18:00:00.000Z', currentScore: 420 }),
    ]));
    expect(executeMock).toHaveBeenCalledOnce();
    const { params } = compiled();
    expect(params).toContain(420);
    expect(params).not.toContain(400);
  });

  it('drops a score with an unparseable createdDateTime rather than failing the batch', async () => {
    await persistSecureScore(ctx(), result([
      score({ id: 'bad', createdDateTime: 'not-a-date' }),
      score({ id: 'good' }),
    ]));
    const { params } = compiled();
    expect(params).not.toContain('not-a-date');
    expect(params).toContain('2026-09-07T02:00:00.000Z');
  });

  it('issues no statement and stays complete for an empty score list', async () => {
    const out = await persistSecureScore(ctx(), result([]));
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.complete).toBe(true);
    expect(out.counts).toEqual({});
  });

  it('is not complete when the primary source failed or the result was truncated', async () => {
    expect((await persistSecureScore(ctx(), result([], { sources: { secureScores: 'error' } }))).complete).toBe(false);
    expect((await persistSecureScore(ctx(), result([score()], { truncated: true }))).complete).toBe(false);
  });

  it('never marks anything stale — it is a time series, not an entity table', async () => {
    const out = await persistSecureScore(ctx(), result([score()]));
    expect(out.stale).toBe(0);
    expect(compiled().sql).not.toContain('is_stale');
  });
});
