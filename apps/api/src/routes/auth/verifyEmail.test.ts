import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendVerificationEmailMock = vi.fn(async () => undefined);

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
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
  },
  partners: { id: 'partners.id' },
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendVerificationEmail: sendVerificationEmailMock,
  })),
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
import { writeAuthAudit } from './helpers';
import { getEmailService } from '../../services/email';

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

  it('returns 400 with the token error code when consume fails', async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({ ok: false, error: 'expired' });
    const res = await postJson('/verify-email', { token: 'x' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'expired' });
    expect(writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.email_verify_failed', reason: 'expired' })
    );
  });

  it('returns 200 with verified payload on success', async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValueOnce({
      ok: true,
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
  });

  it('rejects an empty token via Zod', async () => {
    const res = await postJson('/verify-email', { token: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
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
