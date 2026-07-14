import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'users.id', email: 'users.email', name: 'users.name', mfaEnabled: 'users.mfaEnabled', setupCompletedAt: 'users.setupCompletedAt' },
  partnerUsers: { userId: 'partnerUsers.userId' },
}));

vi.mock('../../services', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
  // register.ts no longer imports these token-mint helpers (the mint moved to
  // verifyEmail step 2). They are mocked only so the SR2-21 suite can assert
  // they are NEVER called from the request.
  createTokenPair: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', refreshJti: 'jti', expiresInSeconds: 900 })),
  mintRefreshTokenFamily: vi.fn(async () => 'family-id'),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

vi.mock('../../services/partnerCreate', () => ({
  createPartner: vi.fn(),
}));

vi.mock('../../services/pendingRegistration', () => ({
  createPendingRegistration: vi.fn(async () => ({ rawToken: 'raw-token', tokenHash: 'f'.repeat(64) })),
}));

vi.mock('../../services/authEmailQueue', () => ({
  enqueueRegistrationVerification: vi.fn(async () => undefined),
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
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    registrationDisabledResponse: vi.fn((c: { json: (b: unknown, s: number) => unknown }) =>
      c.json({ error: 'Registration disabled' }, 404),
    ),
  };
});

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return {
    ...actual,
    ENABLE_REGISTRATION: true,
  };
});

import { registerRoutes } from './register';
import { db } from '../../db';
import { createTokenPair, mintRefreshTokenFamily, getRedis } from '../../services';
import { createPartner } from '../../services/partnerCreate';
import { createPendingRegistration } from '../../services/pendingRegistration';
import { enqueueRegistrationVerification } from '../../services/authEmailQueue';
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

const VALID_BODY = {
  companyName: 'Acme Co',
  email: 'new@corp.com',
  password: 'Sup3rSecure!',
  name: 'Admin User',
  acceptTerms: true,
};

function postRegisterPartner(body: unknown, headers: Record<string, string> = {}) {
  return registerRoutes.request('/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest/1.0', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /register-partner — SR2-21: email-first, no account created before verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IS_HOSTED = 'true'; // hosted mode: the setup-admin gate is skipped (no db.select)
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(createPendingRegistration).mockResolvedValue({ rawToken: 'raw-token', tokenHash: 'f'.repeat(64) });
  });

  afterEach(() => {
    delete process.env.IS_HOSTED;
  });

  it('creates NO partner, NO user, NO tokens, and sets NO cookie', async () => {
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.',
    });
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
    expect(vi.mocked(createTokenPair)).not.toHaveBeenCalled();
    expect(vi.mocked(mintRefreshTokenFamily)).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('performs NO user-existence lookup (that lookup WAS the oracle)', async () => {
    await postRegisterPartner(VALID_BODY);
    // db.select is still used by the SELF-HOSTED setup gate. In hosted mode
    // (isHosted() -> true, the mode this suite runs) there must be ZERO selects.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('returns the byte-identical body whether or not the address has an account', async () => {
    const a = await postRegisterPartner({ ...VALID_BODY, email: 'brand-new@corp.com' });
    const b = await postRegisterPartner({ ...VALID_BODY, email: 'already-registered@corp.com' });
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('stores the step-1 attribution (trusted IP + UA) in the pending record', async () => {
    await postRegisterPartner(VALID_BODY);
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@corp.com',
        passwordHash: 'hashed',
        signupIp: '127.0.0.1', // from the mocked getTrustedClientIpOrUndefined
        signupUserAgent: expect.any(String),
      }),
    );
  });

  it('enqueues the verification job with the token HASH, never the raw token', async () => {
    await postRegisterPartner(VALID_BODY);
    const [arg] = vi.mocked(enqueueRegistrationVerification).mock.calls[0]!;
    expect(arg).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Redis down: the generic 503 and NO pending record', async () => {
    vi.mocked(getRedis).mockReturnValueOnce(null as never);
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(503);
    expect(vi.mocked(createPendingRegistration)).not.toHaveBeenCalled();
  });
});

describe('POST /register-partner setup-admin gate (still enforced pre-park)', () => {
  const originalFlag = process.env.IS_HOSTED;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IS_HOSTED;
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(createPendingRegistration).mockResolvedValue({ rawToken: 'raw-token', tokenHash: 'f'.repeat(64) });
    // Default self-hosted lookup returns no setup admin.
    vi.mocked(db.select).mockReturnValue(selectChain([]) as never);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalFlag;
  });

  it('returns 403 and parks NOTHING when IS_HOSTED is unset and no setup admin exists', async () => {
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/setup is not yet complete/i);
    expect(vi.mocked(createPendingRegistration)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueRegistrationVerification)).not.toHaveBeenCalled();
  });

  it('proceeds to park when a setup admin exists (self-hosted)', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{ setupCompletedAt: new Date() }]) as never);
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(200);
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledOnce();
    // Self-hosted parks with hostedExpectation=false.
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledWith(
      expect.objectContaining({ hostedExpectation: false }),
    );
  });

  it('skips the gate and writes a bypass audit when IS_HOSTED=true (no db.select)', async () => {
    process.env.IS_HOSTED = 'true';
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(200);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register-partner.setup-admin-gate-bypass' }),
    );
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledWith(
      expect.objectContaining({ hostedExpectation: true }),
    );
  });

  it('does NOT write the bypass audit when the gate is enforced (self-hosted)', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{ setupCompletedAt: new Date() }]) as never);
    await postRegisterPartner(VALID_BODY);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('proceeds with signup when the bypass audit-log write fails (IS_HOSTED=true)', async () => {
    process.env.IS_HOSTED = 'true';
    const auditErr = new Error('audit DB unreachable');
    vi.mocked(createAuditLog).mockRejectedValueOnce(auditErr);
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(200);
    expect(vi.mocked(createPendingRegistration)).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(auditErr, expect.anything());
  });

  // Truthy-parsing matrix per envFlag(): '1' | 'true' | 'yes' | 'on'
  // (case-insensitive) bypass the gate; anything else enforces it.
  it.each([
    ['1', 200],
    ['true', 200],
    ['TRUE', 200],
    ['yes', 200],
    ['on', 200],
    ['false', 403],
    ['0', 403],
    ['no', 403],
    ['off', 403],
    ['', 403],
    ['random', 403],
  ])('IS_HOSTED=%j → status %i', async (flag, expectedStatus) => {
    process.env.IS_HOSTED = flag as string;
    const res = await postRegisterPartner(VALID_BODY);
    expect(res.status).toBe(expectedStatus);
  });
});
