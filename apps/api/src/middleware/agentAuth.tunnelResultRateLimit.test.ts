import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route-level proof (#11464) that the agent's HTTP acknowledgement of a Network
// Proxy `http_request` command is metered apart from the agent's general
// buckets: the REAL agentAuthMiddleware, the REAL rateLimiter and the REAL
// proxy-result limiter, over an in-memory sorted-set Redis. Only the database
// and tenant lookups are faked.
//
// Agents released before #11464 POST every proxied request's result to
// /commands/<http-req-…>/result, a no-op on the server. Charged to the general
// per-(agent, source-IP) and per-agent buckets, one device web UI page load
// spent them and the agent's own heartbeats were refused.

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

vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return { ...actual, resolveOrgRateLimit: vi.fn(async () => actual.DEFAULT_AGENT_ORG_RATE_LIMIT) };
});

import { createHash, randomUUID } from 'crypto';
import { Hono } from 'hono';
import { db, withDbAccessContext } from '../db';
import { SortedSetRedisFake } from '../__tests__/helpers/sortedSetRedisFake';
import { agentAuthMiddleware } from './agentAuth';
import { AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT } from '../services/agentTunnelResultRateLimit';
import { tunnelHttpCommandPrefix } from '../services/tunnelHttpCommandId';

const TOKEN = 'brz_tunnel_result_rate_token';
const AGENT = 'agent-1';
const TUNNEL = '0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39';

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
  app.post('/api/v1/agents/:id/commands/:commandId/result', (c) => c.json({ success: true }));
  app.post('/api/v1/agents/:id/commands/:commandId/result/extra', (c) => c.json({ success: true }));
  return app;
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
// The id the dispatcher mints (routes/tunnelHttpCore.ts dispatchTunnelHttpRequest).
const proxyCommandId = () => `${tunnelHttpCommandPrefix(TUNNEL)}${randomUUID()}`;

async function result(app: Hono, commandId: string, suffix = '') {
  return app.request(`/api/v1/agents/${AGENT}/commands/${commandId}/result${suffix}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'completed' }),
  });
}

async function heartbeat(app: Hono) {
  return app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST', headers: auth });
}

describe('agentAuthMiddleware — Network Proxy result acknowledgements (#11464)', () => {
  let fake: SortedSetRedisFake;

  beforeEach(() => {
    fake = new SortedSetRedisFake();
    redisHolder.current = fake;
    mockDeviceLookup();
  });

  it('a page load worth of proxy result POSTs never makes the agent heartbeat 429 and never touches the general buckets', async () => {
    const app = buildApp();
    for (let i = 0; i < 300; i += 1) {
      expect((await result(app, proxyCommandId())).status).toBe(200);
      if (i % 50 === 0) expect((await heartbeat(app)).status).toBe(200);
    }
    expect((await heartbeat(app)).status).toBe(200);
    const general = fake.keys().filter((k) => k.startsWith('agent_rate') || k.startsWith('agent_org_rate'));
    // Only the interleaved heartbeats were charged there.
    for (const key of general) expect(await fake.zcard(key)).toBeLessThanOrEqual(8);
  });

  it('stays bounded: past its own per-device ceiling it is refused with a real Retry-After, and heartbeats are unaffected', async () => {
    const app = buildApp();
    const statuses = new Map<number, number>();
    let retryAfter: string | null = null;
    for (let i = 0; i < AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT + 25; i += 1) {
      const res = await result(app, proxyCommandId());
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status === 429) retryAfter = res.headers.get('Retry-After');
    }
    expect(statuses.get(200)).toBe(AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT);
    expect(statuses.get(429)).toBe(25);
    expect(Number(retryAfter)).toBeGreaterThan(1);
    expect((await heartbeat(app)).status).toBe(200);
  });

  it('fails closed for a full window when Redis is unavailable', async () => {
    redisHolder.current = null;
    const res = await result(buildApp(), proxyCommandId());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('answers a proxy result outside the request-long DB transaction (the route touches no database for it)', async () => {
    const app = buildApp();
    vi.mocked(withDbAccessContext).mockClear();
    expect((await result(app, proxyCommandId())).status).toBe(200);
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect((await result(app, randomUUID())).status).toBe(200);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a persisted (UUID) command result', () => randomUUID(), ''],
    ['a non-proxy WebSocket command result', () => `mon-${randomUUID()}`, ''],
    ['a proxy-looking id on a path that is not the core result route', proxyCommandId, '/extra'],
  ])('%s stays on the general per-(agent, source-IP) bucket', async (_label, id, suffix) => {
    const app = buildApp();
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      if ((await result(app, id(), suffix)).status === 429) refused += 1;
    }
    expect(refused).toBe(10);
  });
});
