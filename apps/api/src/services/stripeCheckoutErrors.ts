import { InvoiceServiceError } from './invoiceTypes';

/** True when a Stripe error from checkout.sessions.create is a currency the
 *  connected account cannot present/settle (spec §10 friendly mapping). */
export function isStripeCurrencyUnsupportedError(err: unknown): boolean {
  const e = err as { type?: string; code?: string; param?: string; message?: string } | null;
  if (!e || e.type !== 'StripeInvalidRequestError') return false;
  if (e.code === 'currency_not_supported') return true;
  if (typeof e.param === 'string' && /currency/i.test(e.param)) return true;
  return typeof e.message === 'string' && /currenc/i.test(e.message);
}

/** Partner-facing mapping. Returns null for anything that is not a currency failure
 *  so the caller rethrows the original error untouched. */
export function mapStripeCheckoutError(err: unknown, currency: string): InvoiceServiceError | null {
  if (!isStripeCurrencyUnsupportedError(err)) return null;
  const code = currency.toUpperCase();
  return new InvoiceServiceError(
    `Your Stripe account cannot accept payments in ${code}. Enable ${code} in your Stripe Dashboard (Settings → Payments → Currencies) or record this payment manually.`,
    409,
    'STRIPE_CURRENCY_UNSUPPORTED',
  );
}

/** Customer-safe wording for portal/public callers (never leaks account setup detail). */
export const CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE = 'Online payment is not available for this invoice — please contact the sender.';
