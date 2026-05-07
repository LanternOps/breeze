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

vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: {
    id: 'ar.id',
    userId: 'ar.userId',
    status: 'ar.status',
    expiresAt: 'ar.expiresAt',
  },
}));

const getUserPushTokensMock = vi.fn(async (_uid: string) => [] as string[]);
const sendExpoPushMock = vi.fn(async (msgs: unknown[]) =>
  msgs.map(() => ({ status: 'ok' as const, id: 'ticket-1' })),
);

vi.mock('../../services/expoPush', () => ({
  buildApprovalPush: vi.fn(() => ({
    title: 'Approval requested',
    body: 'Breeze (test trigger): Approve a test request from Breeze.',
    data: { type: 'approval', approvalId: 'approval-test-1' },
    sound: 'default',
    priority: 'high',
    channelId: 'approvals',
    ttl: 60,
  })),
  getUserPushTokens: (uid: string) => getUserPushTokensMock(uid),
  sendExpoPush: (msgs: unknown[]) => sendExpoPushMock(msgs),
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
    getUserPushTokensMock.mockReset().mockResolvedValue([]);
    sendExpoPushMock
      .mockReset()
      .mockImplementation(async (msgs: unknown[]) =>
        (msgs as unknown[]).map(() => ({ status: 'ok' as const, id: 'ticket-1' })),
      );
    buildInsertChain();
  });

  it('happy path: inserts approval row with expected fields, dispatches push, returns 201', async () => {
    getUserPushTokensMock.mockResolvedValueOnce([
      'ExponentPushToken[abc]',
      'ExponentPushToken[def]',
    ]);

    const res = await postTrigger();
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toMatchObject({
      approvalId: 'approval-test-1',
      pushSentToDeviceCount: 2,
      registeredDeviceCount: 2,
      errors: [],
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

    expect(sendExpoPushMock).toHaveBeenCalledTimes(1);
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
    expect(sendExpoPushMock).not.toHaveBeenCalled();
  });

  it('still creates the approval and reports zero devices when the user has no registered mobile push tokens', async () => {
    getUserPushTokensMock.mockResolvedValueOnce([]);

    const res = await postTrigger();
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body).toMatchObject({
      approvalId: 'approval-test-1',
      pushSentToDeviceCount: 0,
      registeredDeviceCount: 0,
      errors: [],
    });
    expect(sendExpoPushMock).not.toHaveBeenCalled();
    expect(insertReturningMock).toHaveBeenCalledTimes(1);
  });
});
