import type Stripe from 'stripe';
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts, stripeFinancialEvents } from '../db/schema/stripePayments';
import { getPartnerStripeClient } from './partnerStripe';
import { ingestStripeFinancialEvent, processPendingStripeFinancialEvents, type NormalizedStripeFinancialEvent } from './stripeReversalState';
import { captureException } from './sentry';

export const STRIPE_FINANCIAL_EVENT_TYPES = [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const;

const PAGE_SIZE = 100;
const ACCOUNTS_PER_RUN = 25;
const INITIAL_LOOKBACK_SECONDS = 29 * 24 * 60 * 60;

type PollConnection = {
  partnerId: string;
  stripeAccountId: string;
  livemode: boolean;
  cursorCreated: number;
  pageAfter: string | null;
  scanUpperCreated: number | null;
};

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export async function normalizeStripeFinancialEvent(input: {
  event: Stripe.Event;
  partnerId: string;
  stripeAccountId: string;
  stripe: Stripe;
  requestOptions?: Stripe.RequestOptions;
}): Promise<NormalizedStripeFinancialEvent | null> {
  const { event, partnerId, stripeAccountId, stripe, requestOptions } = input;
  if (event.account && event.account !== stripeAccountId) {
    throw new Error('Stripe event account does not match the credential-bound account');
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = idOf(charge.payment_intent);
    if (!paymentIntentId) throw new Error(`Refund event ${event.id} has no PaymentIntent binding`);
    return {
      partnerId, stripeAccountId, stripeEventId: event.id, eventType: event.type,
      livemode: Boolean(event.livemode), providerCreated: event.created,
      paymentIntentId, chargeId: charge.id, currency: charge.currency,
      chargeAmountMinor: charge.amount, refundedAmountMinor: charge.amount_refunded,
    };
  }

  if (!event.type.startsWith('charge.dispute.')) return null;
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = idOf(dispute.charge);
  let paymentIntentId = idOf(dispute.payment_intent);
  if (!paymentIntentId && chargeId) {
    const charge = requestOptions
      ? await stripe.charges.retrieve(chargeId, {}, requestOptions)
      : await stripe.charges.retrieve(chargeId);
    paymentIntentId = idOf(charge.payment_intent);
  }
  if (!paymentIntentId) throw new Error(`Dispute event ${event.id} has no PaymentIntent binding`);

  let disputeFundsWithdrawn: boolean | null = null;
  if (event.type === 'charge.dispute.funds_withdrawn') {
    disputeFundsWithdrawn = true;
  } else if (event.type === 'charge.dispute.funds_reinstated') {
    disputeFundsWithdrawn = false;
  } else if (event.type === 'charge.dispute.closed') {
    if (dispute.status === 'won' || dispute.status === 'warning_closed' || dispute.status === 'prevented') {
      disputeFundsWithdrawn = false;
    } else if (dispute.status === 'lost') {
      disputeFundsWithdrawn = true;
    }
  }

  return {
    partnerId, stripeAccountId, stripeEventId: event.id, eventType: event.type,
    livemode: Boolean(event.livemode), providerCreated: event.created,
    paymentIntentId, chargeId, disputeId: dispute.id, currency: dispute.currency,
    disputeAmountMinor: dispute.amount, disputeFundsWithdrawn,
  };
}

async function readConnection(partnerId: string): Promise<PollConnection | null> {
  const [row] = await withSystemDbAccessContext(() => db.select({
    partnerId: stripeConnectAccounts.partnerId,
    stripeAccountId: stripeConnectAccounts.stripeAccountId,
    livemode: stripeConnectAccounts.livemode,
    cursorCreated: stripeConnectAccounts.financialEventCursorCreated,
    pageAfter: stripeConnectAccounts.financialEventPageAfter,
    scanUpperCreated: stripeConnectAccounts.financialEventScanUpperCreated,
  }).from(stripeConnectAccounts).where(and(
    eq(stripeConnectAccounts.partnerId, partnerId),
    eq(stripeConnectAccounts.status, 'connected'),
    isNotNull(stripeConnectAccounts.apiKey),
  )).limit(1));
  return row ?? null;
}

export async function pollPartnerStripeFinancialEvents(partnerId: string, now = new Date()): Promise<number> {
  const connection = await readConnection(partnerId);
  if (!connection) return 0;
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId));
  if (stripeAccountId !== connection.stripeAccountId) throw new Error('Stripe connection changed before financial event poll');

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const cursorCreated = connection.cursorCreated > 0
    ? connection.cursorCreated
    : nowSeconds - INITIAL_LOOKBACK_SECONDS;
  const scanUpperCreated = connection.scanUpperCreated ?? nowSeconds;
  const page = await runOutsideDbContext(() => stripe.events.list({
    types: [...STRIPE_FINANCIAL_EVENT_TYPES],
    created: { gte: cursorCreated, lte: scanUpperCreated },
    limit: PAGE_SIZE,
    ...(connection.pageAfter ? { starting_after: connection.pageAfter } : {}),
  }));

  let ingested = 0;
  // Stripe lists newest-first. Applying this page oldest-first reduces stale
  // work; persisted provider timestamps/high-water marks remain authoritative
  // across page boundaries and webhook redelivery.
  for (const event of [...page.data].reverse()) {
    if (Boolean(event.livemode) !== connection.livemode) {
      throw new Error(`Stripe event ${event.id} livemode does not match its credential-bound account`);
    }
    const normalized = await normalizeStripeFinancialEvent({
      event, partnerId, stripeAccountId, stripe,
    });
    if (!normalized) continue;
    await ingestStripeFinancialEvent(normalized);
    ingested += 1;
  }

  const last = page.data.at(-1);
  const hasAnotherPage = page.has_more && Boolean(last);
  const updated = await withSystemDbAccessContext(() => db.update(stripeConnectAccounts).set({
    financialEventCursorCreated: hasAnotherPage ? cursorCreated : scanUpperCreated,
    financialEventPageAfter: hasAnotherPage ? last!.id : null,
    financialEventScanUpperCreated: hasAnotherPage ? scanUpperCreated : null,
    financialEventLastPolledAt: now,
    financialEventLastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(stripeConnectAccounts.partnerId, partnerId),
    eq(stripeConnectAccounts.stripeAccountId, stripeAccountId),
    eq(stripeConnectAccounts.status, 'connected'),
  )).returning({ id: stripeConnectAccounts.id }));
  if (updated.length !== 1) throw new Error('Stripe connection changed while advancing financial event cursor');

  const [blocked] = await withSystemDbAccessContext(() => db.select({ value: count() })
    .from(stripeFinancialEvents).where(and(
      eq(stripeFinancialEvents.partnerId, partnerId),
      eq(stripeFinancialEvents.stripeAccountId, stripeAccountId),
      eq(stripeFinancialEvents.status, 'blocked'),
    )));
  if (Number(blocked?.value ?? 0) > 0) {
    captureException(new Error('Stripe payment reversal requires operator review'), undefined, {
      partner_id: partnerId,
      stripe_account_id: stripeAccountId,
      blocked_events: String(Number(blocked?.value ?? 0)),
    });
    await withSystemDbAccessContext(() => db.update(stripeConnectAccounts).set({
      financialEventLastError: 'One or more Stripe payment reversals require operator review.',
      updatedAt: new Date(),
    }).where(and(
      eq(stripeConnectAccounts.partnerId, partnerId),
      eq(stripeConnectAccounts.stripeAccountId, stripeAccountId),
    )));
  }
  return ingested;
}

export async function pollStripeFinancialEvents(): Promise<{ accounts: number; events: number; applied: number }> {
  const accounts = await withSystemDbAccessContext(() => db.select({ partnerId: stripeConnectAccounts.partnerId })
    .from(stripeConnectAccounts)
    .where(and(eq(stripeConnectAccounts.status, 'connected'), isNotNull(stripeConnectAccounts.apiKey)))
    .orderBy(sql`${stripeConnectAccounts.financialEventLastPolledAt} ASC NULLS FIRST`, asc(stripeConnectAccounts.partnerId))
    .limit(ACCOUNTS_PER_RUN));

  let events = 0;
  for (const account of accounts) {
    try {
      events += await pollPartnerStripeFinancialEvents(account.partnerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stripeType = (err as { type?: string } | null)?.type;
      const publicMessage = stripeType === 'StripePermissionError' || stripeType === 'StripeAuthenticationError'
        ? 'The stored Stripe key cannot read Events. Replace it with a key that has Events read access.'
        : 'Stripe payment reversal reconciliation could not complete and will retry automatically.';
      console.error('[stripeFinancialEventPoller] account poll failed', { partnerId: account.partnerId, message });
      captureException(err instanceof Error ? err : new Error(message), undefined, {
        partner_id: account.partnerId,
        operation: 'stripe-financial-event-poll',
      });
      await withSystemDbAccessContext(() => db.update(stripeConnectAccounts).set({
        financialEventLastPolledAt: new Date(), financialEventLastError: publicMessage, updatedAt: new Date(),
      }).where(eq(stripeConnectAccounts.partnerId, account.partnerId)));
    }
  }
  const applied = await processPendingStripeFinancialEvents(PAGE_SIZE);
  return { accounts: accounts.length, events, applied };
}
