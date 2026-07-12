import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db } from '../db';
import { organizationUsers, organizations, partners, partnerUsers, users } from '../db/schema';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  type AuthLifecycleTransaction,
} from './authLifecycle';

/**
 * Partner activation reconciliation (issue #718).
 *
 * A hosted self-service partner is created `pending` and only becomes
 * `active` once BOTH preconditions are independently satisfied:
 *
 *   1. email verified  → `partners.email_verified_at` is set, and
 *   2. payment attached → `partners.payment_method_attached_at` is set.
 *
 * These two events arrive on independent paths and in either order:
 *
 *   - pay-then-verify: breeze-billing writes `payment_method_attached_at`
 *     (and normally flips status), then the user clicks the verify link.
 *     `consumeVerificationToken` reconciles this ordering.
 *   - verify-then-pay: the user verifies first, then breeze-billing writes
 *     `payment_method_attached_at`. If breeze-billing has a webhook /
 *     idempotency gap and writes the timestamp without flipping status, the
 *     partner is stranded `pending` forever even though both preconditions
 *     are met. `partnerGuard` reconciles this ordering on the next
 *     authenticated request.
 *
 * The predicate below is the SINGLE source of truth shared by both paths so
 * they cannot drift apart.
 *
 * SECURITY / PRODUCT INVARIANTS (issue #718 rescope — do not relax):
 *   - NEVER activate on time elapsed. There is no "it's been N days, let them
 *     in" branch anywhere. A failed signup payment correctly stays `pending`.
 *   - NEVER activate on email-verified alone. `payment_method_attached_at` is
 *     written only by breeze-billing on a confirmed Stripe capture, so it is
 *     the proof-of-payment gate. Activating without it would comp a non-payer.
 *   - ONLY `pending` partners are eligible. `suspended` / `churned` /
 *     soft-deleted partners are never resurrected by reconciliation — that
 *     would undo the abuse-suspension and #568 mid-session cutoff.
 *
 * Self-hosted (`IS_HOSTED=false`) partners are created `active` directly by
 * `register-partner`, so they never enter the `pending` state and this
 * predicate simply never matches for them — payment is implicitly waived by
 * never being required in the first place.
 */

export interface ReconcilablePartner {
  status: string;
  emailVerifiedAt: Date | string | null;
  paymentMethodAttachedAt: Date | string | null;
  deletedAt?: Date | string | null;
}

export interface PartnerActivationStatusMetadata {
  message?: string;
  actionUrl?: string;
  actionLabel?: string;
}

export const PARTNER_SUSPENSION_DISABLED_REASON = 'partner_suspended';

/** Restore only users carrying the marker written by partner suspension. */
export function reEnableSuspensionDisabledUsers(
  tx: AuthLifecycleTransaction,
  partnerId: string,
) {
  return tx
    .update(users)
    .set({ status: 'active', disabledReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(users.partnerId, partnerId),
        eq(users.status, 'disabled'),
        eq(users.disabledReason, PARTNER_SUSPENSION_DISABLED_REASON),
      ),
    )
    .returning({ id: users.id });
}

/**
 * True iff a `pending` partner has independently met BOTH activation
 * preconditions and should be flipped to `active`. Pure — no I/O — so it is
 * trivially testable and reusable from any read path.
 */
export function shouldActivatePendingPartner(partner: ReconcilablePartner): boolean {
  if (partner.deletedAt != null) return false;
  return (
    partner.status === 'pending' &&
    partner.emailVerifiedAt != null &&
    partner.paymentMethodAttachedAt != null
  );
}

/**
 * The mutation half of activation. Flips the partner to `active` and clears
 * the "Awaiting email verification" / "Finish payment" status banner keys that
 * breeze-billing (or register-partner hooks) may have written while the tenant
 * was `pending`, so the dashboard doesn't show a stale inactive banner.
 *
 * Mirrors the JSONB-null pattern in
 * breeze-billing/src/services/partnerSync.ts:activatePartner and the inline
 * version previously duplicated in consumeVerificationToken.
 *
 * `tx` is any Drizzle-compatible executor (the request db, a transaction, or
 * a system-scoped handle). The caller owns the RLS scope; this helper only
 * issues the UPDATE.
 *
 * Returns whether this caller won the activation. The UPDATE is guarded by
 * `status = 'pending'` so a concurrent reconciliation (e.g. verify-then-pay
 * racing the billing webhook) is idempotent — the loser updates 0 rows and
 * does not clobber an already-active partner.
 */
export async function activatePartnerRow(
  tx: Pick<typeof db, 'update'>,
  partnerId: string,
  now: Date = new Date(),
  statusMetadata?: PartnerActivationStatusMetadata,
): Promise<boolean> {
  const clearedSettings = sql`jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(${partners.settings}, '{}'::jsonb),
        '{statusMessage}', 'null'::jsonb
      ),
      '{statusActionUrl}', 'null'::jsonb
    ),
    '{statusActionLabel}', 'null'::jsonb
  )`;
  const statusSettings: Record<string, string> = {};
  if (statusMetadata?.message) statusSettings.statusMessage = statusMetadata.message;
  if (statusMetadata?.actionUrl) statusSettings.statusActionUrl = statusMetadata.actionUrl;
  if (statusMetadata?.actionLabel) statusSettings.statusActionLabel = statusMetadata.actionLabel;
  const settings = Object.keys(statusSettings).length > 0
    ? sql`${clearedSettings} || ${JSON.stringify(statusSettings)}::jsonb`
    : clearedSettings;

  const activated = await tx
    .update(partners)
    .set({
      status: 'active' as const,
      settings,
      updatedAt: now,
    })
    .where(sql`${partners.id} = ${partnerId} AND ${partners.status} = 'pending'`)
    .returning({ id: partners.id });
  return activated.length > 0;
}

export interface PartnerActivationResult {
  activated: boolean;
  userIds: string[];
}

/**
 * Activate one pending partner and invalidate every session that was minted
 * while that tenant was inactive. The caller must supply the active system
 * transaction so the status flip, auth-epoch advances, and durable family
 * revocations commit or roll back together.
 */
export async function activatePendingPartnerAndInvalidateSessions(
  tx: AuthLifecycleTransaction,
  partnerId: string,
  now: Date = new Date(),
  statusMetadata?: PartnerActivationStatusMetadata,
): Promise<PartnerActivationResult> {
  if (!(await activatePartnerRow(tx, partnerId, now, statusMetadata))) {
    return { activated: false, userIds: [] };
  }

  const orgRows = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, partnerId));
  const orgIds = orgRows.map((row) => row.id);
  const partnerMemberships = await tx
    .select({ userId: partnerUsers.userId })
    .from(partnerUsers)
    .where(eq(partnerUsers.partnerId, partnerId));
  const orgMemberships = orgIds.length === 0
    ? []
    : await tx
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(inArray(organizationUsers.orgId, orgIds));
  const userIds = [...new Set([
    ...partnerMemberships.map((row) => row.userId),
    ...orgMemberships.map((row) => row.userId),
  ])];

  for (const userId of userIds) {
    await advanceUserSecurityState(tx, userId);
    await revokeAllUserSessionFamilies(tx, userId, 'partner-activated');
  }

  return { activated: true, userIds };
}

/**
 * Restore one explicitly suspended partner without bypassing the normal
 * activation gates. The row lock keeps the eligibility check, status write,
 * suspension-marker cleanup, and durable auth invalidation atomic with respect
 * to concurrent partner lifecycle changes.
 */
export async function restoreSuspendedPartnerInTransaction(
  tx: AuthLifecycleTransaction,
  partnerId: string,
) {
  const [partner] = await tx
    .select({
      id: partners.id,
      status: partners.status,
      emailVerifiedAt: partners.emailVerifiedAt,
      paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1)
    .for('update');

  // Deliberately use the same response shape for missing and ineligible rows:
  // callers must not be able to use this endpoint as a partner-status oracle.
  if (!partner || partner.status !== 'suspended') {
    return { notFound: true as const };
  }

  // Snapshot the whole partner population before changing any user rows. Auth
  // invalidation is based on tenant membership, not on which accounts happen
  // to carry the partner_suspended marker.
  const partnerUserRows = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.partnerId, partnerId));

  const newStatus: 'active' | 'pending' = shouldActivatePendingPartner({
    status: 'pending',
    emailVerifiedAt: partner.emailVerifiedAt,
    paymentMethodAttachedAt: partner.paymentMethodAttachedAt,
  })
    ? 'active'
    : 'pending';

  await tx
    .update(partners)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(partners.id, partnerId));

  // Restore only users disabled by suspension; independently invalidate every
  // affected partner user. Include the returned rows defensively and dedupe so
  // a concurrent legacy/membership repair cannot leave a restored user out.
  const reEnabled = await reEnableSuspensionDisabledUsers(tx, partnerId);
  const affectedUserIds = [...new Set([
    ...partnerUserRows.map((user) => user.id),
    ...reEnabled.map((user) => user.id),
  ])];
  for (const userId of affectedUserIds) {
    await advanceUserSecurityState(tx, userId);
    await revokeAllUserSessionFamilies(tx, userId, 'partner-reactivated');
  }

  return {
    notFound: false as const,
    status: newStatus,
    userCount: reEnabled.length,
    affectedUserIds,
  };
}
