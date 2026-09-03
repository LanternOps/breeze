/**
 * #3205 W07 (#4656) Task 5 — device appendix stamping at issuance.
 *
 * NOTE ON PROVENANCE: this file is newly created for this task (Step 2 of the
 * brief instructs creating it; it was omitted from the brief's top-level
 * "Files" list, which is a documentation gap in the brief, not a signal to
 * skip it — Steps 2/8/9 all name it explicitly). Every fixture below is
 * original, modeled on `seedDraftInvoice`/`seedIssuedInvoice` in
 * `invoicePdf.integration.test.ts` (direct-insert org/invoice seeding) and the
 * quote -> send -> accept sequence in
 * `multiCurrencyWave6QuoteAcceptance.integration.test.ts` (createQuote ->
 * addManualLine -> updateQuote(deposit) -> sendQuote -> acceptQuote).
 *
 * #3205 W07 decision 14a — the appendix choice is FROZEN AT ISSUANCE and stable
 * across every sanctioned re-render. Not "byte-stable forever": the reset-link
 * path legitimately re-renders and rewrites the stored document
 * (invoicePdf.ts mints the public link into the bytes). The PDF-content
 * assertions for that claim are Task 7's job — this file only turns the
 * stamping cases green.
 *
 * Runs under vitest.integration.config.ts against a real Postgres.
 * integration/setup.ts TRUNCATEs core tenant tables before every test.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices, organizations, partners } from '../../db/schema';
import { issueInvoice } from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { acceptQuote } from '../../services/quoteAcceptService';
import { sendQuote } from '../../services/quoteLifecycle';
import { addManualLine, createQuote, updateQuote } from '../../services/quoteService';
import type { QuoteActor } from '../../services/quoteTypes';
import { seedGateOrg } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

const ACTOR: InvoiceActor = { userId: null, partnerId: null, accessibleOrgIds: null };

interface DraftFixture { invoiceId: string; partnerId: string; orgId: string; actor: InvoiceActor }

/** A DRAFT invoice (one customer-visible line, so issueInvoice's
 *  NO_VISIBLE_LINES guard is satisfied) under a partner stamped with the given
 *  invoice_device_appendix default. */
async function seedDraftInvoice(opts: { invoiceDeviceAppendix: boolean }): Promise<DraftFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({
        name: `AP ${sfx}`, slug: `ap-${sfx}`, type: 'msp', plan: 'pro', status: 'active',
        invoiceDeviceAppendix: opts.invoiceDeviceAppendix,
      })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `AP Org ${sfx}`, slug: `ap-org-${sfx}` })
      .returning({ id: organizations.id });
    const [inv] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: o!.id, status: 'draft', currencyCode: 'USD',
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: o!.id, sourceType: 'manual', name: 'Consulting',
      description: 'Consulting', quantity: '1', unitPrice: '100.00', taxable: false,
      customerVisible: true, lineTotal: '100.00', sortOrder: 0,
    });
    return { invoiceId: inv!.id, partnerId: p!.id, orgId: o!.id, actor: ACTOR };
  });
}

/** A quote with a single deposit-eligible one-time line, sent and ready to
 *  accept — accepting it auto-issues the converted invoice (never through
 *  issueInvoice), the other writer the appendix stamp must cover. */
async function seedAcceptableQuoteWithDeposit(opts: { invoiceDeviceAppendix: boolean }) {
  const fixture = await seedGateOrg('USD');
  await withSystemDbAccessContext(() => db.update(partners)
    .set({ invoiceDeviceAppendix: opts.invoiceDeviceAppendix }).where(eq(partners.id, fixture.partnerId)));
  const actor: QuoteActor = { userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: [fixture.orgId] } as QuoteActor;
  const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
  await withSystemDbAccessContext(() => addManualLine(quote.id, {
    sourceType: 'manual', name: 'Deposit Line', description: 'Deposit Line', quantity: 1, unitPrice: 1000,
    taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: true,
  } as never, actor));
  await withSystemDbAccessContext(() => updateQuote(quote.id, { depositType: 'percent', depositPercent: 30 } as never, actor));
  await withSystemDbAccessContext(() => sendQuote(quote.id, actor));
  return {
    quoteId: quote.id, partnerId: fixture.partnerId, orgId: fixture.orgId,
    acceptance: { quoteId: quote.id, signerName: 'Appendix Signer' },
  };
}

describe.runIf(RUN)('device appendix stamping (real DB) #3205 W07', () => {
  runDb('issueInvoice stamps the RESOLVED partner default onto invoices.device_appendix', async () => {
    for (const partnerDefault of [true, false]) {
      const f = await seedDraftInvoice({ invoiceDeviceAppendix: partnerDefault });
      await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
      const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
        .from(invoices).where(eq(invoices.id, f.invoiceId)));
      expect(inv!.a).toBe(partnerDefault);        // a concrete boolean, never NULL
    }
  });

  runDb('the quote-acceptance deposit invoice stamps it too (it never goes through issueInvoice)', async () => {
    const f = await seedAcceptableQuoteWithDeposit({ invoiceDeviceAppendix: true });
    const out = await withSystemDbAccessContext(() => acceptQuote(f.acceptance));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix, s: invoices.status })
      .from(invoices).where(eq(invoices.id, out.invoiceId)));
    expect(inv!.s).toBe('sent');
    expect(inv!.a).toBe(true);
  });

  runDb('a per-invoice override set on the DRAFT wins over the partner default at issue', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => db.update(invoices).set({ deviceAppendix: true })
      .where(eq(invoices.id, f.invoiceId)));
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(true);
  });

  runDb('flipping the partner default AFTER issue does not change the stamp', async () => {
    const f = await seedDraftInvoice({ invoiceDeviceAppendix: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, f.actor));
    await withSystemDbAccessContext(() => db.update(partners).set({ invoiceDeviceAppendix: true })
      .where(eq(partners.id, f.partnerId)));
    const [inv] = await withSystemDbAccessContext(() => db.select({ a: invoices.deviceAppendix })
      .from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(inv!.a).toBe(false);
  });
});
