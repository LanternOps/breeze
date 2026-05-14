import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: <T>(fn: () => Promise<T>) => fn(),
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../middleware/mobileDeviceBlocked', () => ({
  mobileDeviceBlockedMiddleware: vi.fn((_c: any, next: any) => next()),
}));

const { revokeUserOauthClientMock } = vi.hoisted(() => ({
  revokeUserOauthClientMock: vi.fn(),
}));
vi.mock('../services/oauthRevocation', () => ({
  revokeUserOauthClient: revokeUserOauthClientMock,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
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

vi.mock('../db/schema/ai', () => ({
  aiToolExecutions: { id: 'id' },
}));

vi.mock('../db/schema/oauth', () => ({
  oauthGrants: { id: 'id', accountId: 'accountId', clientId: 'clientId' },
  oauthRefreshTokens: { id: 'id', userId: 'userId', clientId: 'clientId' },
}));

vi.mock('../db/schema/audit', () => ({
  auditLogs: {},
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

function mockUpdateReturning(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
    }),
  } as any);
  return returning;
}

function mockSelectResolves(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
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
    mockSelectResolves([]);

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
    mockSelectResolves([approval]);

    const res = await buildApp().request('/approvals/a1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.id).toBe('a1');
  });
});

describe('POST /approvals/:id/approve', () => {
  const updatedRow = {
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
  };

  it('approves a pending non-expired request', async () => {
    const returning = mockUpdateReturning([updatedRow]);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(returning).toHaveBeenCalled();
    const body = await res.json();
    expect(body.approval.id).toBe('a1');
    expect(body.approval.status).toBe('approved');
  });

  it('returns 409 with finalStatus when already decided', async () => {
    mockUpdateReturning([]);
    mockSelectResolves([
      {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'denied',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.finalStatus).toBe('denied');
  });

  it('returns 410 with finalStatus expired when row exists but UPDATE missed', async () => {
    mockUpdateReturning([]);
    mockSelectResolves([
      {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'pending',
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.finalStatus).toBe('expired');
  });

  it('returns 404 when the approval does not exist for this user', async () => {
    mockUpdateReturning([]);
    mockSelectResolves([]);

    const res = await buildApp().request('/approvals/missing/approve', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('mirrors approval to ai_tool_executions when executionId is linked', async () => {
    const linkedRow = { ...updatedRow, executionId: 'exec-42' };
    // First update (approval_requests) returns the row; second update
    // (ai_tool_executions) just resolves.
    const aiSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const approvalReturning = vi.fn().mockResolvedValue([linkedRow]);
    const approvalSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalReturning }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: approvalSet } as any)
      .mockReturnValueOnce({ set: aiSet } as any);

    const res = await buildApp().request('/approvals/a1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(approvalSet).toHaveBeenCalled();
    expect(aiSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: TEST_USER.id }),
    );
  });
});

describe('POST /approvals/:id/deny', () => {
  it('denies a pending non-expired request', async () => {
    mockUpdateReturning([
      {
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
        status: 'denied',
        expiresAt: new Date(Date.now() + 60_000),
        decidedAt: new Date(),
        decisionReason: 'no thanks',
        createdAt: new Date(),
      },
    ]);

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no thanks' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.status).toBe('denied');
    expect(body.approval.decisionReason).toBe('no thanks');
  });

  it('returns 409 with finalStatus when already decided', async () => {
    mockUpdateReturning([]);
    mockSelectResolves([
      {
        id: 'a1',
        userId: TEST_USER.id,
        status: 'approved',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.finalStatus).toBe('approved');
  });

  it('mirrors deny to ai_tool_executions as rejected when executionId is linked', async () => {
    const deniedRow = {
      id: 'a1',
      userId: TEST_USER.id,
      requestingClientLabel: 'Breeze AI',
      requestingMachineLabel: null,
      requestingClientId: null,
      requestingSessionId: null,
      actionLabel: 'x',
      actionToolName: 'execute_command',
      actionArguments: {},
      riskTier: 'high',
      riskSummary: 'z',
      status: 'denied',
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: new Date(),
      decisionReason: null,
      executionId: 'exec-77',
      createdAt: new Date(),
    };
    const aiSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const approvalReturning = vi.fn().mockResolvedValue([deniedRow]);
    const approvalSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: approvalReturning }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce({ set: approvalSet } as any)
      .mockReturnValueOnce({ set: aiSet } as any);

    const res = await buildApp().request('/approvals/a1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(aiSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', approvedBy: TEST_USER.id }),
    );
  });
});

describe('POST /approvals/:id/report-suspicious', () => {
  const baseRow = {
    id: 'a1',
    userId: TEST_USER.id,
    requestingClientLabel: 'Claude Desktop',
    requestingMachineLabel: null,
    requestingClientId: 'client-xyz',
    requestingSessionId: null,
    actionLabel: 'Delete prod devices',
    actionToolName: 'breeze.devices.delete',
    actionArguments: {},
    riskTier: 'high' as const,
    riskSummary: 'Reported as suspicious test',
    status: 'pending' as const,
    expiresAt: new Date(Date.now() + 60_000),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    createdAt: new Date(),
  };

  function wireRevocationStubs(opts: {
    existing: typeof baseRow | null;
    revokeResult?: { grantsRevoked: number; refreshTokensRevoked: number; cacheFailures: number };
    revokeThrows?: Error;
  }) {
    // 1) initial select to find approval
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(opts.existing ? [opts.existing] : []),
      }),
    } as any);

    // 2) update approval_requests (status=reported)
    const approvalUpdateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: approvalUpdateSet } as any);

    // insert audit log
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);

    revokeUserOauthClientMock.mockReset();
    if (opts.revokeThrows) {
      revokeUserOauthClientMock.mockRejectedValueOnce(opts.revokeThrows);
    } else {
      revokeUserOauthClientMock.mockResolvedValueOnce(
        opts.revokeResult ?? { grantsRevoked: 1, refreshTokensRevoked: 1, cacheFailures: 0 },
      );
    }

    return { approvalUpdateSet };
  }

  it('happy path: 204, marks row reported, calls revokeUserOauthClient, writes audit', async () => {
    const { approvalUpdateSet } = wireRevocationStubs({ existing: baseRow });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(approvalUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reported' }),
    );
    expect(revokeUserOauthClientMock).toHaveBeenCalledWith(
      TEST_USER.id,
      baseRow.requestingClientId,
      TEST_USER.id,
      expect.any(String),
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it('returns 200 + warning when revocation throws (session not revoked)', async () => {
    wireRevocationStubs({ existing: baseRow, revokeThrows: new Error('db down') });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reported).toBe(true);
    expect(body.revoked).toBe(false);
    expect(body.warning).toMatch(/revoke this app manually/i);
  });

  it('returns 200 + warning when revocation succeeds but cacheFailures > 0', async () => {
    wireRevocationStubs({
      existing: baseRow,
      revokeResult: { grantsRevoked: 1, refreshTokensRevoked: 1, cacheFailures: 2 },
    });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reported).toBe(true);
    expect(body.revoked).toBe(true);
    expect(body.cacheFailures).toBe(2);
  });

  it('returns 404 when the approval does not exist for this user', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await buildApp().request('/approvals/missing/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 401 when auth middleware rejects (permission denied)', async () => {
    vi.mocked(authMiddleware).mockImplementationOnce((c: any) => {
      return c.json({ error: 'unauthorized' }, 401);
    });

    const res = await buildApp().request('/approvals/a1/report-suspicious', { method: 'POST' });
    expect(res.status).toBe(401);
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

  it('returns 404 when NODE_ENV is unset (e.g. staging)', async () => {
    const orig = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
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
      if (orig === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = orig;
    }
  });

  it('creates a seed approval and returns 201 with push diagnostics', async () => {
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
      expect(body.push).toEqual({ tokensFound: 1, dispatched: 1, errors: [] });
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
