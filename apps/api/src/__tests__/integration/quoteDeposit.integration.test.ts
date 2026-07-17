/**
 * End-to-end real-Postgres happy path for the quote-deposits feature (Task 14).
 * Exercises the full lifecycle in one sequential flow — draft → deposit config →
 * send → accept (invoice + contract) → chargeNow → deposit payment → chargeNow
 * again → due-date update → final payment → content-hash binding — against a
 * real DB, not mocks. Mirrors the harness of quoteAccept.integration.test.ts and
 * quotePay.integration.test.ts (org-scope ctx/actor helpers, `runDb` gate,
 * withSystemDbAccessContext for tenant seeding + read-back assertions).
 *
 * Money trail (asserted at every step so a regression in quoteMath/invoiceMath/
 * depositMath surfaces here immediately):
 *   catalog line (hardware, taxable):      6200.00
 *   manual labor line (taxable):           2400.00
 *   monthly recurring line:                 300.00 (excluded from one-time math)
 *   tax rate:                                 10%
 *   dueOnAcceptance = (6200+2400) + 10% tax = 8600 + 860 = 9460.00
 *   deposit (selected_lines, catalog line only) = 6200 + 10% = 6820.00
 *   balance after deposit payment = 9460 − 6820 = 2640.00
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances } from '../../db/schema/quotes';
import { invoices } from '../../db/schema/invoices';
import { contracts } from '../../db/schema/contracts';
import { catalogItems } from '../../db/schema/catalog';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine, addCatalogLine, updateQuote, getQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { recordPayment, updateIssuedDueDate, getInvoice } from '../../services/invoiceService';
import { computeQuoteSha256 } from '../../services/quoteContentHash';
import { computeChargeNow } from '@breeze/shared';
import type { QuoteActor } from '../../services/quoteTypes';
import type { InvoiceActor } from '../../services/invoiceTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function qActor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}
function iActor(orgId: string, partnerId: string): InvoiceActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}

/** Seed a taxable hardware catalog item (system scope bypasses RLS for the seed). */
async function seedHardwareCatalogItem(partnerId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(catalogItems).values({
      partnerId,
      itemType: 'hardware',
      name: 'Managed switch',
      unitPrice: '6200.00',
      billingType: 'one_time',
      taxable: true,
      isBundle: false,
    }).returning({ id: catalogItems.id });
    return { id: row!.id };
  });
}

describe('quote deposits: accept → deposit → balance (breeze_app, real DB)', () => {
  runDb('full deposit lifecycle: draft → selected_lines deposit → send → accept → chargeNow → deposit payment → chargeNow → due-date update → final payment → content-hash binding', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id);
    const actor = qActor(org.id, partner.id);
    const invActor = iActor(org.id, partner.id);

    // --- Step 1: draft quote with a hardware catalog line, a manual labor line,
    // and a monthly recurring line; both one-time lines are taxable. ---
    const item = await seedHardwareCatalogItem(partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));

    const catalogLine = await withDbAccessContext(ctx, () =>
      addCatalogLine(created.id, item.id, 1, undefined, actor)
    );
    expect(catalogLine.unitPrice).toBe('6200.00');
    expect(catalogLine.taxable).toBe(true);
    // Hardware auto-defaults to deposit-eligible (addCatalogLine snapshot rule).
    expect(catalogLine.depositEligible).toBe(true);
    expect(catalogLine.itemType).toBe('hardware');

    await withDbAccessContext(ctx, () =>
      addManualLine(created.id, {
        sourceType: 'manual', description: 'Installation labor', quantity: 1, unitPrice: 2400,
        taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false,
      }, actor)
    );
    await withDbAccessContext(ctx, () =>
      addManualLine(created.id, {
        sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 300,
        taxable: false, customerVisible: true, recurrence: 'monthly', depositEligible: false,
      }, actor)
    );

    // 10% tax.
    await withDbAccessContext(ctx, () => updateQuote(created.id, { taxRate: 0.10 }, actor));

    // --- Step 2: configure a selected_lines deposit — only the (deposit-eligible)
    // hardware line counts: 6200 + 10% tax = 6820.00. ---
    const withDeposit = await withDbAccessContext(ctx, () =>
      updateQuote(created.id, { depositType: 'selected_lines' }, actor)
    );
    expect(withDeposit.depositAmount).toBe('6820.00');

    const fetched = await withDbAccessContext(ctx, () => getQuote(created.id, actor));
    expect(fetched.quote.dueOnAcceptanceTotal).toBe('9460.00'); // (6200+2400) + 10% tax
    expect(fetched.quote.depositDueTotal).toBe('6820.00');
    const fetchedCatalogLine = fetched.lines.find((l) => l.id === catalogLine.id)!;
    expect(fetchedCatalogLine.depositEligible).toBe(true);
    expect(fetchedCatalogLine.itemType).toBe('hardware');

    // --- Step 3: send → accept. Invoice issued for the one-time total, deposit
    // due carried over from the quote; monthly line spins off a draft contract. ---
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const res = await withDbAccessContext(ctx, () =>
      acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer', signerEmail: 'jane@org.example' })
    );
    expect(res.invoiceIssued).toBe(true);

    const [invoiceRow] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, res.invoiceId))
    );
    expect(invoiceRow!.status).toBe('sent');
    expect(invoiceRow!.total).toBe('9460.00'); // 8600 + 860 tax
    expect(invoiceRow!.balance).toBe('9460.00');
    expect(invoiceRow!.depositDue).toBe('6820.00');

    const [quoteAfterAccept] = await withSystemDbAccessContext(() =>
      db.select().from(quotes).where(eq(quotes.id, created.id))
    );
    expect(quoteAfterAccept!.status).toBe('converted');
    expect(quoteAfterAccept!.convertedInvoiceId).toBe(res.invoiceId);

    expect(res.contractIds).toHaveLength(1);
    const [contract] = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!))
    );
    expect(contract!.status).toBe('draft');
    expect(contract!.intervalMonths).toBe(1); // the monthly line's cadence

    // --- Step 4: chargeNow on the freshly-issued invoice targets the deposit. ---
    let chargeNow = computeChargeNow({
      depositDue: invoiceRow!.depositDue, amountPaid: invoiceRow!.amountPaid, balance: invoiceRow!.balance,
    });
    expect(chargeNow).toEqual({ amount: '6820.00', isDeposit: true });

    // --- Step 5: record the deposit payment. Status flips to partially_paid;
    // balance is the remainder; chargeNow now targets the full remaining balance. ---
    await withDbAccessContext(ctx, () =>
      recordPayment(res.invoiceId, { amount: 6820.00, method: 'bank_transfer', receivedAt: new Date().toISOString().slice(0, 10) }, invActor)
    );
    const afterDeposit = await withDbAccessContext(ctx, () => getInvoice(res.invoiceId, invActor));
    expect(afterDeposit.invoice.status).toBe('partially_paid');
    expect(afterDeposit.invoice.balance).toBe('2640.00');
    expect(afterDeposit.invoice.amountPaid).toBe('6820.00');

    chargeNow = computeChargeNow({
      depositDue: afterDeposit.invoice.depositDue, amountPaid: afterDeposit.invoice.amountPaid, balance: afterDeposit.invoice.balance,
    });
    expect(chargeNow).toEqual({ amount: '2640.00', isDeposit: false });

    // --- Step 6: due-date update succeeds on the still-open (partially_paid)
    // invoice and is reflected on read-back. ---
    const futureDueDate = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    const dueDateResult = await withDbAccessContext(ctx, () =>
      updateIssuedDueDate(res.invoiceId, futureDueDate, invActor)
    );
    expect(dueDateResult.invoice.dueDate).toBe(futureDueDate);
    const afterDueDateUpdate = await withDbAccessContext(ctx, () => getInvoice(res.invoiceId, invActor));
    expect(afterDueDateUpdate.invoice.dueDate).toBe(futureDueDate);

    // --- Step 7: pay off the remaining balance → invoice fully paid. ---
    await withDbAccessContext(ctx, () =>
      recordPayment(res.invoiceId, { amount: 2640.00, method: 'bank_transfer', receivedAt: new Date().toISOString().slice(0, 10) }, invActor)
    );
    const afterFinalPayment = await withDbAccessContext(ctx, () => getInvoice(res.invoiceId, invActor));
    expect(afterFinalPayment.invoice.status).toBe('paid');
    expect(afterFinalPayment.invoice.balance).toBe('0.00');

    // --- Step 8: the signed content hash binds the deposit terms — hashing the
    // same quote content with the deposit stripped must NOT reproduce the stored
    // hash (the customer signed the deposit terms as part of the acceptance). ---
    const [acceptance] = await withSystemDbAccessContext(() =>
      db.select().from(quoteAcceptances).where(eq(quoteAcceptances.quoteId, created.id))
    );
    expect(acceptance!.quoteSha256).toMatch(/^[0-9a-f]{64}$/);

    const blocksForHash = await withSystemDbAccessContext(() =>
      db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, created.id))
    );
    const linesForHash = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, created.id))
    );
    // Sanity: recomputing the hash from the (unchanged) persisted quote/lines
    // reproduces the exact hash stored at accept time.
    const recomputedHash = computeQuoteSha256(quoteAfterAccept as any, blocksForHash as any, linesForHash as any, []);
    expect(recomputedHash).toBe(acceptance!.quoteSha256);

    // Now strip the deposit terms and hash again — must differ.
    const strippedHash = computeQuoteSha256(
      { ...(quoteAfterAccept as any), depositType: 'none', depositPercent: null, depositAmount: null },
      blocksForHash as any,
      linesForHash as any,
      [],
    );
    expect(strippedHash).not.toBe(acceptance!.quoteSha256);
  });
});
