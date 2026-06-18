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
  getUserRiskEvaluation: vi.fn(),
  getUserRiskDetail: vi.fn(),
  getUserRiskOrgMembership: vi.fn(),
  listUserRiskEvents: vi.fn(),
  getOrCreateUserRiskPolicy: vi.fn(),
  updateUserRiskPolicy: vi.fn(),
  assignSecurityTraining: vi.fn()
}));

vi.mock('../services/mlFeedbackEmitters', () => ({
  emitUserRiskFeedback: vi.fn()
}));

import { userRiskRoutes } from './userRisk';
import {
  assignSecurityTraining,
  getOrCreateUserRiskPolicy,
  getUserRiskEvaluation,
  getUserRiskDetail,
  getUserRiskOrgMembership,
  listUserRiskEvents,
  listUserRiskScores,
  updateUserRiskPolicy
} from '../services/userRiskScoring';
import { resolveOrgAccess } from '../middleware/auth';
import { emitUserRiskFeedback } from '../services/mlFeedbackEmitters';

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

  it('GET /evaluation returns label quality metrics', async () => {
    vi.mocked(getUserRiskEvaluation).mockResolvedValue({
      windowDays: 30,
      totalLabels: 4,
      truePositives: 3,
      falsePositives: 1,
      precision: 0.75,
      trainingAssigned: 2,
      trainingCompleted: 1,
      trainingCompletionRate: 0.5,
      riskSignals: 12,
      usersWithRiskSignals: 5,
      repeatSignalUsers: 2,
      repeatSignalRate: 0.4
    });

    const app = buildApp();
    const res = await app.request('/user-risk/evaluation?days=14');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.precision).toBe(0.75);
    expect(getUserRiskEvaluation).toHaveBeenCalledWith({
      orgIds: [ORG_ID],
      days: 14
    });
  });

  it('GET /evaluation returns 403 for inaccessible org filter', async () => {
    const app = buildApp();
    const res = await app.request(`/user-risk/evaluation?orgId=${ORG_ID_2}`);
    expect(res.status).toBe(403);
    expect(getUserRiskEvaluation).not.toHaveBeenCalled();
  });

  it('POST /users/:userId/feedback records a true-positive label', async () => {
    vi.mocked(getUserRiskOrgMembership).mockResolvedValue(true);
    vi.mocked(emitUserRiskFeedback).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/user-risk/users/${USER_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'true_positive', score: 88, reason: 'confirmed_incident' })
    });

    expect(res.status).toBe(200);
    expect(emitUserRiskFeedback).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      userId: USER_ID,
      eventType: 'user_risk.true_positive',
      outcome: 'true_positive',
      actorUserId: '00000000-0000-0000-0000-000000000099'
    }));
  });

  it('POST /users/:userId/feedback returns 404 for a user outside the org', async () => {
    vi.mocked(getUserRiskOrgMembership).mockResolvedValue(false);

    const app = buildApp();
    const res = await app.request(`/user-risk/users/${USER_ID}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'false_positive' })
    });

    expect(res.status).toBe(404);
    expect(emitUserRiskFeedback).not.toHaveBeenCalled();
  });

  it('POST /users/:userId/training-completed records a completion label', async () => {
    vi.mocked(getUserRiskOrgMembership).mockResolvedValue(true);
    vi.mocked(emitUserRiskFeedback).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/user-risk/users/${USER_ID}/training-completed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        moduleId: 'security-awareness-baseline',
        assignmentEventId: '00000000-0000-0000-0000-000000000020',
        completedAt: '2026-06-18T12:00:00.000Z'
      })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, eventType: 'training.completed' });
    expect(emitUserRiskFeedback).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      userId: USER_ID,
      eventType: 'training.completed',
      outcome: 'completed',
      actorUserId: '00000000-0000-0000-0000-000000000099',
      metadata: expect.objectContaining({
        source: 'user_risk_training_completion',
        moduleId: 'security-awareness-baseline',
        assignmentEventId: '00000000-0000-0000-0000-000000000020',
        completedAt: '2026-06-18T12:00:00.000Z'
      })
    }));
  });

  it('POST /users/:userId/training-completed returns 404 for a user outside the org', async () => {
    vi.mocked(getUserRiskOrgMembership).mockResolvedValue(false);

    const app = buildApp();
    const res = await app.request(`/user-risk/users/${USER_ID}/training-completed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'User not found in this organization' });
    expect(emitUserRiskFeedback).not.toHaveBeenCalled();
  });

  it('POST /users/:userId/training-completed rejects inaccessible orgs before membership lookup', async () => {
    const app = buildApp({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id) => id === ORG_ID
    });
    const res = await app.request(`/user-risk/users/${USER_ID}/training-completed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID_2 })
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access denied to this organization' });
    expect(getUserRiskOrgMembership).not.toHaveBeenCalled();
    expect(emitUserRiskFeedback).not.toHaveBeenCalled();
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
    expect(emitUserRiskFeedback).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      userId: USER_ID,
      eventType: 'training.assigned',
      outcome: 'assigned'
    }));
  });
});
