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
 *     the proof-of-payment gate; activating without it would comp a non-payer.
 *   - ONLY `pending` partners are eligible. `suspended` / `churned` /
 *     soft-deleted partners are never resurrected by reconciliation — that
 *     would undo the abuse-suspension and #568 mid-session cutoff.
 *   - A non-entitled `billing_subscription_status` VETOES activation even when
 *     the payment stamp is present. See below for why this exists.
 *
 * WHY THE VETO EXISTS: the comment that used to sit here claimed
 * `payment_method_attached_at` was "written only by breeze-billing on a
 * confirmed Stripe capture". That was false. breeze-billing's
 * `customer.subscription.updated` handler backfilled the stamp with no regard
 * for `subscription.status`, and Stripe expires an unpaid subscription to
 * `incomplete_expired` ~23h after creation — firing exactly that event. Audited
 * 2026-07-29: 34 of 55 partners carrying the stamp had ZERO successful Stripe
 * charges, and several had been auto-upgraded to a 250-device plan having paid
 * nothing. The writer is fixed, but the stamp is no longer trusted on its own.
 *
 * The veto is deliberately a VETO AND NOT A REQUIREMENT. Requiring a good
 * billing status would defeat #718 in precisely its target failure mode: the
 * `checkout.session.completed` webhook lands and stamps payment, then the
 * `customer.subscription.updated` that would have set the status mirror is lost
 * — a genuine payer stranded `pending` forever. A NULL / unknown mirror
 * therefore still passes. This also keeps the predicate safe across a deploy
 * skew where the API ships before breeze-billing starts populating the mirror.
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
  /**
   * Mirror of the raw Stripe subscription status, written by breeze-billing's
   * `syncSubscriptionStatus`. Optional so existing callers that cannot supply
   * it keep compiling — but a caller that omits it forfeits the veto, so pass
   * it wherever the column is available.
   */
  billingSubscriptionStatus?: string | null;
}

/**
 * Stripe subscription statuses that positively contradict a payment stamp. A
 * partner whose mirror reads one of these has a subscription that never
 * captured (or has terminated), so the stamp cannot be trusted regardless of
 * how it got written.
 *
 * Mirrors breeze-billing's `PAYMENT_PROVEN_STATUSES` inversion. `past_due` is
 * absent (it follows a real capture) and so is `trialing`. Kept as a denylist
 * rather than an allowlist so an unrecognised future Stripe status fails OPEN
 * — see the veto-not-requirement rationale in the header.
 */
const BILLING_STATUS_VETO = new Set<string>([
  'incomplete',
  'incomplete_expired',
  'canceled',
  'unpaid',
  'paused',
]);

/**
 * True when the billing mirror positively contradicts a payment stamp, so any
 * path about to grant access on the strength of that stamp must not.
 *
 * Exported because the admin unsuspend path (`routes/admin/abuse.ts`) makes the
 * same active-vs-pending decision from the same stamp, but cannot reuse
 * `shouldActivatePendingPartner` — its partner is `suspended`, not `pending`.
 * A false stamp there is worse than elsewhere: it turns an admin's unsuspend
 * into a straight-to-active with no payment.
 */
export function billingStatusContradictsPayment(
  billingSubscriptionStatus: string | null | undefined,
): boolean {
  return billingSubscriptionStatus != null && BILLING_STATUS_VETO.has(billingSubscriptionStatus);
}

/**
 * True iff a `pending` partner has independently met BOTH activation
 * preconditions, with no contradicting billing status, and should be flipped to
 * `active`. Pure — no I/O — so it is trivially testable and reusable from any
 * read path.
 */
export function shouldActivatePendingPartner(partner: ReconcilablePartner): boolean {
  if (partner.deletedAt != null) return false;
  if (billingStatusContradictsPayment(partner.billingSubscriptionStatus)) {
    return false;
  }
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
