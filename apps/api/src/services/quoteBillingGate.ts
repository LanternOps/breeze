import { assertBillingEnabledForOrg } from './billingEnabled';
import { QuoteServiceError, type QuoteServiceErrorCode } from './quoteTypes';

/**
 * Partner billing master switch for the quote family: 404
 * `{ error: 'Not found', code: 'BILLING_DISABLED' }` when the org's partner has
 * billing off. Kept out of quoteService so routes can use it without pulling
 * the service module.
 */
export async function assertQuoteBillingEnabled(orgId: string | null | undefined): Promise<void> {
  await assertBillingEnabledForOrg(orgId, (m, s, c) => new QuoteServiceError(m, s, c as QuoteServiceErrorCode));
}
