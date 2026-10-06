import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({ permissionDenied: false, mfaDenied: false }));
const permissionsState = vi.hoisted(() => ({ approvalsDecide: true }));

const P = '22222222-2222-4222-8222-222222222222';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/** A W06 openai_compatible (gateway) connection, and an offering on it. */
const G = '99999999-9999-4999-8999-999999999999';
const GO = '88888888-8888-4888-8888-888888888888';
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
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn((fn: () => unknown) => fn()), withSystemDbAccessContext: vi.fn() }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: vi.fn() }));

vi.mock('../../services/aiModels/registryCutover', () => ({ ensurePartnerCutover: vi.fn() }));
vi.mock('../../services/aiModels/registryView', () => ({ buildPartnerModelsSnapshot: vi.fn() }));
vi.mock('../../services/aiModels/connections', () => ({ getConnection: vi.fn() }));
vi.mock('../../services/aiModels/offerings', () => ({ getOffering: vi.fn() }));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(), enqueueOfferingVerification: vi.fn() }));
vi.mock('../../services/aiModels/gatewayConnections', () => ({
  createGatewayConnection: vi.fn(),
  updateGatewayConnection: vi.fn(),
  deleteGatewayConnection: vi.fn(),
  createManualOffering: vi.fn(),
  isEnvManaged: (conn: { providerConfig?: { managedBy?: unknown } | null }) => conn.providerConfig?.managedBy === 'env',
}));
vi.mock('../../services/aiModels/connectionSettings', () => ({ updateConnectionSettings: vi.fn() }));
vi.mock('../../services/aiModels/offeringHealth', () => ({ clearConnectionCooldowns: vi.fn() }));
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
vi.mock('../../services/aiModels/connectionProbe', () => {
  class ConnectionCheckError extends Error {
    constructor(message: string, readonly status: 400 | 409 | 500 | 503) {
      super(message);
      this.name = 'ConnectionCheckError';
    }
  }
  return { ConnectionCheckError };
});
vi.mock('../../services/aiModels/anthropicConnectionWrites', () => ({
  hasAnthropicConnection: vi.fn(),
  createAnthropicKeyConnection: vi.fn(),
  rotateAnthropicKey: vi.fn(),
  changeAnthropicEndpoint: vi.fn(),
  deleteAnthropicConnection: vi.fn(),
}));

import { aiModelsRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { getConnection } from '../../services/aiModels/connections';
import { getOffering } from '../../services/aiModels/offerings';
import { enqueueConnectionSync, enqueueOfferingVerification } from '../../jobs/aiModelDiscoveryWorker';
import { createGatewayConnection, createManualOffering, deleteGatewayConnection, updateGatewayConnection } from '../../services/aiModels/gatewayConnections';
import { ByoEndpointRejected } from '../../services/aiModels/gateway/byoEndpointPolicy';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { clearConnectionCooldowns } from '../../services/aiModels/offeringHealth';
import { ensurePlatformOffering, listOfferingDefaultUses, setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { putPartnerAssignments } from '../../services/aiModels/assignmentWrites';
import { previewResidencyImpact, setResidencyRequired } from '../../services/aiModels/residency';
import {
  changeAnthropicEndpoint,
  createAnthropicKeyConnection,
  deleteAnthropicConnection,
  hasAnthropicConnection,
  rotateAnthropicKey,
} from '../../services/aiModels/anthropicConnectionWrites';
import { ConnectionCheckError } from '../../services/aiModels/connectionProbe';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
import { rateLimiter } from '../../services/rate-limit';

const chatRow = {
  surface: 'chat', role: 'default', defaultOfferingId: A, permittedOfferingIds: null,
  allowUserChoice: true, options: null, expectedUpdatedAt: null,
};
const KEY = 'sk-ant-' + 'x'.repeat(40);
const BYO_KEY = 'sk-local-123456';
const BYO_BODY = { kind: 'openai_compatible', name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: BYO_KEY };
const gatewayConn = (o: Record<string, unknown> = {}) => ({
  id: G, partnerId: P, kind: 'openai_compatible', status: 'active', baseUrl: 'https://llm.example.com/v1',
  providerConfig: null, configVersion: 3, ...o,
});

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
  // W06 (#7604) gateway arms.
  ['POST', '/connections', BYO_BODY],
  ['PATCH', `/connections/${G}/gateway`, { apiKey: null, expectedConfigVersion: 3 }],
  ['PATCH', `/connections/${G}`, { name: 'Renamed' }],
  ['DELETE', `/connections/${G}`],
  ['POST', `/connections/${G}/refresh`],
  ['POST', `/connections/${G}/offerings`, { modelId: 'qwen2.5-coder:7b' }],
  ['POST', `/offerings/${GO}/verify`],
];

const ALL_WRITE_SERVICE_MOCKS = [
  createAnthropicKeyConnection, rotateAnthropicKey, changeAnthropicEndpoint, deleteAnthropicConnection, updateConnectionSettings,
  ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails, putPartnerAssignments, setResidencyRequired,
  enqueueConnectionSync, enqueueOfferingVerification,
  createGatewayConnection, updateGatewayConnection, deleteGatewayConnection, createManualOffering,
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
  vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date(Date.now() + 60_000) });
  vi.mocked(buildPartnerModelsSnapshot).mockResolvedValue({ connections: [] } as any);
  // The partner already has its Anthropic connection C (getConnection below
  // resolves it, live): creating another is the R1-cap 409.
  vi.mocked(hasAnthropicConnection).mockResolvedValue(true);
  vi.mocked(createAnthropicKeyConnection).mockResolvedValue({ connectionId: C, last4: 'xxxx', configVersion: 1 });
  vi.mocked(rotateAnthropicKey).mockResolvedValue({ last4: 'xxxx', configVersion: 2 });
  vi.mocked(changeAnthropicEndpoint).mockResolvedValue({ connectionId: C, catalogEntryId: null, configVersion: 3, slug: null, revision: null });
  vi.mocked(deleteAnthropicConnection).mockResolvedValue(true);
  vi.mocked(updateConnectionSettings).mockResolvedValue({ id: C, configVersion: 4 } as any);
  vi.mocked(ensurePlatformOffering).mockResolvedValue(offeringRow as any);
  vi.mocked(setOfferingEnabled).mockResolvedValue({ offering: offeringRow as any, inUse: [] });
  vi.mocked(updateOfferingDetails).mockResolvedValue(offeringRow as any);
  vi.mocked(listOfferingDefaultUses).mockResolvedValue([]);
  vi.mocked(getOffering).mockImplementation(async (id: string) => (id === GO
    ? { id: GO, partnerId: P, connectionId: G, modelId: 'qwen2.5-coder:7b', source: 'discovered' }
    : { id: A, partnerId: P, connectionId: C }) as any);
  vi.mocked(getConnection).mockImplementation(async (id: string) => (id === G
    ? gatewayConn()
    : { id: C, partnerId: P, kind: 'anthropic_byok', status: 'active' }) as any);
  vi.mocked(enqueueConnectionSync).mockResolvedValue(undefined);
  vi.mocked(enqueueOfferingVerification).mockResolvedValue(undefined);
  vi.mocked(createGatewayConnection).mockResolvedValue(gatewayConn({ configVersion: 1 }) as any);
  vi.mocked(updateGatewayConnection).mockResolvedValue(gatewayConn({ configVersion: 4 }) as any);
  vi.mocked(deleteGatewayConnection).mockResolvedValue(undefined);
  vi.mocked(createManualOffering).mockResolvedValue({ id: GO, partnerId: P, connectionId: G, modelId: 'qwen2.5-coder:7b' } as any);
  vi.mocked(putPartnerAssignments).mockResolvedValue([{ surface: 'chat', role: 'default', updatedAt: T }] as any);
  vi.mocked(previewResidencyImpact).mockResolvedValue({ unavailableSurfaces: [], affectedOrgOverrides: [] });
  vi.mocked(setResidencyRequired).mockResolvedValue({ residencyRequired: false, impact: { unavailableSurfaces: [], affectedOrgOverrides: [] } });
});

describe('/ai/models partner routes — authz matrix', () => {
  it.each(WRITE_ROUTES)('%s %s succeeds for a full partner admin with MFA (control)', async (method, path, body) => {
    // POST /connections is a 409 when an Anthropic connection already exists.
    if (path === '/connections' && (body as { kind?: string }).kind === 'anthropic_byok') vi.mocked(hasAnthropicConnection).mockResolvedValueOnce(false);
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
    vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: 'other-partner', kind: 'anthropic_byok', status: 'active' } as any);
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/connections/${C}`)).status).toBe(404);
    expect((await call('POST', `/connections/${C}/key`, { apiKey: KEY })).status).toBe(404);
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null })).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
    expect(deleteAnthropicConnection).not.toHaveBeenCalled();
    expect(rotateAnthropicKey).not.toHaveBeenCalled();
    expect(changeAnthropicEndpoint).not.toHaveBeenCalled();
  });
  it('a soft-disconnected Anthropic connection id 404s on every :id route and is never revived', async () => {
    vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: P, kind: 'anthropic_byok', status: 'disconnected' } as any);
    expect((await call('POST', `/connections/${C}/key`, { apiKey: KEY })).status).toBe(404);
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null })).status).toBe(404);
    expect((await call('DELETE', `/connections/${C}`)).status).toBe(404);
    expect(rotateAnthropicKey).not.toHaveBeenCalled();
    expect(changeAnthropicEndpoint).not.toHaveBeenCalled();
    expect(deleteAnthropicConnection).not.toHaveBeenCalled();
    expect(clearConnectionCooldowns).not.toHaveBeenCalled();
  });
  it('a partner that is not cut over gets the recoverable 503 on every :id connection route, never a 404', async () => {
    // Before the cutover the connection may not resolve yet; the cutover gate must answer first.
    vi.mocked(getConnection).mockResolvedValue(null);
    vi.mocked(ensurePartnerCutover).mockResolvedValue(false);
    const routes: Array<[string, string, unknown?]> = [
      ['POST', `/connections/${C}/key`, { apiKey: KEY }],
      ['POST', `/connections/${C}/endpoint`, { catalogEntryId: null }],
      ['PATCH', `/connections/${C}`, { name: 'x' }],
      ['DELETE', `/connections/${C}`],
      ['POST', `/connections/${C}/refresh`],
      ['PATCH', `/connections/${G}/gateway`, { apiKey: null, expectedConfigVersion: 3 }],
      ['PATCH', `/connections/${G}`, { name: 'x' }],
      ['DELETE', `/connections/${G}`],
      ['POST', `/connections/${G}/refresh`],
      ['POST', `/connections/${G}/offerings`, { modelId: 'm1' }],
      ['POST', `/offerings/${GO}/verify`],
    ];
    for (const [method, path, body] of routes) {
      const res = await call(method, path, body);
      expect([path, method, res.status]).toEqual([path, method, 503]);
      expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
    }
    // Ownership (every kind) runs inside the cutover gate.
    expect(getConnection).not.toHaveBeenCalled();
    expect(getOffering).not.toHaveBeenCalled();
  });
  it('404s every connection route when the partner has no connection', async () => {
    vi.mocked(getConnection).mockResolvedValue(null);
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
  });
  it('409s creating a second Anthropic connection', async () => {
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY });
    expect([res.status, (await res.json()).code]).toEqual([409, 'conflict']);
    expect(createAnthropicKeyConnection).not.toHaveBeenCalled();
  });
  it('creates the first connection with the partner id from auth, then applies name/geo', async () => {
    vi.mocked(hasAnthropicConnection).mockResolvedValueOnce(false);
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY, name: 'Ours', inferenceGeo: 'us' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: C });
    expect(hasAnthropicConnection).toHaveBeenCalledWith(P);
    expect(createAnthropicKeyConnection).toHaveBeenCalledWith({ partnerId: P, apiKey: KEY, userId: baseAuth().user.id });
    expect(updateConnectionSettings).toHaveBeenCalledWith({ partnerId: P, connectionId: C, patch: { name: 'Ours', inferenceGeo: 'us' } });
    expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain(KEY);
  });
  it('does not call updateConnectionSettings when create carries no name/geo', async () => {
    vi.mocked(hasAnthropicConnection).mockResolvedValueOnce(false);
    expect((await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: KEY })).status).toBe(201);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
  });
  it('POST /connections/:id/endpoint 404s selecting an endpoint when the catalog flag is off, but still clears one', async () => {
    const { isLlmProviderCatalogEnabled } = await import('../../services/llm/llmConfigResolver');
    vi.mocked(isLlmProviderCatalogEnabled).mockReturnValue(false);
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: 'entry-1' })).status).toBe(404);
    expect(changeAnthropicEndpoint).not.toHaveBeenCalled();
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null })).status).toBe(200);
    expect(changeAnthropicEndpoint).toHaveBeenCalledWith({ partnerId: P, connectionId: C, catalogEntryId: null, acknowledgeDataNote: false, userId: baseAuth().user.id });
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
  it('a ConnectionCheckError keeps its message and status (no code), like the retired facade', async () => {
    vi.mocked(rotateAnthropicKey).mockRejectedValue(new ConnectionCheckError('That Anthropic API key was rejected. Check the key and try again.', 400));
    const res = await call('POST', `/connections/${C}/key`, { apiKey: KEY });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That Anthropic API key was rejected. Check the key and try again.' });
    expect(clearConnectionCooldowns).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
  it('a 5xx ConnectionCheckError is captured', async () => {
    vi.mocked(rotateAnthropicKey).mockRejectedValue(new ConnectionCheckError('Could not store the API key.', 500));
    expect((await call('POST', `/connections/${C}/key`, { apiKey: KEY })).status).toBe(500);
    expect(captureException).toHaveBeenCalled();
  });
  it('POST /connections/:id/key rotates the NAMED connection with the partner id from auth', async () => {
    const res = await call('POST', `/connections/${C}/key`, { apiKey: KEY });
    expect(await res.json()).toEqual({ id: C, keyLast4: 'xxxx', configVersion: 2 });
    expect(rotateAnthropicKey).toHaveBeenCalledWith({ partnerId: P, connectionId: C, apiKey: KEY, userId: baseAuth().user.id });
  });
  it('POST /connections/:id/endpoint keeps the connection id across a kind switch', async () => {
    vi.mocked(changeAnthropicEndpoint).mockResolvedValueOnce({ connectionId: C, catalogEntryId: 'e1', configVersion: 5, slug: 'gw', revision: 3 });
    const res = await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: '44444444-4444-4444-8444-444444444444', acknowledgeDataNote: true });
    expect(await res.json()).toEqual({ id: C, catalogEntryId: 'e1', configVersion: 5 });
    expect(changeAnthropicEndpoint).toHaveBeenCalledWith(expect.objectContaining({ connectionId: C, acknowledgeDataNote: true }));
  });
  it('W09: a successful key rotation clears that connection\'s failover cooldowns', async () => {
    const res = await call('POST', `/connections/${C}/key`, { apiKey: KEY });
    expect(res.status).toBe(200);
    expect(clearConnectionCooldowns).toHaveBeenCalledWith(P, C);
  });
  it('W09: a cooldown clear failure never fails the rotation (cooldowns fail open), and is reported', async () => {
    vi.mocked(clearConnectionCooldowns).mockRejectedValue(new Error('db down'));
    const res = await call('POST', `/connections/${C}/key`, { apiKey: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: C, keyLast4: 'xxxx' });
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), undefined, { service: 'aiModels', stage: 'cooldown_clear' });
  });
  it('W08a: an endpoint change (now in place, same id) clears that connection\'s failover cooldowns after the write', async () => {
    const res = await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null });
    expect(res.status).toBe(200);
    expect(clearConnectionCooldowns).toHaveBeenCalledWith(P, C);
    expect(vi.mocked(clearConnectionCooldowns).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(vi.mocked(changeAnthropicEndpoint).mock.invocationCallOrder[0]!);
  });
  it('W08a: a failed endpoint change clears nothing; a cooldown clear failure never fails the change and is reported', async () => {
    vi.mocked(changeAnthropicEndpoint).mockRejectedValueOnce(new ConnectionCheckError('That endpoint was delisted and is no longer available for selection.', 409));
    expect((await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null })).status).toBe(409);
    expect(clearConnectionCooldowns).not.toHaveBeenCalled();

    vi.mocked(clearConnectionCooldowns).mockRejectedValueOnce(new Error('db down'));
    const res = await call('POST', `/connections/${C}/endpoint`, { catalogEntryId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: C, configVersion: 3 });
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), undefined, { service: 'aiModels', stage: 'cooldown_clear' });
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
    vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: 'other-partner', kind: 'anthropic_byok', status: 'active' } as any);
    expect((await call('POST', `/connections/${C}/refresh`)).status).toBe(404);
    vi.mocked(getConnection).mockResolvedValue(null);
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
  it('POST /offerings/:id/verify is rate limited per partner → 429 with Retry-After, nothing queued', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 120_000) });
    const res = await call('POST', `/offerings/${A}/verify`);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `rl:ai-models:offering-verify:${P}`, expect.any(Number), expect.any(Number));
    expect(getOffering).not.toHaveBeenCalled();
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
    expect(enqueueOfferingVerification).not.toHaveBeenCalled();
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
  // returns it), but ownConnection treats a disconnected row as absent, so
  // :id never binds to it — whether or not the partner reconnected since.
  it.each([
    ['anthropic_byok'],
    ['catalog'],
  ])('PATCH /connections/:id and /refresh on a disconnected %s id → 404, nothing written or queued', async (kind) => {
    vi.mocked(getConnection).mockResolvedValue({ id: C, partnerId: P, kind, status: 'disconnected' } as any);
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

describe('/ai/models partner routes — openai_compatible connections (W06 #7604)', () => {
  const audits = () => vi.mocked(writeRouteAudit).mock.calls.map(([, entry]) => entry as Record<string, any>);

  describe('POST /connections (openai_compatible arm)', () => {
    it('creates with the partner id from auth, enqueues discovery after the write, audits host/hasKey but never the key or URL path', async () => {
      const res = await call('POST', '/connections', BYO_BODY);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: G, discoveryQueued: true });
      expect(createGatewayConnection).toHaveBeenCalledWith({
        partnerId: P, name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: BYO_KEY, connectedBy: baseAuth().user.id,
      });
      expect(enqueueConnectionSync).toHaveBeenCalledWith(G);
      expect(vi.mocked(createGatewayConnection).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(enqueueConnectionSync).mock.invocationCallOrder[0]!);
      expect(audits()).toEqual([expect.objectContaining({
        orgId: null, action: 'ai_models.connection.created', resourceType: 'partner', resourceId: P,
        details: { kind: 'openai_compatible', connectionId: G, host: 'llm.example.com', hasKey: true },
      })]);
      const serialized = JSON.stringify(vi.mocked(writeRouteAudit).mock.calls);
      expect(serialized).not.toContain(BYO_KEY);
      expect(serialized).not.toContain('/v1');
      expect(createAnthropicKeyConnection).not.toHaveBeenCalled();
    });
    it('keyless create audits hasKey false and passes no key', async () => {
      const { apiKey: _k, ...keyless } = BYO_BODY;
      expect((await call('POST', '/connections', keyless)).status).toBe(201);
      expect(createGatewayConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
      expect(audits()[0]!.details).toMatchObject({ hasKey: false });
    });
    it('is allowed while an Anthropic connection exists (the R1-cap 409 belongs to the anthropic_byok arm only)', async () => {
      vi.mocked(hasAnthropicConnection).mockResolvedValue(true);
      expect((await call('POST', '/connections', BYO_BODY)).status).toBe(201);
      expect(createGatewayConnection).toHaveBeenCalled();
    });
    it('still 201s when discovery cannot be queued (the row committed; the daily sweep picks it up), captured', async () => {
      vi.mocked(enqueueConnectionSync).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const res = await call('POST', '/connections', BYO_BODY);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: G, discoveryQueued: false });
      expect(captureException).toHaveBeenCalled();
      expect(audits().map((a) => a.action)).toEqual(['ai_models.connection.created']);
    });
    it.each([
      ['egress_blocked', 'That host resolves to a private or reserved address, which Breeze does not connect to.'],
      ['invalid_url', 'Enter a valid http(s) URL.'],
    ] as const)('an egress-policy rejection (%s) → 400 with the policy message and code; not audited, not captured', async (code, message) => {
      vi.mocked(createGatewayConnection).mockRejectedValueOnce(new ByoEndpointRejected(message, code));
      const res = await call('POST', '/connections', BYO_BODY);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message, code });
      expect(writeRouteAudit).not.toHaveBeenCalled();
      expect(enqueueConnectionSync).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    });
    it.each([
      ['inferenceGeo (never residency-eligible, D7)', { ...BYO_BODY, inferenceGeo: 'eu' }],
      ['a capabilities claim', { ...BYO_BODY, capabilities: { tool_use: { supported: true } } }],
      ['a credential in the URL', { ...BYO_BODY, baseUrl: 'https://u:p@llm.example.com/v1' }],
    ])('rejects %s with 400 before any write', async (_l, body) => {
      expect((await call('POST', '/connections', body)).status).toBe(400);
      expect(createGatewayConnection).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /connections/:id/gateway', () => {
    it('rotates the key with the expected config version, enqueues discovery after the write, audits without the key', async () => {
      const res = await call('PATCH', `/connections/${G}/gateway`, { apiKey: 'sk-new-abcdef12', expectedConfigVersion: 3 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: G, configVersion: 4 });
      expect(updateGatewayConnection).toHaveBeenCalledWith({
        partnerId: P, connectionId: G, baseUrl: undefined, apiKey: 'sk-new-abcdef12', expectedConfigVersion: 3,
      });
      expect(enqueueConnectionSync).toHaveBeenCalledWith(G);
      expect(vi.mocked(updateGatewayConnection).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(enqueueConnectionSync).mock.invocationCallOrder[0]!);
      expect(audits()).toEqual([expect.objectContaining({
        action: 'ai_models.connection.endpoint_changed', resourceId: P,
        details: { kind: 'openai_compatible', connectionId: G, host: 'llm.example.com', urlChanged: false, key: 'rotated', configVersion: 4 },
      })]);
      expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain('sk-new-abcdef12');
    });
    it('W09: a key rotation or endpoint change clears the connection\'s failover cooldowns, after the write', async () => {
      await call('PATCH', `/connections/${G}/gateway`, { apiKey: 'sk-new-abcdef12', expectedConfigVersion: 3 });
      expect(clearConnectionCooldowns).toHaveBeenCalledWith(P, G);
      expect(vi.mocked(updateGatewayConnection).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(clearConnectionCooldowns).mock.invocationCallOrder[0]!);
      vi.mocked(clearConnectionCooldowns).mockClear();
      vi.mocked(updateGatewayConnection).mockResolvedValueOnce(gatewayConn({ baseUrl: 'https://other.example.org/v1', configVersion: 4 }) as any);
      await call('PATCH', `/connections/${G}/gateway`, { baseUrl: 'https://other.example.org/v1', apiKey: null, expectedConfigVersion: 3 });
      expect(clearConnectionCooldowns).toHaveBeenCalledWith(P, G);
    });
    it('W09: a cooldown clear failure never fails the gateway update (cooldowns fail open)', async () => {
      vi.mocked(clearConnectionCooldowns).mockRejectedValueOnce(new Error('redis down'));
      const res = await call('PATCH', `/connections/${G}/gateway`, { apiKey: 'sk-new-abcdef12', expectedConfigVersion: 3 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: G, configVersion: 4 });
      expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }), undefined, { service: 'aiModels', stage: 'cooldown_clear' });
    });
    it('a URL change audits the new host only; a null key audits key cleared', async () => {
      vi.mocked(updateGatewayConnection).mockResolvedValueOnce(gatewayConn({ baseUrl: 'https://other.example.org/tenant-42/v1', configVersion: 4 }) as any);
      await call('PATCH', `/connections/${G}/gateway`, { baseUrl: 'https://other.example.org/tenant-42/v1', apiKey: null, expectedConfigVersion: 3 });
      expect(audits()[0]!.details).toMatchObject({ host: 'other.example.org', urlChanged: true, key: 'cleared' });
      expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls)).not.toContain('tenant-42');
    });
    it.each([
      ['another partner’s connection', gatewayConn({ partnerId: 'OTHER' })],
      ['a missing connection', null],
      ['a disconnected connection', gatewayConn({ status: 'disconnected' })],
      ['an Anthropic (compat) connection', { id: G, partnerId: P, kind: 'anthropic_byok', status: 'active' }],
    ])('404s %s before any write', async (_l, conn) => {
      vi.mocked(getConnection).mockResolvedValue(conn as any);
      const res = await call('PATCH', `/connections/${G}/gateway`, { apiKey: null, expectedConfigVersion: 3 });
      expect([res.status, (await res.json()).code]).toEqual([404, 'not_found']);
      expect(updateGatewayConnection).not.toHaveBeenCalled();
      expect(enqueueConnectionSync).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
    it.each([
      ['managed_by_env', new RegistryWriteError('This connection is managed by the MCP_LLM_* environment variables.', 'managed_by_env', 409)],
      ['stale_write', new RegistryWriteError('This connection changed since you opened it.', 'stale_write', 409)],
      ['egress_blocked', new ByoEndpointRejected('Use https for an endpoint on a public address.', 'egress_blocked')],
      ['key_required_for_new_endpoint', new RegistryWriteError('Enter the key for the new URL (or remove the key).', 'key_required_for_new_endpoint', 422, { field: 'apiKey' })],
    ])('maps a %s refusal to its status/code; nothing queued or audited', async (code, err) => {
      vi.mocked(updateGatewayConnection).mockRejectedValueOnce(err);
      const res = await call('PATCH', `/connections/${G}/gateway`, { baseUrl: 'http://example.com', expectedConfigVersion: 3 });
      expect(res.status).toBe(err.status);
      expect((await res.json()).code).toBe(code);
      expect(enqueueConnectionSync).not.toHaveBeenCalled();
      expect(clearConnectionCooldowns).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
    it('rejects an empty patch and a missing expectedConfigVersion (400, no write)', async () => {
      expect((await call('PATCH', `/connections/${G}/gateway`, { expectedConfigVersion: 3 })).status).toBe(400);
      expect((await call('PATCH', `/connections/${G}/gateway`, { apiKey: null })).status).toBe(400);
      expect(updateGatewayConnection).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /connections/:id (settings) on a gateway connection', () => {
    it('renames it', async () => {
      const res = await call('PATCH', `/connections/${G}`, { name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(updateConnectionSettings).toHaveBeenCalledWith({ partnerId: P, connectionId: G, patch: { name: 'Renamed' } });
      expect(audits()[0]).toMatchObject({ action: 'ai_models.connection.updated' });
    });
    it('refuses an inference geography → 422 geo_not_supported, no write', async () => {
      const res = await call('PATCH', `/connections/${G}`, { inferenceGeo: 'eu' });
      expect([res.status, (await res.json()).code]).toEqual([422, 'geo_not_supported']);
      expect(updateConnectionSettings).not.toHaveBeenCalled();
    });
    it('refuses editing an env-managed connection → 409 managed_by_env, no write', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ providerConfig: { managedBy: 'env' } }) as any);
      const res = await call('PATCH', `/connections/${G}`, { name: 'Renamed' });
      expect([res.status, (await res.json()).code]).toEqual([409, 'managed_by_env']);
      expect(updateConnectionSettings).not.toHaveBeenCalled();
    });
    it('404s another partner’s gateway connection', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ partnerId: 'OTHER' }) as any);
      expect((await call('PATCH', `/connections/${G}`, { name: 'x' })).status).toBe(404);
      expect(updateConnectionSettings).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /connections/:id', () => {
    it('soft-disconnects a gateway connection through deleteGatewayConnection, never the Anthropic disconnect', async () => {
      const res = await call('DELETE', `/connections/${G}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
      expect(deleteGatewayConnection).toHaveBeenCalledWith({ partnerId: P, connectionId: G });
      expect(deleteAnthropicConnection).not.toHaveBeenCalled();
      expect(audits()[0]).toMatchObject({ action: 'ai_models.connection.deleted', details: { connectionId: G, kind: 'openai_compatible' } });
    });
    it('a released env connection can be disconnected (the route leaves the env rule to the service)', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ providerConfig: { managedBy: 'env', envReleasedAt: '2026-10-01T00:00:00.000Z' } }) as any);
      const res = await call('DELETE', `/connections/${G}`);
      expect(res.status).toBe(200);
      expect(deleteGatewayConnection).toHaveBeenCalledWith({ partnerId: P, connectionId: G });
    });
    it('the Anthropic connection goes through the id-keyed Anthropic disconnect', async () => {
      expect((await call('DELETE', `/connections/${C}`)).status).toBe(200);
      expect(deleteAnthropicConnection).toHaveBeenCalledWith({ partnerId: P, connectionId: C });
      expect(deleteGatewayConnection).not.toHaveBeenCalled();
    });
    it('maps connection_in_use with its details', async () => {
      const details = { surfaces: ['chat'], inUse: [{ surface: 'chat', level: 'partner', orgId: null }] };
      vi.mocked(deleteGatewayConnection).mockRejectedValueOnce(new RegistryWriteError('In use.', 'connection_in_use', 409, details));
      const res = await call('DELETE', `/connections/${G}`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'In use.', code: 'connection_in_use', details });
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
    it('404s another partner’s gateway connection (no write)', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ partnerId: 'OTHER' }) as any);
      expect((await call('DELETE', `/connections/${G}`)).status).toBe(404);
      expect(deleteGatewayConnection).not.toHaveBeenCalled();
      expect(deleteAnthropicConnection).not.toHaveBeenCalled();
    });
  });

  describe('POST /connections/:id/refresh', () => {
    it('queues discovery for a gateway connection; the route audit names the egress host (partner-level discovery writes no egress row)', async () => {
      const res = await call('POST', `/connections/${G}/refresh`);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ queued: true, connectionId: G });
      expect(enqueueConnectionSync).toHaveBeenCalledWith(G);
      expect(audits()).toEqual([expect.objectContaining({
        action: 'ai_models.connection.refresh_requested',
        details: { connectionId: G, kind: 'openai_compatible', host: 'llm.example.com' },
      })]);
    });
    it.each([
      ['another partner’s', gatewayConn({ partnerId: 'OTHER' })],
      ['a disconnected', gatewayConn({ status: 'disconnected' })],
    ])('404s %s gateway connection, nothing queued', async (_l, conn) => {
      vi.mocked(getConnection).mockResolvedValue(conn as any);
      expect((await call('POST', `/connections/${G}/refresh`)).status).toBe(404);
      expect(enqueueConnectionSync).not.toHaveBeenCalled();
    });
  });

  describe('POST /connections/:id/offerings (manual model)', () => {
    it('adds a manual model pinned to the partner and connection; audited as ai_models.offering.added', async () => {
      const body = { modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder', prices: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } };
      const res = await call('POST', `/connections/${G}/offerings`, body);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: GO });
      expect(createManualOffering).toHaveBeenCalledWith({ partnerId: P, connectionId: G, ...body });
      expect(audits()).toEqual([expect.objectContaining({
        orgId: null, action: 'ai_models.offering.added', resourceType: 'partner', resourceId: P,
        details: { offeringId: GO, connectionId: G, source: 'manual', modelId: 'qwen2.5-coder:7b' },
      })]);
    });
    it('refuses a capabilities / verification claim in the body (400, no write)', async () => {
      const res = await call('POST', `/connections/${G}/offerings`, {
        modelId: 'm1', capabilities: { tool_use: { supported: true }, breeze_verification: { passed: true } },
      });
      expect(res.status).toBe(400);
      expect(createManualOffering).not.toHaveBeenCalled();
    });
    it('409 not_gateway on an Anthropic connection (its models are discovered)', async () => {
      const res = await call('POST', `/connections/${C}/offerings`, { modelId: 'm1' });
      expect([res.status, (await res.json()).code]).toEqual([409, 'not_gateway']);
      expect(createManualOffering).not.toHaveBeenCalled();
    });
    it('404s another partner’s connection', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ partnerId: 'OTHER' }) as any);
      expect((await call('POST', `/connections/${G}/offerings`, { modelId: 'm1' })).status).toBe(404);
      expect(createManualOffering).not.toHaveBeenCalled();
    });
    it('maps duplicate_model → 409', async () => {
      vi.mocked(createManualOffering).mockRejectedValueOnce(new RegistryWriteError('That model is already listed on this connection.', 'duplicate_model', 409));
      const res = await call('POST', `/connections/${G}/offerings`, { modelId: 'm1' });
      expect([res.status, (await res.json()).code]).toEqual([409, 'duplicate_model']);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
    it.each([
      ['too_many_models', new RegistryWriteError('This connection already has the maximum of 200 hand-entered models.', 'too_many_models', 409, { max: 200 })],
      ['managed_by_env', new RegistryWriteError('This connection is managed by the MCP_LLM_* environment variables.', 'managed_by_env', 409)],
    ])('maps %s → 409, nothing audited', async (code, err) => {
      vi.mocked(createManualOffering).mockRejectedValueOnce(err);
      const res = await call('POST', `/connections/${G}/offerings`, { modelId: 'm1' });
      expect([res.status, (await res.json()).code]).toEqual([409, code]);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  it('Anthropic-only routes 404 for a gateway connection id', async () => {
    expect((await call('POST', `/connections/${G}/key`, { apiKey: KEY })).status).toBe(404);
    expect((await call('POST', `/connections/${G}/endpoint`, { catalogEntryId: null })).status).toBe(404);
    expect(rotateAnthropicKey).not.toHaveBeenCalled();
    expect(changeAnthropicEndpoint).not.toHaveBeenCalled();
  });

  describe('POST /offerings/:id/verify on a gateway offering', () => {
    it('enqueues harness verification (ids only), not a connection sync → 202, audited mode harness', async () => {
      const res = await call('POST', `/offerings/${GO}/verify`);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ queued: true, connectionId: G, offeringId: GO });
      expect(enqueueOfferingVerification).toHaveBeenCalledWith({ offeringId: GO, partnerId: P });
      expect(enqueueConnectionSync).not.toHaveBeenCalled();
      expect(audits()).toEqual([expect.objectContaining({
        action: 'ai_models.offering.verify_requested', resourceId: P,
        details: { offeringId: GO, connectionId: G, mode: 'harness' },
      })]);
    });
    it('verifies an env-managed connection’s offering too (verification is how it earns tools)', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ providerConfig: { managedBy: 'env' } }) as any);
      expect((await call('POST', `/offerings/${GO}/verify`)).status).toBe(202);
      expect(enqueueOfferingVerification).toHaveBeenCalled();
    });
    it('a gateway connection in error → 409 not_eligible connection_unavailable before enqueueing (same rule as the verifier)', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ status: 'error' }) as any);
      const res = await call('POST', `/offerings/${GO}/verify`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'not_eligible', details: { reason: 'connection_unavailable' } });
      expect(enqueueOfferingVerification).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
    it('a disconnected gateway connection → 409 connection_unavailable, nothing queued', async () => {
      vi.mocked(getConnection).mockResolvedValue(gatewayConn({ status: 'disconnected' }) as any);
      expect((await call('POST', `/offerings/${GO}/verify`)).status).toBe(409);
      expect(enqueueOfferingVerification).not.toHaveBeenCalled();
    });
    it('another partner’s gateway offering → 404, nothing queued', async () => {
      vi.mocked(getOffering).mockResolvedValue({ id: GO, partnerId: 'OTHER', connectionId: G, modelId: 'm1' } as any);
      expect((await call('POST', `/offerings/${GO}/verify`)).status).toBe(404);
      expect(enqueueOfferingVerification).not.toHaveBeenCalled();
    });
    it('a queue failure → 503 queue_unavailable, captured, not audited', async () => {
      vi.mocked(enqueueOfferingVerification).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const res = await call('POST', `/offerings/${GO}/verify`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'queue_unavailable' });
      expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
      expect(captureException).toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  it('malformed gateway ids → 400, no write', async () => {
    expect((await call('PATCH', '/connections/not-a-uuid/gateway', { apiKey: null, expectedConfigVersion: 1 })).status).toBe(400);
    expect((await call('POST', '/connections/not-a-uuid/offerings', { modelId: 'm1' })).status).toBe(400);
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
});
