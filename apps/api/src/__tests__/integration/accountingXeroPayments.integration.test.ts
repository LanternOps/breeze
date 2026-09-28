/**
 * Real-DB proof of Xero payment pull + push + delete once `paymentPull` and
 * `paymentPush` flip true (Xero W05c). Xero's HTTP API is mocked at the fetch
 * boundary; everything else — the coordinators' phases, the mapping row, RLS
 * under a partner/system context, the unique index — is real. `setup.ts`
 * truncates tenant tables between tests, so every test seeds its own fixture.
 *
 * Fixtures/helpers are modelled on `accountingPaymentPush.integration.test.ts`
 * (copied, not imported across test files) but connect Xero instead of
 * QuickBooks and drive the real Xero provider's HTTP calls through a fetch
 * router keyed on "METHOD path", instead of stubbing `createPayment` /
 * `deletePayment` directly.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  accountingConnections,
  accountingEntityMappings,
  invoicePayments,
  invoices,
  type AccountingEntityMapping,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';
import { hmacFingerprint } from '../../services/secretCrypto';
import { providerSupports } from '../../services/accounting/providerRegistry';
import { routeWebhookToConnection } from '../../services/accounting/accountingWebhookRouting';
import {
  deletePaymentInAccounting,
  pushPaymentToAccounting,
} from '../../services/accounting/accountingPaymentPush';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';

vi.mock('../../jobs/accountingReconcileWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/accountingReconcileWorker')>()),
  enqueueAccountingReconcile: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../jobs/accountingSyncWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/accountingSyncWorker')>()),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));

import { enqueueAccountingReconcile, processReconcileConnectionJob } from '../../jobs/accountingReconcileWorker';
import { recordPayment, voidPayment } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/** Every coordinator is ENTERED with no ambient context — exactly how the Task-4 workers call them. */
const systemRunner: DbContextRunner = (fn) => withSystemDbAccessContext(fn, 'accountingXeroPayments.test');

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  conn: AccountingConnection;
  actor: { userId: string; partnerId: string; accessibleOrgIds: string[] };
}

// A FRESH tenant per fixture: (provider, realm_id_fingerprint) is unique across
// partners, so a shared tenant id would make every later seed a tenant-held 409.
const XI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';     // the pushed invoice's Xero InvoiceID (unique per connection only)
const XC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';     // the org's Xero ContactID
const XP = '99999999-8888-7777-6666-555555555555';     // a Xero PaymentID

type XeroFixture = Fixture & { tenantId: string };

async function seedFixture(opts: { pushPayments?: boolean; pullPayments?: boolean; paymentAccount?: string | null } = {}): Promise<XeroFixture> {
  const paymentAccount = opts.paymentAccount === undefined ? 'bank-acc-1' : opts.paymentAccount;
  const tenantId = randomUUID();
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'GBP' });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const conn = await upsertConnection(db, partner.id, 'xero', {
      realmId: tenantId,
      accessToken: 'live-access-token', refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS, refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'production', homeCurrency: 'GBP', pushMode: 'auto',
      pushPayments: opts.pushPayments ?? true, pullPayments: opts.pullPayments ?? true,
    });
    await db.update(accountingConnections)
      // `pushPaymentsSince` backdated to the epoch: it is stamped from Node's
      // clock (upsertConnection) but compared against invoice_payments.created_at
      // (Postgres's clock, defaultNow()) with no margin — see the sibling
      // accountingXeroInvoicePush.integration.test.ts fix for the cross-clock race.
      .set({ defaultPaymentAccountRef: paymentAccount, pushPaymentsSince: new Date(0) })
      .where(eq(accountingConnections.id, conn.id));
    return {
      partnerId: partner.id, orgId: org.id, userId: user.id, tenantId,
      conn: { ...conn, defaultPaymentAccountRef: paymentAccount },
      actor: { userId: user.id, partnerId: partner.id, accessibleOrgIds: [org.id] },
    };
  });
}

/** An issued, pushable invoice — the coordinators read only the header. */
async function seedInvoice(fx: Fixture, opts: { currencyCode?: string; total?: string } = {}): Promise<string> {
  const total = opts.total ?? '150.00';
  return withSystemDbAccessContext(async () => {
    const [inv] = await db
      .insert(invoices)
      .values({
        partnerId: fx.partnerId,
        orgId: fx.orgId,
        invoiceNumber: `INV-XPAY-${Math.random().toString(36).slice(2, 8)}`,
        status: 'sent',
        currencyCode: opts.currencyCode ?? 'GBP',
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
async function seedInvoiceMapping(fx: Fixture, invoiceId: string, remoteInvoiceId = XI): Promise<string> {
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
async function seedOrgMapping(fx: Fixture, remoteCustomerId = XC): Promise<string> {
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

/** Records a Breeze payment; auto push mode + paymentPush make recordPayment create the pending mapping row (enqueue mocked). */
async function recordOnly(fx: XeroFixture, invoiceId: string, amount = 50) {
  const recorded = await withSystemDbAccessContext(() => recordPayment(
    invoiceId, { amount, method: 'check', receivedAt: '2026-09-02' }, fx.actor,
  ));
  const mapping = await loadOnePaymentMapping(fx);
  expect(mapping).toMatchObject({ pendingOp: 'push', remoteEntityId: null });
  return { mappingId: mapping.id, paymentId: recorded.audit.paymentId };
}

// ---------------------------------------------------------------------------
// Xero fetch boundary
// ---------------------------------------------------------------------------

/** A route answers with a Response (cloned per call, so it can be reused) or a
 * function (to throw, or to vary). An array is consumed one entry per call. */
type Handler = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);
function xeroFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/api.xro/2.0/', '')}`;
    calls.push(`${key}${url.search}`);
    const route = routes[key];
    const handler = Array.isArray(route) ? route.shift() : route;
    if (!handler) throw new Error(`unexpected Xero call ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler.clone();
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const forbidden = (body: unknown = {}) => new Response(JSON.stringify(body), {
  status: 403,
  headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="insufficient_scope"' },
});
const msDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;
const xeroPayment = (over: Record<string, unknown> = {}) => ({
  PaymentID: XP, PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Date: msDate('2026-09-20T00:00:00Z'),
  Amount: 50, Reference: 'CHQ 1001', IsReconciled: false, UpdatedDateUTC: msDate(new Date().toISOString()),
  Invoice: { InvoiceID: XI, Type: 'ACCREC', CurrencyCode: 'GBP' }, ...over,
});

describe('Xero payments — real Postgres (W05)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  runDb('capabilities: Xero declares both payment directions', () => {
    expect(providerSupports('xero', 'paymentPull')).toBe(true);
    expect(providerSupports('xero', 'paymentPush')).toBe(true);
  });

  runDb('the webhook tenant id finds the connection through the stored fingerprint (system scope) and enqueues delayed', async () => {
    const fx = await seedFixture();
    await expect(runOutsideDbContext(() => routeWebhookToConnection('xero', hmacFingerprint(fx.tenantId), { delayMs: 30_000 })))
      .resolves.toBe('enqueued');
    expect(enqueueAccountingReconcile).toHaveBeenCalledWith(fx.conn.id, fx.partnerId, 'webhook', { delayMs: 30_000 });
  });

  runDb('pull: a Xero-origin payment is applied once; a replayed window changes nothing; its deletion reverses it', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP', total: '150.00' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    const job = { type: 'reconcile-connection' as const, connectionId: fx.conn.id, partnerId: fx.partnerId, trigger: 'manual' as const };

    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment()] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(1);

    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment()] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(1);           // replayed, not doubled

    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [xeroPayment({ Status: 'DELETED', UpdatedDateUTC: msDate(new Date(Date.now() + 1000).toISOString()) })] }), 'GET Invoices': json({ Invoices: [] }) });
    await processReconcileConnectionJob(job);
    expect(await loadPayments(invoiceId)).toHaveLength(0);           // reversed
  });

  runDb('push: a lost create response is adopted, never duplicated (one PUT in all)', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    const ours = () => json({ Payments: [xeroPayment({ Reference: `Breeze payment ${paymentId}` })] });
    const calls = xeroFetch({
      'GET Payments': [() => json({ Payments: [] }), ours],
      'PUT Payments': () => { throw new TypeError('fetch failed'); },   // response lost
    });

    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('pushed');

    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
    expect((await loadOnePaymentMapping(fx)).remoteEntityId).toBe(`${XP}/${XI}`);
  });

  runDb('pull adopts our own lost create; the owed push then has nothing to do', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({
      'GET Payments': json({ Payments: [xeroPayment({ Reference: `Breeze payment ${paymentId} | CHQ 1001` })] }),
      'GET Invoices': json({ Invoices: [] }),
    });
    await processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: fx.conn.id, partnerId: fx.partnerId, trigger: 'manual' });
    expect(await loadPayments(invoiceId)).toHaveLength(1);           // no mirrored second receipt
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ remoteEntityId: `${XP}/${XI}`, pendingOp: null });

    vi.restoreAllMocks();
    const calls = xeroFetch({});
    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('nothing_owed');
    expect(calls).toEqual([]);
  });

  runDb('no bank account: the push parks with no Xero call and no attempt; choosing one lets the next attempt push', async () => {
    const fx = await seedFixture({ paymentAccount: null });
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId } = await recordOnly(fx, invoiceId);
    const none = xeroFetch({});

    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).rejects.toMatchObject({ code: 'push_settings_incomplete' });
    expect(none).toEqual([]);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({ pendingOp: 'push', syncAttempts: 0, claimedAt: null });

    await withSystemDbAccessContext(() => db.update(accountingConnections).set({ defaultPaymentAccountRef: 'bank-acc-1' }).where(eq(accountingConnections.id, fx.conn.id)));
    vi.restoreAllMocks();
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await expect(pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('pushed');
  });

  runDb('a Breeze void deletes the Xero payment (read, then POST DELETED) and clears the mapping', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner);
    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));

    vi.restoreAllMocks();
    const calls = xeroFetch({
      [`GET Payments/${XP}`]: json({ Payments: [xeroPayment()] }),
      [`POST Payments/${XP}`]: json({ Payments: [xeroPayment({ Status: 'DELETED' })] }),
    });
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('deleted');
    expect(calls).toEqual([`GET Payments/${XP}`, `POST Payments/${XP}`]);
    expect(await loadPaymentMappings(fx)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Addendum B — W05b rulings 5 and 6.
  // -------------------------------------------------------------------------

  runDb('ruling 5: a reconciled payment refuses the delete with no write; once the bookkeeper deletes it in Xero, the mapping drops (not removed_remotely)', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner);
    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));

    vi.restoreAllMocks();
    const reconciledCalls = xeroFetch({
      [`GET Payments/${XP}`]: json({ Payments: [xeroPayment({ IsReconciled: true })] }),
    });
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).rejects.toMatchObject({ code: 'remote_locked' });
    expect(reconciledCalls).toEqual([`GET Payments/${XP}`]);          // no POST
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: `${XP}/${XI}`, pendingOp: null, claimedAt: null,
    });
    expect((await loadOnePaymentMapping(fx)).lastError).toMatch(/reconciled/i);

    // The bookkeeper deletes it in Xero; the next reconcile observes the
    // deletion. The Breeze payment row is already gone (voided above), so the
    // mapping is DROPPED, not marked removed_remotely.
    vi.restoreAllMocks();
    xeroFetch({
      'GET Payments': json({ Payments: [xeroPayment({
        Status: 'DELETED', Reference: `Breeze payment ${paymentId}`, UpdatedDateUTC: msDate(new Date(Date.now() + 1000).toISOString()),
      })] }),
      'GET Invoices': json({ Invoices: [] }),
    });
    await processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: fx.conn.id, partnerId: fx.partnerId, trigger: 'manual' });
    expect(await loadPaymentMappings(fx)).toHaveLength(0);
  });

  runDb('ruling 6: a scope-refused delete parks (pendingOp kept, no attempt counted); it heals after reconnect', async () => {
    const fx = await seedFixture();
    const invoiceId = await seedInvoice(fx, { currencyCode: 'GBP' });
    await seedInvoiceMapping(fx, invoiceId, XI);
    await seedOrgMapping(fx, XC);
    const { mappingId, paymentId } = await recordOnly(fx, invoiceId);
    xeroFetch({ 'GET Payments': json({ Payments: [] }), 'PUT Payments': json({ Payments: [xeroPayment()] }) });
    await pushPaymentToAccounting(mappingId, fx.partnerId, systemRunner);
    await withSystemDbAccessContext(() => voidPayment(paymentId, fx.actor));

    vi.restoreAllMocks();
    const scopeRefusedCalls = xeroFetch({ [`GET Payments/${XP}`]: forbidden() });
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).rejects.toMatchObject({ code: 'provider_permission' });
    // Per-sweep cost of a parked scope-refused delete (lab wants this number):
    // 1 call — the GET read that deleteXeroPayment issues before the refusal;
    // no POST is ever attempted.
    expect(scopeRefusedCalls).toHaveLength(1);
    expect(await loadOnePaymentMapping(fx)).toMatchObject({
      remoteEntityId: `${XP}/${XI}`, pendingOp: 'delete', syncAttempts: 0, claimedAt: null,
    });

    // Reconnect (a normal Xero answers again): the delete goes through.
    vi.restoreAllMocks();
    xeroFetch({
      [`GET Payments/${XP}`]: json({ Payments: [xeroPayment()] }),
      [`POST Payments/${XP}`]: json({ Payments: [xeroPayment({ Status: 'DELETED' })] }),
    });
    await expect(deletePaymentInAccounting(mappingId, fx.partnerId, systemRunner)).resolves.toBe('deleted');
    expect(await loadPaymentMappings(fx)).toHaveLength(0);
  });
});
