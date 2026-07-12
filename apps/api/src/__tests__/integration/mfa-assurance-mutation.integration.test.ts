import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { partners, refreshTokenFamilies, users } from '../../db/schema';
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
import {
  consumeMfaStepUpGrant,
  issueMfaStepUpGrant,
  MfaStepUpGrantInvalidError,
  readMfaStepUpGrant,
} from '../../routes/auth/helpers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedRefreshFamilyInsert(): Promise<void> {
  const tdb = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await tdb.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position('insert into "refresh_token_families"' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Pending issuance never reached the blocked refresh-family insert');
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

  it('rolls policy settings, member epochs, and family revocation back together', async () => {
    const tdb = getTestDb();
    const seeded = await seedPartnerMfaUser();
    const originalSettings = { security: { allowedMethods: { totp: true, passkey: true } } };
    await tdb.update(partners).set({ settings: originalSettings }).where(eq(partners.id, seeded.partner.id));
    const familyId = await tdb.transaction((tx) => mintRefreshTokenFamily(seeded.user.id, { tx }));

    await expect(tdb.transaction(async (tx) => {
      await tx.update(partners).set({
        settings: { security: { allowedMethods: { passkey: true } } },
      }).where(eq(partners.id, seeded.partner.id));
      await invalidateMfaPolicyAssurance(tx, {
        partnerId: seeded.partner.id,
        reason: 'partner-mfa-policy-changed',
      });
      throw new Error('inject policy rollback');
    })).rejects.toThrow('inject policy rollback');

    const [afterPartner] = await tdb.select().from(partners).where(eq(partners.id, seeded.partner.id));
    const [afterUser] = await tdb.select().from(users).where(eq(users.id, seeded.user.id));
    const [afterFamily] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(afterPartner?.settings).toEqual(originalSettings);
    expect(afterUser?.mfaEpoch).toBe(seeded.user.mfaEpoch);
    expect(afterFamily?.revokedAt).toBeNull();
  });

  it('burns SMS replacement proof while rolling back the DB mutation and assurance invalidation', async () => {
    const tdb = getTestDb();
    const seeded = await seedPartnerMfaUser();
    const familyId = await tdb.transaction((tx) => mintRefreshTokenFamily(seeded.user.id, { tx }));
    const binding = {
      purpose: 'sms.replace' as const,
      userId: seeded.user.id,
      sessionId: familyId,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      verifiedMethod: 'totp' as const,
    };
    const grant = await issueMfaStepUpGrant(binding);

    await expect(runLockedMfaMutation({
      userId: seeded.user.id,
      partnerId: seeded.partner.id,
      authEpoch: seeded.user.authEpoch,
      mfaEpoch: seeded.user.mfaEpoch,
      reason: 'sms-phone-replaced',
    }, async (tx) => {
      await consumeMfaStepUpGrant(grant, binding);
      await tx.update(users).set({ phoneNumber: '+14155550199', phoneVerified: true })
        .where(eq(users.id, seeded.user.id));
      throw new Error('inject SMS replacement rollback');
    })).rejects.toThrow('inject SMS replacement rollback');

    const [afterUser] = await tdb.select().from(users).where(eq(users.id, seeded.user.id));
    const [afterFamily] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(afterUser?.phoneNumber).toBe(seeded.user.phoneNumber);
    expect(afterUser?.phoneVerified).toBe(seeded.user.phoneVerified);
    expect(afterUser?.mfaEpoch).toBe(seeded.user.mfaEpoch);
    expect(afterFamily?.revokedAt).toBeNull();
    await expect(readMfaStepUpGrant(grant, binding)).rejects.toBeInstanceOf(MfaStepUpGrantInvalidError);
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

  it('revokes the issued family when overlapping session issuance wins before policy mutation', async () => {
    const seeded = await seedPartnerMfaUser();
    const pending = await pendingFor(seeded);
    const tdb = getTestDb();

    const tableLocked = deferred();
    const releaseTable = deferred();
    const blocker = tdb.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE refresh_token_families IN ACCESS EXCLUSIVE MODE`);
      tableLocked.resolve();
      await releaseTable.promise;
    });
    await tableLocked.promise;

    const issuance = issueVerifiedPendingMfaSession({
      ...pending,
      verifiedMethod: 'totp',
    });
    // The blocked INSERT proves issuance already holds partner/user/factor
    // assurance locks before the effective-policy invalidation starts.
    await waitForBlockedRefreshFamilyInsert();
    const policyMutation = tdb.transaction((tx) => invalidateMfaPolicyAssurance(tx, {
      partnerId: seeded.partner.id,
      reason: 'partner-mfa-policy-changed',
    }));

    releaseTable.resolve();
    await blocker;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('policy issuance-first overlap deadlocked')), 5_000);
    });
    const [issued] = await Promise.race([Promise.all([issuance, policyMutation]), timeout]);

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
