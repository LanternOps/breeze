import { afterAll, describe, expect, it } from 'vitest';
import {
  consumePendingMfa,
  createPendingMfa,
  readPendingMfa,
} from '../../services/mfaAssurance';
import { closeRedis, getRedis } from '../../services/redis';

describe('pending MFA Redis atomicity', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('stores a five-minute V2 record and gives exactly one concurrent GETDEL consumer the record', async () => {
    const tempToken = await createPendingMfa({
      userId: 'real-redis-user',
      authEpoch: 3,
      mfaEpoch: 9,
      expectedStatus: 'active',
      roleId: null,
      orgId: null,
      partnerId: null,
      scope: 'system',
      policyRequired: true,
      policySources: ['role'],
      allowedMethods: new Set(['totp', 'recovery_code']),
      enrolledMethods: new Set(['totp']),
      primaryAuthenticationMethod: 'password',
      primaryMfaMethod: 'totp',
    });
    const key = `mfa:pending:${tempToken}`;
    const redis = getRedis();
    expect(redis).not.toBeNull();
    expect(await redis!.ttl(key)).toBeGreaterThanOrEqual(298);
    expect(await readPendingMfa(tempToken)).toMatchObject({
      version: 2,
      userId: 'real-redis-user',
      authEpoch: 3,
      mfaEpoch: 9,
    });

    const results = await Promise.all(Array.from(
      { length: 12 },
      () => consumePendingMfa(tempToken),
    ));

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(11);
    expect(await redis!.exists(key)).toBe(0);
  });
});
