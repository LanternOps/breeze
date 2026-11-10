import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * jobs/aiChatSessionExpirySweep.ts (#11430) — the 15-minute sweep that retires
 * chat sessions nobody will send to again. Expiry used to be lazy (only the
 * next send stamped it), and an API restart drops the in-memory eviction, so a
 * row idle for days stayed 'active' and its Wisp thread was never summarised.
 * The SQL predicate itself is proven against real Postgres in
 * __tests__/integration/aiChatSessionExpirySweep.integration.test.ts.
 */
const h = vi.hoisted(() => ({
  candidates: [] as Array<{ id: string }>,
  updated: [] as Array<{ id: string }>,
  finalize: vi.fn(async (_id: string) => ({ updated: true })),
  captureException: vi.fn(),
  systemContext: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  limit: vi.fn(),
  selectWhere: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('../db', () => ({
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => { void work(); }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
    h.systemContext(label);
    return fn();
  }),
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (cond: unknown) => {
          h.selectWhere(cond);
          return {
            orderBy: () => ({
              limit: (n: number) => {
                h.limit(n);
                return Promise.resolve(h.candidates);
              },
            }),
          };
        },
      }),
    })),
    update: (...args: unknown[]) => {
      h.update(...args);
      return {
        set: (values: unknown) => {
          h.set(values);
          return { where: (cond: unknown) => { h.updateWhere(cond); return { returning: () => Promise.resolve(h.updated) }; } };
        },
      };
    },
  },
}));
vi.mock('../services/wisp/threadSummary', () => ({ finalizeWispSessionSummary: h.finalize }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN, sweepIdleChatSessions } from './aiChatSessionExpirySweep';

const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as SQL);

beforeEach(() => {
  vi.clearAllMocks();
  h.candidates = [];
  h.updated = [];
  h.finalize.mockImplementation(async () => ({ updated: true }));
});

describe('sweepIdleChatSessions (#11430)', () => {
  it('expires the stale chat sessions in system context and finalizes each one it flipped', async () => {
    h.candidates = [{ id: 's-stale-1' }, { id: 's-stale-2' }];
    h.updated = [{ id: 's-stale-1' }, { id: 's-stale-2' }];

    const result = await sweepIdleChatSessions();

    expect(result).toEqual({ scanned: 2, expired: 2, capped: false });
    expect(h.systemContext).toHaveBeenCalledWith('aiChatSessionExpirySweep.expire');
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(h.limit).toHaveBeenCalledWith(AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN);
    expect(h.finalize.mock.calls.map(([id]) => id).sort()).toEqual(['s-stale-1', 's-stale-2']);
  });

  it('selects only active technician chat sessions past a limit with no turn running, and the UPDATE re-applies all of it', async () => {
    h.candidates = [{ id: 's-stale' }];
    h.updated = [{ id: 's-stale' }];
    const now = new Date('2026-11-08T12:00:00.000Z');

    await sweepIdleChatSessions(now);

    const select = render(h.selectWhere.mock.calls[0]![0]);
    for (const clause of [
      '"ai_sessions"."status" = $',
      '"ai_sessions"."type" in (',
      '"ai_sessions"."user_id" is not null',
      '"ai_sessions"."last_activity_at" < $',
      '"ai_sessions"."created_at" < $',
      'NOT EXISTS (',
      '"ai_budget_reservations"."org_id" = "ai_sessions"."org_id"',
      '"ai_budget_reservations"."session_id" = "ai_sessions"."id"',
      '"ai_budget_reservations"."created_at" > now() - make_interval(secs => ',
      '"ai_budget_reservations"."pending_settlement" IS NULL',
      '"ai_budget_reservations"."expiry_reason" = \'active_ttl\'',
    ]) {
      expect(select.sql).toContain(clause);
    }
    expect(select.params).toEqual(expect.arrayContaining([
      'active', 'general', 'topology',
      '2026-11-08T10:00:00.000Z', // idle window: 2 h
      '2026-11-07T12:00:00.000Z', // age cap: 24 h
      3660, // the longest turn: a 60-min approval wait + 1 min
    ]));
    // A turn admitted, or a close, between the SELECT and the UPDATE must win.
    const update = render(h.updateWhere.mock.calls[0]![0]);
    const placeholders = (s: string) => s.replace(/\$\d+/g, '$?');
    expect(update.sql).toContain('"ai_sessions"."id" in (');
    expect(placeholders(update.sql)).toContain(placeholders(select.sql));
    expect(update.params).toEqual(['s-stale', ...select.params]);
  });

  it('finalizes only the rows the guarded UPDATE returned (a send that raced the sweep keeps its session)', async () => {
    h.candidates = [{ id: 's-stale' }, { id: 's-raced' }];
    h.updated = [{ id: 's-stale' }];

    const result = await sweepIdleChatSessions();

    expect(result).toEqual({ scanned: 2, expired: 1, capped: false });
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.finalize).toHaveBeenCalledWith('s-stale');
  });

  it('with nothing stale it writes nothing and finalizes nothing', async () => {
    const result = await sweepIdleChatSessions();

    expect(result).toEqual({ scanned: 0, expired: 0, capped: false });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('reports a full batch as capped so a growing backlog is visible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.candidates = Array.from({ length: AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN }, (_, i) => ({ id: `s-${i}` }));
    h.updated = h.candidates;

    const result = await sweepIdleChatSessions();

    expect(result).toMatchObject({ expired: AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN, capped: true });
    expect(warn.mock.calls.some((args) => String(args[0]).includes('cap'))).toBe(true);
    warn.mockRestore();
  });

  it('a failed summary finalize is captured and never fails the sweep or the other sessions', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.candidates = [{ id: 's-a' }, { id: 's-b' }];
    h.updated = [{ id: 's-a' }, { id: 's-b' }];
    const boom = new Error('summary boom');
    h.finalize.mockImplementation(async (id: string) => {
      if (id === 's-a') throw boom;
      return { updated: true };
    });

    await expect(sweepIdleChatSessions()).resolves.toMatchObject({ expired: 2 });
    expect(h.finalize).toHaveBeenCalledWith('s-b');
    expect(h.captureException).toHaveBeenCalledWith(boom);
    err.mockRestore();
  });
});
