import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'], scope: 'partner' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) =>
    c.req.header('x-allow') === 'true' ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const serviceMocks = vi.hoisted(() => ({ listInvoiceLineDevices: vi.fn() }));
vi.mock('../../services/billingEvidence', () => ({
  listInvoiceLineDevices: serviceMocks.listInvoiceLineDevices,
  INVOICE_LINE_DEVICES_DEFAULT_LIMIT: 100,
  INVOICE_LINE_DEVICES_MAX_LIMIT: 500,
}));

vi.mock('./invoices', () => ({
  invoiceActorFrom: (c: any) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, partnerId: auth.partnerId, accessibleOrgIds: auth.accessibleOrgIds };
  },
  handleServiceError: (c: any, err: any) => c.json({ error: err.message, code: err.code }, err.status),
}));

import { authMiddleware } from '../../middleware/auth';
import { invoiceEvidenceRoutes } from './evidence';

const { listInvoiceLineDevices } = serviceMocks;

const INV = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_INV = '33333333-3333-4333-8333-333333333333';
const OTHER_INVOICES_LINE = '44444444-4444-4444-8444-444444444444';
const PATH = `/${INV}/lines/${LINE}/devices`;
const OTHER_ORG_PATH = `/${OTHER_ORG_INV}/lines/${LINE}/devices`;
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', invoiceEvidenceRoutes);

describe('invoice evidence route (#3205 W07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listInvoiceLineDevices.mockResolvedValue({ recorded: true, total: 2, devices: [], nextCursor: null });
  });

  it('401 unauthenticated', async () => expect((await app.request(PATH)).status).toBe(401));

  it('403 without invoices:read', async () =>
    expect((await app.request(PATH, { headers: NO_PERM })).status).toBe(403));

  it('404 for a cross-tenant invoice id', async () => {
    listInvoiceLineDevices.mockRejectedValueOnce({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    expect((await app.request(OTHER_ORG_PATH, { headers: AUTH })).status).toBe(404);
  });

  it('404 for a line id from another invoice (same-parent ownership)', async () => {
    listInvoiceLineDevices.mockRejectedValueOnce({ status: 404, code: 'INVOICE_LINE_NOT_FOUND', message: 'Invoice line not found' });
    expect((await app.request(`/${INV}/lines/${OTHER_INVOICES_LINE}/devices`, { headers: AUTH })).status).toBe(404);
  });

  it('200 with the paged shape', async () => {
    const res = await app.request(`${PATH}?limit=2`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { recorded: true, total: expect.any(Number), devices: expect.any(Array) },
    });
    expect(listInvoiceLineDevices).toHaveBeenCalledWith(INV, LINE, { limit: 2, cursor: undefined }, expect.anything());
  });

  it('400 on limit=0, limit=501 and a non-numeric limit', async () => {
    for (const q of ['limit=0', 'limit=501', 'limit=abc']) {
      expect((await app.request(`${PATH}?${q}`, { headers: AUTH })).status).toBe(400);
    }
  });

  it('is mounted BEFORE invoiceCrudRoutes so /:id/lines/:lineId/devices is not swallowed', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(src.indexOf('invoiceEvidenceRoutes')).toBeLessThan(src.indexOf('invoiceCrudRoutes'));
  });
});
