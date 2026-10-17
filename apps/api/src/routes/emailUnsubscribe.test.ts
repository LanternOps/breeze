import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setEmailOptOut = vi.hoisted(() => vi.fn());
const rateLimiter = vi.hoisted(() => vi.fn());
const redis = vi.hoisted(() => ({ current: {} as object | null }));
const systemCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock('../services/emailOptouts', async (orig) => ({
  ...(await orig<typeof import('../services/emailOptouts')>()),
  setEmailOptOut: (...a: unknown[]) => setEmailOptOut(...a),
}));
vi.mock('../services/rate-limit', () => ({ rateLimiter: (...a: unknown[]) => rateLimiter(...a) }));
vi.mock('../services/redis', () => ({ getRedis: () => redis.current }));
vi.mock('../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => {
    systemCalls.n += 1;
    return fn();
  },
}));

import { emailUnsubscribeRoutes } from './emailUnsubscribe';
import { signUnsubscribeToken } from '../services/emailUnsubscribeToken';

const USER = '11111111-2222-4333-8444-555555555555';
const app = new Hono().route('/api/v1/email', emailUnsubscribeRoutes);
const url = (t: string) => `/api/v1/email/unsubscribe?t=${encodeURIComponent(t)}`;
const oneClick = (t: string) => app.request(url(t), {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'List-Unsubscribe=One-Click',
});

let token: string;

beforeEach(() => {
  vi.clearAllMocks();
  systemCalls.n = 0;
  vi.stubEnv('APP_ENCRYPTION_KEY', 'route-test-secret-0123456789');
  redis.current = {};
  rateLimiter.mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
  setEmailOptOut.mockResolvedValue({ userExists: true });
  token = signUnsubscribeToken({ userId: USER, topic: 'connection_health_digest' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /email/unsubscribe (confirmation page only)', () => {
  it('renders a POST form for a valid token and never writes', async () => {
    const res = await app.request(url(token));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(html).toContain(`action="/api/v1/email/unsubscribe?t=${encodeURIComponent(token)}"`);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('a bad token gets a 400 page and no write', async () => {
    const res = await app.request(url('forged.token'));
    expect(res.status).toBe(400);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('a missing token gets a 400', async () => {
    const res = await app.request('/api/v1/email/unsubscribe');
    expect(res.status).toBe(400);
  });

  it('sets a strict page CSP whose style hash matches the inline style', async () => {
    const res = await app.request(url(token));
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    const html = await res.text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const hash = createHash('sha256').update(style).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('the token is escaped into the page', async () => {
    // A tampered token never reaches the form, so only a valid one is echoed;
    // assert there is no raw quote or angle bracket in the action value.
    const html = await (await app.request(url(token))).text();
    const action = /action="([^"]*)"/.exec(html)![1]!;
    expect(action).not.toMatch(/[<>"']/);
  });
});

describe('POST /email/unsubscribe (RFC 8058 one-click)', () => {
  it('writes a one_click opt-out in system scope and answers 200', async () => {
    const res = await oneClick(token);
    expect(res.status).toBe(200);
    expect(setEmailOptOut).toHaveBeenCalledWith(USER, 'connection_health_digest', 'one_click');
    expect(systemCalls.n).toBe(1);
  });

  it('is idempotent: a replay answers 200 again', async () => {
    expect((await oneClick(token)).status).toBe(200);
    expect((await oneClick(token)).status).toBe(200);
    expect(setEmailOptOut).toHaveBeenCalledTimes(2);
  });

  it('a deleted user still gets 200 (nothing left to unsubscribe)', async () => {
    setEmailOptOut.mockResolvedValue({ userExists: false });
    expect((await oneClick(token)).status).toBe(200);
  });

  it('works without the One-Click body (some clients post an empty body)', async () => {
    const res = await app.request(url(token), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(setEmailOptOut).toHaveBeenCalledTimes(1);
  });

  it('a forged token is a 400 and writes nothing', async () => {
    const [p] = token.split('.');
    const res = await oneClick(`${p}.AAAA`);
    expect(res.status).toBe(400);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('a token signed under another secret is a 400', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', 'another-secret-entirely-000000');
    expect((await oneClick(token)).status).toBe(400);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('a write failure is a 500, not a silent success', async () => {
    setEmailOptOut.mockRejectedValue(new Error('db down'));
    expect((await oneClick(token)).status).toBe(500);
  });
});

describe('rate limiting (per IP)', () => {
  it('429 when the limiter refuses, before any token work or write', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await oneClick(token);
    expect(res.status).toBe(429);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('limits GET too', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    expect((await app.request(url(token))).status).toBe(429);
  });

  it('uses an email-unsubscribe IP bucket', async () => {
    await oneClick(token);
    expect(rateLimiter).toHaveBeenCalledWith(redis.current, expect.stringMatching(/^email-unsubscribe:/), 30, 60);
  });

  it('503 (not a raw 500) when the limiter itself errors', async () => {
    rateLimiter.mockRejectedValue(new Error('redis multi failed'));
    expect((await oneClick(token)).status).toBe(503);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('503, not "invalid link", when the server has no signing secret', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await oneClick(token)).status).toBe(503);
    expect((await app.request(url(token))).status).toBe(503);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });

  it('503 when Redis is unavailable (fail closed)', async () => {
    redis.current = null;
    expect((await oneClick(token)).status).toBe(503);
    expect(setEmailOptOut).not.toHaveBeenCalled();
  });
});
