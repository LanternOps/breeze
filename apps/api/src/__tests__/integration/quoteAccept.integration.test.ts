import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { invoices, invoiceLines } from '../../db/schema/invoices';
import { contracts, contractLines } from '../../db/schema/contracts';
import { organizations } from '../../db/schema/orgs';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext { return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null }; }
function actorFor(orgId: string, partnerId: string): QuoteActor { return { userId: null, partnerId, accessibleOrgIds: [orgId] }; }
async function seed() { return withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partner, org }; }); }

describe('quote accept → convert', () => {
  runDb('records acceptance with content hash and converts one-time lines to an invoice', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Managed services', quantity: 5, unitPrice: 99, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer', signerEmail: 'jane@org.example', ipAddress: '9.9.9.9', userAgent: 'UA' }));
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');
    expect(q!.convertedInvoiceId).toBe(res.invoiceId);
    expect(q!.acceptedAt).toBeTruthy();

    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.signerName).toBe('Jane Buyer');
    expect(acc!.quoteSha256).toMatch(/^[0-9a-f]{64}$/);

    // Only the one-time line ($250) is invoiced; the monthly line is excluded.
    const invLines = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, res.invoiceId)));
    expect(invLines).toHaveLength(1);
    expect(invLines[0]!.description).toBe('Onboarding');
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.total).toBe('250.00');

    // Phase 4: the monthly recurring line becomes a draft contract.
    expect(res.contractIds).toHaveLength(1);
    const createdContracts = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)),
    );
    expect(createdContracts).toHaveLength(1);
    const contract = createdContracts[0]!;
    expect(contract.status).toBe('draft');
    expect(contract.intervalMonths).toBe(1);
    expect(contract.billingTiming).toBe('advance');
    expect(contract.autoIssue).toBe(false);
    expect(contract.currencyCode).toBe('USD');
    expect(contract.orgId).toBe(org.id);
    expect(contract.partnerId).toBe(partner.id);
    expect(contract.startDate).toBe(new Date().toISOString().slice(0, 10));

    const cLines = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.contractId, contract.id)),
    );
    expect(cLines).toHaveLength(1);
    expect(cLines[0]!.lineType).toBe('manual');
    expect(cLines[0]!.description).toBe('Managed services');
    expect(cLines[0]!.unitPrice).toBe('99.00');
    expect(cLines[0]!.manualQuantity).toBe('5.00');
  });

  // The auto-issued invoice must carry the quote's frozen seller snapshot, T&C, and
  // terms footer — the customer signed against a proposal that showed this info;
  // the invoice they receive must match.
  runDb('auto-issued invoice carries seller snapshot, termsAndConditions, and terms from the quote', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    // Overwrite the snapshot AFTER send — sendQuote unconditionally stamps
    // buildSellerSnapshot(partnerRow), so we must patch it post-send to simulate
    // a quote whose frozen seller info differs from the partner's live values.
    const sellerSnap = { name: 'Acme MSP LLC', address: null, phone: null, email: null, website: null };
    await withSystemDbAccessContext(() => db.update(quotes).set({
      sellerSnapshot: sellerSnap,
      termsAndConditions: 'Net 30 terms',
      terms: 'Footer line',
    }).where(eq(quotes.id, created.id)));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect((inv!.sellerSnapshot as { name: string } | null)?.name).toBe('Acme MSP LLC');
    expect(inv!.termsAndConditions).toBe('Net 30 terms');
    expect(inv!.terms).toBe('Footer line');
  });

  // Phase 3 (auto-issue on accept): the converted invoice is ISSUED (status=sent,
  // invoice number, balance = quote one-time total) so the customer can pay it
  // immediately via the existing pay-link — using the accepted quote's locked
  // total (no tax re-resolve).
  runDb('issues the converted invoice (sent + number + balance) so it is immediately payable', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));
    expect(res.invoiceIssued).toBe(true); // drives the post-commit invoice.issued emit + PDF enqueue
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.status).toBe('sent'); // issued → payable (PAYABLE set in invoiceCheckout)
    expect(inv!.invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(inv!.total).toBe('250.00');
    expect(inv!.balance).toBe('250.00');
    expect(inv!.issueDate).toBeTruthy();
    expect(inv!.dueDate).toBeTruthy();
  });

  // The whole point of "lock the quote total" (Phase 3 decision): the auto-issued
  // invoice keeps the quote's snapshotted tax rate — it must NOT re-resolve the org's
  // current rate like issueInvoice does, or the customer would be charged differently
  // than the proposal they signed.
  runDb('auto-issued invoice uses the quote tax snapshot, not the current org rate', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Taxable item', quantity: 1, unitPrice: 100, taxable: true, customerVisible: true, recurrence: 'one_time' } as any, actor));
    // Quote snapshot = 10%; org's live rate = 25% (deliberately different).
    await withSystemDbAccessContext(() => db.update(quotes).set({ taxRate: '0.100' }).where(eq(quotes.id, created.id)));
    await withSystemDbAccessContext(() => db.update(organizations).set({ taxRate: '0.250' }).where(eq(organizations.id, org.id)));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.taxTotal).toBe('10.00');  // 100 × 0.10 (quote snapshot) — NOT 25.00 (org rate)
    expect(inv!.total).toBe('110.00');
  });

  // Auto-issue allocates a gapless invoice number. Two accepts for the same
  // partner/year must get consecutive numbers (no gap, no reuse) — accounting integrity.
  runDb('two accepted quotes for the same partner get sequential invoice numbers', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const acceptOne = async () => {
      const q = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
      await withDbAccessContext(ctx, () => addManualLine(q.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 50, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
      await withDbAccessContext(ctx, () => sendQuote(q.id, actor));
      return withDbAccessContext(ctx, () => acceptQuote({ quoteId: q.id, signerName: 'Jane' }));
    };
    const a = await acceptOne();
    const b = await acceptOne();
    const [invA] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, a.invoiceId)));
    const [invB] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, b.invoiceId)));
    const numA = Number(invA!.invoiceNumber!.split('-')[2]);
    const numB = Number(invB!.invoiceNumber!.split('-')[2]);
    expect(Number.isFinite(numA)).toBe(true);
    expect(numB).toBe(numA + 1);
  });

  runDb('a recurring-only quote still converts but yields a $0 invoice (Phase 2 degenerate edge)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 99, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Bob' }));
    expect(res.invoiceIssued).toBe(false); // no one-time lines → invoice not issued → no invoice.issued emit
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, res.invoiceId)));
    expect(inv!.total).toBe('0.00');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');

    // Phase 4: even a recurring-only quote still creates the draft contract.
    expect(res.contractIds).toHaveLength(1);
    const [recurringContract] = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)),
    );
    expect(recurringContract!.status).toBe('draft');
    expect(recurringContract!.intervalMonths).toBe(1);
  });

  // Phase 3 read-time expiry guard: a quote whose expiry_date has passed must be
  // rejected at accept time even if the BullMQ sweep hasn't flipped it to 'expired'
  // yet (status still 'sent'/'viewed'). Closes the gap between expiry and the sweep.
  runDb('rejects accepting a quote whose expiry_date has passed (even before the sweep runs)', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    // Back-date the expiry so it's in the past while status is still 'sent'.
    await withSystemDbAccessContext(() => db.update(quotes).set({ expiryDate: '2000-01-01' }).where(eq(quotes.id, created.id)));

    await expect(
      withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Late Larry' }))
    ).rejects.toMatchObject({ status: 410, code: 'QUOTE_EXPIRED' });

    // No invoice or acceptance was created by the rejected accept.
    const invs = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, org.id)));
    expect(invs).toHaveLength(0);
    const accs = await withSystemDbAccessContext(() => db.select({ id: quoteAcceptances.id }).from(quoteAcceptances).where(eq(quoteAcceptances.quoteId, created.id)));
    expect(accs).toHaveLength(0);
  });

  runDb('rejects accepting a quote that is not sent/viewed', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    // still draft
    await expect(withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }))).rejects.toMatchObject({ status: 409 });
  });

  // TA-1 / atom-1: accepting a quote is at-most-once. A second accept (the
  // double-submit / replay case) must 409 and create NO second invoice — the
  // single most important invariant of the convert pipeline.
  runDb('a second accept of the same quote is rejected and creates no duplicate invoice', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const first = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));
    await expect(
      withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane (again)' }))
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });

    // Exactly one invoice + one acceptance exist for the quote.
    const invs = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, org.id)));
    expect(invs).toHaveLength(1);
    expect(invs[0]!.id).toBe(first.invoiceId);
    const accs = await withSystemDbAccessContext(() => db.select({ id: quoteAcceptances.id }).from(quoteAcceptances).where(eq(quoteAcceptances.quoteId, created.id)));
    expect(accs).toHaveLength(1);
  });

  runDb('one-time-only quote creates no contracts', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Onboarding fee', quantity: 1, unitPrice: 500, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));
    expect(res.contractIds).toEqual([]);

    // Defense-in-depth: confirm no contracts exist at the DB level either.
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: contracts.id }).from(contracts).where(eq(contracts.orgId, org.id)),
    );
    expect(rows).toHaveLength(0);
  });

  runDb('creates a monthly and an annual draft contract for a quote with both cadences', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Annual license', quantity: 2, unitPrice: 1200, taxable: false, customerVisible: true, recurrence: 'annual' } as any, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'EDR', quantity: 3, unitPrice: 15, taxable: false, customerVisible: true, recurrence: 'monthly' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));

    expect(res.contractIds).toHaveLength(2);
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(contracts).where(inArray(contracts.id, res.contractIds)),
    );
    const intervals = rows.map((r) => r.intervalMonths).sort((a, b) => a - b);
    expect(intervals).toEqual([1, 12]);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    expect(rows.every((r) => r.billingTiming === 'advance' && r.autoIssue === false)).toBe(true);

    // Verify contract lines: two contracts, each with exactly one manual line
    const cLines = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(inArray(contractLines.contractId, res.contractIds)),
    );
    expect(cLines).toHaveLength(2);
    expect(cLines.every((l) => l.lineType === 'manual')).toBe(true);

    // Match lines to contracts by intervalMonths: 1=monthly (EDR, qty 3, price 15), 12=annual (Annual license, qty 2, price 1200)
    const monthlyContract = rows.find((c) => c.intervalMonths === 1)!;
    const annualContract = rows.find((c) => c.intervalMonths === 12)!;

    const monthlyLine = cLines.find((l) => l.contractId === monthlyContract.id)!;
    expect(monthlyLine.description).toBe('EDR');
    expect(monthlyLine.unitPrice).toBe('15.00');
    expect(monthlyLine.manualQuantity).toBe('3.00');

    const annualLine = cLines.find((l) => l.contractId === annualContract.id)!;
    expect(annualLine.description).toBe('Annual license');
    expect(annualLine.unitPrice).toBe('1200.00');
    expect(annualLine.manualQuantity).toBe('2.00');
  });
});
