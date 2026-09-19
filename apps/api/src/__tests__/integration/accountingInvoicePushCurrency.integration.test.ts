/**
 * Real-DB proof for the Phase-C invoice-push currency contract (multi-currency
 * §11, bug B8), UPDATED by #4498 to invert the "no trace" half of that
 * contract for `currency_mismatch` specifically. The trailing contract
 * comment in `accountingCurrency.ts:143-186` still describes the ORIGINAL
 * shape (no mapping row for either currency failure) — that comment is
 * stale for `currency_mismatch` as of this change; `home_currency_unknown`
 * is unaffected and still persists nothing (see #4498's own scoping: it is a
 * rarer connection-setup problem, not this issue's complaint):
 *
 *  - EUR invoice + USD-home connection: `pushInvoiceToAccounting` throws
 *    `ACCOUNTING_INVOICE_CURRENCY_MISMATCH` (typed here as the coordinator's
 *    `currency_mismatch`), NO QBO request is made, and the invoice's
 *    `accounting_entity_mappings` row now lands `sync_status:'error'` with
 *    no `remoteEntityId` and both currencies named in `lastError` — so the
 *    invoice detail card has something to show instead of nothing (#4498).
 *  - NULL home currency: `home_currency_unknown`, NO QBO request, and NO
 *    mapping row persisted — unchanged from before #4498.
 *  - USD invoice against a USD-home connection with the provider transport
 *    mocked at the `fetch` boundary: the invoice's mapping row lands
 *    `sync_status:'synced'`, and a second push against the now-existing
 *    mapping row UPDATEs in place rather than inserting a second row — proven
 *    against the real `accounting_entity_mappings_breeze_uniq` unique index,
 *    not just asserted in prose.
 *
 * A memoized fixture would be stale here: setup.ts truncates tenant tables
 * between tests, so every test seeds its own partner/org/connection/invoice.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  accountingConnections,
  accountingEntityMappings,
  invoiceLines,
  invoices,
  type AccountingEntityMapping,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import { pushInvoiceToAccounting, voidInvoiceInAccounting } from '../../services/accounting/accountingInvoicePush';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string, orgId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/** Tokens far from expiry so `resolveConnectionAndToken` never refreshes (never calls `fetch`). */
const FAR_FUTURE_ACCESS = new Date(Date.now() + 60 * 60 * 1000);
const FAR_FUTURE_REFRESH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

interface Fixture {
  partnerId: string;
  orgId: string;
  connectionId: string;
}

async function seedFixture(opts: {
  homeCurrency: string | null;
  multiCurrencyEnabled?: boolean | null;
}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, currencyCode: 'USD' });
    const conn = await upsertConnection(db, partner.id, 'quickbooks', {
      realmId: 'realm-invoice-push',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      accessTokenExpiresAt: FAR_FUTURE_ACCESS,
      refreshTokenExpiresAt: FAR_FUTURE_REFRESH,
      environment: 'sandbox',
      homeCurrency: opts.homeCurrency,
    });
    if (opts.multiCurrencyEnabled !== undefined) {
      await db
        .update(accountingConnections)
        .set({ multiCurrencyEnabled: opts.multiCurrencyEnabled })
        .where(eq(accountingConnections.id, conn.id));
    }
    return { partnerId: partner.id, orgId: org.id, connectionId: conn.id };
  });
}

/** Seeds a pushable (issued, non-void) invoice with one line, directly against the schema. */
async function seedInvoice(fx: Fixture, opts: {
  currencyCode: string;
  subtotal?: string;
  taxTotal?: string;
  total?: string;
}): Promise<string> {
  const subtotal = opts.subtotal ?? '100.00';
  const taxTotal = opts.taxTotal ?? '0.00';
  const total = opts.total ?? subtotal;
  return withSystemDbAccessContext(async () => {
    const [inv] = await db
      .insert(invoices)
      .values({
        partnerId: fx.partnerId,
        orgId: fx.orgId,
        invoiceNumber: `INV-TEST-${Math.random().toString(36).slice(2, 8)}`,
        status: 'sent',
        currencyCode: opts.currencyCode,
        issueDate: new Date().toISOString().slice(0, 10),
        subtotal,
        taxTotal,
        total,
      })
      .returning({ id: invoices.id });
    if (!inv) throw new Error('failed to seed invoice fixture');
    await db.insert(invoiceLines).values({
      invoiceId: inv.id,
      orgId: fx.orgId,
      sourceType: 'manual',
      name: 'Ad-hoc line',
      description: 'Ad-hoc line',
      quantity: '1.00',
      unitPrice: subtotal,
      taxable: false,
      lineTotal: subtotal,
      sortOrder: 0,
    });
    return inv.id;
  });
}

/** Confirmed + already-synced org mapping so the happy-path push skips the nested customer sync entirely. */
async function seedSyncedOrgMapping(fx: Fixture, remoteCurrencyCode: string | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.insert(accountingEntityMappings).values({
      integrationId: fx.connectionId,
      partnerId: fx.partnerId,
      breezeEntityType: 'org',
      breezeEntityId: fx.orgId,
      remoteEntityType: 'Customer',
      remoteEntityId: 'qbo-customer-1',
      remoteSyncToken: '0',
      remoteCurrencyCode,
      linkStatus: 'confirmed',
      syncStatus: 'synced',
    });
  });
}

async function loadInvoiceMappingRows(fx: Fixture, invoiceId: string): Promise<AccountingEntityMapping[]> {
  return withSystemDbAccessContext(() =>
    db
      .select()
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.integrationId, fx.connectionId),
        eq(accountingEntityMappings.breezeEntityType, 'invoice'),
        eq(accountingEntityMappings.breezeEntityId, invoiceId),
      )) as unknown as Promise<AccountingEntityMapping[]>
  );
}

function jsonFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('pushInvoiceToAccounting currency contract — real Postgres', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  runDb('EUR invoice against a USD-home connection: currency_mismatch, no QBO request, error-only mapping row persisted with both currencies named (#4498)', async () => {
    const fx = await seedFixture({ homeCurrency: 'USD', multiCurrencyEnabled: false });
    const invoiceId = await seedInvoice(fx, { currencyCode: 'EUR' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      pushInvoiceToAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn))
    ).rejects.toMatchObject({ code: 'currency_mismatch', status: 409 });

    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await loadInvoiceMappingRows(fx, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      syncStatus: 'error',
      remoteEntityId: null,
      linkStatus: 'create_new',
    });
    expect(rows[0]!.lastError).toContain('EUR');
    expect(rows[0]!.lastError).toContain('USD');

    // Retrying the same push re-throws the same terminal error and merely
    // UPDATEs the existing row in place (idempotent) rather than inserting a
    // second one — proves a manual retry loop cannot spin up duplicate rows
    // or duplicate QuickBooks calls against a mapping that can never succeed.
    const fetchSpy2 = vi.spyOn(globalThis, 'fetch');
    await expect(
      pushInvoiceToAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn))
    ).rejects.toMatchObject({ code: 'currency_mismatch', status: 409 });
    expect(fetchSpy2).not.toHaveBeenCalled();
    const rowsAfterRetry = await loadInvoiceMappingRows(fx, invoiceId);
    expect(rowsAfterRetry).toHaveLength(1);
    expect(rowsAfterRetry[0]!.id).toBe(rows[0]!.id);

    // The mapping row this currency guard just persisted must not trip
    // `voidInvoiceInAccounting`'s in-flight-marker assumption: that push
    // never reached QuickBooks (syncStatus:'error', no remoteEntityId), so a
    // void must no-op rather than misreading it as a mid-flight `pending`
    // push (which would throw the non-terminal `sync_in_progress`) or trying
    // to void a QuickBooks invoice that was never created.
    await expect(
      voidInvoiceInAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn))
    ).resolves.toBeUndefined();
    const rowsAfterVoid = await loadInvoiceMappingRows(fx, invoiceId);
    expect(rowsAfterVoid).toHaveLength(1);
    expect(rowsAfterVoid[0]).toMatchObject({ syncStatus: 'error', remoteEntityId: null });
  });

  runDb('NULL home currency: home_currency_unknown, no QBO request, no mapping row persisted', async () => {
    const fx = await seedFixture({ homeCurrency: null });
    const invoiceId = await seedInvoice(fx, { currencyCode: 'USD' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      pushInvoiceToAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn))
    ).rejects.toMatchObject({ code: 'home_currency_unknown', status: 409 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await loadInvoiceMappingRows(fx, invoiceId)).toEqual([]);
  });

  runDb('USD invoice against a USD-home connection with a mocked provider: mapping synced, and a second push is idempotent under the unique constraint', async () => {
    const fx = await seedFixture({ homeCurrency: 'USD', multiCurrencyEnabled: false });
    const invoiceId = await seedInvoice(fx, {
      currencyCode: 'USD',
      subtotal: '100.00',
      taxTotal: '0.00',
      total: '100.00',
    });
    await seedSyncedOrgMapping(fx, 'USD');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonFetchResponse({
        Invoice: { Id: 'qbo-invoice-1', SyncToken: '0', DocNumber: 'INV-TEST-QBO', TotalAmt: 100 },
      })
    );

    const first = await pushInvoiceToAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn));

    expect(first.syncStatus).toBe('synced');
    expect(first.taxVarianceCents).toBeNull();
    expect(first.remoteEntityId).toBe('qbo-invoice-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const afterFirst = await loadInvoiceMappingRows(fx, invoiceId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      remoteEntityId: 'qbo-invoice-1',
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      lastError: null,
    });
    const mappingRowId = afterFirst[0]!.id;

    // Second push: the coordinator finds the existing mapping row and re-sends
    // via the sparse-update wire path (mapping present -> `sparse:true, Id,
    // SyncToken` per quickbooksProvider.pushInvoice), not a second INSERT.
    const second = await pushInvoiceToAccounting(invoiceId, fx.partnerId, (fn) => withDbAccessContext(partnerCtx(fx.partnerId, fx.orgId), fn));

    expect(second.syncStatus).toBe('synced');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const afterSecond = await loadInvoiceMappingRows(fx, invoiceId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(mappingRowId);

    // The unique index this idempotency relies on: proves the constraint the
    // coordinator's find-then-upsert logic is protecting against actually
    // exists on the live schema, not just in the migration file.
    const constraintRows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'accounting_entity_mappings'
          AND indexname = 'accounting_entity_mappings_breeze_uniq'
      `)
    );
    expect((constraintRows as unknown as Array<{ indexname: string }>).length).toBe(1);
  });
});
