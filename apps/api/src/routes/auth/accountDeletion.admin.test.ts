import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// Mocks — kept self-contained so this suite doesn't share state with
// the user-facing accountDeletion.test.ts file.
// ============================================================

const sendEmailMock = vi.fn(async () => undefined);
const writeAuthAuditMock = vi.fn();
let mockAuth: any = null;
let nextRequestRow: any | undefined = undefined;
let nextUpdatedRow: any | undefined = undefined;
let pendingListRows: any[] = [];

vi.mock('../../db', () => {
  // db.select() is invoked in several shapes:
  //   - list:  .from(...).leftJoin(...).where(...).orderBy(...).limit(...).offset(...)
  //   - count: .from(...).where(...)
  //   - one:   .from(...).leftJoin(...).where(...).limit(1)
  //   - reach: .from(partnerUsers/organizationUsers).where(...)
  //
  // We model each call by inspecting whether `leftJoin` was used; the
  // helpers ignore everything else.
  let selectCallIdx = 0;
  const reset = () => { selectCallIdx = 0; };
  (globalThis as any).__resetSelectIdx = reset;

  const buildChain = () => {
    let usedLeftJoin = false;
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockImplementation(() => {
        usedLeftJoin = true;
        return chain;
      }),
      where: vi.fn().mockImplementation((..._args: unknown[]) => {
        // For list/one queries, where is followed by orderBy/limit, so return chain.
        // For "membership" lookups (partnerUsers / organizationUsers), the test
        // returns []. We resolve the promise here only when no further chain.
        return chain;
      }),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation((n: number) => {
        if (usedLeftJoin && n === 1) {
          return Promise.resolve(nextRequestRow ? [nextRequestRow] : []);
        }
        if (usedLeftJoin) {
          return {
            offset: vi.fn().mockResolvedValue(pendingListRows),
          };
        }
        return Promise.resolve([]);
      }),
      offset: vi.fn().mockResolvedValue([]),
      then: (resolve: (v: any[]) => void) => {
        // Bare-await on a select that never gets `.limit()` — used by
        // resolveReachableUserIds + pending-count's lightweight scan.
        return Promise.resolve([]).then(resolve);
      },
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => {
        selectCallIdx += 1;
        return buildChain();
      }),
      insert: vi.fn(),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn(async () => (nextUpdatedRow ? [nextUpdatedRow] : [])),
      })),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../db/schema', () => {
  const make = (n: string) => new Proxy({}, { get: () => n });
  return {
    accountDeletionRequests: make('adr'),
    organizationUsers: make('org_users'),
    partners: make('partners'),
    partnerUsers: make('partner_users'),
    roles: make('roles'),
    users: make('users'),
  };
});

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
  getRedis: vi.fn(() => ({})),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock })),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    USERS_WRITE: { resource: 'users', action: 'write' },
  },
}));

let permissionAllowed = true;
let mfaAllowed = true;
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', mockAuth);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!permissionAllowed) return c.json({ error: 'forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!mfaAllowed) return c.json({ error: 'mfa required' }, 401);
    return next();
  }),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'test'),
    writeAuthAudit: (...args: unknown[]) => writeAuthAuditMock(...args),
    resolveUserAuditOrgId: vi.fn(async () => 'o-1'),
  };
});

import { accountDeletionAdminRoutes } from './accountDeletion';

const ADMIN_USER = {
  id: '00000000-0000-0000-0000-000000000099',
  email: 'admin@example.test',
};

const TARGET_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'leaver@example.test',
  name: 'Leaver',
  createdAt: new Date('2025-12-01T00:00:00Z'),
};

const REQUEST_ID = '22222222-2222-2222-2222-222222222222';

function makeRequestRow(overrides: Partial<any> = {}) {
  return {
    request: {
      id: REQUEST_ID,
      userId: TARGET_USER.id,
      orgId: 'o-1',
      reason: 'I want out',
      status: 'pending',
      requestedAt: new Date('2026-05-07T00:00:00Z'),
      processBy: new Date('2026-06-06T00:00:00Z'),
      processedAt: null,
      processedBy: null,
      adminNote: null,
      createdAt: new Date('2026-05-07T00:00:00Z'),
      updatedAt: new Date('2026-05-07T00:00:00Z'),
      ...overrides,
    },
    user: TARGET_USER,
  };
}

describe('admin /admin/account-deletion-requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockClear();
    writeAuthAuditMock.mockClear();
    permissionAllowed = true;
    mfaAllowed = true;
    nextRequestRow = makeRequestRow();
    nextUpdatedRow = undefined;
    pendingListRows = [];
    mockAuth = {
      scope: 'system',
      partnerId: null,
      accessibleOrgIds: [],
      canAccessOrg: () => true,
      user: ADMIN_USER,
      token: { mfa: true },
    };
  });

  it('approve: pending → processing, audits approved, no email', async () => {
    nextUpdatedRow = {
      ...nextRequestRow.request,
      status: 'processing',
      processedAt: new Date('2026-05-08T00:00:00Z'),
      processedBy: ADMIN_USER.id,
    };

    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processing');
    expect(body.processedBy).toBe(ADMIN_USER.id);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuthAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'account.deletion_request.approved',
        result: 'success',
      })
    );
  });

  it('reject: pending → cancelled with adminNote, emails the user, audits rejected', async () => {
    nextUpdatedRow = {
      ...nextRequestRow.request,
      status: 'cancelled',
      processedAt: new Date('2026-05-08T00:00:00Z'),
      processedBy: ADMIN_USER.id,
      adminNote: 'You have an outstanding contract obligation.',
    };

    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          adminNote: 'You have an outstanding contract obligation.',
        }),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('cancelled');
    expect(body.adminNote).toBe('You have an outstanding contract obligation.');

    // Email send is fire-and-forget; allow the microtask queue to drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: TARGET_USER.email,
        subject: expect.stringMatching(/declined/i),
      })
    );
    expect(writeAuthAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'account.deletion_request.rejected',
        result: 'success',
      })
    );
  });

  it('rejects when adminNote missing on reject', async () => {
    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      }
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 if the request is already processed', async () => {
    nextRequestRow = makeRequestRow({ status: 'processing' });
    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }
    );
    expect(res.status).toBe(409);
  });

  it('returns 403 when permission middleware denies the caller', async () => {
    permissionAllowed = false;
    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }
    );
    expect(res.status).toBe(403);
  });

  it('requires MFA on the destructive process endpoint', async () => {
    mfaAllowed = false;
    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}/process`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }
    );
    expect(res.status).toBe(401);
  });

  it('blocks cross-tenant: org-scoped admin who cannot reach target user gets 403', async () => {
    mockAuth = {
      scope: 'organization',
      partnerId: 'p-other',
      // No org accessible — reachable list will be empty.
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      user: ADMIN_USER,
      token: { mfa: true },
    };

    const res = await accountDeletionAdminRoutes.request(
      `/account-deletion-requests/${REQUEST_ID}`,
      { method: 'GET' }
    );
    expect(res.status).toBe(403);
  });
});
