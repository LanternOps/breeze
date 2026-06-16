import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/invoiceService', () => ({
  createManualInvoice: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  addBundleLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  deleteDraftInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  issueInvoice: vi.fn(),
  voidInvoice: vi.fn(),
  recordPayment: vi.fn(),
  listPayments: vi.fn(),
  voidPayment: vi.fn(),
  assembleDraftFromOrg: vi.fn(),
  assembleDraftFromTicket: vi.fn()
}));

// Mock the Phase 5 PDF/email service — /:id/send + /:id/pdf delegate here.
vi.mock('../../services/invoicePdf', () => ({
  sendInvoiceEmail: vi.fn(),
  renderInvoicePdf: vi.fn(),
  getInvoicePdf: vi.fn()
}));

// InvoiceServiceError lives in invoiceTypes; routes import the class from there.
vi.mock('../../services/invoiceTypes', () => ({
  InvoiceServiceError: class InvoiceServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with invoice perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { invoiceRoutes } from './index';
import { invoiceAssemblyRoutes } from './assembly';
import * as svc from '../../services/invoiceService';
import * as pdfSvc from '../../services/invoicePdf';
import { InvoiceServiceError } from '../../services/invoiceTypes';

function app() {
  // invoiceRoutes already applies authMiddleware internally
  return invoiceRoutes;
}

const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const TICKET_ID = '33333333-3333-3333-3333-333333333333';

describe('invoice crud + lines routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST / creates a manual invoice', async () => {
    (svc.createManualInvoice as any).mockResolvedValue({ id: INV_ID, status: 'draft' });
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(INV_ID);
    expect(svc.createManualInvoice).toHaveBeenCalledOnce();
  });

  it('POST / rejects an invalid body (non-UUID orgId → 400, no service call)', async () => {
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'not-a-uuid' })
    });
    expect(res.status).toBe(400);
    expect(svc.createManualInvoice).not.toHaveBeenCalled();
  });

  it('GET / lists invoices', async () => {
    (svc.listInvoices as any).mockResolvedValue([{ id: INV_ID }]);
    const res = await app().request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(svc.listInvoices).toHaveBeenCalledOnce();
  });

  it('GET /:id fetches one invoice', async () => {
    (svc.getInvoice as any).mockResolvedValue({ id: INV_ID });
    const res = await app().request(`/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(INV_ID);
    expect(svc.getInvoice).toHaveBeenCalledWith(INV_ID, expect.anything());
  });

  it('POST /:id/lines adds a manual line', async () => {
    (svc.addManualLine as any).mockResolvedValue({ id: 'line1' });
    const res = await app().request(`/${INV_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Onsite hour', quantity: 2, unitPrice: 150, taxable: true })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('line1');
    expect(svc.addManualLine).toHaveBeenCalledOnce();
  });

  it('POST /:id/lines rejects an invalid body (negative quantity → 400, no service call)', async () => {
    const res = await app().request(`/${INV_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'X', quantity: -1, unitPrice: 150, taxable: false })
    });
    expect(res.status).toBe(400);
    expect(svc.addManualLine).not.toHaveBeenCalled();
  });

  it('PATCH /:id edits a draft invoice', async () => {
    (svc.updateInvoice as any).mockResolvedValue({ id: INV_ID, notes: 'Updated', status: 'draft' });
    const res = await app().request(`/${INV_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Updated', siteId: null })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notes).toBe('Updated');
    expect(svc.updateInvoice).toHaveBeenCalledWith(
      INV_ID,
      { notes: 'Updated', siteId: null },
      expect.anything()
    );
  });

  it('PATCH /:id rejects an invalid body (non-UUID siteId → 400, no service call)', async () => {
    const res = await app().request(`/${INV_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'not-a-uuid' })
    });
    expect(res.status).toBe(400);
    expect(svc.updateInvoice).not.toHaveBeenCalled();
  });

  it('DELETE /:id deletes a draft invoice', async () => {
    (svc.deleteDraftInvoice as any).mockResolvedValue(undefined);
    const res = await app().request(`/${INV_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.deleteDraftInvoice).toHaveBeenCalledWith(INV_ID, expect.anything());
  });

  it('maps an InvoiceServiceError to its status (NOTHING_TO_INVOICE → 409)', async () => {
    (svc.createManualInvoice as any).mockRejectedValue(
      new InvoiceServiceError('Nothing to invoice', 409, 'NOTHING_TO_INVOICE')
    );
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOTHING_TO_INVOICE');
  });
});

describe('invoice lifecycle routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /:id/issue calls issueInvoice', async () => {
    (svc.issueInvoice as any).mockResolvedValue({ id: INV_ID, status: 'sent', invoiceNumber: 'INV-0001' });
    const res = await app().request(`/${INV_ID}/issue`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.invoiceNumber).toBe('INV-0001');
    expect(svc.issueInvoice).toHaveBeenCalledWith(INV_ID, expect.anything());
  });

  it('POST /:id/send returns the honest { invoice, emailed } shape when emailed', async () => {
    (pdfSvc.sendInvoiceEmail as any).mockResolvedValue({ invoice: { id: INV_ID, status: 'sent' }, emailed: true });
    const res = await app().request(`/${INV_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.emailed).toBe(true);
    expect(body.data.invoice.id).toBe(INV_ID);
    expect(pdfSvc.sendInvoiceEmail).toHaveBeenCalledWith(INV_ID, expect.anything());
  });

  it('POST /:id/send surfaces emailed:false + reason when nothing was emailed', async () => {
    (pdfSvc.sendInvoiceEmail as any).mockResolvedValue({ invoice: { id: INV_ID, status: 'sent' }, emailed: false, reason: 'no_email_service' });
    const res = await app().request(`/${INV_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.emailed).toBe(false);
    expect(body.data.reason).toBe('no_email_service');
  });

  it('POST /:id/send maps a cross-tenant INVOICE_NOT_FOUND to 404', async () => {
    (pdfSvc.sendInvoiceEmail as any).mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app().request(`/${INV_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('INVOICE_NOT_FOUND');
  });

  it('POST /:id/void validates the reason body (empty reason → 400, no service call)', async () => {
    const res = await app().request(`/${INV_ID}/void`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '' })
    });
    expect(res.status).toBe(400);
    expect(svc.voidInvoice).not.toHaveBeenCalled();
  });

  it('POST /:id/void calls voidInvoice with reason + reissue', async () => {
    (svc.voidInvoice as any).mockResolvedValue({ id: INV_ID, status: 'void' });
    const res = await app().request(`/${INV_ID}/void`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Duplicate', reissue: true })
    });
    expect(res.status).toBe(200);
    expect(svc.voidInvoice).toHaveBeenCalledWith(INV_ID, 'Duplicate', { reissue: true }, expect.anything());
  });

  it('maps an InvoiceServiceError from issue to its status (NOT_A_DRAFT → 409)', async () => {
    (svc.issueInvoice as any).mockRejectedValue(
      new InvoiceServiceError('Invoice is not a draft', 409, 'NOT_A_DRAFT')
    );
    const res = await app().request(`/${INV_ID}/issue`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOT_A_DRAFT');
  });
});

describe('invoice payment routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /:id/payments lists payments', async () => {
    (svc.listPayments as any).mockResolvedValue([{ id: 'pay1' }]);
    const res = await app().request(`/${INV_ID}/payments`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(svc.listPayments).toHaveBeenCalledWith(INV_ID, expect.anything());
  });

  it('POST /:id/payments records a payment', async () => {
    (svc.recordPayment as any).mockResolvedValue({ id: 'pay1', amount: '40.00' });
    const res = await app().request(`/${INV_ID}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 40, method: 'card', receivedAt: '2026-06-14' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.amount).toBe('40.00');
    expect(svc.recordPayment).toHaveBeenCalledOnce();
  });

  it('POST /:id/payments rejects a non-positive amount (→ 400, no service call)', async () => {
    const res = await app().request(`/${INV_ID}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 0, method: 'card', receivedAt: '2026-06-14' })
    });
    expect(res.status).toBe(400);
    expect(svc.recordPayment).not.toHaveBeenCalled();
  });

  it('maps an OVERPAYMENT InvoiceServiceError to 409', async () => {
    (svc.recordPayment as any).mockRejectedValue(
      new InvoiceServiceError('Payment exceeds balance', 409, 'OVERPAYMENT')
    );
    const res = await app().request(`/${INV_ID}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 9999, method: 'card', receivedAt: '2026-06-14' })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('OVERPAYMENT');
  });
});

describe('invoice pdf route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /:id/pdf streams the stored PDF as an attachment', async () => {
    (svc.getInvoice as any).mockResolvedValue({ invoice: { id: INV_ID, invoiceNumber: 'INV-2026-0001' }, lines: [] });
    (pdfSvc.getInvoicePdf as any).mockResolvedValue(Buffer.from('%PDF-1.7 test'));
    const res = await app().request(`/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="INV-2026-0001.pdf"');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfSvc.renderInvoicePdf).not.toHaveBeenCalled();
  });

  it('GET /:id/pdf renders on demand when no artifact exists yet', async () => {
    (svc.getInvoice as any).mockResolvedValue({ invoice: { id: INV_ID, invoiceNumber: 'INV-2026-0002' }, lines: [] });
    (pdfSvc.getInvoicePdf as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('%PDF-rendered'));
    const res = await app().request(`/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(pdfSvc.renderInvoicePdf).toHaveBeenCalledWith(INV_ID);
  });

  it('GET /:id/pdf maps a cross-tenant INVOICE_NOT_FOUND to 404', async () => {
    (svc.getInvoice as any).mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app().request(`/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('INVOICE_NOT_FOUND');
  });
});

describe('invoice assembly routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /orgs/:orgId/invoices/assemble assembles from org', async () => {
    (svc.assembleDraftFromOrg as any).mockResolvedValue({ id: INV_ID, status: 'draft' });
    const res = await invoiceAssemblyRoutes.request(`/orgs/${ORG_ID}/invoices/assemble`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-06-01', to: '2026-06-14' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(INV_ID);
    expect(svc.assembleDraftFromOrg).toHaveBeenCalledWith(
      { orgId: ORG_ID, from: '2026-06-01', to: '2026-06-14' },
      expect.anything()
    );
  });

  it('POST /orgs/:orgId/invoices/assemble rejects a missing date range (→ 400, no service call)', async () => {
    const res = await invoiceAssemblyRoutes.request(`/orgs/${ORG_ID}/invoices/assemble`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    expect(svc.assembleDraftFromOrg).not.toHaveBeenCalled();
  });

  it('POST /tickets/:ticketId/invoice assembles from ticket', async () => {
    (svc.assembleDraftFromTicket as any).mockResolvedValue({ id: INV_ID });
    const res = await invoiceAssemblyRoutes.request(`/tickets/${TICKET_ID}/invoice`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(INV_ID);
    expect(svc.assembleDraftFromTicket).toHaveBeenCalledWith(TICKET_ID, expect.anything());
  });

  it('maps a NOTHING_TO_INVOICE InvoiceServiceError from ticket assembly to 409', async () => {
    (svc.assembleDraftFromTicket as any).mockRejectedValue(
      new InvoiceServiceError('Nothing to invoice', 409, 'NOTHING_TO_INVOICE')
    );
    const res = await invoiceAssemblyRoutes.request(`/tickets/${TICKET_ID}/invoice`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOTHING_TO_INVOICE');
  });
});
