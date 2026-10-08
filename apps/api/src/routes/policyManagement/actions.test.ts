import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for POST /policies/:id/deactivate.
 *
 * Style follows monitorDefinitions.test.ts: middleware
 * (requireScope/requirePermission/requireMfa) is replaced with cheap gates
 * controlled by hoisted mocks, and the db layer is mocked directly.
 */
const { hasPermMock, mfaOkMock } = vi.hoisted(() => ({
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
}));

const updateMock = vi.hoisted(() => vi.fn());

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: updateMock,
        })),
      })),
    })),
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

const scheduleReconcileMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/complianceAlertReconcileTrigger', () => ({
  scheduleComplianceAlertReconcile: scheduleReconcileMock,
}));

const invalidateProbeMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/agentOrgSettingsCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentOrgSettingsCache')>()),
  invalidateOrgPolicyProbeCache: invalidateProbeMock,
}));

import { db } from '../../db';
import { actionRoutes } from './actions';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Disk space',
    enabled: true,
    ...overrides,
  };
}

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1', email: 'tech@example.com' },
      canAccessOrg: () => true,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/policies', actionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  vi.mocked(db.select).mockReturnValue(selectChain([policyRow()]) as never);
  updateMock.mockResolvedValue([policyRow({ enabled: false })]);
});

describe('POST /policies/:id/deactivate site ceiling', () => {
  it.each([
    ['restricted to one site', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']],
    ['restricted to zero sites', []],
  ])('denies a site-restricted caller (%s) with no update issued', async (_label, allowedSiteIds) => {
    const app = buildApp({ allowedSiteIds });
    const res = await app.request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies a caller with only an exact-device ceiling', async () => {
    const app = buildApp({ allowedDeviceIds: [] });
    const res = await app.request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows an unrestricted org caller to deactivate', async () => {
    const app = buildApp({});
    const res = await app.request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
  });

  it('requires MFA on the deactivate route', async () => {
    mfaOkMock.mockReturnValue(false);
    const app = buildApp({});
    const res = await app.request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });
});

// A disabled policy is never evaluated again, so nothing else would close the
// alerts it raised (compliance alerts do not auto-resolve).
describe('POST /policies/:id/deactivate closes the policy alerts', () => {
  it('schedules a compliance-alert reconcile for the policy owner', async () => {
    const res = await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(scheduleReconcileMock).toHaveBeenCalledWith({ orgId: ORG_ID }, 'automation-policy-deactivate');
  });

  it('scopes a partner-wide policy to its partner', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([policyRow({ orgId: null, partnerId: 'partner-1' })]) as never);
    const res = await buildApp({ scope: 'system' }).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(scheduleReconcileMock).toHaveBeenCalledWith({ partnerId: 'partner-1' }, 'automation-policy-deactivate');
  });

  it('schedules nothing when the deactivation is refused', async () => {
    mfaOkMock.mockReturnValue(false);
    await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(scheduleReconcileMock).not.toHaveBeenCalled();
  });
});

describe('POST /policies/:id/deactivate drops the heartbeat probe cache (#8053)', () => {
  it("drops the org's heartbeat probe cache", async () => {
    await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).toHaveBeenCalledWith(ORG_ID);
  });

  it("drops every org's probe cache for a partner-wide policy", async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([policyRow({ orgId: null, partnerId: 'partner-1' })]) as never);
    await buildApp({ scope: 'system' }).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).toHaveBeenCalledWith(undefined);
  });

  it('drops nothing when the deactivation is refused', async () => {
    mfaOkMock.mockReturnValue(false);
    await buildApp({}).request(`/policies/${POLICY_ID}/deactivate`, { method: 'POST' });
    expect(invalidateProbeMock).not.toHaveBeenCalled();
  });
});
