import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../services/expoPush', () => ({
  sendExpoPush: vi.fn(async () => [{ status: 'ok', id: 'tk' }]),
  getUserPushTokens: vi.fn(async () => ['ExponentPushToken[abc]']),
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'Dev Seed: x',
    data: { type: 'approval', approvalId: 'a1' },
  })),
}));

vi.mock('../db/schema/approvals', () => ({
  approvalRequests: {},
}));

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 't@example.com',
  name: 'Test User',
  isPlatformAdmin: false,
};

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: TEST_USER,
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      orgCondition: () => undefined,
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { approvalRoutes } from './approvals';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

function buildApp() {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: TEST_USER,
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      orgCondition: () => undefined,
    });
    return next();
  });
});

describe('GET /approvals/pending', () => {
  it('returns only pending non-expired approvals for the authed user', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([
            {
              id: 'a1',
              userId: TEST_USER.id,
              requestingClientLabel: 'Claude Desktop',
              requestingMachineLabel: "Todd's MacBook Pro",
              requestingClientId: null,
              requestingSessionId: null,
              actionLabel: 'Delete 4 devices in Acme Corp',
              actionToolName: 'breeze.devices.delete',
              actionArguments: { ids: ['x'] },
              riskTier: 'high',
              riskSummary: 'High impact: deletes data.',
              status: 'pending',
              expiresAt: new Date(Date.now() + 60_000),
              decidedAt: null,
              decisionReason: null,
              createdAt: new Date(),
            },
          ]),
        }),
      }),
    } as any);

    const res = await buildApp().request('/approvals/pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe('a1');
  });
});

describe('GET /approvals/:id', () => {
  it('returns 404 when approval not found', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns the approval when found', async () => {
    const approval = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Claude Desktop',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'Reboot devices',
      actionToolName: 'breeze.devices.reboot',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'Low risk operation.',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date(),
    };
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([approval]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.id).toBe('a1');
  });
});

describe('POST /approvals/:id/approve', () => {
  it('rejects when the approval is already decided', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: 'a1',
          userId: TEST_USER.id,
          status: 'denied',
          expiresAt: new Date(Date.now() + 60_000),
        }]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('rejects when the approval has expired', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: 'a1',
          userId: TEST_USER.id,
          status: 'pending',
          expiresAt: new Date(Date.now() - 1000),
        }]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('updates status to approved when valid', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: 'a1',
          userId: TEST_USER.id,
          status: 'pending',
          expiresAt: new Date(Date.now() + 60_000),
        }]),
      }),
    } as any);

    const updateReturning = vi.fn().mockResolvedValue([{
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Claude Desktop',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'y',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'z',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: null,
      createdAt: new Date(),
    }]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: updateReturning,
        }),
      }),
    } as any);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(updateReturning).toHaveBeenCalled();
  });
});

describe('POST /approvals/:id/deny', () => {
  it('returns 409 when already decided', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: 'a1',
          userId: TEST_USER.id,
          status: 'approved',
          expiresAt: new Date(Date.now() + 60_000),
        }]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /approvals/dev/seed', () => {
  it('returns 404 when NODE_ENV=production', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionLabel: 'x',
          actionToolName: 'y',
          riskTier: 'low',
          riskSummary: 'z',
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('creates a seed approval and returns 201', async () => {
    const now = new Date();
    const seededRow = {
      id: 'seed-1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Dev Seed',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'Test action',
      actionToolName: 'breeze.test',
      actionArguments: {},
      riskTier: 'low',
      riskSummary: 'Just a test',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decisionReason: null,
      createdAt: now,
    };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([seededRow]),
      }),
    } as any);

    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const res = await buildApp().request('/approvals/dev/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionLabel: 'Test action',
          actionToolName: 'breeze.test',
          riskTier: 'low',
          riskSummary: 'Just a test',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.approval.id).toBe('seed-1');
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
