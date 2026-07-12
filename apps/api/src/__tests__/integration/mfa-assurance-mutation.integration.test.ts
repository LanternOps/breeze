import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { refreshTokenFamilies, users } from '../../db/schema';
import {
  createPendingMfa,
  issueVerifiedPendingMfaSession,
  PendingMfaInvalidError,
  readPendingMfa,
} from '../../services/mfaAssurance';
import {
  invalidateMfaPolicyAssurance,
  MfaAssuranceMutationStaleError,
  runLockedMfaMutation,
} from '../../services/mfaAssuranceMutation';
import { mintRefreshTokenFamily, getActiveRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { closeRedis } from '../../services/redis';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seedPartnerMfaUser() {
  const tdb = getTestDb();
  const partner = await createPartner();
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, mfaEnabled: true });
  await assignUserToPartner(user.id, partner.id, role.id, 'all');
  const [enrolled] = await tdb.update(users).set({
    mfaMethod: 'totp',
    mfaSecret: 'integration-encrypted-secret',
  }).where(eq(users.id, user.id)).returning();
  if (!enrolled) throw new Error('Failed to seed MFA user');
  return { partner, role, user: enrolled };
}

async function pendingFor(input: Awaited<ReturnType<typeof seedPartnerMfaUser>>) {
  const tempToken = await createPendingMfa({
    userId: input.user.id,
    authEpoch: input.user.authEpoch,
    mfaEpoch: input.user.mfaEpoch,
    expectedStatus: 'active',
    roleId: input.role.id,
    orgId: null,
    partnerId: input.partner.id,
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
  if (!expectedPending) throw new Error('Pending MFA state was not stored');
  return { tempToken, expectedPending };
}

describe('MFA assurance mutation atomicity against real PostgreSQL', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('rolls factor state, epoch, and family revocation back together', async () => {
    const tdb = getTestDb();
    const seeded = await seedPartnerMfaUser();
    const familyId = await tdb.transaction((tx) => mintRefreshTokenFamily(seeded.user.id, { tx }));

    await expect(runLockedMfaMutation({
      userId: seeded.user.id,
      partnerId: seeded.partner.id,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      reason: 'totp-factor-changed',
    }, async (tx) => {
      await tx.update(users).set({ mfaMethod: 'sms' }).where(eq(users.id, seeded.user.id));
      throw new Error('inject rollback');
    })).rejects.toThrow('inject rollback');

    const [afterUser] = await tdb.select().from(users).where(eq(users.id, seeded.user.id));
    const [afterFamily] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(afterUser?.mfaMethod).toBe('totp');
    expect(afterUser?.mfaEpoch).toBe(seeded.user.mfaEpoch);
    expect(afterFamily?.revokedAt).toBeNull();
  });

  it('revokes a session family and makes its issued assurance stale when issuance wins first', async () => {
    const tdb = getTestDb();
    const seeded = await seedPartnerMfaUser();
    const pending = await pendingFor(seeded);
    const issued = await issueVerifiedPendingMfaSession({
      ...pending,
      verifiedMethod: 'totp',
    });

    await runLockedMfaMutation({
      userId: seeded.user.id,
      partnerId: seeded.partner.id,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      reason: 'totp-factor-changed',
    }, async (tx) => {
      await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, seeded.user.id));
    });

    const [afterUser] = await tdb.select().from(users).where(eq(users.id, seeded.user.id));
    const activeFamily = await getActiveRefreshTokenFamily(issued.tokens.familyId, seeded.user.id);
    expect(afterUser?.mfaEpoch).toBe(seeded.user.mfaEpoch + 1);
    expect(activeFamily).toBeNull();
  });

  it('rejects pending issuance after a partner policy mutation wins first', async () => {
    const seeded = await seedPartnerMfaUser();
    const pending = await pendingFor(seeded);
    const tdb = getTestDb();

    const mutationLocked = deferred();
    const allowCommit = deferred();
    const mutation = tdb.transaction(async (tx) => {
      await invalidateMfaPolicyAssurance(tx, {
        partnerId: seeded.partner.id,
        reason: 'partner-mfa-policy-changed',
      });
      mutationLocked.resolve();
      await allowCommit.promise;
    });
    await mutationLocked.promise;

    const issuance = issueVerifiedPendingMfaSession({
      ...pending,
      verifiedMethod: 'totp',
    });
    const rejectedIssuance = expect(issuance).rejects.toBeInstanceOf(PendingMfaInvalidError);
    allowCommit.resolve();
    await mutation;
    await rejectedIssuance;
  });

  it('rejects pending issuance after a factor mutation wins first', async () => {
    const seeded = await seedPartnerMfaUser();
    const pending = await pendingFor(seeded);

    await runLockedMfaMutation({
      userId: seeded.user.id,
      partnerId: seeded.partner.id,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      reason: 'totp-factor-changed',
    }, async () => undefined);

    await expect(issueVerifiedPendingMfaSession({
      ...pending,
      verifiedMethod: 'totp',
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);
  });

  it('revokes the issued family when session issuance wins before policy mutation', async () => {
    const seeded = await seedPartnerMfaUser();
    const pending = await pendingFor(seeded);
    const issued = await issueVerifiedPendingMfaSession({
      ...pending,
      verifiedMethod: 'totp',
    });

    await getTestDb().transaction((tx) => invalidateMfaPolicyAssurance(tx, {
      partnerId: seeded.partner.id,
      reason: 'partner-mfa-policy-changed',
    }));

    await expect(getActiveRefreshTokenFamily(issued.tokens.familyId, seeded.user.id))
      .resolves.toBeNull();
  });

  it('organization policy invalidation affects only current members of that organization', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const roleA = await createRole({ scope: 'organization', partnerId: partner.id, orgId: orgA.id });
    const roleB = await createRole({ scope: 'organization', partnerId: partner.id, orgId: orgB.id });
    const userA = await createUser({ partnerId: partner.id, orgId: orgA.id });
    const userB = await createUser({ partnerId: partner.id, orgId: orgB.id });
    await assignUserToOrganization(userA.id, orgA.id, roleA.id);
    await assignUserToOrganization(userB.id, orgB.id, roleB.id);
    const familyA = await tdb.transaction((tx) => mintRefreshTokenFamily(userA.id, { tx }));
    const familyB = await tdb.transaction((tx) => mintRefreshTokenFamily(userB.id, { tx }));

    const result = await tdb.transaction((tx) => invalidateMfaPolicyAssurance(tx, {
      partnerId: partner.id,
      orgId: orgA.id,
      reason: 'organization-mfa-policy-changed',
    }));

    const [afterA] = await tdb.select().from(users).where(eq(users.id, userA.id));
    const [afterB] = await tdb.select().from(users).where(eq(users.id, userB.id));
    expect(result.userIds).toEqual([userA.id]);
    expect(afterA?.mfaEpoch).toBe(userA.mfaEpoch + 1);
    expect(afterB?.mfaEpoch).toBe(userB.mfaEpoch);
    await expect(getActiveRefreshTokenFamily(familyA, userA.id)).resolves.toBeNull();
    await expect(getActiveRefreshTokenFamily(familyB, userB.id)).resolves.not.toBeNull();
  });

  it('serializes two competing locked mutations without deadlock and permits one epoch winner', async () => {
    const seeded = await seedPartnerMfaUser();
    const input = {
      userId: seeded.user.id,
      partnerId: seeded.partner.id,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      reason: 'factor-race',
    };
    const race = Promise.allSettled([
      runLockedMfaMutation(input, async () => undefined),
      runLockedMfaMutation(input, async () => undefined),
    ]);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MFA lock-order race timed out')), 5_000);
    });
    const results = await Promise.race([race, timeout]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(MfaAssuranceMutationStaleError) });
  });
});
