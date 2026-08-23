import './setup';

import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// Lifecycle events + async PDF render are BullMQ side effects, not the render
// semantics under test — stub them so no socket is opened to the test Redis
// (same discipline as documentLocaleStamping.integration.test.ts).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { formatMoney } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { invoiceDocuments, invoices, partners, quotes } from '../../db/schema';
import { addManualLine, createManualInvoice, issueInvoice } from '../../services/invoiceService';
import { renderInvoicePdf } from '../../services/invoicePdf';
import { formatMoneyForPdf, isWinAnsiSafe } from '../../services/pdfMoney';
import { resolveQuoteBranding } from '../../services/quoteBranding';
import { sendQuote } from '../../services/quoteLifecycle';
import { addManualLine as addQuoteLine, createQuote, getQuote } from '../../services/quoteService';
import { renderQuotePdf } from '../../services/quotePdf';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

/**
 * Verbatim copy of the extractor in
 * `apps/api/src/__tests__/integration/documentLocaleStamping.integration.test.ts:74-96`
 * (it is not exported there). pdfkit writes Flate-compressed content streams
 * with WinAnsi standard-font bytes; inflate + collect the string operands so
 * locale/currency assertions can be made on the human-readable text. WinAnsi
 * 0x80 is "€" and Intl's no-break space lands as U+00A0 — fold both back.
 */
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

/** The extractor folds NBSP to a plain space; fold every width-bearing Unicode
 *  space in an EXPECTED string the same way so containment is comparable. */
function normalizeSpaces(text: string): string {
  return text.replace(/[\u2007\u2009\u200a\u202f\u00a0]/g, ' ');
}

function assertionMessage(
  transition: string, currency: string, subject: string, expected: unknown, actual: unknown,
): string {
  return `${transition}; currency=${currency}; subject=${subject}; expected=${String(expected)}; actual=${String(actual)}`;
}

async function setPartnerLanguage(partnerId: string, language: string): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(partners).set({ settings: { language } }).where(eq(partners.id, partnerId)));
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      currencyCode: invoices.currencyCode,
      total: invoices.total,
      documentLocale: invoices.documentLocale,
      pdfDocumentRef: invoices.pdfDocumentRef,
      pdfSha256: invoices.pdfSha256,
    })
    .from(invoices).where(eq(invoices.id, invoiceId)));
  return row;
}

async function readInvoiceDocuments(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: invoiceDocuments.id, sha256: invoiceDocuments.sha256 })
    .from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, invoiceId)));
}

async function readQuote(quoteId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ documentLocale: quotes.documentLocale, currencyCode: quotes.currencyCode, status: quotes.status })
    .from(quotes).where(eq(quotes.id, quoteId)));
  return row;
}

/** Issue a single-line invoice for `unitPrice` in the fixture's currency. */
async function issuedInvoice(fixture: GateOrgFixture, unitPrice: number): Promise<string> {
  const created = await withSystemDbAccessContext(() =>
    createManualInvoice({ orgId: fixture.orgId }, fixture.actor));
  await withSystemDbAccessContext(() => addManualLine(created.id, {
    name: 'Managed services', quantity: 1, unitPrice, taxable: false,
  }, fixture.actor));
  await withSystemDbAccessContext(() => issueInvoice(created.id, fixture.actor));
  return created.id;
}

/** Send a single-line quote for `unitPrice` in the fixture's currency. */
async function sentQuote(fixture: GateOrgFixture, unitPrice: number): Promise<string> {
  const created = await withSystemDbAccessContext(() =>
    createQuote({ orgId: fixture.orgId }, fixture.actor));
  await withSystemDbAccessContext(() => addQuoteLine(created.id, {
    sourceType: 'manual',
    description: 'Managed services',
    quantity: 1,
    unitPrice,
    taxable: false,
    customerVisible: true,
    recurrence: 'one_time',
  } as never, fixture.actor));
  await withSystemDbAccessContext(() => sendQuote(created.id, fixture.actor));
  return created.id;
}

/** Drive renderQuotePdf exactly the way `GET /quotes/:id/pdf`
 *  (`apps/api/src/routes/quotes/quotes.ts` :308-362) does, minus the image and
 *  contract-template loaders no fixture quote here uses. */
async function renderSentQuotePdf(quoteId: string, fixture: GateOrgFixture): Promise<Buffer> {
  return withSystemDbAccessContext(async () => {
    const { quote, blocks, lines, billTo } = await getQuote(quoteId, fixture.actor);
    const branding = await resolveQuoteBranding(quote);
    const quoteForRender = {
      ...quote,
      sellerSnapshot: branding.seller,
      billToName: billTo?.name ?? quote.billToName,
      billToAddress: billTo?.address ?? quote.billToAddress,
      billToTaxId: billTo?.taxId ?? quote.billToTaxId,
    };
    return renderQuotePdf(quoteForRender, blocks, lines, async () => null, branding);
  });
}

/**
 * Wave-6 gate slice G7 (#3778) — PDF render on a non-default-currency org.
 *
 * Properties under test: a server-rendered document snapshots its render locale
 * at issue/send and NEVER re-resolves it from the partner's current language;
 * money glyphs come from the shared formatter in that stamped locale; a
 * zero-decimal currency shows no fraction and no 100x inflation; and a symbol
 * pdfkit's WinAnsi standard fonts cannot encode degrades to the ISO-code form in
 * the SAME locale rather than to mojibake.
 */
describe.runIf(RUN)(gateLabel('G7', 'invoice + quote PDF render'), () => {
  it('renders and persists a EUR invoice PDF in the stamped de-DE locale after the partner language moves', async () => {
    const fixture = await seedGateOrg('EUR', { partnerLanguage: 'de-DE' });
    const invoiceId = await issuedInvoice(fixture, 1000);

    // The partner switches language AFTER issue — the stamp must win.
    await setPartnerLanguage(fixture.partnerId, 'fr-FR');

    const { documentId, sha256, pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(invoiceId));

    expect(
      pdf.subarray(0, 4).toString('latin1'),
      assertionMessage('renderInvoicePdf', 'EUR', 'pdf magic', '%PDF', pdf.subarray(0, 4).toString('latin1')),
    ).toBe('%PDF');

    const row = await readInvoice(invoiceId);
    const docs = await readInvoiceDocuments(invoiceId);
    expect(
      docs.length,
      assertionMessage('renderInvoicePdf', 'EUR', 'invoice_documents rows', 1, docs.length),
    ).toBe(1);
    expect(
      row?.pdfDocumentRef,
      assertionMessage('renderInvoicePdf', 'EUR', 'invoices.pdf_document_ref', docs[0]?.id, row?.pdfDocumentRef),
    ).toBe(docs[0]?.id);
    expect(
      row?.pdfDocumentRef,
      assertionMessage('renderInvoicePdf', 'EUR', 'returned documentId', documentId, row?.pdfDocumentRef),
    ).toBe(documentId);
    expect(
      row?.pdfSha256,
      assertionMessage('renderInvoicePdf', 'EUR', 'invoices.pdf_sha256', '64 hex chars', row?.pdfSha256),
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      row?.pdfSha256,
      assertionMessage('renderInvoicePdf', 'EUR', 'sha256 agreement', sha256, row?.pdfSha256),
    ).toBe(sha256);
    expect(
      docs[0]?.sha256,
      assertionMessage('renderInvoicePdf', 'EUR', 'invoice_documents.sha256', sha256, docs[0]?.sha256),
    ).toBe(sha256);
    expect(
      row?.documentLocale,
      assertionMessage('renderInvoicePdf', 'EUR', 'invoices.document_locale', 'de-DE (stamp, not fr-FR)', row?.documentLocale),
    ).toBe('de-DE');

    const text = normalizeSpaces(extractPdfText(pdf));
    const expectedMoney = normalizeSpaces(formatMoney('1000.00', 'EUR', 'de-DE'));
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'EUR', 'rendered money string', expectedMoney, 'see extracted text'),
    ).toContain(expectedMoney);
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'EUR', 'foreign currency symbol', 'no "$"', 'see extracted text'),
    ).not.toContain('$');
  });

  it('renders a zero-decimal JPY invoice with no fraction and no 100x inflation', async () => {
    const fixture = await seedGateOrg('JPY', { partnerLanguage: 'de-DE' });
    const invoiceId = await issuedInvoice(fixture, 1000);

    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(invoiceId));
    const row = await readInvoice(invoiceId);
    expect(
      row?.documentLocale,
      assertionMessage('renderInvoicePdf', 'JPY', 'invoices.document_locale', 'de-DE', row?.documentLocale),
    ).toBe('de-DE');

    const text = normalizeSpaces(extractPdfText(pdf));
    const expectedMoney = normalizeSpaces(formatMoney('1000.00', 'JPY', 'de-DE'));
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'JPY', 'rendered money string', expectedMoney, 'see extracted text'),
    ).toContain(expectedMoney);
    // Zero-decimal: the drawn string carries no minor-unit fraction, and no 100x
    // inflation (the classic minor-unit bug: 1000 JPY drawn as 100.000).
    expect(
      expectedMoney,
      assertionMessage('renderInvoicePdf', 'JPY', 'expected string has no fraction', 'no ",00"/".00"', expectedMoney),
    ).not.toMatch(/[.,]\d{2}(\D|$)/);
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'JPY', '100x inflation', 'no "100.000"', 'see extracted text'),
    ).not.toContain('100.000');
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'JPY', 'foreign currency symbol', 'no "$"', 'see extracted text'),
    ).not.toContain('$');
  });

  it('falls back to the ISO-code form in the document locale for a non-WinAnsi symbol (TRY)', async () => {
    const fixture = await seedGateOrg('TRY', { partnerLanguage: 'tr-TR' });
    const invoiceId = await issuedInvoice(fixture, 1000);

    const { pdf } = await withSystemDbAccessContext(() => renderInvoicePdf(invoiceId));
    const row = await readInvoice(invoiceId);
    expect(
      row?.documentLocale,
      assertionMessage('renderInvoicePdf', 'TRY', 'invoices.document_locale', 'tr-TR', row?.documentLocale),
    ).toBe('tr-TR');

    // Precondition for this test to mean anything: the symbol form really is
    // unrepresentable, so formatMoneyForPdf must have taken the code branch.
    const symbolForm = formatMoney('1000.00', 'TRY', 'tr-TR');
    expect(
      isWinAnsiSafe(symbolForm),
      assertionMessage('formatMoneyForPdf precondition', 'TRY', 'symbol form WinAnsi-safe', false, isWinAnsiSafe(symbolForm)),
    ).toBe(false);

    const expectedMoney = normalizeSpaces(formatMoneyForPdf('1000.00', 'TRY', 'tr-TR'));
    const text = normalizeSpaces(extractPdfText(pdf));
    expect(
      expectedMoney,
      assertionMessage('formatMoneyForPdf', 'TRY', 'code form carries the ISO code', 'TRY', expectedMoney),
    ).toContain('TRY');
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'TRY', 'ISO-code money string', expectedMoney, 'see extracted text'),
    ).toContain(expectedMoney);
    expect(
      text,
      assertionMessage('renderInvoicePdf', 'TRY', 'mojibake lira glyph', 'no U+20BA in the drawn text', 'see extracted text'),
    ).not.toContain('₺');
  });

  it('renders a EUR quote PDF in the stamped de-DE locale after the partner language moves', async () => {
    const fixture = await seedGateOrg('EUR', { partnerLanguage: 'de-DE' });
    const quoteId = await sentQuote(fixture, 1000);

    const sent = await readQuote(quoteId);
    expect(
      sent?.currencyCode,
      assertionMessage('sendQuote', 'EUR', 'quotes.currency_code', 'EUR', sent?.currencyCode),
    ).toBe('EUR');
    expect(
      sent?.documentLocale,
      assertionMessage('sendQuote', 'EUR', 'quotes.document_locale', 'de-DE', sent?.documentLocale),
    ).toBe('de-DE');

    await setPartnerLanguage(fixture.partnerId, 'fr-FR');
    const pdf = await renderSentQuotePdf(quoteId, fixture);

    expect(
      pdf.subarray(0, 4).toString('latin1'),
      assertionMessage('renderQuotePdf', 'EUR', 'pdf magic', '%PDF', pdf.subarray(0, 4).toString('latin1')),
    ).toBe('%PDF');
    const afterRender = await readQuote(quoteId);
    expect(
      afterRender?.documentLocale,
      assertionMessage('renderQuotePdf', 'EUR', 'quotes.document_locale after render', 'de-DE (never restamped)', afterRender?.documentLocale),
    ).toBe('de-DE');

    const text = normalizeSpaces(extractPdfText(pdf));
    const expectedMoney = normalizeSpaces(formatMoney('1000.00', 'EUR', 'de-DE'));
    expect(
      text,
      assertionMessage('renderQuotePdf', 'EUR', 'rendered money string', expectedMoney, 'see extracted text'),
    ).toContain(expectedMoney);
    expect(
      text,
      assertionMessage('renderQuotePdf', 'EUR', 'foreign currency symbol', 'no "$"', 'see extracted text'),
    ).not.toContain('$');
  });

  it('renders a zero-decimal JPY quote PDF with no fraction and no 100x inflation', async () => {
    const fixture = await seedGateOrg('JPY', { partnerLanguage: 'de-DE' });
    const quoteId = await sentQuote(fixture, 1000);

    const pdf = await renderSentQuotePdf(quoteId, fixture);
    expect(
      pdf.subarray(0, 4).toString('latin1'),
      assertionMessage('renderQuotePdf', 'JPY', 'pdf magic', '%PDF', pdf.subarray(0, 4).toString('latin1')),
    ).toBe('%PDF');
    const afterRender = await readQuote(quoteId);
    expect(
      afterRender?.documentLocale,
      assertionMessage('renderQuotePdf', 'JPY', 'quotes.document_locale', 'de-DE', afterRender?.documentLocale),
    ).toBe('de-DE');

    const text = normalizeSpaces(extractPdfText(pdf));
    const expectedMoney = normalizeSpaces(formatMoney('1000.00', 'JPY', 'de-DE'));
    expect(
      text,
      assertionMessage('renderQuotePdf', 'JPY', 'rendered money string', expectedMoney, 'see extracted text'),
    ).toContain(expectedMoney);
    expect(
      text,
      assertionMessage('renderQuotePdf', 'JPY', '100x inflation', 'no "100.000"', 'see extracted text'),
    ).not.toContain('100.000');
    expect(
      text,
      assertionMessage('renderQuotePdf', 'JPY', 'foreign currency symbol', 'no "$"', 'see extracted text'),
    ).not.toContain('$');
  });
});
