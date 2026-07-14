import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'users.id', email: 'users.email', name: 'users.name', mfaEnabled: 'users.mfaEnabled', setupCompletedAt: 'users.setupCompletedAt' },
  partners: { id: 'partners.id', name: 'partners.name', slug: 'partners.slug', plan: 'partners.plan', status: 'partners.status', settings: 'partners.settings' },
  partnerUsers: { userId: 'partnerUsers.userId' },
}));

vi.mock('../../services', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  createTokenPair: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', refreshJti: 'jti-mock', expiresInSeconds: 900 })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
  // Task 7 follow-up: shared family-mint helper. /register-partner now mints
  // a fresh family for its auto-login, matching every other authenticated
  // token-mint path.
  mintRefreshTokenFamily: vi.fn(async () => 'family-id-mock'),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

vi.mock('../../services/partnerCreate', () => ({
  createPartner: vi.fn(),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(async () => null),
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
    sendVerificationEmail: vi.fn(async () => undefined),
  })),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    runWithSystemDbAccess: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    setRefreshTokenCookie: vi.fn(),
    toPublicTokens: vi.fn((t: { accessToken: string; expiresInSeconds: number }) => ({
      accessToken: t.accessToken,
      expiresInSeconds: t.expiresInSeconds,
    })),
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    registrationDisabledResponse: vi.fn((c: { json: (b: unknown, s: number) => unknown }) =>
      c.json({ error: 'Registration disabled' }, 403),
    ),
  };
});

// ENABLE_2FA is a module-level const in the real schemas module; hoist it into
// mutable state so the MFA-assurance suite below can exercise the 2FA-on path
// without a second test file. Everything else keeps the historical `false`.
const schemaState = vi.hoisted(() => ({ enable2fa: false }));

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return {
    ...actual,
    ENABLE_REGISTRATION: true,
    get ENABLE_2FA() {
      return schemaState.enable2fa;
    },
  };
});

// Effective MFA policy (PR2's resolver). /register-partner auto-logs the new
// partner admin in, so it is a token-mint site and must not hand out a vacuous
// mfa=true when policy requires a factor the brand-new user does not have.
const policyState = vi.hoisted(() => ({ required: false }));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(async () => ({
    required: policyState.required,
    allowedMethods: { totp: true, sms: true, passkey: true },
    source: {
      roleForceMfa: policyState.required,
      settingsRequireMfa: false,
      killSwitchOff: false,
    },
  })),
}));

import { registerRoutes } from './register';
import { db } from '../../db';
import { createTokenPair } from '../../services';
import { createPartner } from '../../services/partnerCreate';
import { writeAuditEvent } from '../../services/auditEvents';
import { createAuditLog } from '../../services/auditService';
import { captureException } from '../../services/sentry';

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

function postRegisterPartner(body: unknown, headers: Record<string, string> = {}) {
  return registerRoutes.request('/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

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
    );
  });

  it('creates partner with status=active when IS_HOSTED is unset', async () => {
    // IS_HOSTED already deleted in beforeEach
    setupDbSelectsForSuccess(false);

    const res = await postRegisterPartner(validBody);
    expect(res.status).toBeLessThan(400);
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('threads signup IP and user agent into createPartner', async () => {
    process.env.IS_HOSTED = 'true';
    setupDbSelectsForSuccess(true);

    const res = await postRegisterPartner(validBody, { 'user-agent': 'vitest-agent/1.0' });
    expect(res.status).toBeLessThan(400);
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { mcp: false, ip: '127.0.0.1', userAgent: 'vitest-agent/1.0' },
      }),
    );
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

// PR3 carry-forward (sweep): /register-partner auto-logs the brand-new partner
// admin in, and computed `mfaSatisfied = !(ENABLE_2FA && newUser.mfaEnabled)`.
// A just-created user NEVER has a factor, so that expression is a constant
// `true` — a vacuous MFA claim on a real, refreshable session. If the new
// admin's role carries force_mfa (the seeded "Partner Admin" posture) or the
// partner is created under a requireMfa policy, that token satisfies every
// hasSatisfiedMfa() gate without a second factor ever existing. Resolve the
// effective policy instead, exactly like /login and the CF-Access mint sites.
describe('POST /register-partner — MFA assurance (no vacuous mfa=true)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true';
    schemaState.enable2fa = true;
    policyState.required = false;

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
        id: 'p-1', name: 'Acme Co', slug: 'acme-co', plan: 'free', status: 'pending',
      }]) as any)
      .mockReturnValueOnce(selectChain([{
        id: 'u-1', email: 'admin@acme.test', name: 'Admin User', mfaEnabled: false,
      }]) as any);
  });

  afterEach(() => {
    schemaState.enable2fa = false;
    policyState.required = false;
    delete process.env.IS_HOSTED;
  });

  it('mints mfa=false and flags enrollment when the new admin is under a required policy', async () => {
    policyState.required = true;

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBeLessThan(400);
    expect(vi.mocked(createTokenPair)).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'u-1', mfa: false }),
      expect.anything(),
    );
    const body = await res.json();
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(body.enrollUrl).toBe('/auth/mfa/setup');
  });

  it('mints mfa=true when no policy requires MFA', async () => {
    policyState.required = false;

    const res = await postRegisterPartner(validBody);

    expect(res.status).toBeLessThan(400);
    expect(vi.mocked(createTokenPair)).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'u-1', mfa: true }),
      expect.anything(),
    );
    const body = await res.json();
    expect(body.mfaEnrollmentRequired).toBe(false);
  });
});
