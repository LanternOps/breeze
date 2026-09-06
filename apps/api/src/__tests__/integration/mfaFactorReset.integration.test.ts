/**
 * RMM-QA-166 — resetAllFactors under real RLS (breeze_app) + real transactions.
 *
 *   I-4 RLS guard (verifier concern C1, executed): under a TENANT
 *       withDbAccessContext the service throws MfaFactorResetContextError and
 *       the passkey row + mfa_enabled are untouched. The row-count alternative
 *       was rejected because an ambient pre-read is RLS-filtered to zero too.
 *   I-5 atomicity: a throw injected AFTER resetAllFactors inside the
 *       invalidate primitive rolls back passkey delete, column clears, the
 *       mfa_epoch bump and the family revoke together.
 *   I-6 already-disabled passkey rows are deleted too (credential ids freed).
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaFactorReset.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { MfaFactorResetContextError, resetAllFactors } from '../../services/mfaFactorReset';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function passkeyCount(userId: string) {
  return (await getTestDb().select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId))).length;
}

async function seedPasskey(userId: string, suffix: string, disabledAt: Date | null = null) {
  await getTestDb().insert(userPasskeys).values({
    userId, credentialId: `cred-${suffix}-${userId}`, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: suffix, disabledAt,
  });
}

async function seedProtectedUser() {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, withMembership: true, mfaEnabled: true });
  await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: 'enc:seed', mfaRecoveryCodes: ['h'] }).where(eq(users.id, user.id));
  await seedPasskey(user.id, 'live');
  return { partner, user };
}

describe('resetAllFactors — RLS guard, atomicity, disabled rows (RMM-QA-166)', () => {
  it('I-4: refuses to run under a tenant context and leaves the passkey + mfa_enabled untouched', async () => {
    const { partner, user } = await seedProtectedUser();

    await expect(
      withDbAccessContext(
        { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partner.id], userId: null },
        () => db.transaction((tx) => resetAllFactors(tx, user.id)),
      ),
    ).rejects.toBeInstanceOf(MfaFactorResetContextError);

    expect(await passkeyCount(user.id)).toBe(1);
    expect((await readUser(user.id)).mfaEnabled).toBe(true);
  });

  it('I-5: a failure after the factor write rolls back passkeys, columns, mfa_epoch and the family together', async () => {
    const { user } = await seedProtectedUser();
    const familyId = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);
    const boom = new Error('injected failure after resetAllFactors');

    await expect(
      withSystemDbAccessContext(() =>
        invalidateMfaAssuranceAfterFactorChange(user.id, 'test-rollback', async (tx) => {
          const inventory = await resetAllFactors(tx, user.id);
          expect(inventory.passkeysDeleted).toBe(1); // the delete DID run inside the tx
          throw boom;
        }),
      ),
    ).rejects.toThrow(boom);

    const after = await readUser(user.id);
    expect(await passkeyCount(user.id)).toBe(1);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc:seed', mfaEpoch: before.mfaEpoch });
    const [family] = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId)).limit(1);
    expect(family?.revokedAt).toBeNull();
  });

  it('I-6: deletes already-disabled passkey rows too and reports the full count', async () => {
    const { user } = await seedProtectedUser();
    await seedPasskey(user.id, 'disabled', new Date());
    expect(await passkeyCount(user.id)).toBe(2);

    const inventory = await withSystemDbAccessContext(() => db.transaction((tx) => resetAllFactors(tx, user.id)));

    expect(inventory.passkeysDeleted).toBe(2);
    expect(inventory.passkeys.map((p) => p.name).sort()).toEqual(['disabled', 'live']);
    expect(await passkeyCount(user.id)).toBe(0);
  });
});
