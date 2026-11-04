import { eq } from 'drizzle-orm';
import { db } from '../db';
import { invoices } from '../db/schema';
import { assertBillingEnabledForOrg } from './billingEnabled';
import { InvoiceServiceError } from './invoiceTypes';

/**
 * Partner billing master switch for the invoice family: 404
 * `{ error: 'Not found', code: 'BILLING_DISABLED' }` when the org's partner has
 * billing off. Kept out of invoiceService so routes can use it without pulling
 * the service module.
 */
export async function assertInvoiceBillingEnabled(orgId: string | null | undefined): Promise<void> {
  await assertBillingEnabledForOrg(orgId, (m, s, c) => new InvoiceServiceError(m, s, c));
}

/**
 * Same gate, resolving the org from the invoice id (one RLS-scoped read). An
 * unknown / invisible invoice passes through so the caller's own not-found and
 * access errors keep their order. Used where the gate must run before a write
 * that precedes the service call (lifecycle /send, /resend).
 */
export async function assertInvoiceBillingEnabledById(invoiceId: string): Promise<void> {
  const [inv] = await db.select({ orgId: invoices.orgId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (inv) await assertInvoiceBillingEnabled(inv.orgId);
}
