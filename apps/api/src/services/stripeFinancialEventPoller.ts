import { reconcilePendingControls } from './autopay/collectionControl';
import {createHash} from 'node:crypto';
import { AUTOPAY_STRIPE_EVENT_TYPES, isAutopayStripeEvent, ingestAutopayStripeEvent, replayAutopayStripeEvents } from './autopay/setupReconciliation';
import type Stripe from 'stripe';
import { and, asc, count, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts, stripeFinancialEvents } from '../db/schema/stripePayments';
import { getPartnerStripeClient } from './partnerStripe';
import { ingestStripeFinancialEvent, processPendingStripeFinancialEvents, type NormalizedStripeFinancialEvent } from './stripeReversalState';
import { captureException } from './sentry';

export const STRIPE_FINANCIAL_EVENT_TYPES = [
  ...AUTOPAY_STRIPE_EVENT_TYPES,
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
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

if (event.type.startsWith('payment_intent.')) {
  const pi = event.data.object as Stripe.PaymentIntent;
  return { partnerId, stripeAccountId, stripeEventId: event.id, eventType: event.type,
    livemode: event.livemode, providerCreated: event.created, paymentIntentId: pi.id,
    currency: pi.currency, chargeAmountMinor: pi.amount };
}

  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = idOf(charge.payment_intent);
    return {
      partnerId, stripeAccountId, stripeEventId: event.id, eventType: event.type,
      livemode: Boolean(event.livemode), providerCreated: event.created,
      paymentIntentId,
      // A legacy charge created without a PaymentIntent cannot be bound to an
      // invoice. Throwing here would abort the poller's page loop before the
      // cursor advance and wedge this partner's reversal channel permanently,
      // so the event is quarantined as a `blocked` row instead.
      quarantineReason: paymentIntentId ? null : `Refund event ${event.id} has no PaymentIntent binding`,
      chargeId: charge.id, currency: charge.currency,
      chargeAmountMinor: charge.amount, refundedAmountMinor: charge.amount_refunded,
    };
  }

  if (!event.type.startsWith('charge.dispute.')) return null;
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = idOf(dispute.charge);
  let paymentIntentId = idOf(dispute.payment_intent);
  if (!paymentIntentId && chargeId) {
    const charge = await runOutsideDbContext(() => (requestOptions
      ? stripe.charges.retrieve(chargeId, {}, requestOptions)
      : stripe.charges.retrieve(chargeId)));
    paymentIntentId = idOf(charge.payment_intent);
  }

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
    paymentIntentId,
    // Same quarantine contract as the refund arm above.
    quarantineReason: paymentIntentId ? null : `Dispute event ${event.id} has no PaymentIntent binding`,
    chargeId, disputeId: dispute.id, currency: dispute.currency,
    disputeAmountMinor: dispute.amount, disputeFundsWithdrawn,
  };
}

// Keep historical mappings eligible for late success and ACH returns after disconnect.
// Credential retention remains enforced by the account-bound client factory.
function canPollFinancialEvents() {
  return or(and(eq(stripeConnectAccounts.status,'connected'),isNotNull(stripeConnectAccounts.apiKey)),
    sql`EXISTS (
      SELECT 1 FROM invoice_collection_attempts a
      JOIN invoices i ON i.id=a.invoice_id
      JOIN invoice_stripe_payments m ON m.id=a.invoice_stripe_payment_id
      WHERE i.partner_id=${stripeConnectAccounts.partnerId}
        AND m.stripe_account_id=${stripeConnectAccounts.stripeAccountId}
        AND a.state IN ('created','confirming','processing','requires_action','unapplied','succeeded','failed')
    )`);
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
    canPollFinancialEvents(),
  )).limit(1));
  return row ?? null;
}

export async function pollPartnerStripeFinancialEvents(partnerId: string, now = new Date()): Promise<number> {
  return (await pollPartner(partnerId, now)).ingested;
}

/** Ingestion applies a financial event at once when its payment is already mapped, so
 * the sweep's applied count includes these, not only later replays (#7897). */
async function pollPartner(partnerId: string, now: Date): Promise<{ ingested: number; applied: number }> {
  const connection = await readConnection(partnerId);
  if (!connection) return { ingested: 0, applied: 0 };
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId, {
    reconciliationAccountId: connection.stripeAccountId, reason: 'financial_event_poll',
  }));
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
  let applied = 0;
  // Stripe lists newest-first. Applying this page oldest-first reduces stale
  // work; persisted provider timestamps/high-water marks remain authoritative
  // across page boundaries and webhook redelivery.
  for (const event of [...page.data].reverse()) {
    if (!isAutopayStripeEvent(event.type)&&Boolean(event.livemode) !== connection.livemode) {
      throw new Error(`Stripe event ${event.id} livemode does not match its credential-bound account`);
    }
    if (isAutopayStripeEvent(event.type)) {
      try{
        await ingestAutopayStripeEvent(partnerId, stripeAccountId, event);
        ingested++;
      }catch(error){
        const reason=error instanceof Error?error.message:String(error);
        // Invalid provider identity is terminal. Database failures still abort the
        // cursor advance, preserving the page for retry after later events run.
        if(!['Autopay event account mismatch','Autopay event identity conflict'].includes(reason))throw error;
        await withSystemDbAccessContext(()=>db.execute(sql`
          INSERT INTO stripe_financial_events(partner_id,stripe_connection_id,stripe_account_id,stripe_event_id,event_type,livemode,provider_created,currency,payload_digest,status,last_error,processed_at)
          SELECT ${partnerId}::uuid,id,${stripeAccountId},${event.id},${event.type},${connection.livemode},${event.created},'XXX',
            ${createHash('sha256').update(JSON.stringify(event)).digest('hex')},'blocked',${reason},now()
          FROM stripe_connect_accounts WHERE partner_id=${partnerId}::uuid AND stripe_account_id=${stripeAccountId}
          ON CONFLICT DO NOTHING`));
        captureException(error instanceof Error?error:new Error(reason));
      }
      continue;
    }
    const normalized = await normalizeStripeFinancialEvent({
      event, partnerId, stripeAccountId, stripe,
    });
    if (!normalized) continue;
    if ((await ingestStripeFinancialEvent(normalized))?.state === 'applied') applied += 1;
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
  )).returning({ id: stripeConnectAccounts.id }));
  if (updated.length !== 1) throw new Error('Stripe connection changed while advancing financial event cursor');

  const [blocked] = await withSystemDbAccessContext(() => db.select({ value: count() })
    .from(stripeFinancialEvents).where(and(
      eq(stripeFinancialEvents.partnerId, partnerId),
      eq(stripeFinancialEvents.stripeAccountId, stripeAccountId),
      eq(stripeFinancialEvents.status, 'blocked'),
      // Quarantined events (no PaymentIntent, so no Breeze payment to reduce)
      // are terminal by construction and must not raise a banner that nothing
      // short of manual SQL could ever clear.
      isNotNull(stripeFinancialEvents.paymentIntentId),
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
  // The reconciler owns control admission; its current API sweeps all pending controls.
  if (page.data.some(event => event.type.startsWith('payment_intent.'))) {
    await reconcilePendingControls();
  }
  return { ingested, applied };
}

export async function pollStripeFinancialEvents(): Promise<{ accounts: number; events: number; applied: number }> {
  const accounts = await withSystemDbAccessContext(() => db.select({ partnerId: stripeConnectAccounts.partnerId })
    .from(stripeConnectAccounts)
    .where(canPollFinancialEvents())
    .orderBy(sql`${stripeConnectAccounts.financialEventLastPolledAt} ASC NULLS FIRST`, asc(stripeConnectAccounts.partnerId))
    .limit(ACCOUNTS_PER_RUN));

  let events = 0;
  let applied = 0;
  for (const account of accounts) {
    try {
      const polled = await pollPartner(account.partnerId, new Date());
      events += polled.ingested;
      applied += polled.applied;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stripeType = (err as { type?: string } | null)?.type;
      const publicMessage = stripeType === 'StripePermissionError' || stripeType === 'StripeAuthenticationError'
        ? 'The stored Stripe key cannot read Events. Replace it with a key that has Events read access.'
        : 'Stripe payment reversal reconciliation could not complete and will retry automatically.';
      console.error('[stripeFinancialEventPoller] account poll failed', { partnerId: account.partnerId, message });
      captureException(err instanceof Error ? err : new Error(message), undefined, {
        partner_id: account.partnerId,
        stripe_reconcile_stage: 'financial-event-poll',
      });
      await withSystemDbAccessContext(() => db.update(stripeConnectAccounts).set({
        financialEventLastPolledAt: new Date(), financialEventLastError: publicMessage, updatedAt: new Date(),
      }).where(eq(stripeConnectAccounts.partnerId, account.partnerId)));
    }
  }
  applied += await processPendingStripeFinancialEvents(PAGE_SIZE);
  applied += await replayAutopayStripeEvents();
  return { accounts: accounts.length, events, applied };
}
