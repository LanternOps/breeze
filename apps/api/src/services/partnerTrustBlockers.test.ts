import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redis, getRedis } = vi.hoisted(() => {
  const redis = { set: vi.fn(), mget: vi.fn() };
  return { redis, getRedis: vi.fn(() => redis as typeof redis | null) };
});
vi.mock('./redis', () => ({ getRedis }));

import { readPromotionBlockers, recordPromotionBlockers } from './partnerTrustBlockers';

describe('partnerTrustBlockers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedis.mockReturnValue(redis);
  });

  it('records blockers with an evaluation time and an expiry', async () => {
    await recordPromotionBlockers('p1', ['card_not_settled']);
    expect(redis.set).toHaveBeenCalledWith('partner-trust:blockers:v1:p1', expect.any(String), 'EX', 3600);
    const stored = JSON.parse(redis.set.mock.calls[0]![1] as string);
    expect(stored).toEqual({ blockers: ['card_not_settled'], evaluatedAt: expect.any(String) });
  });

  it('reads recorded entries and drops missing or malformed ones', async () => {
    redis.mget.mockResolvedValue([
      JSON.stringify({ blockers: ['too_young'], evaluatedAt: '2026-11-11T00:00:00.000Z' }),
      null,
      '{not json',
      JSON.stringify({ blockers: 'nope', evaluatedAt: 1 }),
    ]);

    const result = await readPromotionBlockers(['p1', 'p2', 'p3', 'p4']);
    expect(redis.mget).toHaveBeenCalledWith(
      'partner-trust:blockers:v1:p1', 'partner-trust:blockers:v1:p2',
      'partner-trust:blockers:v1:p3', 'partner-trust:blockers:v1:p4',
    );
    expect([...result.entries()]).toEqual([['p1', { blockers: ['too_young'], evaluatedAt: '2026-11-11T00:00:00.000Z' }]]);
  });

  it('returns an empty map when Redis is unavailable or fails, without calling it for no ids', async () => {
    await expect(readPromotionBlockers([])).resolves.toEqual(new Map());
    expect(redis.mget).not.toHaveBeenCalled();

    redis.mget.mockRejectedValue(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readPromotionBlockers(['p1'])).resolves.toEqual(new Map());
    warn.mockRestore();

    getRedis.mockReturnValue(null);
    await expect(readPromotionBlockers(['p1'])).resolves.toEqual(new Map());
    await expect(recordPromotionBlockers('p1', [])).resolves.toBeUndefined();
  });
});
