import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Enabling IOC auto-quarantine on a policy's `security` feature is a
 * device-execution grant: it needs devices:execute + MFA, and the write stamps
 * a stored authority the scan dispatcher re-resolves. Writes that leave
 * auto-quarantine off keep the plain devices:write requirement.
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
const WRITE_AND_EXECUTE = [...WRITE_ONLY, { resource: 'devices', action: 'execute' }];

describe('security feature link auto-quarantine authority', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = WRITE_ONLY;
    state.mfa = true;
    app = buildApp();
    getConfigPolicyMock.mockResolvedValue(POLICY);
    addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
    updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'security' });
  });

  it('POST: 403 when enabling auto-quarantine without devices:execute', async () => {
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { autoQuarantine: true } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('AUTO_QUARANTINE_EXECUTE_REQUIRED');
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST: settings that omit autoQuarantine take the default (on) and are gated too', async () => {
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { scanType: 'quick' } });
    expect(res.status).toBe(403);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST: 403 MFA_REQUIRED with devices:execute but no MFA', async () => {
    state.permissions = WRITE_AND_EXECUTE;
    state.mfa = false;
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { autoQuarantine: true } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
  });

  it('POST: devices:execute + MFA stamps an authority for the policy owner', async () => {
    state.permissions = WRITE_AND_EXECUTE;
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { autoQuarantine: true } });
    expect(res.status).toBe(201);
    const options = addFeatureLinkMock.mock.calls[0]![6];
    expect(options.executionAuthority).toEqual(expect.objectContaining({
      executionAuthorityUserId: 'user-1',
      executionAuthorityKind: 'organization_unrestricted',
      executionAuthorityGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
  });

  it('POST: auto-quarantine off needs only devices:write and stamps nothing', async () => {
    const res = await send(app, 'POST', { featureType: 'security', inlineSettings: { autoQuarantine: false } });
    expect(res.status).toBe(201);
    expect(addFeatureLinkMock.mock.calls[0]![6]).toEqual({ executionAuthority: null });
  });

  describe('PATCH', () => {
    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue({
        ...POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'security', featurePolicyId: null }],
      });
    });

    it('403 when saving settings with auto-quarantine on without devices:execute', async () => {
      const res = await send(app, 'PATCH', { inlineSettings: { autoQuarantine: true, exclusions: ['C:\\Temp'] } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('AUTO_QUARANTINE_EXECUTE_REQUIRED');
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('devices:execute + MFA re-stamps the authority', async () => {
      state.permissions = WRITE_AND_EXECUTE;
      const res = await send(app, 'PATCH', { inlineSettings: { autoQuarantine: true } });
      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock.mock.calls[0]![5].executionAuthority).toEqual(
        expect.objectContaining({ executionAuthorityUserId: 'user-1' }),
      );
    });

    it('turning auto-quarantine off is allowed with devices:write and clears the stamp', async () => {
      const res = await send(app, 'PATCH', { inlineSettings: { autoQuarantine: false } });
      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock.mock.calls[0]![5]).toEqual({ executionAuthority: null });
    });
  });
});
