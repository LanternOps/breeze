/**
 * Real-Postgres atomicity proof for `invalidateMfaAssuranceAfterFactorChange`
 * (Task 9 of the MFA policy/assurance PR — SR2-07/SR2-19).
 *
 * `mfaAssurance.test.ts` proves the call ordering (mutate → advance epoch →
 * revoke families → post-commit cleanup) against a MOCKED `db.transaction`.
 * That proves nothing about whether Postgres itself actually commits the
 * three writes (factor mutation, `mfa_epoch` bump, refresh-family revoke)
 * together, or rolls all three back together when `mutate` throws — a mock
 * can't observe partial-commit behavior because it never talks to a real
 * transaction. This file drives the real function against real Postgres to
 * prove both directions of the atomicity invariant.
 *
 * The function itself does not open its own RLS access context (see its
 * docstring — production callers already run inside the request's ambient
 * `withDbAccessContext`, opened by `authMiddleware`). This test reproduces
 * that same shape by wrapping the call in `withSystemDbAccessContext`, exactly
 * as `refreshEpoch.integration.test.ts` wraps `advanceUserEpochs`/
 * `revokeAllRefreshFamilies` directly.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaAssurance.integration.test.ts
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { users, refreshTokenFamilies } from '../../db/schema';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPartner, createUser } from './db-utils';

async function readUser(userId: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

async function readFamily(familyId: string) {
  const [row] = await getTestDb()
    .select()
    .from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, familyId))
    .limit(1);
  if (!row) throw new Error(`family ${familyId} not found`);
  return row;
}

describe('invalidateMfaAssuranceAfterFactorChange — real-PG atomicity (Task 9)', () => {
  it('commits the factor write + mfa_epoch bump + family revoke together, in one transaction', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, withMembership: true });
    const familyId = await mintRefreshTokenFamily(user.id);

    const before = await readUser(user.id);
    expect(before.mfaEpoch).toBe(1);
    expect(before.mfaMethod).toBeNull();
    const familyBefore = await readFamily(familyId);
    expect(familyBefore.revokedAt).toBeNull();

    const result = await withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(user.id, 'test-commit', async (tx) => {
        await tx.update(users).set({ mfaMethod: 'sms', updatedAt: new Date() }).where(eq(users.id, user.id));
      })
    );

    // Returned mfaEpoch reflects the just-committed value.
    expect(result.mfaEpoch).toBe(2);

    // All three writes landed together.
    const after = await readUser(user.id);
    expect(after.mfaEpoch).toBe(2);
    expect(after.mfaMethod).toBe('sms');
    const familyAfter = await readFamily(familyId);
    expect(familyAfter.revokedAt).not.toBeNull();
    expect(familyAfter.revokedReason).toBe('test-commit');
  });

  it('rolls back the factor write AND the epoch bump AND the family revoke when mutate throws (no partial commit)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id, withMembership: true });
    const familyId = await mintRefreshTokenFamily(user.id);

    const before = await readUser(user.id);
    expect(before.mfaEpoch).toBe(1);
    expect(before.mfaMethod).toBeNull();

    const boom = new Error('factor write failed mid-transaction');
    await expect(
      withSystemDbAccessContext(() =>
        invalidateMfaAssuranceAfterFactorChange(user.id, 'test-rollback', async (tx) => {
          await tx.update(users).set({ mfaMethod: 'sms', updatedAt: new Date() }).where(eq(users.id, user.id));
          throw boom;
        })
      )
    ).rejects.toThrow(boom);

    // Nothing committed: the factor field write, the epoch bump, and the
    // family revoke are all still at their pre-call values.
    const after = await readUser(user.id);
    expect(after.mfaEpoch).toBe(1);
    expect(after.mfaMethod).toBeNull();
    const familyAfter = await readFamily(familyId);
    expect(familyAfter.revokedAt).toBeNull();
  });
});
