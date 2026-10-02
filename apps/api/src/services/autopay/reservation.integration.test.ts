import { getTestDb } from '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, stripeConnectAccounts, orgAutopayEnrollments, orgPaymentMethods, invoiceCollectionAttempts, invoiceStripePayments, invoicePayments, accountingConnections, accountingEntityMappings } from '../../db/schema';
import { lockInvoiceForCollection } from './reservation';
import { createInvoicePayLink } from '../invoiceCheckout';
import { recordPayment, voidInvoice } from '../invoiceService';
import { resetInvoiceLink } from '../invoiceLinkToken';
import { applyAccountingPayment } from '../accounting/accountingPaymentPull';
import { getConnection } from '../accounting/accountingConnectionService';
import type { ChangeSetPaymentLine } from '../accounting/types';

const mocks = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }));
vi.mock('../partnerStripe', async (original) => ({
  ...(await original<typeof import('../partnerStripe')>()), getPartnerStripeClient: mocks.client,
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ name: 'Reservation test', slug: `reservation-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Synthetic customer', slug: `reservation-${suffix}`, currencyCode: 'USD' }).returning();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', livemode: false }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org!.id, partnerId: partner!.id, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org!.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`, type: 'card', status: 'active' }).returning();
    const [invoice] = await db.insert(invoices).values({ orgId: org!.id, partnerId: partner!.id, currencyCode: 'USD', status: 'sent', issueDate: '2026-10-01', dueDate: '2026-10-31', total: '100.00', subtotal: '100.00', balance: '100.00' }).returning();
    const actor = { userId: null, partnerId: partner!.id, accessibleOrgIds: [org!.id] };
    const attempt = { orgId: org!.id, invoiceId: invoice!.id, paymentMethodId: method!.id, attemptNo: 1, idempotencyKey: `reservation-${suffix}`, principalAmount: '60.00', currency: 'USD', initiatedBy: 'client_on_session' as const, state: 'reserved' as const };
    mocks.client.mockResolvedValue({ stripe: { checkout: { sessions: { create: mocks.create } } }, stripeAccountId: connection!.stripeAccountId, defaultCurrency: 'USD' });
    return { invoice: invoice!, actor, attempt };
  });
}

beforeEach(() => { vi.clearAllMocks(); });
describe('reservation with real PostgreSQL', () => {
  it('rejects a caller holding a DB context before contacting Stripe', async () => {
    const f = await fixture();
    mocks.create.mockResolvedValue({ id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null });
    await expect(withSystemDbAccessContext(() => createInvoicePayLink(f.invoice.id, f.actor)))
      .rejects.toMatchObject({ name: 'HeldDbContextForStripeError' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('releases the preflight invoice lock before the paused Stripe call', async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.create.mockImplementation(async () => {
      entered();
      await gate;
      return { id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null };
    });
    const checkout = createInvoicePayLink(f.invoice.id, f.actor);
    try {
      await Promise.race([started, checkout.then(() => { throw new Error('Stripe barrier was not reached'); })]);
      // Independent connection: NOWAIT fails immediately if preflight still owns the row.
      await withSystemDbAccessContext(async () => {
        const rows = await db.execute(sql`select id from invoices where id = ${f.invoice.id} for update nowait`);
        expect(rows).toHaveLength(1);
      });
    } finally { release(); await checkout; }
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
    expect(mapping).toMatchObject({ status: 'pending' });
  });
  it('serializes a concurrent manual payment behind the reservation and refuses its excess', async () => {
    const f = await fixture();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(r => { acquired = r; });
    const gate = new Promise<void>(r => { release = r; });
    let reserverPid!: number;
    const reserve = withSystemDbAccessContext(async () => {
      const [backend] = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      reserverPid = backend!.pid;
      await lockInvoiceForCollection(db, f.invoice.id);
      // Insert only after observation: its FK key-share lock must not hide a
      // missing FOR UPDATE in lockInvoiceForCollection.
      acquired();
      await gate;
      await db.insert(invoiceCollectionAttempts).values(f.attempt);
    });
    await locked;
    let pending = true;
    const manual = withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 40.01, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
    const outcome = manual.then(value => { pending = false; return value; }, error => { pending = false; return error; });
    try {
      await vi.waitFor(async () => {
        const rows = await getTestDb().execute(sql`select pid from pg_stat_activity where ${reserverPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
        expect(rows).toHaveLength(1);
      }, { timeout: 5000, interval: 20 });
      expect(pending).toBe(true);
      release();
      await reserve;
      expect(await outcome).toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    } finally { release(); await reserve; await outcome; }
    const rows = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)));
    expect(rows).toHaveLength(0);
    await withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 40, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
    const state = await withSystemDbAccessContext(() => lockInvoiceForCollection(db, f.invoice.id));
    expect(state).toMatchObject({ reservedAmount: '60.00', unreservedBalance: '0.00' });
  });
  it('applies an accounting import only within the real locked unreserved balance', async () => {
    const f = await fixture();
    const connection = await withSystemDbAccessContext(async () => {
      await db.insert(invoiceCollectionAttempts).values(f.attempt);
      const [created] = await db.insert(accountingConnections).values({ partnerId: f.invoice.partnerId, provider: 'quickbooks', homeCurrency: 'USD', pullPayments: true }).returning();
      await db.insert(accountingEntityMappings).values({ integrationId: created!.id, partnerId: f.invoice.partnerId, breezeEntityType: 'invoice', breezeEntityId: f.invoice.id, remoteEntityType: 'Invoice', remoteEntityId: 'synthetic-invoice', breezeOrigin: true, linkStatus: 'confirmed', syncStatus: 'synced' });
      return getConnection(db, f.invoice.partnerId, 'quickbooks');
    });
    if (!connection) throw new Error('Synthetic accounting connection was not created');
    const line: ChangeSetPaymentLine = { remoteInvoiceId: 'synthetic-invoice', remotePaymentId: 'synthetic-payment', amountMinor: 4001, currency: 'USD', txnDate: '2026-10-01', remotePaymentVersion: '1', method: 'check', paymentMethodName: 'Check', paymentRefNum: null, breezePaymentId: null };
    await expect(applyAccountingPayment(connection, line, fn => withSystemDbAccessContext(fn), null)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)))).toHaveLength(0);
    expect(await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings).where(eq(accountingEntityMappings.breezeEntityType, 'payment')))).toHaveLength(0);
    await expect(applyAccountingPayment(connection, { ...line, amountMinor: 4000 }, fn => withSystemDbAccessContext(fn), null)).resolves.toMatchObject({ outcome: 'applied' });
    const state = await withSystemDbAccessContext(() => lockInvoiceForCollection(db, f.invoice.id));
    expect(state).toMatchObject({ reservedAmount: '60.00', unreservedBalance: '0.00' });
  });
  it('blocks link and void while allowing a customer-link reset', async () => {
    const f = await fixture();
    await withSystemDbAccessContext(() => db.insert(invoiceCollectionAttempts).values(f.attempt));
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    await expect(withSystemDbAccessContext(() => voidInvoice(f.invoice.id, 'synthetic', {}, f.actor))).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    await expect(withSystemDbAccessContext(() => resetInvoiceLink(f.invoice))).resolves.toMatchObject({ origin: 'reset' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('withholds a stale Checkout amount when manual payment wins during Stripe HTTP', async () => {
    const f = await fixture();
    mocks.create.mockImplementation(async () => {
      await withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 25, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
      return { id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null };
    });
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'STRIPE_REVOCATION_PENDING' });
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
    expect(mapping).toMatchObject({ revocationState: 'revocation_requested' });
  });
  it('persists revocation intent and withholds the URL when reservation wins during Stripe HTTP', async () => {
    const f = await fixture();
    mocks.create.mockImplementation(async () => {
      await withSystemDbAccessContext(async () => {
        await lockInvoiceForCollection(db, f.invoice.id);
        await db.insert(invoiceCollectionAttempts).values(f.attempt);
      });
      return { id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null };
    });
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
    expect(mapping).toMatchObject({ revocationState: 'revocation_requested' });
  });
});
