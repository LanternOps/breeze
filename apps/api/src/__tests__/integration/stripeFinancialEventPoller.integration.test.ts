/** Real-PostgreSQL cursor/inbox proof with a synthetic Stripe SDK page. */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, stripeConnectAccounts, stripeFinancialEvents } from '../../db/schema';

const { eventsList, clientBinding } = vi.hoisted(() => ({
  eventsList: vi.fn(),
  clientBinding: { accountByPartner: new Map<string, string>() },
}));
vi.mock('../../services/partnerStripe', () => ({
  getPartnerStripeClient: vi.fn(async (partnerId: string) => ({
    stripe: { events: { list: eventsList }, charges: { retrieve: vi.fn() } },
    stripeAccountId: clientBinding.accountByPartner.get(partnerId),
    defaultCurrency: 'USD',
  })),
}));
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { pollPartnerStripeFinancialEvents } from '../../services/stripeFinancialEventPoller';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedConnection() {
  return withSystemDbAccessContext(async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const [partner] = await db.insert(partners).values({
      name: `Stripe poll ${suffix}`, slug: `stripe-poll-${suffix}`,
      type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const accountId = `acct_${suffix}`;
    await db.insert(stripeConnectAccounts).values({
      partnerId: partner!.id, stripeAccountId: accountId,
      apiKey: 'enc:synthetic', keyLast4: 'test', livemode: false,
      financialEventCursorCreated: 100,
    });
    clientBinding.accountByPartner.set(partner!.id, accountId);
    return { partnerId: partner!.id, accountId };
  });
}

describe('direct-account Stripe financial event cursor (real PostgreSQL)', () => {
  beforeEach(() => {
    eventsList.mockReset();
    clientBinding.accountByPartner.clear();
  });

  runDb('persists a page before its bounded continuation cursor, then completes the pinned scan', async () => {
    const f = await seedConnection();
    eventsList.mockResolvedValueOnce({
      has_more: true,
      data: [{
        id: 'evt_page_1', type: 'charge.refunded', account: null, livemode: false, created: 150,
        data: { object: { id: 'ch_1', payment_intent: 'pi_not_linked_yet', amount: 10_000, amount_refunded: 1_000, currency: 'usd' } },
      }],
    });
    expect(await pollPartnerStripeFinancialEvents(f.partnerId, new Date(200_000))).toBe(1);

    let [connection] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, f.partnerId)));
    const [durable] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_page_1')));
    expect(durable).toMatchObject({ partnerId: f.partnerId, stripeAccountId: f.accountId, status: 'pending' });
    expect(connection).toMatchObject({
      financialEventCursorCreated: 100,
      financialEventPageAfter: 'evt_page_1',
      financialEventScanUpperCreated: 200,
    });

    eventsList.mockResolvedValueOnce({ has_more: false, data: [] });
    expect(await pollPartnerStripeFinancialEvents(f.partnerId, new Date(999_000))).toBe(0);
    [connection] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, f.partnerId)));
    expect(connection).toMatchObject({
      financialEventCursorCreated: 200,
      financialEventPageAfter: null,
      financialEventScanUpperCreated: null,
    });
    expect(eventsList.mock.calls[1]?.[0]).toMatchObject({
      created: { gte: 100, lte: 200 }, starting_after: 'evt_page_1', limit: 100,
    });
  });

  runDb('does not advance the cursor when account/livemode binding fails', async () => {
    const f = await seedConnection();
    eventsList.mockResolvedValueOnce({
      has_more: false,
      data: [{
        id: 'evt_wrong_mode', type: 'charge.refunded', account: null, livemode: true, created: 150,
        data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10_000, amount_refunded: 1_000, currency: 'usd' } },
      }],
    });
    await expect(pollPartnerStripeFinancialEvents(f.partnerId, new Date(200_000))).rejects.toThrow(/livemode/);
    const [connection] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, f.partnerId)));
    expect(connection!.financialEventCursorCreated).toBe(100);
    expect(connection!.financialEventPageAfter).toBeNull();
  });

  runDb('polls previously untouched accounts before cycling old timestamps', async () => {
    for (let i = 0; i < 26; i += 1) await seedConnection();
    eventsList.mockResolvedValue({ has_more: false, data: [] });

    const { pollStripeFinancialEvents } = await import('../../services/stripeFinancialEventPoller');
    expect((await pollStripeFinancialEvents()).accounts).toBe(25);
    let untouched = await withSystemDbAccessContext(() => db.select({ id: stripeConnectAccounts.id })
      .from(stripeConnectAccounts).where(isNull(stripeConnectAccounts.financialEventLastPolledAt)));
    expect(untouched).toHaveLength(1);

    expect((await pollStripeFinancialEvents()).accounts).toBe(25);
    untouched = await withSystemDbAccessContext(() => db.select({ id: stripeConnectAccounts.id })
      .from(stripeConnectAccounts).where(isNull(stripeConnectAccounts.financialEventLastPolledAt)));
    expect(untouched).toHaveLength(0);
  });

  runDb('quarantines a no-PaymentIntent event, ingests the rest of the page and advances the cursor', async () => {
    const f = await seedConnection();
    // Stripe lists newest-first; the poller applies the page oldest-first, so
    // the legacy no-PaymentIntent event is the FIRST one processed.
    eventsList.mockResolvedValueOnce({
      has_more: false,
      data: [
        {
          id: 'evt_normal', type: 'charge.refunded', account: null, livemode: false, created: 160,
          data: { object: { id: 'ch_normal', payment_intent: 'pi_normal', amount: 10_000, amount_refunded: 1_000, currency: 'usd' } },
        },
        {
          id: 'evt_legacy', type: 'charge.refunded', account: null, livemode: false, created: 150,
          data: { object: { id: 'ch_legacy', payment_intent: null, amount: 10_000, amount_refunded: 2_000, currency: 'usd' } },
        },
      ],
    });

    expect(await pollPartnerStripeFinancialEvents(f.partnerId, new Date(200_000))).toBe(2);

    const [legacy] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_legacy')));
    expect(legacy).toMatchObject({ status: 'blocked', paymentIntentId: null });
    expect(legacy!.lastError).toMatch(/no PaymentIntent/);
    const [normal] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_normal')));
    expect(normal).toMatchObject({ status: 'pending', paymentIntentId: 'pi_normal' });

    const [connection] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, f.partnerId)));
    expect(connection).toMatchObject({
      financialEventCursorCreated: 200, financialEventPageAfter: null, financialEventScanUpperCreated: null,
    });
  });
});
