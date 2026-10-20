/**
 * #8604 (feature #8601 W03) — invoice labor line itemization is FROZEN AT
 * ISSUE, the #3205 device-appendix rule: both issue writers stamp the resolved
 * values onto invoices.line_*, and every renderer of an issued invoice reads
 * only those columns. A partner changing its default later — or an invoice
 * issued before the columns existed — must never reflow a document the
 * customer already received.
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
import { getPortalInvoiceRowOr404, issueInvoice, updateInvoice, voidInvoice } from '../../services/invoiceService';
import { assembleCustomerInvoiceDocument } from '../../services/customerDocument';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { renderInvoicePdf } from '../../services/invoicePdf';
import { acceptQuote } from '../../services/quoteAcceptService';
import { sendQuote } from '../../services/quoteLifecycle';
import { addManualLine, createQuote, updateQuote } from '../../services/quoteService';
import type { QuoteActor } from '../../services/quoteTypes';
import { seedGateOrg } from './multiCurrencyWave6GateFixtures';
import { extractPositionedPdfText } from '../../testUtils/invoiceRenderFixtures';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);
const ACTOR: InvoiceActor = { userId: null, partnerId: null, accessibleOrgIds: null };

type PartnerDefaults = Partial<{
  invoiceLineGrouping: 'entry' | 'day'; invoiceLineShowDate: boolean;
  invoiceLineShowNote: boolean; invoiceLineShowWorkedTime: boolean;
}>;
type Override = Partial<{ lineGrouping: 'entry' | 'day' | null; lineShowDate: boolean | null; lineShowNote: boolean | null; lineShowWorkedTime: boolean | null }>;

/** A draft with one dated time-entry line (worked 110 min, billed 1.50 h). */
async function seedDraft(partnerDefaults: PartnerDefaults = {}, override: Override = {}, status: 'draft' | 'sent' = 'draft') {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `LD ${sfx}`, slug: `ld-${sfx}`, type: 'msp', plan: 'pro', status: 'active', ...partnerDefaults })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `LD Org ${sfx}`, slug: `ld-org-${sfx}` })
      .returning({ id: organizations.id });
    const [inv] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: o!.id, status, currencyCode: 'USD', ...override,
      ...(status === 'sent' ? { invoiceNumber: `LD-${sfx}`, issueDate: '2026-09-30', subtotal: '150.00', total: '150.00', balance: '150.00' } : {}),
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: o!.id, sourceType: 'time_entry', description: 'Diagnosed paper jam',
      quantity: '1.50', unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '150.00',
      workedMinutes: 110, workDate: '2026-09-16', sortOrder: 0,
    });
    return { invoiceId: inv!.id, partnerId: p!.id, orgId: o!.id };
  });
}

const frozen = (invoiceId: string) => withSystemDbAccessContext(async () => {
  const [row] = await db.select({
    lineGrouping: invoices.lineGrouping, lineShowDate: invoices.lineShowDate,
    lineShowNote: invoices.lineShowNote, lineShowWorkedTime: invoices.lineShowWorkedTime,
  }).from(invoices).where(eq(invoices.id, invoiceId));
  return row!;
});
const pdfText = async (invoiceId: string) => {
  const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(invoiceId));
  return extractPositionedPdfText(pdf).map((f) => f.text).join('|');
};
const setPartner = (partnerId: string, set: PartnerDefaults) =>
  withSystemDbAccessContext(() => db.update(partners).set(set).where(eq(partners.id, partnerId)));

describe.runIf(RUN)('invoice line detail — frozen at issue (#8604)', () => {
  runDb('issueInvoice stamps the RESOLVED partner default as concrete values', async () => {
    const f = await seedDraft({ invoiceLineGrouping: 'day', invoiceLineShowDate: true, invoiceLineShowNote: false, invoiceLineShowWorkedTime: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    expect(await frozen(f.invoiceId)).toEqual({ lineGrouping: 'day', lineShowDate: true, lineShowNote: false, lineShowWorkedTime: false });
  });

  runDb('a partner that never touched the setting freezes the defaults (today\'s document)', async () => {
    const f = await seedDraft();
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    expect(await frozen(f.invoiceId)).toEqual({ lineGrouping: 'entry', lineShowDate: false, lineShowNote: true, lineShowWorkedTime: true });
  });

  runDb('the draft override wins over the partner default at issue, field by field', async () => {
    const f = await seedDraft({ invoiceLineShowDate: false, invoiceLineShowNote: true }, { lineShowDate: true, lineGrouping: 'day' });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    expect(await frozen(f.invoiceId)).toEqual({ lineGrouping: 'day', lineShowDate: true, lineShowNote: true, lineShowWorkedTime: true });
    expect(await pdfText(f.invoiceId)).toContain('Sep 16, 2026');
  });

  runDb('FREEZE: changing the partner default after issue does not change a re-render', async () => {
    const f = await seedDraft({ invoiceLineShowDate: true });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    const before = await pdfText(f.invoiceId);
    expect(before).toContain('Sep 16, 2026');
    expect(before).toContain('Diagnosed paper jam');
    await setPartner(f.partnerId, { invoiceLineShowDate: false, invoiceLineShowNote: false, invoiceLineShowWorkedTime: false });
    const after = await pdfText(f.invoiceId);
    expect(after).toBe(before);
  });

  runDb('an invoice issued BEFORE the columns existed (NULLs) renders the default document, not the partner\'s new choice', async () => {
    const f = await seedDraft({ invoiceLineShowDate: true, invoiceLineShowNote: false, invoiceLineShowWorkedTime: false }, {}, 'sent');
    const text = await pdfText(f.invoiceId);
    expect(text).not.toContain('Sep 16, 2026');
    expect(text).toContain('Diagnosed paper jam');
    expect(text).toContain('1.83 h worked');
  });

  runDb('a DRAFT previews the partner\'s live default', async () => {
    const f = await seedDraft({ invoiceLineShowDate: true });
    expect(await pdfText(f.invoiceId)).toContain('Sep 16, 2026');
    await setPartner(f.partnerId, { invoiceLineShowDate: false });
    expect(await pdfText(f.invoiceId)).not.toContain('Sep 16, 2026');
  });

  runDb('the quote-acceptance invoice stamps it too (it never goes through issueInvoice)', async () => {
    const g = await seedGateOrg('USD');
    await setPartner(g.partnerId, { invoiceLineShowDate: true, invoiceLineGrouping: 'day', invoiceLineShowNote: false });
    const actor = { userId: g.userId, partnerId: g.partnerId, accessibleOrgIds: [g.orgId] } as QuoteActor;
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: g.orgId }, actor));
    await withSystemDbAccessContext(() => addManualLine(quote.id, {
      sourceType: 'manual', name: 'Deposit Line', description: 'Deposit Line', quantity: 1, unitPrice: 1000,
      taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: true,
    } as never, actor));
    await withSystemDbAccessContext(() => updateQuote(quote.id, { depositType: 'percent', depositPercent: 30 } as never, actor));
    await withSystemDbAccessContext(() => sendQuote(quote.id, actor));
    const out = await withSystemDbAccessContext(() => acceptQuote({ quoteId: quote.id, signerName: 'Line Detail Signer' }));
    expect(await frozen(out.invoiceId)).toEqual({ lineGrouping: 'day', lineShowDate: true, lineShowNote: false, lineShowWorkedTime: true });
  });

  runDb('void + reissue carries the frozen itemization onto the replacement draft', async () => {
    const f = await seedDraft({ invoiceLineShowDate: true, invoiceLineShowWorkedTime: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    await setPartner(f.partnerId, { invoiceLineShowDate: false, invoiceLineShowWorkedTime: true });
    await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'wrong rate', { reissue: true }, ACTOR));
    const [orig] = await withSystemDbAccessContext(() => db.select({ r: invoices.replacedByInvoiceId }).from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(await frozen(orig!.r!)).toEqual({ lineGrouping: 'entry', lineShowDate: true, lineShowNote: true, lineShowWorkedTime: false });
  });

  runDb('the draft PATCH sets and clears (null = inherit) the override; an issued invoice refuses it', async () => {
    const f = await seedDraft();
    await withSystemDbAccessContext(() => updateInvoice(f.invoiceId, { lineShowDate: true, lineGrouping: 'day' }, ACTOR));
    expect(await frozen(f.invoiceId)).toMatchObject({ lineShowDate: true, lineGrouping: 'day', lineShowNote: null });
    await withSystemDbAccessContext(() => updateInvoice(f.invoiceId, { lineShowDate: null, lineGrouping: null }, ACTOR));
    expect(await frozen(f.invoiceId)).toMatchObject({ lineShowDate: null, lineGrouping: null });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    await expect(withSystemDbAccessContext(() => updateInvoice(f.invoiceId, { lineShowDate: true }, ACTOR))).rejects.toThrow();
    expect(await frozen(f.invoiceId)).toMatchObject({ lineShowDate: false });
  });

  runDb('the customer payload (portal + public link) applies the frozen toggles server-side', async () => {
    const f = await seedDraft({ invoiceLineShowDate: true, invoiceLineGrouping: 'day', invoiceLineShowNote: false, invoiceLineShowWorkedTime: false });
    await withSystemDbAccessContext(() => issueInvoice(f.invoiceId, ACTOR));
    await setPartner(f.partnerId, { invoiceLineShowDate: false, invoiceLineShowNote: true, invoiceLineShowWorkedTime: true });
    const out = await withSystemDbAccessContext(async () =>
      assembleCustomerInvoiceDocument(await getPortalInvoiceRowOr404(f.invoiceId, f.orgId), 'portal'));
    expect(out.invoice.lineGrouping).toBe('day');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({ name: 'Labor', description: '', workedMinutes: null, workDate: '2026-09-16' });
    expect(JSON.stringify(out)).not.toContain('Diagnosed paper jam');
  });
});
