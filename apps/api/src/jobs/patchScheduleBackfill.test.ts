import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  where: undefined as SQL | undefined,
  scopes: [] as Array<string | undefined>,
  ambient: undefined as { scope: string } | undefined,
  outsideCalls: 0,
  ensure: vi.fn(),
  txCount: 0,
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((w: SQL) => {
          state.where = w;
          state.scopes.push(state.ambient?.scope);
          return Promise.resolve(state.agents);
        }),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      state.txCount += 1;
      return fn({ tx: state.txCount });
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => { state.outsideCalls += 1; return fn(); }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const prev = state.ambient;
    state.ambient = { scope: 'system' };
    try { return await fn(); } finally { state.ambient = prev; }
  }),
}));

vi.mock('../services/aiAgents/scheduleService', () => ({ ensureDefaultPatchSchedule: state.ensure }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { backfillDefaultPatchSchedules } from './patchScheduleBackfill';

const agent = (id: string) => ({ id, kind: 'patch', orgId: null, partnerId: 'p1', enabled: true, disabledAt: null });

beforeEach(() => {
  state.agents = [];
  state.where = undefined;
  state.scopes = [];
  state.ambient = undefined;
  state.outsideCalls = 0;
  state.txCount = 0;
  state.ensure.mockReset();
});

describe('backfillDefaultPatchSchedules (#5382 — already-enabled agents that never ran)', () => {
  it('creates a baseline for every already-enabled partner-wide patch agent, each in its own savepoint, under a system context', async () => {
    state.agents = [agent('a1'), agent('a2')];
    state.ensure.mockResolvedValue({ created: true });

    const result = await backfillDefaultPatchSchedules();

    expect(result).toEqual({ scanned: 2, created: 2, skipped: 0, failed: 0 });
    expect(state.ensure).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'a1' }), { tx: 1 });
    expect(state.ensure).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'a2' }), { tx: 2 });
    expect(state.outsideCalls).toBe(1);
    expect(state.scopes).toEqual(['system']);
  });

  it('selects only live, enabled, partner-wide patch agents', async () => {
    await backfillDefaultPatchSchedules();
    const q = new PgDialect().sqlToQuery(state.where!);
    expect(q.sql).toContain('"kind" = ');
    expect(q.params).toContain('patch');
    expect(q.sql).toContain('"org_id" is null');
    expect(q.sql).toContain('"disabled_at" is null');
    expect(q.sql).toContain('"enabled" = ');
  });

  it('skips agents that already have a patch schedule and counts them', async () => {
    state.agents = [agent('a1'), agent('a2')];
    state.ensure.mockResolvedValueOnce({ created: false, reason: 'exists' }).mockResolvedValueOnce({ created: true });
    expect(await backfillDefaultPatchSchedules()).toEqual({ scanned: 2, created: 1, skipped: 1, failed: 0 });
  });

  it('isolates a failing agent — the rest still get their schedule', async () => {
    state.agents = [agent('a1'), agent('a2')];
    state.ensure.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ created: true });
    expect(await backfillDefaultPatchSchedules()).toEqual({ scanned: 2, created: 1, skipped: 0, failed: 1 });
  });

  it('is a no-op with nothing to do', async () => {
    expect(await backfillDefaultPatchSchedules()).toEqual({ scanned: 0, created: 0, skipped: 0, failed: 0 });
    expect(state.ensure).not.toHaveBeenCalled();
  });
});
