import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Route-level tests for the fulfillment endpoints (POST /:id/orders,
// PATCH /:id/orders/:orderId, PATCH /:id/orders/:orderId/lines/:lineId), mounted
// on the REAL quoteCrudRoutes router. Mirrors lifecycle.test.ts's RBAC style:
// keep the REAL requireScope/requirePermission middleware and only stub the
// DB-backed getUserPermissions, so a route ungated or gated on the wrong
// permission (e.g. quotes:write instead of quotes:fulfill) actually fails here —
// a plain service-level mock could never catch that class of bug.

const permState = vi.hoisted(() => ({ perms: ['quotes:read', 'quotes:write', 'quotes:fulfill'] }));

vi.mock('../../services/permissions', async (importActual) => {
  const actual = await importActual<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: permState.perms.map((p) => { const [resource, action] = p.split(':'); return { resource, action }; }),
      partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' as const,
    })),
  };
});

// The service layer is what does the real work (idempotency, access checks,
// the receivedQty<=orderedQty guard) — it has its own coverage. Here we only
// assert the route's wiring: param/body validation, permission gating, error
// mapping, and the audit event shape.
vi.mock('../../services/quoteOrderService', () => ({
  createQuoteOrder: vi.fn(),
  updateQuoteOrder: vi.fn(),
  updateQuoteOrderLine: vi.fn(),
}));
// Stub every other service quotes.ts imports so mounting the real router never
// touches the DB or does real work outside the orders endpoints under test.
vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(), cloneQuote: vi.fn(), getQuote: vi.fn(), listQuotes: vi.fn(), updateQuote: vi.fn(),
  deleteDraftQuote: vi.fn(), addBlock: vi.fn(), updateBlock: vi.fn(), deleteBlock: vi.fn(),
  addManualLine: vi.fn(), addCatalogLine: vi.fn(), updateLine: vi.fn(), removeLine: vi.fn(),
  reorderBlocks: vi.fn(), reorderLines: vi.fn(), moveLineToBlock: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) },
}));
vi.mock('../../services/catalogImageStorage', () => ({ readCatalogItemImage: vi.fn() }));
vi.mock('../../services/quoteBranding', () => ({ resolveQuoteBranding: vi.fn() }));
vi.mock('../../services/contractTemplateRender', () => ({
  renderContractBlocksForClient: vi.fn(), loadContractPdfInputs: vi.fn(),
  loadContractBlockAuthoring: vi.fn(), attachContractAuthoring: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: audit.writeAuditEvent }));

import { quoteCrudRoutes } from './quotes';
import { createQuoteOrder, updateQuoteOrder, updateQuoteOrderLine } from '../../services/quoteOrderService';
import { QuoteServiceError } from '../../services/quoteTypes';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_QUOTE_ID = '99999999-9999-4999-8999-999999999999';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const LINE_ID = '33333333-3333-4333-8333-333333333333';
const QUOTE_LINE_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_REQUEST_ID = '55555555-5555-4555-8555-555555555555';

function appWith(scope: 'partner' | 'system' | 'organization', perms: string[]) {
  permState.perms = perms;
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope, accessibleOrgIds: null } as never);
    await next();
  });
  a.route('/', quoteCrudRoutes);
  return a;
}

const jsonReq = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const PERMS = ['quotes:read', 'quotes:write', 'quotes:fulfill'];

describe('POST /:id/orders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a header + allocations and returns them', async () => {
    const orderRow = {
      id: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', clientRequestId: CLIENT_REQUEST_ID,
      vendorName: 'Acme Distributor', orderRef: null, procurementSource: null, notes: null,
      orderedBy: 'u1', orderedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lines: [{ id: LINE_ID, orderId: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', quoteLineId: QUOTE_LINE_ID, orderedQty: '5.00', receivedQty: '0.00' }],
    };
    vi.mocked(createQuoteOrder).mockResolvedValue(orderRow as never);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders`, jsonReq({
      clientRequestId: CLIENT_REQUEST_ID,
      vendorName: 'Acme Distributor',
      lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(ORDER_ID);
    expect(body.data.lines).toHaveLength(1);
    expect(createQuoteOrder).toHaveBeenCalledWith(
      QUOTE_ID,
      expect.objectContaining({ clientRequestId: CLIENT_REQUEST_ID, lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }] }),
      expect.objectContaining({ userId: 'u1' }),
    );
  });

  it('is idempotent — the same clientRequestId submitted twice returns the SAME order id', async () => {
    const orderRow = { id: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', clientRequestId: CLIENT_REQUEST_ID, lines: [] };
    // The service (not the route) is what dedupes on the 23505 from
    // quote_orders_client_request_uq and re-reads the committed row — a static
    // mock stands in for that: whatever the caller sends, the service always
    // resolves the ONE committed order for this clientRequestId.
    vi.mocked(createQuoteOrder).mockResolvedValue(orderRow as never);

    const body = jsonReq({ clientRequestId: CLIENT_REQUEST_ID, lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }] });
    const app = appWith('partner', PERMS);
    const first = await app.request(`/${QUOTE_ID}/orders`, body);
    const second = await app.request(`/${QUOTE_ID}/orders`, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.data.id).toBe(secondBody.data.id);
    expect(createQuoteOrder).toHaveBeenCalledTimes(2);
  });

  it('403s without quotes:fulfill even when the caller holds quotes:write', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/orders`, jsonReq({
      clientRequestId: CLIENT_REQUEST_ID,
      lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }],
    }));
    expect(res.status).toBe(403);
    expect(createQuoteOrder).not.toHaveBeenCalled();
  });

  it('409s when the quote status is not accepted/converted', async () => {
    vi.mocked(createQuoteOrder).mockRejectedValue(
      new QuoteServiceError('Only accepted or converted quotes can be fulfilled', 409, 'QUOTE_NOT_FULFILLABLE')
    );
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders`, jsonReq({
      clientRequestId: CLIENT_REQUEST_ID,
      lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }],
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_NOT_FULFILLABLE' });
  });

  it('400s when a quoteLineId belongs to another quote', async () => {
    vi.mocked(createQuoteOrder).mockRejectedValue(
      new QuoteServiceError('Line does not belong to this quote', 400, 'QUOTE_LINE_MISMATCH')
    );
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders`, jsonReq({
      clientRequestId: CLIENT_REQUEST_ID,
      lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }],
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_LINE_MISMATCH' });
  });

  it('400s a body missing required fields (schema validation)', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders`, jsonReq({ lines: [] }));
    expect(res.status).toBe(400);
    expect(createQuoteOrder).not.toHaveBeenCalled();
  });

  it('writes an audit event with IDs + counts only — never tracking numbers, refs, or notes', async () => {
    const orderRow = {
      id: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', clientRequestId: CLIENT_REQUEST_ID,
      orderRef: 'PO-SECRET-REF', notes: 'internal notes',
      lines: [
        { id: LINE_ID, orderId: ORDER_ID, quoteId: QUOTE_ID, quoteLineId: QUOTE_LINE_ID, orderedQty: '5.00', trackingNumber: '1Z999AA10123456784' },
      ],
    };
    vi.mocked(createQuoteOrder).mockResolvedValue(orderRow as never);

    await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders`, jsonReq({
      clientRequestId: CLIENT_REQUEST_ID,
      orderRef: 'PO-SECRET-REF',
      trackingNumber: '1Z999AA10123456784',
      lines: [{ quoteLineId: QUOTE_LINE_ID, orderedQty: 5 }],
    }));

    expect(audit.writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = audit.writeAuditEvent.mock.calls[0]!;
    expect(event).toMatchObject({ action: 'quote_order_created', resourceType: 'quote', resourceId: QUOTE_ID });
    expect(event.details).toEqual({ orderId: ORDER_ID, lineCount: 1 });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('PO-SECRET-REF');
    expect(serialized).not.toContain('1Z999AA10123456784');
    expect(serialized).not.toContain('internal notes');
  });
});

describe('PATCH /:id/orders/:orderId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates header fields (vendorName/orderRef/notes)', async () => {
    const orderRow = { id: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', vendorName: 'New Vendor', orderRef: 'PO-2', notes: null };
    vi.mocked(updateQuoteOrder).mockResolvedValue(orderRow as never);
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders/${ORDER_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendorName: 'New Vendor' }),
    });
    expect(res.status).toBe(200);
    expect(updateQuoteOrder).toHaveBeenCalledWith(QUOTE_ID, ORDER_ID, { vendorName: 'New Vendor' }, expect.anything());
  });

  it('404s an orderId that does not belong to this quote', async () => {
    vi.mocked(updateQuoteOrder).mockRejectedValue(new QuoteServiceError('Order not found', 404, 'QUOTE_ORDER_NOT_FOUND'));
    const res = await appWith('partner', PERMS).request(`/${OTHER_QUOTE_ID}/orders/${ORDER_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendorName: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /:id/orders/:orderId/lines/:lineId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('{ cancelled: true } stamps cancelledAt', async () => {
    const cancelledAt = new Date().toISOString();
    vi.mocked(updateQuoteOrderLine).mockResolvedValue({
      id: LINE_ID, orderId: ORDER_ID, quoteId: QUOTE_ID, orgId: 'org-1', quoteLineId: QUOTE_LINE_ID,
      orderedQty: '5.00', receivedQty: '0.00', cancelledAt,
    } as never);

    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cancelled: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.cancelledAt).toBe(cancelledAt);
    expect(updateQuoteOrderLine).toHaveBeenCalledWith(QUOTE_ID, ORDER_ID, LINE_ID, { cancelled: true }, expect.anything());
  });

  it('400s a receivedQty above orderedQty with a clean message (not a raw DB error)', async () => {
    vi.mocked(updateQuoteOrderLine).mockRejectedValue(
      new QuoteServiceError('Received quantity cannot exceed ordered quantity', 400, 'RECEIVED_QTY_EXCEEDS_ORDERED')
    );
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receivedQty: 999 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Received quantity cannot exceed ordered quantity');
    expect(body.code).toBe('RECEIVED_QTY_EXCEEDS_ORDERED');
  });

  it('403s without quotes:fulfill even when the caller holds quotes:write', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cancelled: true }),
    });
    expect(res.status).toBe(403);
    expect(updateQuoteOrderLine).not.toHaveBeenCalled();
  });
});
