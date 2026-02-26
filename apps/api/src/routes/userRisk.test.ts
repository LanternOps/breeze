import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => await next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => await next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => await next(),
  resolveOrgAccess: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/userRiskScoring', () => ({
  listUserRiskScores: vi.fn(),
  getUserRiskDetail: vi.fn(),
  getUserRiskOrgMembership: vi.fn(),
  listUserRiskEvents: vi.fn(),
  getOrCreateUserRiskPolicy: vi.fn(),
  updateUserRiskPolicy: vi.fn(),
  assignSecurityTraining: vi.fn()
}));

import { userRiskRoutes } from './userRisk';
import {
  assignSecurityTraining,
  getOrCreateUserRiskPolicy,
  getUserRiskDetail,
  listUserRiskEvents,
  listUserRiskScores,
  updateUserRiskPolicy
} from '../services/userRiskScoring';
import { resolveOrgAccess } from '../middleware/auth';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000010';

function buildApp(authOverrides?: Partial<{
  scope: 'organization' | 'partner' | 'system';
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
}>): Hono {
  const authSetter = async (c: any, next: any) => {
    c.set('auth', {
      user: { id: '00000000-0000-0000-0000-000000000099', email: 'tester@example.com', name: 'Tester' },
      scope: authOverrides?.scope ?? 'organization',
      orgId: authOverrides?.orgId ?? ORG_ID,
      accessibleOrgIds: authOverrides?.accessibleOrgIds ?? [ORG_ID],
      canAccessOrg: authOverrides?.canAccessOrg ?? ((id: string) => id === ORG_ID)
    });
    await next();
  };

  const app = new Hono();
  app.use('/user-risk', authSetter);
  app.use('/user-risk/*', authSetter);
  app.route('/user-risk', userRiskRoutes);
  return app;
}

describe('userRiskRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveOrgAccess).mockResolvedValue({ type: 'single', orgId: ORG_ID });
  });

  it('GET /scores returns ranked scores with pagination', async () => {
    vi.mocked(listUserRiskScores).mockResolvedValue({
      total: 1,
      rows: [
        {
          orgId: ORG_ID,
          userId: USER_ID,
          userName: 'Alice',
          userEmail: 'alice@example.com',
          score: 78,
          trendDirection: 'up',
          calculatedAt: '2026-02-26T00:00:00.000Z',
          factors: { mfaRisk: 90 }
        }
      ]
    });

    const app = buildApp();
    const res = await app.request('/user-risk/scores');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
    expect(body.summary.highRiskUsers).toBe(1);
  });

  it('GET /scores returns 403 for inaccessible org filter', async () => {
    const app = buildApp();
    const res = await app.request(`/user-risk/scores?orgId=${ORG_ID_2}`);
    expect(res.status).toBe(403);
  });

  it('GET /users/:userId returns detail payload', async () => {
    vi.mocked(getUserRiskDetail).mockResolvedValue({
      user: {
        id: USER_ID,
        name: 'Alice',
        email: 'alice@example.com',
        mfaEnabled: true,
        lastLoginAt: '2026-02-25T00:00:00.000Z'
      },
      latestScore: {
        score: 55,
        factors: { mfaRisk: 10 },
        trendDirection: 'stable',
        calculatedAt: '2026-02-26T00:00:00.000Z',
        deltaFromPrevious: 0,
        severity: 'medium'
      },
      recentEvents: [],
      history: [],
      policy: {
        orgId: ORG_ID,
        weights: {},
        thresholds: {},
        interventions: {},
        updatedAt: '2026-02-26T00:00:00.000Z',
        updatedBy: null
      }
    });

    const app = buildApp();
    const res = await app.request(`/user-risk/users/${USER_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user.id).toBe(USER_ID);
    expect(body.data.latestScore.score).toBe(55);
  });

  it('GET /events returns event history', async () => {
    vi.mocked(listUserRiskEvents).mockResolvedValue({
      total: 1,
      rows: [
        {
          id: '00000000-0000-0000-0000-000000000020',
          orgId: ORG_ID,
          userId: USER_ID,
          userName: 'Alice',
          userEmail: 'alice@example.com',
          eventType: 'training_assigned',
          severity: 'low',
          scoreImpact: -5,
          description: 'Assigned training',
          details: {},
          occurredAt: '2026-02-26T00:00:00.000Z'
        }
      ]
    });

    const app = buildApp();
    const res = await app.request('/user-risk/events');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });

  it('PUT /policy updates policy', async () => {
    vi.mocked(updateUserRiskPolicy).mockResolvedValue({
      orgId: ORG_ID,
      weights: { mfaRisk: 0.2 },
      thresholds: { high: 70 },
      interventions: { autoAssignTraining: true },
      updatedAt: '2026-02-26T00:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-000000000099'
    });

    const app = buildApp();
    const res = await app.request('/user-risk/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thresholds: { high: 70 } })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgId).toBe(ORG_ID);
  });

  it('GET /policy returns org policy', async () => {
    vi.mocked(getOrCreateUserRiskPolicy).mockResolvedValue({
      orgId: ORG_ID,
      weights: {},
      thresholds: {},
      interventions: {},
      updatedAt: '2026-02-26T00:00:00.000Z',
      updatedBy: null
    });

    const app = buildApp();
    const res = await app.request('/user-risk/policy');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.orgId).toBe(ORG_ID);
  });

  it('POST /assign-training triggers assignment workflow', async () => {
    vi.mocked(assignSecurityTraining).mockResolvedValue({
      assignmentEventId: '00000000-0000-0000-0000-000000000020',
      moduleId: 'security-awareness-baseline',
      deduplicated: false,
      eventPublished: true
    });

    const app = buildApp();
    const res = await app.request('/user-risk/assign-training', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.assignmentEventId).toBeDefined();
  });
});
