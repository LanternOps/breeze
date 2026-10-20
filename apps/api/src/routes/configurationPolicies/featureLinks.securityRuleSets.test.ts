import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * #6263 W03: a `security` feature-link write runs checkSecurityRuleSetsWrite
 * (securityRuleSetGate.test.ts pins its logic) with the POLICY's owner, and a
 * refusal stops the write. Harness copied from
 * featureLinks.securityQuarantine.test.ts.
 */
const {
  getConfigPolicyMock,
  addFeatureLinkMock,
  updateFeatureLinkMock,
  state,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  addFeatureLinkMock: vi.fn(),
  updateFeatureLinkMock: vi.fn(),
  state: { permissions: [] as Array<{ resource: string; action: string }>, mfa: true },
}));

const { ruleSetGateMock } = vi.hoisted(() => ({ ruleSetGateMock: vi.fn() }));
vi.mock('./securityRuleSetGate', () => ({ checkSecurityRuleSetsWrite: ruleSetGateMock }));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    addFeatureLink: addFeatureLinkMock,
    updateFeatureLink: updateFeatureLinkMock,
    removeFeatureLink: vi.fn(),
    listFeatureLinks: vi.fn(),
    validateFeaturePolicyExists: vi.fn(async () => ({ valid: true })),
  };
});

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn((auth: any) => auth.token?.mfa === true),
}));

import { featureLinkRoutes } from './featureLinks';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const LINK_ID = '44444444-4444-4444-4444-444444444444';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      token: { scope: 'organization', mfa: state.mfa },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
    } as any);
    c.set('permissions', {
      permissions: state.permissions,
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-1',
      scope: 'organization',
    } as any);
    await next();
  });
  app.route('/', featureLinkRoutes);
  return app;
}

const POLICY = { id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy', featureLinks: [] as any[] };

function send(app: Hono, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  const path = method === 'POST' ? `/${POLICY_ID}/features` : `/${POLICY_ID}/features/${LINK_ID}`;
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const WRITE_ONLY = [{ resource: 'devices', action: 'write' }];
const SET = 'aaaaaaaa-0000-4000-8000-00000000000a';
const REFUSAL = { ok: false, status: 400, body: { error: 'nope', code: 'YARA_RULE_SET_NOT_ATTACHABLE', ruleSetIds: [SET] } };

describe('security feature link ruleSetIds gate wiring', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = WRITE_ONLY;
    state.mfa = true;
    app = buildApp();
    getConfigPolicyMock.mockResolvedValue(POLICY);
    addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
    updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
    ruleSetGateMock.mockResolvedValue({ ok: true });
  });

  it('POST: the gate sees the policy owner + settings, and a refusal is a 400 with no write', async () => {
    ruleSetGateMock.mockResolvedValue(REFUSAL);
    const inlineSettings = { autoQuarantine: false, ruleSetIds: [SET] };
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('YARA_RULE_SET_NOT_ATTACHABLE');
    expect(ruleSetGateMock).toHaveBeenCalledWith({ orgId: ORG_ID, partnerId: null }, inlineSettings);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST: an accepted list saves', async () => {
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { autoQuarantine: false, ruleSetIds: [SET] } });
    expect(res.status).toBe(201);
    expect(addFeatureLinkMock).toHaveBeenCalled();
  });

  it('PATCH: a refusal is a 400 with no write', async () => {
    getConfigPolicyMock.mockResolvedValue({
      ...POLICY,
      featureLinks: [{ id: LINK_ID, featureType: 'security', featurePolicyId: null }],
    });
    ruleSetGateMock.mockResolvedValue(REFUSAL);
    const res = await send(app, 'PATCH', { inlineSettings: { autoQuarantine: false, ruleSetIds: [SET] } });
    expect(res.status).toBe(400);
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('a non-security feature link never consults the gate', async () => {
    await send(app, 'POST', { featureType: 'patch', inlineSettings: {} });
    expect(ruleSetGateMock).not.toHaveBeenCalled();
  });
});
