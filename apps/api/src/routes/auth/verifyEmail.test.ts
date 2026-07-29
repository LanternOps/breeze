import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendVerificationEmailMock = vi.fn(async () => undefined);
const sendEmailChangedMock = vi.fn(async () => undefined);
const { runPostCommitCleanupMock } = vi.hoisted(() => ({
  runPostCommitCleanupMock: vi.fn(async () => ({
    redisOk: true,
    permissionCacheOk: true,
    oauthOk: true,
  })),
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    name: 'users.name',
    partnerId: 'users.partnerId',
    emailVerifiedAt: 'users.emailVerifiedAt',
    mfaEnabled: 'users.mfaEnabled',
  },
  partners: { id: 'partners.id', name: 'partners.name', slug: 'partners.slug', plan: 'partners.plan', status: 'partners.status', settings: 'partners.settings' },
  roles: { id: 'roles.id', forceMfa: 'roles.forceMfa' },
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
  createTokenPair: vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', refreshJti: 'jti', expiresInSeconds: 900 })),
  mintRefreshTokenFamily: vi.fn(async () => 'family-id'),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

vi.mock('../../services/pendingRegistration', () => ({
  consumePendingRegistration: vi.fn(async () => null),
  rewritePendingRegistration: vi.fn(async () => undefined),
}));

vi.mock('../../services/partnerCreate', () => ({
  createPartner: vi.fn(async () => ({
    partnerId: 'p-1', orgId: 'o-1', adminUserId: 'u-1', adminRoleId: 'r-1', siteId: 's-1', mcpOrigin: false,
  })),
}));

vi.mock('../../services/mfaPolicy', () => ({
  combineMfaPolicyFacts: vi.fn(() => ({ required: false, allowedMethods: { totp: true, sms: true, passkey: true }, source: {} })),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(async () => null),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
  // requestTransport.ts's effectiveRequestScheme (used by isRequestConnectionSecure
  // when setting auth cookies) checks this unconditionally, unlike the pre-TRANSPORT-001
  // code which only called it when an X-Forwarded-Proto header was present.
  trustsForwardedHeadersFrom: vi.fn(() => false),
}));

vi.mock('../../config/env', () => ({
  isHosted: vi.fn(() => true),
}));

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return { ...actual, ENABLE_REGISTRATION: true, ENABLE_2FA: false };
});

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendVerificationEmail: sendVerificationEmailMock,
    sendEmailChanged: sendEmailChangedMock,
  })),
}));

vi.mock('../../services/authLifecycle', () => ({
  runPostCommitCleanup: runPostCommitCleanupMock,
}));

vi.mock('../../services/emailVerification', () => ({
  consumeVerificationToken: vi.fn(),
  generateVerificationToken: vi.fn(async () => 'fresh-token'),
  invalidateOpenTokens: vi.fn(async () => 0),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'p-1',
      orgId: null,
      user: { id: 'u-1', email: 'admin@acme.test', name: 'Admin' },
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
  };
});

import { verifyEmailRoutes } from './verifyEmail';
import { db } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import {
  consumeVerificationToken,
  generateVerificationToken,
  invalidateOpenTokens,
} from '../../services/emailVerification';
import { consumePendingRegistration } from '../../services/pendingRegistration';
import { dispatchHook } from '../../services/partnerHooks';
import { createPartner } from '../../services/partnerCreate';
import { writeAuthAudit } from './helpers';
import { getEmailService } from '../../services/email';

function updateChain() {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) };
}

const PENDING_RECORD = {
  email: 'new@corp.com',
  companyName: 'Acme',
  name: 'A',
  passwordHash: 'hashed',
  acceptTerms: true,
  termsVersion: 'v1',
  hostedExpectation: true,
  createdAt: Date.now(),
  signupIp: '203.0.113.7',
  signupUserAgent: 'Mozilla/5.0 (signup)',
};

// db.select call order in the pending-registration finalizer: [0] uniqueness
// re-check, [1] partner row, [2] user row, [3] admin-role row.
function primeFinalizeSelects(existingUser: unknown[] = []) {
  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(existingUser) as never)
    .mockReturnValueOnce(selectChain([{ id: 'p-1', name: 'Acme', slug: 'acme', plan: 'free', status: 'pending', settings: {} }]) as never)
    .mockReturnValueOnce(selectChain([{ id: 'u-1', email: 'new@corp.com', name: 'A', mfaEnabled: false }]) as never)
    .mockReturnValueOnce(selectChain([{ forceMfa: false }]) as never);
  vi.mocked(db.update).mockReturnValue(updateChain() as never);
}

/**
 * As `primeFinalizeSelects`, but returns the `set` spy so a test can inspect
 * what was written. NOTE: `db.update` is mocked with a single shared chain, so
 * every UPDATE in the finalizer funnels through ONE `set` mock — assert by
 * searching `set.mock.calls`, never by call index or count. The finalizer always
 * issues two email-verification stamps (users, then partners) before any
 * hook-driven write, so "no settings UPDATE" means "no call carrying settings",
 * not "no calls at all".
 */
function primeFinalizeSelectsWithSetSpy(existingUser: unknown[] = []) {
  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(existingUser) as never)
    .mockReturnValueOnce(selectChain([{ id: 'p-1', name: 'Acme', slug: 'acme', plan: 'free', status: 'pending', settings: {} }]) as never)
    .mockReturnValueOnce(selectChain([{ id: 'u-1', email: 'new@corp.com', name: 'A', mfaEnabled: false }]) as never)
    .mockReturnValueOnce(selectChain([{ forceMfa: false }]) as never);
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return set;
}

/** The UPDATE carrying the inactive-screen banner, if one was issued. */
function findSettingsWrite(set: ReturnType<typeof vi.fn>) {
  return set.mock.calls.map((c) => c[0] as Record<string, unknown>).find((arg) => 'settings' in arg);
}

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

async function postJson(path: string, body: unknown) {
  return verifyEmailRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getRedis).mockReturnValue({} as any);
  });

  it('returns 503 when redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValueOnce(null as any);
    const res = await postJson('/verify-email', { token: 'x' });
    expect(res.status).toBe(503);
  });

  it('returns 429 and audits a denied event when rate-limited', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false } as any);
    const res = await postJson('/verify-email', { token: 'x' });
    expect(res.status).toBe(429);
    expect(consumeVerificationToken).not.toHaveBeenCalled();
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.email_verify_failed', reason: 'rate_limited' })
    );
  });

  it('returns a GENERIC 400 that does not leak the reason when consume fails, but audits the real reason', async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({ ok: false, error: 'expired' });
    const res = await postJson('/verify-email', { token: 'x' });
    expect(res.status).toBe(400);
    const body = await res.json();
    // The public body is uniform — no 'expired' leak.
    expect(body).toEqual({ error: 'Invalid or expired verification link' });
    // ...but the audit still records the precise reason for forensics.
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.email_verify_failed', reason: 'expired' })
    );
  });

  // Enumeration-oracle guard: 'address_changed' vs 'invalid' vs 'email_taken'
  // would tell the holder of a random token whether it existed and how it
  // failed. Every failure reason MUST produce one identical public body.
  it('every failure reason produces one identical public body', async () => {
    for (const reason of [
      'invalid',
      'expired',
      'consumed',
      'superseded',
      'address_changed',
      'no_pending_email',
      'email_taken',
    ] as const) {
      vi.mocked(consumeVerificationToken).mockResolvedValueOnce({ ok: false, error: reason });
      const res = await postJson('/verify-email', { token: 't' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid or expired verification link' });
    }
  });

  it('returns 200 with verified payload on signup success', async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({
      ok: true,
      purpose: 'signup',
      partnerId: 'p-1',
      userId: 'u-1',
      email: 'a@b.com',
      autoActivated: true,
    });

    const res = await postJson('/verify-email', { token: 'good' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      verified: true,
      partnerId: 'p-1',
      email: 'a@b.com',
      autoActivated: true,
    });
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.email_verified', result: 'success', userId: 'u-1' })
    );
    // The signup path does NOT run the sign-out cleanup or completion notice.
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(sendEmailChangedMock).not.toHaveBeenCalled();
  });

  it('email_change success: runs post-commit cleanup, sends completion notice to the OLD address, returns purpose', async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({
      ok: true,
      purpose: 'email_change',
      partnerId: 'p-1',
      userId: 'u-1',
      email: 'new@b.com',
      previousEmail: 'old@b.com',
      autoActivated: false,
    });

    const res = await postJson('/verify-email', { token: 'good' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ verified: true, purpose: 'email_change', email: 'new@b.com' });

    expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-1');
    // Completion notice goes to the OLD (abandoned) address, pending:false.
    expect(sendEmailChangedMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'old@b.com', newEmail: 'new@b.com', pending: false })
    );
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.email.change.committed',
        result: 'success',
        userId: 'u-1',
      })
    );
  });

  it('rejects an empty token via Zod', async () => {
    const res = await postJson('/verify-email', { token: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('POST /verify-email — SR2-21 pending-registration finalization (step 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as never);
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(createPartner).mockResolvedValue({
      partnerId: 'p-1', orgId: 'o-1', adminUserId: 'u-1', adminRoleId: 'r-1', siteId: 's-1', mcpOrigin: false,
    } as never);
  });

  it('a pending-registration token creates the partner with the STEP-1 attribution, not the click IP', async () => {
    vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
    primeFinalizeSelects([]);

    const res = await postJson('/verify-email', { token: 'raw' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    // createPartner receives the STEP-1 IP/UA parked in Redis — never the
    // verification click's IP (a mail scanner would poison the abuse corpus).
    expect(vi.mocked(createPartner)).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { mcp: false, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (signup)' },
      }),
    );
  });

  it('a second click on the same token is a no-op (single-winner GETDEL falls through to generic 400)', async () => {
    vi.mocked(consumePendingRegistration).mockResolvedValueOnce(null);
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({ ok: false, error: 'invalid' });

    const res = await postJson('/verify-email', { token: 'raw' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired verification link' });
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
  });

  it('the address was registered while the link sat in the mailbox: directs the owner to sign in, creates nothing', async () => {
    vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
    // Uniqueness re-check finds a now-existing user.
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ id: 'existing-u' }]) as never);

    const res = await postJson('/verify-email', { token: 'raw' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false, status: 'sign_in' });
    expect(vi.mocked(createPartner)).not.toHaveBeenCalled();
  });

  // Regression cover for the #542 (2026-05-01) fallout: the banner write used to
  // be nested inside `hookStatus !== rowStatus`, so once hosted partners were
  // created `pending` — matching what breeze-billing's hook returns — the
  // "Choose a Plan" CTA stopped being persisted. The inactive screen then fell
  // back to "Your account is being set up. Please check back shortly." with no
  // way to pay, for 144 partners across both regions.
  describe('registration hook banner', () => {
    const HOSTED_HOOK = {
      status: 'pending',
      message: 'Welcome! Choose a plan to get started with Breeze.',
      actionUrl: 'https://us.2breeze.app/billing/plans',
      actionLabel: 'Choose a Plan',
      redirectUrl: '/billing/plans',
    };

    it('persists the banner when the hook AGREES with the status already created', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      const set = primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce(HOSTED_HOOK as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);

      const settingsWrite = findSettingsWrite(set);
      expect(settingsWrite).toBeDefined();
      // Status matched, so the UPDATE must NOT try to change it.
      expect(settingsWrite).not.toHaveProperty('status');
      expect((await res.json()).partner.status).toBe('pending');
    });

    it('applies both the banner and the status when the hook overrides status', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      const set = primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce({ ...HOSTED_HOOK, status: 'active' } as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);

      const settingsWrite = findSettingsWrite(set);
      expect(settingsWrite).toBeDefined();
      expect(settingsWrite!.status).toBe('active');
      // effectiveStatus must reach the client, not the pre-hook row status.
      expect((await res.json()).partner.status).toBe('active');
    });

    it('keeps the banner but ignores an invalid status', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      const set = primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce({ ...HOSTED_HOOK, status: 'bogus' } as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);

      const settingsWrite = findSettingsWrite(set);
      expect(settingsWrite).toBeDefined();
      expect(settingsWrite).not.toHaveProperty('status');
      expect((await res.json()).partner.status).toBe('pending');
    });

    it('drops a javascript: actionUrl but keeps the rest of the banner', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      const set = primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce({
        ...HOSTED_HOOK,
        actionUrl: 'javascript:alert(1)',
      } as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);

      const settingsWrite = findSettingsWrite(set);
      expect(settingsWrite).toBeDefined();
      const payload = JSON.stringify(settingsWrite!.settings);
      expect(payload).not.toContain('javascript:');
      expect(payload).toContain('statusMessage');
    });

    it.each([
      ['//evil.com', 'protocol-relative'],
      ['/\\evil.com', 'backslash normalized to protocol-relative'],
      ['https://evil.com/x', 'absolute'],
      ['/billing /plans', 'embedded control character'],
    ])('drops an unsafe redirectUrl (%s — %s)', async (redirectUrl) => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce({ ...HOSTED_HOOK, redirectUrl } as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('redirectUrl');
    });

    it('passes through a safe single-slash redirectUrl', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce(HOSTED_HOOK as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect((await res.json()).redirectUrl).toBe('/billing/plans');
    });

    it('issues no settings write when the hook returns nothing', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      const set = primeFinalizeSelectsWithSetSpy([]);
      vi.mocked(dispatchHook).mockResolvedValueOnce(null as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);

      // The two email-verification stamps still happen; nothing carries settings.
      expect(findSettingsWrite(set)).toBeUndefined();
      expect(set.mock.calls.length).toBeGreaterThan(0);
    });

    it('still returns 200 with the pre-hook status when the banner UPDATE throws', async () => {
      vi.mocked(consumePendingRegistration).mockResolvedValueOnce({ ...PENDING_RECORD });
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([]) as never)
        .mockReturnValueOnce(selectChain([{ id: 'p-1', name: 'Acme', slug: 'acme', plan: 'free', status: 'pending', settings: {} }]) as never)
        .mockReturnValueOnce(selectChain([{ id: 'u-1', email: 'new@corp.com', name: 'A', mfaEnabled: false }]) as never)
        .mockReturnValueOnce(selectChain([{ forceMfa: false }]) as never);
      // First two updates (the email stamps) succeed; the hook write rejects.
      let call = 0;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            call += 1;
            return call > 2 ? Promise.reject(new Error('boom')) : Promise.resolve(undefined);
          }),
        })),
      } as never);
      vi.mocked(dispatchHook).mockResolvedValueOnce({ ...HOSTED_HOOK, status: 'active' } as never);

      const res = await postJson('/verify-email', { token: 'raw' });
      expect(res.status).toBe(200);
      // The write failed, so effectiveStatus must NOT advance to 'active'.
      expect((await res.json()).partner.status).toBe('pending');
    });
  });
});

describe('POST /resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getRedis).mockReturnValue({} as any);
    sendVerificationEmailMock.mockClear();
  });

  it('returns 400 already_verified when emailVerifiedAt is already set', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: 'u-1',
          email: 'a@b.com',
          name: 'Admin',
          partnerId: 'p-1',
          emailVerifiedAt: new Date(),
        },
      ]) as any
    );

    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'already_verified' });
    expect(generateVerificationToken).not.toHaveBeenCalled();
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('returns 429 with retryAfterSeconds when the per-minute limit is hit', async () => {
    const resetAt = new Date(Date.now() + 30_000);
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt,
    } as any);
    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = await res.json();
    expect(body.window).toBe('minute');
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(generateVerificationToken).not.toHaveBeenCalled();
  });

  it('returns 429 with hour-window retryAfter when the per-hour limit is hit', async () => {
    const minuteResetAt = new Date(Date.now() + 30_000);
    const hourResetAt = new Date(Date.now() + 30 * 60_000);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 0, resetAt: minuteResetAt } as any)
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: hourResetAt } as any);
    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.window).toBe('hour');
    expect(body.retryAfterSeconds).toBeGreaterThan(60);
    expect(generateVerificationToken).not.toHaveBeenCalled();
  });

  it('returns 404 when the user row is missing', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]) as any);
    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(404);
  });

  it('invalidates open tokens, issues a new one, sends the email, and audits success', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: 'u-1',
          email: 'a@b.com',
          name: 'Admin',
          partnerId: 'p-1',
          emailVerifiedAt: null,
        },
      ]) as any
    );

    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sent: true });

    expect(invalidateOpenTokens).toHaveBeenCalledWith('u-1');
    expect(generateVerificationToken).toHaveBeenCalledWith({
      partnerId: 'p-1',
      userId: 'u-1',
      email: 'a@b.com',
    });
    expect(sendVerificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.com',
        name: 'Admin',
        verificationUrl: expect.stringContaining('/auth/verify-email?token=fresh-token'),
      })
    );
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.verification_resent', result: 'success' })
    );
  });

  it('returns 503 when the email service is unconfigured', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: 'u-1',
          email: 'a@b.com',
          name: 'Admin',
          partnerId: 'p-1',
          emailVerifiedAt: null,
        },
      ]) as any
    );
    vi.mocked(getEmailService).mockReturnValueOnce(null as any);

    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(503);
  });

  it('returns 500 when sendVerificationEmail throws', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: 'u-1',
          email: 'a@b.com',
          name: 'Admin',
          partnerId: 'p-1',
          emailVerifiedAt: null,
        },
      ]) as any
    );
    sendVerificationEmailMock.mockRejectedValueOnce(new Error('Resend down'));

    const res = await postJson('/resend-verification', {});
    expect(res.status).toBe(500);
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.verification_resent', result: 'failure' })
    );
  });
});
