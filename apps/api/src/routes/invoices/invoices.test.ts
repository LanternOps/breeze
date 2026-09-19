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
  updateIssuedDueDate: vi.fn(),
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
  resendInvoiceEmail: vi.fn(),
  renderInvoicePdf: vi.fn(),
  getInvoicePdf: vi.fn()
}));

// GET /:id resolves document branding (partner/portal) for the in-app preview,
// mirroring the quotes route. Stub it so route tests don't hit the real DB.
vi.mock('../../services/quoteBranding', () => ({
  resolveQuoteBranding: vi.fn()
}));

// Payment routes write to the durable audit chain; stub it so route tests don't
// hit the real audit persistence path.
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

// InvoiceServiceError lives in invoiceTypes; routes import the class from there.
vi.mock('../../services/invoiceTypes', () => ({
  InvoiceServiceError: class InvoiceServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string, public details?: Record<string, unknown>) { super(msg); }
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

// #3205 W07: lifecycle.ts's applyDeviceAppendixOverride calls `db` directly
// (the reset-link/public-link routes already do too, but are untested here).
// Only `.update().set().where().returning()` needs a controllable result —
// dbAppendixState is shared with the test bodies below via vi.hoisted so the
// mock factory (hoisted above these imports) can close over it.
const { dbAppendixState } = vi.hoisted(() => ({
  dbAppendixState: { updateAffectedRows: 1 as number, callOrder: [] as string[] },
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'delete', 'for', 'update', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => {
    dbAppendixState.callOrder.push('device_appendix_update');
    return Promise.resolve(dbAppendixState.updateAffectedRows > 0 ? [{ id: 'x' }] : []);
  });
  return { db: chain };
});

import { invoiceRoutes } from './index';
import { invoiceAssemblyRoutes } from './assembly';
import * as svc from '../../services/invoiceService';
import * as pdfSvc from '../../services/invoicePdf';
import * as brandingSvc from '../../services/quoteBranding';
import { writeRouteAudit } from '../../services/auditEvents';
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

  it('GET /:id fetches one invoice and attaches resolved branding', async () => {
    (svc.getInvoice as any).mockResolvedValue({ invoice: { id: INV_ID }, lines: [], stripeConnected: false });
    (brandingSvc.resolveQuoteBranding as any).mockResolvedValue({ partnerName: 'Lantern IT', logoUrl: null, primaryColor: null, footer: null, currencyCode: 'USD', seller: null });
    const res = await app().request(`/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.invoice.id).toBe(INV_ID);
    expect(body.data.branding.partnerName).toBe('Lantern IT');
    expect(svc.getInvoice).toHaveBeenCalledWith(INV_ID, expect.anything());
    expect(brandingSvc.resolveQuoteBranding).toHaveBeenCalledWith({ id: INV_ID, presentationSnapshot: null });
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

describe('invoice due-date route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PATCH /:id/due-date rejects a malformed date (400, no service call)', async () => {
    const res = await app().request(`/${INV_ID}/due-date`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '09/01/2026' })
    });
    expect(res.status).toBe(400);
    expect(svc.updateIssuedDueDate).not.toHaveBeenCalled();
  });

  it('PATCH /:id/due-date rejects a non-calendar date that passes the regex (400, no service call)', async () => {
    // 2026-13-40 matches \d{4}-\d{2}-\d{2} but is not a real date — Date would
    // silently roll it over to a later valid date instead of erroring, and
    // without the round-trip refine this used to reach the service and 500 at
    // the Postgres DATE column.
    const res = await app().request(`/${INV_ID}/due-date`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '2026-13-40' })
    });
    expect(res.status).toBe(400);
    expect(svc.updateIssuedDueDate).not.toHaveBeenCalled();
  });

  it('PATCH /:id/due-date updates the due date and writes invoice.due_date.updated to the audit chain', async () => {
    (svc.updateIssuedDueDate as any).mockResolvedValue({
      invoice: { id: INV_ID, dueDate: '2026-09-01', status: 'sent' },
      audit: { orgId: ORG_ID, invoiceId: INV_ID, oldDueDate: '2026-06-01', newDueDate: '2026-09-01' }
    });
    const res = await app().request(`/${INV_ID}/due-date`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '2026-09-01' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dueDate).toBe('2026-09-01');
    expect(svc.updateIssuedDueDate).toHaveBeenCalledWith(INV_ID, '2026-09-01', expect.anything());
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'invoice.due_date.updated',
      resourceType: 'invoice',
      resourceId: INV_ID,
      details: { oldDueDate: '2026-06-01', newDueDate: '2026-09-01' }
    });
  });

  it('maps an INVALID_STATE InvoiceServiceError from updateIssuedDueDate to 409', async () => {
    (svc.updateIssuedDueDate as any).mockRejectedValue(
      new InvoiceServiceError('Due date can only be changed on an open issued invoice', 409, 'INVALID_STATE')
    );
    const res = await app().request(`/${INV_ID}/due-date`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '2026-09-01' })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('INVALID_STATE');
    expect(writeRouteAudit).not.toHaveBeenCalled();
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
    // Third arg is the (empty) composer body: a body-less POST must reproduce
    // the classic billing-contact send, with every composer field undefined.
    expect(pdfSvc.sendInvoiceEmail).toHaveBeenCalledWith(INV_ID, expect.anything(), {
      to: undefined, cc: undefined, subject: undefined, message: undefined, includePdf: undefined,
    });
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

  it('POST /:id/send threads the composer body through to the service', async () => {
    (pdfSvc.sendInvoiceEmail as any).mockResolvedValue({ invoice: { id: INV_ID, status: 'sent' }, emailed: true, recipients: ['a@x.test'] });
    const res = await app().request(`/${INV_ID}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: ['a@x.test'], cc: ['b@x.test'], subject: 'Your invoice', message: 'Thanks!', includePdf: false }),
    });
    expect(res.status).toBe(200);
    expect(pdfSvc.sendInvoiceEmail).toHaveBeenCalledWith(INV_ID, expect.anything(), {
      to: ['a@x.test'], cc: ['b@x.test'], subject: 'Your invoice', message: 'Thanks!', includePdf: false,
    });
  });

  it('POST /:id/resend calls resendInvoiceEmail with the composer options', async () => {
    (pdfSvc.resendInvoiceEmail as any).mockResolvedValue({
      invoice: { id: INV_ID, orgId: 'o1', status: 'sent' }, emailed: true, recipients: ['a@x.test'],
    });
    const res = await app().request(`/${INV_ID}/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: ['a@x.test'], message: 'Second copy as requested.' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.emailed).toBe(true);
    expect(pdfSvc.resendInvoiceEmail).toHaveBeenCalledWith(INV_ID, expect.anything(), {
      to: ['a@x.test'], cc: undefined, subject: undefined, message: 'Second copy as requested.', includePdf: undefined,
    });
  });

  it('POST /:id/resend audits the attempt, recording the recipient COUNT not the addresses', async () => {
    (pdfSvc.resendInvoiceEmail as any).mockResolvedValue({
      invoice: { id: INV_ID, orgId: 'o1', status: 'sent' }, emailed: true, recipients: ['a@x.test', 'b@x.test'],
    });
    await app().request(`/${INV_ID}/resend`, { method: 'POST' });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'o1', action: 'invoice.resend', resourceType: 'invoice', resourceId: INV_ID, result: 'success',
      details: { emailed: true, emailReason: undefined, recipientCount: 2 },
    }));
    const audited = JSON.stringify((writeRouteAudit as any).mock.calls[0][1]);
    expect(audited).not.toContain('a@x.test');
  });

  it('POST /:id/resend audits result:failure when nothing was emailed', async () => {
    (pdfSvc.resendInvoiceEmail as any).mockResolvedValue({
      invoice: { id: INV_ID, orgId: 'o1', status: 'sent' }, emailed: false, reason: 'no_billing_contact', recipients: [],
    });
    const res = await app().request(`/${INV_ID}/resend`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.reason).toBe('no_billing_contact');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure' }));
  });

  it('POST /:id/resend rejects a mis-keyed composer field rather than dropping it', async () => {
    const res = await app().request(`/${INV_ID}/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mesage: 'typo — must not be silently swallowed' }),
    });
    expect(res.status).toBe(400);
    expect(pdfSvc.resendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('POST /:id/resend maps a draft INVALID_STATE to 409', async () => {
    (pdfSvc.resendInvoiceEmail as any).mockRejectedValue(
      new InvoiceServiceError('This invoice has not been issued yet — issue it before re-sending', 409, 'INVALID_STATE'),
    );
    const res = await app().request(`/${INV_ID}/resend`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_STATE');
  });

  it('POST /:id/resend rejects a non-uuid id before reaching the service', async () => {
    const res = await app().request('/not-a-uuid/resend', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(pdfSvc.resendInvoiceEmail).not.toHaveBeenCalled();
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

// #3205 W07. NOTE: the plan brief cited a `lifecycle.test.ts` file for these
// tests, but no such file exists — every route test for lifecycle.ts (the
// module under change here) already lives in this file's "invoice lifecycle
// routes" describe block above, so these are appended here instead (stale
// citation, anchored on the real file per the controller's other rulings).
describe('POST /:id/send — includeDeviceAppendix (#3205 W07)', () => {
  const DRAFT_ID = INV_ID;
  const SENT_ID = '55555555-5555-5555-5555-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    dbAppendixState.updateAffectedRows = 1;
    dbAppendixState.callOrder = [];
    (pdfSvc.sendInvoiceEmail as any).mockImplementation(async () => {
      dbAppendixState.callOrder.push('sendInvoiceEmail');
      return { invoice: { id: DRAFT_ID, status: 'sent' }, emailed: true };
    });
  });

  it('persists device_appendix on a DRAFT before issuing, then sends', async () => {
    const res = await app().request(`/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(res.status).toBe(200);
    // The atomic update runs BEFORE sendInvoiceEmail (which issues, which
    // enqueues the async render) — the only ordering that survives the job.
    expect(dbAppendixState.callOrder).toEqual(['device_appendix_update', 'sendInvoiceEmail']);
  });

  it('409 INVOICE_ALREADY_ISSUED when the flag is present on a non-draft, and sends nothing', async () => {
    dbAppendixState.updateAffectedRows = 0;              // the WHERE status='draft' matched nothing
    const res = await app().request(`/${SENT_ID}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INVOICE_ALREADY_ISSUED' });
    expect(pdfSvc.sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('OMITTING the field on an issued invoice is unaffected', async () => {
    const res = await app().request(`/${SENT_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(dbAppendixState.callOrder).toEqual(['sendInvoiceEmail']); // no override call at all
  });

  it('400s on an unknown composer field (the .strict() guard still bites)', async () => {
    const res = await app().request(`/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeDeviceAppendixx: true }),
    });
    expect(res.status).toBe(400);
    expect(pdfSvc.sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('composerOptions does NOT forward includeDeviceAppendix — the column is the channel', async () => {
    await app().request(`/${DRAFT_ID}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeDeviceAppendix: true }),
    });
    expect(pdfSvc.sendInvoiceEmail).toHaveBeenCalled();
    expect((pdfSvc.sendInvoiceEmail as any).mock.calls[0]![2]).not.toHaveProperty('includeDeviceAppendix');
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
    (svc.recordPayment as any).mockResolvedValue({
      invoice: { id: INV_ID, amount: '40.00' },
      audit: { orgId: ORG_ID, paymentId: 'pay1', invoiceId: INV_ID, amount: '40.00', method: 'card', reference: null, recordedBy: 'u1' }
    });
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
      expect.objectContaining({ orgId: ORG_ID, from: '2026-06-01', to: '2026-06-14' }),
      expect.anything()
    );
  });

  it('POST /orgs/:orgId/invoices/assemble forwards a normalized currencyCode override (#3776)', async () => {
    (svc.assembleDraftFromOrg as any).mockResolvedValue({ id: INV_ID, status: 'draft', blockedByCurrency: [] });
    const res = await invoiceAssemblyRoutes.request(`/orgs/${ORG_ID}/invoices/assemble`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-06-01', to: '2026-06-14', currencyCode: 'eur' })
    });
    expect(res.status).toBe(200);
    expect(svc.assembleDraftFromOrg).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, currencyCode: 'EUR' }),
      expect.anything()
    );
  });

  it('POST /orgs/:orgId/invoices/assemble rejects an unsupported currencyCode (→ 400, no service call)', async () => {
    const res = await invoiceAssemblyRoutes.request(`/orgs/${ORG_ID}/invoices/assemble`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-06-01', to: '2026-06-14', currencyCode: 'ZZZ' })
    });
    expect(res.status).toBe(400);
    expect(svc.assembleDraftFromOrg).not.toHaveBeenCalled();
  });

  it('surfaces ALL_BLOCKED_BY_CURRENCY details (blocked groups) on the 409 body', async () => {
    (svc.assembleDraftFromOrg as any).mockRejectedValue(
      new InvoiceServiceError('All blocked', 409, 'ALL_BLOCKED_BY_CURRENCY',
        { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] })
    );
    const res = await invoiceAssemblyRoutes.request(`/orgs/${ORG_ID}/invoices/assemble`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-06-01', to: '2026-06-14' })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ALL_BLOCKED_BY_CURRENCY');
    expect(body.details).toEqual({ blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] });
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
    expect(svc.assembleDraftFromTicket).toHaveBeenCalledWith(TICKET_ID, expect.anything(), { currencyCode: undefined });
  });

  it('POST /tickets/:ticketId/invoice?currencyCode=eur forwards the normalized override (#3776)', async () => {
    (svc.assembleDraftFromTicket as any).mockResolvedValue({ id: INV_ID });
    const res = await invoiceAssemblyRoutes.request(`/tickets/${TICKET_ID}/invoice?currencyCode=eur`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.assembleDraftFromTicket).toHaveBeenCalledWith(TICKET_ID, expect.anything(), { currencyCode: 'EUR' });
  });

  it('POST /tickets/:ticketId/invoice?currencyCode=ZZZ → 400, no service call', async () => {
    const res = await invoiceAssemblyRoutes.request(`/tickets/${TICKET_ID}/invoice?currencyCode=ZZZ`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(svc.assembleDraftFromTicket).not.toHaveBeenCalled();
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
