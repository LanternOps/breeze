// apps/api/src/services/scriptProposals/reviewConcurrency.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_ID = '00000000-0000-4000-8000-0000000000f1';

const shared = vi.hoisted(() => ({
  evalMock: vi.fn<(script: string, numKeys: number, ...args: unknown[]) => Promise<number>>(),
  redisAvailable: true,
}));

vi.mock('../redis', () => ({
  getRedis: () => (shared.redisAvailable ? { eval: shared.evalMock } : null),
}));

import { releaseOrgReviewSlot, SCRIPT_REVIEW_ORG_CONCURRENCY, tryAcquireOrgReviewSlot } from './reviewConcurrency';

describe('tryAcquireOrgReviewSlot', () => {
  beforeEach(() => {
    shared.evalMock.mockReset();
    shared.redisAvailable = true;
  });

  it('the spec §4.4 cap is 3', () => {
    expect(SCRIPT_REVIEW_ORG_CONCURRENCY).toBe(3);
  });

  it('acquires when the Lua script reports success', async () => {
    shared.evalMock.mockResolvedValueOnce(1);
    await expect(tryAcquireOrgReviewSlot(ORG_ID)).resolves.toBe(true);
    const [, numKeys, key, cap] = shared.evalMock.mock.calls[0]!;
    expect(numKeys).toBe(1);
    expect(key).toBe(`script-review:concurrency:${ORG_ID}`);
    expect(cap).toBe('3');
  });

  it('refuses when the org is already at the cap', async () => {
    shared.evalMock.mockResolvedValueOnce(0);
    await expect(tryAcquireOrgReviewSlot(ORG_ID)).resolves.toBe(false);
  });

  it('respects a caller-supplied cap', async () => {
    shared.evalMock.mockResolvedValueOnce(1);
    await tryAcquireOrgReviewSlot(ORG_ID, 5);
    const [, , , cap] = shared.evalMock.mock.calls[0]!;
    expect(cap).toBe('5');
  });

  it('fails OPEN (returns true) when Redis is unavailable', async () => {
    shared.redisAvailable = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(tryAcquireOrgReviewSlot(ORG_ID)).resolves.toBe(true);
    expect(shared.evalMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('releaseOrgReviewSlot', () => {
  beforeEach(() => {
    shared.evalMock.mockReset();
    shared.redisAvailable = true;
  });

  it('decrements via the release script', async () => {
    shared.evalMock.mockResolvedValueOnce(1);
    await releaseOrgReviewSlot(ORG_ID);
    const [, numKeys, key] = shared.evalMock.mock.calls[0]!;
    expect(numKeys).toBe(1);
    expect(key).toBe(`script-review:concurrency:${ORG_ID}`);
  });

  it('is a no-op when Redis is unavailable', async () => {
    shared.redisAvailable = false;
    await releaseOrgReviewSlot(ORG_ID);
    expect(shared.evalMock).not.toHaveBeenCalled();
  });
});
