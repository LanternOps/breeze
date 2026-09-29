import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../redis', () => ({ getRedis: vi.fn() }));
vi.mock('../rate-limit', () => ({ rateLimiter: vi.fn(), assertOutsideHeldDbContextSafe: vi.fn() }));

import { getRedis } from '../redis';
import { assertOutsideHeldDbContextSafe, rateLimiter } from '../rate-limit';
import { checkDeployKeyRateBuckets } from './enrollmentRateBuckets';
import { DEPLOY_KEY_RATE } from './limits';

const redis = { fake: true } as any;
const allow = { allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) };
const deny = { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 90_000) };

describe('checkDeployKeyRateBuckets', () => {
  beforeEach(() => {
    vi.mocked(getRedis).mockReset().mockReturnValue(redis);
    vi.mocked(rateLimiter).mockReset().mockResolvedValue(allow);
    vi.mocked(assertOutsideHeldDbContextSafe).mockReset();
  });

  it('lets the held-DB-context guard throw through instead of turning it into a refusal', async () => {
    vi.mocked(assertOutsideHeldDbContextSafe).mockImplementationOnce(() => {
      throw new Error('ran inside a held withDbAccessContext transaction');
    });
    await expect(checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' }))
      .rejects.toThrow('held withDbAccessContext');
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('charges the per-key bucket, then the per-partner bucket, with the ruled limits', async () => {
    expect(await checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' })).toEqual({ allowed: true });
    expect(vi.mocked(rateLimiter).mock.calls).toEqual([
      [redis, 'deploy-key-enroll:key:key-1', DEPLOY_KEY_RATE.perKey.limit, DEPLOY_KEY_RATE.perKey.windowSeconds],
      [redis, 'deploy-key-enroll:partner:partner-1', DEPLOY_KEY_RATE.perPartner.limit, DEPLOY_KEY_RATE.perPartner.windowSeconds],
    ]);
  });

  it('refuses on the per-key limit without charging the partner bucket', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce(deny);
    const result = await checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' });
    expect(result).toMatchObject({ allowed: false, bucket: 'key' });
    expect(result.allowed === false && result.retryAfterSeconds).toBeGreaterThan(0);
    expect(rateLimiter).toHaveBeenCalledTimes(1);
  });

  it('refuses on the per-partner limit', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce(allow).mockResolvedValueOnce(deny);
    expect(await checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' }))
      .toMatchObject({ allowed: false, bucket: 'partner' });
  });

  it('fails closed when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null as any);
    expect(await checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' }))
      .toMatchObject({ allowed: false, bucket: 'unavailable' });
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('fails closed when the limiter throws', async () => {
    vi.mocked(rateLimiter).mockRejectedValueOnce(new Error('connection reset'));
    expect(await checkDeployKeyRateBuckets({ deployKeyId: 'key-1', partnerId: 'partner-1' }))
      .toMatchObject({ allowed: false, bucket: 'unavailable' });
  });
});
