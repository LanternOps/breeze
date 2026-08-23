import './setup';
import { describe, it, expect } from 'vitest';

import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  partners, organizations, users, timeEntries, invoices, invoiceLines,
  quotes, quoteLines, contracts, contractLines,
} from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import * as quoteSvc from '../../services/quoteService';
import * as contractSvc from '../../services/contractService';
import { computeLineTotal } from '../../services/invoiceMath';
import { createCatalogItem, removeItemPrice, type CatalogActor } from '../../services/catalogService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
}

/** USD partner + EUR org (mixed on purpose — proves org/document stamps drive
 *  everything, never the partner). */
async function seedFixture(orgCurrency = 'EUR'): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `ChgCur ${suffix}`, slug: `chgcur-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `chgcur-org-${suffix}`, currencyCode: orgCurrency
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    return { partnerId, orgId, userId: u!.id };
  });
}

// The fixture always has a real user, so narrow userId to string — the same
// object then satisfies InvoiceActor, QuoteActor, and ContractActor (whose
// userId is non-nullable).
function actor(f: Fixture): InvoiceActor & { userId: string } {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

const manualQuoteLine = (name: string, unitPrice: number) => ({
  sourceType: 'manual' as const, name, description: null, quantity: 1, unitPrice,
  taxable: false, customerVisible: true, recurrence: 'one_time' as const, depositEligible: false,
});

describe.runIf(RUN)('changeQuoteCurrency (atomic clear-and-restamp, #3774)', () => {
  it('clearLines: true drops the lines, restamps JPY, and zeroes the totals', async () => {
    const f = await seedFixture(); // EUR org
    const result = await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      expect(q.currencyCode).toBe('EUR');
      await quoteSvc.addManualLine(q.id, manualQuoteLine('Setup', 500), actor(f));
      await quoteSvc.addManualLine(q.id, manualQuoteLine('Hardware', 250.5), actor(f));
      return quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'JPY', clearLines: true }, actor(f));
    });
    expect(result.currencyCode).toBe('JPY');
    expect(result.subtotal).toBe('0.00');
    expect(result.total).toBe('0.00');
    const lines = await withSystemDbAccessContext(() =>
      db.select({ id: quoteLines.id }).from(quoteLines).where(eq(quoteLines.quoteId, result.id)));
    expect(lines.length).toBe(0);
  });

  it('refuses without clearLines when monetary lines exist (CURRENCY_LOCKED 409)', async () => {
    const f = await seedFixture();
    await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      await quoteSvc.addManualLine(q.id, manualQuoteLine('Setup', 100), actor(f));
      await expect(
        quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'JPY', clearLines: false }, actor(f))
      ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
      // Nothing moved: still EUR, line intact.
      const [after] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      expect(after!.currencyCode).toBe('EUR');
      const lines = await db.select({ id: quoteLines.id }).from(quoteLines).where(eq(quoteLines.quoteId, q.id));
      expect(lines.length).toBe(1);
    });
  });

  it('is all-or-nothing: a failure after the line delete rolls the whole change back', async () => {
    const f = await seedFixture();
    await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      await quoteSvc.addManualLine(q.id, manualQuoteLine('Setup', 100), actor(f));
      // 'ZZZ' passes no Zod here (service called directly) and fails INSIDE the
      // transaction at the supported_currencies FK — which fires only on the
      // header UPDATE, i.e. AFTER the lines were deleted. The rollback must
      // restore them: a change-currency can never be observed half-applied.
      await expect(
        quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'ZZZ', clearLines: true }, actor(f))
      ).rejects.toThrow();
      const [after] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      expect(after!.currencyCode).toBe('EUR');
      const lines = await db.select({ id: quoteLines.id }).from(quoteLines).where(eq(quoteLines.quoteId, q.id));
      expect(lines.length).toBe(1);
    });
  });
});

describe.runIf(RUN)('changeInvoiceCurrency (atomic clear-and-restamp, #3774)', () => {
  it('clearLines: true drops the lines and restamps WITHOUT touching source billing status', async () => {
    const f = await seedFixture();
    // A time entry this draft gathered, since billed by ANOTHER invoice: the
    // clear must not release it back to not_billed (#3774 addendum — a draft
    // holds no billed claim, so it has nothing to release).
    const timeEntryId = await withSystemDbAccessContext(async () => {
      const now = new Date();
      const [te] = await db.insert(timeEntries).values({
        partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, startedAt: now, endedAt: now,
        durationMinutes: 60, description: 'Work', isBillable: true,
        hourlyRate: '100.00', billingStatus: 'billed', isApproved: true,
        currencyCode: 'EUR'
      }).returning({ id: timeEntries.id });
      return te!.id;
    });
    const inv = await withDbAccessContext(ctx(f), () =>
      invoiceSvc.createManualInvoice({ orgId: f.orgId }, actor(f)));
    expect(inv.currencyCode).toBe('EUR');
    await withSystemDbAccessContext(async () => {
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, orgId: f.orgId, sourceType: 'time_entry', sourceId: timeEntryId,
        catalogItemId: null, parentLineId: null, ticketId: null, description: 'Labor',
        quantity: '1.00', unitPrice: '100.00', costBasis: null, taxable: false,
        customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1
      });
    });

    const updated = await withDbAccessContext(ctx(f), () =>
      invoiceSvc.changeInvoiceCurrency(inv.id, { currencyCode: 'JPY', clearLines: true }, actor(f)));
    expect(updated.currencyCode).toBe('JPY');
    expect(updated.total).toBe('0.00');
    expect(updated.balance).toBe('0.00');

    await withSystemDbAccessContext(async () => {
      const lines = await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      expect(lines.length).toBe(0);
      const [te] = await db.select({ billingStatus: timeEntries.billingStatus }).from(timeEntries).where(eq(timeEntries.id, timeEntryId)).limit(1);
      expect(te!.billingStatus).toBe('billed'); // untouched — the other invoice's claim survives
    });
  });

  it('refuses without clearLines when monetary lines exist (CURRENCY_LOCKED 409)', async () => {
    const f = await seedFixture();
    const inv = await withDbAccessContext(ctx(f), async () => {
      const draft = await invoiceSvc.createManualInvoice({ orgId: f.orgId }, actor(f));
      await invoiceSvc.addManualLine(draft.id, { name: 'Setup', quantity: 1, unitPrice: 100, taxable: false }, actor(f));
      return draft;
    });
    await withDbAccessContext(ctx(f), async () => {
      await expect(
        invoiceSvc.changeInvoiceCurrency(inv.id, { currencyCode: 'JPY', clearLines: false }, actor(f))
      ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    });
  });

  it('rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    const f = await seedFixture();
    const issuedId = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(invoices).values({
        partnerId: f.partnerId, orgId: f.orgId, status: 'sent', currencyCode: 'EUR',
        invoiceNumber: `INV-CHG-${Math.random().toString(36).slice(2, 8)}`,
        subtotal: '100.00', total: '100.00', balance: '100.00',
        issueDate: new Date().toISOString().slice(0, 10), dueDate: new Date().toISOString().slice(0, 10)
      }).returning({ id: invoices.id });
      return row!.id;
    });
    await withDbAccessContext(ctx(f), async () => {
      await expect(
        invoiceSvc.changeInvoiceCurrency(issuedId, { currencyCode: 'JPY', clearLines: true }, actor(f))
      ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
    });
  });
});

describe.runIf(RUN)('changeContractCurrency (atomic clear-and-restamp, #3774)', () => {
  it('clearLines: true drops the lines and restamps the draft', async () => {
    const f = await seedFixture();
    const updated = await withDbAccessContext(ctx(f), async () => {
      const c = await contractSvc.createContract({
        orgId: f.orgId, name: 'MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: new Date().toISOString().slice(0, 10),
      }, actor(f));
      expect(c.currencyCode).toBe('EUR');
      await contractSvc.addContractLineToContract(c.id, {
        lineType: 'manual', description: 'Managed services', unitPrice: '500.00',
        taxable: false, manualQuantity: '1',
      }, actor(f));
      return contractSvc.changeContractCurrency(c.id, { currencyCode: 'JPY', clearLines: true }, actor(f));
    });
    expect(updated.currencyCode).toBe('JPY');
    const lines = await withSystemDbAccessContext(() =>
      db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, updated.id)));
    expect(lines.length).toBe(0);
  });

  it('refuses without clearLines when lines exist (CURRENCY_LOCKED 409)', async () => {
    const f = await seedFixture();
    await withDbAccessContext(ctx(f), async () => {
      const c = await contractSvc.createContract({
        orgId: f.orgId, name: 'MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: new Date().toISOString().slice(0, 10),
      }, actor(f));
      await contractSvc.addContractLineToContract(c.id, {
        lineType: 'manual', description: 'Managed services', unitPrice: '500.00',
        taxable: false, manualQuantity: '1',
      }, actor(f));
      await expect(
        contractSvc.changeContractCurrency(c.id, { currencyCode: 'JPY', clearLines: false }, actor(f))
      ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
      const lines = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, c.id));
      expect(lines.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-currency wave 3 (#3775): `reprice` re-resolves catalog-sourced lines
// from the price book in the new currency inside the restamp transaction.
// Atomic: one price-book gap leaves the document byte-identical.
// ---------------------------------------------------------------------------

/** Two catalog items under the fixture's USD partner, each with a USD and an
 *  EUR price-book row (A: 100/90, B: 50/45). */
async function seedPricedItems(f: Fixture) {
  const catalogActor: CatalogActor = { userId: null, partnerId: f.partnerId, accessibleOrgIds: null };
  const suffix = Math.random().toString(36).slice(2, 8);
  return withSystemDbAccessContext(async () => {
    const a = await createCatalogItem({
      itemType: 'service', name: `Managed endpoint ${suffix}`, billingType: 'one_time', unitOfMeasure: 'each',
      taxable: false, isBundle: false, attributes: {},
      prices: [{ currencyCode: 'USD', unitPrice: 100 }, { currencyCode: 'EUR', unitPrice: 90 }],
    }, catalogActor);
    const b = await createCatalogItem({
      itemType: 'service', name: `Onboarding ${suffix}`, billingType: 'one_time', unitOfMeasure: 'each',
      taxable: false, isBundle: false, attributes: {},
      prices: [{ currencyCode: 'USD', unitPrice: 50 }, { currencyCode: 'EUR', unitPrice: 45 }],
    }, catalogActor);
    return { a, b, catalogActor };
  });
}

describe.runIf(RUN)('change-currency reprice via the price book (#3775)', () => {
  it('quote: reprice to EUR stamps both lines from the EUR book and re-totals in EUR', async () => {
    const f = await seedFixture('USD');
    const { a, b } = await seedPricedItems(f);
    const result = await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      expect(q.currencyCode).toBe('USD');
      await quoteSvc.addCatalogLine(q.id, a.id, 2, undefined, actor(f));
      await quoteSvc.addCatalogLine(q.id, b.id, 1, undefined, actor(f));
      const [before] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      expect(before!.subtotal).toBe('250.00'); // 2×100 + 1×50 USD
      return quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'EUR', reprice: true }, actor(f));
    });
    expect(result.currencyCode).toBe('EUR');
    expect(result.subtotal).toBe('225.00'); // 2×90 + 1×45 EUR
    expect(result.total).toBe('225.00');
    const lines = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, result.id)).orderBy(quoteLines.sortOrder));
    expect(lines.map((l) => [l.catalogItemId, l.unitPrice, l.lineTotal])).toEqual([
      [a.id, '90.00', '180.00'],
      [b.id, '45.00', '45.00'],
    ]);
  });

  it('quote: a price-book gap fails 409 and leaves the quote byte-identical', async () => {
    const f = await seedFixture('USD');
    const { a, b, catalogActor } = await seedPricedItems(f);
    await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      await quoteSvc.addCatalogLine(q.id, a.id, 2, undefined, actor(f));
      await quoteSvc.addCatalogLine(q.id, b.id, 1, undefined, actor(f));
      await withSystemDbAccessContext(() => removeItemPrice(b.id, 'EUR', catalogActor));
      const [before] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      const linesBefore = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id)).orderBy(quoteLines.sortOrder);
      await expect(
        quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'EUR', reprice: true }, actor(f))
      ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining(b.name) });
      const [after] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      const linesAfter = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id)).orderBy(quoteLines.sortOrder);
      expect(after).toEqual(before);
      expect(linesAfter).toEqual(linesBefore); // item A's line was NOT repriced (rolled back)
      expect(after!.currencyCode).toBe('USD');
    });
  });

  it('quote: reprice refuses a manual line (CURRENCY_LOCKED 409) — clearLines is the only path', async () => {
    const f = await seedFixture('USD');
    const { a } = await seedPricedItems(f);
    await withDbAccessContext(ctx(f), async () => {
      const q = await quoteSvc.createQuote({ orgId: f.orgId }, actor(f));
      await quoteSvc.addCatalogLine(q.id, a.id, 1, undefined, actor(f));
      await quoteSvc.addManualLine(q.id, manualQuoteLine('Travel', 75), actor(f));
      await expect(
        quoteSvc.changeQuoteCurrency(q.id, { currencyCode: 'EUR', reprice: true }, actor(f))
      ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409, message: expect.stringContaining('1 non-catalog line(s)') });
      const [after] = await db.select().from(quotes).where(eq(quotes.id, q.id)).limit(1);
      expect(after!.currencyCode).toBe('USD');
    });
  });

  it('invoice: reprice to EUR stamps both lines from the EUR book and re-totals in EUR', async () => {
    const f = await seedFixture('USD');
    const { a, b } = await seedPricedItems(f);
    const result = await withDbAccessContext(ctx(f), async () => {
      const inv = await invoiceSvc.createManualInvoice({ orgId: f.orgId }, actor(f));
      expect(inv.currencyCode).toBe('USD');
      await invoiceSvc.addCatalogLine(inv.id, a.id, 2, actor(f));
      await invoiceSvc.addCatalogLine(inv.id, b.id, 1, actor(f));
      const [before] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
      expect(before!.subtotal).toBe('250.00');
      return invoiceSvc.changeInvoiceCurrency(inv.id, { currencyCode: 'EUR', reprice: true }, actor(f));
    });
    expect(result.currencyCode).toBe('EUR');
    expect(result.subtotal).toBe('225.00');
    expect(result.total).toBe('225.00');
    expect(result.balance).toBe('225.00');
    const lines = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, result.id)).orderBy(invoiceLines.sortOrder));
    expect(lines.map((l) => [l.catalogItemId, l.unitPrice, l.lineTotal])).toEqual([
      [a.id, '90.00', '180.00'],
      [b.id, '45.00', '45.00'],
    ]);
  });

  it('invoice: a price-book gap fails 409 and leaves the invoice byte-identical', async () => {
    const f = await seedFixture('USD');
    const { a, b, catalogActor } = await seedPricedItems(f);
    await withDbAccessContext(ctx(f), async () => {
      const inv = await invoiceSvc.createManualInvoice({ orgId: f.orgId }, actor(f));
      await invoiceSvc.addCatalogLine(inv.id, a.id, 2, actor(f));
      await invoiceSvc.addCatalogLine(inv.id, b.id, 1, actor(f));
      await withSystemDbAccessContext(() => removeItemPrice(b.id, 'EUR', catalogActor));
      const [before] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
      const linesBefore = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.sortOrder);
      await expect(
        invoiceSvc.changeInvoiceCurrency(inv.id, { currencyCode: 'EUR', reprice: true }, actor(f))
      ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining(b.name) });
      const [after] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
      const linesAfter = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.sortOrder);
      expect(after).toEqual(before);
      expect(linesAfter).toEqual(linesBefore);
      expect(after!.currencyCode).toBe('USD');
    });
  });

  it('contract: reprice to EUR stamps both catalog lines from the EUR book', async () => {
    const f = await seedFixture('USD');
    const { a, b } = await seedPricedItems(f);
    const updated = await withDbAccessContext(ctx(f), async () => {
      const c = await contractSvc.createContract({
        orgId: f.orgId, name: 'MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: new Date().toISOString().slice(0, 10),
      }, actor(f));
      expect(c.currencyCode).toBe('USD');
      await contractSvc.addContractLineToContract(c.id, { lineType: 'flat', description: 'A', taxable: false, catalogItemId: a.id }, actor(f));
      await contractSvc.addContractLineToContract(c.id, { lineType: 'flat', description: 'B', taxable: false, catalogItemId: b.id }, actor(f));
      return contractSvc.changeContractCurrency(c.id, { currencyCode: 'EUR', reprice: true }, actor(f));
    });
    expect(updated.currencyCode).toBe('EUR');
    const lines = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.contractId, updated.id)).orderBy(contractLines.sortOrder));
    expect(lines.map((l) => [l.catalogItemId, l.unitPrice])).toEqual([[a.id, '90.00'], [b.id, '45.00']]);
  });

  it('contract: a price-book gap fails 409 and leaves the contract byte-identical', async () => {
    const f = await seedFixture('USD');
    const { a, b, catalogActor } = await seedPricedItems(f);
    await withDbAccessContext(ctx(f), async () => {
      const c = await contractSvc.createContract({
        orgId: f.orgId, name: 'MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: new Date().toISOString().slice(0, 10),
      }, actor(f));
      await contractSvc.addContractLineToContract(c.id, { lineType: 'flat', description: 'A', taxable: false, catalogItemId: a.id }, actor(f));
      await contractSvc.addContractLineToContract(c.id, { lineType: 'flat', description: 'B', taxable: false, catalogItemId: b.id }, actor(f));
      await withSystemDbAccessContext(() => removeItemPrice(b.id, 'EUR', catalogActor));
      const [before] = await db.select().from(contracts).where(eq(contracts.id, c.id)).limit(1);
      const linesBefore = await db.select().from(contractLines).where(eq(contractLines.contractId, c.id)).orderBy(contractLines.sortOrder);
      await expect(
        contractSvc.changeContractCurrency(c.id, { currencyCode: 'EUR', reprice: true }, actor(f))
      ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining(b.name) });
      const [after] = await db.select().from(contracts).where(eq(contracts.id, c.id)).limit(1);
      const linesAfter = await db.select().from(contractLines).where(eq(contractLines.contractId, c.id)).orderBy(contractLines.sortOrder);
      expect(after).toEqual(before);
      expect(linesAfter).toEqual(linesBefore);
      expect(after!.currencyCode).toBe('USD');
    });
  });
});

// ---------------------------------------------------------------------------
// Phantom-line race (#3774 wave-3 review): a line writer racing the restamp
// must serialize on the DOCUMENT row lock. Harness pattern from
// invoiceIssueRace.integration.test.ts — a dedicated admin postgres.js client
// pre-holds the contended document row lock, both racers are started against
// the app pool, and pg_blocking_pids proves BOTH are queued behind the lock
// (pre-fix, the line writer never blocked — this barrier would time out)
// before the holder releases. No sleeps.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(
    clients.map((client) => client.end({ timeout: 1 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to close change-currency race client(s)');
  }
}

/** Wait until at least `min` backends in this database are actively blocked on
 *  a lock. The idle-in-transaction holder never matches — only the racers
 *  queued behind it can, which makes the release deterministic. */
async function waitForBlockedBackends(min: number): Promise<void> {
  const admin = getTestDb();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await admin.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
    `);
    if ((rows[0]?.waiting ?? 0) >= min) return;
    if (Date.now() > deadline) {
      throw new Error(`expected >= ${min} lock-blocked backends within 10s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function errorCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  const reason = result.reason as { code?: string };
  return reason?.code;
}

describe.runIf(RUN)('change-currency vs line-writer race (#3774)', () => {
  it('quote: addManualLine racing changeQuoteCurrency serializes on the quote row — never a mixed-currency line', async () => {
    const f = await seedFixture(); // EUR org
    const quote = await withDbAccessContext(ctx(f), () =>
      quoteSvc.createQuote({ orgId: f.orgId }, actor(f)));
    expect(quote.currencyCode).toBe('EUR');

    const locksHeld = deferred<void>();
    const releaseLocks = deferred<void>();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let settled: PromiseSettledResult<unknown>[] | undefined;
    try {
      // Barrier: pre-hold the QUOTE row so both racers queue behind it.
      holderWork = holder.begin(async (htx) => {
        await htx`SELECT id FROM public.quotes WHERE id = ${quote.id} FOR UPDATE`;
        locksHeld.resolve();
        await releaseLocks.promise;
      });
      await locksHeld.promise;

      // 3 × 33.35 = 100.05 — rounds to '100.05' under EUR but '100.00' under
      // JPY, so the persisted lineTotal proves WHICH stamp the writer saw.
      const addLine = withDbAccessContext(ctx(f), () =>
        quoteSvc.addManualLine(quote.id, {
          sourceType: 'manual', name: 'Discriminator', description: null, quantity: 3, unitPrice: 33.35,
          taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
        } as never, actor(f)));
      const change = withDbAccessContext(ctx(f), () =>
        quoteSvc.changeQuoteCurrency(quote.id, { currencyCode: 'JPY', clearLines: false }, actor(f)));
      // BOTH must be lock-waiting on the quote row. Pre-fix the line writer
      // used an unlocked read + bare insert and never blocked here.
      await waitForBlockedBackends(2);
      releaseLocks.resolve();
      await holderWork;
      settled = await Promise.allSettled([addLine, change]);
    } finally {
      releaseLocks.resolve();
      if (holderWork) await Promise.allSettled([holderWork]);
      await closeRaceClients(holder);
    }

    const [addResult, changeResult] = settled!;
    // The quote stays a draft in every interleaving, so the add is never
    // rejected for STATE. Since wave 6 it can still be rejected for VALUE: if
    // the restamp to JPY commits first, 33.35 is not representable in the new
    // currency and the write seam refuses it (PRICE_NOT_REPRESENTABLE) instead
    // of silently rounding it to whole yen.
    if (addResult!.status === 'rejected') {
      expect(errorCode(addResult!)).toBe('PRICE_NOT_REPRESENTABLE');
      expect(changeResult!.status).toBe('fulfilled');
    }

    const persisted = await withSystemDbAccessContext(async () => {
      const [q] = await db.select({ currencyCode: quotes.currencyCode, subtotal: quotes.subtotal })
        .from(quotes).where(eq(quotes.id, quote.id)).limit(1);
      const lines = await db.select({ quantity: quoteLines.quantity, unitPrice: quoteLines.unitPrice, lineTotal: quoteLines.lineTotal })
        .from(quoteLines).where(eq(quoteLines.quoteId, quote.id));
      return { q: q!, lines };
    });

    // THE invariant: every persisted line was totaled under the quote's
    // CURRENT stamp — a JPY quote can never carry an EUR-rounded line.
    for (const line of persisted.lines) {
      expect(line.lineTotal).toBe(computeLineTotal(line.quantity, line.unitPrice, persisted.q.currencyCode));
    }

    if (changeResult!.status === 'rejected') {
      // Line landed first: the restamp saw it and refused (CURRENCY_LOCKED).
      expect(errorCode(changeResult!)).toBe('CURRENCY_LOCKED');
      expect(persisted.q.currencyCode).toBe('EUR');
      expect(persisted.lines).toHaveLength(1);
      expect(persisted.lines[0]!.lineTotal).toBe('100.05');
    } else if (addResult!.status === 'fulfilled') {
      // Restamp won and the line was still representable: the line writer
      // re-read the NEW currency off the locked row and rounded to whole yen.
      expect(persisted.q.currencyCode).toBe('JPY');
      expect(persisted.lines).toHaveLength(1);
      expect(persisted.lines[0]!.lineTotal).toBe('100.00');
    } else {
      // Restamp won and the fractional-yen price was refused: nothing landed.
      expect(persisted.q.currencyCode).toBe('JPY');
      expect(persisted.lines).toHaveLength(0);
    }
  }, 30_000);

  it('contract: addContractLineToContract racing changeContractCurrency serializes on the contract row', async () => {
    const f = await seedFixture(); // EUR org
    const contract = await withDbAccessContext(ctx(f), () =>
      contractSvc.createContract({
        orgId: f.orgId, name: 'Race MSA', billingTiming: 'advance', intervalMonths: 1,
        startDate: new Date().toISOString().slice(0, 10),
      }, actor(f)));
    expect(contract.currencyCode).toBe('EUR');

    const locksHeld = deferred<void>();
    const releaseLocks = deferred<void>();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let settled: PromiseSettledResult<unknown>[] | undefined;
    try {
      holderWork = holder.begin(async (htx) => {
        await htx`SELECT id FROM public.contracts WHERE id = ${contract.id} FOR UPDATE`;
        locksHeld.resolve();
        await releaseLocks.promise;
      });
      await locksHeld.promise;

      const addLine = withDbAccessContext(ctx(f), () =>
        contractSvc.addContractLineToContract(contract.id, {
          lineType: 'manual', description: 'Managed services', unitPrice: '500.00',
          taxable: false, manualQuantity: '1',
        } as never, actor(f)));
      const change = withDbAccessContext(ctx(f), () =>
        contractSvc.changeContractCurrency(contract.id, { currencyCode: 'JPY', clearLines: false }, actor(f)));
      // Pre-fix the line writer never blocked on the contract row; this
      // barrier is the regression proof that both now serialize on it.
      await waitForBlockedBackends(2);
      releaseLocks.resolve();
      await holderWork;
      settled = await Promise.allSettled([addLine, change]);
    } finally {
      releaseLocks.resolve();
      if (holderWork) await Promise.allSettled([holderWork]);
      await closeRaceClients(holder);
    }

    const [addResult, changeResult] = settled!;
    // The add always succeeds (draft contracts are line-editable either way).
    expect(addResult!.status).toBe('fulfilled');

    const persisted = await withSystemDbAccessContext(async () => {
      const [c] = await db.select({ currencyCode: contracts.currencyCode })
        .from(contracts).where(eq(contracts.id, contract.id)).limit(1);
      const lines = await db.select({ id: contractLines.id })
        .from(contractLines).where(eq(contractLines.contractId, contract.id));
      return { c: c!, lines };
    });
    expect(persisted.lines).toHaveLength(1);

    if (changeResult!.status === 'rejected') {
      // Line landed first: the restamp saw it under the lock and refused —
      // pre-fix this interleaving restamped anyway (phantom line: a JPY
      // contract keeping a line priced in EUR with a success response).
      expect(errorCode(changeResult!)).toBe('CURRENCY_LOCKED');
      expect(persisted.c.currencyCode).toBe('EUR');
    } else {
      // Restamp won on the empty draft; the line writer then re-read the
      // locked row and landed its line on the JPY contract.
      expect(persisted.c.currencyCode).toBe('JPY');
    }
  }, 30_000);
});
