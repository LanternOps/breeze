import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbContextState = vi.hoisted(() => ({ active: false }));
const emailMocks = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));

async function runTrackedDbContext<T>(fn: () => Promise<T>): Promise<T> {
  const previous = dbContextState.active;
  dbContextState.active = true;
  try {
    return await fn();
  } finally {
    dbContextState.active = previous;
  }
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
  withSystemDbAccessContext: vi.fn(runTrackedDbContext),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'users.id', email: 'users.email', name: 'users.name', mfaEnabled: 'users.mfaEnabled', setupCompletedAt: 'users.setupCompletedAt' },
  partners: { id: 'partners.id', name: 'partners.name', slug: 'partners.slug', plan: 'partners.plan', status: 'partners.status', settings: 'partners.settings' },
  partnerUsers: { userId: 'partnerUsers.userId' },
}));

vi.mock('../../services', () => ({
  AuthBindingRotationRequiredError: class AuthBindingRotationRequiredError extends Error {
    constructor(readonly replacement: { kind: 'browser'; value: string }) { super(); }
  },
  AuthBindingUnavailableError: class AuthBindingUnavailableError extends Error {},
  AuthIssuanceCapabilityError: class AuthIssuanceCapabilityError extends Error {},
  AuthIssuanceConflictError: class AuthIssuanceConflictError extends Error {},
  beginAuthIssuance: vi.fn(async () => ({
    transitionId: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 120_000),
  })),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: object) => Promise<unknown>) => {
    const { db } = await import('../../db');
    return callback(db);
  }),
  cancelAuthIssuance: vi.fn(async () => true),
  bindIssuedUserSession: vi.fn(async () => undefined),
  hashPassword: vi.fn(async () => 'hashed'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  issueUserSession: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', refreshJti: 'jti-mock', expiresInSeconds: 900, familyId: 'family-id-mock' })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/partnerCreate', () => ({
  createPartner: vi.fn(),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(async () => null),
}));

vi.mock('../../services/partnerActivation', () => ({
  activatePendingPartnerAndInvalidateSessions: vi.fn(async () => ({
    activated: true,
    userIds: ['u-1'],
  })),
  applyRegistrationHookStatusTransition: vi.fn(async () => ({ applied: true })),
}));

vi.mock('../../services/authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: vi.fn(
    async (fn: (tx: object) => Promise<unknown>) => fn({ scope: 'system-tx' }),
  ),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../services/emailVerification', () => ({
  generateVerificationToken: vi.fn(async () => 'verify-token'),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendVerificationEmail: emailMocks.sendVerificationEmail,
  })),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    runWithSystemDbAccess: vi.fn(runTrackedDbContext),
    setRefreshTokenCookie: vi.fn(),
    toPublicTokens: vi.fn((t: { accessToken: string; expiresInSeconds: number }) => ({
      accessToken: t.accessToken,
      expiresInSeconds: t.expiresInSeconds,
    })),
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    getCookieValue: vi.fn(() => 'a'.repeat(64)),
    rotateCsrfBindingCookie: vi.fn(),
    registrationDisabledResponse: vi.fn((c: { json: (b: unknown, s: number) => unknown }) =>
      c.json({ error: 'Registration disabled' }, 403),
    ),
  };
});

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return {
    ...actual,
    ENABLE_REGISTRATION: true,
    ENABLE_2FA: false,
  };
});

import { registerRoutes } from './register';
import { db } from '../../db';
import { createPartner } from '../../services/partnerCreate';
import { writeAuditEvent } from '../../services/auditEvents';
import { createAuditLog } from '../../services/auditService';
import { captureException } from '../../services/sentry';
import { dispatchHook } from '../../services/partnerHooks';
import {
  beginAuthIssuance,
  finishAuthIssuance,
  issueUserSession,
  bindIssuedUserSession,
  hashPassword,
} from '../../services';
import { activatePendingPartnerAndInvalidateSessions } from '../../services/partnerActivation';
import { setRefreshTokenCookie } from './helpers';
import { generateVerificationToken } from '../../services/emailVerification';

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

const validBody = {
  companyName: 'Acme Co',
  email: 'admin@acme.test',
  password: 'Sup3rSecure!',
  name: 'Admin User',
  acceptTerms: true,
};

async function postRegisterPartner(body: unknown) {
  return registerRoutes.request('/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `breeze_csrf_token=${'a'.repeat(64)}` },
    body: JSON.stringify(body),
  });
}

describe('/register-partner durable issuance ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    vi.mocked(createPartner).mockResolvedValue({
      partnerId: 'p-1',
      orgId: 'o-1',
      adminUserId: 'u-1',
      adminRoleId: 'r-1',
      siteId: 's-1',
      mcpOrigin: false,
    });
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);
  });

  it('makes no account, family, cookie, success-audit, email, or hook write when logout wins finalization', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new Error('logout pending'));

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBe(500);
    expect(beginAuthIssuance).toHaveBeenCalledOnce();
    expect(finishAuthIssuance).toHaveBeenCalledOnce();
    expect(createPartner).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(bindIssuedUserSession).not.toHaveBeenCalled();
    expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(dispatchHook).not.toHaveBeenCalled();
  });

  it('does not hold a database context across hashing, token delivery, or webhook I/O', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'free', status: 'pending',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);

    const observed: Array<[string, boolean]> = [];
    vi.mocked(hashPassword).mockImplementationOnce(async () => {
      observed.push(['hash', dbContextState.active]);
      return 'hashed';
    });
    vi.mocked(generateVerificationToken).mockImplementationOnce(async () => {
      observed.push(['verification-token', dbContextState.active]);
      return 'verify-token';
    });
    emailMocks.sendVerificationEmail.mockImplementationOnce(async () => {
      observed.push(['email-send', dbContextState.active]);
    });
    vi.mocked(dispatchHook).mockImplementationOnce(async () => {
      observed.push(['webhook', dbContextState.active]);
      return null;
    });

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBe(200);
    expect(observed).toEqual([
      ['hash', false],
      ['verification-token', false],
      ['email-send', false],
      ['webhook', false],
    ]);
  });
});

describe('/register-partner partner status by deployment mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IS_HOSTED;

    vi.mocked(createPartner).mockResolvedValue({
      partnerId: 'p-1',
      orgId: 'o-1',
      adminUserId: 'u-1',
      adminRoleId: 'r-1',
      siteId: 's-1',
      mcpOrigin: false,
    });

    // Hosted path: skip gate (IS_HOSTED=true), no dup user, then partner+user rows
    // Non-hosted path: setup admin exists, no dup user, then partner+user rows
  });

  function setupDbSelectsForSuccess(isHostedMode: boolean) {
    if (isHostedMode) {
      // gate skipped; user-existence check + post-create partner + post-create user
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'free', status: 'pending',
        }]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
        }]) as any);
    } else {
      // setup-admin check returns admin, user-existence empty, partner+user rows
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([{ setupCompletedAt: new Date() }]) as any)
        .mockReturnValueOnce(selectChain([]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'free', status: 'active',
        }]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
        }]) as any);
    }
  }

  it('creates partner with status=pending when IS_HOSTED=true', async () => {
    process.env.IS_HOSTED = 'true';
    setupDbSelectsForSuccess(true);

    const res = await postRegisterPartner(validBody);
    expect(res.status).toBeLessThan(400);
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({ tx: db }),
    );
  });

  it('creates partner with status=active when IS_HOSTED is unset', async () => {
    // IS_HOSTED already deleted in beforeEach
    setupDbSelectsForSuccess(false);

    const res = await postRegisterPartner(validBody);
    expect(res.status).toBeLessThan(400);
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      expect.objectContaining({ tx: db }),
    );
  });
});

describe('/register-partner hook activation session rotation', () => {
  const originalFlag = process.env.IS_HOSTED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    vi.mocked(createPartner).mockResolvedValue({
      partnerId: 'p-1',
      orgId: 'o-1',
      adminUserId: 'u-1',
      adminRoleId: 'r-1',
      siteId: 's-1',
      mcpOrigin: false,
    });
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'starter', status: 'pending',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);
    vi.mocked(issueUserSession).mockReset();
    vi.mocked(issueUserSession)
      .mockResolvedValueOnce({
        accessToken: 'pre-hook-access',
        refreshToken: 'pre-hook-refresh',
        refreshJti: 'pre-hook-jti',
        expiresInSeconds: 900,
        familyId: 'pre-hook-family',
      })
      .mockResolvedValueOnce({
        accessToken: 'post-hook-access',
        refreshToken: 'post-hook-refresh',
        refreshJti: 'post-hook-jti',
        expiresInSeconds: 900,
        familyId: 'post-hook-family',
      });
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalFlag;
  });

  it('atomically activates, revokes the pre-hook family, and returns a fresh session', async () => {
    vi.mocked(dispatchHook).mockResolvedValueOnce({
      status: 'active',
      message: 'Ready',
      actionUrl: '/welcome',
      actionLabel: 'Continue',
    });

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBe(200);
    expect(activatePendingPartnerAndInvalidateSessions).toHaveBeenCalledWith(
      db,
      'p-1',
      expect.any(Date),
      {
        message: 'Ready',
        actionUrl: '/welcome',
        actionLabel: 'Continue',
      },
    );
    expect(db.update).not.toHaveBeenCalled();
    expect(issueUserSession).toHaveBeenCalledTimes(2);
    expect(issueUserSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mfa: false, amr: ['password'] }),
      expect.objectContaining({ tx: db }),
    );
    expect(issueUserSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mfa: false, amr: ['password'] }),
      expect.objectContaining({ tx: db }),
    );
    expect(
      vi.mocked(activatePendingPartnerAndInvalidateSessions).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(issueUserSession).mock.invocationCallOrder[1]!);
    expect(setRefreshTokenCookie).toHaveBeenCalledTimes(1);
    expect(setRefreshTokenCookie).toHaveBeenCalledWith(expect.anything(), 'post-hook-refresh');
    expect(await res.json()).toMatchObject({
      partner: { status: 'active' },
      tokens: { accessToken: 'post-hook-access' },
    });
  });

  it('rolls back activation failure and issues no fresh post-activation session', async () => {
    vi.mocked(dispatchHook).mockResolvedValueOnce({ status: 'active' });
    vi.mocked(activatePendingPartnerAndInvalidateSessions)
      .mockRejectedValueOnce(new Error('family invalidation failed'));

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBe(500);
    expect(issueUserSession).toHaveBeenCalledTimes(1);
    expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: 'Registration failed. Please try again.' });
  });

  it('keeps a pending hook on the original session without activation or rotation', async () => {
    vi.mocked(dispatchHook).mockResolvedValueOnce({
      status: 'pending',
      message: 'Finish verification',
    });

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBe(200);
    expect(activatePendingPartnerAndInvalidateSessions).not.toHaveBeenCalled();
    expect(issueUserSession).toHaveBeenCalledTimes(1);
    expect(setRefreshTokenCookie).toHaveBeenCalledTimes(1);
    expect(setRefreshTokenCookie).toHaveBeenCalledWith(expect.anything(), 'pre-hook-refresh');
    expect(await res.json()).toMatchObject({
      partner: { status: 'pending' },
      tokens: { accessToken: 'pre-hook-access' },
    });
  });
});

describe('POST /register-partner setup-admin gate', () => {
  const originalFlag = process.env.IS_HOSTED;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IS_HOSTED;

    vi.mocked(createPartner).mockResolvedValue({
      partnerId: 'p-1',
      orgId: 'o-1',
      adminUserId: 'u-1',
      adminRoleId: 'r-1',
      siteId: 's-1',
      mcpOrigin: false,
    });

    // Default: setup-admin lookup returns no admin; user-existence check returns empty.
    // Both are SELECT chains and the route hits them in order. selectChain returns
    // an empty array on .limit() so both lookups behave the same way.
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalFlag;
  });

  it('returns 403 when IS_HOSTED is unset and no setup admin exists', async () => {
    const res = await postRegisterPartner(validBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/setup is not yet complete/i);
    expect(createPartner).not.toHaveBeenCalled();
  });

  it('skips the setup-admin gate and proceeds when IS_HOSTED=true', async () => {
    process.env.IS_HOSTED = 'true';

    // After the gate is skipped, the route runs the user-existence SELECT and
    // then the post-create SELECTs for partner + user. Stage three responses:
    //  1. user-existence -> empty (no dup)
    //  2. partner row after create
    //  3. user row after create
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'starter', status: 'active',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);

    const res = await postRegisterPartner(validBody);
    expect(res.status).toBe(200);
    expect(createPartner).toHaveBeenCalledOnce();
  });

  it('writes a setup-admin-gate-bypass audit event when IS_HOSTED=true', async () => {
    process.env.IS_HOSTED = 'true';

    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'starter', status: 'active',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);

    await postRegisterPartner(validBody);
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith({
      orgId: null,
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000000',
      action: 'register-partner.setup-admin-gate-bypass',
      resourceType: 'partner',
      details: {
        email: 'admin@acme.test',
        companyName: 'Acme Co',
        reason: 'mcp-bootstrap-enabled',
      },
      ipAddress: '127.0.0.1',
      userAgent: undefined,
      result: 'success',
    });
  });

  it('does NOT write the bypass audit event when the gate is enforced', async () => {
    await postRegisterPartner(validBody);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('proceeds with signup when the bypass audit-log write fails', async () => {
    process.env.IS_HOSTED = 'true';
    const auditErr = new Error('audit DB unreachable');
    vi.mocked(createAuditLog).mockRejectedValueOnce(auditErr);

    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'starter', status: 'active',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);

    const res = await postRegisterPartner(validBody);
    expect(res.status).toBe(200);
    expect(createPartner).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(auditErr, expect.anything());
  });

  // Truthy-parsing matrix per envFlag(): '1' | 'true' | 'yes' | 'on'
  // (case-insensitive) bypass the gate; anything else enforces it. A
  // regression where 'False' or 'no' bypasses would silently open
  // registration in self-hosted production. Locks the contract at this layer
  // so swapping envFlag's parser triggers a test failure here, not a CVE.
  it.each([
    // bypass (200)
    ['1', 200],
    ['true', 200],
    ['TRUE', 200],
    ['yes', 200],
    ['on', 200],
    // enforce (403)
    ['false', 403],
    ['0', 403],
    ['no', 403],
    ['off', 403],
    ['', 403],
    ['random', 403],
  ])('IS_HOSTED=%j → status %i', async (flag, expectedStatus) => {
    process.env.IS_HOSTED = flag;
    if (expectedStatus === 200) {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'starter', status: 'active',
        }]) as any)
        .mockReturnValueOnce(selectChain([{
          id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
        }]) as any);
    }
    const res = await postRegisterPartner(validBody);
    expect(res.status).toBe(expectedStatus);
  });
});
