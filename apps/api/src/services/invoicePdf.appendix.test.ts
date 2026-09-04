/**
 * #3205 W07 — the appendix is drawn by the PURE renderer from a prepared
 * structure. No DB here; the gate and the SQL filter are covered by the
 * integration suite.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { renderInvoicePdfBuffer, APPENDIX_ROW_CAP, type InvoiceBranding, type InvoiceDeviceAppendix } from './invoicePdf';
import { invoices, invoiceLines } from '../db/schema';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

// The brief names a shared invoicePdf fixture module, but this worktree has no
// such file and the operating contract does not authorize creating it. Keep the
// minimal fixtures local to this newly-created test instead.
const INVOICE_FIXTURE = {
  id: 'inv-appendix', partnerId: 'partner-appendix', orgId: 'org-appendix',
  invoiceNumber: 'INV-APPENDIX', status: 'sent', currencyCode: 'USD',
  issueDate: '2026-09-03', dueDate: '2026-10-03', subtotal: '100.00',
  taxRate: '0', taxTotal: '0.00', total: '100.00', amountPaid: '0.00',
  balance: '100.00', billToName: 'Appendix Customer', billToAddress: null,
  billToTaxId: null, notes: null, terms: null,
} as unknown as InvoiceRow;

const LINES_FIXTURE = [{
  id: 'line-appendix', invoiceId: 'inv-appendix', orgId: 'org-appendix',
  sourceType: 'manual', sourceId: null, catalogItemId: null, parentLineId: null,
  ticketId: null, description: 'Managed devices', quantity: '1', unitPrice: '100.00',
  costBasis: null, revenueAllocation: null, taxable: false, customerVisible: true,
  lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 0,
}] as unknown as InvoiceLineRow[];

const BRANDING_FIXTURE: InvoiceBranding = {
  partnerName: 'Appendix MSP', logoUrl: null, primaryColor: '#2563eb',
  footerText: null, currencyCode: 'USD',
};

// pdfkit Flate-compresses its page streams, so assertions must inspect decoded
// show-text operands rather than grepping the raw PDF container bytes.
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
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(body))) {
      out += token[1] !== undefined
        ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
        : token[2]!.replace(/\\([()\\])/g, '$1');
    }
    out += ' ';
  }
  return out;
}

const text = async (appendix?: InvoiceDeviceAppendix | null) =>
  extractPdfText(await renderInvoicePdfBuffer(INVOICE_FIXTURE, LINES_FIXTURE, BRANDING_FIXTURE, appendix));

const dev = (hostname: string, countedAs: 'included' | 'overage' = 'included') =>
  ({ hostname, deviceRole: 'server', countedAs });

describe('renderInvoicePdfBuffer device appendix (#3205 W07)', () => {
  it('the existing three-argument call still produces a %PDF- buffer with no appendix', async () => {
    const buf = await renderInvoicePdfBuffer(INVOICE_FIXTURE, LINES_FIXTURE, BRANDING_FIXTURE);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(extractPdfText(buf)).not.toContain('Billed devices');
  });

  it('null / empty appendix draws nothing', async () => {
    expect(await text(null)).not.toContain('Billed devices');
    expect(await text({ lines: [], omitted: 0 })).not.toContain('Billed devices');
  });

  it('draws a heading per invoice line and a row per device', async () => {
    const out = await text({ lines: [
      { lineId: 'l1', description: 'Endpoints', devices: [dev('alpha-01'), dev('beta-02')] },
      { lineId: 'l2', description: 'Servers', devices: [dev('srv-01')] },
    ], omitted: 0 });
    expect(out).toContain('Billed devices');
    expect(out).toContain('Endpoints');
    expect(out).toContain('alpha-01');
    expect(out).toContain('beta-02');
    expect(out).toContain('Servers');
    expect(out).toContain('srv-01');
  });

  it('labels overage rows without implying they were free', async () => {
    const out = await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: [dev('over-01', 'overage')] }], omitted: 0 });
    expect(out).toContain('Overage');
  });

  it('emits the truncation line when omitted > 0, and not otherwise', async () => {
    const many = Array.from({ length: APPENDIX_ROW_CAP }, (_, i) => dev(`h-${i}`));
    expect(await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: many }], omitted: 0 }))
      .not.toContain('more devices');
    expect(await text({ lines: [{ lineId: 'l1', description: 'Endpoints', devices: many }], omitted: 37 }))
      .toContain('37 more devices');
  }, 30_000);

  it('reports the number of rows actually printed for a partially capped line', async () => {
    const out = (await text({
      lines: [{ lineId: 'l1', description: 'Servers', devices: [dev('srv-printed')] }],
      omitted: 37,
    })).replace(/\x97/g, '—');
    expect(out).toContain('Servers — 1');
    expect(out).not.toContain('Servers — 38');
  });
});
