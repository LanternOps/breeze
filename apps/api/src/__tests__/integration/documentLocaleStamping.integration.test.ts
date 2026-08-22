import './setup';
import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';

// Lifecycle events + async PDF render are BullMQ side effects, not the snapshot
// semantics under test — stub them so no socket is opened to the test Redis.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, invoices, quotes } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { renderInvoicePdf } from '../../services/invoicePdf';
import { createQuote, addManualLine as addQuoteLine, cloneQuote } from '../../services/quoteService';
import { sendQuote, resendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import type { QuoteActor } from '../../services/quoteTypes';

const RUN = !!process.env.DATABASE_URL;

interface Fixture { partnerId: string; orgId: string; userId: string }

/** Disjoint tenant per test: pt-BR partner, BRL org. */
async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Loc ${suffix}`, slug: `loc-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'BRL', settings: { language: 'pt-BR' },
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Loc Org ${suffix}`, slug: `loc-org-${suffix}`, currencyCode: 'BRL',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

function invActor(f: Fixture): InvoiceActor { return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] }; }
function quoteActor(f: Fixture): QuoteActor { return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] }; }
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

async function setPartnerLanguage(partnerId: string, language: string) {
  await withSystemDbAccessContext(() => db.update(partners).set({ settings: { language } }).where(eq(partners.id, partnerId)));
}
async function invoiceLocale(id: string) {
  const [row] = await withSystemDbAccessContext(() => db.select({ documentLocale: invoices.documentLocale, status: invoices.status }).from(invoices).where(eq(invoices.id, id)));
  return row!;
}
async function quoteLocale(id: string) {
  const [row] = await withSystemDbAccessContext(() => db.select({ documentLocale: quotes.documentLocale, status: quotes.status }).from(quotes).where(eq(quotes.id, id)));
  return row!;
}

/** Create a BRL draft with a single 1000.00 manual line. */
async function draftInvoice(f: Fixture) {
  const a = invActor(f);
  const invoice = await withDbAccessContext(ctx(f), () => invoiceSvc.createManualInvoice({ orgId: f.orgId }, a));
  await withDbAccessContext(ctx(f), () => invoiceSvc.addManualLine(invoice.id, { description: 'Servico', quantity: 1, unitPrice: 1000, taxable: false }, a));
  return invoice.id;
}

// pdfkit writes Flate-compressed content streams with WinAnsi standard-font
// bytes; inflate + collect the string operands so locale assertions can be made
// on the human-readable text (same approach as quotePdf.test.ts). WinAnsi 0x80
// is "€" and Intl's no-break space lands as U+00A0 — fold both back.
function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  let out = '';
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + Number(match[1])), 'latin1');
    let body: string;
    try { body = zlib.inflateSync(compressed).toString('latin1'); } catch { continue; }
    const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(body))) {
      if (tm[1] !== undefined) {
        const hex = tm[1].length % 2 ? `${tm[1]}0` : tm[1];
        out += Buffer.from(hex, 'hex').toString('latin1');
      } else {
        out += tm[2]!.replace(/\\([()\\])/g, '$1');
      }
    }
    out += ' ';
  }
  return out.replace(/\u0080/g, '€').replace(/\u00a0/g, ' ');
}

/**
 * Multi-currency wave 5 (#3777): `document_locale` is stamped ONCE — at invoice
 * issue and quote first-send — from the partner's language, and never
 * restamped: a later partner-language change must not move an issued document,
 * and reissue/clone start from NULL so the new draft stamps at its own
 * issue/send. Quote accept issues the converted invoice inline and carries the
 * quote's stamp across (the same rule sellerSnapshot follows).
 */
describe.runIf(RUN)('document_locale stamping', () => {
  it('issueInvoice stamps the partner language, the stamp survives a later language change, and reissue starts from NULL', async () => {
    const f = await seedFixture();
    const id = await draftInvoice(f);
    expect((await invoiceLocale(id)).documentLocale).toBeNull();

    // (a) issue → pt-BR
    await withDbAccessContext(ctx(f), () => invoiceSvc.issueInvoice(id, invActor(f)));
    expect(await invoiceLocale(id)).toMatchObject({ status: 'sent', documentLocale: 'pt-BR' });

    // (b) partner flips to de-DE afterwards → the issued document still renders pt-BR
    await setPartnerLanguage(f.partnerId, 'de-DE');
    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(id));
    const text = extractPdfText(pdf);
    expect(text).toContain('R$ 1.000,00');
    expect(text).not.toContain('1.000,00 R$');
    expect((await invoiceLocale(id)).documentLocale).toBe('pt-BR');

    // (c) void + reissue → fresh draft carries NO locale; issuing it stamps the CURRENT language
    const { invoice: draft } = await withDbAccessContext(ctx(f), () => invoiceSvc.voidInvoice(id, 'redo', { reissue: true }, invActor(f)));
    expect(draft.id).not.toBe(id);
    expect(await invoiceLocale(draft.id)).toMatchObject({ status: 'draft', documentLocale: null });
    await withDbAccessContext(ctx(f), () => invoiceSvc.issueInvoice(draft.id, invActor(f)));
    expect((await invoiceLocale(draft.id)).documentLocale).toBe('de-DE');
    // the voided original is untouched
    expect((await invoiceLocale(id)).documentLocale).toBe('pt-BR');
  });

  it('sendQuote stamps the partner language; resend never restamps; clone starts from NULL', async () => {
    const f = await seedFixture();
    const a = quoteActor(f);
    const created = await withDbAccessContext(ctx(f), () => createQuote({ orgId: f.orgId, currencyCode: 'BRL' }, a));
    await withDbAccessContext(ctx(f), () => addQuoteLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 1000, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, a));
    expect((await quoteLocale(created.id)).documentLocale).toBeNull();

    // (d) send → pt-BR
    const sent = await withDbAccessContext(ctx(f), () => sendQuote(created.id, a));
    expect(sent.quote.documentLocale).toBe('pt-BR'); // the post-send re-select carries it
    expect(await quoteLocale(created.id)).toMatchObject({ status: 'sent', documentLocale: 'pt-BR' });

    // partner flips to de-DE → resend leaves the stamp alone
    await setPartnerLanguage(f.partnerId, 'de-DE');
    await withDbAccessContext(ctx(f), () => resendQuote(created.id, a));
    expect((await quoteLocale(created.id)).documentLocale).toBe('pt-BR');

    // clone → NULL (stamps fresh at its own send, now de-DE)
    const clone = await withDbAccessContext(ctx(f), () => cloneQuote(created.id, a));
    expect(await quoteLocale(clone.id)).toMatchObject({ status: 'draft', documentLocale: null });
    await withDbAccessContext(ctx(f), () => sendQuote(clone.id, a));
    expect((await quoteLocale(clone.id)).documentLocale).toBe('de-DE');
    expect((await quoteLocale(created.id)).documentLocale).toBe('pt-BR');
  });

  it("accept issues the converted invoice with the QUOTE's stamp, not the partner's current language", async () => {
    const f = await seedFixture();
    const a = quoteActor(f);
    const created = await withDbAccessContext(ctx(f), () => createQuote({ orgId: f.orgId, currencyCode: 'BRL' }, a));
    await withDbAccessContext(ctx(f), () => addQuoteLine(created.id, { sourceType: 'manual', description: 'Onboarding', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, a));
    await withDbAccessContext(ctx(f), () => sendQuote(created.id, a));
    expect((await quoteLocale(created.id)).documentLocale).toBe('pt-BR');

    // (e) language changes between send and accept
    await setPartnerLanguage(f.partnerId, 'de-DE');
    const res = await withDbAccessContext(ctx(f), () => acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer' }));
    expect(res.invoiceIssued).toBe(true);
    expect(await invoiceLocale(res.invoiceId)).toMatchObject({ status: 'sent', documentLocale: 'pt-BR' });
  });
});
