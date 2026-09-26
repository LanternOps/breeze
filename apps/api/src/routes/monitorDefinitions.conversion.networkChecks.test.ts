import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { UserPermissions } from '../services/permissions';
import type { AuthContext } from '../middleware/auth';

const m = vi.hoisted(() => ({
  authenticated: true, permission: true, mfa: true,
  preview: vi.fn(), convert: vi.fn(), revert: vi.fn(), retire: vi.fn(),
  partner: vi.fn(), partnerPreview: vi.fn(), ledger: vi.fn(), counts: vi.fn(), audit: vi.fn(),
  networkPreview: vi.fn(), networkConvert: vi.fn(),
  NetworkCheckConversionError: class extends Error {
    constructor(public code: string, public status: 403 | 404 | 409) { super(code); }
  },
  NetworkHistoryError: class extends Error {
    constructor(public code: string, public status: 400 | 403 | 404 | 409) { super(code); }
  },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => m.authenticated ? next() : c.json({ error: 'Unauthorized' }, 401),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) => m.permission ? next() : c.json({ error: 'Permission denied' }, 403),
  requireMfa: () => async (c: any, next: any) => m.mfa ? next() : c.json({ error: 'MFA required' }, 403),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: m.audit }));
vi.mock('../services/monitors/conversion', () => ({
  previewPolicyConversion: m.preview, convertPolicy: m.convert,
  revertConversion: m.revert, retireSource: m.retire,
  convertPartnerLegacy: m.partner, previewPartnerConversion: m.partnerPreview, listConversionLedger: m.ledger, countPendingConversions: m.counts,
  ConversionError: class extends Error {
    constructor(public code: string, message: string, public details?: unknown) { super(message); }
  },
  ConversionPrerequisiteMissingError: class extends Error {
    constructor(public missing: string[]) { super('conversion prerequisites missing'); }
  },
}));
vi.mock('../services/monitors/conversion/loadSources', () => ({
  readRetirementReport: vi.fn(async () => ({ unconvertible: [], sweep: null })),
}));
vi.mock('../services/monitors/conversion/networkHistory', () => ({
  NetworkHistoryError: m.NetworkHistoryError,
}));
vi.mock('../services/monitors/conversion/networkChecks', () => ({
  previewNetworkCheckConversion: m.networkPreview,
  convertNetworkChecks: m.networkConvert,
  NetworkCheckConversionError: m.NetworkCheckConversionError,
}));
import { isSelfManagedDbContextRoute } from '../middleware/selfManagedDbContextRoutes';
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
import { ConversionError, ConversionPrerequisiteMissingError } from '../services/monitors/conversion';

const ORG = '10000000-0000-4000-8000-000000000001';
const PARTNER = '10000000-0000-4000-8000-000000000002';
const POLICY = '10000000-0000-4000-8000-000000000003';
const SOURCE = '10000000-0000-4000-8000-000000000004';
const OTHER = '10000000-0000-4000-8000-000000000005';
const HASH = 'a'.repeat(64);
function app(overrides: Partial<AuthContext> = {}, permissions?: unknown) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: PARTNER,
      user: { id: SOURCE }, canAccessOrg: (id: string) => id === ORG,
      ...overrides,
    } as AuthContext);
    if (permissions) c.set('permissions', permissions as UserPermissions);
    await next();
  });
  a.route('/monitor-definitions/conversion', monitorConversionRoutes);
  return a;
}
function request(path: string, method = 'GET', body?: unknown, auth: Partial<AuthContext> = {}, permissions?: unknown) {
  return app(auth, permissions).request(`/monitor-definitions/conversion${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.authenticated = m.permission = m.mfa = true;
  m.networkPreview.mockResolvedValue({ orgId: ORG, previewHash: HASH, items: [] });
  m.networkConvert.mockResolvedValue({ conversionIds: [SOURCE], retired: 0, monitorsCreated: 1, policyId: POLICY });
  m.counts.mockResolvedValue({ policies: 1, rows: 2, networkChecks: 3, pendingPolicies: [] });
});
describe('network check conversion routes', () => {
  it('requires orgId and denies inaccessible organizations', async () => {
    expect((await request('/network-checks')).status).toBe(400);
    expect((await request(`/network-checks?orgId=${OTHER}`)).status).toBe(404);
    expect((await request('/network-checks/convert', 'POST', { orgId: OTHER, previewHash: HASH })).status).toBe(404);
    expect(m.networkPreview).not.toHaveBeenCalled();
    expect(m.networkConvert).not.toHaveBeenCalled();
  });
  it.each([[[]], [[OTHER]]])('rejects auth or permissions site ceilings %j', async allowedSiteIds => {
    for (const [auth, permissions] of [[{ allowedSiteIds }, undefined], [{}, { allowedSiteIds }]] as const) {
      for (const [path, method, body] of [
        [`/network-checks?orgId=${ORG}`, 'GET', undefined],
        [`/pending?orgId=${ORG}`, 'GET', undefined],
        ['/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH }],
      ] as const) {
        const response = await request(path, method, body, auth, permissions);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'site_restricted_conversion' });
      }
    }
    expect(m.networkPreview).not.toHaveBeenCalled();
    expect(m.networkConvert).not.toHaveBeenCalled();
  });
  it('requires authentication, read/write permission, MFA and unrestricted devices', async () => {
    m.authenticated = false;
    expect((await request(`/network-checks?orgId=${ORG}`)).status).toBe(401);
    m.authenticated = true;
    m.permission = false;
    expect((await request(`/network-checks?orgId=${ORG}`)).status).toBe(403);
    expect((await request('/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH })).status).toBe(403);
    m.permission = true;
    m.mfa = false;
    const denied = await request('/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH });
    expect(await denied.json()).toEqual({ error: 'MFA required' });
    m.mfa = true;
    expect((await request(`/network-checks?orgId=${ORG}`, 'GET', undefined, { allowedDeviceIds: [] })).status).toBe(403);
    expect(m.networkPreview).not.toHaveBeenCalled();
    expect(m.networkConvert).not.toHaveBeenCalled();
  });
  it('forwards preview and selected conversion inputs without an envelope', async () => {
    expect(await (await request(`/network-checks?orgId=${ORG}`)).json()).toEqual({ orgId: ORG, previewHash: HASH, items: [] });
    expect(m.networkPreview).toHaveBeenCalledWith(ORG, expect.objectContaining({ orgId: ORG }));
    const result = await request('/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH, sourceIds: [SOURCE] });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ conversionIds: [SOURCE], retired: 0, monitorsCreated: 1, policyId: POLICY });
    expect(m.networkConvert).toHaveBeenCalledWith(ORG, HASH, expect.objectContaining({ orgId: ORG }), { sourceIds: [SOURCE] });
    expect(m.audit).toHaveBeenCalled();
  });
  it('reports blocked preview and prerequisite failure on confirmation', async () => {
    const missing = ['runtime capability'];
    const preview = { orgId: ORG, previewHash: '', items: [], blockedBy: 'prerequisite_missing', missingPrerequisites: missing };
    m.networkPreview.mockResolvedValue(preview);
    expect(await (await request(`/network-checks?orgId=${ORG}`)).json()).toEqual(preview);
    m.networkConvert.mockRejectedValue(new ConversionPrerequisiteMissingError(missing));
    const result = await request('/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'CONVERSION_PREREQUISITE_MISSING', missing });
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('maps stale confirmations centrally', async () => {
    m.networkConvert.mockRejectedValue(new m.NetworkCheckConversionError('stale_preview', 409));
    const result = await request('/network-checks/convert', 'POST', { orgId: ORG, previewHash: HASH });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'stale_preview' });
  });
  it('validates conversion input', async () => {
    for (const body of [{}, { orgId: ORG, previewHash: 'bad' }, { orgId: ORG, previewHash: HASH, sourceIds: ['bad'] }]) {
      expect((await request('/network-checks/convert', 'POST', body)).status).toBe(400);
    }
    expect(m.networkConvert).not.toHaveBeenCalled();
  });
  it('preserves pending counts and reports networks separately', async () => {
    expect(await (await request(`/pending?orgId=${ORG}`)).json()).toEqual({
      data: { policies: 1, rows: 2, networkChecks: 3, pendingPolicies: [], unconvertible: [], sweep: null },
    });
  });
  it('opts transaction-owning endpoints out of ambient request transactions', () => {
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/monitor-definitions/conversion/network-checks')).toBe(true);
    expect(isSelfManagedDbContextRoute('POST', '/api/v1/monitor-definitions/conversion/network-checks/convert')).toBe(true);
    expect(isSelfManagedDbContextRoute('GET', '/api/v1/monitor-definitions/conversion/pending')).toBe(false);
  });
});
