import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// The deploy-key branch itself is replaced: this suite pins WHERE the enroll
// route branches and that the enrollment-secret gate never runs for a deploy
// key, while it still runs for an org key. The branch's behaviour is proven on
// real Postgres in deployKeyEnrollment.integration.test.ts.
const { enrollWithDeployKeyMock, rateLimiterMock } = vi.hoisted(() => ({
  enrollWithDeployKeyMock: vi.fn(),
  rateLimiterMock: vi.fn(),
}));

vi.mock('./enrollmentDeployKey', () => ({ enrollWithDeployKey: enrollWithDeployKeyMock }));

vi.mock('../../db', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEvent: vi.fn(),
}));
vi.mock('../../services/anomalyMetrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/anomalyMetrics')>()),
  recordAgentEnrollment: vi.fn(),
}));
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  getRedis: vi.fn(() => ({})),
}));
vi.mock('../../services/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/rate-limit')>()),
  rateLimiter: rateLimiterMock,
}));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
}));
vi.mock('../../services/enrollmentKeySecurity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/enrollmentKeySecurity')>()),
  hashEnrollmentKeyCandidates: vi.fn((k: string) => [`hashed:${k}`]),
}));

import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import { enrollmentRoutes } from './enrollment';
import { deployKeyStateRefusal, sourceAllowed } from '../../services/deployKeys/enrollmentGate';

const DEPLOY_KEY = `bdk_${'ab'.repeat(32)}`;
const body = (enrollmentKey: string) => ({
  enrollmentKey,
  hostname: 'image-host',
  osType: 'windows',
  osVersion: '11',
  architecture: 'amd64',
  agentVersion: '1.0.0',
});

function app() {
  const a = new Hono();
  a.route('/agents', enrollmentRoutes);
  return a;
}
const post = (payload: unknown) => app().request('/agents/enroll', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiterMock.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
  enrollWithDeployKeyMock.mockImplementation(async (c: any) => c.json({ parked: true }, 201));
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('POST /agents/enroll — deploy-key branch', () => {
  it('hands a bdk_ key to the deploy-key branch with the per-IP limiter\'s address, and never looks up an org key', async () => {
    const res = await post(body(DEPLOY_KEY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ parked: true });
    expect(enrollWithDeployKeyMock).toHaveBeenCalledTimes(1);
    const [, data, options] = enrollWithDeployKeyMock.mock.calls[0]!;
    expect(data.enrollmentKey).toBe(DEPLOY_KEY);
    expect(options).toEqual({ enrollmentIp: '203.0.113.7' });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a malformed bdk_ value still takes the deploy-key branch (refused there), never the org-key lookup', async () => {
    await post(body('bdk_not-hex'));
    expect(enrollWithDeployKeyMock).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('the per-IP rate limit still runs first', async () => {
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, resetAt: new Date(Date.now() + 30_000) });
    const res = await post(body(DEPLOY_KEY));
    expect(res.status).toBe(429);
    expect(enrollWithDeployKeyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['AGENT_ENROLLMENT_SECRET set and no secret sent', { AGENT_ENROLLMENT_SECRET: 'global-secret' }, {}],
    ['AGENT_ENROLLMENT_SECRET set and a wrong secret sent', { AGENT_ENROLLMENT_SECRET: 'global-secret' }, { enrollmentSecret: 'wrong' }],
    ['production with no secret configured (enforce)', { NODE_ENV: 'production' }, {}],
  ])('skips the enrollment-secret gate for a deploy key: %s', async (_label, env, extra) => {
    delete process.env.AGENT_ENROLLMENT_SECRET;
    delete process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE;
    Object.assign(process.env, env);
    const res = await post({ ...body(DEPLOY_KEY), ...extra });
    expect(res.status).toBe(201);
    expect(enrollWithDeployKeyMock).toHaveBeenCalledTimes(1);
    const secretDenials = vi.mocked(writeAuditEvent).mock.calls
      .filter(([, e]) => /enrollment_secret/.test(String((e as { details?: { reason?: string } }).details?.reason)));
    expect(secretDenials).toEqual([]);
  });

  it('still enforces the production secret gate for an org key', async () => {
    delete process.env.AGENT_ENROLLMENT_SECRET;
    delete process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE;
    process.env.NODE_ENV = 'production';
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1', orgId: 'org-1', siteId: 'site-1', keySecretHash: null,
            expiresAt: null, maxUsage: null, usageCount: 0, supportSessionId: null,
          }]),
        })),
      })),
    } as any);
    const res = await post(body('a'.repeat(64)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Enrollment secret required' });
    expect(enrollWithDeployKeyMock).not.toHaveBeenCalled();
  });

  it('still enforces AGENT_ENROLLMENT_SECRET for an org key', async () => {
    process.env.AGENT_ENROLLMENT_SECRET = 'global-secret';
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{
            id: 'key-1', orgId: 'org-1', siteId: 'site-1', keySecretHash: null,
            expiresAt: null, maxUsage: null, usageCount: 0, supportSessionId: null,
          }]),
        })),
      })),
    } as any);
    const res = await post(body('a'.repeat(64)));
    expect(res.status).toBe(403);
    expect(enrollWithDeployKeyMock).not.toHaveBeenCalled();
  });
});

describe('deployKeyStateRefusal', () => {
  const live = { status: 'active', expired: false, usageCount: 0, maxUsage: 5 };
  it.each([
    ['a live key', live, null],
    ['a revoked key (revocation wins over expiry and exhaustion)', { ...live, status: 'revoked', expired: true, usageCount: 5 }, 'deploy_key_revoked'],
    ['an expired key (expiry wins over exhaustion)', { ...live, expired: true, usageCount: 5 }, 'deploy_key_expired'],
    ['an exhausted key', { ...live, usageCount: 5 }, 'deploy_key_exhausted'],
    ['a key one use from its limit', { ...live, usageCount: 4 }, null],
  ])('%s → %s', (_label, key, expected) => {
    expect(deployKeyStateRefusal(key)).toBe(expected);
  });
});

describe('sourceAllowed', () => {
  it.each([
    [null, null, true],
    [null, '198.51.100.1', true],
    [['10.0.0.0/8'], '10.1.2.3', true],
    [['10.0.0.0/8'], '::ffff:10.1.2.3', true],
    [['10.0.0.0/8'], '11.0.0.1', false],
    [['10.0.0.0/8'], null, false],
    [['2001:db8::/32'], '2001:db8::5', true],
    [['2001:db8::/32'], '10.0.0.1', false],
    [['10.0.0.0/8', '192.168.1.0/24'], '192.168.1.20', true],
  ] as const)('cidrs %j, source %s → %s', (cidrs, ip, expected) => {
    expect(sourceAllowed(cidrs as readonly string[] | null, ip)).toBe(expected);
  });
});
