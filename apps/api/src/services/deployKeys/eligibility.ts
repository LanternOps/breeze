/**
 * Deploy-key eligibility (spec 2026-10-12 §10.3, §13 decision 10).
 *
 * A gate for ISSUING or USING any deploy key, never evidence that an
 * enrollment is legitimate. Existing columns only (F22):
 *   - `partners.trust_state = 'trusted'` AND `partners.deploy_key_enrollment_enabled`;
 *   - where billing is configured (`BREEZE_BILLING_URL`, the breeze-billing
 *     integration that writes the payment column), also
 *     `payment_method_attached_at IS NOT NULL` AND NOT
 *     `billingStatusContradictsPayment(billing_subscription_status)` — a veto,
 *     not a requirement, exactly as partner activation uses it: a NULL or
 *     unknown status passes, only a non-entitled one blocks;
 *   - on a self-hosted instance with no billing, both payment clauses are skipped.
 *
 * Mint and rotate check it (services/deployKeys/manage.ts), and so does every
 * deploy-key enrollment. The platform flag PRE_ASSIGNMENT_ENROLLMENT_ENABLED is
 * NOT part of it: enrollment checks it separately (isDeployKeyEnrollmentEnabled),
 * and minting or rotating while the platform is dark stays possible.
 */
import { eq } from 'drizzle-orm';
import type { db } from '../../db';
import { partners } from '../../db/schema';
import { billingStatusContradictsPayment } from '../partnerActivation';

export interface DeployKeyEligibilityFacts {
  trustState: string;
  deployKeyEnrollmentEnabled: boolean;
  paymentMethodAttachedAt: Date | null;
  billingSubscriptionStatus: string | null;
}

export type DeployKeyIneligibleReason =
  | 'partner_not_found'
  | 'partner_not_trusted'
  | 'enrollment_switch_off'
  | 'payment_method_missing'
  | 'billing_status_contradicts_payment';

export type DeployKeyEligibility =
  | { eligible: true }
  | { eligible: false; reason: DeployKeyIneligibleReason };

/** Whether this instance runs the breeze-billing integration. Read per call. */
export function deployKeyBillingConfigured(): boolean {
  return Boolean(process.env.BREEZE_BILLING_URL?.trim());
}

/** Pure decision over one partner's facts. */
export function evaluateDeployKeyEligibility(
  facts: DeployKeyEligibilityFacts | null | undefined,
  options: { billingConfigured: boolean } = { billingConfigured: deployKeyBillingConfigured() },
): DeployKeyEligibility {
  if (!facts) return { eligible: false, reason: 'partner_not_found' };
  if (facts.trustState !== 'trusted') return { eligible: false, reason: 'partner_not_trusted' };
  if (!facts.deployKeyEnrollmentEnabled) return { eligible: false, reason: 'enrollment_switch_off' };
  if (options.billingConfigured) {
    if (facts.paymentMethodAttachedAt == null) return { eligible: false, reason: 'payment_method_missing' };
    if (billingStatusContradictsPayment(facts.billingSubscriptionStatus)) {
      return { eligible: false, reason: 'billing_status_contradicts_payment' };
    }
  }
  return { eligible: true };
}

type SelectExecutor = Pick<typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0], 'select'>;

/**
 * Reads the partner's facts on the caller's executor (a system-context `db`
 * or an open transaction) and decides. The caller owns the context.
 */
export async function readDeployKeyEligibility(
  executor: SelectExecutor,
  partnerId: string,
): Promise<DeployKeyEligibility> {
  const [row] = await executor
    .select({
      trustState: partners.trustState,
      deployKeyEnrollmentEnabled: partners.deployKeyEnrollmentEnabled,
      paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
      billingSubscriptionStatus: partners.billingSubscriptionStatus,
      deletedAt: partners.deletedAt,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!row || row.deletedAt != null) return { eligible: false, reason: 'partner_not_found' };
  return evaluateDeployKeyEligibility(row);
}
