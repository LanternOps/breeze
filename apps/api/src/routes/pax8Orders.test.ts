import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_B = '99999999-9999-4999-8999-999999999999';
const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '88888888-8888-4888-8888-888888888888';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LINE_ID = '55555555-5555-4555-8555-555555555555';
const INTEGRATION_ID = '66666666-6666-4666-8666-666666666666';

const state = vi.hoisted(() => ({
  unauthenticated: false,
  permissionDenied: false,
  mfaDenied: false,
  scope: 'partner' as 'partner' | 'organization' | 'system',
  partnerId: '11111111-1111-4111-8111-111111111111' as string | null,
  accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'] as string[] | null,
}));

const mocks = vi.hoisted(() => ({
  listPax8Orders: vi.fn(),
  getOrderWithLines: vi.fn(),
  getOrCreateDraftOrder: vi.fn(),
  addOrderLine: vi.fn(),
  updateOrderLine: vi.fn(),
  removeOrderLine: vi.fn(),
  listPax8Products: vi.fn(),
  preflightOrder: vi.fn(),
  submitOrder: vi.fn(),
  reconcileOrder: vi.fn(),
  detectPax8Drift: vi.fn(),
  writeRouteAudit: vi.fn(),
  createPax8ClientForIntegration: vi.fn(),
  getProvisionDetails: vi.fn(),
  getProductDependencies: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn((_context: unknown, fn: () => unknown) => fn()),
  dbSelect: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (state.unauthenticated) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: state.scope,
      partnerId: state.partnerId,
      orgId: state.scope === 'organization' ? ORG_A : null,
      accessibleOrgIds: state.accessibleOrgIds,
      canAccessOrg: (orgId: string) => state.accessibleOrgIds === null || state.accessibleOrgIds.includes(orgId),
      user: { id: USER_ID, email: 'admin@example.com', name: 'Admin', isPlatformAdmin: false },
    });
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => {
    if (!['partner', 'system'].includes(c.get('auth').scope)) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => {
    if (state.permissionDenied) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => {
    if (state.mfaDenied) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: { BILLING_MANAGE: { resource: 'billing', action: 'manage' } },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.writeRouteAudit }));

vi.mock('../services/pax8OrderService', async () => {
  class Pax8OrderError extends Error {
    constructor(message: string, public readonly status: 400 | 403 | 404 | 409 | 422) {
      super(message);
      this.name = 'Pax8OrderError';
    }
  }
  return {
    Pax8OrderError,
    listPax8Orders: mocks.listPax8Orders,
    getOrderWithLines: mocks.getOrderWithLines,
    getOrCreateDraftOrder: mocks.getOrCreateDraftOrder,
    addOrderLine: mocks.addOrderLine,
    updateOrderLine: mocks.updateOrderLine,
    removeOrderLine: mocks.removeOrderLine,
    listPax8Products: mocks.listPax8Products,
  };
});

vi.mock('../services/pax8OrderSubmit', () => ({
  preflightOrder: mocks.preflightOrder,
  submitOrder: mocks.submitOrder,
  reconcileOrder: mocks.reconcileOrder,
}));

vi.mock('../services/pax8Drift', () => ({ detectPax8Drift: mocks.detectPax8Drift }));

vi.mock('../services/pax8SyncService', () => ({
  createPax8ClientForIntegration: mocks.createPax8ClientForIntegration,
}));

vi.mock('../db', () => ({
  db: { select: mocks.dbSelect },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withDbAccessContext: mocks.withDbAccessContext,
}));

vi.mock('../db/schema', () => ({
  pax8Integrations: {
    id: 'pax8_integrations.id',
    partnerId: 'pax8_integrations.partner_id',
    isActive: 'pax8_integrations.is_active',
  },
}));

vi.mock('../services/pax8Client', async () => {
  class Pax8ApiError extends Error {
    constructor(message: string, public readonly status?: number, public readonly body?: string) {
      super(message);
      this.name = 'Pax8ApiError';
    }
  }
  return { Pax8ApiError };
});

import { Pax8ApiError } from '../services/pax8Client';
import { Pax8OrderError } from '../services/pax8OrderService';
import { pax8OrderRoutes } from './pax8Orders';

const baseOrder = {
  id: ORDER_ID,
  partnerId: PARTNER_A,
  orgId: ORG_A,
  integrationId: INTEGRATION_ID,
  status: 'draft',
};

function mockIntegrationClient(): void {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => [{ id: INTEGRATION_ID, partnerId: PARTNER_A }]);
  mocks.dbSelect.mockReturnValueOnce(chain);
  mocks.createPax8ClientForIntegration.mockResolvedValueOnce({
    integration: { id: INTEGRATION_ID, partnerId: PARTNER_A },
    client: {
      getProvisionDetails: mocks.getProvisionDetails,
      getProductDependencies: mocks.getProductDependencies,
    },
  });
}

function request(path: string, init?: RequestInit) {
  const app = new Hono();
  app.route('/pax8', pax8OrderRoutes);
  return app.request(`/pax8${path}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.unauthenticated = false;
  state.permissionDenied = false;
  state.mfaDenied = false;
  state.scope = 'partner';
  state.partnerId = PARTNER_A;
  state.accessibleOrgIds = [ORG_A];
  mocks.listPax8Orders.mockResolvedValue([baseOrder]);
  mocks.getOrderWithLines.mockResolvedValue({ order: baseOrder, lines: [] });
  mocks.getOrCreateDraftOrder.mockResolvedValue(baseOrder);
  mocks.addOrderLine.mockResolvedValue({ id: LINE_ID, orderId: ORDER_ID, orgId: ORG_A });
  mocks.updateOrderLine.mockResolvedValue({ id: LINE_ID, orderId: ORDER_ID, orgId: ORG_A, action: 'new_subscription' });
  mocks.removeOrderLine.mockResolvedValue({ removed: true });
  mocks.listPax8Products.mockResolvedValue([{ pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'M365' }]);
  mocks.preflightOrder.mockResolvedValue({ ok: true });
  mocks.submitOrder.mockResolvedValue({ orderId: ORDER_ID, status: 'completed', lines: [] });
  mocks.reconcileOrder.mockResolvedValue({ resolved: 1, stillUnknown: 0 });
  mocks.detectPax8Drift.mockResolvedValue([]);
});

describe('Pax8 order route security and tenancy', () => {
  it('rejects unauthenticated callers', async () => {
    state.unauthenticated = true;
    expect((await request('/orders')).status).toBe(401);
  });

  it('requires billing:manage', async () => {
    state.permissionDenied = true;
    expect((await request('/orders')).status).toBe(403);
    expect(mocks.listPax8Orders).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('rejects organization scope with the ordering-specific message', async () => {
    state.scope = 'organization';
    const res = await request('/orders');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Pax8 ordering is managed at partner scope' });
  });

  it('rejects a partner token requesting another partner', async () => {
    const res = await request(`/orders?partnerId=${PARTNER_B}`);
    expect(res.status).toBe(403);
    expect(mocks.listPax8Orders).not.toHaveBeenCalled();
  });

  it('enforces authentication, billing permission, and partner scope on drift reads', async () => {
    state.unauthenticated = true;
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(401);

    state.unauthenticated = false;
    state.permissionDenied = true;
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(403);

    state.permissionDenied = false;
    state.scope = 'organization';
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(403);

    state.scope = 'partner';
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}&partnerId=${PARTNER_B}`)).status).toBe(403);
    expect(mocks.detectPax8Drift).not.toHaveBeenCalled();
  });

  it('requires system drift callers to choose a valid partner', async () => {
    state.scope = 'system';
    state.partnerId = null;
    state.accessibleOrgIds = null;
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(400);
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}&partnerId=not-a-uuid`)).status).toBe(400);
    expect(mocks.detectPax8Drift).not.toHaveBeenCalled();
  });

  it('requires a valid requested partner for system scope', async () => {
    state.scope = 'system';
    state.partnerId = null;
    expect((await request('/orders')).status).toBe(400);
    expect((await request('/orders?partnerId=not-a-uuid')).status).toBe(400);
  });

  it('passes only the system-requested partner to the service', async () => {
    state.scope = 'system';
    state.partnerId = null;
    state.accessibleOrgIds = null;
    const res = await request(`/orders?partnerId=${PARTNER_B}`);
    expect(res.status).toBe(200);
    expect(mocks.listPax8Orders).toHaveBeenCalledWith({ partnerId: PARTNER_B });
  });

  it('rejects a list query for an inaccessible org', async () => {
    const res = await request(`/orders?orgId=${ORG_B}`);
    expect(res.status).toBe(403);
    expect(mocks.listPax8Orders).not.toHaveBeenCalled();
  });

  it('limits a partner-wide list to the member accessible-org allowlist', async () => {
    const res = await request('/orders');
    expect(res.status).toBe(200);
    expect(mocks.listPax8Orders).toHaveBeenCalledWith({
      partnerId: PARTNER_A,
      accessibleOrgIds: [ORG_A],
    });
  });

  it('rejects detail and actions for an inaccessible same-partner org', async () => {
    mocks.getOrderWithLines.mockResolvedValue({ order: { ...baseOrder, orgId: ORG_B }, lines: [] });
    const detail = await request(`/orders/${ORDER_ID}`);
    expect(detail.status).toBe(403);

    const submit = await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' });
    expect(submit.status).toBe(403);
    expect(mocks.submitOrder).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('requires MFA on every POST and DELETE action', async () => {
    state.mfaDenied = true;
    const mutations: Array<[string, RequestInit]> = [
      ['/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: ORG_A }) }],
      [`/orders/${ORDER_ID}/lines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', targetSubscriptionId: 'sub-1' }) }],
      [`/orders/${ORDER_ID}/lines/${LINE_ID}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provisioningDetails: [] }) }],
      [`/orders/${ORDER_ID}/lines/${LINE_ID}`, { method: 'DELETE' }],
      [`/orders/${ORDER_ID}/preflight`, { method: 'POST' }],
      [`/orders/${ORDER_ID}/submit`, { method: 'POST' }],
      [`/orders/${ORDER_ID}/reconcile`, { method: 'POST' }],
    ];
    for (const [path, init] of mutations) {
      expect((await request(path, init)).status, path).toBe(403);
    }
    expect(mocks.getOrCreateDraftOrder).not.toHaveBeenCalled();
    expect(mocks.submitOrder).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('Pax8 order route handlers', () => {
  it('returns drift for the resolved partner after validating integration ownership', async () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => [{ id: INTEGRATION_ID }]);
    mocks.dbSelect.mockReturnValueOnce(chain);
    mocks.detectPax8Drift.mockResolvedValueOnce([{ contractLineId: LINE_ID }]);
    const res = await request(`/drift?integrationId=${INTEGRATION_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: [{ contractLineId: LINE_ID }] });
    expect(mocks.detectPax8Drift).toHaveBeenCalledWith({
      partnerId: PARTNER_A,
      integrationId: INTEGRATION_ID,
    });
    expect(mocks.runOutsideDbContext).not.toHaveBeenCalled();
  });

  it('does not require MFA for a read-only drift request', async () => {
    state.mfaDenied = true;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => [{ id: INTEGRATION_ID }]);
    mocks.dbSelect.mockReturnValueOnce(chain);

    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(200);
    expect(mocks.detectPax8Drift).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, invalid, and foreign-partner drift integrations without reading drift', async () => {
    expect((await request('/drift')).status).toBe(400);
    expect((await request('/drift?integrationId=not-a-uuid')).status).toBe(400);

    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => []);
    mocks.dbSelect.mockReturnValueOnce(chain);
    expect((await request(`/drift?integrationId=${INTEGRATION_ID}`)).status).toBe(404);
    expect(mocks.detectPax8Drift).not.toHaveBeenCalled();
  });

  it('lists by org and returns order detail', async () => {
    expect((await request(`/orders?orgId=${ORG_A}`)).status).toBe(200);
    expect(mocks.listPax8Orders).toHaveBeenCalledWith({ partnerId: PARTNER_A, orgId: ORG_A });

    const detail = await request(`/orders/${ORDER_ID}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual({ data: { order: baseOrder, lines: [] } });
  });

  it('creates a draft using authenticated tenancy and audits safe identifiers', async () => {
    const res = await request('/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: ORG_A }),
    });
    expect(res.status).toBe(201);
    expect(mocks.getOrCreateDraftOrder).toHaveBeenCalledWith({
      partnerId: PARTNER_A, orgId: ORG_A, actorUserId: USER_ID,
    });
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_A, action: 'pax8.order.create', resourceId: ORDER_ID,
      details: expect.objectContaining({ partnerId: PARTNER_A }),
    }));
  });

  it('audits a create service failure only after org authorization', async () => {
    mocks.getOrCreateDraftOrder.mockRejectedValueOnce(new Pax8OrderError('No mapping.', 409));
    const res = await request('/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: ORG_A }),
    });
    expect(res.status).toBe(409);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_A, action: 'pax8.order.create', result: 'failure',
      details: { partnerId: PARTNER_A, status: 409, errorClass: 'Pax8OrderError' },
    }));
  });

  it('adds and removes lines, returning 404 when no line was removed', async () => {
    const add = await request(`/orders/${ORDER_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'new_subscription', pax8ProductId: 'prod-1', billingTerm: 'Monthly', quantity: '3' }),
    });
    expect(add.status).toBe(201);
    expect(mocks.addOrderLine).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER_A, orderId: ORDER_ID, action: 'new_subscription',
    }));

    mocks.removeOrderLine.mockResolvedValueOnce({ removed: false });
    const missing = await request(`/orders/${ORDER_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(2);
    expect(mocks.writeRouteAudit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.line.delete', result: 'failure',
      details: { partnerId: PARTNER_A, lineId: LINE_ID, status: 404, errorClass: 'NotFound' },
    }));
  });

  it('updates only mutable staged-line provisioning fields and audits the change', async () => {
    const res = await request(`/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commitmentTermId: 'commit-1',
        provisioningDetails: [{ key: 'domain', values: ['acme.example'] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(mocks.updateOrderLine).toHaveBeenCalledWith({
      partnerId: PARTNER_A, orderId: ORDER_ID, lineId: LINE_ID,
      commitmentTermId: 'commit-1',
      provisioningDetails: [{ key: 'domain', values: ['acme.example'] }],
    });
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.line.update', resourceId: ORDER_ID,
      details: { partnerId: PARTNER_A, lineId: LINE_ID },
    }));
  });

  it('validates staged-line PATCH and preserves cross-org authorization', async () => {
    const invalid = await request(`/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
    });
    expect(invalid.status).toBe(400);
    expect(mocks.updateOrderLine).not.toHaveBeenCalled();

    mocks.getOrderWithLines.mockResolvedValueOnce({ order: { ...baseOrder, orgId: ORG_B }, lines: [] });
    const foreign = await request(`/orders/${ORDER_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provisioningDetails: [] }),
    });
    expect(foreign.status).toBe(403);
    expect(mocks.updateOrderLine).not.toHaveBeenCalled();
  });

  it('maps Pax8OrderError status and message exactly', async () => {
    mocks.submitOrder.mockRejectedValueOnce(new Pax8OrderError('Order is already submitting.', 409));
    const res = await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Order is already submitting.' });
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.submit', result: 'failure',
      details: { partnerId: PARTNER_A, status: 409, errorClass: 'Pax8OrderError' },
    }));
  });

  it('uses the same bounded failure audit for every authorized order operation', async () => {
    const cases: Array<{
      service: typeof mocks.addOrderLine;
      path: string;
      init: RequestInit;
      action: string;
      safeDetails?: Record<string, unknown>;
    }> = [
      {
        service: mocks.addOrderLine,
        path: `/orders/${ORDER_ID}/lines`,
        init: {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', targetSubscriptionId: 'sub-1' }),
        },
        action: 'pax8.order.line.create',
        safeDetails: { lineAction: 'cancel' },
      },
      {
        service: mocks.removeOrderLine,
        path: `/orders/${ORDER_ID}/lines/${LINE_ID}`,
        init: { method: 'DELETE' },
        action: 'pax8.order.line.delete',
        safeDetails: { lineId: LINE_ID },
      },
      {
        service: mocks.updateOrderLine,
        path: `/orders/${ORDER_ID}/lines/${LINE_ID}`,
        init: {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provisioningDetails: [] }),
        },
        action: 'pax8.order.line.update',
        safeDetails: { lineId: LINE_ID },
      },
      {
        service: mocks.preflightOrder,
        path: `/orders/${ORDER_ID}/preflight`,
        init: { method: 'POST' },
        action: 'pax8.order.preflight',
      },
      {
        service: mocks.submitOrder,
        path: `/orders/${ORDER_ID}/submit`,
        init: { method: 'POST' },
        action: 'pax8.order.submit',
      },
      {
        service: mocks.reconcileOrder,
        path: `/orders/${ORDER_ID}/reconcile`,
        init: { method: 'POST' },
        action: 'pax8.order.reconcile',
      },
    ];

    for (const scenario of cases) {
      mocks.writeRouteAudit.mockClear();
      scenario.service.mockRejectedValueOnce(new Pax8OrderError('Rejected.', 422));
      const res = await request(scenario.path, scenario.init);
      expect(res.status, scenario.action).toBe(422);
      expect(mocks.writeRouteAudit, scenario.action).toHaveBeenCalledTimes(1);
      expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: scenario.action,
        result: 'failure',
        details: {
          partnerId: PARTNER_A,
          ...scenario.safeDetails,
          status: 422,
          errorClass: 'Pax8OrderError',
        },
      }));
    }
  });

  it('returns raw preflight validation bodies with 422 and audits the failed outcome', async () => {
    const body = '{"details":[{"field":"tenant","message":"required"}]}';
    mocks.preflightOrder.mockResolvedValueOnce({ ok: false, errorBody: body });
    const res = await request(`/orders/${ORDER_ID}/preflight`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(await res.text()).toBe(body);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.preflight', result: 'failure',
    }));
  });

  it('submits and reconciles with the authenticated actor and audits after success', async () => {
    expect((await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' })).status).toBe(200);
    expect(mocks.submitOrder).toHaveBeenCalledWith({ partnerId: PARTNER_A, orderId: ORDER_ID, actorUserId: USER_ID });
    expect((await request(`/orders/${ORDER_ID}/reconcile`, { method: 'POST' })).status).toBe(200);
    expect(mocks.reconcileOrder).toHaveBeenCalledWith({ partnerId: PARTNER_A, orderId: ORDER_ID });
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(2);
    expect(mocks.writeRouteAudit).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      action: 'pax8.order.submit', result: 'success',
      details: {
        partnerId: PARTNER_A, orderStatus: 'completed',
        succeededCount: 0, failedCount: 0, needsReconcileCount: 0,
      },
    }));
    expect(mocks.writeRouteAudit).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      action: 'pax8.order.reconcile', result: 'success',
    }));
  });

  it('audits a terminally failed submit outcome as failure', async () => {
    mocks.submitOrder.mockResolvedValueOnce({ orderId: ORDER_ID, status: 'failed', lines: [] });
    const res = await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.submit', result: 'failure',
      details: {
        partnerId: PARTNER_A, orderStatus: 'failed',
        succeededCount: 0, failedCount: 0, needsReconcileCount: 0,
        status: 200, errorClass: 'OrderResultNotCompleted',
      },
    }));
  });

  it('audits non-completed submit state counts without line payloads', async () => {
    mocks.submitOrder.mockResolvedValueOnce({
      orderId: ORDER_ID,
      status: 'partially_failed',
      lines: [
        { lineId: 'line-success', submitState: 'succeeded', error: null },
        { lineId: 'line-failed', submitState: 'failed', error: 'sensitive vendor detail' },
        { lineId: 'line-unknown', submitState: 'needs_reconcile', error: 'raw Pax8 body' },
      ],
    });
    const res = await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' });
    expect(res.status).toBe(200);
    const audit = mocks.writeRouteAudit.mock.calls[0]?.[1];
    expect(audit).toMatchObject({
      action: 'pax8.order.submit', result: 'failure',
      details: {
        partnerId: PARTNER_A,
        orderStatus: 'partially_failed',
        succeededCount: 1,
        failedCount: 1,
        needsReconcileCount: 1,
        status: 200,
        errorClass: 'OrderResultNotCompleted',
      },
    });
    expect(JSON.stringify(audit)).not.toContain('line-success');
    expect(JSON.stringify(audit)).not.toContain('sensitive vendor detail');
    expect(JSON.stringify(audit)).not.toContain('raw Pax8 body');
  });

  it('audits incomplete reconciliation totals without changing its response', async () => {
    mocks.reconcileOrder.mockResolvedValueOnce({ resolved: 2, stillUnknown: 1 });
    const res = await request(`/orders/${ORDER_ID}/reconcile`, { method: 'POST' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ resolved: 2, stillUnknown: 1 });
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.reconcile', result: 'failure',
      details: {
        partnerId: PARTNER_A,
        resolved: 2,
        stillUnknown: 1,
        status: 200,
        errorClass: 'ReconciliationIncomplete',
      },
    }));
  });

  it('validates UUID params and line bodies before service calls', async () => {
    expect((await request('/orders/not-a-uuid')).status).toBe(400);
    const badLine = await request(`/orders/${ORDER_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unknown' }),
    });
    expect(badLine.status).toBe(400);
    const clientOwnedPosition = await request(`/orders/${ORDER_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'new_subscription', pax8ProductId: 'prod-1', billingTerm: 'Monthly',
        quantity: '1.00', sortOrder: 99,
      }),
    });
    expect(clientOwnedPosition.status).toBe(400);
    expect(mocks.addOrderLine).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('preserves a raw Pax8ApiError response but excludes its body from failure audit metadata', async () => {
    const raw = '{"details":[{"secretProvisioningValue":"do-not-audit"}]}';
    mocks.submitOrder.mockRejectedValueOnce(new Pax8ApiError('vendor failure', 422, raw));
    const res = await request(`/orders/${ORDER_ID}/submit`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(raw);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'pax8.order.submit', result: 'failure',
      details: { partnerId: PARTNER_A, status: 502, errorClass: 'Pax8ApiError' },
    }));
    expect(JSON.stringify(mocks.writeRouteAudit.mock.calls)).not.toContain('do-not-audit');
  });

  it('audits an unexpected authorized mutation failure without its message or stack', async () => {
    mocks.reconcileOrder.mockRejectedValueOnce(new Error('postgresql://user:secret@internal/orders'));
    const res = await request(`/orders/${ORDER_ID}/reconcile`, { method: 'POST' });
    expect(res.status).toBe(500);
    const audit = mocks.writeRouteAudit.mock.calls[0]?.[1];
    expect(audit).toMatchObject({
      action: 'pax8.order.reconcile', result: 'failure',
      details: { partnerId: PARTNER_A, status: 500, errorClass: 'UnexpectedError' },
    });
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  it('returns a generic 500 without leaking unexpected service errors', async () => {
    mocks.listPax8Orders.mockRejectedValueOnce(new Error('postgresql://user:secret@internal/orders'));
    const res = await request('/orders');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('Pax8 product proxy routes', () => {
  it('requires billing permission and the exact authenticated partner for product mappings', async () => {
    state.permissionDenied = true;
    expect((await request('/products')).status).toBe(403);
    state.permissionDenied = false;
    expect((await request(`/products?partnerId=${PARTNER_B}`)).status).toBe(403);
    expect(mocks.listPax8Products).not.toHaveBeenCalled();
  });

  it('lists bounded local product mappings without MFA or Pax8 HTTP', async () => {
    state.mfaDenied = true;
    const res = await request('/products');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [{ pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'M365' }],
    });
    expect(mocks.listPax8Products).toHaveBeenCalledWith({ partnerId: PARTNER_A });
    expect(mocks.createPax8ClientForIntegration).not.toHaveBeenCalled();
  });
  it('proxies provision details and dependencies through the partner active integration', async () => {
    mocks.getProvisionDetails.mockResolvedValueOnce([{ key: 'tenant', valueType: 'Input' }]);
    mockIntegrationClient();
    const details = await request('/products/prod-1/provision-details');
    expect(details.status).toBe(200);
    expect(mocks.getProvisionDetails).toHaveBeenCalledWith('prod-1');

    mocks.getProductDependencies.mockResolvedValueOnce({ commitments: [{ id: 'c1', allowForQuantityIncrease: true }] });
    mockIntegrationClient();
    const dependencies = await request('/products/prod-1/dependencies');
    expect(dependencies.status).toBe(200);
    expect(mocks.getProductDependencies).toHaveBeenCalledWith('prod-1');
    expect(mocks.runOutsideDbContext).toHaveBeenCalled();
  });

  it('returns 404 without HTTP when the partner has no active integration', async () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => []);
    mocks.dbSelect.mockReturnValueOnce(chain);
    const res = await request('/products/prod-1/dependencies');
    expect(res.status).toBe(404);
    expect(mocks.createPax8ClientForIntegration).not.toHaveBeenCalled();
  });

  it('returns a Pax8ApiError raw body as 502', async () => {
    mockIntegrationClient();
    mocks.getProductDependencies.mockRejectedValueOnce(new Pax8ApiError('vendor error', 500, 'upstream unavailable'));
    const res = await request('/products/prod-1/dependencies');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('upstream unavailable');
  });

  it('refuses a foreign integration returned during client resolution', async () => {
    mockIntegrationClient();
    mocks.createPax8ClientForIntegration.mockReset();
    mocks.createPax8ClientForIntegration.mockResolvedValueOnce({
      integration: { id: INTEGRATION_ID, partnerId: PARTNER_B },
      client: { getProductDependencies: mocks.getProductDependencies },
    });
    const res = await request('/products/prod-1/dependencies');
    expect(res.status).toBe(403);
    expect(mocks.getProductDependencies).not.toHaveBeenCalled();
  });
});
