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
  createTokenPair: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /register-partner setup-admin gate', () => {
  const originalFlag = process.env.MCP_BOOTSTRAP_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MCP_BOOTSTRAP_ENABLED;

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
    if (originalFlag === undefined) delete process.env.MCP_BOOTSTRAP_ENABLED;
    else process.env.MCP_BOOTSTRAP_ENABLED = originalFlag;
  });

  it('returns 403 when MCP_BOOTSTRAP_ENABLED is unset and no setup admin exists', async () => {
    const res = await postRegisterPartner(validBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/setup is not yet complete/i);
    expect(createPartner).not.toHaveBeenCalled();
  });

  it('skips the setup-admin gate and proceeds when MCP_BOOTSTRAP_ENABLED=true', async () => {
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';

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

  it('writes a setup-admin-gate-bypass audit event when MCP_BOOTSTRAP_ENABLED=true', async () => {
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';

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
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';
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
  ])('MCP_BOOTSTRAP_ENABLED=%j → status %i', async (flag, expectedStatus) => {
    process.env.MCP_BOOTSTRAP_ENABLED = flag;
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
