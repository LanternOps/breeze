/**
 * Real-DB proof for the Phase-D QuickBooks payment applier
 * (`services/accounting/accountingPaymentPull.ts`, Task 3).
 *
 * The unit suite proves lock ORDER and statement shape against a fake DB; only
 * this file can prove the properties that live in Postgres itself:
 *
 *  - AT MOST ONCE against the real `accounting_entity_mappings_remote_uniq`
 *    index — applying the same CDC line twice yields ONE payment row.
 *  - SPLIT PAYMENTS: one QuickBooks Payment id settling two invoices produces
 *    two mapping rows under the `<PaymentId>/<InvoiceId>` scheme (decision 1),
 *    which a bare Payment id could not.
 *  - SELECTIVE REVERSAL: only the QBO-origin payment row is destroyed; a manual
 *    payment on the same invoice survives with its `recorded_by` intact.
 *  - The real `recomputeInvoiceStatus` moving `status`/`balance` (the unit
 *    suite mocks it, so the money maths is unproven there).
 *  - The ownership TRIGGER (`validate_accounting_mapping_entity_partner`)
 *    refusing a cross-partner payment mapping forge.
 *  - `invoiceService.voidPayment` REFUSING a QuickBooks-origin payment (Phase
 *    D2, spec decision 14) against the real `breeze_origin` column the pull
 *    writes — the row and its mapping must both survive the refusal.
 *
 * Mirrors `accountingInvoicePushCurrency.integration.test.ts`: `import './setup'`
 * (which truncates tenant tables between tests, so every test seeds its own
 * fixture — a memoized one would be stale), `runDb` gating on DATABASE_URL, and
 * `createPartner`/`createOrganization` from `./db-utils`.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  accountingEntityMappings,
  invoicePayments,
  invoices,
  type AccountingEntityMapping,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import type { ChangeSetPaymentLine } from '../../services/accounting/types';
import {
  applyAccountingPayment,
  markInvoiceDeletedRemotely,
  reverseAccountingPayment,
  reverseStaleAllocations,
} from '../../services/accounting/accountingPaymentPull';

// The applier itself never emits invoice events or enqueues jobs, but
// `invoiceService.voidPayment` (exercised below) does both.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));

import { voidPayment } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * The applier must be ENTERED with no ambient context and opens its own short
 * ones through this runner — exactly how the Task-4 worker will call it.
 */
const systemRunner: DbContextRunner = (fn) => withSystemDbAccessContext(fn, 'accountingPaymentPull.test');

const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  conn: AccountingConnection;
}

async function seedFixture(opts: { homeCurrency?: string; realmId?: string } = {}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'USD' });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const conn = await upsertConnection(db, partner.id, 'quickbooks', {
      realmId: opts.realmId ?? `realm-payment-pull-${partner.id.slice(0, 8)}`,
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS,
      refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'sandbox',
      homeCurrency: opts.homeCurrency ?? 'USD',
    });
    return { partnerId: partner.id, orgId: org.id, userId: user.id, conn };
  });
}

/** An issued, pushable invoice — no lines needed; the applier reads only the header. */
async function seedInvoice(fx: Fixture, opts: { currencyCode?: string; total?: string } = {}): Promise<string> {
  const total = opts.total ?? '150.00';
  return withSystemDbAccessContext(async () => {
    const [inv] = await db
      .insert(invoices)
      .values({
        partnerId: fx.partnerId,
        orgId: fx.orgId,
        invoiceNumber: `INV-PULL-${Math.random().toString(36).slice(2, 8)}`,
        status: 'sent',
        currencyCode: opts.currencyCode ?? 'USD',
        issueDate: new Date().toISOString().slice(0, 10),
        subtotal: total,
        taxTotal: '0.00',
        total,
        balance: total,
      })
      .returning({ id: invoices.id });
    if (!inv) throw new Error('failed to seed invoice fixture');
    return inv.id;
  });
}

/** The confirmed/synced `invoice` mapping the applier resolves the line against. */
async function seedInvoiceMapping(fx: Fixture, invoiceId: string, remoteInvoiceId: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(accountingEntityMappings).values({
      integrationId: fx.conn.id,
      partnerId: fx.partnerId,
      breezeEntityType: 'invoice',
      breezeEntityId: invoiceId,
      remoteEntityType: 'Invoice',
      remoteEntityId: remoteInvoiceId,
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
    }).returning({ id: accountingEntityMappings.id });
    if (!row) throw new Error('failed to seed invoice mapping fixture');
    return row.id;
  });
}

function paymentLine(overrides: Partial<ChangeSetPaymentLine> = {}): ChangeSetPaymentLine {
  return {
    remoteInvoiceId: '145',
    remotePaymentId: '180',
    amountMinor: 15000,
    currency: 'USD',
    txnDate: '2026-09-02',
    remotePaymentSyncToken: '0',
    paymentMethodName: 'Check',
    paymentRefNum: '10441',
    breezePaymentId: null,
    ...overrides,
  };
}

async function loadPayments(invoiceId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId))
  );
}

async function loadMappings(fx: Fixture, breezeEntityType: 'invoice' | 'payment'): Promise<AccountingEntityMapping[]> {
  return withSystemDbAccessContext(() =>
    db.select().from(accountingEntityMappings).where(and(
      eq(accountingEntityMappings.integrationId, fx.conn.id),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
    )) as unknown as Promise<AccountingEntityMapping[]>
  );
}

async function loadInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  );
  if (!row) throw new Error(`invoice ${invoiceId} disappeared`);
  return row;
}

function sqlCause(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

describe('QuickBooks payment applier — real Postgres', () => {
  runDb('applying the same CDC line twice records exactly one payment and one mapping', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');

    const first = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);
    expect(first.outcome).toBe('applied');
    expect(first.invoiceId).toBe(invoiceId);

    const second = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);
    expect(second.outcome).toBe('replayed');
    expect(second.invoicePaymentId).toBe(first.invoicePaymentId);

    const payments = await loadPayments(invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount: '150.00', method: 'check', reference: '10441', recordedBy: null, note: 'Pulled from QuickBooks',
    });

    const mappings = await loadMappings(fx, 'payment');
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      remoteEntityId: '180/145', remoteSyncToken: '0', linkStatus: 'confirmed', syncStatus: 'synced',
    });

    // The real recompute ran under the invoice lock.
    const inv = await loadInvoice(invoiceId);
    expect(inv.status).toBe('paid');
    expect(inv.balance).toBe('0.00');
  });

  runDb('a split payment settling two invoices lands two rows under one QuickBooks Payment id', async () => {
    const fx = await seedFixture();
    const invoiceA = await seedInvoice(fx, { total: '150.00' });
    const invoiceB = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceA, '145');
    await seedInvoiceMapping(fx, invoiceB, '146');

    const a = await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '145' }), systemRunner, fx.conn.realmIdFingerprint);
    const b = await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '146' }), systemRunner, fx.conn.realmIdFingerprint);

    expect([a.outcome, b.outcome]).toEqual(['applied', 'applied']);
    expect(await loadPayments(invoiceA)).toHaveLength(1);
    expect(await loadPayments(invoiceB)).toHaveLength(1);

    // A bare Payment id would have collided on accounting_entity_mappings_remote_uniq.
    const mappings = await loadMappings(fx, 'payment');
    expect(mappings.map((m) => m.remoteEntityId).sort()).toEqual(['180/145', '180/146']);

    expect((await loadInvoice(invoiceA)).status).toBe('paid');
    expect((await loadInvoice(invoiceB)).status).toBe('paid');
  });

  runDb('reversal destroys only the QBO-origin payment; a manual payment on the same invoice survives', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '200.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');

    const [manual] = await withSystemDbAccessContext(() => db.insert(invoicePayments).values({
      invoiceId, orgId: fx.orgId, amount: '50.00', method: 'cash',
      reference: 'front-desk', receivedAt: '2026-08-01', recordedBy: fx.userId,
    }).returning({ id: invoicePayments.id }));
    if (!manual) throw new Error('failed to seed the manual payment');

    const applied = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);
    expect(applied.outcome).toBe('applied');
    expect((await loadInvoice(invoiceId)).status).toBe('paid'); // 50 + 150 = 200

    const reversed = await reverseAccountingPayment(fx.conn, '180', systemRunner, fx.conn.realmIdFingerprint);

    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ outcome: 'reversed', invoiceId, invoicePaymentId: applied.invoicePaymentId });

    const remaining = await loadPayments(invoiceId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: manual.id, amount: '50.00', method: 'cash', recordedBy: fx.userId });
    expect(await loadMappings(fx, 'payment')).toEqual([]);

    const inv = await loadInvoice(invoiceId);
    expect(inv.status).toBe('partially_paid');
    expect(inv.balance).toBe('150.00');
  });

  runDb('an allocation QuickBooks dropped from a split payment is reversed; the surviving one is untouched', async () => {
    // Finding B, against real Postgres: payment 180 settled invoices 145 and
    // 146; the operator edited it in QBO down to 145 only. The next CDC window
    // carries the 145 line and NO deletion, so without the stale sweep the
    // Breeze payment against invoice B stands forever and B reads as paid.
    const fx = await seedFixture();
    const invoiceA = await seedInvoice(fx, { total: '150.00' });
    const invoiceB = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceA, '145');
    await seedInvoiceMapping(fx, invoiceB, '146');
    await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '145' }), systemRunner, fx.conn.realmIdFingerprint);
    await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '146' }), systemRunner, fx.conn.realmIdFingerprint);
    expect((await loadInvoice(invoiceB)).status).toBe('paid');

    const stale = await reverseStaleAllocations(fx.conn, '180', ['145'], systemRunner, fx.conn.realmIdFingerprint);

    expect(stale.map((r) => r.outcome)).toEqual(['reversed']);
    expect(await loadPayments(invoiceA)).toHaveLength(1);
    expect(await loadPayments(invoiceB)).toHaveLength(0);
    expect((await loadMappings(fx, 'payment')).map((m) => m.remoteEntityId)).toEqual(['180/145']);

    // Invoice B is open again for exactly the amount that was reversed.
    const b = await loadInvoice(invoiceB);
    expect(b.status).not.toBe('paid');
    expect(b.balance).toBe('150.00');
    expect((await loadInvoice(invoiceA)).status).toBe('paid');
  });

  runDb('a stale sweep whose current set still covers every allocation destroys nothing', async () => {
    const fx = await seedFixture();
    const invoiceA = await seedInvoice(fx, { total: '150.00' });
    const invoiceB = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceA, '145');
    await seedInvoiceMapping(fx, invoiceB, '146');
    await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '145' }), systemRunner, fx.conn.realmIdFingerprint);
    await applyAccountingPayment(fx.conn, paymentLine({ remoteInvoiceId: '146' }), systemRunner, fx.conn.realmIdFingerprint);

    expect(await reverseStaleAllocations(fx.conn, '180', ['145', '146'], systemRunner, fx.conn.realmIdFingerprint)).toEqual([]);

    expect(await loadPayments(invoiceA)).toHaveLength(1);
    expect(await loadPayments(invoiceB)).toHaveLength(1);
    expect((await loadMappings(fx, 'payment'))).toHaveLength(2);
  });

  runDb('a EUR payment against a USD invoice is refused and marked on the invoice mapping', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'USD', total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');

    const res = await applyAccountingPayment(fx.conn, paymentLine({ currency: 'EUR' }), systemRunner, fx.conn.realmIdFingerprint);

    expect(res).toMatchObject({ outcome: 'currency_mismatch', invoiceId, invoicePaymentId: null });
    expect(await loadPayments(invoiceId)).toEqual([]);
    // No payment mapping row is even possible: the ownership trigger's `payment`
    // arm requires an existing invoice_payments id, and there is none. The
    // durable, operator-visible marker is the INVOICE mapping row.
    expect(await loadMappings(fx, 'payment')).toEqual([]);

    const invoiceMappings = await loadMappings(fx, 'invoice');
    expect(invoiceMappings).toHaveLength(1);
    expect(invoiceMappings[0]).toMatchObject({
      syncStatus: 'error',
      lastError: 'Payment pull: Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.',
      remoteEntityId: '145',
      linkStatus: 'confirmed',
    });

    const inv = await loadInvoice(invoiceId);
    expect(inv.status).toBe('sent');
    expect(inv.balance).toBe('150.00');
  });

  runDb('a payment against an invoice Breeze already voided writes no money row and marks the mapping', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');
    await withSystemDbAccessContext(() => db.update(invoices)
      .set({ status: 'void', voidedAt: new Date(), voidReason: 'issued in error' })
      .where(eq(invoices.id, invoiceId)));

    const res = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);

    expect(res).toMatchObject({ outcome: 'invoice_void', invoiceId, invoicePaymentId: null });
    expect(await loadPayments(invoiceId)).toEqual([]);
    expect(await loadMappings(fx, 'payment')).toEqual([]);

    const [invoiceMapping] = await loadMappings(fx, 'invoice');
    expect(invoiceMapping).toMatchObject({
      syncStatus: 'error',
      lastError: 'Payment pull: Payment received in QuickBooks against a voided invoice',
      remoteEntityId: '145',
      linkStatus: 'confirmed',
    });

    // The void header is untouched: no amount_paid/balance rewrite.
    const inv = await loadInvoice(invoiceId);
    expect(inv.status).toBe('void');
    expect(inv.amountPaid).toBe('0.00');
    expect(inv.balance).toBe('150.00');
  });

  runDb('a later payment clears the payment-pull marker but never a push-originated one (finding G)', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    const mappingId = await seedInvoiceMapping(fx, invoiceId, '145');

    // A payment-originated marker (a currency mismatch that has since been fixed).
    await withSystemDbAccessContext(() => db.update(accountingEntityMappings)
      .set({ syncStatus: 'error', lastError: 'Payment pull: Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.' })
      .where(eq(accountingEntityMappings.id, mappingId)));

    await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);

    const [cleared] = await loadMappings(fx, 'invoice');
    expect(cleared).toMatchObject({ syncStatus: 'synced', lastError: null });

    // A PUSH-originated marker survives the next pulled payment untouched.
    await withSystemDbAccessContext(() => db.update(accountingEntityMappings)
      .set({ syncStatus: 'error', lastError: 'Deleted in QuickBooks' })
      .where(eq(accountingEntityMappings.id, mappingId)));

    await applyAccountingPayment(
      fx.conn, paymentLine({ remotePaymentId: '181', paymentRefNum: '10442' }), systemRunner,
      fx.conn.realmIdFingerprint,
    );

    const [kept] = await loadMappings(fx, 'invoice');
    expect(kept).toMatchObject({ syncStatus: 'error', lastError: 'Deleted in QuickBooks' });
  });

  runDb('a payment for an invoice Breeze never pushed is skipped and writes nothing', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    // Deliberately NO invoice mapping row.

    const res = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);

    expect(res.outcome).toBe('skipped_unmapped');
    expect(await loadPayments(invoiceId)).toEqual([]);
    expect(await loadMappings(fx, 'payment')).toEqual([]);
    expect(await loadMappings(fx, 'invoice')).toEqual([]);
  });

  runDb('the ownership trigger refuses a payment mapping forged across partners', async () => {
    const partnerA = await seedFixture();
    const partnerB = await seedFixture();
    const invoiceId = await seedInvoice(partnerA, { total: '150.00' });
    await seedInvoiceMapping(partnerA, invoiceId, '145');
    const applied = await applyAccountingPayment(partnerA.conn, paymentLine(), systemRunner, partnerA.conn.realmIdFingerprint);
    expect(applied.invoicePaymentId).toBeTruthy();

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() => db.insert(accountingEntityMappings).values({
        integrationId: partnerB.conn.id,
        partnerId: partnerB.partnerId,
        breezeEntityType: 'payment',
        breezeEntityId: applied.invoicePaymentId!,
        remoteEntityType: 'Payment',
        remoteEntityId: '999/145',
        linkStatus: 'confirmed',
        syncStatus: 'synced',
      }));
    } catch (error) {
      caught = error;
    }

    expect(sqlCause(caught).code).toBe('23514');
    expect(sqlCause(caught).message).toMatch(/does not belong to partner/i);
  });

  runDb('invoiceService.voidPayment REFUSES a pulled (QuickBooks-origin) payment and changes nothing', async () => {
    // Phase D2, spec decision 14. Until now this void succeeded, and the next
    // CDC sweep pulled the same payment straight back in — leaving an audit
    // trail of a void that did nothing. The refusal is asserted here rather than
    // only in the unit suite because it turns on the REAL `breeze_origin` value
    // the pull writes (the column defaults to false, so a pulled row is
    // QuickBooks-origin without the applier saying so explicitly).
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');
    const applied = await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);
    expect(await loadMappings(fx, 'payment')).toHaveLength(1);
    const before = await loadInvoice(invoiceId);

    await expect(withSystemDbAccessContext(() => voidPayment(applied.invoicePaymentId!, {
      userId: fx.userId, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId],
    }))).rejects.toMatchObject({ status: 409, code: 'QUICKBOOKS_OWNED_PAYMENT' });

    // Refused BEFORE any write: the payment, its mapping and the invoice's own
    // money columns are all exactly as the pull left them.
    expect(await loadPayments(invoiceId)).toHaveLength(1);
    expect(await loadMappings(fx, 'payment')).toHaveLength(1);
    const after = await loadInvoice(invoiceId);
    expect(after.status).toBe(before.status);
    expect(after.balance).toBe(before.balance);
    expect(after.amountPaid).toBe(before.amountPaid);
  });

  runDb('invoiceService.voidPayment still voids a MANUAL payment on an invoice QuickBooks also paid', async () => {
    // The refusal must be narrow: only the QuickBooks-owned row is protected.
    // A hand-recorded payment on the same invoice stays hand-voidable, and its
    // void leaves the pulled payment and mapping untouched.
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');
    await applyAccountingPayment(fx.conn, paymentLine(), systemRunner, fx.conn.realmIdFingerprint);
    const [manual] = await withSystemDbAccessContext(() => db.insert(invoicePayments).values({
      invoiceId, orgId: fx.orgId, amount: '10.00', method: 'cash',
      receivedAt: '2026-09-02', recordedBy: fx.userId,
    }).returning({ id: invoicePayments.id }));

    await withSystemDbAccessContext(() => voidPayment(manual!.id, {
      userId: fx.userId, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId],
    }));

    const remaining = await loadPayments(invoiceId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(manual!.id);
    expect(await loadMappings(fx, 'payment')).toHaveLength(1);
  });

  runDb('markInvoiceDeletedRemotely flips the invoice mapping to error and keeps the remote id', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, '145');

    const outcome = await markInvoiceDeletedRemotely(fx.conn, '145', systemRunner, fx.conn.realmIdFingerprint);

    expect(outcome).toBe('marked');
    const [mapping] = await loadMappings(fx, 'invoice');
    expect(mapping).toMatchObject({
      syncStatus: 'error',
      lastError: 'Deleted in QuickBooks',
      remoteEntityId: '145',
      linkStatus: 'confirmed',
    });

    // An invoice QuickBooks never saw is a clean no-op.
    expect(await markInvoiceDeletedRemotely(fx.conn, '999', systemRunner, fx.conn.realmIdFingerprint)).toBe('skipped_unmapped');
  });
});
