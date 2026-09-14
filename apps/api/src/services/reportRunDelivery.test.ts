/**
 * #4248 W03 (spec OD-8) — the claim-before-send state machine for
 * `report_run_deliveries`.
 *
 * Mocked-drizzle double with COMPILED-SQL assertions (PgDialect), the idiom of
 * `narrativeReport.test.ts`: the whole contract lives in the WHERE predicates
 * (`state = 'pending'` on the claim, `state = 'claimed'` on the settle) and
 * in which DB context each statement runs — a substring match on an opaque
 * `.where()` object cannot see either. The live-Postgres proof of the
 * exactly-once claim and the crash recovery is
 * `__tests__/integration/narrativeEmailDelivery.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  insertValues: [] as unknown[],
  insertConflicts: [] as unknown[],
  insertReturningQueue: [] as unknown[][],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  updateReturningQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  selectQueue: [] as unknown[][],
  selectLimits: [] as number[],
  ambientContext: undefined as { scope: string } | undefined,
  statementScopes: [] as Array<string | undefined>,
  contextOpens: 0,
  outsideExits: 0,
}));

function reset(): void {
  state.insertValues = [];
  state.insertConflicts = [];
  state.insertReturningQueue = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.updateReturningQueue = [];
  state.selectWheres = [];
  state.selectQueue = [];
  state.selectLimits = [];
  state.ambientContext = undefined;
  state.statementScopes = [];
  state.contextOpens = 0;
  state.outsideExits = 0;
}

vi.mock('../db', () => {
  const thenable = (produce: () => unknown) => ({
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => {
          state.statementScopes.push(state.ambientContext?.scope);
          return produce();
        })
        .then(resolve, reject),
  });
  function insertBuilder() {
    const b: Record<string, unknown> = {
      values: vi.fn((v: unknown) => { state.insertValues.push(v); return b; }),
      onConflictDoNothing: vi.fn((cfg?: unknown) => { state.insertConflicts.push(cfg ?? {}); return b; }),
      returning: vi.fn(() => thenable(() => state.insertReturningQueue.shift() ?? [])),
      ...thenable(() => []),
    };
    return b;
  }
  function updateBuilder() {
    const b: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => { state.updateSets.push(v); return b; }),
      where: vi.fn((w: unknown) => { state.updateWheres.push(w); return b; }),
      returning: vi.fn(() => thenable(() => state.updateReturningQueue.shift() ?? [])),
      ...thenable(() => []),
    };
    return b;
  }
  function selectBuilder() {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn((w: unknown) => { state.selectWheres.push(w); return b; }),
      orderBy: vi.fn(() => b),
      limit: vi.fn((n: number) => { state.selectLimits.push(n); return b; }),
      ...thenable(() => state.selectQueue.shift() ?? []),
    };
    return b;
  }
  const dbDouble = {
    insert: vi.fn(() => insertBuilder()),
    update: vi.fn(() => updateBuilder()),
    select: vi.fn(() => selectBuilder()),
  };
  return {
    db: dbDouble,
    getCurrentDbAccessContext: vi.fn(() => state.ambientContext),
    // Like the real AsyncLocalStorage.exit: continuations created inside `fn`
    // see NO ambient context (the mock does not restore afterwards — every
    // test resets state, and restoring synchronously would race the async
    // builder's `.then`).
    runOutsideDbContext: vi.fn((fn: () => unknown) => {
      state.outsideExits += 1;
      state.ambientContext = undefined;
      return fn();
    }),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      state.contextOpens += 1;
      const previous = state.ambientContext;
      state.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        state.ambientContext = previous;
      }
    }),
  };
});

import { db } from '../db';
import {
  STALE_CLAIM_MS,
  claimDelivery,
  createPendingDeliveries,
  listPendingDeliveriesForRun,
  listUnsettledDeliveries,
  recordTransientGateFailure,
  settleDelivery,
  summarizeDeliveries,
} from './reportRunDelivery';

const dialect = new PgDialect();
function compiled(value: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(value as SQL);
}

const RUN = '00000000-0000-4000-8000-0000000000b1';
const D1 = '00000000-0000-4000-8000-0000000000d1';

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe('report run delivery state machine (#4248 W03, OD-8)', () => {
  it('exposes the 15-minute stale-claim window', () => {
    expect(STALE_CLAIM_MS).toBe(15 * 60 * 1000);
  });

  describe('createPendingDeliveries', () => {
    it('inserts one pending row per DISTINCT recipient on the caller handle, idempotently', async () => {
      state.insertReturningQueue.push([{ id: 'x' }, { id: 'y' }]);
      const n = await createPendingDeliveries(db, RUN, ['u1', 'u2', 'u1'], 'email');
      expect(n).toBe(2);
      expect(state.insertValues[0]).toEqual([
        { reportRunId: RUN, recipientUserId: 'u1', channel: 'email', state: 'pending' },
        { reportRunId: RUN, recipientUserId: 'u2', channel: 'email', state: 'pending' },
      ]);
      // onConflictDoNothing against the (run, recipient, channel) unique index:
      // a retried persist does not double the rows.
      expect(state.insertConflicts).toHaveLength(1);
      // Runs on the CALLER's handle (joins the artifact transaction) — never
      // opens a context of its own.
      expect(state.contextOpens).toBe(0);
    });

    it('returns 0 and issues no statement for an empty recipient list', async () => {
      expect(await createPendingDeliveries(db, RUN, [], 'email')).toBe(0);
      expect(state.insertValues).toHaveLength(0);
    });

    it('reports only the rows that were actually inserted (conflicts excluded)', async () => {
      state.insertReturningQueue.push([]);
      expect(await createPendingDeliveries(db, RUN, ['u1'], 'email')).toBe(0);
    });
  });

  describe('claimDelivery', () => {
    it('is a single UPDATE gated on state = pending, in its OWN committed system context', async () => {
      state.updateReturningQueue.push([{ id: D1 }]);
      expect(await claimDelivery(D1)).toBe(true);

      const { sql, params } = compiled(state.updateWheres[0]);
      expect(sql).toContain('"id" = ');
      expect(sql).toContain('"state" = ');
      expect(params).toEqual([D1, 'pending']);
      expect(state.updateSets[0]).toMatchObject({ state: 'claimed', claimedAt: expect.any(Date), updatedAt: expect.any(Date) });
      expect(compiled(state.updateSets[0]!.attempts).sql).toMatch(/"attempts" \+ 1/);
      // Own transaction: exits any ambient context, then opens a fresh system one.
      expect(state.outsideExits).toBe(1);
      expect(state.contextOpens).toBe(1);
      expect(state.statementScopes).toEqual(['system']);
    });

    it('returns false when the row was already claimed (zero rows matched) — the caller sends nothing', async () => {
      state.updateReturningQueue.push([]);
      expect(await claimDelivery(D1)).toBe(false);
    });

    it('refuses to run inside an ambient DB context (a rollback there would erase the claim after the mail left)', async () => {
      state.ambientContext = { scope: 'system' };
      await expect(claimDelivery(D1)).rejects.toThrow(/outside any db context/i);
      expect(state.updateWheres).toHaveLength(0);
    });
  });

  describe('settleDelivery', () => {
    it('sent: stamps sent_at and only moves a CLAIMED row', async () => {
      state.updateReturningQueue.push([{ id: D1 }]);
      await settleDelivery(D1, { state: 'sent' });
      const { params } = compiled(state.updateWheres[0]);
      expect(params).toEqual([D1, 'claimed']);
      expect(state.updateSets[0]).toMatchObject({ state: 'sent', sentAt: expect.any(Date), lastError: null });
      expect(state.contextOpens).toBe(1);
    });

    it('failed: records the error, no sent_at', async () => {
      state.updateReturningQueue.push([{ id: D1 }]);
      await settleDelivery(D1, { state: 'failed', error: 'authority:membership_removed' });
      expect(state.updateSets[0]).toMatchObject({ state: 'failed', lastError: 'authority:membership_removed' });
      expect(state.updateSets[0]).not.toHaveProperty('sentAt');
    });

    it('unknown: records the ambiguity and never resets', async () => {
      state.updateReturningQueue.push([{ id: D1 }]);
      await settleDelivery(D1, { state: 'unknown', error: 'ETIMEDOUT' });
      expect(state.updateSets[0]).toMatchObject({ state: 'unknown', lastError: 'ETIMEDOUT' });
    });

    it('surfaces a settle that matched no claimed row instead of silently succeeding', async () => {
      state.updateReturningQueue.push([]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await settleDelivery(D1, { state: 'sent' });
      expect(warn.mock.calls.flat().join(' ')).toMatch(/no claimed row/i);
    });
  });

  describe('recordTransientGateFailure', () => {
    it('writes last_error but leaves the row pending (retryable)', async () => {
      await recordTransientGateFailure(D1, 'authority:unverifiable_scope');
      const { params } = compiled(state.updateWheres[0]);
      expect(params).toEqual([D1, 'pending']);
      expect(state.updateSets[0]).toMatchObject({ lastError: 'authority:unverifiable_scope' });
      expect(state.updateSets[0]).not.toHaveProperty('state');
    });
  });

  describe('listUnsettledDeliveries', () => {
    it('selects only pending/claimed rows older than the cutoff, bounded by limit', async () => {
      const cutoff = new Date('2026-09-14T10:00:00Z');
      state.selectQueue.push([{ id: D1, state: 'pending' }]);
      const rows = await listUnsettledDeliveries(cutoff, 25);
      expect(rows).toEqual([{ id: D1, state: 'pending' }]);
      const { sql, params } = compiled(state.selectWheres[0]);
      expect(sql).toContain('"state" in (');
      // claimed_at for a claimed row, created_at for a pending one — as typed
      // column comparisons (a Date inside a raw sql`` fragment throws at bind).
      expect(sql).toMatch(/"claimed_at" is null and "[^"]*"\."created_at" < \$/);
      expect(sql).toMatch(/"claimed_at" < \$/);
      expect(sql).not.toContain('COALESCE');
      expect(params).toHaveLength(4);
      expect(params.slice(0, 2)).toEqual(['pending', 'claimed']);
      for (const bound of params.slice(2)) {
        expect(new Date(bound as string | Date).toISOString()).toBe(cutoff.toISOString());
      }
      expect(params).not.toContain('unknown');
      expect(state.selectLimits).toEqual([25]);
    });
  });

  describe('listPendingDeliveriesForRun', () => {
    it('selects only the pending rows of that run', async () => {
      state.selectQueue.push([{ id: D1, state: 'pending' }]);
      expect(await listPendingDeliveriesForRun(RUN)).toEqual([{ id: D1, state: 'pending' }]);
      const { params } = compiled(state.selectWheres[0]);
      expect(params).toEqual([RUN, 'pending']);
      expect(state.contextOpens).toBe(1);
    });
  });

  describe('summarizeDeliveries', () => {
    it('counts per state for one run, in its own system context when there is no ambient one', async () => {
      state.selectQueue.push([{ total: 5, sent: 2, failed: 1, unknown: 1, pending: 1 }]);
      expect(await summarizeDeliveries(RUN)).toEqual({ total: 5, sent: 2, failed: 1, unknown: 1, pending: 1 });
      const { params } = compiled(state.selectWheres[0]);
      expect(params).toEqual([RUN]);
      // A bare contextless read is a DENY under forced RLS, not a bypass.
      expect(state.contextOpens).toBe(1);
      expect(state.statementScopes).toEqual(['system']);
    });

    it('reads on the AMBIENT handle inside a request context (never a second pooled connection)', async () => {
      state.ambientContext = { scope: 'organization' };
      state.selectQueue.push([{ total: 1, sent: 1, failed: 0, unknown: 0, pending: 0 }]);
      await summarizeDeliveries(RUN);
      expect(state.contextOpens).toBe(0);
      expect(state.outsideExits).toBe(0);
      expect(state.statementScopes).toEqual(['organization']);
    });

    it('returns zeros for a run with no delivery rows', async () => {
      state.selectQueue.push([]);
      expect(await summarizeDeliveries(RUN)).toEqual({ total: 0, sent: 0, failed: 0, unknown: 0, pending: 0 });
    });
  });
});
