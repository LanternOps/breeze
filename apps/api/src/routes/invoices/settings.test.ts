import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted with the vi.mock factories (they reference it), so it is declared as a
// var-like class expression via vi.hoisted.
/** Mutable actor so the reporting-totals cases can switch to an ORG-scoped token. */
const { authState } = vi.hoisted(() => ({ authState: { value: {} as Record<string, unknown> } }));

// Mock the service layer — the settings routes are thin; we assert wiring,
// validation, and error mapping (mirrors invoices.test.ts).
vi.mock('../../services/invoiceService', () => ({
  updatePartnerBillingSettings: vi.fn(),
  updateOrgBillingSettings: vi.fn()
}));

// Multi-currency wave 7 (#3779): the reporting-totals route is thin — the money
// math lives in the service and is proven in reportingTotals.test.ts.
vi.mock('../../services/reportingTotals', async () => {
  // Only the two async, DB-touching functions are stubbed. `parseGroupsParam` is
  // the REAL parser, so these cases prove the route surfaces its 400s rather
  // than testing a stand-in that could drift from it.
  const actual = await vi.importActual<typeof import('../../services/reportingTotals')>(
    '../../services/reportingTotals');
  return {
    parseGroupsParam: actual.parseGroupsParam,
    computeReportingTotal: vi.fn(),
    resolvePartnerReportingCurrency: vi.fn(),
  };
});

// InvoiceServiceError lives in invoiceTypes; the shared route helpers import it.
vi.mock('../../services/invoiceTypes', () => ({
  InvoiceServiceError: class InvoiceServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with invoice perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', authState.value);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { invoiceSettingsRoutes } from './settings';
import * as reporting from '../../services/reportingTotals';
import { ExchangeRateServiceError } from '../../services/exchangeRateService';
import * as svc from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

function jsonBody(body: unknown) {
  return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const PARTNER_ACTOR = { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null };
const ORG_ACTOR = { user: { id: 'u2' }, partnerId: 'p1', orgId: ORG_ID, scope: 'organization', accessibleOrgIds: [ORG_ID] };

describe('billing settings routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.value = { ...PARTNER_ACTOR };
  });

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

  it('#3205 W07: PATCH /partner/billing-settings round-trips invoiceDeviceAppendix', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceDeviceAppendix: true,
    }));
    expect(res.status).toBe(200);
    expect((svc.updatePartnerBillingSettings as any).mock.calls[0]![0]).toMatchObject({ invoiceDeviceAppendix: true });
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

  // #3430 — billingWebsite is snapshotted onto issued invoices/quotes and
  // rendered in branded PDFs and the customer portal, so a dangerous scheme
  // must be rejected at the boundary rather than persisted on a 200.
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd'])(
    'PATCH /partner/billing-settings rejects billingWebsite %j (→ 400, no service call)',
    async (billingWebsite) => {
      const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
        currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, billingWebsite
      }));
      expect(res.status).toBe(400);
      expect(svc.updatePartnerBillingSettings).not.toHaveBeenCalled();
    }
  );

  it('PATCH /partner/billing-settings accepts an https billingWebsite', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingWebsite: 'https://acme.example.com'
    }));
    expect(res.status).toBe(200);
    expect(svc.updatePartnerBillingSettings).toHaveBeenCalledWith(
      expect.objectContaining({ billingWebsite: 'https://acme.example.com' }),
      expect.objectContaining({ partnerId: 'p1' })
    );
  });

  it('PATCH /partner/billing-settings persists documentTheme and documentPageSize', async () => {
    (svc.updatePartnerBillingSettings as any).mockResolvedValue({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      documentTheme: 'condensed', documentPageSize: 'letter',
    });
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      documentTheme: 'condensed', documentPageSize: 'letter'
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.documentTheme).toBe('condensed');
    expect(data.data.documentPageSize).toBe('letter');
    expect(svc.updatePartnerBillingSettings).toHaveBeenCalledWith(
      expect.objectContaining({ documentTheme: 'condensed', documentPageSize: 'letter' }),
      expect.objectContaining({ partnerId: 'p1' })
    );
  });

  it('PATCH /partner/billing-settings rejects an invalid documentTheme (→ 400, no service call)', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, documentTheme: 'garish'
    }));
    expect(res.status).toBe(400);
    expect(svc.updatePartnerBillingSettings).not.toHaveBeenCalled();
  });

  it('PATCH /partner/billing-settings rejects an invalid documentPageSize (→ 400, no service call)', async () => {
    const res = await invoiceSettingsRoutes.request('/partner/billing-settings', jsonBody({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, documentPageSize: 'legal'
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

  // -------------------------------------------------------------------------
  // Multi-currency wave 7 (#3779): GET /billing/reporting-totals.
  // Reporting-only FX, converted SERVER-side (spec §8) — the browser never
  // multiplies money. Deliberately permission-free and readable by an
  // ORGANIZATION-scoped token, whose target currency is derived from the actor's
  // partner rather than /orgs/partners/me (partner-scope only, orgs.ts:723).
  // -------------------------------------------------------------------------
  const TOTAL = {
    status: 'available', targetCurrencyCode: 'CAD', requestedDate: '2026-09-03', maxStalenessDays: 7,
    rateDate: '2026-09-02', total: '22715.00', groups: [], unavailableCurrencyCodes: [],
  };

  it('GET /billing/reporting-totals returns the service result under data', async () => {
    (reporting.computeReportingTotal as any).mockResolvedValue(TOTAL);
    const res = await invoiceSettingsRoutes.request(
      '/billing/reporting-totals?groups=USD:12300.00,EUR:4100.00&to=CAD&date=2026-09-03');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(TOTAL);
    expect(reporting.computeReportingTotal).toHaveBeenCalledWith(
      [{ currencyCode: 'USD', amount: '12300.00' }, { currencyCode: 'EUR', amount: '4100.00' }],
      'CAD',
      // Passed through VERBATIM — never defaulted to today server-side.
      '2026-09-03',
    );
    // The client cannot widen the staleness ceiling: there is no such param.
    expect(reporting.computeReportingTotal).toHaveBeenCalledTimes(1);
    expect((reporting.computeReportingTotal as any).mock.calls[0]).toHaveLength(3);
    expect(reporting.resolvePartnerReportingCurrency).not.toHaveBeenCalled();
  });

  it('derives the target from the actor PARTNER for an organization-scoped token (no /orgs/partners/me)', async () => {
    authState.value = { ...ORG_ACTOR };
    (reporting.resolvePartnerReportingCurrency as any).mockResolvedValue('GBP');
    (reporting.computeReportingTotal as any).mockResolvedValue({ ...TOTAL, targetCurrencyCode: 'GBP' });
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=USD:1.00&date=2026-09-03');
    expect(res.status).toBe(200);
    expect((await res.json()).data.targetCurrencyCode).toBe('GBP');
    expect(reporting.resolvePartnerReportingCurrency).toHaveBeenCalledWith('p1');
    expect((reporting.computeReportingTotal as any).mock.calls[0][1]).toBe('GBP');
  });

  it('returns 409 NO_REPORTING_CURRENCY when the partner has none — never a USD substitute', async () => {
    (reporting.resolvePartnerReportingCurrency as any).mockResolvedValue(null);
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=USD:1.00&date=2026-09-03');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_REPORTING_CURRENCY');
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it.each(['USD', 'USD:', ':12', 'USD:abc', 'USD:-5'])(
    'rejects the malformed groups value %j (→ 400, no service call)', async (groups) => {
      const res = await invoiceSettingsRoutes.request(
        `/billing/reporting-totals?groups=${encodeURIComponent(groups)}&to=CAD&date=2026-09-03`);
      expect(res.status).toBe(400);
      expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
    });

  it('rejects a duplicated currency in groups (→ 400)', async () => {
    const res = await invoiceSettingsRoutes.request(
      '/billing/reporting-totals?groups=USD:1.00,USD:2.00&to=CAD&date=2026-09-03');
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('rejects more than 34 groups (→ 400)', async () => {
    const groups = Array.from({ length: 35 }, (_, i) => `USD:${i}.00`).join(',');
    const res = await invoiceSettingsRoutes.request(
      `/billing/reporting-totals?groups=${encodeURIComponent(groups)}&to=CAD&date=2026-09-03`);
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('rejects an unknown currency code in to (→ 400)', async () => {
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=USD:1.00&to=ZZZ&date=2026-09-03');
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('rejects an unknown currency code in groups (→ 400)', async () => {
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=ZZZ:1.00&to=CAD&date=2026-09-03');
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('rejects a missing date (→ 400) — never defaulted to today', async () => {
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=USD:1.00&to=CAD');
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('rejects an unknown query param (strict schema → 400)', async () => {
    const res = await invoiceSettingsRoutes.request(
      '/billing/reporting-totals?groups=USD:1.00&to=CAD&date=2026-09-03&maxStalenessDays=90');
    expect(res.status).toBe(400);
    expect(reporting.computeReportingTotal).not.toHaveBeenCalled();
  });

  it('returns an UNAVAILABLE result as HTTP 200 data, not an error status', async () => {
    const unavailable = { ...TOTAL, status: 'unavailable', total: null, rateDate: null, unavailableCurrencyCodes: ['NGN'] };
    (reporting.computeReportingTotal as any).mockResolvedValue(unavailable);
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=NGN:1.00&to=CAD&date=2026-09-03');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('unavailable');
    expect(body.data.total).toBeNull();
  });

  it('maps an ExchangeRateServiceError to its status + code', async () => {
    (reporting.computeReportingTotal as any).mockRejectedValue(
      new ExchangeRateServiceError(400, 'INVALID_DATE', '2026-02-30 is not a real calendar date'));
    const res = await invoiceSettingsRoutes.request('/billing/reporting-totals?groups=USD:1.00&to=CAD&date=2026-02-30');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_DATE');
  });
});
