import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, withSystemDbAccessContext } from '../../db';
import { orgAutopayEnrollments, orgPaymentMethods, stripeConnectAccounts, stripeFinancialEvents } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
const m = vi.hoisted(() => ({ client: vi.fn(), retrieve: vi.fn(), list: vi.fn(), complete: vi.fn(), finish: vi.fn(), notify: vi.fn() }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: m.client }));
vi.mock('./setupCompletion', () => ({ completeAutopaySetup: m.complete }));
vi.mock('./payAndSave', () => ({ finishCardPayAndSave: m.finish }));
vi.mock('./staffNotifications', () => ({ notifyAutopayStaff: m.notify }));
import { ingestAutopayStripeEvent, reconcileAutopaySetups, replayAutopayStripeEvents } from './setupReconciliation';
import { processPendingStripeFinancialEvents, processPendingStripeFinancialEventsForPayment } from '../stripeReversalState';

beforeEach(() => {
  vi.resetAllMocks();
  m.client.mockResolvedValue({ stripeAccountId: 'acct_test', stripe: { events: { retrieve: m.retrieve }, checkout: { sessions: { list: m.list } } } });
  m.complete.mockResolvedValue({ outcome: 'activated' });
  m.finish.mockResolvedValue({ outcome: 'not_saved' });
});
async function fixture(account = 'acct_test') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return withSystemDbAccessContext(async () => {
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: account, apiKey: 'enc:synthetic', keyLast4: 'test' }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id, stripeConnectionId: connection!.id, stripeAccountId: account }).returning();
    return { partnerId: partner.id, orgId: org.id, enrollmentId: enrollment!.id, stripeConnectionId: connection!.id, stripeAccountId: account };
  });
}
function setup(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<typeof autopaySetupAttempts.$inferInsert> = {}): typeof autopaySetupAttempts.$inferInsert {
  return { ...f, id: randomUUID(), generation: 1, source: 'setup_page', methodType: 'card', consentSnapshot: {}, stripeCustomerId: 'cus_test', checkoutSessionId: `cs_${randomUUID()}`, ...overrides };
}
function eventRow(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<typeof stripeFinancialEvents.$inferInsert> = {}): typeof stripeFinancialEvents.$inferInsert {
  return { partnerId: f.partnerId, stripeConnectionId: f.stripeConnectionId, stripeAccountId: f.stripeAccountId,
    stripeEventId: `evt_${randomUUID()}`, eventType: 'payment_method.detached', livemode: false, providerCreated: 100,
    currency: 'XXX', payloadDigest: 'a'.repeat(64), ...overrides };
}
describe('real reconciliation selection and durability', () => {
  it('limits discovery to 24 hours while recovering a bound older card capture', async () => {
    const f = await fixture();
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    const recent = setup(f);
    const late = setup(f, { source: 'pay_and_save', createdAt: old });
    await withSystemDbAccessContext(() => db.insert(autopaySetupAttempts).values([
      recent, late, setup(f, { createdAt: old, outcome: 'pending_verification' }),
      setup(f, { source: 'pay_and_save', createdAt: old, checkoutSessionId: null }),
    ]));
    expect(await reconcileAutopaySetups()).toBe(1);
    expect(m.complete).toHaveBeenCalledExactlyOnceWith(f.partnerId, { checkoutSessionId: recent.checkoutSessionId });
    expect(m.finish).toHaveBeenCalledExactlyOnceWith(f.partnerId, late.checkoutSessionId);
    expect(m.list).not.toHaveBeenCalled();
    const [saved] = await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id, late.id!)));
    expect(saved!.completedAt).toBeNull();
    expect(saved!.captureNextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rotates a full batch of no-op captures behind newer work durably', async () => {
    const f = await fixture();
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    const rows = Array.from({ length: 201 }, (_, i) => setup(f, { source: 'pay_and_save', createdAt: old, captureNextAttemptAt: new Date(i) }));
    await withSystemDbAccessContext(() => db.insert(autopaySetupAttempts).values(rows));
    expect(await reconcileAutopaySetups()).toBe(0);
    expect(m.finish).toHaveBeenCalledTimes(200);
    m.finish.mockClear();
    expect(await reconcileAutopaySetups()).toBe(0);
    expect(m.finish).toHaveBeenCalledExactlyOnceWith(f.partnerId, rows[200]!.checkoutSessionId);
  });

  it.each([false, true])('discovers an unbound capture behind 200 unresolved attempts (retry deadlines elapsed: %s)', async deadlinesElapsed => {
    const f = await fixture();
    const older = new Date(Date.now() - 2 * 60 * 60_000);
    const unresolved = Array.from({ length: 200 }, () => setup(f, {
      createdAt: older, checkoutSessionId: null,
    }));
    const recoverable = setup(f, { source: 'pay_and_save', checkoutSessionId: null });
    await withSystemDbAccessContext(() => db.insert(autopaySetupAttempts).values([...unresolved, recoverable]));
    m.list.mockResolvedValue({ data: [], has_more: false });
    expect(await reconcileAutopaySetups()).toBe(0);
    expect(m.list).toHaveBeenCalledTimes(200);
    expect(m.finish).not.toHaveBeenCalled();
    const examined = await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts));

    if (deadlinesElapsed) {
      // Simulate a later sweep without sleeping: keep relative priority, but
      // make both the examined and unexamined rows due again.
      await withSystemDbAccessContext(() => db.update(autopaySetupAttempts).set({
        discoveryNextAttemptAt: sql`${autopaySetupAttempts.discoveryNextAttemptAt} - interval '11 minutes'`,
      }));
    }

    m.list.mockClear().mockResolvedValueOnce({ data: [{ id: 'cs_recovered', metadata: {
      autopay_setup_attempt_id: recoverable.id,
    } }], has_more: false });
    m.finish.mockResolvedValue({ outcome: 'activated' });
    expect(await reconcileAutopaySetups()).toBe(1);
    expect(examined.filter(row => row.discoveryNextAttemptAt.getTime() > Date.now())).toHaveLength(200);
    expect(m.list).toHaveBeenCalledTimes(deadlinesElapsed ? 200 : 1);
    expect(m.finish).toHaveBeenCalledExactlyOnceWith(f.partnerId, 'cs_recovered');
    const saved = await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts));
    expect(saved.find(row => row.id === recoverable.id)!.checkoutSessionId).toBe('cs_recovered');
    expect(saved.find(row => row.id === recoverable.id)!.discoveryNextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('moves 200 failed events out of the next batch so newer verification can complete', async () => {
    const f = await fixture();
    const old = setup(f, { createdAt: new Date(0), outcome: 'pending_verification' });
    await withSystemDbAccessContext(() => db.insert(autopaySetupAttempts).values(old));
    const events = Array.from({ length: 200 }, (_, i) => eventRow(f, { nextAttemptAt: new Date(i), attemptCount: i === 0 ? 49 : 0 }));
    events.push(eventRow(f, { stripeEventId: 'evt_new', eventType: 'setup_intent.succeeded', nextAttemptAt: new Date(201) }));
    await withSystemDbAccessContext(() => db.insert(stripeFinancialEvents).values(events));
    m.retrieve.mockRejectedValue(new Error('temporary Stripe failure'));
    expect(await replayAutopayStripeEvents()).toBe(0);
    const [blocked] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId, events[0]!.stripeEventId)));
    expect(blocked).toMatchObject({ status: 'blocked', attemptCount: 50, nextAttemptAt: null });
    m.retrieve.mockReset().mockResolvedValue({ id: 'evt_new', type: 'setup_intent.succeeded', livemode: false, data: { object: { id: 'seti_late', metadata: { setup_attempt_id: old.id } } } });
    expect(await replayAutopayStripeEvents()).toBe(1);
    expect(m.retrieve).toHaveBeenCalledExactlyOnceWith('evt_new');
    expect(m.complete).toHaveBeenCalledExactlyOnceWith(f.partnerId, { setupIntentId: 'seti_late' });
  });

  it('ingests idempotently without a PaymentIntent and fences event identity', async () => {
    const f = await fixture();
    const event = { id: 'evt_ingest', type: 'payment_method.detached', created: 100, livemode: false, data: { object: { id: 'pm_test' } } } as Stripe.Event;
    await ingestAutopayStripeEvent(f.partnerId, f.stripeAccountId, event);
    await ingestAutopayStripeEvent(f.partnerId, f.stripeAccountId, event);
    const rows = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paymentIntentId: null, currency: 'XXX', status: 'pending' });
    await expect(ingestAutopayStripeEvent(f.partnerId, f.stripeAccountId, { ...event, data: { object: { id: 'pm_wrong' } } } as Stripe.Event)).rejects.toThrow('identity conflict');
    expect(await processPendingStripeFinancialEvents()).toBe(0);
    // Even a malformed enrollment row carrying a PI must never enter the reducer.
    await withSystemDbAccessContext(() => db.update(stripeFinancialEvents).set({ paymentIntentId: 'pi_invalid' }).where(eq(stripeFinancialEvents.id, rows[0]!.id)));
    expect(await processPendingStripeFinancialEventsForPayment('acct_test', 'pi_invalid')).toBe(0);
    const [unchanged] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents));
    expect(unchanged).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  it('replays a detach with a replacement key for the same account and isolates other partners', async () => {
    const f = await fixture();
    const other = await fixture('acct_other');
    const method = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(orgPaymentMethods).values({ orgId: f.orgId, enrollmentId: f.enrollmentId, stripePaymentMethodId: 'pm_test', type: 'card', status: 'active', isAutopayMethod: true }).returning();
      await db.insert(orgPaymentMethods).values({ orgId: other.orgId, enrollmentId: other.enrollmentId, stripePaymentMethodId: 'pm_test', type: 'card', status: 'active', isAutopayMethod: true });
      await db.insert(stripeFinancialEvents).values(eventRow(f, { stripeEventId: 'evt_detached' }));
      await db.update(stripeConnectAccounts).set({ apiKey: 'enc:rotated', keyLast4: 'next' }).where(eq(stripeConnectAccounts.id, f.stripeConnectionId));
      return row!;
    });
    m.retrieve.mockResolvedValue({ id: 'evt_detached', type: 'payment_method.detached', livemode: false, data: { object: { id: 'pm_test' } } });
    expect(await replayAutopayStripeEvents()).toBe(1);
    expect(m.client).toHaveBeenCalledWith(f.partnerId);
    const rows = await withSystemDbAccessContext(() => db.select().from(orgPaymentMethods));
    expect(rows.find(r => r.id === method.id)!.status).toBe('unusable');
    expect(rows.find(r => r.orgId === other.orgId)!.status).toBe('active');
    expect(m.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ orgId: f.orgId, partnerId: f.partnerId }));
  });
});
