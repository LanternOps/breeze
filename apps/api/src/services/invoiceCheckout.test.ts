const { prepareSaveMock } = vi.hoisted(() => ({ prepareSaveMock: vi.fn(async (
  _invoiceId: string, _orgId: string, _input: { saveForAutopay?: boolean }, _checkoutKey: string,
): Promise<{ id: string; stripeCustomerId: string } | null> => null) }));
vi.mock('./autopay/payAndSave', async importOriginal => {
  const actual = await importOriginal<typeof import('./autopay/payAndSave')>();
  return { ...actual, prepareCardPayAndSave: prepareSaveMock };
});

const reservation = vi.hoisted(() => ({ assert: vi.fn(), lock: vi.fn(), invoice: null as Record<string, unknown> | null }));
// holdsClientMoney (unapplied money, B1-2) is proven on real Postgres in charging.integration.test.ts.
vi.mock('./autopay/reservation', () => ({ assertNoActiveCollection: reservation.assert, holdsClientMoney: async () => false, lockInvoiceForCollection: reservation.lock }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSelfManagedDbContextRoute } from '../middleware/selfManagedDbContextRoutes';

// DB mock: select().from().where().limit() resolves to the next queued row set;
// insert().values() is a thenable so the mapping-row write awaits cleanly.
// Mirrors the pattern in routes/portal/invoices.test.ts.
const { dbResults, insertValuesMock, mappings } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  insertValuesMock: vi.fn(),
  mappings: new Map<string,Record<string,unknown>>(),
}));
// The fail-closed Checkout-session revocation phases run BEFORE this
// suite's transaction and issue their own queries. This file drives a
// hand-rolled Drizzle mock whose result queue would be consumed by them, so the
// revocation is stubbed out here and proved for real — against Postgres, with a
// mocked Stripe SDK — in __tests__/integration/stripeSessionRevocation.integration.test.ts.
vi.mock('./stripeSessionRevocation', () => ({
  requestInvoiceSessionRevocation: vi.fn(async () => ({
    requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0,
  })),
  assertInvoiceSessionsRevoked: vi.fn(async () => undefined),
  assertNoPendingRevocation: vi.fn(async () => undefined),
  markSiblingRevocationIntentInTx: vi.fn(async () => 0),
  markSessionChargedRepair: vi.fn(async () => false),
  REVOCATION_PENDING_CODE: 'STRIPE_REVOCATION_PENDING',
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'leftJoin', 'where', 'limit', 'for', 'update', 'set']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      const first = rows[0];
      if (first && typeof first === 'object' && 'currencyCode' in first && 'balance' in first) reservation.invoice = first as Record<string, unknown>;
      return Promise.resolve(rows).then(resolve);
    };
    (chain as { insert: unknown }).insert = vi.fn(() => ({
      values: (v: any) => { insertValuesMock(v);let ignore=false;
        const result:any={onConflictDoNothing:()=>{ignore=true;return result;},returning:()=>result,
          then:(resolve:any,reject:any)=>{const prior=mappings.get(v.stripeObjectId);if(prior&&!ignore)return Promise.reject(new Error('invoice_stripe_payments_object_uq')).then(resolve,reject);
            if(!prior)mappings.set(v.stripeObjectId,v);return Promise.resolve(prior?[]:[{invoiceId:v.invoiceId}]).then(resolve,reject);}};return result; },
    }));
    return chain;
  };
  return {
    db: makeChain(),
    hasDbAccessContext: () => false,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

// Partner Stripe-key mocks (API-key model — no Connect).
const { sessionsCreateMock, getPartnerStripeClientMock } = vi.hoisted(() => ({
  sessionsCreateMock: vi.fn(),
  getPartnerStripeClientMock: vi.fn(),
}));
vi.mock('./partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    getPartnerStripeClient: getPartnerStripeClientMock,
  };
});

// requireOrgAccess/requireSiteAccess only — the rest of invoiceService is
// irrelevant here and pulls in unrelated schema imports, so keep the mock minimal
// (both no-op by default; site enforcement is exercised in the siteScope suites).
const { requireOrgAccessMock, requireSiteAccessMock } = vi.hoisted(() => ({
  requireOrgAccessMock: vi.fn(),
  requireSiteAccessMock: vi.fn(),
}));
vi.mock('./invoiceService', () => ({
  requireOrgAccess: requireOrgAccessMock,
  requireSiteAccess: requireSiteAccessMock,
}));

import { createInvoicePayLink, checkoutSessionExpiry } from './invoiceCheckout';
import { assertNoPendingRevocation } from './stripeSessionRevocation';
import { InvoiceServiceError } from './invoiceTypes';

// Default fixture: a cached USD account (matches the USD invoices below, so no
// warning). Currency tests override defaultCurrency explicitly — `null` now
// means an explicit STRIPE_ACCOUNT_CURRENCY_UNKNOWN warning (review F6).
const partnerClient = (stripeAccountId = 'acct_9') => ({
  stripe: { checkout: { sessions: { create: sessionsCreateMock } } },
  stripeAccountId,
  defaultCurrency: 'USD' as string | null,
});

const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

/**
 * `expires_at` is now part of every sessions.create request, and Stripe
 * refuses an idempotent replay whose parameters moved — so the hour quantum is
 * folded into the key too. Both are asserted through the real
 * `checkoutSessionExpiry`, not a hardcoded literal: a drift between the value
 * sent to Stripe and the value baked into the key would be an
 * `idempotency_key_in_use` error in production that a literal would hide.
 */
function expectedIdempotencyKey(base: string): string {
  // _pd: the request carries a PaymentIntent description (FP-20); a new key keeps an in-hour replay identical.
  return `${base}_e${checkoutSessionExpiry().quantum}_pd`;
}

describe('createInvoicePayLink', () => {
it('checked card payments retain card-only Checkout and a stable save-enabled retry family', async () => {
  const captureId = '33333333-3333-4333-8333-333333333333';
  prepareSaveMock.mockResolvedValue({ id: captureId, stripeCustomerId: 'cus_saved' });
  getPartnerStripeClientMock.mockResolvedValue(partnerClient());
  sessionsCreateMock.mockResolvedValue({ id: 'cs_saved', url: 'https://checkout.stripe.com/c/cs_saved', payment_intent: 'pi_saved' });
  for (let replay = 0; replay < 2; replay++) {
    dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: actor.partnerId, status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00', currencyCode: 'USD', invoiceNumber: 'INV-SAVE', partnerName: 'Example MSP' }],
      [{ id: '44444444-4444-4444-8444-444444444444' }], []);
    if(replay)dbResults.push([{invoiceId:INV_ID,stripeAccountId:'acct_9'}]);
    await createInvoicePayLink(INV_ID, actor, {
      saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64),
    });
  }
  expect(sessionsCreateMock).toHaveBeenCalledTimes(2);
  for (const [params, options] of sessionsCreateMock.mock.calls) {
    expect(params).toMatchObject({ mode: 'payment', payment_method_types: ['card'], customer: 'cus_saved',
      metadata: { autopay_setup_attempt_id: captureId },
      payment_intent_data: { setup_future_usage: 'off_session', metadata: { autopay_setup_attempt_id: captureId } },
      wallet_options: { link: { display: 'never' } } });
    expect(options.idempotencyKey).toBe(expectedIdempotencyKey(`inv_${INV_ID}_10000_bal_save_${captureId}`));
    // FP-20: pay-link PaymentIntents carry a description, as autopay ones do.
    expect(params.payment_intent_data).toMatchObject({ description: 'Invoice INV-SAVE · Example MSP' });
  }
  expect(prepareSaveMock.mock.calls[0]?.[3]).toBe(prepareSaveMock.mock.calls[1]?.[3]);
});

  beforeEach(() => {
    reservation.invoice = null; reservation.assert.mockResolvedValue(undefined); reservation.lock.mockImplementation(async () => ({ invoice: reservation.invoice, reservedAmount: '0.00' }));
    vi.clearAllMocks(); mappings.clear();
    dbResults.length = 0;
    insertValuesMock.mockReset(); mappings.clear();
    prepareSaveMock.mockResolvedValue(null);
  });

it('refuses a reserved invoice before calling Stripe', async () => {
  dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent', currencyCode: 'USD', balance: '100.00' }]);
  reservation.assert.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  await expect(createInvoicePayLink(INV_ID, actor)).rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS' });
  expect(sessionsCreateMock).not.toHaveBeenCalled();
});

  it('refuses to reach Stripe at all while a revocation is in flight', async () => {
    // The gate has to fire BEFORE checkout.sessions.create, not after: a session
    // that exists on Stripe is payable the moment it is minted, so a gate placed
    // after the round-trip would still hand out a live capability during exactly
    // the window the revocation intent exists to close.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-GATE',
    }]);
    vi.mocked(assertNoPendingRevocation).mockRejectedValueOnce(
      new InvoiceServiceError('still revoking', 409, 'STRIPE_REVOCATION_PENDING'),
    );

    await expect(createInvoicePayLink(INV_ID, actor))
      .rejects.toMatchObject({ status: 409, code: 'STRIPE_REVOCATION_PENDING' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('deposit unpaid: charges the deposit-remaining amount, not the full balance', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '3000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', payment_intent: 'pi_1' });
    dbResults.push([{ id: 'connection' }]);

    const result = await createInvoicePayLink(INV_ID, actor);
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/cs_1' });
    // An ordinary pay link saves nothing, so its wallet choices are left to Stripe.
    expect(sessionsCreateMock.mock.calls[0]![0]).not.toHaveProperty('wallet_options');

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 300000,
            product_data: { name: 'Deposit — Invoice INV-1' },
          }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '300000' }),
      }),
      { idempotencyKey: expectedIdempotencyKey(`inv_${INV_ID}_300000_dep`) },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '3000.00' }));
  });

  it('deposit already satisfied: charges the remaining balance with a plain product name', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '7000.00', depositDue: '3000.00', amountPaid: '3000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2', payment_intent: 'pi_2' });
    dbResults.push([{ id: 'connection' }]);

    await createInvoicePayLink(INV_ID, actor);

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 700000,
            product_data: { name: 'Invoice INV-1' },
          }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '700000' }),
      }),
      { idempotencyKey: expectedIdempotencyKey(`inv_${INV_ID}_700000_bal`) },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '7000.00' }));
  });

  it('no-deposit invoice: unchanged full-balance charge (byte-identical to pre-deposit behavior)', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-3',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_3', url: 'https://checkout.stripe.com/c/cs_3', payment_intent: 'pi_3' });
    dbResults.push([{ id: 'connection' }]);

    await createInvoicePayLink(INV_ID, actor);

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 10000,
            product_data: { name: 'Invoice INV-3' },
          }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '10000' }),
      }),
      { idempotencyKey: expectedIdempotencyKey(`inv_${INV_ID}_10000_bal`) },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '100.00' }));
  });

  it('deposit-phase and balance-phase idempotency keys differ for the SAME charge amount (#idempotency-collision)', async () => {
    // A 50%-deposit invoice: depositDue exactly equals the eventual balance
    // charge amount, so chargeMinor is IDENTICAL for the deposit session and the
    // later full-balance session. Without a phase discriminator the two Stripe
    // idempotencyKeys would collide and the second session creation would be
    // rejected with idempotency_error for ~24h.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '5000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep_eq', url: 'https://checkout.stripe.com/c/cs_dep_eq', payment_intent: 'pi_dep_eq' });
    dbResults.push([{ id: 'connection' }]);
    await createInvoicePayLink(INV_ID, actor);
    const depositKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(depositKey).toBe(expectedIdempotencyKey(`inv_${INV_ID}_500000_dep`));

    vi.clearAllMocks(); mappings.clear();
    // Deposit now fully paid: the balance charge is ALSO 5000.00 (equal minor
    // amount to the deposit above) — simulating the exact collision scenario.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '5000.00', depositDue: '5000.00', amountPaid: '5000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_bal_eq', url: 'https://checkout.stripe.com/c/cs_bal_eq', payment_intent: 'pi_bal_eq' });
    dbResults.push([{ id: 'connection' }]);
    await createInvoicePayLink(INV_ID, actor);
    const balanceKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(balanceKey).toBe(expectedIdempotencyKey(`inv_${INV_ID}_500000_bal`));

    expect(depositKey).not.toBe(balanceKey);
  });

  it('throws NOTHING_TO_PAY when the charge-now amount is zero', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '0.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-4',
    }]);

    await expect(createInvoicePayLink(INV_ID, actor)).rejects.toMatchObject({ code: 'NOTHING_TO_PAY' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  // ---- multi-currency (#3777): warn-don't-block + friendly currency error ----

  it('returns a CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT warning when the account settles in another currency (never blocks)', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'EUR', invoiceNumber: 'INV-EUR',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'USD' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_eur', url: 'https://checkout.stripe.com/c/cs_eur', payment_intent: 'pi_eur' });
    dbResults.push([{ id: 'connection' }]);

    const result = await createInvoicePayLink(INV_ID, actor);
    expect(result).toEqual({
      url: 'https://checkout.stripe.com/c/cs_eur',
      warning: {
        code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT',
        documentCurrency: 'EUR',
        accountCurrency: 'USD',
        message: expect.stringContaining('FX spread'),
      },
    });
    // The session is still created in the DOCUMENT currency — no conversion.
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({ price_data: expect.objectContaining({ currency: 'eur' }) })],
      }),
      expect.anything(),
    );
  });

  it('account currency not cached (null): returns an explicit STRIPE_ACCOUNT_CURRENCY_UNKNOWN warning and still mints the session (review F6)', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'EUR', invoiceNumber: 'INV-EUR',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: null });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_unk', url: 'https://checkout.stripe.com/c/cs_unk', payment_intent: 'pi_unk' });
    dbResults.push([{ id: 'connection' }]);

    const result = await createInvoicePayLink(INV_ID, actor);
    expect(result).toEqual({
      url: 'https://checkout.stripe.com/c/cs_unk',
      warning: {
        code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN',
        documentCurrency: 'EUR',
        accountCurrency: null,
        message: expect.stringMatching(/refresh/i),
      },
    });
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
  });

  it('omits the warning key entirely when the account currency matches', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'EUR', invoiceNumber: 'INV-EUR',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'eur' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_eur2', url: 'https://checkout.stripe.com/c/cs_eur2', payment_intent: 'pi_eur2' });
    dbResults.push([{ id: 'connection' }]);

    const result = await createInvoicePayLink(INV_ID, actor);
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/cs_eur2' });
    expect('warning' in result).toBe(false);
  });

  it('rejects a Checkout session whose account changed before mapping persistence', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-RACE',
    }]);
    dbResults.push([]); // final FOR SHARE revalidation sees no matching connection
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_old'));
    sessionsCreateMock.mockResolvedValue({
      id: 'cs_orphan_candidate', url: 'https://checkout.stripe.com/c/cs_orphan_candidate', payment_intent: 'pi_race',
    });

    await expect(createInvoicePayLink(INV_ID, actor)).rejects.toMatchObject({
      code: 'STRIPE_NOT_CONNECTED', status: 409,
    });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('maps a Stripe currency_not_supported rejection to STRIPE_CURRENCY_UNSUPPORTED (409) naming the currency', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'CHF', invoiceNumber: 'INV-CHF',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'USD' });
    sessionsCreateMock.mockRejectedValue(Object.assign(new Error('Invalid currency: chf'), {
      type: 'StripeInvalidRequestError', code: 'currency_not_supported',
    }));

    const p = createInvoicePayLink(INV_ID, actor);
    await expect(p).rejects.toBeInstanceOf(InvoiceServiceError);
    await expect(p).rejects.toMatchObject({ code: 'STRIPE_CURRENCY_UNSUPPORTED', status: 409 });
    await expect(p).rejects.toThrow(/CHF/);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('propagates a non-currency Stripe error (StripeCardError) unchanged', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-CARD',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'USD' });
    const cardErr = Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' });
    sessionsCreateMock.mockRejectedValue(cardErr);

    await expect(createInvoicePayLink(INV_ID, actor)).rejects.toBe(cardErr);
  });
});

 describe('Checkout request transaction ownership', () => {
  it.each([
    '/api/v1/invoices/invoice-id/pay-link',
    '/api/v1/invoices/public/token/pay',
    '/api/v1/portal/invoices/invoice-id/pay',
    '/api/v1/portal/quotes/quote-id/pay',
  ])('POST %s owns its short DB contexts', path => {
    expect(isSelfManagedDbContextRoute('POST', path)).toBe(true);
    expect(isSelfManagedDbContextRoute('GET', path)).toBe(false);
  });
});

it('reuses a public/MSP Checkout mapping on repeated create',async()=>{
 mappings.clear();dbResults.length=0;prepareSaveMock.mockResolvedValue(null);
 getPartnerStripeClientMock.mockResolvedValue(partnerClient());sessionsCreateMock.mockResolvedValue({id:'cs_reuse',url:'https://checkout.stripe.com/c/cs_reuse'});
 const inv={id:INV_ID,orgId:ORG_ID,partnerId:actor.partnerId,status:'sent',balance:'100.00',currencyCode:'USD',amountPaid:'0.00'};
 for(let i=0;i<2;i++){
  dbResults.push([inv],[{id:'connection'}],[]);if(i)dbResults.push([{invoiceId:INV_ID,stripeAccountId:'acct_9'}]);
  await expect(createInvoicePayLink(INV_ID,actor)).resolves.toMatchObject({url:'https://checkout.stripe.com/c/cs_reuse'});
 }
 expect(mappings.size).toBe(1);
});
