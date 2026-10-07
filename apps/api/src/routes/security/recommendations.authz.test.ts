import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { insert: vi.fn() },
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({ auditLogs: {} }));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('./helpers', () => ({
  getPagination: vi.fn(),
  paginate: vi.fn(),
  // Real resolution logic: auth.orgId, else the sole accessible org, else null.
  getPolicyOrgId: vi.fn((auth: { orgId?: string | null; accessibleOrgIds?: string[] | null }) => {
    if (auth.orgId) return auth.orgId;
    if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) return auth.accessibleOrgIds[0];
    return null;
  }),
  getRecommendationStatusMap: vi.fn(),
  buildBe9Recommendations: vi.fn(async () => ({
    recommendations: [{ id: 'rec-1', priority: 'high', category: 'security' }],
  })),
}));

import { db } from '../../db';
import { buildBe9Recommendations } from './helpers';
import { recommendationsRoutes } from './recommendations';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      partnerId: null,
      user: { id: 'user-1', email: 'viewer@example.com', name: 'Viewer' },
    } as never);
    await next();
  });
  app.route('/security', recommendationsRoutes);
  return app;
}

describe.each(['complete', 'dismiss'] as const)('POST /recommendations/:id/%s authorization', (action) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies read-only viewers before writing recommendation status', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });

    const res = await buildApp().request(`/security/recommendations/rec-1/${action}`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows callers with devices:write and records the status event', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'write' }],
      allowedSiteIds: undefined,
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const res = await buildApp().request(`/security/recommendations/rec-1/${action}`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const ORG_FOREIGN = '44444444-4444-4444-8444-444444444444';

function buildPartnerApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: (orgId: string) => orgId === ORG_A || orgId === ORG_B,
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
    } as never);
    await next();
  });
  app.route('/security', recommendationsRoutes);
  return app;
}

// #8086: a multi-org partner user has auth.orgId === null, so the action
// endpoints must honour the ?orgId the UI sends (same as the GET list).
describe.each(['complete', 'dismiss'] as const)('POST /recommendations/:id/%s with ?orgId (multi-org partner)', (action) => {
  let insertValues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'write' }],
      allowedSiteIds: undefined,
    });
    insertValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as never);
  });

  it('records the status event against the selected org', async () => {
    const res = await buildPartnerApp().request(
      `/security/recommendations/rec-1/${action}?orgId=${ORG_B}`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(buildBe9Recommendations).toHaveBeenCalledWith(expect.anything(), ORG_B);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_B }));
  });

  it('rejects an org the caller cannot access without writing', async () => {
    const res = await buildPartnerApp().request(
      `/security/recommendations/rec-1/${action}?orgId=${ORG_FOREIGN}`,
      { method: 'POST' },
    );

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a malformed orgId', async () => {
    const res = await buildPartnerApp().request(
      `/security/recommendations/rec-1/${action}?orgId=not-a-uuid`,
      { method: 'POST' },
    );

    expect(res.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('still returns 400 when no org is selected and the caller spans several orgs', async () => {
    const res = await buildPartnerApp().request(`/security/recommendations/rec-1/${action}`, {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
