import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { refreshTokenFamilies, users } from '../../db/schema';
import {
  PendingMfaInvalidError,
  createPendingMfa,
  issueVerifiedPendingMfaSession,
  readPendingMfa,
} from '../../services/mfaAssurance';
import { closeRedis, getRedis } from '../../services/redis';
import { runLockedMfaMutation } from '../../services/mfaAssuranceMutation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('pending MFA issuance serialization against real PostgreSQL and Redis', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('waits for a locked epoch mutation, then rejects without creating a family', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const [enrolledUser] = await tdb
      .update(users)
      .set({ mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret' })
      .where(eq(users.id, user.id))
      .returning();
    expect(enrolledUser).toBeDefined();
    if (!enrolledUser) throw new Error('Integration user enrollment update returned no row');

    const tempToken = await createPendingMfa({
      userId: user.id,
      authEpoch: enrolledUser.authEpoch,
      mfaEpoch: enrolledUser.mfaEpoch,
      expectedStatus: 'active',
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      policyRequired: false,
      policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp']),
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
    });
    const expectedPending = await readPendingMfa(tempToken);
    expect(expectedPending).not.toBeNull();

    const mutationLocked = deferred();
    const allowMutationCommit = deferred();
    const mutation = runLockedMfaMutation({
      userId: user.id,
      partnerId: partner.id,
      authEpoch: enrolledUser.authEpoch,
      mfaEpoch: enrolledUser.mfaEpoch,
      reason: 'totp-factor-changed',
    }, async (tx) => {
      await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id));
      mutationLocked.resolve();
      await allowMutationCommit.promise;
    });
    await mutationLocked.promise;

    const issuance = issueVerifiedPendingMfaSession({
      tempToken,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    });
    const redis = getRedis();
    expect(redis).not.toBeNull();
    for (let attempt = 0; attempt < 100 && await redis!.exists(`mfa:pending:${tempToken}`); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await redis!.exists(`mfa:pending:${tempToken}`)).toBe(0);

    allowMutationCommit.resolve();
    await mutation;
    await expect(issuance).rejects.toBeInstanceOf(PendingMfaInvalidError);

    const families = await tdb
      .select({ familyId: refreshTokenFamilies.familyId })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(families).toEqual([]);
  });
});
