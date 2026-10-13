// Shared fixtures for the invoice renderer tests (#8604): the golden
// byte-identity test and the line-detail tests render the SAME invoice, so a
// default-settings render can be compared against the snapshot taken on the
// pre-#8604 renderer.
import zlib from 'node:zlib';
import type { invoices, invoiceLines } from '../db/schema';
import type { InvoiceBranding } from '../services/invoicePdf';

export type FixtureInvoiceRow = typeof invoices.$inferSelect;
export type FixtureInvoiceLineRow = typeof invoiceLines.$inferSelect & {
  ticketNumber?: string | null;
  ticketSubject?: string | null;
  ticketCategory?: string | null;
};

export function makeFixtureInvoice(overrides: Partial<FixtureInvoiceRow> = {}): FixtureInvoiceRow {
  return {
    id: 'inv-golden',
    partnerId: 'p-1',
    orgId: 'o-1',
    siteId: null,
    invoiceNumber: 'INV-2026-0042',
    status: 'sent',
    currencyCode: 'USD',
    issueDate: '2026-09-30',
    dueDate: '2026-10-30',
    subtotal: '595.00',
    taxRate: '0.085',
    taxTotal: '8.50',
    total: '603.50',
    amountPaid: '0.00',
    balance: '603.50',
    billToName: 'An hourly client',
    billToAddress: { line1: '1 Example Way', city: 'Springfield', region: 'IL', postalCode: '62704', country: 'US' },
    billToTaxId: null,
    billToTaxExempt: false,
    notes: 'Thanks for your business',
    terms: 'Net 30.',
    ...overrides,
  } as unknown as FixtureInvoiceRow;
}

let lineSeq = 0;
export function makeFixtureLine(overrides: Partial<FixtureInvoiceLineRow> = {}): FixtureInvoiceLineRow {
  lineSeq += 1;
  return {
    id: `line-${lineSeq}`,
    invoiceId: 'inv-golden',
    orgId: 'o-1',
    sourceType: 'manual',
    sourceId: null,
    catalogItemId: null,
    parentLineId: null,
    ticketId: null,
    name: null,
    description: 'Consulting',
    quantity: '1.00',
    unitPrice: '100.00',
    costBasis: null,
    revenueAllocation: null,
    taxable: false,
    customerVisible: true,
    lineTotal: '100.00',
    isUnapprovedTime: false,
    workedMinutes: null,
    workDate: null,
    sortOrder: 0,
    ...overrides,
  } as unknown as FixtureInvoiceLineRow;
}

/** The golden invoice's lines, in stored order. Covers: two dated time-entry
 *  lines on one ticket (one with worked ≠ billed), a dated time-entry line on a
 *  later day listed FIRST (so day grouping must reorder), a hidden line, a
 *  taxable part, a manual line, and the aggregated block-hours overage line
 *  (source_type 'contract', no date). */
export function goldenLines(): FixtureInvoiceLineRow[] {
  const ticket = { ticketId: 't-1', ticketNumber: '1042', ticketSubject: 'Printer offline', ticketCategory: 'Hardware' };
  return [
    makeFixtureLine({ ...ticket, sourceType: 'time_entry', sourceId: 'te-3', description: 'Replaced fuser unit', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', workedMinutes: 60, workDate: '2026-09-17', sortOrder: 0 }),
    makeFixtureLine({ ...ticket, sourceType: 'time_entry', sourceId: 'te-1', description: 'Diagnosed paper jam', quantity: '1.50', unitPrice: '100.00', lineTotal: '150.00', workedMinutes: 110, workDate: '2026-09-16', sortOrder: 1 }),
    makeFixtureLine({ ...ticket, sourceType: 'time_entry', sourceId: 'te-2', description: 'Tested print queue', quantity: '0.50', unitPrice: '100.00', lineTotal: '50.00', workedMinutes: 30, workDate: '2026-09-16', sortOrder: 2 }),
    makeFixtureLine({ ...ticket, sourceType: 'time_entry', sourceId: 'te-h', description: 'Internal follow-up', quantity: '0.25', unitPrice: '100.00', lineTotal: '0.00', workedMinutes: 15, workDate: '2026-09-16', customerVisible: false, sortOrder: 3 }),
    makeFixtureLine({ ...ticket, sourceType: 'part', sourceId: 'tp-1', description: 'Fuser unit', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true, sortOrder: 4 }),
    makeFixtureLine({ sourceType: 'manual', name: 'Onsite visit', description: 'Travel and setup', quantity: '1.00', unitPrice: '75.00', lineTotal: '75.00', sortOrder: 5 }),
    makeFixtureLine({ sourceType: 'contract', description: 'Block hours overage', quantity: '1.20', unitPrice: '100.00', lineTotal: '120.00', sortOrder: 6 }),
  ];
}

export const fixtureBranding: InvoiceBranding = {
  partnerName: 'Example MSP',
  logoUrl: null,
  primaryColor: '#0ea5e9',
  footerText: 'Powered by Example',
  currencyCode: 'USD',
};

/** Inflate pdfkit's flate content streams and decode each BT…ET text object to
 *  {text, x, y} (WinAnsi bytes → latin1). Same decoder as invoicePdf.test.ts.
 *  `page` is the 0-based content-stream index (one per page for these docs). */
export function extractPositionedPdfText(pdf: Buffer): { text: string; x: number; y: number; page: number }[] {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  const fragments: { text: string; x: number; y: number; page: number }[] = [];
  let match: RegExpExecArray | null;
  let page = -1;
  while ((match = headerRe.exec(raw))) {
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + Number(match[1])), 'latin1');
    let body: string;
    try { body = zlib.inflateSync(compressed).toString('latin1'); } catch { continue; }
    if (!/BT\s/.test(body)) continue;
    page += 1;
    const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
    let textObject: RegExpExecArray | null;
    while ((textObject = textObjectRe.exec(body))) {
      const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(textObject[1]!);
      if (!tm) continue;
      let text = '';
      const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
      let token: RegExpExecArray | null;
      while ((token = tokenRe.exec(textObject[1]!))) {
        text += token[1] !== undefined
          ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
          : token[2]!.replace(/\\([()\\])/g, '$1');
      }
      if (text) fragments.push({ text, x: Number(tm[1]), y: Number((841.89 - Number(tm[2])).toFixed(3)), page });
    }
  }
  return fragments;
}

/** pdfkit page count from the page tree. */
export function pdfPageCount(pdf: Buffer): number {
  const m = /\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(pdf.toString('latin1'));
  return m ? Number(m[1]) : 0;
}
