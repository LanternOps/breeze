import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
const m = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), client: vi.fn(), ingest: vi.fn(),
  replay: vi.fn(), setupReplay: vi.fn(), controls: vi.fn(), capture: vi.fn(), depth: 0 }));
vi.mock('../db', () => ({ db: { select: m.select, update: m.update },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    m.depth++; try { return await fn(); } finally { m.depth--; }
  },
  runOutsideDbContext: async (fn: () => unknown) => { expect(m.depth).toBe(0); return fn(); },
}));
vi.mock('./partnerStripe', () => ({ getPartnerStripeClient: m.client }));
vi.mock('./stripeReversalState', () => ({ ingestStripeFinancialEvent: m.ingest, processPendingStripeFinancialEvents: m.replay }));
vi.mock('./autopay/collectionControl', () => ({ reconcilePendingControls: m.controls }));
vi.mock('./autopay/setupReconciliation', () => ({ AUTOPAY_STRIPE_EVENT_TYPES: [],
  isAutopayStripeEvent: () => false, ingestAutopayStripeEvent: vi.fn(), replayAutopayStripeEvents: m.setupReplay }));
vi.mock('./sentry', () => ({ captureException: m.capture }));
import { STRIPE_FINANCIAL_EVENT_TYPES, normalizeStripeFinancialEvent, pollStripeFinancialEvents } from './stripeFinancialEventPoller';

const base = {
  partnerId: '11111111-1111-4111-8111-111111111111',
  stripeAccountId: 'acct_direct',
};

describe('normalizeStripeFinancialEvent', () => {
  it('normalizes cumulative refund state without trusting Event.account for direct-key identity', async () => {
    const stripe = { charges: { retrieve: vi.fn() } } as any;
    const result = await normalizeStripeFinancialEvent({ ...base, stripe, event: {
      id: 'evt_refund', type: 'charge.refunded', account: null, livemode: false, created: 100,
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 4000, currency: 'usd' } },
    } as any });
    expect(result).toMatchObject({
      stripeEventId: 'evt_refund', stripeAccountId: 'acct_direct', paymentIntentId: 'pi_1',
      chargeAmountMinor: 10000, refundedAmountMinor: 4000,
    });
  });

  it('resolves a dispute charge when the event snapshot has no PaymentIntent', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'ch_1', payment_intent: 'pi_1' });
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: { charges: { retrieve } } as any, event: {
      id: 'evt_dispute', type: 'charge.dispute.funds_withdrawn', account: null, livemode: false, created: 101,
      data: { object: { id: 'dp_1', payment_intent: null, charge: 'ch_1', amount: 10000, currency: 'usd', status: 'needs_response' } },
    } as any });
    expect(retrieve).toHaveBeenCalledWith('ch_1');
    expect(result).toMatchObject({ paymentIntentId: 'pi_1', disputeAmountMinor: 10000, disputeFundsWithdrawn: true });
  });

  it('maps funds reinstatement to an explicit reversible state transition', async () => {
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_restore', type: 'charge.dispute.funds_reinstated', account: null, livemode: false, created: 102,
      data: { object: { id: 'dp_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 10000, currency: 'usd', status: 'won' } },
    } as any });
    expect(result).toMatchObject({ disputeFundsWithdrawn: false, disputeId: 'dp_1' });
  });

  it('does not treat a dispute-created warning inquiry as withdrawn funds', async () => {
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_warning', type: 'charge.dispute.created', account: null, livemode: false, created: 102,
      data: { object: { id: 'dp_warning', payment_intent: 'pi_1', charge: 'ch_1', amount: 10000, currency: 'usd', status: 'warning_needs_response' } },
    } as any });
    expect(result).toMatchObject({ disputeFundsWithdrawn: null, disputeId: 'dp_warning' });
  });

  it('quarantines a refund on a legacy charge with no PaymentIntent instead of throwing', async () => {
    // A throw here happens inside the poller's page loop, before the cursor
    // advance: one such event would wedge the partner's channel forever.
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_legacy_refund', type: 'charge.refunded', account: null, livemode: false, created: 104,
      data: { object: { id: 'ch_legacy', payment_intent: null, amount: 10000, amount_refunded: 2500, currency: 'usd' } },
    } as any });
    expect(result).toMatchObject({
      stripeEventId: 'evt_legacy_refund', paymentIntentId: null,
      quarantineReason: expect.stringContaining('no PaymentIntent'),
    });
  });

  it('quarantines a dispute whose charge also has no PaymentIntent binding', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: 'ch_legacy', payment_intent: null });
    const result = await normalizeStripeFinancialEvent({ ...base, stripe: { charges: { retrieve } } as any, event: {
      id: 'evt_legacy_dispute', type: 'charge.dispute.funds_withdrawn', account: null, livemode: false, created: 105,
      data: { object: { id: 'dp_legacy', payment_intent: null, charge: 'ch_legacy', amount: 10000, currency: 'usd', status: 'lost' } },
    } as any });
    expect(retrieve).toHaveBeenCalledWith('ch_legacy');
    expect(result).toMatchObject({
      stripeEventId: 'evt_legacy_dispute', paymentIntentId: null,
      quarantineReason: expect.stringContaining('no PaymentIntent'),
    });
  });

  it('rejects an event attributed to a different account', async () => {
    await expect(normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
      id: 'evt_wrong', type: 'charge.refunded', account: 'acct_other', livemode: false, created: 103,
      data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 10000, amount_refunded: 1000, currency: 'usd' } },
    } as any })).rejects.toThrow(/account/);
  });
});

it.each(['payment_intent.succeeded', 'payment_intent.payment_failed',
  'payment_intent.processing', 'payment_intent.requires_action'])('normalizes durable %s identity', async type => {
  expect(STRIPE_FINANCIAL_EVENT_TYPES).toContain(type);
  const result = await normalizeStripeFinancialEvent({ ...base, stripe: {} as any, event: {
    id: 'evt_pi', type, account: base.stripeAccountId, livemode: false, created: 106,
    data: { object: { id: 'pi_1', amount: 10300, currency: 'usd' } },
  } as any });
  expect(result).toEqual({ ...base, stripeEventId: 'evt_pi', eventType: type,
    livemode: false, providerCreated: 106, paymentIntentId: 'pi_1', chargeAmountMinor: 10300, currency: 'usd' });
});


describe('polling retained accounts after disconnect', () => {
  const dialect = new PgDialect();
  const now = new Date('2026-10-20T00:00:00Z');
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); m.depth = 0;
    m.replay.mockResolvedValue(1); m.setupReplay.mockResolvedValue(0);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['succeeded', 'charge.dispute.funds_withdrawn', {
      id: 'dp_ach_return', payment_intent: 'pi_1', charge: 'ch_ach', amount: 10300,
      currency: 'usd', status: 'lost', reason: 'bank_cannot_process',
    }],
    ['failed', 'payment_intent.succeeded', { id: 'pi_1', amount: 10300, currency: 'usd' }],
  ])('polls a %s attempt’s %s after disconnect', async (state, type, object) => {
    const connection = { ...base, status: 'disconnected', apiKey: null, livemode: false,
      cursorCreated: 1792368000, pageAfter: null, scanUpperCreated: null };
    const predicates: ReturnType<PgDialect['sqlToQuery']>[] = [];
    m.select.mockImplementation((projection: Record<string, unknown>) => {
      let table: unknown;
      const chain = {
        from: (value: unknown) => { table = value; return chain; },
        where: (predicate: SQL) => {
          if (table === stripeConnectAccounts) {
            const query = dialect.sqlToQuery(predicate); predicates.push(query);
            // Both the global candidate query and the per-partner read must admit
            // this terminal mapped attempt, despite the missing active credential.
            expect(query.sql).toContain(`'${state}'`);
            expect(query.sql).toMatch(/or.*EXISTS/s);
            expect(query.sql).toContain('i.partner_id="stripe_connect_accounts"."partner_id"');
            expect(query.sql).toContain('m.stripe_account_id="stripe_connect_accounts"."stripe_account_id"');
            expect(query.sql).not.toMatch(/created_at|interval/i);
            if ('stripeAccountId' in projection) expect(query.params).toContain(base.partnerId);
          }
          return chain;
        },
        orderBy: () => chain,
        limit: async () => [connection],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ value: 0 }]).then(resolve),
      };
      return chain;
    });
    const event = { id: 'evt_after_disconnect', type, account: base.stripeAccountId,
      livemode: false, created: connection.cursorCreated + 1, data: { object } };
    const list = vi.fn(async () => {
      expect(m.depth).toBe(0);
      return { data: [event], has_more: false };
    });
    m.client.mockImplementation(async (partnerId, options) => {
      expect(partnerId).toBe(base.partnerId);
      expect(options).toEqual({ reconciliationAccountId: base.stripeAccountId, reason: 'financial_event_poll' });
      return { stripeAccountId: base.stripeAccountId, stripe: { events: { list } } };
    });
    const writes: unknown[] = [];
    m.update.mockImplementation((table: unknown) => ({ set: (values: unknown) => ({ where: (predicate: SQL) => {
      expect(table).toBe(stripeConnectAccounts);
      expect(m.ingest).toHaveBeenCalledOnce(); // durable ingestion precedes cursor movement
      const query = dialect.sqlToQuery(predicate);
      expect(query.params).toEqual([base.partnerId, base.stripeAccountId]);
      expect(query.sql).not.toContain('"status"');
      writes.push(values);
      return { returning: async () => [{ id: 'connection' }] };
    } }) }));

    // #7897: the event applies while it is ingested (nothing left to replay) and still counts.
    m.ingest.mockResolvedValue({ state: 'applied' }); m.replay.mockResolvedValue(0);
    await expect(pollStripeFinancialEvents()).resolves.toEqual({ accounts: 1, events: 1, applied: 1 });
    expect(predicates).toHaveLength(2);
    expect(m.client).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ types: [...STRIPE_FINANCIAL_EVENT_TYPES],
      created: { gte: connection.cursorCreated, lte: now.getTime() / 1000 }, limit: 100 });
    expect(m.ingest).toHaveBeenCalledWith(expect.objectContaining({ ...base,
      stripeEventId: event.id, eventType: type, paymentIntentId: 'pi_1', livemode: false, currency: 'usd',
      ...(state === 'succeeded' ? { disputeFundsWithdrawn: true, disputeAmountMinor: 10300 } : { chargeAmountMinor: 10300 }),
    }));
    expect(writes).toEqual([expect.objectContaining({ financialEventCursorCreated: now.getTime() / 1000,
      financialEventPageAfter: null, financialEventScanUpperCreated: null, financialEventLastError: null })]);
    expect(m.replay).toHaveBeenCalledWith(100);
    expect(m.setupReplay).toHaveBeenCalledOnce();
    expect(m.controls).toHaveBeenCalledTimes(state === 'failed' ? 1 : 0);
    expect(m.capture).not.toHaveBeenCalled();
  });
});

// #8021: a partner whose reversals are blocked for operator review stays in that
// state until someone acts, so the poller must page Sentry when the state is
// entered or grows — not on every 10-minute sweep — while the partner-facing
// banner is still re-asserted on each poll.
describe('blocked reversal alerting', () => {
  const REVIEW = 'One or more Stripe payment reversals require operator review.';
  const now = new Date('2026-10-20T00:00:00Z');
  const previousPoll = new Date('2026-10-19T23:50:00Z');
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); m.depth = 0;
    m.replay.mockResolvedValue(0); m.setupReplay.mockResolvedValue(0);
  });
  afterEach(() => vi.useRealTimers());

  async function sweep(opts: { lastError: string | null; lastPolledAt: Date | null; blocked: number; fresh: number }) {
    const connection = { ...base, livemode: false, cursorCreated: 1792368000, pageAfter: null,
      scanUpperCreated: null, lastError: opts.lastError, lastPolledAt: opts.lastPolledAt };
    m.select.mockImplementation(() => {
      const chain = {
        from: () => chain, where: () => chain, orderBy: () => chain,
        limit: async () => [connection],
        then: (resolve: (rows: unknown[]) => unknown) =>
          Promise.resolve([{ value: opts.blocked, fresh: opts.fresh }]).then(resolve),
      };
      return chain;
    });
    m.client.mockResolvedValue({ stripeAccountId: base.stripeAccountId,
      stripe: { events: { list: vi.fn(async () => ({ data: [], has_more: false })) } } });
    const writes: Record<string, unknown>[] = [];
    m.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => {
      writes.push(values);
      return { where: () => Object.assign(Promise.resolve(), { returning: async () => [{ id: 'connection' }] }) };
    } }));
    await pollStripeFinancialEvents();
    return writes;
  }

  it('pages when a partner first enters operator review', async () => {
    const writes = await sweep({ lastError: null, lastPolledAt: previousPoll, blocked: 41, fresh: 0 });
    expect(m.capture).toHaveBeenCalledOnce();
    expect(m.capture.mock.calls[0]![0].message).toBe('Stripe payment reversal requires operator review');
    expect(writes.at(-1)).toMatchObject({ financialEventLastError: REVIEW });
  });

  it('does not page again on later sweeps while nothing new is blocked, but keeps the banner', async () => {
    const writes = await sweep({ lastError: REVIEW, lastPolledAt: previousPoll, blocked: 41, fresh: 0 });
    expect(m.capture).not.toHaveBeenCalled();
    expect(writes.at(-1)).toMatchObject({ financialEventLastError: REVIEW });
  });

  it('pages again when another reversal is blocked after the previous poll', async () => {
    await sweep({ lastError: REVIEW, lastPolledAt: previousPoll, blocked: 42, fresh: 1 });
    expect(m.capture).toHaveBeenCalledOnce();
    expect(m.capture.mock.calls[0]![2]).toMatchObject({ blocked_events: '42', newly_blocked_events: '1' });
  });

  it('pages after an unrelated poll error replaced the review banner', async () => {
    await sweep({ lastError: 'Stripe payment reversal reconciliation could not complete and will retry automatically.',
      lastPolledAt: previousPoll, blocked: 41, fresh: 0 });
    expect(m.capture).toHaveBeenCalledOnce();
  });

  it('neither pages nor sets the banner when nothing is blocked', async () => {
    const writes = await sweep({ lastError: null, lastPolledAt: previousPoll, blocked: 0, fresh: 0 });
    expect(m.capture).not.toHaveBeenCalled();
    expect(writes.every(w => w.financialEventLastError === null)).toBe(true);
  });
});
