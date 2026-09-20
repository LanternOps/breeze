import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  mfaAllowed: { value: true },
  requireMfa: vi.fn(() => async (c: any, next: any) => (mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403))),
  audit: vi.fn(),
  backlog: vi.fn(),
  convertPartnerLegacy: vi.fn(), previewPartnerConversion: vi.fn(),
}));
vi.mock('../../middleware/auth', () => ({ requireMfa: mocks.requireMfa }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../../services/monitors/conversion/partnerBacklog', () => ({ listPartnerConversionBacklog: mocks.backlog }));
vi.mock('../../services/monitors/conversion', () => ({
  convertPartnerLegacy: mocks.convertPartnerLegacy, previewPartnerConversion: mocks.previewPartnerConversion,
  ConversionError: class ConversionError extends Error {
    constructor(public code: string, message: string, public details?: unknown) { super(message); }
  },
  ConversionPrerequisiteMissingError: class ConversionPrerequisiteMissingError extends Error {
    constructor(public missing: string[]) { super('Missing prerequisites'); }
  },
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { ConversionError } from '../../services/monitors/conversion';
import { adminMonitorConversionRoutes } from './monitorConversion';

const PARTNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { scope: 'system', partnerId: null, orgId: null, user: { id: ADMIN, email: 'admin@lanternops.test', name: 'Admin', isPlatformAdmin: true } } as never);
    await next();
  });
  app.route('/admin/monitor-conversion', adminMonitorConversionRoutes);
  return app;
}

beforeEach(() => { vi.clearAllMocks(); mocks.mfaAllowed.value = true; });

describe('admin monitor-conversion routes', () => {
  it('GET /partners lists the backlog', async () => {
    mocks.backlog.mockResolvedValue([{ partnerId: PARTNER, partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }]);
    const res = await buildApp().request('/admin/monitor-conversion/partners');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ partnerId: PARTNER, partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }] });
  });
  it('POST converts as system (null persisted actors) and audits the initiating administrator', async () => {
    mocks.convertPartnerLegacy.mockResolvedValue({ policies: 1, converted: 3, unconvertible: 0 });
    const res = await buildApp().request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewHash: 'partner-h' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { policies: 1, converted: 3, unconvertible: 0 } });
    const [partnerId, previewHash, auth] = mocks.convertPartnerLegacy.mock.calls[0]!;
    expect(previewHash).toBe('partner-h');
    expect(partnerId).toBe(PARTNER);
    expect(auth).toEqual(expect.objectContaining({ scope: 'system', partnerId: PARTNER, partnerOrgAccess: 'all', user: expect.objectContaining({ id: ADMIN }) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'monitor_conversion.admin_partner_convert', resourceId: PARTNER }));
    // writeRouteAudit derives attribution from the original request, not the converter's system principal.
    const [auditContext] = mocks.audit.mock.calls[0]!;
    expect(auditContext.get('auth').user.id).toBe(ADMIN);
    expect(auditContext.get('auth').partnerId).toBeNull();
    // Actual null FK persistence is asserted by the live case below, not this mocked converter.
  });
  it('previews the whole partner and rejects conversion without its hash', async () => {
    mocks.previewPartnerConversion.mockResolvedValue({ partnerId: PARTNER, previewHash: 'h1', policies: 2, rows: 4, convertible: 4, unconvertible: [] });
    const app = buildApp();
    const preview = await app.request(`/admin/monitor-conversion/partners/${PARTNER}/preview`, { method: 'POST' });
    expect(preview.status).toBe(200);
    expect((await preview.json()).data.previewHash).toBe('h1');
    const missing = await app.request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(400);
    expect(mocks.convertPartnerLegacy).not.toHaveBeenCalled();
  });
  it('POST is MFA-gated', async () => {
    mocks.mfaAllowed.value = false;
    const res = await buildApp().request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewHash: 'partner-h' }) });
    expect(res.status).toBe(403);
    expect(mocks.convertPartnerLegacy).not.toHaveBeenCalled();
  });
  it('POST rejects a non-uuid partner id', async () => {
    const res = await buildApp().request('/admin/monitor-conversion/partners/not-a-uuid/convert', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});


it('returns the converter conflict and does not audit a failed conversion', async () => {
  mocks.convertPartnerLegacy.mockRejectedValueOnce(new ConversionError('preview_stale', 'Preview inputs changed'));
  const res = await buildApp().request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewHash: 'old' }),
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: 'preview_stale', message: 'Preview inputs changed' });
  expect(mocks.audit).not.toHaveBeenCalled();
});
