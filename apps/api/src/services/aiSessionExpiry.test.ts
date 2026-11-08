import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * services/aiSessionExpiry.ts (#11430) — the one session-lifetime rule shared by
 * the send pre-flight, the session read, the in-memory eviction and the idle
 * sweep. The schema is real so the guarded UPDATE's WHERE can be rendered.
 */
const h = vi.hoisted(() => ({
  where: vi.fn(),
  set: vi.fn(),
  returned: [] as Array<{ id: string }>,
  finalize: vi.fn(async (_id: string) => ({ updated: true })),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => { void work(); }),
  db: {
    update: vi.fn(() => ({
      set: (values: unknown) => {
        h.set(values);
        return {
          where: (cond: unknown) => {
            h.where(cond);
            // Awaited directly (pre-flight) or through .returning() (unlessTurnInFlight).
            return Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve(h.returned) });
          },
        };
      },
    })),
  },
}));
vi.mock('./wisp/threadSummary', () => ({ finalizeWispSessionSummary: h.finalize }));
vi.mock('./sentry', () => ({ captureException: h.captureException }));

import { db } from '../db';
import { SESSION_IDLE_TIMEOUT_MS, SESSION_MAX_AGE_MS } from './aiAgentSessionLimits';
import {
  expireIfStale,
  finalizeWispSummaries,
  isExpirableChatSession,
  sessionExpiredError,
  sessionExpiryCutoffs,
  sessionExpiryReason,
} from './aiSessionExpiry';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

/** noTurnInFlight(): an unsettled reservation of this session admitted within the longest turn. */
const TURN_IN_FLIGHT_CLAUSES = [
  '"ai_budget_reservations"."org_id" = "ai_sessions"."org_id"',
  '"ai_budget_reservations"."session_id" = "ai_sessions"."id"',
  '"ai_budget_reservations"."created_at" > now() - make_interval(secs => ',
  '"ai_budget_reservations"."pending_settlement" IS NULL',
  '"ai_budget_reservations"."status" = \'active\'',
  '"ai_budget_reservations"."status" = \'expired\' AND "ai_budget_reservations"."expiry_reason" = \'active_ttl\'',
];
const ago = (ms: number) => new Date(NOW - ms);
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  h.returned = [];
  h.finalize.mockImplementation(async () => ({ updated: true }));
});

describe('sessionExpiryReason', () => {
  it('is live up to and including both limits, expired one millisecond past either', () => {
    expect(sessionExpiryReason({ createdAt: ago(SESSION_MAX_AGE_MS), lastActivityAt: ago(SESSION_IDLE_TIMEOUT_MS) }, NOW)).toBeNull();
    expect(sessionExpiryReason({ createdAt: ago(SESSION_MAX_AGE_MS + 1), lastActivityAt: ago(0) }, NOW)).toBe('max_age');
    expect(sessionExpiryReason({ createdAt: ago(0), lastActivityAt: ago(SESSION_IDLE_TIMEOUT_MS + 1) }, NOW)).toBe('idle');
  });

  it('reports the 24 h cap first when both limits are past', () => {
    expect(sessionExpiryReason({ createdAt: ago(72 * 3_600_000), lastActivityAt: ago(72 * 3_600_000) }, NOW)).toBe('max_age');
  });

  it('reads Date, ISO string and epoch-ms timestamps alike', () => {
    const stale = NOW - SESSION_IDLE_TIMEOUT_MS - 1;
    expect(sessionExpiryReason({ createdAt: new Date(NOW), lastActivityAt: new Date(stale) }, NOW)).toBe('idle');
    expect(sessionExpiryReason({ createdAt: new Date(NOW).toISOString(), lastActivityAt: new Date(stale).toISOString() }, NOW)).toBe('idle');
    expect(sessionExpiryReason({ createdAt: NOW, lastActivityAt: stale }, NOW)).toBe('idle');
  });

  it('never expires a session on an unreadable timestamp alone', () => {
    expect(sessionExpiryReason({ createdAt: 'not a date', lastActivityAt: 'garbage' }, NOW)).toBeNull();
    expect(sessionExpiryReason({ createdAt: 'not a date', lastActivityAt: ago(SESSION_IDLE_TIMEOUT_MS + 1) }, NOW)).toBe('idle');
  });

  it('agrees with the SQL cutoffs the sweep uses (strictly before = expired)', () => {
    const { createdBefore, idleBefore } = sessionExpiryCutoffs(NOW);
    expect(sessionExpiryReason({ createdAt: createdBefore, lastActivityAt: idleBefore }, NOW)).toBeNull();
    expect(sessionExpiryReason({ createdAt: new Date(createdBefore.getTime() - 1), lastActivityAt: ago(0) }, NOW)).toBe('max_age');
    expect(sessionExpiryReason({ createdAt: ago(0), lastActivityAt: new Date(idleBefore.getTime() - 1) }, NOW)).toBe('idle');
  });
});

describe('sessionExpiredError', () => {
  it('words both reasons with "expired", which the send route maps to 410', () => {
    expect(sessionExpiredError('max_age')).toMatch(/expired.*24h/);
    expect(sessionExpiredError('idle')).toMatch(/expired.*inactivity/);
  });
});

describe('isExpirableChatSession', () => {
  it.each([
    [{ type: 'general', userId: 'u-1' }, true],
    [{ type: 'topology', userId: 'u-1' }, true],
    [{ type: 'general', userId: null }, false], // a Helper session: its own lifecycle
    [{ type: 'mcp', userId: 'u-1' }, false],
    [{ type: 'script_builder', userId: 'u-1' }, false],
    [{ type: 'agent', userId: null }, false],
  ])('%o -> %s', (session, expected) => {
    expect(isExpirableChatSession(session)).toBe(expected);
  });
});

describe('expireIfStale', () => {
  it('stamps a stale active session expired, guarded on status active, and finalizes its summary', async () => {
    const reason = await expireIfStale({ id: 's-1', status: 'active', createdAt: ago(0), lastActivityAt: ago(3 * 3_600_000) }, NOW);

    expect(reason).toBe('idle');
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    const { sql, params } = dialect.sqlToQuery(h.where.mock.calls[0]![0] as SQL);
    expect(sql).toBe('("ai_sessions"."id" = $1 and "ai_sessions"."status" = $2)');
    expect(params).toEqual(['s-1', 'active']);
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledWith('s-1'));
  });

  it.each(['closed', 'expired'])('leaves a %s session alone, however old', async (status) => {
    const reason = await expireIfStale({ id: 's-1', status, createdAt: ago(72 * 3_600_000), lastActivityAt: ago(72 * 3_600_000) }, NOW);

    expect(reason).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('leaves a live session alone', async () => {
    expect(await expireIfStale({ id: 's-1', status: 'active', createdAt: ago(0), lastActivityAt: ago(60_000) }, NOW)).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  describe('unlessTurnInFlight (the session read)', () => {
    const stale = { id: 's-1', status: 'active', createdAt: ago(0), lastActivityAt: ago(3 * 3_600_000) };

    it('also requires no live budget reservation (a running turn), and reports the expiry when it flipped the row', async () => {
      h.returned = [{ id: 's-1' }];

      expect(await expireIfStale(stale, NOW, { unlessTurnInFlight: true })).toBe('idle');

      const { sql } = dialect.sqlToQuery(h.where.mock.calls[0]![0] as SQL);
      expect(sql).toContain('"ai_sessions"."id" = $1 and "ai_sessions"."status" = $2');
      expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "ai_budget_reservations"/);
      for (const clause of TURN_IN_FLIGHT_CLAUSES) expect(sql).toContain(clause);
      await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledWith('s-1'));
    });

    it('reports nothing and finalizes nothing when the guarded UPDATE matched no row (turn running, or closed meanwhile)', async () => {
      h.returned = [];

      expect(await expireIfStale(stale, NOW, { unlessTurnInFlight: true })).toBeNull();
      expect(h.finalize).not.toHaveBeenCalled();
    });
  });
});

describe('finalizeWispSummaries', () => {
  it('finalizes every id, a few at a time, and one failure neither rejects nor stops the rest', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('summary boom');
    h.finalize.mockImplementation(async (id: string) => {
      if (id === 's-2') throw boom;
      return { updated: true };
    });
    const ids = ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'];

    await expect(finalizeWispSummaries(ids)).resolves.toBeUndefined();

    expect(h.finalize.mock.calls.map(([id]) => id)).toEqual(ids);
    expect(h.captureException).toHaveBeenCalledWith(boom);
    expect(err.mock.calls.some((args) => String(args[0]).includes('s-2'))).toBe(true);
    err.mockRestore();
  });

  it('does nothing for an empty batch', async () => {
    await finalizeWispSummaries([]);
    expect(h.finalize).not.toHaveBeenCalled();
  });
});
