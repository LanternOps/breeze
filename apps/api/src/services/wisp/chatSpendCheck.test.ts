import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * services/wisp/chatSpendCheck.ts — #10414 (spec §4.2 Option 2): after a Wisp
 * chat turn settles, tell the grantor once per window when today's spend
 * (chat included) has reached the grant budget. Throttled by a Redis NX key to
 * at most one spend query per grant per 5 minutes; never throws for Redis.
 */
const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  getRedis: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  spendSummary: vi.fn(),
  notifyBudgetExhaustedOnce: vi.fn(),
  chargeableUnderGrant: vi.fn(),
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('../redis', () => ({ getRedis: h.getRedis }));
vi.mock('./budget', async (orig) => ({
  ...(await orig<typeof import('./budget')>()),
  spendSummary: h.spendSummary,
  notifyBudgetExhaustedOnce: h.notifyBudgetExhaustedOnce,
  chargeableUnderGrant: h.chargeableUnderGrant,
}));

import {
  CHAT_SPEND_CHECK_KEY_PREFIX,
  CHAT_SPEND_CHECK_TTL_SECONDS,
  maybeNotifyChatCrossedBudget,
} from './chatSpendCheck';

const GRANT = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2027-02-01T23:58:00.000Z');

const summary = (spentTodayCents: number, budgetCentsPerDay: number) => ({
  spentTodayCents, backgroundCents: 0, chatCents: spentTodayCents, budgetCentsPerDay,
  budgetResetsAt: new Date('2027-02-02T00:00:00.000Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.getRedis.mockReturnValue({ set: h.redisSet, del: h.redisDel });
  h.redisSet.mockResolvedValue('OK');
  h.redisDel.mockResolvedValue(1);
  h.notifyBudgetExhaustedOnce.mockResolvedValue(true);
});

describe('maybeNotifyChatCrossedBudget', () => {
  it('claims a per-grant, per-UTC-day key with SET NX EX 300 before reading spend', async () => {
    h.spendSummary.mockResolvedValue(summary(10, 500));
    await maybeNotifyChatCrossedBudget(GRANT, NOW);
    expect(CHAT_SPEND_CHECK_TTL_SECONDS).toBe(300);
    expect(h.redisSet).toHaveBeenCalledWith(`${CHAT_SPEND_CHECK_KEY_PREFIX}${GRANT}:2027-02-01`, '1', 'EX', 300, 'NX');
    expect(CHAT_SPEND_CHECK_KEY_PREFIX).toBe('wisp:chat-spend-check:');
    expect(h.redisSet.mock.invocationCallOrder[0]).toBeLessThan(h.spendSummary.mock.invocationCallOrder[0]!);
  });

  it("'skipped' when the key is already held: no spend query (at most one per grant per 5 minutes)", async () => {
    h.redisSet.mockResolvedValue(null);
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('skipped');
    expect(h.spendSummary).not.toHaveBeenCalled();
    expect(h.notifyBudgetExhaustedOnce).not.toHaveBeenCalled();
  });

  it("'notified' when today's spend has reached the budget: the once-per-window notice is asked for once", async () => {
    h.spendSummary.mockResolvedValue(summary(500, 500));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('notified');
    expect(h.spendSummary).toHaveBeenCalledWith(GRANT, NOW);
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledTimes(1);
    expect(h.notifyBudgetExhaustedOnce).toHaveBeenCalledWith(GRANT, NOW);
  });

  it("'under' when the spend is below the budget, and no notice", async () => {
    h.spendSummary.mockResolvedValue(summary(499, 500));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('under');
    expect(h.notifyBudgetExhaustedOnce).not.toHaveBeenCalled();
  });

  it("'skipped' with no throw when Redis is unavailable (no client, or the SET rejects)", async () => {
    h.getRedis.mockReturnValue(null);
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('skipped');
    h.getRedis.mockReturnValue({ set: h.redisSet });
    h.redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('skipped');
    expect(h.spendSummary).not.toHaveBeenCalled();
  });

  it("'skipped' and touches nothing when Wisp is off (dark)", async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('skipped');
    expect(h.getRedis).not.toHaveBeenCalled();
    expect(h.spendSummary).not.toHaveBeenCalled();
  });

  it('never asks whether chat is chargeable: chat is never refused by the grant budget', async () => {
    h.spendSummary.mockResolvedValue(summary(9999, 500));
    await maybeNotifyChatCrossedBudget(GRANT, NOW);
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
  });

  it('a spend-read failure propagates to the caller (which reports it off the response path)', async () => {
    const err = new Error('db down');
    h.spendSummary.mockRejectedValue(err);
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).rejects.toBe(err);
  });

  it('a failed spend read or notice releases the throttle key, so the next turn can retry', async () => {
    const del = vi.fn().mockResolvedValue(1);
    h.getRedis.mockReturnValue({ set: h.redisSet, del });
    h.spendSummary.mockRejectedValueOnce(new Error('db down'));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).rejects.toThrow('db down');
    expect(del).toHaveBeenCalledWith(`${CHAT_SPEND_CHECK_KEY_PREFIX}${GRANT}:2027-02-01`);

    del.mockClear();
    h.spendSummary.mockResolvedValue(summary(600, 500));
    h.notifyBudgetExhaustedOnce.mockRejectedValueOnce(new Error('deliver failed'));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).rejects.toThrow('deliver failed');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('a successful check keeps the key (the 5-minute throttle holds)', async () => {
    const del = vi.fn().mockResolvedValue(1);
    h.getRedis.mockReturnValue({ set: h.redisSet, del });
    h.spendSummary.mockResolvedValue(summary(10, 500));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('under');
    expect(del).not.toHaveBeenCalled();
  });

  it('a release that itself fails never masks the original error', async () => {
    const del = vi.fn().mockRejectedValue(new Error('redis gone'));
    h.getRedis.mockReturnValue({ set: h.redisSet, del });
    const err = new Error('db down');
    h.spendSummary.mockRejectedValueOnce(err);
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).rejects.toBe(err);
  });

  it('a throttle SET that rejects is logged, not swallowed silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(maybeNotifyChatCrossedBudget(GRANT, NOW)).resolves.toBe('skipped');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat spend check'), expect.stringContaining('ECONNREFUSED'));
    warn.mockRestore();
  });
});
