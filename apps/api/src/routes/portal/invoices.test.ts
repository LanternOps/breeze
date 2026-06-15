import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Service-layer mocks — the route is a thin org-scoped consumer.
const { getCustomerInvoiceMock, markViewedMock } = vi.hoisted(() => ({
  getCustomerInvoiceMock: vi.fn(),
  markViewedMock: vi.fn(),
}));
vi.mock('../../services/invoiceService', () => ({
  getCustomerInvoice: getCustomerInvoiceMock,
  markViewed: markViewedMock,
}));

const { getInvoicePdfMock, renderInvoicePdfMock } = vi.hoisted(() => ({
  getInvoicePdfMock: vi.fn(),
  renderInvoicePdfMock: vi.fn(),
}));
vi.mock('../../services/invoicePdf', () => ({
  getInvoicePdf: getInvoicePdfMock,
  renderInvoicePdf: renderInvoicePdfMock,
}));

// DB mock for the list query: select().from().where() resolves to either the
// count row or the data rows depending on call order.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  return { db: makeChain() };
});

// Real InvoiceServiceError so `instanceof` branches in the route fire.
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const INV_ID = '11111111-1111-1111-1111-111111111111';

// Wrap the route with a portalAuth-injecting middleware (mirrors portalAuthMiddleware).
function app(orgId = ORG_ID) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer',
    });
    await next();
  });
  a.route('/', portalInvoiceRoutes);
  return a;
}

describe('portal invoices routes', () => {
  beforeEach(() => { vi.clearAllMocks(); dbResults.length = 0; });

  it('GET /invoices lists this org non-draft invoices', async () => {
    dbResults.push([{ count: 2 }]);             // count query
    dbResults.push([{ id: INV_ID, status: 'sent' }, { id: 'i2', status: 'paid' }]); // data
    const res = await app().request('/invoices', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
  });

  it('GET /invoices/:id returns the customer view + stamps viewed', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [{ id: 'l1' }] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.id).toBe(INV_ID);
    expect(body.lines).toHaveLength(1);
    expect(getCustomerInvoiceMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
    expect(markViewedMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
  });

  it('GET /invoices/:id maps a cross-tenant 404 from the service', async () => {
    getCustomerInvoiceMock.mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id never exposes a draft (404)', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'draft' }, lines: [] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf streams the stored PDF', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValue(Buffer.from('%PDF-portal'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="INV-1.pdf"');
    expect(renderInvoicePdfMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf renders on demand if no artifact exists', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('%PDF-rendered'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(renderInvoicePdfMock).toHaveBeenCalledWith(INV_ID);
  });
});
