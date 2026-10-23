import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  securityStatus: {},
  securityThreats: {},
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(async () => undefined),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getSecurityPostureTrend: vi.fn(async () => []),
}));

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

// Keep requireScope as a passthrough; use real requirePermission so RBAC
// is actually enforced in tests.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

import { listLatestSecurityPosture } from '../../services/securityPosture';
import { dashboardRoutes } from './dashboard';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
      ...authOverrides,
    } as any);
    await next();
  });
  app.route('/security', dashboardRoutes);
  return app;
}

describe('GET /dashboard — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/dashboard', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

describe('GET /score-breakdown — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/score-breakdown', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

// #9639: the header org switcher sends ?orgId=<selected org>. Score must
// narrow to it (within the caller's accessible orgs), not aggregate the book.
describe('GET /score-breakdown — selected organization (#9639)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ORG_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const partnerAuth = {
    scope: 'partner',
    orgId: null,
    partnerId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (id: string) => id === ORG_A || id === ORG_B,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('narrows posture to the selected org', async () => {
    const res = await buildApp(partnerAuth).request(`/security/score-breakdown?orgId=${ORG_A}`);

    expect(res.status).toBe(200);
    expect(listLatestSecurityPosture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listLatestSecurityPosture).mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A] });
  });

  it('returns 403 for an org outside the caller\'s access and reads nothing', async () => {
    const res = await buildApp(partnerAuth).request(`/security/score-breakdown?orgId=${ORG_OTHER}`);

    expect(res.status).toBe(403);
    expect(listLatestSecurityPosture).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed orgId', async () => {
    const res = await buildApp(partnerAuth).request('/security/score-breakdown?orgId=not-a-uuid');

    expect(res.status).toBe(400);
    expect(listLatestSecurityPosture).not.toHaveBeenCalled();
  });

  it('denies an org-scoped caller selecting another org (403)', async () => {
    const res = await buildApp({ orgId: ORG_A, accessibleOrgIds: [ORG_A], canAccessOrg: (id: string) => id === ORG_A })
      .request(`/security/score-breakdown?orgId=${ORG_B}`);

    expect(res.status).toBe(403);
    expect(listLatestSecurityPosture).not.toHaveBeenCalled();
  });

  it('keeps every accessible org when no org is selected', async () => {
    const res = await buildApp(partnerAuth).request('/security/score-breakdown');

    expect(res.status).toBe(200);
    expect(vi.mocked(listLatestSecurityPosture).mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A, ORG_B] });
  });
});
