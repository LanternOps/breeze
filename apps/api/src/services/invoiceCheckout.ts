import { and, eq } from 'drizzle-orm';
import { computeChargeNow, buildStripeCurrencyWarning, type StripeCurrencyWarning } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoices, invoiceStripePayments, stripeConnectAccounts } from '../db/schema';
import { getPartnerStripeClient, PartnerStripeError } from './partnerStripe';
import { toMinorUnits } from './stripeMoney';
import { mapStripeCheckoutError } from './stripeCheckoutErrors';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { requireOrgAccess, requireSiteAccess } from './invoiceService';
import { assertNoPendingRevocation, markSessionRevocationRequestedInTx } from './stripeSessionRevocation';
import { portalBase } from './portalUrl';

/**
 * Provider-side expiry for a new Checkout session (SEC-150, defence in depth).
 *
 * Stripe expires an unclaimed session after 24h anyway; asking for it EXPLICITLY
 * means the bound is recorded on our side (`provider_expires_at`) and survives a
 * future Stripe default change.
 *
 * Quantised to the hour on purpose. Stripe rejects an idempotent replay whose
 * parameters differ from the first use, so a per-millisecond `expires_at` would
 * turn the double-click dedupe both producers rely on into an
 * `idempotency_key_in_use` error. The quantum is therefore ALSO folded into the
 * idempotency key (the established `idempotencySuffix` pattern): two clicks in
 * the same hour reuse one session; a click in a later hour mints a fresh one,
 * and every one of them is revoked together by the intent phase.
 *
 * Yields 22h00m01s–23h ahead — comfortably inside Stripe's [30 min, 24 h] window
 * with no risk of tripping the upper bound on a slow request.
 */
export function checkoutSessionExpiry(now: Date = new Date()): { expiresAt: number; quantum: number } {
  const quantum = Math.floor(now.getTime() / 1000 / 3600) * 3600;
  return { expiresAt: quantum + 23 * 3600, quantum };
}

// Statuses whose balance can be collected online. Mirrors the customer-portal
// PAYABLE set (routes/portal/invoices.ts) — drafts/paid/void are excluded.
const PAYABLE = new Set(['sent', 'partially_paid', 'overdue']);

/**
 * Partner-initiated "Send payment link": open a Stripe Checkout session on the
 * partner's OWN Stripe account (using their stored API key — no Connect) for the
 * invoice's outstanding balance and return the hosted-checkout URL. The webhook
 * (routes/webhooks/stripe.ts → stripeReconcile) records the resulting payment
 * idempotently via the `invoice_stripe_payments` mapping, so this only creates
 * the session + a pending mapping row.
 *
 * Twin of the customer-driven POST /portal/invoices/:id/pay.
 *
 * #1448 — this route opts out of the auth middleware's auto request-transaction
 * (see selfManagedDbContextRoutes.ts), so there is NO ambient DB context here.
 * Each DB step opens its own short `withSystemDbAccessContext` and the slow
 * Stripe HTTP call runs OUTSIDE any transaction — a pooled connection is never
 * held idle across the network round-trip (#1105 class). Tenant isolation does
 * not rely on RLS scope here: the explicit `requireOrgAccess(actor, inv.orgId)`
 * app-layer guard blocks cross-tenant access regardless of the read scope, and
 * the mapping INSERT runs inside a context so it isn't a contextless 0-row
 * no-op (#1375).
 */
export interface InvoiceCheckoutUrls {
  /** Overrides for the Checkout return URLs. The public invoice-link path uses
   *  session-id-only URLs so the durable bearer token never reaches Stripe's
   *  logs (2026-08-21 spec §5); the default is the authenticated portal detail
   *  page, unchanged for the portal/MSP callers. */
  successUrl?: string;
  cancelUrl?: string;
  /** Discriminates the Stripe idempotency key when the return URLs differ from
   *  the default — identical keys with different params make Stripe reject the
   *  replay outright, so each URL shape needs its own key family. Omitted for
   *  the historical portal/MSP path to keep its keys byte-identical. */
  idempotencySuffix?: string;
}

export async function createInvoicePayLink(
  invoiceId: string, actor: InvoiceActor, urls: InvoiceCheckoutUrls = {},
): Promise<{ url: string; warning?: StripeCurrencyWarning }> {
  const [inv] = await withSystemDbAccessContext(() =>
    db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  );
  if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, inv.orgId);
  // Site-axis guard: a site-restricted caller must not mint a pay link for an
  // out-of-site invoice. No-op for unrestricted (partner/system/portal) actors.
  requireSiteAccess(actor, inv.siteId);
  if (!PAYABLE.has(inv.status)) throw new InvoiceServiceError('Invoice is not payable', 409, 'NOT_PAYABLE');
  // SEC-150 producer gate. Once a transition has recorded revocation intent for
  // this invoice, minting another session would re-open the very window the
  // intent exists to close — and the new session would not be covered by the
  // in-flight revocation. Refuse until the sweep has settled the old ones.
  await withSystemDbAccessContext(() => assertNoPendingRevocation(inv.id));

  // Deposit-first: charge the deposit remaining while unmet, else the full
  // balance. computeChargeNow clamps to balance and handles every state (no
  // deposit, deposit partially/fully paid) — never reimplement that logic here.
  const chargeNow = computeChargeNow({
    depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance,
  }, inv.currencyCode);
  // Currency-aware minor units (zero-decimal currencies must not be ×100).
  const chargeMinor = toMinorUnits(chargeNow.amount, inv.currencyCode);
  if (chargeMinor <= 0) throw new InvoiceServiceError('Nothing to pay', 409, 'NOTHING_TO_PAY');

  // The partner charges on their OWN Stripe account using their stored key (no
  // platform/Connect). stripe_connect_accounts is a partner-axis table (reused by
  // the #1610 API-key model), so read it in a short system-scoped context (#1448 —
  // there is no ambient request tx here). One read returns both the client and the
  // account id (for the mapping row).
  let stripe, stripeAccountId: string, defaultCurrency: string | null;
  try {
    ({ stripe, stripeAccountId, defaultCurrency } = await withSystemDbAccessContext(() =>
      getPartnerStripeClient(inv.partnerId)));
  } catch (err) {
    // Only "no key configured" is a benign 409. A decrypt/unreadable-key fault is an
    // internal error — surface it as such (and let it be logged) instead of lying
    // "connect Stripe first" when the key is actually corrupt/misconfigured.
    if (err instanceof PartnerStripeError && err.code === 'NO_STRIPE_KEY') {
      throw new InvoiceServiceError('Online payment is not available — connect Stripe first', 409, 'STRIPE_NOT_CONNECTED');
    }
    // Log at this layer too: a non-NO_STRIPE_KEY error here may be an unreadable key
    // (already logged in partnerStripe) OR an unexpected DB/context failure from the
    // wrapping read — don't let the latter collapse into a generic 500 with no trace.
    console.error('[invoiceCheckout] failed to initialize partner Stripe client', { partnerId: inv.partnerId, err });
    throw new InvoiceServiceError('Could not initialize payment — please contact support', 500, 'STRIPE_INIT_FAILED');
  }

  // Shared portal-URL resolution (honors PUBLIC_PORTAL_URL and appends the
  // portal base path to app-origin fallbacks — the /portal segment is no
  // longer hand-appended below).
  const portalBaseUrl = portalBase();

  const { expiresAt, quantum } = checkoutSessionExpiry();

  // Truly outside any DB context/transaction — no pooled connection is held
  // across this ~hundreds-of-ms round trip.
  let session;
  try {
    session = await runOutsideDbContext(() => stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    // SEC-150 defence in depth: an explicit provider-side death clock, so an
    // unrevoked session cannot outlive the day even if every local control fails.
    expires_at: expiresAt,
    line_items: [{
      price_data: {
        currency: inv.currencyCode.toLowerCase(),
        unit_amount: chargeMinor,
        product_data: {
          name: chargeNow.isDeposit
            ? `Deposit — Invoice ${inv.invoiceNumber ?? inv.id}`
            : `Invoice ${inv.invoiceNumber ?? inv.id}`,
        },
      },
      quantity: 1,
    }],
    // {CHECKOUT_SESSION_ID} is substituted by Stripe on redirect — the portal
    // verify-on-return handler reads it to settle server-side. Provider-side
    // reversals are observed independently by the direct-account event poller.
    success_url: urls.successUrl ?? `${portalBaseUrl}/invoices/${inv.id}?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: urls.cancelUrl ?? `${portalBaseUrl}/invoices/${inv.id}`,
    metadata: {
      invoice_id: inv.id,
      org_id: inv.orgId,
      partner_id: inv.partnerId,
      // Historically the full balance; now the amount actually charged in THIS
      // session (deposit or balance). Write-only — the settle path (stripeSettle.ts)
      // records what Stripe reports paid via session.amount_total, never this field.
      invoice_balance_cents: String(chargeMinor),
    },
  }, {
    // Identical (invoice, charge-now amount, phase) reuses the session instead of
    // creating a second pending mapping — safe for repeated "send link" clicks. A
    // 50%-deposit invoice has the SAME chargeMinor for the deposit and the later
    // balance charge (different product name but equal amount), so the amount
    // alone can't disambiguate — the explicit dep/bal discriminator does.
    // `_e<quantum>` (SEC-150): `expires_at` is part of the request, and Stripe
    // refuses an idempotent replay whose parameters moved. Folding the hour
    // quantum into the key keeps the replay identical within the hour instead of
    // erroring across one.
    idempotencyKey: `inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit ? 'dep' : 'bal'}${urls.idempotencySuffix ?? ''}_e${quantum}`,
  }));
  } catch (err) {
    // Friendly mapping (spec §10): a currency the account cannot present becomes a
    // partner-facing 409 STRIPE_CURRENCY_UNSUPPORTED; everything else propagates.
    const mapped = mapStripeCheckoutError(err, inv.currencyCode);
    if (mapped) throw mapped;
    throw err;
  }

  if (!session.url) throw new InvoiceServiceError('Stripe did not return a checkout URL', 500, 'STRIPE_NO_URL');

  // Fresh short context so the pending-mapping write isn't a contextless 0-row
  // no-op under forced-RLS breeze_app (#1375).
  let raced = false;
  await withSystemDbAccessContext(async () => {
    // Serialize the final mapping insert against account replacement. If the
    // key changed during the external Checkout call, never return an orphaned
    // payment URL whose future reversals cannot be observed.
    const [currentConnection] = await db.select({ id: stripeConnectAccounts.id })
      .from(stripeConnectAccounts).where(and(
        eq(stripeConnectAccounts.partnerId, inv.partnerId),
        eq(stripeConnectAccounts.stripeAccountId, stripeAccountId),
        eq(stripeConnectAccounts.status, 'connected'),
      )).limit(1).for('share');
    if (!currentConnection) {
      throw new InvoiceServiceError('Stripe connection changed while creating the payment link — please retry', 409, 'STRIPE_NOT_CONNECTED');
    }
    // SEC-150: did a reset/void/pay record revocation intent WHILE the Stripe
    // round-trip was in flight? Read it here, but never refuse before the
    // mapping is written — a session that exists on Stripe with no mapping row
    // is an orphan no revocation can ever find, which is strictly worse than
    // the race we are closing. The mapping commits first; the caller then
    // revokes it and refuses.
    const [racedRevocation] = await db.select({ id: invoiceStripePayments.id })
      .from(invoiceStripePayments)
      .where(and(
        eq(invoiceStripePayments.invoiceId, inv.id),
        eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
        eq(invoiceStripePayments.revocationState, 'revocation_requested'),
      )).limit(1);
    raced = racedRevocation !== undefined;
    await db.insert(invoiceStripePayments).values({
      orgId: inv.orgId,
      invoiceId: inv.id,
      stripeAccountId,
      stripeObjectType: 'checkout_session',
      stripeObjectId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      amount: chargeNow.amount,
      currency: inv.currencyCode,
      status: 'pending',
      providerExpiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date(expiresAt * 1000),
    });
    if (raced) {
      // Stamp intent on THIS transaction handle. Never `requestInvoiceSessionRevocation`
      // here: it escapes the context and re-takes the invoice row FOR UPDATE, which
      // self-deadlocks against the FOR KEY SHARE the INSERT above already holds
      // whenever this runs inside a caller's request transaction (create_pay_link via
      // the AI tools, the public invoice-link route). The sweep expires it within 60s.
      await markSessionRevocationRequestedInTx(session.id, 'raced_revocation', actor.userId, db);
    }
  });

  if (raced) {
    throw new InvoiceServiceError(
      'A payment link for this invoice is still being revoked — try again in a moment.',
      409, 'STRIPE_REVOCATION_PENDING',
    );
  }

  // Warn-don't-block (spec §10): the session is ALWAYS minted in the document
  // currency; a differing account default is surfaced so the partner knows they
  // bear the FX spread. Built from the cached column returned with the client —
  // no extra query, no Stripe refresh on the pay path. The key is omitted (not
  // `undefined`) when there is nothing to warn about.
  const warning = buildStripeCurrencyWarning(inv.currencyCode, defaultCurrency);
  return warning ? { url: session.url, warning } : { url: session.url };
}
