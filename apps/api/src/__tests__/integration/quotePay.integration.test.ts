/**
 * Real-DB tests for createQuotePayLink (Phase 3 accept→pay). It resolves a
 * converted quote's invoice and delegates to createInvoicePayLink. Stripe SDK +
 * connection lookup are mocked; the quote/invoice reads + guards run against
 * Postgres. Verifies: NOT_CONVERTED guard (before any Stripe work), the happy
 * path (accepted quote → auto-issued invoice → checkout url), and that a
 * recurring-only ($0, still-draft invoice) converted quote is NOT_PAYABLE.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createPartner, createOrganization } from './db-utils';

// #1610 replaced Stripe Connect with the per-partner API-key model: createInvoicePayLink
// now resolves the partner's client via getPartnerStripeClient (./partnerStripe) and maps a
// NO_STRIPE_KEY PartnerStripeError to STRIPE_NOT_CONNECTED. Mock that seam — the old
// stripeClient/stripeConnectService modules are no longer on the pay path.
const { sessionsCreateMock, getPartnerStripeClientMock, PartnerStripeError } = vi.hoisted(() => {
  class PartnerStripeError extends Error {
    readonly status: number;
    constructor(message: string, readonly code: 'NO_STRIPE_KEY' | 'INVALID_STRIPE_KEY' | 'STRIPE_KEY_UNREADABLE') {
      super(message);
      this.name = 'PartnerStripeError';
      this.status = code === 'NO_STRIPE_KEY' ? 409 : code === 'INVALID_STRIPE_KEY' ? 400 : 500;
    }
  }
  return { sessionsCreateMock: vi.fn(), getPartnerStripeClientMock: vi.fn(), PartnerStripeError };
});
vi.mock('../../services/partnerStripe', () => ({
  getPartnerStripeClient: getPartnerStripeClientMock,
  PartnerStripeError,
}));

import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { createQuotePayLink } from '../../services/quotePay';
import type { QuoteActor } from '../../services/quoteTypes';
import type { InvoiceActor } from '../../services/invoiceTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext { return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null }; }
function qActor(orgId: string, partnerId: string): QuoteActor { return { userId: null, partnerId, accessibleOrgIds: [orgId] }; }
function iActor(orgId: string, partnerId: string): InvoiceActor { return { userId: null, partnerId, accessibleOrgIds: [orgId] }; }
async function seed() { return withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partner, org }; }); }

describe('createQuotePayLink (breeze_app, real DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPartnerStripeClientMock.mockResolvedValue({ stripe: { checkout: { sessions: { create: sessionsCreateMock } } }, stripeAccountId: 'acct_test' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_quote_1', url: 'https://checkout.stripe.com/c/pay/quote', payment_intent: null });
  });

  runDb('accepted quote → auto-issued invoice → returns the checkout url', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => sendQuote(created.id, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));

    const res = await withSystemDbAccessContext(() => createQuotePayLink(created.id, iActor(org.id, partner.id)));
    expect(res.url).toBe('https://checkout.stripe.com/c/pay/quote');
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
    // $250.00 → 25000 minor units, charged on the converted invoice.
    expect(sessionsCreateMock.mock.calls[0]![0].line_items[0].price_data.unit_amount).toBe(25000);
  });

  runDb('a quote that has not been accepted/converted → NOT_CONVERTED, no Stripe call', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => sendQuote(created.id, qActor(org.id, partner.id))); // sent, not converted

    await expect(withSystemDbAccessContext(() => createQuotePayLink(created.id, iActor(org.id, partner.id))))
      .rejects.toMatchObject({ status: 409, code: 'NOT_CONVERTED' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  runDb('a recurring-only ($0) converted quote → NOT_PAYABLE (its invoice stayed draft)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 99, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => sendQuote(created.id, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Bob' }));

    await expect(withSystemDbAccessContext(() => createQuotePayLink(created.id, iActor(org.id, partner.id))))
      .rejects.toMatchObject({ status: 409, code: 'NOT_PAYABLE' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  runDb('a corrupt/undecryptable partner key → STRIPE_INIT_FAILED (500), not the 409 "connect Stripe" lie', async () => {
    // #1610 forks the connection lookup: NO_STRIPE_KEY is a benign 409, but a
    // STRIPE_KEY_UNREADABLE (decrypt fault / KEK rotated away) must surface as an
    // internal 500 — not "connect Stripe first". Guards invoiceCheckout.ts:42-50.
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('stored key unreadable', 'STRIPE_KEY_UNREADABLE'));
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => sendQuote(created.id, qActor(org.id, partner.id)));
    await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));

    await expect(withSystemDbAccessContext(() => createQuotePayLink(created.id, iActor(org.id, partner.id))))
      .rejects.toMatchObject({ status: 500, code: 'STRIPE_INIT_FAILED' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
