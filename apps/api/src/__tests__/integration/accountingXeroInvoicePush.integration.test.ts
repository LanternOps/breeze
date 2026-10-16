/**
 * Real-DB proof of Xero invoice push and void (Xero W04). Xero's HTTP API is
 * mocked at the fetch boundary; everything else — the coordinator's phases,
 * the mapping row, RLS under a partner context, the unique index — is real.
 * setup.ts truncates tenant tables between tests, so every test seeds its own.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings, invoiceLines, invoicePayments, invoices } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import { pushInvoiceToAccounting, voidInvoiceInAccounting } from '../../services/accounting/accountingInvoicePush';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Fixture { partnerId: string; orgId: string; connectionId: string }

function partnerCtx(fx: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
}
const runner = (fx: Fixture) => <T>(fn: () => Promise<T>) => withDbAccessContext(partnerCtx(fx), fn);

async function seed(settings: { exempt?: string | null } = {}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'GBP' });
    const conn = await upsertConnection(db, partner.id, 'xero', {
      realmId: 'ten-A', accessToken: 'live-access-token', refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS, refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'production', homeCurrency: 'GBP',
    });
    await db.update(accountingConnections).set({
      defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2',
      defaultExemptTaxCodeRef: settings.exempt === undefined ? 'EXEMPTOUTPUT' : settings.exempt,
    }).where(eq(accountingConnections.id, conn.id));
    await db.insert(accountingEntityMappings).values({
      integrationId: conn.id, partnerId: partner.id, breezeEntityType: 'org', breezeEntityId: org.id,
      remoteEntityType: 'Customer', remoteEntityId: 'xc-1', remoteSyncToken: null, remoteCurrencyCode: 'GBP',
      linkStatus: 'confirmed', syncStatus: 'synced',
    });
    return { partnerId: partner.id, orgId: org.id, connectionId: conn.id };
  });
}

async function seedInvoice(fx: Fixture, opts: {
  taxable: boolean; taxTotal: string;
  invoice?: Partial<typeof invoices.$inferInsert>; line?: Partial<typeof invoiceLines.$inferInsert>;
}): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const total = (Number('100.00') + Number(opts.taxTotal)).toFixed(2);
    const [inv] = await db.insert(invoices).values({
      partnerId: fx.partnerId, orgId: fx.orgId, invoiceNumber: 'INV-2026-0001', status: 'sent', currencyCode: 'GBP',
      issueDate: '2026-09-01', dueDate: '2026-10-01', subtotal: '100.00', taxTotal: opts.taxTotal, total,
      ...opts.invoice,
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: fx.orgId, sourceType: 'manual', name: 'Managed support', description: 'Managed support',
      quantity: '1.00', unitPrice: '100.00', taxable: opts.taxable, lineTotal: '100.00', sortOrder: 0,
      ...opts.line,
    });
    return inv!.id;
  });
}

async function invoiceMapping(fx: Fixture, invoiceId: string) {
  const rows = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings).where(and(
    eq(accountingEntityMappings.integrationId, fx.connectionId),
    eq(accountingEntityMappings.breezeEntityType, 'invoice'),
    eq(accountingEntityMappings.breezeEntityId, invoiceId),
  )));
  return rows;
}

const remote = (invoiceId: string, over: Record<string, unknown> = {}) => ({
  InvoiceID: 'xi-1', Type: 'ACCREC', InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${invoiceId}`, Status: 'AUTHORISED',
  Contact: { ContactID: 'xc-1' }, CurrencyCode: 'GBP', SubTotal: 100, TotalTax: 20, Total: 120, AmountPaid: 0, AmountCredited: 0,
  UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});

describe('Xero invoice push and void — real Postgres (Xero W04)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // #8605 W04: the work date read from a real `invoice_lines.work_date` row
  // reaches Xero as description text only when the invoice's FROZEN showDate
  // is on; with it off the line text is exactly what was sent before W04.
  const timeLine = {
    sourceType: 'time_entry' as const, name: null, description: 'Rebuilt the print queue',
    workedMinutes: 30, workDate: '2026-09-16',
  };
  const pushedDescription = async (fx: Fixture, invoiceId: string) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx));
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === 'PUT')!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    return (body.Invoices?.[0] ?? body).LineItems[0].Description as string;
  };

  runDb('frozen showDate on: the work date is appended to the Xero line text (#8605)', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00', invoice: { lineShowDate: true }, line: timeLine });
    expect(await pushedDescription(fx, invoiceId)).toBe('Rebuilt the print queue — 0.50 h worked, 1.00 h billed — Sep 16, 2026');
  });

  runDb('frozen showDate off: a dated line pushes the pre-W04 text (#8605)', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00', invoice: { lineShowDate: false }, line: timeLine });
    expect(await pushedDescription(fx, invoiceId)).toBe('Rebuilt the print queue — 0.50 h worked, 1.00 h billed');
  });

  runDb('pushes an issued invoice: one lookup, one PUT; the mapping is synced with the Xero id and ISO version', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));

    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1', syncStatus: 'synced' });

    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(['GET', 'PUT']);
    const rows = await invoiceMapping(fx, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      remoteEntityType: 'Invoice', remoteEntityId: 'xi-1', remoteSyncToken: new Date(1790000000000).toISOString(),
      remoteDocNumber: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
    });
  });

  runDb('a lost create response is adopted in the same push; a later push resends by POST, never a second PUT', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1' });

    vi.restoreAllMocks();
    const second = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).resolves.toMatchObject({ remoteEntityId: 'xi-1', syncStatus: 'synced' });
    expect(second.mock.calls.map(([url, init]) => [(init as RequestInit).method, url])).toEqual([
      ['GET', 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4'],
      ['POST', 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true'],
    ]);
    expect(await invoiceMapping(fx, invoiceId)).toHaveLength(1);
  });

  runDb('a missing exempt tax rate refuses before any Xero call and persists the reason (Review Focus 4)', async () => {
    const fx = await seed({ exempt: null });
    const invoiceId = await seedInvoice(fx, { taxable: false, taxTotal: '0.00' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx))).rejects.toMatchObject({ code: 'push_settings_incomplete', status: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await invoiceMapping(fx, invoiceId)).toEqual([expect.objectContaining({
      syncStatus: 'error', remoteEntityId: null,
      lastError: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again',
    })]);
  });

  runDb('void: reads, voids, and stores the new remote version', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx));
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId, { Status: 'VOIDED', UpdatedDateUTC: '/Date(1790000100000+0000)/' })] }));
    await voidInvoiceInAccounting(invoiceId, fx.partnerId, runner(fx));

    expect((await invoiceMapping(fx, invoiceId))[0]).toMatchObject({ remoteSyncToken: new Date(1790000100000).toISOString(), syncStatus: 'synced' });
  });

  runDb('fans an existing payment out to a pending push mapping once paymentPush is live (Xero W05c, refinement 18)', async () => {
    const fx = await seed();
    const invoiceId = await seedInvoice(fx, { taxable: true, taxTotal: '20.00' });
    // The fan-out's horizon (`push_payments_since`, stamped by `upsertConnection`
    // to Node's clock at connection-insert time) is compared against
    // `invoice_payments.created_at` (Postgres's own clock, via `defaultNow()`).
    // Backdate it explicitly rather than rely on the payment insert below
    // landing "later": those are two different clock sources with no
    // guaranteed margin between them, which makes an un-backdated horizon a
    // race, not a fact (accountingPaymentPush.ts paymentIsWithinPushHorizon).
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ pushPaymentsSince: new Date(0) })
      .where(eq(accountingConnections.id, fx.connectionId)));
    // Copy the invoice_payments insert from accountingPaymentPush.integration.test.ts (its required
    // columns); one 50.00 manual payment on this invoice, received today.
    await withSystemDbAccessContext(() => db.insert(invoicePayments).values({
      invoiceId, orgId: fx.orgId, amount: '50.00', method: 'cash', receivedAt: new Date().toISOString().slice(0, 10),
    }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote(invoiceId)] }));
    await pushInvoiceToAccounting(invoiceId, fx.partnerId, runner(fx));

    const paymentRows = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings).where(and(
      eq(accountingEntityMappings.integrationId, fx.connectionId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
    )));
    expect(paymentRows).toEqual([expect.objectContaining({ pendingOp: 'push', remoteEntityId: null })]);
  });
});
