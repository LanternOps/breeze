import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { createInvoicePayLink, type InvoiceCheckoutUrls } from './invoiceCheckout';
import { isPartnerOnlinePaymentAvailable } from './partnerStripe';
import { readOrgAutopayEnrollment } from './autopay/customerInvoiceStatus';
import { InvoiceServiceError } from './invoiceTypes';
import { portalBase } from './portalUrl';
import { captureException } from './sentry';

/**
 * Return URLs + idempotency family for every Checkout session minted on behalf
 * of the PUBLIC invoice link (2026-08-21 spec §5): session-id-only return URLs,
 * so the durable bearer token never reaches Stripe's logs, and both success and
 * cancel land on /invoice/return → settle-return → the invoice's durable page.
 *
 * Shared by POST /invoices/public/:token/pay and the public quote accept
 * (#8231) so the two mint the SAME session family: identical request params and
 * idempotency key means a customer who cancels out of the accept-time checkout
 * and presses Pay on the durable page within the hour is handed the same
 * session back, not a second competing one (spec §8).
 */
export function publicInvoiceCheckoutUrls(): Required<Pick<InvoiceCheckoutUrls, 'successUrl' | 'cancelUrl' | 'idempotencySuffix'>> {
  const returnBase = `${portalBase()}/invoice/return`;
  return {
    successUrl: `${returnBase}?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${returnBase}?canceled=1&session_id={CHECKOUT_SESSION_ID}`,
    idempotencySuffix: '_pub',
  };
}

/**
 * Will a public accept of this org's quote go straight on to card checkout?
 * True when the partner can take online payment and the client is NOT enrolled
 * in automatic payments (an enrolled client lands on the invoice page, which
 * says the invoice will be paid automatically, instead of being steered into a
 * manual card payment). Drives the "Sign & pay" copy on the public quote page;
 * the accept route re-checks it, so the copy can never promise a checkout the
 * server would not attempt. Amount gating ($0, recurring-only) is the caller's.
 */
export async function isPayOnAcceptAvailable(partnerId: string, orgId: string): Promise<boolean> {
  if (!(await isPartnerOnlinePaymentAvailable(partnerId))) return false;
  const { enrolled } = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    readOrgAutopayEnrollment(db, orgId)));
  return !enrolled;
}

/**
 * #8231 — after a successful PUBLIC accept, mint the Stripe Checkout session
 * for the converted invoice's charge-now amount (computeChargeNow inside
 * createInvoicePayLink: the deposit if one is set, else the balance) so the
 * customer goes straight from signing to payment.
 *
 * This is NOT the retired one-shot payUrl (spec §8): the session is an ordinary
 * mapped, revocable session from the public-link family (see
 * publicInvoiceCheckoutUrls), it is consumed by an immediate redirect rather
 * than held in page state, and both its success and cancel URLs return to the
 * invoice's durable public page. Nothing is lost if the tab closes: the invoice
 * is auto-emailed with that same durable link.
 *
 * Only ever attempted on top of a durable `invoiceUrl` — without one there is
 * no page for Stripe to return the customer to. Returns null whenever no
 * checkout can be minted (no Stripe connection, nothing to pay, autopay
 * enrolled, revocation pending, Stripe error); the caller then falls back to
 * the invoice page. Never throws: the accept has already committed.
 *
 * Called with NO DB context held: createInvoicePayLink opens its own short
 * contexts and asserts none is held across the Stripe round-trip.
 */
export async function resolveAcceptCheckoutUrl(
  res: { invoiceId: string; invoiceIssued: boolean; quote: { partnerId: string; orgId: string } },
  invoiceUrl: string | null,
  client: { ip: string | null; userAgent: string | null },
): Promise<string | null> {
  if (!res.invoiceIssued || invoiceUrl == null) return null;
  try {
    if (!(await isPayOnAcceptAvailable(res.quote.partnerId, res.quote.orgId))) return null;
    const link = await createInvoicePayLink(
      res.invoiceId,
      { userId: null, partnerId: null, accessibleOrgIds: [res.quote.orgId] },
      { ...publicInvoiceCheckoutUrls(), ip: client.ip, userAgent: client.userAgent },
    );
    return link.url;
  } catch (err) {
    // 4xx = a known "can't charge right now" state (nothing to pay, not
    // connected, collection in progress, revocation pending, currency
    // unsupported) — the invoice page explains it. Anything else is a fault
    // worth seeing, but the customer still lands on the durable page.
    if (err instanceof InvoiceServiceError && err.status < 500) {
      console.warn('[quoteAcceptCheckout] no checkout after accept', { invoiceId: res.invoiceId, code: err.code });
      return null;
    }
    console.error('[quoteAcceptCheckout] checkout mint failed after accept', { invoiceId: res.invoiceId, err });
    captureException(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}
