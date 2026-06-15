import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — the settings routes are thin; we assert wiring,
// validation, and error mapping (mirrors invoices.test.ts).
vi.mock('../../services/invoiceService', () => ({
  updatePartnerBillingSettings: vi.fn(),
  updateOrgBillingSettings: vi.fn()
}));

// InvoiceServiceError lives in invoiceTypes; the shared route helpers import it.
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

import { invoiceSettingsRoutes } from './settings';
import * as svc from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

function jsonBody(body: unknown) {
  return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('billing settings routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PATCH /partner/billing-settings updates partner config', async () => {
    (svc.updatePartnerBillingSettings as any).mockResolvedValue({
      currencyCode: 'EUR', defaultTaxRate: '0.200', invoiceNumberPrefix: 'EU', invoiceTermsDays: 14, invoiceFooter: 'Thanks'
    });
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'EUR', defaultTaxRate: 0.2, invoiceNumberPrefix: 'EU', invoiceTermsDays: 14, invoiceFooter: 'Thanks'
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.currencyCode).toBe('EUR');
    expect(svc.updatePartnerBillingSettings).toHaveBeenCalledWith(
      expect.objectContaining({ currencyCode: 'EUR', invoiceNumberPrefix: 'EU', invoiceTermsDays: 14 }),
      expect.objectContaining({ partnerId: 'p1' })
    );
  });

  it('PATCH /partner/billing-settings rejects a bad currency code (→ 400, no service call)', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'EURO', invoiceNumberPrefix: 'EU', invoiceTermsDays: 14
    }));
    expect(res.status).toBe(400);
    expect(svc.updatePartnerBillingSettings).not.toHaveBeenCalled();
  });

  it('PATCH /partner/billing-settings rejects out-of-range terms days (→ 400)', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 999
    }));
    expect(res.status).toBe(400);
    expect(svc.updatePartnerBillingSettings).not.toHaveBeenCalled();
  });

  it('PATCH /orgs/:orgId/billing-settings updates org config', async () => {
    (svc.updateOrgBillingSettings as any).mockResolvedValue({ id: ORG_ID, taxExempt: true, taxRate: null });
    const res = await invoiceSettingsRoutes.request(`/orgs/${ORG_ID}/billing-settings`, jsonBody({
      taxId: 'GB123', taxExempt: true, billingAddressLine1: '1 High St', billingAddressCountry: 'GB'
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.taxExempt).toBe(true);
    expect(svc.updateOrgBillingSettings).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ taxId: 'GB123', taxExempt: true, billingAddressCountry: 'GB' }),
      expect.objectContaining({ partnerId: 'p1' })
    );
  });

  it('PATCH /orgs/:orgId/billing-settings rejects a non-UUID orgId (→ 400, no service call)', async () => {
    const res = await invoiceSettingsRoutes.request('/orgs/not-a-uuid/billing-settings', jsonBody({ taxExempt: true }));
    expect(res.status).toBe(400);
    expect(svc.updateOrgBillingSettings).not.toHaveBeenCalled();
  });

  it('maps an InvoiceServiceError to its HTTP status + code', async () => {
    (svc.updateOrgBillingSettings as any).mockRejectedValue(
      new InvoiceServiceError('Organization access denied', 403, 'ORG_DENIED')
    );
    const res = await invoiceSettingsRoutes.request(`/orgs/${ORG_ID}/billing-settings`, jsonBody({ taxExempt: true }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe('ORG_DENIED');
  });
});
