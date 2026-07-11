import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertReturningMock = vi.fn(async () => [
  {
    id: 'approval-test-1',
    userId: 'u-1',
    requestingClientLabel: 'Breeze (test trigger)',
    requestingMachineLabel: null,
    actionLabel: 'Approve a test request from Breeze.',
    actionToolName: 'breeze.test.approval',
    actionArguments: { note: 'sandbox' },
    riskTier: 'low',
    riskSummary: 'Sandbox test.',
    status: 'pending',
    expiresAt: new Date('2026-05-07T00:01:00Z'),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    createdAt: new Date('2026-05-07T00:00:00Z'),
  },
]);

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Keep the real enums (approvalFactorEnum et al.) — schema/elevations.ts calls
// approvalFactorEnum() at module load, so a bare factory that omits them breaks the
// whole schema import. Override only approvalRequests with the query stub.
vi.mock('../../db/schema/approvals', async (importActual) => ({
  ...(await importActual<typeof import('../../db/schema/approvals')>()),
  approvalRequests: {
    id: 'ar.id',
    userId: 'ar.userId',
    status: 'ar.status',
    expiresAt: 'ar.expiresAt',
  },
}));

const dispatchApprovalPushMock = vi.fn(
  async (
    _userId: string,
    _args: { approvalId: string; actionLabel: string; requestingClientLabel: string },
  ) => ({
    tokensFound: 0,
    dispatched: 0,
    errors: 0,
  }),
);

vi.mock('../../services/expoPush', () => ({
  dispatchApprovalPush: (
    userId: string,
    args: { approvalId: string; actionLabel: string; requestingClientLabel: string },
  ) => dispatchApprovalPushMock(userId, args),
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: 'p-1',
      orgId: 'o-1',
      user: { id: 'u-1', email: 'reviewer@example.test', name: 'Reviewer' },
      token: { mfa: false },
    });
    return next();
  }),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    writeAuthAudit: vi.fn(),
    resolveUserAuditOrgId: vi.fn(async () => 'o-1'),
  };
});

import { testApprovalRoutes } from './testApproval';
import { db } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import { writeAuthAudit } from './helpers';

function buildInsertChain() {
  vi.mocked(db.insert as any).mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: insertReturningMock,
    }),
  });
}

async function postTrigger() {
  return testApprovalRoutes.request('/me/test-approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('POST /auth/me/test-approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getRedis).mockReturnValue({} as any);
    insertReturningMock.mockClear();
    dispatchApprovalPushMock
      .mockReset()
      .mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
    buildInsertChain();
  });

  it('happy path: inserts approval row with expected fields, dispatches push, returns 201', async () => {
    dispatchApprovalPushMock.mockResolvedValueOnce({
      tokensFound: 2,
      dispatched: 2,
      errors: 0,
    });

    const res = await postTrigger();
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toMatchObject({
      approvalId: 'approval-test-1',
      pushSentToDeviceCount: 2,
      registeredDeviceCount: 2,
      errors: 0,
    });
    expect(typeof body.expiresAt).toBe('string');

    // Validate the row that was inserted has the expected sandbox shape.
    const valuesCall = vi.mocked(db.insert as any).mock.results[0]?.value
      ?.values?.mock?.calls?.[0]?.[0];
    expect(valuesCall).toMatchObject({
      userId: 'u-1',
      actionToolName: 'breeze.test.approval',
      actionLabel: 'Approve a test request from Breeze.',
      requestingClientLabel: 'Breeze (test trigger)',
      requestingMachineLabel: null,
      riskTier: 'low',
      status: 'pending',
      executionId: null,
    });
    expect(valuesCall.actionArguments).toMatchObject({ note: expect.any(String) });
    expect(valuesCall.expiresAt).toBeInstanceOf(Date);

    expect(dispatchApprovalPushMock).toHaveBeenCalledTimes(1);
    expect(dispatchApprovalPushMock).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        approvalId: 'approval-test-1',
        actionLabel: 'Approve a test request from Breeze.',
        requestingClientLabel: 'Breeze (test trigger)',
      }),
    );
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.test_approval.triggered',
        result: 'success',
      }),
    );
  });

  it('returns 429 after exceeding the rate limit', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      resetAt: new Date(Date.now() + 30_000),
    } as any);

    const res = await postTrigger();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(dispatchApprovalPushMock).not.toHaveBeenCalled();
  });

  it('still creates the approval and reports zero devices when the user has no registered mobile push tokens', async () => {
    dispatchApprovalPushMock.mockResolvedValueOnce({ tokensFound: 0, dispatched: 0, errors: 0 });

    const res = await postTrigger();
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toMatchObject({
      approvalId: 'approval-test-1',
      pushSentToDeviceCount: 0,
      registeredDeviceCount: 0,
      errors: 0,
    });
    expect(insertReturningMock).toHaveBeenCalledTimes(1);
  });
});
