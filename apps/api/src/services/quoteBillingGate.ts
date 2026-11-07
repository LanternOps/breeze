import { eq } from 'drizzle-orm';
import { db } from '../db';
import { quotes } from '../db/schema';
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

/**
 * Same gate, resolving the org from the quote id (one RLS-scoped read). An
 * unknown / invisible quote passes through so the caller's own not-found and
 * access errors keep their order.
 */
export async function assertQuoteBillingEnabledById(quoteId: string): Promise<void> {
  const [row] = await db.select({ orgId: quotes.orgId }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (row) await assertQuoteBillingEnabled(row.orgId);
}
