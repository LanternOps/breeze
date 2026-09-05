import { eq } from 'drizzle-orm';
import { users, partnerUsers, organizationUsers } from '../db/schema';
import type { Tx } from './authLifecycle';
import { resetAllFactors, type MfaFactorInventory } from './mfaFactorReset';

export interface NeutralizationResult {
  neutralized: boolean;
  inventory?: MfaFactorInventory;
}

/**
 * When a user's LAST membership anywhere has just been removed, neutralize the
 * orphaned `users` row so it cannot authenticate: status='disabled',
 * password_hash=NULL, and (RMM-QA-166) every second factor stripped —
 * TOTP secret, recovery codes, method flag, phone, and all `user_passkeys`
 * rows — via `resetAllFactors`. Closes the #1367 login hole (a "deleted" user
 * could still log in) and the RMM-QA-166 passkey leftover (a tombstone that
 * still carried a stranger's credential).
 *
 * MUST run under a SYSTEM DB access context, on the caller's `tx`: the orphan
 * check has to see memberships across EVERY tenant (an org admin's RLS view
 * hides partner memberships and other orgs' rows, so a request-scoped check
 * would falsely report a still-active multi-org user as orphaned and wrongly
 * disable them), the just-deleted membership — still uncommitted on this
 * connection — must be visible to the SELECTs below, and `resetAllFactors`
 * itself throws outside system context (its passkey DELETE would silently
 * match zero rows under RLS).
 *
 * Contract with callers (D3): this function NEVER advances epochs or revokes
 * refresh families. Callers do that first —
 * `advanceUserEpochs(tx, id, { auth: true, mfa: true })` then
 * `revokeAllRefreshFamilies(tx, id, 'membership-removed')` — and call this
 * LAST, so the global lock order user → families → factor rows holds. Both
 * current callers (`routes/users.ts` removeMembershipForScope and
 * `routes/accessReviews.ts` completion) follow that order.
 */
export async function neutralizeUserIfOrphaned(tx: Tx, userId: string): Promise<NeutralizationResult> {
  const [partnerLink] = await tx
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(eq(partnerUsers.userId, userId))
    .limit(1);
  if (partnerLink) return { neutralized: false };

  const [orgLink] = await tx
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(eq(organizationUsers.userId, userId))
    .limit(1);
  if (orgLink) return { neutralized: false };

  await tx
    .update(users)
    .set({
      status: 'disabled',
      disabledReason: 'removed',
      passwordHash: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  const inventory = await resetAllFactors(tx, userId);
  return { neutralized: true, inventory };
}
