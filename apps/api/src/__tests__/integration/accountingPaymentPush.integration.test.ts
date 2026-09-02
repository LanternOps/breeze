/**
 * QuickBooks payment PUSH against real Postgres (Phase D2).
 *
 * The unit suites (`accountingPaymentPush.test.ts`, `invoiceService.*.test.ts`)
 * assert the SQL Breeze MEANT to write against a fake db. Only this file can
 * prove the facts that live in Postgres itself:
 *
 *  - THE OUTBOX IS ATOMIC. The mapping row is written in the SAME transaction
 *    as the `invoice_payments` row — roll that transaction back and neither
 *    exists, so no promise to QuickBooks can outlive a payment that was undone.
 *  - THE LEASE REALLY EXCLUDES. The compare-and-set claim is a single UPDATE
 *    whose WHERE clause is evaluated by Postgres; a second worker gets zero
 *    rows and a `sync_in_progress` refusal, and the claim really does expire.
 *  - A `pending_op='delete'` ROW OUTLIVES ITS PAYMENT. The partner guard
 *    trigger fires only on INSERT and UPDATE OF
 *    (partner_id, breeze_entity_type, breeze_entity_id), which is what lets a
 *    void destroy the `invoice_payments` row while its mapping stays behind
 *    owing QuickBooks a delete. A mocked db cannot express that trigger at all.
 *  - `accounting_entity_mappings_breeze_uniq` FORBIDS A SECOND MAPPING for the
 *    same payment, which is why `fanOutOwedPayments` RE-OWNS a remotely-deleted
 *    row instead of inserting one — the only re-push path that exists.
 *  - THE `pending_op` CHECK, the RLS partner axis (42501), the ownership
 *    trigger (23514) and the composite connection FK (23503) all reject a
 *    forged mapping.
 *  - `recomputeInvoiceStatus` really CLEARS `paid_at` when an invoice leaves
 *    `paid` (#4542) — the unit suites mock the recompute entirely.
 *  - The Task-1 migration's `breeze_origin` backfill really needs
 *    `breeze.scope = 'system'`: without it the UPDATE is a silent zero-row
 *    no-op under FORCE RLS, which is exactly how a managed-Postgres backfill
 *    ships "successfully" and changes nothing.
 *
 * Only the QuickBooks PROVIDER is stubbed (`createPayment` / `deletePayment`
 * on the object `getAccountingProvider('quickbooks')` returns). The database is
 * never mocked and every case runs through the real `withSystemDbAccessContext`
 * / `withDbAccessContext` runners, so RLS is exercised on every statement.
 *
 * Harness mirrors `accountingPaymentPull.integration.test.ts`: `import './setup'`
 * (which TRUNCATEs the tenant tables before every test, so each case seeds its
 * own fixture), `runDb` gating on DATABASE_URL, and `createPartner` /
 * `createOrganization` / `createUser` from `./db-utils`.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  accountingEntityMappings,
  invoicePayments,
  invoices,
  type AccountingEntityMapping,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import type {
  AccountingDeletePaymentPayload,
  AccountingPaymentPayload,
  ChangeSetPaymentLine,
  PaymentDeleteResult,
  RemoteRef,
} from '../../services/accounting/types';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import {
  PAYMENT_CLAIM_LEASE_MS,
  PAYMENT_DELETE_UNRESOLVED_GRACE_MS,
  PAYMENT_SWEEP_MIN_AGE_MS,
  deletePaymentInAccounting,
  fanOutOwedPayments,
  listOwedPaymentMappings,
  partialRefundDivergenceMessage,
  pushPaymentToAccounting,
  requestPaymentPush,
} from '../../services/accounting/accountingPaymentPush';
import {
  BREEZE_ORIGIN_DIVERGED_MESSAGE,
  BREEZE_ORIGIN_REMOVED_MESSAGE,
  applyAccountingPayment,
  reverseAccountingPayment,
  reverseStaleAllocations,
} from '../../services/accounting/accountingPaymentPull';
import { buildPaymentPrivateNote } from '../../services/accounting/accountingPaymentMarker';

// The coordinator itself emits no invoice events and enqueues no jobs, but
// `invoiceService.recordPayment`/`voidPayment` (driven throughout) do both.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));

import { enqueueAccountingPaymentDelete } from '../../jobs/accountingSyncWorker';
import { listPayments, recordPayment, voidPayment } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Every coordinator is ENTERED with no ambient context and opens its own short
 *  ones through this runner — exactly how the Task-4 workers call them. */
const systemRunner: DbContextRunner = (fn) => withSystemDbAccessContext(fn, 'accountingPaymentPush.test');

const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-02-110000-quickbooks-payment-push.sql',
);

// ---------------------------------------------------------------------------
// Provider stubs — the ONLY thing mocked in this file.
// ---------------------------------------------------------------------------

const quickbooks = getAccountingProvider('quickbooks');

afterEach(() => {
  vi.restoreAllMocks();
});

function stubCreatePayment(
  impl: (conn: AccountingConnection, payload: AccountingPaymentPayload) => Promise<RemoteRef>,
) {
  return vi.spyOn(quickbooks, 'createPayment').mockImplementation(impl);
}

function stubDeletePayment(
  impl: (conn: AccountingConnection, payload: AccountingDeletePaymentPayload) => Promise<PaymentDeleteResult>,
) {
  return vi.spyOn(quickbooks, 'deletePayment').mockImplementation(impl);
}

/** A `createPayment` that is a hard failure if it is ever reached. Used to prove
 *  a refusal happened BEFORE the QuickBooks call, not after it. */
function forbidCreatePayment() {
  return vi.spyOn(quickbooks, 'createPayment').mockImplementation(async () => {
    throw new Error('createPayment must not be called on this path');
  });
}

function forbidDeletePayment() {
  return vi.spyOn(quickbooks, 'deletePayment').mockImplementation(async () => {
    throw new Error('deletePayment must not be called on this path');
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  conn: AccountingConnection;
  actor: { userId: string; partnerId: string; accessibleOrgIds: string[] };
}

async function seedFixture(opts: {
  pushPayments?: boolean;
  pullPayments?: boolean;
  pushMode?: 'auto' | 'manual';
  homeCurrency?: string;
} = {}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'USD' });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const conn = await upsertConnection(db, partner.id, 'quickbooks', {
      realmId: `realm-payment-push-${partner.id.slice(0, 8)}`,
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS,
      refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'sandbox',
      homeCurrency: opts.homeCurrency ?? 'USD',
      pushMode: opts.pushMode ?? 'auto',
      pushPayments: opts.pushPayments ?? true,
      pullPayments: opts.pullPayments ?? true,
    });
    return {
      partnerId: partner.id,
      orgId: org.id,
      userId: user.id,
      conn,
      actor: { userId: user.id, partnerId: partner.id, accessibleOrgIds: [org.id] },
    };
  });
}

/** An issued, pushable invoice — the coordinator reads only the header. */
async function seedInvoice(fx: Fixture, opts: { currencyCode?: string; total?: string } = {}): Promise<string> {
  const total = opts.total ?? '150.00';
  return withSystemDbAccessContext(async () => {
    const [inv] = await db
      .insert(invoices)
      .values({
        partnerId: fx.partnerId,
        orgId: fx.orgId,
        invoiceNumber: `INV-PUSH-${Math.random().toString(36).slice(2, 8)}`,
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

/** The `synced` invoice mapping the coordinator resolves the remote invoice from. */
async function seedInvoiceMapping(fx: Fixture, invoiceId: string, remoteInvoiceId = '145'): Promise<string> {
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
      breezeOrigin: true,
    }).returning({ id: accountingEntityMappings.id });
    if (!row) throw new Error('failed to seed invoice mapping fixture');
    return row.id;
  });
}

/** The `confirmed` Customer mapping the payment payload names. */
async function seedOrgMapping(fx: Fixture, remoteCustomerId = '55'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(accountingEntityMappings).values({
      integrationId: fx.conn.id,
      partnerId: fx.partnerId,
      breezeEntityType: 'org',
      breezeEntityId: fx.orgId,
      remoteEntityType: 'Customer',
      remoteEntityId: remoteCustomerId,
      linkStatus: 'confirmed',
      syncStatus: 'synced',
    }).returning({ id: accountingEntityMappings.id });
    if (!row) throw new Error('failed to seed org mapping fixture');
    return row.id;
  });
}

/** partner + org + user + connection + issued invoice + invoice/org mappings. */
async function seedPushable(opts: {
  total?: string;
  pushPayments?: boolean;
  pullPayments?: boolean;
  pushMode?: 'auto' | 'manual';
} = {}) {
  const fx = await seedFixture(opts);
  const invoiceId = await seedInvoice(fx, { total: opts.total ?? '150.00' });
  await seedInvoiceMapping(fx, invoiceId, '145');
  await seedOrgMapping(fx, '55');
  return { fx, invoiceId };
}

function paymentLine(overrides: Partial<ChangeSetPaymentLine> = {}): ChangeSetPaymentLine {
  return {
    remoteInvoiceId: '145',
    remotePaymentId: '181',
    amountMinor: 4000,
    currency: 'USD',
    txnDate: '2026-09-02',
    remotePaymentSyncToken: '0',
    paymentMethodName: 'Check',
    paymentRefNum: '10441',
    breezePaymentId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Readers — always through the real access-context runner, never a raw pool.
// ---------------------------------------------------------------------------

async function loadPaymentMappings(fx: Fixture): Promise<AccountingEntityMapping[]> {
  return withSystemDbAccessContext(() =>
    db.select().from(accountingEntityMappings).where(and(
      eq(accountingEntityMappings.integrationId, fx.conn.id),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
    )) as unknown as Promise<AccountingEntityMapping[]>
  );
}

async function loadOnePaymentMapping(fx: Fixture): Promise<AccountingEntityMapping> {
  const rows = await loadPaymentMappings(fx);
  if (rows.length !== 1) throw new Error(`expected exactly one payment mapping, found ${rows.length}`);
  return rows[0]!;
}

async function loadPayments(invoiceId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId))
  );
}

async function loadInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  );
  if (!row) throw new Error(`invoice ${invoiceId} disappeared`);
  return row;
}

/** Drive a full record -> push, returning the ids and the create spy. */
async function recordAndPush(
  fx: Fixture,
  invoiceId: string,
  opts: { amount?: number; remotePaymentId?: string; syncToken?: string } = {},
) {
  const recorded = await withSystemDbAccessContext(() => recordPayment(
    invoiceId,
    { amount: opts.amount ?? 40, method: 'check', receivedAt: '2026-09-02' },
    fx.actor,
  ));
  const mapping = await loadOnePaymentMapping(fx);
  const create = stubCreatePayment(async () => ({
    id: opts.remotePaymentId ?? '181',
    syncToken: opts.syncToken ?? '0',
  }));
  const outcome = await pushPaymentToAccounting(mapping.id, fx.partnerId, systemRunner);
  return { recorded, mappingId: mapping.id, paymentId: recorded.audit.paymentId, outcome, create };
}

function partnerContext(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function sqlCause(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

/** Set `claimed_at` by hand — the only way to simulate a second worker. */
async function setClaimedAt(mappingId: string, at: Date | null): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(accountingEntityMappings)
    .set({ claimedAt: at })
    .where(eq(accountingEntityMappings.id, mappingId))
    .returning({ id: accountingEntityMappings.id }));
}

// ---------------------------------------------------------------------------

describe('QuickBooks payment push — real Postgres', () => {
  // -------------------------------------------------------------------------
  // The outbox
  // -------------------------------------------------------------------------

  runDb('records the payment and its pending push mapping atomically', async () => {
    const { fx, invoiceId } = await seedPushable();

    await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));

    const [payment] = await loadPayments(invoiceId);
    expect(payment).toMatchObject({ amount: '40.00', method: 'check', recordedBy: fx.userId });

    const mapping = await loadOnePaymentMapping(fx);
    expect(mapping).toMatchObject({
      breezeEntityType: 'payment',
      breezeEntityId: payment!.id,
      remoteEntityType: 'Payment',
      remoteEntityId: null,
      remoteSyncToken: null,
      breezeOrigin: true,
      pendingOp: 'push',
      syncStatus: 'pending',
      linkStatus: 'create_new',
      claimedAt: null,
      lastError: null,
    });
  });

  runDb('a rolled-back payment transaction leaves NO payment row and NO mapping', async () => {
    // The property that makes the outbox trustworthy: the promise to QuickBooks
    // cannot outlive the money row it promises to sync.
    const { fx, invoiceId } = await seedPushable();

    await expect(withSystemDbAccessContext(async () => {
      const [payment] = await db.insert(invoicePayments).values({
        invoiceId, orgId: fx.orgId, amount: '40.00', method: 'check',
        receivedAt: '2026-09-02', recordedBy: fx.userId,
      }).returning({ id: invoicePayments.id });
      const mappingId = await requestPaymentPush(db, {
        invoicePaymentId: payment!.id, invoiceId, partnerId: fx.partnerId,
      });
      // Positive control: the mapping really WAS written before the rollback,
      // so the assertions below are proving a rollback, not a no-op.
      expect(mappingId).toEqual(expect.any(String));
      throw new Error('rollback probe');
    })).rejects.toThrow('rollback probe');

    expect(await loadPayments(invoiceId)).toEqual([]);
    expect(await loadPaymentMappings(fx)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Phase 2 + the lease
  // -------------------------------------------------------------------------

  runDb('phase 2 stamps the composite remote id and the second push is a clean no-op', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId, mappingId, outcome, create } = await recordAndPush(fx, invoiceId);

    expect(outcome).toBe('pushed');
    // The payload really was built from real rows — not an empty object handed
    // to a mock that returns regardless.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({
      invoicePaymentId: paymentId,
      remoteCustomerId: '55',
      remoteInvoiceId: '145',
      amount: '40.00',
      currencyCode: 'USD',
      txnDate: '2026-09-02',
      privateNote: buildPaymentPrivateNote(paymentId),
    });

    const mapping = await loadOnePaymentMapping(fx);
    expect(mapping).toMatchObject({
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      pendingOp: null,
      claimedAt: null,
      lastError: null,
      breezeOrigin: true,
    });
    expect(mapping.lastSyncedAt).toBeInstanceOf(Date);

    // Nothing is owed any more, so a re-run must not mint a SECOND QBO Payment.
    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('nothing_owed');
    expect(create).toHaveBeenCalledTimes(1);
  });

  runDb('the lease excludes a second worker and really does expire', async () => {
    const { fx, invoiceId } = await seedPushable();
    await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    await setClaimedAt(mappingId, new Date());
    const blocked = forbidCreatePayment();
    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
    expect(blocked).not.toHaveBeenCalled();
    // A lost CAS must not have stamped an error or dropped the work.
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ pendingOp: 'push', syncStatus: 'pending' });

    blocked.mockRestore();
    await setClaimedAt(mappingId, new Date(Date.now() - PAYMENT_CLAIM_LEASE_MS - 1000));
    const create = stubCreatePayment(async () => ({ id: '181', syncToken: '0' }));

    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('pushed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ remoteEntityId: '181/145', claimedAt: null });
  });

  // -------------------------------------------------------------------------
  // The CDC echo
  // -------------------------------------------------------------------------

  runDb('the echo AFTER phase 2 replays and records no second payment row', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId } = await recordAndPush(fx, invoiceId);

    const echo = await applyAccountingPayment(
      fx.conn,
      paymentLine({ remotePaymentId: '181', remoteInvoiceId: '145', remotePaymentSyncToken: '0', breezePaymentId: paymentId }),
      systemRunner,
      fx.conn.realmIdFingerprint,
    );

    expect(echo).toMatchObject({ outcome: 'replayed', invoiceId, invoicePaymentId: paymentId });
    expect(await loadPayments(invoiceId)).toHaveLength(1);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0', syncStatus: 'synced', pendingOp: null,
    });
  });

  runDb('the echo BEFORE phase 2 adopts, and phase 2 keeps the token the echo stored', async () => {
    const { fx, invoiceId } = await seedPushable();
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const paymentId = recorded.audit.paymentId;
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    // The CDC sweep lands while the create is still in flight. `createPayment`
    // runs inside `runOutsideDbContext`, so the applier really is entered with
    // no ambient context — the same shape the worker produces.
    let adoption: string | undefined;
    const create = stubCreatePayment(async () => {
      const applied = await applyAccountingPayment(
        fx.conn,
        paymentLine({ remotePaymentId: '181', remotePaymentSyncToken: '4', breezePaymentId: paymentId }),
        systemRunner,
        fx.conn.realmIdFingerprint,
      );
      adoption = applied.outcome;
      return { id: '181', syncToken: '0' };
    });

    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('already_adopted');
    expect(adoption).toBe('adopted');
    expect(create).toHaveBeenCalledTimes(1);

    // The ADOPTER's token survives phase 2 — a stale '0' would make the next
    // delete send an outdated SyncToken.
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '4', syncStatus: 'synced',
      pendingOp: null, claimedAt: null, linkStatus: 'confirmed',
    });
    expect(await loadPayments(invoiceId)).toHaveLength(1);
  });

  runDb('a mid-flight partial refund diverges and quotes the CUMULATIVE refunded total', async () => {
    const { fx, invoiceId } = await seedPushable({ total: '150.00' });
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 100, method: 'card', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const paymentId = recorded.audit.paymentId;
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    const create = stubCreatePayment(async () => {
      // Stripe refunded 40.00 while QuickBooks was creating the 100.00 Payment.
      await withSystemDbAccessContext(() => db
        .update(invoicePayments).set({ amount: '60.00' }).where(eq(invoicePayments.id, paymentId))
        .returning({ id: invoicePayments.id }));
      return { id: '181', syncToken: '0' };
    });

    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('diverged');
    expect(create).toHaveBeenCalledTimes(1);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      syncStatus: 'error',
      pendingOp: null,
      claimedAt: null,
      lastError: partialRefundDivergenceMessage('40.00'),
    });
    expect(partialRefundDivergenceMessage('40.00')).toBe(
      'Refunded in Stripe, total 40.00; record the refund in QuickBooks '
      + '(this QuickBooks payment still shows the full amount)',
    );
  });

  // -------------------------------------------------------------------------
  // Void -> delete, and the row that outlives its payment
  // -------------------------------------------------------------------------

  runDb('a void after a push flips to delete-pending and the mapping SURVIVES a failed enqueue', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId } = await recordAndPush(fx, invoiceId);

    // The BullMQ nudge is only a latency optimisation; losing it must not lose
    // the delete, because the mapping row is the durable outbox.
    vi.mocked(enqueueAccountingPaymentDelete).mockRejectedValueOnce(new Error('redis down'));

    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));

    // The money row is gone — and the mapping that names it is NOT, which only
    // the partner-guard trigger's INSERT/UPDATE-OF scoping permits.
    expect(await loadPayments(invoiceId)).toEqual([]);
    const mapping = await loadOnePaymentMapping(fx);
    expect(mapping).toMatchObject({
      breezeEntityId: paymentId,
      pendingOp: 'delete',
      syncStatus: 'pending',
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      breezeOrigin: true,
      lastError: null,
    });

    // ...and the sweep finds it once it is old enough that the immediate
    // enqueue (the one that just failed) has had its chance.
    await withSystemDbAccessContext(() => db
      .update(accountingEntityMappings)
      .set({ updatedAt: new Date(Date.now() - PAYMENT_SWEEP_MIN_AGE_MS - 60_000) })
      .where(eq(accountingEntityMappings.id, mapping.id))
      .returning({ id: accountingEntityMappings.id }));

    const owed = await withSystemDbAccessContext(() => listOwedPaymentMappings(db, new Date()));
    expect(owed).toEqual([{ id: mapping.id, partnerId: fx.partnerId, pendingOp: 'delete' }]);

    // And the delete really clears the outbox row.
    const del = stubDeletePayment(async () => 'deleted');
    expect(await deletePaymentInAccounting(mapping.id, fx.partnerId, systemRunner)).toBe('deleted');
    expect(del.mock.calls[0]![1]).toEqual({ remotePaymentId: '181', syncToken: '0' });
    expect(await loadPaymentMappings(fx)).toEqual([]);
  });

  runDb('a void DURING an in-flight push parks on awaiting_remote_ref until the pull adopts it', async () => {
    const { fx, invoiceId } = await seedPushable();
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const paymentId = recorded.audit.paymentId;
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    // A worker holds the lease and is somewhere between phase 1 and QuickBooks.
    const claimedAt = new Date();
    await setClaimedAt(mappingId, claimedAt);

    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));

    // The push row was NOT deleted (that would orphan a QuickBooks Payment the
    // in-flight create may be about to make) and the LEASE was left alone.
    const flipped = await loadOnePaymentMapping(fx);
    expect(flipped).toMatchObject({ pendingOp: 'delete', syncStatus: 'pending', remoteEntityId: null });
    expect(flipped.claimedAt?.getTime()).toBe(claimedAt.getTime());

    // A delete worker meeting the live lease backs off, retryably.
    const blockedDelete = forbidDeletePayment();
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
    expect(blockedDelete).not.toHaveBeenCalled();
    blockedDelete.mockRestore();

    // The lease lapses; with no remote id the worker PARKS rather than guessing.
    await setClaimedAt(mappingId, null);
    const stillBlocked = forbidDeletePayment();
    expect(await deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).toBe('awaiting_remote_ref');
    expect(stillBlocked).not.toHaveBeenCalled();
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ pendingOp: 'delete', claimedAt: null });
    stillBlocked.mockRestore();

    // The CDC pull finds the orphaned Payment by its PrivateNote marker and
    // fills the remote id in — the un-parking move.
    const adopted = await applyAccountingPayment(
      fx.conn,
      paymentLine({ remotePaymentId: '181', remotePaymentSyncToken: '7', breezePaymentId: paymentId }),
      systemRunner,
      fx.conn.realmIdFingerprint,
    );
    expect(adopted.outcome).toBe('adopted');
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '7', pendingOp: 'delete',
      syncStatus: 'pending', claimedAt: null, linkStatus: 'confirmed',
    });

    const del = stubDeletePayment(async () => 'deleted');
    expect(await deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).toBe('deleted');
    expect(del.mock.calls[0]![1]).toEqual({ remotePaymentId: '181', syncToken: '7' });
    expect(await loadPaymentMappings(fx)).toEqual([]);
  });

  runDb('an unresolved delete is dropped LOUDLY once the grace window closes', async () => {
    const { fx, invoiceId } = await seedPushable();
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    await withSystemDbAccessContext(() => voidPayment(recorded.audit.paymentId, fx.actor));
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    // The age is measured on created_at, NOT updated_at — the lease CAS bumps
    // updated_at on every attempt, so an age measured on it would never expire.
    await withSystemDbAccessContext(() => db
      .update(accountingEntityMappings)
      .set({ createdAt: new Date(Date.now() - PAYMENT_DELETE_UNRESOLVED_GRACE_MS - 60_000) })
      .where(eq(accountingEntityMappings.id, mappingId))
      .returning({ id: accountingEntityMappings.id }));

    const blocked = forbidDeletePayment();
    expect(await deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).toBe('unresolved_dropped');
    expect(blocked).not.toHaveBeenCalled();
    expect(await loadPaymentMappings(fx)).toEqual([]);
  });

  runDb('phase 2 on a row a void already flipped converts to delete with the remote ref stamped', async () => {
    const { fx, invoiceId } = await seedPushable();
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const paymentId = recorded.audit.paymentId;
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    const create = stubCreatePayment(async () => {
      // The operator voids while QuickBooks is creating the Payment.
      await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));
      return { id: '181', syncToken: '2' };
    });

    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('converted_to_delete');
    expect(create).toHaveBeenCalledTimes(1);

    // The delete worker is handed an Id AND a SyncToken it could not otherwise
    // have learned — the whole reason requestPaymentDelete keeps the row.
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '2', pendingOp: 'delete',
      syncStatus: 'pending', claimedAt: null, linkStatus: 'confirmed', lastError: null,
    });
    expect(await loadPayments(invoiceId)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // CDC deletion / reallocation of a Breeze-origin row
  // -------------------------------------------------------------------------

  runDb('a Breeze-origin CDC delete keeps the payment row and re-arms it for a re-push', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId, mappingId } = await recordAndPush(fx, invoiceId);
    const paidBefore = await loadInvoice(invoiceId);
    expect(paidBefore.amountPaid).toBe('40.00');

    const reversed = await reverseAccountingPayment(fx.conn, '181', systemRunner, fx.conn.realmIdFingerprint);

    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ outcome: 'breeze_origin_removed_remotely', invoicePaymentId: paymentId });

    // The money moved, so the Breeze row survives an accounting-side deletion.
    expect(await loadPayments(invoiceId)).toHaveLength(1);
    const after = await loadInvoice(invoiceId);
    expect(after.amountPaid).toBe('40.00');
    expect(after.balance).toBe(paidBefore.balance);

    const errored = await loadOnePaymentMapping(fx);
    expect(errored).toMatchObject({
      id: mappingId,
      syncStatus: 'error',
      lastError: BREEZE_ORIGIN_REMOVED_MESSAGE,
      remoteEntityId: null,
      remoteSyncToken: null,
      pendingOp: null,
      breezeOrigin: true,
    });

    // `accounting_entity_mappings_breeze_uniq` forbids a SECOND mapping for the
    // same payment, so the fan-out RE-OWNS this exact row — the only re-push
    // path there is. A mocked db cannot enforce that index, and without it the
    // insert path would look like a valid alternative.
    const owed = await fanOutOwedPayments(invoiceId, fx.partnerId, systemRunner);
    expect(owed).toEqual([mappingId]);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      pendingOp: 'push', syncStatus: 'pending', linkStatus: 'create_new', lastError: null, claimedAt: null,
    });

    const create = stubCreatePayment(async () => ({ id: '182', syncToken: '0' }));
    // `vi.spyOn` on an already-spied method reuses the SAME spy, so the first
    // push's call is still on it. Clear the log (the implementation survives)
    // so the count below really counts the RE-push.
    create.mockClear();
    expect(await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).toBe('pushed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({
      invoicePaymentId: paymentId, remoteInvoiceId: '145', amount: '40.00',
    });

    const rows = await loadPaymentMappings(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: mappingId, remoteEntityId: '182/145', syncStatus: 'synced', pendingOp: null });
  });

  runDb('a CDC delete of a row that already owed a delete SATISFIES it and drops the mapping', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId, mappingId } = await recordAndPush(fx, invoiceId);
    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ id: mappingId, pendingOp: 'delete' });

    const reversed = await reverseAccountingPayment(fx.conn, '181', systemRunner, fx.conn.realmIdFingerprint);

    expect(reversed.map((r) => r.outcome)).toEqual(['breeze_origin_removed_remotely']);
    // QuickBooks got there first: the owed delete is done, so nothing is left
    // to park on `awaiting_remote_ref` and raise a false orphan alarm.
    expect(await loadPaymentMappings(fx)).toEqual([]);
  });

  runDb('a REALLOCATION is not a deletion: delete-pending is untouched, nothing-owed diverges with its ids KEPT', async () => {
    const { fx, invoiceId } = await seedPushable();
    const { paymentId, mappingId } = await recordAndPush(fx, invoiceId);

    // (a) The Payment is alive and the delete job is about to remove it
    //     outright — writing anything here would abandon that delete.
    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));
    const beforeStale = await loadOnePaymentMapping(fx);
    const staleWhileOwed = await reverseStaleAllocations(
      fx.conn, '181', ['146'], systemRunner, fx.conn.realmIdFingerprint,
    );
    expect(staleWhileOwed.map((r) => r.outcome)).toEqual(['skipped_breeze_origin']);
    const afterStale = await loadOnePaymentMapping(fx);
    expect(afterStale).toMatchObject({
      id: mappingId, pendingOp: 'delete', remoteEntityId: '181/145', remoteSyncToken: '0',
      syncStatus: 'pending', lastError: null,
    });
    expect(afterStale.updatedAt.getTime()).toBe(beforeStale.updatedAt.getTime());

    // (b) Nothing owed: an EDIT, recorded for a human — and the ids SURVIVE it,
    //     because a later Breeze void still has to delete that Payment.
    await withSystemDbAccessContext(() => db
      .update(accountingEntityMappings)
      .set({ pendingOp: null, syncStatus: 'synced' })
      .where(eq(accountingEntityMappings.id, mappingId))
      .returning({ id: accountingEntityMappings.id }));

    const staleWhenIdle = await reverseStaleAllocations(
      fx.conn, '181', ['146'], systemRunner, fx.conn.realmIdFingerprint,
    );
    expect(staleWhenIdle.map((r) => r.outcome)).toEqual(['breeze_origin_diverged']);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      syncStatus: 'error',
      lastError: BREEZE_ORIGIN_DIVERGED_MESSAGE,
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      pendingOp: null,
    });
  });

  // -------------------------------------------------------------------------
  // Money maths + classification
  // -------------------------------------------------------------------------

  runDb('paid_at is stamped when the invoice is paid and CLEARED when a void takes it back out (#4542)', async () => {
    const { fx, invoiceId } = await seedPushable({ total: '150.00' });
    const recorded = await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 150, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));

    const paid = await loadInvoice(invoiceId);
    expect(paid.status).toBe('paid');
    expect(paid.balance).toBe('0.00');
    expect(paid.paidAt).toBeInstanceOf(Date);

    await withSystemDbAccessContext(() => voidPayment(recorded.audit.paymentId, fx.actor));

    const reopened = await loadInvoice(invoiceId);
    expect(reopened.status).toBe('sent');
    expect(reopened.amountPaid).toBe('0.00');
    expect(reopened.balance).toBe('150.00');
    // Before #4542 this kept a payment date the invoice no longer had, and
    // every "paid in period" report counted the invoice twice.
    expect(reopened.paidAt).toBeNull();
  });

  runDb('listPayments badges Breeze-origin as manual-with-sync and QuickBooks-origin as quickbooks', async () => {
    const { fx, invoiceId } = await seedPushable({ total: '150.00' });
    const { paymentId: breezePaymentId } = await recordAndPush(fx, invoiceId);

    // A genuinely QuickBooks-origin payment on the same invoice.
    const pulled = await applyAccountingPayment(
      fx.conn,
      paymentLine({ remotePaymentId: '200', amountMinor: 5000, paymentRefNum: '10442' }),
      systemRunner,
      fx.conn.realmIdFingerprint,
    );
    expect(pulled.outcome).toBe('applied');

    const rows = await withSystemDbAccessContext(() => listPayments(invoiceId, fx.actor));
    const breezeRow = rows.find((r) => r.id === breezePaymentId);
    const qboRow = rows.find((r) => r.id === pulled.invoicePaymentId);

    expect(breezeRow).toMatchObject({
      source: 'manual',
      accountingSync: { status: 'synced', lastError: null },
    });
    expect(qboRow).toMatchObject({ source: 'quickbooks', accountingSync: null });

    // The badge and the refusal are the same fact: QuickBooks OWNS its row.
    await expect(withSystemDbAccessContext(() => voidPayment(pulled.invoicePaymentId!, fx.actor)))
      .rejects.toMatchObject({ status: 409, code: 'QUICKBOOKS_OWNED_PAYMENT' });
    expect(await loadPayments(invoiceId)).toHaveLength(2);

    // ...while the Breeze-origin one is still hand-voidable, and the void
    // propagates as a delete rather than dropping the mapping.
    await withSystemDbAccessContext(() => voidPayment(breezePaymentId, fx.actor));
    const mappings = await loadPaymentMappings(fx);
    expect(mappings).toHaveLength(2);
    expect(mappings.find((m) => m.breezeEntityId === breezePaymentId))
      .toMatchObject({ pendingOp: 'delete', remoteEntityId: '181/145' });
  });

  runDb('fanOutOwedPayments is idempotent — the breeze_uniq index makes a second insert impossible', async () => {
    // `manual` push mode: recordPayment writes no mapping, so the fan-out is the
    // only way these payments reach QuickBooks at all.
    const { fx, invoiceId } = await seedPushable({ total: '150.00', pushMode: 'manual' });
    await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 60, method: 'cash', receivedAt: '2026-09-03' }, fx.actor,
    ));
    expect(await loadPaymentMappings(fx)).toEqual([]);

    const first = await fanOutOwedPayments(invoiceId, fx.partnerId, systemRunner);
    expect(first).toHaveLength(2);

    const second = await fanOutOwedPayments(invoiceId, fx.partnerId, systemRunner);
    expect(second).toEqual([]);

    const mappings = await loadPaymentMappings(fx);
    expect(mappings).toHaveLength(2);
    expect(mappings.every((m) => m.pendingOp === 'push' && m.breezeOrigin)).toBe(true);
    expect(new Set(mappings.map((m) => m.id))).toEqual(new Set(first));
  });

  // -------------------------------------------------------------------------
  // Database constraints
  // -------------------------------------------------------------------------

  runDb('the pending_op CHECK rejects a value the workers could not route', async () => {
    const { fx, invoiceId } = await seedPushable();
    await withSystemDbAccessContext(() => recordPayment(
      invoiceId, { amount: 40, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
    ));
    const mappingId = (await loadOnePaymentMapping(fx)).id;

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() => db.execute(sql`
        UPDATE accounting_entity_mappings SET pending_op = 'sideways' WHERE id = ${mappingId}
      `));
    } catch (error) {
      caught = error;
    }

    expect(sqlCause(caught).code).toBe('23514');
    expect(sqlCause(caught).message).toMatch(/accounting_entity_mappings_pending_op_chk/);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ pendingOp: 'push' });
  });

  runDb('a cross-partner payment mapping is refused by the ownership trigger, by RLS and by the connection FK', async () => {
    const a = await seedPushable();
    const b = await seedPushable();
    const { paymentId: paymentA } = await recordAndPush(a.fx, a.invoiceId);
    const recordedB = await withSystemDbAccessContext(() => recordPayment(
      b.invoiceId, { amount: 25, method: 'cash', receivedAt: '2026-09-02' }, b.fx.actor,
    ));
    const paymentB = recordedB.audit.paymentId;

    // (1) Partner B claims partner A's payment under its OWN connection: the
    //     ownership trigger reads invoice_payments -> invoices.partner_id.
    let trigger: unknown;
    try {
      await withDbAccessContext(partnerContext(b.fx.partnerId, [b.fx.orgId]), () => db.execute(sql`
        INSERT INTO accounting_entity_mappings (
          integration_id, partner_id, breeze_entity_type, breeze_entity_id,
          remote_entity_type, remote_entity_id, link_status, sync_status
        ) VALUES (
          ${b.fx.conn.id}, ${b.fx.partnerId}, 'payment', ${paymentA},
          'Payment', '999/145', 'confirmed', 'synced'
        )
      `));
    } catch (error) {
      trigger = error;
    }
    expect(sqlCause(trigger).code).toBe('23514');
    expect(sqlCause(trigger).message).toMatch(/does not belong to partner/i);

    // (2) The SAME forge stamped for partner A. It must reach RLS's WITH CHECK
    //     to prove the partner axis, and the guard trigger above is in the way:
    //     the trigger's own SELECT runs under the CALLER's RLS, so a payment the
    //     caller cannot see reads as "does not belong to partner" and raises
    //     23514 before the WITH CHECK is ever evaluated. The context here is
    //     therefore the org-scoped-token shape this repo documents — org READ
    //     access to A's org, but a partner allowlist that does NOT contain A —
    //     which satisfies the trigger and leaves RLS as the operative control.
    let rls: unknown;
    try {
      await withDbAccessContext(partnerContext(b.fx.partnerId, [a.fx.orgId]), () => db.execute(sql`
        INSERT INTO accounting_entity_mappings (
          integration_id, partner_id, breeze_entity_type, breeze_entity_id,
          remote_entity_type, remote_entity_id, link_status, sync_status
        ) VALUES (
          ${a.fx.conn.id}, ${a.fx.partnerId}, 'payment', ${paymentA},
          'Payment', '998/145', 'confirmed', 'synced'
        )
      `));
    } catch (error) {
      rls = error;
    }
    expect(sqlCause(rls).code).toBe('42501');
    expect(sqlCause(rls).message).toMatch(/row-level security/i);

    // (3) Partner B's own payment, but hung off partner A's CONNECTION — the
    //     composite (integration_id, partner_id) FK is the last line.
    let fk: unknown;
    try {
      await withDbAccessContext(partnerContext(b.fx.partnerId, [b.fx.orgId]), () => db.execute(sql`
        INSERT INTO accounting_entity_mappings (
          integration_id, partner_id, breeze_entity_type, breeze_entity_id,
          remote_entity_type, remote_entity_id, link_status, sync_status
        ) VALUES (
          ${a.fx.conn.id}, ${b.fx.partnerId}, 'payment', ${paymentB},
          'Payment', '997/145', 'confirmed', 'synced'
        )
      `));
    } catch (error) {
      fk = error;
    }
    expect(sqlCause(fk).code).toBe('23503');
    expect(sqlCause(fk).message).toMatch(/accounting_entity_mappings_connection_partner_fk/);

    // (4) And the read axis: partner B cannot even SEE partner A's mapping, so
    //     a partner-scoped UPDATE against it is a zero-row no-op, never a write.
    const visibleToB = await withDbAccessContext(partnerContext(b.fx.partnerId, [b.fx.orgId]), () => db
      .select({ id: accountingEntityMappings.id })
      .from(accountingEntityMappings)
      .where(eq(accountingEntityMappings.partnerId, a.fx.partnerId)));
    expect(visibleToB).toEqual([]);

    // Nothing forged landed; A still holds exactly its own pushed mapping.
    expect((await loadPaymentMappings(a.fx)).map((m) => m.remoteEntityId)).toEqual(['181/145']);
    expect((await loadPaymentMappings(b.fx)).map((m) => m.remoteEntityId)).toEqual([null]);
  });

  // -------------------------------------------------------------------------
  // The Task-1 backfill
  // -------------------------------------------------------------------------

  runDb('the breeze_origin backfill only lands under breeze.scope=system', async () => {
    // The #-noted managed-Postgres failure mode: the migration role is not a
    // superuser, accounting_entity_mappings is ENABLE + FORCE RLS, so an
    // unscoped UPDATE matches ZERO rows and reports success. CI's superuser
    // masks it — running the statement as `breeze_app` is the only way to see it.
    const migrationText = readFileSync(MIGRATION_FILE, 'utf8');
    const scopedStart = migrationText.indexOf("SELECT set_config('breeze.scope', 'system', true);");
    const doStart = migrationText.indexOf('DO $$\nDECLARE');
    expect(scopedStart).toBeGreaterThan(-1);
    expect(doStart).toBeGreaterThan(scopedStart);
    const scopedBackfill = migrationText.slice(scopedStart);
    const unscopedBackfill = migrationText.slice(doStart);

    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx);
    // Both rows start `breeze_origin = false` — the column default, i.e. the
    // pre-migration state of every row that already existed.
    await withSystemDbAccessContext(() => db.insert(accountingEntityMappings).values({
      integrationId: fx.conn.id, partnerId: fx.partnerId,
      breezeEntityType: 'invoice', breezeEntityId: invoiceId,
      remoteEntityType: 'Invoice', remoteEntityId: '145',
      linkStatus: 'confirmed', syncStatus: 'synced', breezeOrigin: false,
    }).returning({ id: accountingEntityMappings.id }));
    const [pulledPayment] = await withSystemDbAccessContext(() => db.insert(invoicePayments).values({
      invoiceId, orgId: fx.orgId, amount: '10.00', method: 'cash',
      receivedAt: '2026-09-02', recordedBy: null, note: 'Pulled from QuickBooks',
    }).returning({ id: invoicePayments.id }));
    await withSystemDbAccessContext(() => db.insert(accountingEntityMappings).values({
      integrationId: fx.conn.id, partnerId: fx.partnerId,
      breezeEntityType: 'payment', breezeEntityId: pulledPayment!.id,
      remoteEntityType: 'Payment', remoteEntityId: '900/145',
      linkStatus: 'confirmed', syncStatus: 'synced', breezeOrigin: false,
    }).returning({ id: accountingEntityMappings.id }));

    const originOf = async (type: 'invoice' | 'payment') => {
      const [row] = await withSystemDbAccessContext(() => db
        .select({ breezeOrigin: accountingEntityMappings.breezeOrigin })
        .from(accountingEntityMappings)
        .where(and(
          eq(accountingEntityMappings.integrationId, fx.conn.id),
          eq(accountingEntityMappings.breezeEntityType, type),
        ))
        .limit(1));
      return row!.breezeOrigin;
    };

    const asAppRole = async (statements: string) => {
      await getTestDb().transaction(async (tx) => {
        await tx.execute(sql.raw('SET LOCAL ROLE breeze_app'));
        await tx.execute(sql.raw(statements));
      });
    };

    // NEGATIVE CONTROL: the same DO block, no scope. Silently updates nothing.
    await asAppRole(unscopedBackfill);
    expect(await originOf('invoice')).toBe(false);

    // The migration as shipped.
    await asAppRole(scopedBackfill);
    expect(await originOf('invoice')).toBe(true);
    // Payment rows that predate the push came from the Phase D pull and stay
    // QuickBooks-origin — which is what keeps voidPayment refusing them.
    expect(await originOf('payment')).toBe(false);
  });
});
