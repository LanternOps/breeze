/**
 * #9402 W1b — the customer-document assembler, per mode. The DB is the
 * table-keyed stand-in, so hidden-line ABSENCE cannot be proven here (the
 * filter is SQL): these tests prove the filter is IN the query (rendered SQL),
 * and customerDocument.integration.test.ts proves it on Postgres.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    ctx: 'caller' as string,
    rows: {} as Record<string, readonly Record<string, unknown>[] | Error>,
    db: null as null | import('../__tests__/helpers/tableKeyedDb').TableKeyedDb,
  },
}));
vi.mock('../db', async () => {
  const { createTableKeyedDb } = await import('../__tests__/helpers/tableKeyedDb');
  state.db = createTableKeyedDb(() => state.rows, () => state.ctx);
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      const prev = state.ctx;
      state.ctx = 'system';
      try { return await fn(); } finally { state.ctx = prev; }
    },
  };
});

import {
  assembleCustomerInvoiceDocument, loadCustomerDocumentBranding, invoiceDisplayStatus,
  CustomerDocumentModeError, OD9_CUSTOMER_PROJECTION,
} from './customerDocument';
import { renderSql } from '../__tests__/helpers/tableKeyedDb';
import {
  PIN_INVOICE_ROW, PIN_PARTNER_ROW, PIN_BRANDING_ROW, PIN_VISIBLE_LINE_ROWS, PIN_VISIBLE_LINE_IDS, PIN_LINE_IDS, PIN_ORG_ID, PIN_INVOICE_ID,
} from '../routes/__fixtures__/customerInvoicePin';
import type { InvoiceRow } from './customerDocument';

const MODES = ['public', 'portal', 'staff'] as const;
const row = (patch: Record<string, unknown> = {}) => ({ ...PIN_INVOICE_ROW, ...patch }) as unknown as InvoiceRow;
const DRAFT = row({
  status: 'draft', invoiceNumber: null, issueDate: null, dueDate: null,
  lineGrouping: null, lineShowDate: null, lineShowNote: null, lineShowWorkedTime: null,
  documentTheme: null, documentPageSize: null, documentLocale: null,
});
const NOTE = 'Diagnosed the print spooler';

function setRows(patch: Record<string, readonly Record<string, unknown>[] | Error> = {}) {
  state.rows = {
    invoices: [PIN_INVOICE_ROW],
    invoice_lines: PIN_VISIBLE_LINE_ROWS,
    partners: [PIN_PARTNER_ROW],
    portal_branding: [PIN_BRANDING_ROW],
    ...patch,
  };
}

const lineSelect = () => {
  const s = state.db!.selects.filter((x) => x.table === 'invoice_lines');
  expect(s).toHaveLength(1);
  return s[0]!;
};

beforeEach(() => {
  state.ctx = 'caller';
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
  setRows();
});

describe.each(MODES)('%s mode', (mode) => {
  it('the line query carries customerVisible, invoiceId and orgId; the ticket join is org-scoped and skips deleted tickets', async () => {
    const doc = await assembleCustomerInvoiceDocument(row(), mode);
    expect(doc.lines.map((l) => l.id)).toEqual(PIN_VISIBLE_LINE_IDS);
    const { where, joins } = lineSelect();
    const w = renderSql(where);
    expect(w.sql).toMatch(/"invoice_lines"\."customer_visible" = \$\d/);
    expect(w.sql).toMatch(/"invoice_lines"\."org_id" = \$\d/);
    expect(w.sql).toMatch(/"invoice_lines"\."invoice_id" = \$\d/);
    expect(w.params).toEqual(expect.arrayContaining([true, PIN_ORG_ID, PIN_INVOICE_ID]));
    expect(w.sql).not.toMatch(/\bor\b/i); // a disjunction could widen the filter
    expect(joins).toHaveLength(1);
    expect(joins[0]!.table).toBe('tickets');
    const on = renderSql(joins[0]!.on);
    expect(on.sql).toMatch(/"tickets"\."org_id" = \$\d/);
    expect(on.sql).toMatch(/"tickets"\."deleted_at" is null/);
    expect(on.params).toContain(PIN_ORG_ID);
  });

  it('a void invoice assembles with displayStatus void and its lines (Review Focus 3)', async () => {
    const doc = await assembleCustomerInvoiceDocument(row({ status: 'void' }), mode);
    expect(doc.invoice.status).toBe('void');
    expect(doc.invoice.displayStatus).toBe('void');
    expect(doc.lines).toHaveLength(2);
  });

  it('partner-axis reads run in the system context; portal_branding runs in the caller context', async () => {
    await assembleCustomerInvoiceDocument(row(), mode);
    const partnerReads = state.db!.selects.filter((s) => s.table === 'partners');
    expect(partnerReads.length).toBeGreaterThan(0);
    expect(partnerReads.every((s) => s.ctx === 'system')).toBe(true);
    const brandReads = state.db!.selects.filter((s) => s.table === 'portal_branding');
    expect(brandReads).toHaveLength(1);
    expect(brandReads[0]!.ctx).toBe('caller');
  });
});

describe('assembleCustomerInvoiceDocument', () => {
  it('a draft is accepted in staff mode only', async () => {
    await expect(assembleCustomerInvoiceDocument(DRAFT, 'public')).rejects.toBeInstanceOf(CustomerDocumentModeError);
    await expect(assembleCustomerInvoiceDocument(DRAFT, 'portal')).rejects.toBeInstanceOf(CustomerDocumentModeError);
    await expect(assembleCustomerInvoiceDocument(DRAFT, 'staff')).resolves.toMatchObject({ invoice: { status: 'draft', displayStatus: null } });
  });

  it('a refused draft reads nothing (the mode check runs before any query)', async () => {
    await expect(assembleCustomerInvoiceDocument(DRAFT, 'public')).rejects.toThrow();
    expect(state.db!.reads).toEqual([]);
  });

  it('staff mode resolves draft defaults before projection (partner showNote=false withholds the note) — Review Focus 2', async () => {
    setRows({ partners: [{ ...PIN_PARTNER_ROW, invoiceLineShowNote: false }] });
    const doc = await assembleCustomerInvoiceDocument(DRAFT, 'staff');
    const te = doc.lines.find((l) => l.id === PIN_LINE_IDS.timeEntry)!;
    expect(te.name).toBe('Labor');
    expect(te.description).toBe('');
    expect(JSON.stringify(doc)).not.toContain(NOTE);
  });

  it('a draft with partner showNote=true keeps the note (the resolver, not a hard-coded withhold)', async () => {
    const doc = await assembleCustomerInvoiceDocument(DRAFT, 'staff');
    expect(doc.lines.find((l) => l.id === PIN_LINE_IDS.timeEntry)!.description).toBe(NOTE);
  });

  it('an issued invoice uses its frozen columns even in staff mode (partner defaults ignored)', async () => {
    setRows({ partners: [{ ...PIN_PARTNER_ROW, invoiceLineShowNote: false, invoiceLineShowDate: false }] });
    const doc = await assembleCustomerInvoiceDocument(row(), 'staff');
    const te = doc.lines.find((l) => l.id === PIN_LINE_IDS.timeEntry)!;
    expect(te.description).toBe(NOTE);
    expect(te.workDate).toBe('2026-02-26');
  });

  it('an issued invoice with lineShowNote=false withholds the note in every mode', async () => {
    for (const mode of MODES) {
      const doc = await assembleCustomerInvoiceDocument(row({ lineShowNote: false }), mode);
      expect(JSON.stringify(doc)).not.toContain(NOTE);
      expect(doc.lines.find((l) => l.id === PIN_LINE_IDS.timeEntry)!.name).toBe('Labor');
    }
  });

  it('OD-9 screen: no ticketSubject / isChild keys on any line', async () => {
    const doc = await assembleCustomerInvoiceDocument(row(), 'portal');
    for (const l of doc.lines) {
      expect(l).not.toHaveProperty('ticketSubject');
      expect(l).not.toHaveProperty('isChild');
    }
    const explicit = await assembleCustomerInvoiceDocument(row(), 'portal', { surface: 'screen' });
    expect(explicit).toEqual(doc);
  });

  it('OD-9 pdf surface: ticketSubject present, isChild absent', async () => {
    const doc = await assembleCustomerInvoiceDocument(row(), 'portal', { surface: 'pdf' });
    expect(doc.lines.map((l) => l.ticketSubject)).toEqual(['Printer offline', 'Printer offline']);
    for (const l of doc.lines) expect(l).not.toHaveProperty('isChild');
  });

  describe('OD-9 switch branches', () => {
    const saved = JSON.parse(JSON.stringify(OD9_CUSTOMER_PROJECTION));
    const projection = OD9_CUSTOMER_PROJECTION as unknown as Record<'screen' | 'pdf', { ticketSubject: boolean; bundleNesting: boolean }>;
    afterEach(() => { Object.assign(projection.screen, saved.screen); Object.assign(projection.pdf, saved.pdf); });

    it('ships the pending defaults verbatim', () => {
      expect(saved).toEqual({ screen: { ticketSubject: false, bundleNesting: false }, pdf: { ticketSubject: true, bundleNesting: false } });
    });

    it('bundleNesting on: isChild from parentLineId; ticketSubject on: the subject', async () => {
      projection.screen.bundleNesting = true;
      projection.screen.ticketSubject = true;
      setRows({ invoice_lines: [PIN_VISIBLE_LINE_ROWS[0]!, { ...PIN_VISIBLE_LINE_ROWS[1]!, parentLineId: PIN_LINE_IDS.part }] });
      const doc = await assembleCustomerInvoiceDocument(row(), 'portal');
      expect(doc.lines.map((l) => l.isChild)).toEqual([false, true]);
      expect(doc.lines.map((l) => l.ticketSubject)).toEqual(['Printer offline', 'Printer offline']);
    });
  });

  it('every line carries its invoice_lines id and the exact DTO keyset', async () => {
    const doc = await assembleCustomerInvoiceDocument(row(), 'public');
    expect(doc.lines.map((l) => l.id)).toEqual([PIN_LINE_IDS.part, PIN_LINE_IDS.timeEntry]);
    for (const l of doc.lines) {
      expect(Object.keys(l).sort()).toEqual([
        'description', 'id', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketCategory', 'ticketNumber',
        'unitPrice', 'workDate', 'workedMinutes',
      ]);
    }
  });

  it('the header is the customer keyset plus displayStatus; no internal field', async () => {
    const doc = await assembleCustomerInvoiceDocument(row(), 'staff');
    expect(Object.keys(doc.invoice).sort()).toEqual([
      'amountPaid', 'balance', 'billToName', 'currencyCode', 'depositDue', 'displayStatus', 'dueDate', 'id',
      'invoiceNumber', 'issueDate', 'lineGrouping', 'notes', 'sellerSnapshot', 'status', 'subtotal', 'taxRate',
      'taxTotal', 'termsAndConditions', 'total',
    ]);
    expect(Object.keys(doc).sort()).toEqual(['branding', 'documentLocale', 'invoice', 'lines']);
    expect(JSON.stringify(doc)).not.toContain('INTERNAL-ONLY');
    expect(JSON.stringify(doc)).not.toContain('pin-token');
  });

  it('a non-object seller snapshot narrows to null; an object keeps exactly the snapshot keys', async () => {
    expect((await assembleCustomerInvoiceDocument(row({ sellerSnapshot: 'junk' }), 'portal')).invoice.sellerSnapshot).toBeNull();
    const doc = await assembleCustomerInvoiceDocument(row({ sellerSnapshot: { ...PIN_INVOICE_ROW.sellerSnapshot, secret: 'x' } }), 'portal');
    expect(doc.invoice.sellerSnapshot).toEqual(PIN_INVOICE_ROW.sellerSnapshot);
  });

  it('documentLocale: the invoice stamp wins, else the partner language, else en', async () => {
    expect((await assembleCustomerInvoiceDocument(row({ documentLocale: 'pt-BR' }), 'portal')).documentLocale).toBe('pt-BR');
    setRows({ partners: [{ ...PIN_PARTNER_ROW, settings: { language: 'pt-BR' } }] });
    expect((await assembleCustomerInvoiceDocument(row(), 'portal')).documentLocale).toBe('pt-BR');
    setRows({ partners: [] });
    expect((await assembleCustomerInvoiceDocument(row(), 'portal')).documentLocale).toBe('en');
  });

  it('branding: frozen presentation wins over the partner live values (D14); a draft previews the partner values', async () => {
    const issued = await assembleCustomerInvoiceDocument(row(), 'portal');
    expect(issued.branding).toEqual({
      partnerName: 'Example MSP', contactEmail: 'billing@example-msp.test',
      logoUrl: 'https://cdn.example-msp.test/logo.png', primaryColor: '#1d4ed8',
      theme: 'condensed', pageSize: 'a4',
    });
    const draft = await assembleCustomerInvoiceDocument(DRAFT, 'staff');
    expect(draft.branding).toMatchObject({ theme: 'classic', pageSize: 'letter' });
  });

  it('a failing branding read logs and falls back; the document still assembles', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setRows({ partners: new Error('partners down'), portal_branding: new Error('branding down') });
      const doc = await assembleCustomerInvoiceDocument(row(), 'portal');
      expect(doc.branding).toEqual({ partnerName: null, contactEmail: null, logoUrl: null, primaryColor: null, theme: 'condensed', pageSize: 'a4' });
      expect(doc.documentLocale).toBe('en');
      expect(doc.lines).toHaveLength(2);
      expect(err).toHaveBeenCalledWith('[customerDocument] branding lookup failed', expect.objectContaining({ invoiceId: PIN_INVOICE_ID }));
    } finally {
      err.mockRestore();
    }
  });

  it('a missing partner or branding row reads as nulls without logging', async () => {
    setRows({ partners: [], portal_branding: [] });
    const b = await loadCustomerDocumentBranding(row());
    expect(b).toEqual({ partnerName: null, contactEmail: null, logoUrl: null, primaryColor: null, theme: 'condensed', pageSize: 'a4' });
  });

  it('a failing line query is NOT fail-soft (the document must not render without its lines)', async () => {
    setRows({ invoice_lines: new Error('lines down') });
    await expect(assembleCustomerInvoiceDocument(row(), 'portal')).rejects.toThrow('lines down');
  });
});

describe('invoiceDisplayStatus', () => {
  it('draft → null, every other status → itself', () => {
    expect(invoiceDisplayStatus('draft')).toBeNull();
    for (const s of ['sent', 'partially_paid', 'overdue', 'paid', 'void'] as const) expect(invoiceDisplayStatus(s)).toBe(s);
  });
});
