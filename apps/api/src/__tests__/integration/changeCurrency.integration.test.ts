import './setup';
import { describe, it, expect } from 'vitest';

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  partners, organizations, users, timeEntries, invoices, invoiceLines,
  quotes, quoteLines, contractLines,
} from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import * as quoteSvc from '../../services/quoteService';
import * as contractSvc from '../../services/contractService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;

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
        hourlyRate: '100.00', billingStatus: 'billed', isApproved: true
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
