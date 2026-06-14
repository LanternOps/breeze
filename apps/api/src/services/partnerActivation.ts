import { sql } from 'drizzle-orm';
import type { db } from '../db';
import { partners } from '../db/schema';

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
 * Returns the number of rows updated. The UPDATE is guarded by
 * `status = 'pending'` so a concurrent reconciliation (e.g. verify-then-pay
 * racing the billing webhook) is idempotent — the loser updates 0 rows and
 * does not clobber an already-active partner.
 */
export async function activatePartnerRow(
  tx: Pick<typeof db, 'update'>,
  partnerId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(partners)
    .set({
      status: 'active' as const,
      settings: sql`jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(${partners.settings}, '{}'::jsonb),
            '{statusMessage}', 'null'::jsonb
          ),
          '{statusActionUrl}', 'null'::jsonb
        ),
        '{statusActionLabel}', 'null'::jsonb
      )`,
      updatedAt: now,
    })
    .where(sql`${partners.id} = ${partnerId} AND ${partners.status} = 'pending'`);
}
