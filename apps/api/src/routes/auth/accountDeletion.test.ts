import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEmailMock = vi.fn(async () => undefined);
const verifyPasswordMock = vi.fn(async (_hash: string, _plaintext: string) => true);
const insertReturningMock = vi.fn(async () => [
  {
    id: 'req-1',
    userId: 'u-1',
    orgId: 'o-1',
    reason: 'I no longer need it',
    status: 'pending',
    requestedAt: new Date('2026-05-07T00:00:00Z'),
    processBy: new Date('2026-06-06T00:00:00Z'),
    processedAt: null,
    processedBy: null,
    createdAt: new Date('2026-05-07T00:00:00Z'),
    updatedAt: new Date('2026-05-07T00:00:00Z'),
  },
]);

const dbState: {
  pendingRow: unknown;
  userRow: unknown;
} = {
  pendingRow: undefined,
  userRow: {
    id: 'u-1',
    email: 'user@example.test',
    name: 'Sample User',
    passwordHash: 'argon2-hash',
    partnerId: 'p-1',
    orgId: 'o-1',
  },
};

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  accountDeletionRequests: {
    id: 'adr.id',
    userId: 'adr.userId',
    orgId: 'adr.orgId',
    reason: 'adr.reason',
    status: 'adr.status',
    requestedAt: 'adr.requestedAt',
    processBy: 'adr.processBy',
    updatedAt: 'adr.updatedAt',
  },
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
  partnerUsers: { partnerId: 'pu.partnerId', userId: 'pu.userId', roleId: 'pu.roleId' },
  roles: { id: 'roles.id', name: 'roles.name' },
  users: {
    id: 'users.id',
    email: 'users.email',
    name: 'users.name',
    partnerId: 'users.partnerId',
    orgId: 'users.orgId',
    passwordHash: 'users.passwordHash',
    status: 'users.status',
  },
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
  verifyPassword: (hash: string, plaintext: string) => verifyPasswordMock(hash, plaintext),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendEmail: sendEmailMock,
  })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: 'p-1',
      orgId: 'o-1',
      user: { id: 'u-1', email: 'user@example.test', name: 'Sample User' },
      token: { mfa: true },
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    USERS_WRITE: { resource: 'users', action: 'write' },
  },
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

import { accountDeletionRoutes } from './accountDeletion';
import { db } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import { writeAuthAudit } from './helpers';

function buildSelectChain() {
  // `db.select` is called multiple times in a single request:
  // 1. fetch the calling user's row (+ password hash)
  // 2. check for an existing pending request
  // 3. (post-insert) admin lookup via system-scope wrap
  // 4. (post-insert) billing email fallback
  // We model each call by walking through a queue of result rowsets.
  let callIdx = 0;
  vi.mocked(db.select as any).mockImplementation(() => {
    const stage = callIdx++;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (stage === 0) {
              return Promise.resolve(dbState.userRow ? [dbState.userRow] : []);
            }
            if (stage === 1) {
              return Promise.resolve(dbState.pendingRow ? [dbState.pendingRow] : []);
            }
            return Promise.resolve([]);
          }),
        }),
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
  });
}

function buildInsertChain() {
  vi.mocked(db.insert as any).mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: insertReturningMock,
    }),
  });
}

async function postRequest(body: unknown) {
  return accountDeletionRoutes.request('/account-deletion-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /account-deletion-request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getRedis).mockReturnValue({} as any);
    verifyPasswordMock.mockResolvedValue(true);
    insertReturningMock.mockClear();
    dbState.pendingRow = undefined;
    dbState.userRow = {
      id: 'u-1',
      email: 'user@example.test',
      name: 'Sample User',
      passwordHash: 'argon2-hash',
      partnerId: 'p-1',
      orgId: 'o-1',
    };
    buildSelectChain();
    buildInsertChain();
  });

  it('happy path: records the deletion request, returns 201, and audits success', async () => {
    const res = await postRequest({ password: 'correct-horse', reason: 'I no longer need it' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      requestId: 'req-1',
      status: 'pending',
      processBy: '2026-06-06T00:00:00.000Z',
    });

    expect(verifyPasswordMock).toHaveBeenCalledWith('argon2-hash', 'correct-horse');
    expect(insertReturningMock).toHaveBeenCalledTimes(1);

    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.account_deletion.requested', result: 'success' })
    );
  });

  it('returns 401 when the password does not match', async () => {
    verifyPasswordMock.mockResolvedValueOnce(false);
    const res = await postRequest({ password: 'wrong' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid password' });
    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.account_deletion.requested', result: 'failure', reason: 'invalid_password' })
    );
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      resetAt: new Date(Date.now() + 60_000),
    } as any);
    const res = await postRequest({ password: 'correct-horse' });
    expect(res.status).toBe(429);
    expect(insertReturningMock).not.toHaveBeenCalled();
  });

  it('is idempotent: returns the existing pending request without inserting again', async () => {
    dbState.pendingRow = {
      id: 'req-existing',
      userId: 'u-1',
      orgId: 'o-1',
      reason: null,
      status: 'pending',
      requestedAt: new Date('2026-05-06T00:00:00Z'),
      processBy: new Date('2026-06-05T00:00:00Z'),
      processedAt: null,
      processedBy: null,
      createdAt: new Date('2026-05-06T00:00:00Z'),
      updatedAt: new Date('2026-05-06T00:00:00Z'),
    };

    const res = await postRequest({ password: 'correct-horse' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBe('req-existing');
    expect(insertReturningMock).not.toHaveBeenCalled();
  });
});
