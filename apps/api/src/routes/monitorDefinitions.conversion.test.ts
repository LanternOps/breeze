import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

const m = vi.hoisted(() => ({
  authenticated: true, permission: true, mfa: true,
  preview: vi.fn(), convert: vi.fn(), revert: vi.fn(), retire: vi.fn(),
  partner: vi.fn(), partnerPreview: vi.fn(), ledger: vi.fn(), counts: vi.fn(), audit: vi.fn(),
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
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
import { ConversionError, ConversionPrerequisiteMissingError } from '../services/monitors/conversion';

const ORG = '10000000-0000-4000-8000-000000000001';
const PARTNER = '10000000-0000-4000-8000-000000000002';
const POLICY = '10000000-0000-4000-8000-000000000003';
const SOURCE = '10000000-0000-4000-8000-000000000004';
const OTHER = '10000000-0000-4000-8000-000000000005';
const HASH = 'a'.repeat(64);
function app(overrides: Partial<AuthContext> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: PARTNER,
      user: { id: SOURCE }, canAccessOrg: (id: string) => id === ORG,
      ...overrides,
    } as AuthContext);
    await next();
  });
  a.route('/monitor-definitions/conversion', monitorConversionRoutes);
  return a;
}
function request(path: string, method = 'GET', body?: unknown, auth: Partial<AuthContext> = {}) {
  return app(auth).request(`/monitor-definitions/conversion${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const mutations: Array<[string, unknown]> = [
  [`/policies/${POLICY}/convert`, { previewHash: HASH, sourceIds: [SOURCE] }],
  [`/${SOURCE}/revert`, undefined],
  ['/retire', { sourceTable: 'config_policy_alert_rules', sourceId: SOURCE, reason: 'operator' }],
  ['/partner/convert-all', { previewHash: HASH }],
];
beforeEach(() => {
  vi.resetAllMocks();
  m.authenticated = m.permission = m.mfa = true;
  m.preview.mockResolvedValue({ policyId: POLICY, previewHash: HASH, items: [], inheritanceMode: 'replace', equivalence: { devicesChecked: 0, deltas: [] } });
  m.convert.mockResolvedValue({ conversionIds: [SOURCE], retired: 1, monitorsCreated: 1 });
  m.counts.mockResolvedValue({ policies: 0, rows: 0, standaloneRules: 9, pendingPolicies: [] });
  m.retire.mockResolvedValue({ conversionId: SOURCE });
  m.ledger.mockResolvedValue({ items: [], nextCursor: null });
  m.partnerPreview.mockResolvedValue({ partnerId: PARTNER, previewHash: HASH, policies: 2, rows: 3, convertible: 3, unconvertible: [] });
  m.partner.mockResolvedValue({ policies: 2, converted: 3, unconvertible: 1 });
});
describe('conversion resource', () => {
  it('returns a finished preview and passes the authenticated identity', async () => {
    const r = await request(`/policies/${POLICY}/preview`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ data: { policyId: POLICY, previewHash: HASH } });
    expect(m.preview).toHaveBeenCalledWith(POLICY, expect.objectContaining({ orgId: ORG }));
  });
  it('polls the same preview resource with 202 and progress', async () => {
    m.preview.mockResolvedValue({ status: 'running', progress: { checked: 50, total: 501 } });
    const r = await request(`/policies/${POLICY}/preview`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ data: { status: 'running', progress: { checked: 50, total: 501 } } });
  });
  it('passes preview hash and selected sources without accepting a caller-supplied owner', async () => {
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(200);
    expect(m.convert).toHaveBeenCalledWith(POLICY, HASH, expect.anything(), { sourceIds: [SOURCE] });
    expect(await r.json()).toEqual({ data: { conversionIds: [SOURCE], retired: 1, monitorsCreated: 1 } });
  });
  it('revert and retire return explicit mutation outcomes', async () => {
    for (const [path, body] of mutations.slice(1, 3)) {
      const r = await request(path, 'POST', body);
      expect(await r.json()).toEqual(path === '/retire' ? { success: true, conversionId: SOURCE } : { success: true });
    }
    expect(m.revert).toHaveBeenCalledWith(SOURCE, expect.anything());
    expect(m.retire).toHaveBeenCalledWith('config_policy_alert_rules', SOURCE, 'operator', expect.anything());
    expect(m.audit).toHaveBeenCalledTimes(2);
  });
  it('partner convert-all infers the partner and requires full partner membership', async () => {
    expect((await request('/partner/convert-all', 'POST', { previewHash: HASH })).status).toBe(403);
    expect((await request('/partner/convert-all', 'POST', { previewHash: HASH }, { scope: 'partner', partnerOrgAccess: 'selected' })).status).toBe(403);
    const r = await request('/partner/convert-all', 'POST', { previewHash: HASH }, { scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
    expect(r.status).toBe(200);
    expect(m.partner).toHaveBeenCalledWith(PARTNER, HASH, expect.objectContaining({ scope: 'partner' }));
  });
  it('pending projects the banner contract and denies a cross-org query before reading', async () => {
    const r = await request('/pending');
    expect(await r.json()).toEqual({ data: { policies: 0, rows: 0, pendingPolicies: [] } });
    expect(m.counts).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER, includePartnerWide: false });
    // The list and the count come from one query, so the banner and the
    // pending-policies list can never disagree (#6644 review finding 5).
    m.counts.mockResolvedValueOnce({ policies: 1, rows: 3, standaloneRules: 0, pendingPolicies: [{ id: POLICY, name: 'Legacy' }] });
    expect(await (await request('/pending')).json()).toEqual({ data: { policies: 1, rows: 3, pendingPolicies: [{ id: POLICY, name: 'Legacy' }] } });
    m.counts.mockClear();
    expect((await request(`/pending?orgId=${OTHER}`)).status).toBe(403);
    expect(m.counts).not.toHaveBeenCalled();
  });
  it.each(mutations)('guards %s with auth, permissions, MFA, site and device ceilings', async (path, body) => {
    m.authenticated = false;
    expect((await request(path, 'POST', body)).status).toBe(401);
    m.authenticated = true; m.permission = false;
    expect((await request(path, 'POST', body)).status).toBe(403);
    m.permission = true; m.mfa = false;
    expect((await request(path, 'POST', body)).status).toBe(403);
    m.mfa = true;
    expect((await request(path, 'POST', body, { allowedSiteIds: [] })).status).toBe(403);
    expect((await request(path, 'POST', body, { allowedDeviceIds: [SOURCE] })).status).toBe(403);
    expect(m.convert).not.toHaveBeenCalled();
    expect(m.revert).not.toHaveBeenCalled();
    expect(m.retire).not.toHaveBeenCalled();
    expect(m.partner).not.toHaveBeenCalled();
  });
  it.each([
    ['/policies/not-a-uuid/preview', 'GET', undefined],
    [`/policies/${POLICY}/convert`, 'POST', {}],
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: HASH, sourceIds: [] }],
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: HASH, sourceIds: ['bad'] }],
    ['/retire', 'POST', { sourceTable: 'alerts', sourceId: SOURCE, reason: 'operator' }],
    ['/retire', 'POST', { sourceTable: 'automations', sourceId: SOURCE, reason: 'converted' }],
    ['/pending?orgId=bad', 'GET', undefined],
  ])('rejects invalid input %s', async (path, method, body) => {
    expect((await request(path as string, method as string, body)).status).toBe(400);
  });
  it.each([
    ['policy_not_found', 404], ['partner_wide_denied', 403],
    ['preview_stale', 409], ['conversion_revert_unavailable', 409], ['equivalence_delta', 409], ['blocked', 409],
    ['source_not_found', 404], ['conversion_not_found', 404], ['already_converted', 409],
  ] as const)('maps %s without claiming success', async (code, status) => {
    m.convert.mockRejectedValue(new ConversionError(code, code, { reason: code }));
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(status);
    expect(await r.json()).toMatchObject({ error: code, details: { reason: code } });
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('names missing prerequisites and lets unexpected failures become 500', async () => {
    m.convert.mockRejectedValueOnce(new ConversionPrerequisiteMissingError(['#6342']));
    const r = await request(mutations[0]![0], 'POST', mutations[0]![1]);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'CONVERSION_PREREQUISITE_MISSING', missing: ['#6342'] });
    m.convert.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await request(mutations[0]![0], 'POST', mutations[0]![1])).status).toBe(500);
  });
});

it('previews the whole partner and requires its hash at confirmation', async () => {
  const auth = { scope: 'partner' as const, orgId: null, partnerOrgAccess: 'all' as const };
  expect((await request('/partner/preview', 'POST', undefined, auth)).status).toBe(200);
  expect(m.partnerPreview).toHaveBeenCalledWith(PARTNER, expect.objectContaining(auth));
  expect((await request('/partner/convert-all', 'POST', {}, auth)).status).toBe(400);
  m.partner.mockRejectedValueOnce(new ConversionError('preview_stale', 'Partner scope changed'));
  expect((await request('/partner/convert-all', 'POST', { previewHash: HASH }, auth)).status).toBe(409);
});
it('browses persistent ledger entries with an opaque cursor and lifecycle availability', async () => {
  const entry = { id: SOURCE, sourceTable: 'config_policy_alert_rules', sourceId: SOURCE, sourceName: 'CPU',
    policyId: POLICY, convertedBy: null, convertedAt: '2026-09-19T00:00:00.000Z', revertedAt: null,
    revertable: false, outputs: [] };
  m.ledger.mockResolvedValueOnce({ items: [entry], nextCursor: SOURCE });
  const response = await request(`/ledger?orgId=${ORG}&policyId=${POLICY}&limit=1`);
  expect(await response.json()).toEqual({ items: [entry], nextCursor: SOURCE });
  expect(m.ledger).toHaveBeenCalledWith({ orgId: ORG, policyId: POLICY, limit: 1 }, expect.anything());
  expect((await request('/ledger?limit=101')).status).toBe(400);
});
it('rejects unavailable revert before mutation or success audit', async () => {
  m.revert.mockRejectedValueOnce(new ConversionError('conversion_revert_unavailable', 'Legacy runtime retired'));
  const response = await request(`/${SOURCE}/revert`, 'POST');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'conversion_revert_unavailable' });
  expect(m.audit).not.toHaveBeenCalled();
});
it.each([{ allowedSiteIds: [] }, { allowedSiteIds: [SOURCE] }])('does not return policy preview to site-restricted callers', async ({ allowedSiteIds }) => {
  m.preview.mockRejectedValueOnce(new ConversionError('partner_wide_denied', 'Full policy scope required'));
  expect((await request(`/policies/${POLICY}/preview`, 'GET', undefined, { allowedSiteIds })).status).toBe(403);
});

it.each(['selected', 'all'] as const)('counts pending for %s partner access', async (partnerOrgAccess) => {
  const r = await request('/pending', 'GET', undefined, { scope: 'partner', orgId: null, partnerOrgAccess });
  expect(r.status).toBe(200);
  expect(m.counts).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER, includePartnerWide: partnerOrgAccess === 'all' });
});
it('requires owner selection for pending and a partner selection for system partner operations', async () => {
  expect((await request('/pending', 'GET', undefined, { scope: 'system', orgId: null, partnerId: null })).status).toBe(400);
  for (const [path, body] of [['/partner/preview', undefined], ['/partner/convert-all', { previewHash: HASH }]] as const) {
    expect((await request(path, 'POST', body, { scope: 'system', partnerId: null })).status).toBe(400);
  }
  expect(m.counts).not.toHaveBeenCalled();
  expect(m.partnerPreview).not.toHaveBeenCalled();
  expect(m.partner).not.toHaveBeenCalled();
});
it.each([
  ['/partner/preview', 'POST'], ['/pending', 'GET'], ['/ledger', 'GET'], [`/policies/${POLICY}/preview`, 'GET'],
])('requires authentication and read permission for %s', async (path, method) => {
  m.authenticated = false;
  expect((await request(path!, method)).status).toBe(401);
  m.authenticated = true; m.permission = false;
  expect((await request(path!, method)).status).toBe(403);
  for (const mock of [m.partnerPreview, m.counts, m.ledger, m.preview]) expect(mock).not.toHaveBeenCalled();
});
it('rejects caller-supplied ownership and invalid hashes, cursors and conversion ids', async () => {
  for (const [path, method, body] of [
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: HASH, orgId: OTHER }],
    ['/partner/convert-all', 'POST', { previewHash: HASH, partnerId: OTHER }],
    [`/policies/${POLICY}/convert`, 'POST', { previewHash: 'invalid' }],
    ['/ledger?cursor=invalid', 'GET', undefined],
    ['/ledger?limit=0', 'GET', undefined],
    ['/invalid/revert', 'POST', undefined],
  ] as const) expect((await request(path, method, body)).status).toBe(400);
  expect(m.convert).not.toHaveBeenCalled();
  expect(m.partner).not.toHaveBeenCalled();
  expect(m.revert).not.toHaveBeenCalled();
});
