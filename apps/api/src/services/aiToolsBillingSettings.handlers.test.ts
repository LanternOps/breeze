import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c9';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';

function chain(rows: unknown[]): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  auditAsync: vi.fn(),
  updatePartner: vi.fn(),
  updateOrg: vi.fn(),
  impact: vi.fn(),
  computeTotal: vi.fn(),
  reportingCurrency: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync }));
vi.mock('./invoiceService', () => ({ updatePartnerBillingSettings: h.updatePartner, updateOrgBillingSettings: h.updateOrg }));
vi.mock('./orgCurrencyService', () => ({ getOrgCurrencyImpact: h.impact }));
vi.mock('./reportingTotals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reportingTotals')>();
  return { ...actual, computeReportingTotal: h.computeTotal, resolvePartnerReportingCurrency: h.reportingCurrency };
});

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerBillingSettingsTools } from './aiToolsBillingSettings';
import { InvoiceServiceError } from './invoiceTypes';

const tools = new Map<string, AiTool>();
registerBillingSettingsTools(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'partner',
  orgId: null,
  partnerId: PARTNER,
  partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const noMfa = () => makeAuth({ token: {} });
const run = async (input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get('manage_billing_settings')!.handler(input, auth)) as Record<string, any>;

const partnerRow = { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, defaultTaxRate: '8.25000', invoiceFooter: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.select.mockImplementation(() => chain([partnerRow]));
});

describe('manage_billing_settings', () => {
  it('refuses an organization-scoped caller (REST: partner or system scope)', async () => {
    const out = await run({ action: 'get_partner' }, makeAuth({ scope: 'organization', orgId: ORG }));
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('get_org: another partner\'s or an unreachable org is NOT_FOUND; a device-bound session cannot read org-wide settings', async () => {
    expect((await run({ action: 'get_org', orgId: OTHER_ORG })).code).toBe('NOT_FOUND');
    expect((await run({ action: 'get_org', orgId: ORG }, makeAuth({ allowedDeviceIds: ['d1'] }))).code).toBe('ACCESS_DENIED');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('both writes need an MFA session', async () => {
    expect((await run({ action: 'update_partner', partnerPatch: { invoiceTermsDays: 15 } }, noMfa())).code).toBe('MFA_REQUIRED');
    expect((await run({ action: 'update_org', orgId: ORG, orgPatch: { taxExempt: true } }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.updatePartner).not.toHaveBeenCalled();
    expect(h.updateOrg).not.toHaveBeenCalled();
  });

  it('update_partner needs canManagePartnerWidePolicies', async () => {
    const out = await run({ action: 'update_partner', partnerPatch: { invoiceTermsDays: 15 } }, makeAuth({ partnerOrgAccess: 'selected' }));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.updatePartner).not.toHaveBeenCalled();
  });

  it('update_partner merges the patch over the current required fields and audits changed field names only', async () => {
    h.updatePartner.mockResolvedValue({ ...partnerRow, invoiceTermsDays: 15 });
    const out = await run({ action: 'update_partner', partnerPatch: { invoiceTermsDays: 15 } });
    expect(h.updatePartner).toHaveBeenCalledWith(
      { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 15 },
      expect.objectContaining({ partnerId: PARTNER, userId: 'user-1' }),
    );
    expect(out.settings.invoiceTermsDays).toBe(15);
    // Quorum QW3: the previous value comes back so the change can be put back.
    expect(out.before).toEqual({ invoiceTermsDays: 30 });
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'partner.billing_settings.update', details: expect.objectContaining({ changedFields: ['invoiceTermsDays'] }),
    }));
  });

  it('update_partner refuses the agreement-reminder keys (agreements:send at REST; W14-D4)', async () => {
    const out = await run({ action: 'update_partner', partnerPatch: { agreementMaxReminders: 3 } });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.updatePartner).not.toHaveBeenCalled();
  });

  it('update_partner refuses an empty patch', async () => {
    expect((await run({ action: 'update_partner', partnerPatch: {} })).code).toBe('VALIDATION_ERROR');
    expect(h.updatePartner).not.toHaveBeenCalled();
  });

  it('update_org: unreachable org NOT_FOUND, device-bound refused, service errors keep their code', async () => {
    expect((await run({ action: 'update_org', orgId: OTHER_ORG, orgPatch: { taxExempt: true } })).code).toBe('NOT_FOUND');
    expect((await run({ action: 'update_org', orgId: ORG, orgPatch: { taxExempt: true } }, makeAuth({ allowedDeviceIds: ['d1'] }))).code).toBe('ACCESS_DENIED');
    expect(h.updateOrg).not.toHaveBeenCalled();
    h.updateOrg.mockRejectedValueOnce(new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND'));
    expect((await run({ action: 'update_org', orgId: ORG, orgPatch: { taxExempt: true } })).code).toBe('ORG_NOT_FOUND');
  });

  it('update_org passes only the validated patch (no currency, no billingProfileId) and audits field names, not values', async () => {
    h.updateOrg.mockResolvedValue({ id: ORG, taxExempt: true });
    h.select.mockImplementation(() => chain([{ id: ORG, taxExempt: false, billingContact: { email: 'old@example.test', name: 'AP' } }]));
    await run({ action: 'update_org', orgId: ORG, orgPatch: { taxExempt: true, billingContactEmail: 'ap@example.test' } });
    expect(h.updateOrg).toHaveBeenCalledWith(ORG, { taxExempt: true, billingContactEmail: 'ap@example.test' }, expect.anything());
    const out = await run({ action: 'update_org', orgId: ORG, orgPatch: { billingContactEmail: 'new@example.test' } });
    expect(out.before).toEqual({ billingContactEmail: 'old@example.test' });
    const audit = h.auditAsync.mock.calls[0]![0];
    expect(audit).toMatchObject({ action: 'organization.billing_settings.update', orgId: ORG });
    expect(JSON.stringify(h.auditAsync.mock.calls)).not.toMatch(/(old|ap|new)@example\.test/);
    expect(audit.details.before).toEqual({ taxExempt: false });
  });

  it('currency_impact refuses a device-bound session (org-wide preview)', async () => {
    expect((await run({ action: 'currency_impact', orgId: ORG, currencyCode: 'EUR' }, makeAuth({ allowedDeviceIds: ['d1'] }))).code).toBe('ACCESS_DENIED');
    expect(h.impact).not.toHaveBeenCalled();
  });

  it('currency_impact requires an accessible org and a currency', async () => {
    expect((await run({ action: 'currency_impact', orgId: ORG })).code).toBe('VALIDATION_ERROR');
    h.impact.mockResolvedValue({ groups: [] });
    expect(await run({ action: 'currency_impact', orgId: ORG, currencyCode: 'EUR' })).toEqual({ impact: { groups: [] } });
    expect(h.impact).toHaveBeenCalledWith(ORG, 'EUR', expect.objectContaining({ partnerId: PARTNER }));
  });

  it('reporting_totals defaults the target to the partner reporting currency', async () => {
    h.reportingCurrency.mockResolvedValue('USD');
    h.computeTotal.mockResolvedValue({ available: true, total: '10.00' });
    const out = await run({ action: 'reporting_totals', groups: 'EUR:1000', date: '2026-10-01' });
    expect(h.computeTotal).toHaveBeenCalledWith(expect.any(Array), 'USD', '2026-10-01');
    expect(out.total).toMatchObject({ total: '10.00' });
  });
});
