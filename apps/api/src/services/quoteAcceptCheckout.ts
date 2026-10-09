import { createInvoicePayLink, type InvoiceCheckoutUrls } from './invoiceCheckout';
import { isPartnerOnlinePaymentAvailable } from './partnerStripe';
import { InvoiceServiceError } from './invoiceTypes';
import { portalBase } from './portalUrl';
import { captureException, captureMessage } from './sentry';

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
 * How long the accept response waits for the Checkout mint before giving up and
 * sending the customer to the invoice page instead. The accept has already
 * committed and the quote link is spent, so a slow Stripe must not leave the
 * customer staring at "Signing…" (or reloading into a 401). A Checkout create
 * normally returns in well under a second; 5s absorbs a slow one without making
 * the signer wait noticeably. A mint still in flight when this fires keeps
 * running: it writes its pending mapping as usual, and because it used the
 * public-link request key, the invoice page's Pay (same key, same hour) gets
 * that very session back from Stripe — the late session is harmless.
 */
export const ACCEPT_CHECKOUT_TIMEOUT_MS = 5_000;

/**
 * Will a public accept of this partner's quote go straight on to card checkout?
 * True when the partner can take online payment. Drives the "Sign & pay" copy on
 * the public quote page; the accept route re-checks it, so the copy never
 * promises a checkout the server would not attempt. Amount gating ($0,
 * recurring-only) is the caller's.
 *
 * Deliberately NOT gated on automatic-payments enrollment (Todd 2026-10-09): an
 * enrolled client's scheduled run may be days out, so they pay now too. No
 * double charge is possible — the scheduled run first revokes open Checkout
 * sessions (a paid one defers it) and then, under the invoice row lock, refuses
 * on a zero live balance or any unrevoked pending session
 * (autopay/collectionEngine attemptCollection + reserveCollection); Checkout
 * publication takes the same lock and refuses while a collection is reserved
 * (invoiceCheckout checkCheckoutPublicationInTx).
 */
export async function isPayOnAcceptAvailable(partnerId: string): Promise<boolean> {
  return isPartnerOnlinePaymentAvailable(partnerId);
}

/** createInvoicePayLink refusals that are a normal state, not a fault. */
const BENIGN_NO_CHECKOUT_CODES = new Set<string>([
  'NOTHING_TO_PAY', 'STRIPE_NOT_CONNECTED', 'COLLECTION_IN_PROGRESS', 'STRIPE_REVOCATION_PENDING',
]);

function reportMintFailure(invoiceId: string, err: unknown): void {
  // Expected "can't charge right now" states — the invoice page explains
  // them. Everything else (ORG_DENIED, INVOICE_NOT_FOUND, NOT_PAYABLE on a
  // just-issued invoice, INVALID_STATE, a partner's unsupported currency,
  // any 5xx) is a fault an operator must see; the customer still lands on
  // the durable page either way.
  if (err instanceof InvoiceServiceError && err.code != null && BENIGN_NO_CHECKOUT_CODES.has(err.code)) {
    console.warn('[quoteAcceptCheckout] no checkout after accept', { invoiceId, code: err.code });
    return;
  }
  console.error('[quoteAcceptCheckout] checkout mint failed after accept', { invoiceId, err });
  captureException(err instanceof Error ? err : new Error(String(err)));
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
 * checkout can be minted in time (no Stripe connection, nothing to pay,
 * revocation pending, Stripe error, or slower than ACCEPT_CHECKOUT_TIMEOUT_MS);
 * the caller then falls back to the invoice page. Never throws: the accept has
 * already committed.
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
    if (!(await isPayOnAcceptAvailable(res.quote.partnerId))) return null;
  } catch (err) {
    reportMintFailure(res.invoiceId, err);
    return null;
  }

  // Settle the mint into a value so a late rejection after the timeout is
  // never an unhandled rejection — it is still reported below.
  const mint: Promise<{ url: string } | { err: unknown }> = Promise.resolve()
    .then(() => createInvoicePayLink(
      res.invoiceId,
      { userId: null, partnerId: null, accessibleOrgIds: [res.quote.orgId] },
      { ...publicInvoiceCheckoutUrls(), ip: client.ip, userAgent: client.userAgent },
    ))
    .then((link) => ({ url: link.url }), (err: unknown) => ({ err }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ACCEPT_CHECKOUT_TIMEOUT_MS);
  });
  const outcome = await Promise.race([mint, timedOut]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    console.warn('[quoteAcceptCheckout] checkout mint timed out after accept', { invoiceId: res.invoiceId, timeoutMs: ACCEPT_CHECKOUT_TIMEOUT_MS });
    captureMessage('Quote accept checkout mint timed out; customer sent to the invoice page', {
      eventCode: 'quote_accept_checkout_timeout', level: 'warning',
    });
    void mint.then((late) => { if ('err' in late) reportMintFailure(res.invoiceId, late.err); });
    return null;
  }
  if ('err' in outcome) {
    reportMintFailure(res.invoiceId, outcome.err);
    return null;
  }
  return outcome.url;
}
