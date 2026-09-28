import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Route-level proof that brokered storage-session traffic is metered apart from
// the agent's general buckets: the REAL agentAuthMiddleware, the REAL
// rateLimiter and the REAL storage-session limiter, over an in-memory
// sorted-set Redis. Only the database and tenant lookups are faked.

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id', agentId: 'agentId', orgId: 'orgId', siteId: 'siteId',
    agentTokenHash: 'agentTokenHash', previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt', watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt', status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt', hostname: 'hostname', lastSeenIp: 'lastSeenIp',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  deviceMtlsCertificates: {
    deviceId: 'deviceMtlsCertificates.deviceId', state: 'deviceMtlsCertificates.state',
    serialNumber: 'deviceMtlsCertificates.serialNumber', createdAt: 'deviceMtlsCertificates.createdAt',
  },
}));

const redisHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services/rate-limit')>('../services/rate-limit');
  return {
    getRedis: vi.fn(() => redisHolder.current),
    rateLimiter: actual.rateLimiter,
  };
});

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn(async () => undefined) }));

vi.mock('../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '203.0.113.5'),
  trustsForwardedHeadersFrom: vi.fn(() => false),
}));

vi.mock('../services/tenantStatus', () => ({ getAgentTenantState: vi.fn(async () => 'active') }));
vi.mock('../services/deviceUninstallDrain', () => ({ isDeviceUninstallDraining: vi.fn(async () => false) }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
  desc: vi.fn((col) => ({ desc: col })),
  ne: vi.fn((left, right) => ({ ne: [left, right] })),
  count: vi.fn(() => ({ count: true })),
}));

// Smallest org budget (the floor), so storage traffic reaching the org bucket
// would starve heartbeats long before the storage ceilings do.
vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return { ...actual, resolveOrgRateLimit: vi.fn(async () => actual.DEFAULT_AGENT_ORG_RATE_LIMIT) };
});

import { createHash } from 'crypto';
import { Hono } from 'hono';
import { db } from '../db';
import { getTrustedClientIp } from '../services/clientIp';
import { SortedSetRedisFake } from '../__tests__/helpers/sortedSetRedisFake';
import { agentAuthMiddleware } from './agentAuth';
import { AGENT_STORAGE_DEVICE_RATE_LIMIT, AGENT_STORAGE_SESSION_RATE_LIMIT } from '../services/agentStorageSessionRateLimit';

const TOKEN = 'brz_storage_rate_token';
const AGENT = 'agent-1';
const SESSIONS = [
  '0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39',
  '1c7a1d8f-4e3b-4a6c-8f2d-9b8e7d6c5b4a',
  '2d8b2e9a-5f4c-4b7d-9a3e-0c9f8e7d6c5b',
];

function mockDeviceLookup() {
  const terminal = { where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{
    id: 'device-1', agentId: AGENT, orgId: 'org-1', siteId: 'site-1', partnerId: 'partner-1',
    agentTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    previousTokenHash: null, previousTokenExpiresAt: null, watchdogTokenHash: null,
    previousWatchdogTokenHash: null, previousWatchdogTokenExpiresAt: null,
    status: 'active', hostname: 'box-1', lastSeenIp: '203.0.113.5',
  }]) }) };
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue(terminal), ...terminal }),
  } as never);
}

function buildApp() {
  const app = new Hono();
  app.use('/api/v1/agents/:id/*', agentAuthMiddleware);
  app.post('/api/v1/agents/:id/heartbeat', (c) => c.json({ ok: true }));
  app.post('/api/v1/agents/:id/storage-sessions/:sessionId/:op', (c) => c.json({ ok: true }));
  app.get('/api/v1/agents/:id/storage-sessions/:sessionId/object', (c) => c.json({ ok: true }));
  return app;
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function storageCall(app: Hono, sessionId: string, op = 'objects:resolve') {
  return app.request(`/api/v1/agents/${AGENT}/storage-sessions/${sessionId}/${op}`, { method: 'POST', headers: auth });
}

async function heartbeat(app: Hono) {
  return app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST', headers: auth });
}

describe('agentAuthMiddleware — storage-session rate accounting', () => {
  let fake: SortedSetRedisFake;

  beforeEach(() => {
    fake = new SortedSetRedisFake();
    redisHolder.current = fake;
    mockDeviceLookup();
  });

  it('1,500 storage-session calls from one agent never make its heartbeat 429', async () => {
    const app = buildApp();
    const statuses = new Map<number, number>();
    let retryAfter: string | null = null;
    for (let i = 0; i < 1500; i += 1) {
      const res = await storageCall(app, SESSIONS[i % SESSIONS.length]!);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status === 429) retryAfter = res.headers.get('Retry-After');
      // Interleave the agent's own traffic the way a live backup does.
      if (i % 100 === 0) expect((await heartbeat(app)).status).toBe(200);
    }
    // The storage ceilings were genuinely saturated…
    expect(statuses.get(200)).toBe(AGENT_STORAGE_DEVICE_RATE_LIMIT);
    expect(statuses.get(429)).toBe(1500 - AGENT_STORAGE_DEVICE_RATE_LIMIT);
    // …and the refusal told the helper to come back when the window rolls, not in a second.
    expect(Number(retryAfter)).toBeGreaterThan(1);
    // …yet the heartbeat is still admitted.
    expect((await heartbeat(app)).status).toBe(200);

    // None of it was charged to the general agent buckets.
    const general = fake.keys().filter((k) => k.startsWith('agent_rate') || k.startsWith('agent_org_rate'));
    for (const key of general) expect(await fake.zcard(key)).toBeLessThanOrEqual(16);
  });

  it('a single saturated session is refused on its own bucket and leaves other agent traffic alone', async () => {
    const app = buildApp();
    let ok = 0;
    for (let i = 0; i < 1000; i += 1) {
      if ((await storageCall(app, SESSIONS[0]!)).status === 200) ok += 1;
    }
    expect(ok).toBe(AGENT_STORAGE_SESSION_RATE_LIMIT);
    expect((await heartbeat(app)).status).toBe(200);
    // A second session of the same device still has room under the device ceiling.
    expect((await storageCall(app, SESSIONS[1]!, 'renew')).status).toBe(200);
    const read = await app.request(`/api/v1/agents/${AGENT}/storage-sessions/${SESSIONS[2]}/object?key=a`, { headers: auth });
    expect(read.status).toBe(200);
  });

  it('refuses a storage-session call for a full window when Redis is unavailable', async () => {
    redisHolder.current = null;
    const res = await storageCall(buildApp(), SESSIONS[0]!);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('heartbeats keep their existing per-(agent, source-IP) limit', async () => {
    const app = buildApp();
    for (let i = 0; i < 30; i += 1) expect((await heartbeat(app)).status).toBe(200);
    const refused = await heartbeat(app);
    expect(refused.status).toBe(429);
  });

  it('a path that is not a core storage-session route stays on the general buckets', async () => {
    const app = new Hono();
    app.use('/api/v1/agents/:id/*', agentAuthMiddleware);
    app.post('/api/v1/agents/:id/storage-sessions/:sessionId/:op/extra', (c) => c.json({ ok: true }));
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await app.request(`/api/v1/agents/${AGENT}/storage-sessions/${SESSIONS[0]}/objects:resolve/extra`, { method: 'POST', headers: auth });
      if (res.status === 429) refused += 1;
    }
    expect(refused).toBe(10);
  });
});

describe('agentAuthMiddleware — a refused agent request does not extend its window', () => {
  const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);

  beforeEach(() => {
    redisHolder.current = new SortedSetRedisFake();
    mockDeviceLookup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.5');
  });

  /**
   * Fill the bucket at T0, then keep retrying for half a window — a full
   * bucket's worth of refused attempts — then wait out the advertised
   * Retry-After of the last refusal: that retry must be admitted.
   */
  async function burstThenHonourRetryAfter(limit: number) {
    const app = buildApp();
    for (let i = 0; i < limit; i += 1) expect((await heartbeat(app)).status).toBe(200);
    const perSecond = Math.ceil(limit / 30);
    let last: Response | null = null;
    for (let t = 1; t <= 30; t += 1) {
      vi.setSystemTime(T0 + t * 1000);
      for (let k = 0; k < perSecond; k += 1) {
        last = await heartbeat(app);
        expect(last.status).toBe(429);
      }
    }
    const retryAfter = Number(last!.headers.get('Retry-After'));
    // The bucket frees when the T0 entries leave the window, 30 s from now.
    expect(retryAfter).toBe(30);
    vi.setSystemTime(T0 + 30_000 + retryAfter * 1000);
    expect((await heartbeat(app)).status).toBe(200);
  }

  it('per-(agent, source-IP) bucket: waiting the advertised Retry-After succeeds after a burst of retries', async () => {
    await burstThenHonourRetryAfter(30);
  });

  it('per-agent bucket: waiting the advertised Retry-After succeeds after a burst of retries', async () => {
    // No trusted source IP: only the per-agent (and org) buckets apply.
    vi.mocked(getTrustedClientIp).mockReturnValue('unknown');
    await burstThenHonourRetryAfter(120);
  });
});
