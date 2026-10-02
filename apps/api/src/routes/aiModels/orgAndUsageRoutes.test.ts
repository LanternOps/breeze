import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({ permissionDenied: false, mfaDenied: false }));
const permissionsState = vi.hoisted(() => ({ approvalsDecide: true, orgsWrite: true }));

const P = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T = new Date('2026-10-01T00:00:00.000Z');

const baseAuth = () => ({
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
  scope: 'partner',
  partnerId: P,
  orgId: null,
  partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
});
const orgToken = {
  user: { id: '44444444-4444-4444-8444-444444444444', email: 'org@example.com', name: 'Org' },
  scope: 'organization',
  partnerId: P,
  orgId: ORG,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
};
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
  // Real scope semantics: these routes depend on the scope list they declare.
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth')?.scope)) return c.json({ error: 'Insufficient scope' }, 403);
    await next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
    APPROVALS_DECIDE: { resource: 'approvals', action: 'decide' },
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    AI_SESSIONS_READ_ALL: { resource: 'ai_sessions', action: 'read_all' },
  },
  hasPermission: vi.fn((_p: unknown, resource: string, action: string) => {
    if (resource === 'approvals' && action === 'decide') return permissionsState.approvalsDecide;
    if (resource === 'organizations' && action === 'write') return permissionsState.orgsWrite;
    return true;
  }),
  userCanDecideApprovals: vi.fn(() => permissionsState.approvalsDecide),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));

vi.mock('../../services/aiModels/registryCutover', () => ({ ensurePartnerCutover: vi.fn() }));
vi.mock('../../services/aiModels/registryView', () => ({ buildPartnerModelsSnapshot: vi.fn(), buildOrgModelDefaults: vi.fn() }));
vi.mock('../../services/aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn() }));
vi.mock('../../services/aiModels/connections', () => ({ getCompatConnection: vi.fn() }));
vi.mock('../../services/aiModels/connectionSettings', () => ({ updateConnectionSettings: vi.fn() }));
vi.mock('../../services/aiModels/offeringWrites', () => ({
  ensurePlatformOffering: vi.fn(), setOfferingEnabled: vi.fn(), updateOfferingDetails: vi.fn(), listOfferingDefaultUses: vi.fn(),
}));
vi.mock('../../services/aiModels/assignmentWrites', () => ({
  putPartnerAssignments: vi.fn(),
  putOrgAssignments: vi.fn(),
  touchesSurface: (rows: Array<{ surface: string }>, surface: string) => rows.some((r) => r.surface === surface),
}));
vi.mock('../../services/aiModels/residency', () => ({ previewResidencyImpact: vi.fn(), setResidencyRequired: vi.fn() }));
vi.mock('../../services/aiModels/usageQueries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/aiModels/usageQueries')>();
  return { defaultUsageRange: real.defaultUsageRange, queryAiUsageBreakdown: vi.fn() };
});
vi.mock('../../services/llm/llmConfigResolver', () => ({ isLlmProviderCatalogEnabled: vi.fn(() => true) }));
vi.mock('../../services/partnerLlmConfig', () => {
  class PartnerLlmError extends Error {
    constructor(message: string, readonly status: 400 | 409 | 500 | 503) {
      super(message);
    }
  }
  return { PartnerLlmError, savePartnerLlmKey: vi.fn(), updatePartnerLlmEndpoint: vi.fn(), deletePartnerLlmConfig: vi.fn() };
});

import { aiModelsRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { buildOrgModelDefaults } from '../../services/aiModels/registryView';
import { readOrgPartnerId as readOrgPartnerIdMock } from '../../services/aiModels/candidateLoader';
import { putOrgAssignments as putOrgAssignmentsMock } from '../../services/aiModels/assignmentWrites';
import { queryAiUsageBreakdown as queryAiUsageBreakdownMock } from '../../services/aiModels/usageQueries';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';

const readOrgPartnerId = vi.mocked(readOrgPartnerIdMock);
const putOrgAssignments = vi.mocked(putOrgAssignmentsMock);
const queryAiUsageBreakdown = vi.mocked(queryAiUsageBreakdownMock);

const orgChatRow = {
  surface: 'chat', role: 'default', defaultOfferingId: A, permittedOfferingIds: null,
  allowUserChoice: null, options: null, expectedUpdatedAt: null,
};

function call(method: string, path: string, body?: unknown) {
  return aiModelsRoutes.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authGates.permissionDenied = false;
  authGates.mfaDenied = false;
  permissionsState.approvalsDecide = true;
  permissionsState.orgsWrite = true;
  authState.value = baseAuth();
  vi.mocked(ensurePartnerCutover).mockResolvedValue(true);
  readOrgPartnerId.mockResolvedValue(P);
  vi.mocked(buildOrgModelDefaults).mockResolvedValue({ orgId: ORG, offerings: [], surfaces: [], canEdit: true, canEditReviewer: true } as any);
  putOrgAssignments.mockResolvedValue([{ surface: 'chat', role: 'default', updatedAt: T }] as any);
  queryAiUsageBreakdown.mockResolvedValue({ groupBy: 'model', from: '2026-10-01', to: '2026-10-01', orgId: null, rows: [], totals: {} } as any);
});

describe('org assignment routes', () => {
  it('GET 403s an org the caller cannot access', async () => {
    authState.value.canAccessOrg = () => false;
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(403);
    expect(buildOrgModelDefaults).not.toHaveBeenCalled();
  });
  it('GET 404s an org of another partner for a partner-scope caller', async () => {
    readOrgPartnerId.mockResolvedValue('other-partner');
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(404);
    expect(buildOrgModelDefaults).not.toHaveBeenCalled();
  });
  it('GET 404s an org that does not exist', async () => {
    readOrgPartnerId.mockResolvedValue(null);
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(404);
  });
  it('GET 400s a malformed org id', async () => {
    expect((await call('GET', '/orgs/not-a-uuid/assignments')).status).toBe(400);
    expect(readOrgPartnerId).not.toHaveBeenCalled();
  });
  it('GET works for an org-scope token of that org, with the org’s partner id', async () => {
    authState.value = { ...orgToken };
    const res = await call('GET', `/orgs/${ORG}/assignments`);
    expect(res.status).toBe(200);
    expect(buildOrgModelDefaults).toHaveBeenCalledWith({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
  });
  it('GET needs ORGS_READ', async () => {
    authGates.permissionDenied = true;
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(403);
  });
  it('GET reports canEdit=false without ORGS_WRITE and canEditReviewer=false without approvals:decide', async () => {
    permissionsState.approvalsDecide = false;
    await call('GET', `/orgs/${ORG}/assignments`);
    expect(buildOrgModelDefaults).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: true, canEditReviewer: false }));
    permissionsState.orgsWrite = false;
    permissionsState.approvalsDecide = true;
    await call('GET', `/orgs/${ORG}/assignments`);
    expect(buildOrgModelDefaults).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false, canEditReviewer: false }));
  });
  it('PUT needs ORGS_WRITE', async () => {
    authGates.permissionDenied = true;
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(403);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT needs MFA', async () => {
    authGates.mfaDenied = true;
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(403);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT 403s an org the caller cannot access', async () => {
    authState.value.canAccessOrg = () => false;
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(403);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT 404s an org of another partner for a partner-scope caller', async () => {
    readOrgPartnerId.mockResolvedValue('other-partner');
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(404);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT on script_reviewer needs approvals:decide', async () => {
    permissionsState.approvalsDecide = false;
    const res = await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [{ ...orgChatRow, surface: 'script_reviewer' }] });
    expect([res.status, (await res.json()).code]).toEqual([403, 'APPROVALS_DECIDE_REQUIRED']);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT on other surfaces does not need approvals:decide', async () => {
    permissionsState.approvalsDecide = false;
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(200);
  });
  it('PUT passes the ORG’s partner id (never caller input) and audits with orgId', async () => {
    authState.value = { ...orgToken };
    const res = await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [{ surface: 'chat', role: 'default', updatedAt: T.toISOString() }] });
    expect(putOrgAssignments).toHaveBeenCalledWith({ partnerId: P, orgId: ORG, rows: [expect.objectContaining({ surface: 'chat' })] });
    expect(ensurePartnerCutover).toHaveBeenCalledWith(P);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'ai_models.org_assignments.updated', resourceType: 'organization', resourceId: ORG,
    }));
  });
  it('PUT 503s when the org’s partner is not cut over', async () => {
    vi.mocked(ensurePartnerCutover).mockResolvedValue(false);
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(503);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT maps widens_partner to 422 with details', async () => {
    putOrgAssignments.mockRejectedValue(new RegistryWriteError('narrow only', 'widens_partner', 422, { surface: 'chat', field: 'options', key: 'effort' }));
    const res = await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] });
    expect([res.status, (await res.json()).details]).toEqual([422, { surface: 'chat', field: 'options', key: 'effort' }]);
  });
});

describe('usage route', () => {
  it('needs ai_sessions:read_all', async () => {
    authGates.permissionDenied = true;
    expect((await call('GET', '/usage?groupBy=model')).status).toBe(403);
    expect(queryAiUsageBreakdown).not.toHaveBeenCalled();
  });
  it('rejects org-scope tokens (partner/system only)', async () => {
    authState.value = { ...orgToken };
    expect((await call('GET', '/usage?groupBy=model')).status).toBe(403);
    expect(queryAiUsageBreakdown).not.toHaveBeenCalled();
  });
  it('403s an orgId the caller cannot access', async () => {
    authState.value.canAccessOrg = () => false;
    expect((await call('GET', `/usage?groupBy=model&orgId=${ORG}`)).status).toBe(403);
    expect(queryAiUsageBreakdown).not.toHaveBeenCalled();
  });
  it('400s a range over 92 days', async () => {
    expect((await call('GET', '/usage?groupBy=model&from=2026-01-01&to=2026-06-01')).status).toBe(400);
  });
  it('defaults the range to month-to-date', async () => {
    await call('GET', '/usage?groupBy=surface');
    expect(queryAiUsageBreakdown).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'surface', orgId: null, from: expect.stringMatching(/-01$/) }));
  });
  it('passes the explicit range, the org filter and the caller’s accessible orgs', async () => {
    const res = await call('GET', `/usage?groupBy=org&from=2026-09-01&to=2026-09-30&orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect(queryAiUsageBreakdown).toHaveBeenCalledWith({ groupBy: 'org', from: '2026-09-01', to: '2026-09-30', orgId: ORG, accessibleOrgIds: [ORG] });
  });
  it('system callers are unrestricted (accessibleOrgIds null)', async () => {
    authState.value = { ...baseAuth(), scope: 'system', partnerId: null, accessibleOrgIds: null, canAccessOrg: () => true };
    expect((await call('GET', '/usage?groupBy=user')).status).toBe(200);
    expect(queryAiUsageBreakdown).toHaveBeenCalledWith(expect.objectContaining({ accessibleOrgIds: null }));
  });
});
