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

import { persistSigninActivity } from './signinActivity';

const ORG = '11111111-1111-4111-8111-111111111111';

function compiled(call: number): { sql: string; params: unknown[] } {
  const out = new PgDialect().sqlToQuery(executeMock.mock.calls[call]![0] as never);
  return { sql: out.sql, params: out.params };
}

function ctx() {
  return {
    orgId: ORG,
    tenantId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 7,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

function result(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    success: true as const,
    kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z',
    sources: { signInActivity: 'ok' as const },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue([{ updated: 0 }]);
});

describe('persistSigninActivity', () => {
  it('issues one field-wise, change-only UPDATE keyed on (org_id, graph_id)', async () => {
    executeMock.mockResolvedValueOnce([{ updated: 2 }]);
    const out = await persistSigninActivity(ctx(), result([
      { id: 'u1', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' },
      { id: 'u2', lastSuccessfulSignInAt: null },
    ]));
    expect(executeMock).toHaveBeenCalledOnce();
    const { sql, params } = compiled(0);
    expect(sql).toContain('update m365_users');
    expect(sql).toContain('last_successful_sign_in_at');
    expect(sql).toContain('is distinct from');
    expect(sql).not.toContain('insert');
    expect(sql).not.toContain('core_hash');
    expect(sql).not.toContain('last_changed_at');
    expect(params).toContain(ORG);
    expect(out).toMatchObject({ updated: 2, inserted: 0, stale: 0, unchanged: 0, continuation: null, complete: true });
  });

  it('runs inside its own system DB context — the worker holds none in Phase C', async () => {
    await persistSigninActivity(ctx(), result([{ id: 'u1', lastSuccessfulSignInAt: null }]));
    expect(contextMock).toHaveBeenCalledOnce();
  });

  it('binds timestamps as ISO strings, never Date objects', async () => {
    await persistSigninActivity(ctx(), result([{ id: 'u1', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' }]));
    const { params } = compiled(0);
    expect(params.some((p) => p instanceof Date)).toBe(false);
    expect(params).toContain('2026-09-01T10:00:00.000Z');
  });

  it('drops unparseable timestamps and duplicate or missing ids rather than failing the page', async () => {
    await persistSigninActivity(ctx(), result([
      { id: 'u1', lastSuccessfulSignInAt: 'not-a-date' },
      { id: 'u1', lastSuccessfulSignInAt: '2026-09-02T10:00:00.000Z' },
      { lastSuccessfulSignInAt: '2026-09-03T10:00:00.000Z' },
    ]));
    const { params } = compiled(0);
    expect(params).not.toContain('not-a-date');
    expect(params.filter((p) => p === 'u1')).toHaveLength(1);
  });

  it('issues NO statement and reports a complete run for an empty page set', async () => {
    const out = await persistSigninActivity(ctx(), result([]));
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.updated).toBe(0);
    expect(out.complete).toBe(true);
  });

  it('carries the continuation through and marks the run incomplete', async () => {
    const out = await persistSigninActivity(ctx(), result(
      [{ id: 'u1', lastSuccessfulSignInAt: null }],
      { continuation: 'opaque-blob' },
    ));
    expect(out.continuation).toBe('opaque-blob');
    expect(out.complete).toBe(false);
  });

  it('treats an unlicensed tenant as a complete, zero-update success', async () => {
    const out = await persistSigninActivity(ctx(), {
      success: true, kind: 'sync', items: [{ id: 'u1', lastSuccessfulSignInAt: null }], truncated: false,
      fetchedAt: '2026-09-08T00:00:00.000Z',
      sources: { signInActivity: 'unlicensed' },
    });
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.unlicensed).toBe(true);
    expect(out.complete).toBe(true);
    expect(out.counts).toEqual({});
  });

  it('is not complete when the primary source is not ok', async () => {
    const out = await persistSigninActivity(ctx(), result([], { sources: { signInActivity: 'error' } }));
    expect(out.complete).toBe(false);
  });

  it('reports unchanged as the matched-but-equal remainder', async () => {
    executeMock.mockResolvedValueOnce([{ updated: 1 }]);
    const out = await persistSigninActivity(ctx(), result([
      { id: 'u1', lastSuccessfulSignInAt: null },
      { id: 'u2', lastSuccessfulSignInAt: null },
      { id: 'u3', lastSuccessfulSignInAt: null },
    ]));
    expect(out.updated).toBe(1);
    expect(out.unchanged).toBe(2);
  });
});
