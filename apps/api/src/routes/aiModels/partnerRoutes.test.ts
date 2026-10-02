import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({ permissionDenied: false, mfaDenied: false }));
const permissionsState = vi.hoisted(() => ({ approvalsDecide: true }));

const P = '22222222-2222-4222-8222-222222222222';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T = new Date('2026-10-01T00:00:00.000Z');

const baseAuth = () => ({
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
  scope: 'partner',
  partnerId: P,
  partnerOrgAccess: 'all',
});
const authState: { value: any } = { value: baseAuth() };

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', authState.value);
    await next();
  },
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (authGates.permissionDenied) return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', {});
    await next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (authGates.mfaDenied) return c.json({ error: 'MFA required' }, 403);
    await next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => { await next(); }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
    APPROVALS_DECIDE: { resource: 'approvals', action: 'decide' },
    // Read at import by the Task 9 org/usage routers mounted in the same hub.
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    AI_SESSIONS_READ_ALL: { resource: 'ai_sessions', action: 'read_all' },
  },
  hasPermission: vi.fn((_p: unknown, resource: string, action: string) =>
    resource === 'approvals' && action === 'decide' ? permissionsState.approvalsDecide : true),
  userCanDecideApprovals: vi.fn(() => permissionsState.approvalsDecide),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));

vi.mock('../../services/aiModels/registryCutover', () => ({ ensurePartnerCutover: vi.fn() }));
vi.mock('../../services/aiModels/registryView', () => ({ buildPartnerModelsSnapshot: vi.fn() }));
vi.mock('../../services/aiModels/connections', () => ({ getCompatConnection: vi.fn(), getConnection: vi.fn() }));
vi.mock('../../services/aiModels/offerings', () => ({ getOffering: vi.fn() }));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn() }));
vi.mock('../../services/aiModels/connectionSettings', () => ({ updateConnectionSettings: vi.fn() }));
vi.mock('../../services/aiModels/offeringWrites', () => ({
  ensurePlatformOffering: vi.fn(),
  setOfferingEnabled: vi.fn(),
  updateOfferingDetails: vi.fn(),
  listOfferingDefaultUses: vi.fn(),
}));
vi.mock('../../services/aiModels/assignmentWrites', () => ({
  putPartnerAssignments: vi.fn(),
  touchesSurface: (rows: Array<{ surface: string }>, surface: string) => rows.some((r) => r.surface === surface),
}));
vi.mock('../../services/aiModels/residency', () => ({
  previewResidencyImpact: vi.fn(),
  setResidencyRequired: vi.fn(),
}));
vi.mock('../../services/llm/llmConfigResolver', () => ({ isLlmProviderCatalogEnabled: vi.fn(() => true) }));
vi.mock('../../services/partnerLlmConfig', () => {
  class PartnerLlmError extends Error {
    constructor(message: string, readonly status: 400 | 409 | 500 | 503) {
      super(message);
      this.name = 'PartnerLlmError';
    }
  }
  return {
    PartnerLlmError,
    savePartnerLlmKey: vi.fn(),
    updatePartnerLlmEndpoint: vi.fn(),
    deletePartnerLlmConfig: vi.fn(),
  };
});

import { aiModelsRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { getCompatConnection, getConnection } from '../../services/aiModels/connections';
import { getOffering } from '../../services/aiModels/offerings';
import { enqueueConnectionSync } from '../../jobs/aiModelDiscoveryWorker';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { ensurePlatformOffering, listOfferingDefaultUses, setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { putPartnerAssignments } from '../../services/aiModels/assignmentWrites';
import { previewResidencyImpact, setResidencyRequired } from '../../services/aiModels/residency';
import { deletePartnerLlmConfig, PartnerLlmError, savePartnerLlmKey, updatePartnerLlmEndpoint } from '../../services/partnerLlmConfig';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';

const chatRow = {
  surface: 'chat', role: 'default', defaultOfferingId: A, permittedOfferingIds: null,
  allowUserChoice: true, options: null, expectedUpdatedAt: null,
};
const KEY = 'sk-ant-' + 'x'.repeat(40);

const WRITE_ROUTES: Array<[method: string, path: string, body?: unknown]> = [
  ['POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY }],
  ['POST', `/connections/${C}/key`, { apiKey: KEY }],
  ['POST', `/connections/${C}/endpoint`, { catalogEntryId: null }],
  ['PATCH', `/connections/${C}`, { name: 'x' }],
  ['DELETE', `/connections/${C}`],
  ['POST', `/connections/${C}/refresh`],
  ['POST', `/offerings/platform/${PM}`, { enabled: true }],
  ['POST', `/offerings/${A}/enabled`, { enabled: true }],
  ['PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' }],
  ['POST', `/offerings/${A}/verify`],
  ['PUT', '/assignments', { assignments: [chatRow] }],
  ['PUT', '/residency', { required: false }],
];

const ALL_WRITE_SERVICE_MOCKS = [
  savePartnerLlmKey, updatePartnerLlmEndpoint, deletePartnerLlmConfig, updateConnectionSettings,
  ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails, putPartnerAssignments, setResidencyRequired,
  enqueueConnectionSync,
].map((m) => vi.mocked(m));

function call(method: string, path: string, body?: unknown) {
  return aiModelsRoutes.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const offeringRow = { id: A, partnerId: P, enabled: true, updatedAt: T };

beforeEach(() => {
  vi.clearAllMocks();
  authGates.permissionDenied = false;
  authGates.mfaDenied = false;
  permissionsState.approvalsDecide = true;
  authState.value = baseAuth();
  vi.mocked(ensurePartnerCutover).mockResolvedValue(true);
  vi.mocked(buildPartnerModelsSnapshot).mockResolvedValue({ connections: [] } as any);
  // Connection routes bind :id to the partner's compat connection (inside the
  // cutover gate), so the default must be the partner's own connection C.
  vi.mocked(getCompatConnection).mockResolvedValue({ id: C, partnerId: P } as any);
  vi.mocked(savePartnerLlmKey).mockResolvedValue({ last4: 'xxxx', model: 'm', verifiedAt: T, configVersion: 2 });
  vi.mocked(updatePartnerLlmEndpoint).mockResolvedValue({ catalogEntryId: null, configVersion: 3, slug: null, revision: null } as any);
  vi.mocked(deletePartnerLlmConfig).mockResolvedValue(true);
  vi.mocked(updateConnectionSettings).mockResolvedValue({ id: C, configVersion: 4 } as any);
  vi.mocked(ensurePlatformOffering).mockResolvedValue(offeringRow as any);
  vi.mocked(setOfferingEnabled).mockResolvedValue({ offering: offeringRow as any, inUse: [] });
  vi.mocked(updateOfferingDetails).mockResolvedValue(offeringRow as any);
  vi.mocked(listOfferingDefaultUses).mockResolvedValue([]);
  vi.mocked(getOffering).mockResolvedValue({ id: A, partnerId: P, connectionId: C } as any);
  vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: P, status: 'active' } as any);
  vi.mocked(enqueueConnectionSync).mockResolvedValue(undefined);
  vi.mocked(putPartnerAssignments).mockResolvedValue([{ surface: 'chat', role: 'default', updatedAt: T }] as any);
  vi.mocked(previewResidencyImpact).mockResolvedValue({ unavailableSurfaces: [], affectedOrgOverrides: [] });
  vi.mocked(setResidencyRequired).mockResolvedValue({ residencyRequired: false, impact: { unavailableSurfaces: [], affectedOrgOverrides: [] } });
});

describe('/ai/models partner routes — authz matrix', () => {
  it.each(WRITE_ROUTES)('%s %s succeeds for a full partner admin with MFA (control)', async (method, path, body) => {
    // POST /connections is a 409 when a compat connection already exists.
    if (path === '/connections') vi.mocked(getCompatConnection).mockResolvedValueOnce(null);
    const res = await call(method, path, body);
    expect(res.status).toBeLessThan(300);
  });
  it.each(WRITE_ROUTES)('%s %s → 403 without BILLING_MANAGE', async (method, path, body) => {
    authGates.permissionDenied = true;
    expect((await call(method, path, body)).status).toBe(403);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 403 without MFA', async (method, path, body) => {
    authGates.mfaDenied = true;
    expect((await call(method, path, body)).status).toBe(403);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 403 for a partner user with orgAccess != all', async (method, path, body) => {
    authState.value = { ...authState.value, partnerOrgAccess: 'selected' };
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('full partner org access');
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 403 for an org-scope token (no partner context)', async (method, path, body) => {
    authState.value = { ...authState.value, scope: 'organization', partnerId: null };
    expect((await call(method, path, body)).status).toBe(403);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 403 for an org-scope token that carries a partnerId', async (method, path, body) => {
    authState.value = { ...authState.value, scope: 'organization', partnerOrgAccess: null };
    expect((await call(method, path, body)).status).toBe(403);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 503 registry_unavailable when the cutover resolves false (W03 contract), and no service write', async (method, path, body) => {
    vi.mocked(ensurePartnerCutover).mockResolvedValueOnce(false);
    const res = await call(method, path, body);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
    expect(ensurePartnerCutover).toHaveBeenCalledWith(P);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 503 when the cutover rejects, too', async (method, path, body) => {
    vi.mocked(ensurePartnerCutover).mockRejectedValueOnce(new Error('cutover failed'));
    expect((await call(method, path, body)).status).toBe(503);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it('GET / needs BILLING_MANAGE but not MFA', async () => {
    authGates.mfaDenied = true;
    expect((await call('GET', '/')).status).toBe(200);
    expect(buildPartnerModelsSnapshot).toHaveBeenCalledWith(P);
    authGates.permissionDenied = true;
    expect((await call('GET', '/')).status).toBe(403);
  });
  it('GET / and GET /residency/preview need the partner-wide capability', async () => {
    authState.value = { ...authState.value, partnerOrgAccess: 'selected' };
    expect((await call('GET', '/')).status).toBe(403);
    expect((await call('GET', '/residency/preview')).status).toBe(403);
    expect(buildPartnerModelsSnapshot).not.toHaveBeenCalled();
    expect(previewResidencyImpact).not.toHaveBeenCalled();
  });
  it('GET /residency/preview reads without MFA and never gates on the cutover', async () => {
    authGates.mfaDenied = true;
    vi.mocked(ensurePartnerCutover).mockResolvedValue(false);
    const res = await call('GET', '/residency/preview');
    expect(res.status).toBe(200);
    expect(previewResidencyImpact).toHaveBeenCalledWith(P);
  });
});

describe('/ai/models partner routes — behaviour', () => {
  it('404s a connection id that is not the partner’s connection (forged id)', async () => {
    vi.mocked(getCompatConnection).mockResolvedValue({ id: 'someone-else', partnerId: P } as any);
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/connections/${C}`)).status).toBe(404);
    expect((await call('POST', `/connections/${C}/key`, { apiKey: KEY })).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
    expect(deletePartnerLlmConfig).not.toHaveBeenCalled();
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
  });
  it('a partner that is not cut over gets the recoverable 503 on every :id connection route, never a 404', async () => {
    // Before the cutover the compat connection may not resolve yet; the cutover gate must answer first.
    vi.mocked(getCompatConnection).mockResolvedValue(null);
    vi.mocked(ensurePartnerCutover).mockResolvedValue(false);
    const routes: Array<[string, string, unknown?]> = [
      ['POST', `/connections/${C}/key`, { apiKey: KEY }],
      ['POST', `/connections/${C}/endpoint`, { catalogEntryId: null }],
      ['PATCH', `/connections/${C}`, { name: 'x' }],
      ['DELETE', `/connections/${C}`],
      ['POST', `/connections/${C}/refresh`],
    ];
    for (const [method, path, body] of routes) {
      const res = await call(method, path, body);
      expect([path, method, res.status]).toEqual([path, method, 503]);
      expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
    }
    expect(getCompatConnection).not.toHaveBeenCalled();
  });
  it('404s every connection route when the partner has no connection', async () => {
    vi.mocked(getCompatConnection).mockResolvedValue(null);
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
  });
  it('409s creating a second Anthropic connection', async () => {
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY });
    expect([res.status, (await res.json()).code]).toEqual([409, 'conflict']);
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
  });
  it('creates the first connection with the partner id from auth, then applies name/geo', async () => {
    vi.mocked(getCompatConnection).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: C, partnerId: P } as any);
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY, name: 'Ours', inferenceGeo: 'us' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: C });
    expect(savePartnerLlmKey).toHaveBeenCalledWith({ partnerId: P, apiKey: KEY, userId: baseAuth().user.id });
    expect(updateConnectionSettings).toHaveBeenCalledWith({ partnerId: P, connectionId: C, patch: { name: 'Ours', inferenceGeo: 'us' } });
    expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain(KEY);
  });
  it('500s write_failed (captured, no audit) when the new connection cannot be read back after the key save', async () => {
    vi.mocked(getCompatConnection).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY, name: 'Ours' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('write_failed');
    expect(body).not.toHaveProperty('id');
    expect(captureException).toHaveBeenCalled();
    expect(updateConnectionSettings).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
  it('does not call updateConnectionSettings when create carries no name/geo', async () => {
    vi.mocked(getCompatConnection).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: C, partnerId: P } as any);
    expect((await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY })).status).toBe(201);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
  });
  it('POST /connections/:id/endpoint 404s selecting an endpoint when the catalog flag is off, but still clears one', async () => {
    const { isLlmProviderCatalogEnabled } = await import('../../services/llm/llmConfigResolver');
    vi.mocked(isLlmProviderCatalogEnabled).mockReturnValue(false);
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: 'entry-1' })).status).toBe(404);
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null })).status).toBe(200);
    expect(updatePartnerLlmEndpoint).toHaveBeenCalledWith({ partnerId: P, catalogEntryId: null, acknowledgeDataNote: false, userId: baseAuth().user.id });
    vi.mocked(isLlmProviderCatalogEnabled).mockReturnValue(true);
  });
  it('maps RegistryWriteError to its status with code + details', async () => {
    vi.mocked(setOfferingEnabled).mockRejectedValue(new RegistryWriteError('in use', 'offering_in_use', 409, { inUse: [{ surface: 'chat', level: 'partner', orgId: null }] }));
    const res = await call('POST', `/offerings/${A}/enabled`, { enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'in use', code: 'offering_in_use', details: { inUse: [{ surface: 'chat', level: 'partner', orgId: null }] } });
    expect(captureException).not.toHaveBeenCalled();
  });
  it('a busy partner registry lock is a 503 registry_busy, not reported to Sentry (expected contention)', async () => {
    vi.mocked(putPartnerAssignments).mockRejectedValue(
      new RegistryWriteError('Another AI configuration change is in progress. Try again in a moment.', 'registry_busy', 503),
    );
    const res = await call('PUT', '/assignments', { assignments: [{ surface: 'chat', role: 'default', defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: null, expectedUpdatedAt: null }] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'registry_busy', error: 'Another AI configuration change is in progress. Try again in a moment.' });
    expect(captureException).not.toHaveBeenCalled();
  });
  it('maps PartnerLlmError to its status (key rotation probe failure)', async () => {
    vi.mocked(savePartnerLlmKey).mockRejectedValue(new PartnerLlmError('Anthropic rejected this key.', 400));
    const res = await call('POST', `/connections/${C}/key`, { apiKey: KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Anthropic rejected this key.' });
  });
  it('passes the disable force flag and returns the affected surfaces', async () => {
    const inUse = [{ surface: 'chat' as const, level: 'partner' as const, orgId: null }];
    vi.mocked(setOfferingEnabled).mockResolvedValue({ offering: { ...offeringRow, enabled: false } as any, inUse });
    const res = await call('POST', `/offerings/${A}/enabled`, { enabled: false, force: true });
    expect(res.status).toBe(200);
    expect(setOfferingEnabled).toHaveBeenCalledWith({ partnerId: P, offeringId: A, enabled: false, force: true });
    expect(await res.json()).toMatchObject({ id: A, enabled: false, inUse });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ai_models.offering.disabled' }));
  });
  it('adds a platform offering with the partner id from auth', async () => {
    const res = await call('POST', `/offerings/platform/${PM}`, { enabled: true });
    expect(res.status).toBe(200);
    expect(ensurePlatformOffering).toHaveBeenCalledWith({ partnerId: P, platformModelId: PM, enabled: true });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ai_models.offering.added', resourceId: P }));
  });
  it('requires approvals:decide to change the script_reviewer default', async () => {
    permissionsState.approvalsDecide = false;
    const res = await call('PUT', '/assignments', { assignments: [{ ...chatRow, surface: 'script_reviewer' }] });
    expect([res.status, (await res.json()).code]).toEqual([403, 'APPROVALS_DECIDE_REQUIRED']);
    expect(putPartnerAssignments).not.toHaveBeenCalled();
  });
  it('allows the script_reviewer change with approvals:decide', async () => {
    const res = await call('PUT', '/assignments', { assignments: [{ ...chatRow, surface: 'script_reviewer' }] });
    expect(res.status).toBe(200);
    expect(putPartnerAssignments).toHaveBeenCalledWith({ partnerId: P, rows: [expect.objectContaining({ surface: 'script_reviewer' })] });
  });
  it('does not require approvals:decide for other surfaces', async () => {
    permissionsState.approvalsDecide = false;
    expect((await call('PUT', '/assignments', { assignments: [chatRow] })).status).toBe(200);
  });
  it('writes an audit row per mutation with orgId null and the partner as resource', async () => {
    await call('PUT', '/residency', { required: false });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'ai_models.residency.updated', resourceType: 'partner', resourceId: P,
    }));
    expect(setResidencyRequired).toHaveBeenCalledWith({ partnerId: P, required: false, acknowledgeImpact: false });
  });
  it('captures 5xx registry errors to Sentry and never echoes the cause', async () => {
    const e = new RegistryWriteError('Could not save the model.', 'write_failed', 500);
    e.cause = Object.assign(new Error('SQLSTATE XX000'), { code: 'XX000' });
    vi.mocked(updateOfferingDetails).mockRejectedValue(e);
    const res = await call('PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('XX000');
    expect(captureException).toHaveBeenCalled();
  });
  it('audits only the changed field names of an offering patch', async () => {
    await call('PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ai_models.offering.updated', details: { offeringId: A, fields: ['displayName'] },
    }));
  });
  it('rethrows non-registry errors (programming bugs stay visible)', async () => {
    vi.mocked(updateOfferingDetails).mockRejectedValue(new TypeError('boom'));
    const res = await call('PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('registry_unavailable');
  });
});

describe('/ai/models partner routes — script reviewer offering gate', () => {
  const OPTS_PATCHES: Array<[string, Record<string, unknown>]> = [
    ['defaultOptions', { defaultOptions: { effort: 'low' } }],
    ['allowedOptions', { allowedOptions: { effort: ['low'] } }],
    ['refusalFallbackOfferingId', { refusalFallbackOfferingId: PM }],
  ];
  const patch = (body: Record<string, unknown>) =>
    call('PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', ...body });

  it.each([
    ['partner', { surface: 'script_reviewer' as const, level: 'partner' as const, orgId: null }],
    ['org', { surface: 'script_reviewer' as const, level: 'org' as const, orgId: 'o1' }],
  ])('reviewer default (%s row) + options patch without approvals:decide → 403, no write', async (_l, use) => {
    vi.mocked(listOfferingDefaultUses).mockResolvedValue([{ surface: 'chat', level: 'partner', orgId: null }, use]);
    permissionsState.approvalsDecide = false;
    for (const [, body] of OPTS_PATCHES) {
      const res = await patch(body);
      expect([res.status, (await res.json()).code]).toEqual([403, 'APPROVALS_DECIDE_REQUIRED']);
    }
    expect(listOfferingDefaultUses).toHaveBeenCalledWith(P, A);
    expect(updateOfferingDetails).not.toHaveBeenCalled();
  });
  it('reviewer default + options patch with approvals:decide → 200', async () => {
    vi.mocked(listOfferingDefaultUses).mockResolvedValue([{ surface: 'script_reviewer', level: 'partner', orgId: null }]);
    expect((await patch({ defaultOptions: { effort: 'low' } })).status).toBe(200);
    expect(updateOfferingDetails).toHaveBeenCalled();
  });
  it('non-reviewer offering options patch without approvals:decide → 200', async () => {
    vi.mocked(listOfferingDefaultUses).mockResolvedValue([{ surface: 'chat', level: 'partner', orgId: null }]);
    permissionsState.approvalsDecide = false;
    expect((await patch({ allowedOptions: { effort: ['low'] } })).status).toBe(200);
    expect(updateOfferingDetails).toHaveBeenCalled();
  });
  it('reviewer default rename / price patch without approvals:decide → 200', async () => {
    vi.mocked(listOfferingDefaultUses).mockResolvedValue([{ surface: 'script_reviewer', level: 'partner', orgId: null }]);
    permissionsState.approvalsDecide = false;
    expect((await patch({ displayName: 'x' })).status).toBe(200);
    expect((await patch({ prices: { inputCentsPerM: 1, outputCentsPerM: 2, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 1 } })).status).toBe(200);
    expect(updateOfferingDetails).toHaveBeenCalledTimes(2);
  });
  it('reviewer default enable/disable (incl. force) without approvals:decide → 200', async () => {
    vi.mocked(listOfferingDefaultUses).mockResolvedValue([{ surface: 'script_reviewer', level: 'partner', orgId: null }]);
    permissionsState.approvalsDecide = false;
    expect((await call('POST', `/offerings/${A}/enabled`, { enabled: false, force: true })).status).toBe(200);
  });
});

describe('/ai/models partner routes — malformed ids', () => {
  it.each<[string, string, unknown?]>([
    ['POST', '/offerings/platform/not-a-uuid', { enabled: true }],
    ['POST', '/offerings/not-a-uuid/enabled', { enabled: true }],
    ['PATCH', '/offerings/not-a-uuid', { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' }],
    ['PATCH', '/connections/not-a-uuid', { name: 'x' }],
    ['DELETE', '/connections/not-a-uuid'],
    ['POST', '/connections/not-a-uuid/refresh'],
    ['POST', '/offerings/not-a-uuid/verify'],
  ])('%s %s → 400, no write', async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(400);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
});

describe('/ai/models partner routes — refresh and verify (Task 8b)', () => {
  it('POST /connections/:id/refresh queues discovery for the partner’s connection → 202', async () => {
    const res = await call('POST', `/connections/${C}/refresh`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true, connectionId: C });
    expect(enqueueConnectionSync).toHaveBeenCalledWith(C);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'ai_models.connection.refresh_requested', resourceType: 'partner', resourceId: P,
      details: { connectionId: C },
    }));
  });
  it('POST /connections/:id/refresh 404s a forged id (and the platform connection, which has no row)', async () => {
    vi.mocked(getCompatConnection).mockResolvedValue({ id: 'someone-else', partnerId: P } as any);
    expect((await call('POST', `/connections/${C}/refresh`)).status).toBe(404);
    vi.mocked(getCompatConnection).mockResolvedValue(null);
    expect((await call('POST', `/connections/${C}/refresh`)).status).toBe(404);
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
  it('POST /offerings/:id/verify re-runs discovery for the offering’s connection → 202', async () => {
    const res = await call('POST', `/offerings/${A}/verify`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true, connectionId: C });
    expect(getOffering).toHaveBeenCalledWith(A);
    expect(enqueueConnectionSync).toHaveBeenCalledWith(C);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'ai_models.offering.verify_requested', resourceType: 'partner', resourceId: P,
      details: { offeringId: A, connectionId: C },
    }));
  });
  it('POST /offerings/:id/verify on a platform offering is 409 (operator-verified), no enqueue', async () => {
    vi.mocked(getOffering).mockResolvedValue({ id: A, partnerId: P, connectionId: null } as any);
    const res = await call('POST', `/offerings/${A}/verify`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict' });
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
  });
  it('POST /offerings/:id/verify 404s another partner’s offering and a missing one, no enqueue', async () => {
    vi.mocked(getOffering).mockResolvedValueOnce({ id: A, partnerId: 'other-partner', connectionId: C } as any);
    const forged = await call('POST', `/offerings/${A}/verify`);
    expect([forged.status, (await forged.json()).code]).toEqual([404, 'not_found']);
    vi.mocked(getOffering).mockResolvedValueOnce(null);
    expect((await call('POST', `/offerings/${A}/verify`)).status).toBe(404);
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
  // W03 soft-disconnect: the row stays as provenance (getConnection still
  // returns it) but the compat reader is live-only, so :id never binds to it.
  it.each([
    ['not reconnected', null],
    ['reconnected (a NEW live connection)', { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', partnerId: P }],
  ])('PATCH /connections/:id and /refresh on a disconnected id → 404 (%s), nothing written or queued', async (_l, live) => {
    vi.mocked(getCompatConnection).mockResolvedValue(live as any);
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect((await call('POST', `/connections/${C}/refresh`)).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
  it.each([
    ['disconnected', { id: C, partnerId: P, status: 'disconnected' }],
    ['missing', null],
  ])('POST /offerings/:id/verify when the offering’s connection is %s → 409 connection_unavailable, nothing queued', async (_l, conn) => {
    vi.mocked(getConnection).mockResolvedValue(conn as any);
    const res = await call('POST', `/offerings/${A}/verify`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This model's connection is disconnected.", code: 'connection_unavailable' });
    expect(getConnection).toHaveBeenCalledWith(C);
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
  it('POST /offerings/:id/verify on a connection in error still queues (transient health never blocks)', async () => {
    vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: P, status: 'error' } as any);
    expect((await call('POST', `/offerings/${A}/verify`)).status).toBe(202);
    expect(enqueueConnectionSync).toHaveBeenCalledWith(C);
  });
  it.each([
    ['POST', `/connections/${C}/refresh`],
    ['POST', `/offerings/${A}/verify`],
  ])('%s %s → 503 queue_unavailable when the queue rejects; captured, not audited', async (method, path) => {
    vi.mocked(enqueueConnectionSync).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await call(method, path);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'queue_unavailable' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(captureException).toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
