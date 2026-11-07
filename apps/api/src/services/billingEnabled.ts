import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema/orgs';

/**
 * Partner billing master switch (`partners.billing_enabled`).
 * Spec: docs/superpowers/specs/billing/2026-10-16-partner-billing-enabled-design.md §7.
 *
 * With billing off, gated billing operations answer 404 with an IDENTICAL body
 * in every family: `{ error: 'Not found', code: 'BILLING_DISABLED' }`.
 *
 * Usage — each family throws its own error class so its `handleServiceError`
 * renders the body unchanged. All three constructors are `(message, status, code)`:
 *   await assertBillingEnabledForOrg(orgId, (m, s, c) =>
 *     new InvoiceServiceError(m, s, c as InvoiceServiceErrorCode));
 *   // QuoteServiceError / ContractServiceError: same shape.
 * The family's code union must include 'BILLING_DISABLED'.
 */
export const BILLING_DISABLED_MESSAGE = 'Not found';
export const BILLING_DISABLED_CODE = 'BILLING_DISABLED';
export const BILLING_DISABLED_STATUS = 404;

export type BillingDisabledErrorFactory = (
  message: string,
  status: typeof BILLING_DISABLED_STATUS,
  code: typeof BILLING_DISABLED_CODE,
) => Error;

/**
 * Fails OPEN (true) on a missing partner id, missing row, or non-boolean value,
 * like getServiceManagementMode: failing closed would withdraw a paid module.
 */
export async function isBillingEnabledForPartner(
  partnerId: string | null | undefined,
): Promise<boolean> {
  if (!partnerId) return true;

  const rows = await db
    .select({ billingEnabled: partners.billingEnabled })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const stored = rows[0]?.billingEnabled;
  return typeof stored === 'boolean' ? stored : true;
}

/**
 * Resolves the org's partner in ONE joined query. Unknown org => true, so the
 * family's own natural not-found error still applies.
 */
export async function isBillingEnabledForOrg(
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!orgId) return true;

  const rows = await db
    .select({ billingEnabled: partners.billingEnabled })
    .from(organizations)
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(eq(organizations.id, orgId))
    .limit(1);

  const stored = rows[0]?.billingEnabled;
  return typeof stored === 'boolean' ? stored : true;
}

export async function assertBillingEnabledForPartner(
  partnerId: string | null | undefined,
  makeError: BillingDisabledErrorFactory,
): Promise<void> {
  if (!(await isBillingEnabledForPartner(partnerId))) {
    throw makeError(BILLING_DISABLED_MESSAGE, BILLING_DISABLED_STATUS, BILLING_DISABLED_CODE);
  }
}

export async function assertBillingEnabledForOrg(
  orgId: string | null | undefined,
  makeError: BillingDisabledErrorFactory,
): Promise<void> {
  if (!(await isBillingEnabledForOrg(orgId))) {
    throw makeError(BILLING_DISABLED_MESSAGE, BILLING_DISABLED_STATUS, BILLING_DISABLED_CODE);
  }
}
