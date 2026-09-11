/**
 * Real PostgreSQL + Redis proof for installation-scoped mobile revocation.
 * Synthetic principals only; the test stack is disposable.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { refreshTokenFamilies } from '../../db/schema';
import { revokeMobileDeviceRefreshFamilies } from '../../services/authLifecycle';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { getRedis } from '../../services/redis';
import { publishFamilyRevocationSentinel } from '../../services/tokenRevocation';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const sentinelKeys: string[] = [];

afterEach(async () => {
  const redis = getRedis();
  if (redis && sentinelKeys.length > 0) await redis.del(...sentinelKeys.splice(0));
});

describe('mobile installation refresh-family revocation', () => {
  it('revokes only the caller-owned target installation and publishes its sentinel', async () => {
    const partner = await createPartner();
    const userA = await createUser({ partnerId: partner.id, status: 'active' });
    const userB = await createUser({ partnerId: partner.id, status: 'active' });
    const targetInstallation = `test-install-${randomUUID()}`;

    const targetFamily = await mintRefreshTokenFamily(userA.id, randomUUID(), {
      mobileDeviceId: targetInstallation,
    });
    const otherDeviceFamily = await mintRefreshTokenFamily(userA.id, randomUUID(), {
      mobileDeviceId: `other-install-${randomUUID()}`,
    });
    const otherUserFamily = await mintRefreshTokenFamily(userB.id, randomUUID(), {
      mobileDeviceId: targetInstallation,
    });

    const context = {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
      userId: userA.id,
      currentPartnerId: partner.id,
    };

    // Shape-6 RLS must make a forged cross-user revoke a zero-row operation,
    // even when the installation string is identical.
    const forged = await withDbAccessContext(context, () =>
      db.transaction((tx) => revokeMobileDeviceRefreshFamilies(
        tx,
        userB.id,
        targetInstallation,
        'mobile-device-blocked',
      ))
    );
    expect(forged).toEqual([]);

    const revoked = await withDbAccessContext(context, () =>
      db.transaction((tx) => revokeMobileDeviceRefreshFamilies(
        tx,
        userA.id,
        targetInstallation,
        'mobile-device-blocked',
      ))
    );
    expect(revoked).toEqual([targetFamily]);

    const rows = await getTestDb()
      .select({
        familyId: refreshTokenFamilies.familyId,
        revokedAt: refreshTokenFamilies.revokedAt,
        revokedReason: refreshTokenFamilies.revokedReason,
      })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, userA.id));
    const byId = new Map(rows.map((row) => [row.familyId, row]));
    expect(byId.get(targetFamily)).toMatchObject({
      revokedAt: expect.any(Date),
      revokedReason: 'mobile-device-blocked',
    });
    expect(byId.get(otherDeviceFamily)?.revokedAt).toBeNull();

    const [foreignRow] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, otherUserFamily))
      .limit(1);
    expect(foreignRow?.revokedAt).toBeNull();

    expect(await publishFamilyRevocationSentinel(targetFamily)).toBe(true);
    const sentinelKey = `refresh-fam-revoked:${targetFamily}`;
    sentinelKeys.push(sentinelKey);
    expect(await getRedis()?.get(sentinelKey)).toBe('1');
  });
});
