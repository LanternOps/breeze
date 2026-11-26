/**
 * #12690 — extension agent routes through the REAL gateway guard and the REAL
 * agentAuthMiddleware.
 *
 * gateway.test.ts stubs agentAuthMiddleware, and the Workspace extension's own
 * tests stub host auth, so neither can see what path shape actually
 * authenticates. Here only agentAuthMiddleware's storage and service
 * dependencies are faked (the same set agentAuth.negativeCache.test.ts uses for
 * its admitted case), and the device lookup answers ONLY for the enrolled
 * agent ID. That is the discriminating part: a lookup that ignored the ID
 * would let the flat `/agent/crawl-config` authenticate too.
 *
 * The route app mirrors ee/workspace/src/index.ts: the agent surface is
 * mounted under both `/agent/:agentId` and flat `/agent`, so a 401 on the flat
 * shape comes from host auth, not from a missing route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agentId',
    orgId: 'orgId',
    siteId: 'siteId',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt',
    hostname: 'hostname',
    lastSeenIp: 'lastSeenIp',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    type: 'organizations.type',
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('../services/agentStorageSessionRateLimit', () => ({
  checkAgentStorageSessionRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../services/clientIp', () => ({
  rateLimitIpKey: (ip: string) => ip,
  getTrustedClientIp: vi.fn(() => 'unknown'),
}));

vi.mock('../services/tenantStatus', () => ({
  getAgentTenantState: vi.fn(async () => 'active'),
}));

vi.mock('../services/deviceUninstallDrain', () => ({
  isDeviceUninstallDraining: vi.fn(async () => false),
}));

vi.mock('../services/agentCertificateBinding', () => ({
  readAgentCertificateAssertion: vi.fn(() => ({
    assertionTrusted: false,
    assertedVerified: false,
    assertedSerial: null,
  })),
  enforceAgentCertificateBinding: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return {
    ...actual,
    resolveOrgRateLimit: vi.fn(async () => 600),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
}));

// User and helper auth are not under test; any call to them here is a routing
// bug, so they fail loudly instead of admitting.
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async () => {
    throw new Error('user auth must not run on an agent path');
  }),
  hasSatisfiedMfa: vi.fn(() => false),
}));
vi.mock('../middleware/helperAuth', () => ({
  helperAuth: vi.fn(async () => {
    throw new Error('helper auth must not run on an agent path');
  }),
}));
vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(async () => null),
  hasPermission: vi.fn(() => false),
}));

import { createHash } from 'crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

import { db } from '../db';
import { getRedis, rateLimiter } from '../services';
import { agentAuthMiddleware } from '../middleware/agentAuth';
import { __resetAgentAuthNegativeCacheForTests } from '../middleware/agentAuthNegativeCache';
import { ExtensionContributionRegistry } from './contributionRegistry';
import { mountExtensionGateway } from './gateway';

const AGENT_ID = 'a1b2c3d4e5f6';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'brz_workspace_agent_token';

function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function device() {
  return {
    id: DEVICE_ID,
    agentId: AGENT_ID,
    orgId: 'org-1',
    siteId: 'site-1',
    partnerId: 'partner-1',
    agentTokenHash: sha(TOKEN),
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    pendingTokenHash: null,
    pendingWatchdogTokenHash: null,
    pendingTokenExpiresAt: null,
    status: 'online',
    agentTokenSuspendedAt: null,
    hostname: 'box-1',
    lastSeenIp: null,
    organizationType: 'customer',
  };
}

/** Device lookups seen by the fake, by the agent ID the middleware asked for. */
let lookedUpAgentIds: unknown[] = [];

/**
 * The device lookup answers only when the middleware asks for AGENT_ID —
 * `eq(devices.agentId, X)` is faked to `{ left, right: X }`. Set
 * `ignoreAgentId` to prove the flat-path assertions depend on that.
 */
function mockDeviceLookup(options: { ignoreAgentId?: boolean } = {}) {
  vi.mocked(db.select).mockImplementation((() => {
    const terminal = {
      where: vi.fn((condition: { left?: unknown; right?: unknown }) => {
        lookedUpAgentIds.push(condition?.right);
        const found = options.ignoreAgentId || condition?.right === AGENT_ID;
        return { limit: vi.fn().mockResolvedValue(found ? [device()] : []) };
      }),
    };
    return {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue(terminal),
        ...terminal,
      }),
    };
  }) as never);
}

function makeManifest(): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'workspace',
    version: '1.0.0',
    routeNamespace: 'workspace',
    requires: {
      breeze: '>=1.0.0',
      serverSdk: '^1.0.0',
      capabilities: ['server.routes.v1'],
    },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
    publicRoutes: [],
  };
}

const handled = vi.fn();

function agentIdentity(c: Context) {
  const agent = c.get('agent') as { deviceId: string; agentId: string; orgId: string };
  handled(c.req.path);
  return { deviceId: agent.deviceId, agentId: agent.agentId, orgId: agent.orgId };
}

function makeApp(isEnabled: (name: string) => Promise<boolean> = async () => true) {
  // Same dual mount as ee/workspace/src/index.ts.
  const agentApp = new Hono();
  agentApp.get('/crawl-config', (c) => c.json(agentIdentity(c)));
  agentApp.post('/runs', (c) => c.json(agentIdentity(c)));
  agentApp.post('/runs/:runId/batch', (c) => c.json(agentIdentity(c)));
  const routeApp = new Hono();
  routeApp.route('/agent/:agentId', agentApp);
  routeApp.route('/agent', agentApp);
  routeApp.all('/agent/*', (c) => c.json({ error: 'not found' }, 404));

  const registry = new ExtensionContributionRegistry();
  const session = registry.begin(makeManifest());
  session.registrar.mountRoute(routeApp);
  registry.activate(session.finish());

  const app = new Hono();
  mountExtensionGateway(app, registry, isEnabled);
  // The gateway wrapper rethrows; the real middleware throws HTTPException.
  // Render it the way the API's top-level onError does.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: String(err) }, 500);
  });
  return app;
}

function request(app: Hono, method: 'GET' | 'POST', path: string) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

const ROUTES: Array<{ method: 'GET' | 'POST'; action: string }> = [
  { method: 'GET', action: 'crawl-config' },
  { method: 'POST', action: 'runs' },
  { method: 'POST', action: 'runs/run-1/batch' },
];

beforeEach(() => {
  vi.clearAllMocks();
  __resetAgentAuthNegativeCacheForTests();
  lookedUpAgentIds = [];
  vi.mocked(getRedis).mockReturnValue({} as never);
  vi.mocked(rateLimiter).mockResolvedValue({
    allowed: true,
    remaining: 100,
    resetAt: new Date(Date.now() + 60_000),
  } as never);
  mockDeviceLookup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('extension gateway + real agent auth on /api/v1/workspace/agent (#12690)', () => {
  it.each(ROUTES)('authenticates $method /agent/<agentId>/$action as that device', async ({ method, action }) => {
    const app = makeApp();
    const res = await request(app, method, `/api/v1/workspace/agent/${AGENT_ID}/${action}`);

    expect(res.status).toBe(200);
    // Identity comes from the authenticated device row, not from the path.
    expect(await res.json()).toEqual({ deviceId: DEVICE_ID, agentId: AGENT_ID, orgId: 'org-1' });
    expect(lookedUpAgentIds).toEqual([AGENT_ID]);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it.each(ROUTES)('rejects flat $method /agent/$action with the same valid token', async ({ method, action }) => {
    const app = makeApp();
    const res = await request(app, method, `/api/v1/workspace/agent/${action}`);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Invalid agent credentials');
    // The gateway took the first segment after /agent/ as the agent ID.
    expect(lookedUpAgentIds).toEqual([action.split('/')[0]]);
    expect(handled).not.toHaveBeenCalled();
  });

  it('control: a device lookup that ignored the agent ID would admit the flat path', async () => {
    // Proves the flat-path 401s above come from the ID-keyed lookup, not from
    // routing or the token: with the ID ignored, the same request is admitted.
    mockDeviceLookup({ ignoreAgentId: true });
    const app = makeApp();
    const res = await request(app, 'GET', '/api/v1/workspace/agent/crawl-config');

    expect(res.status).toBe(200);
    expect(lookedUpAgentIds).toEqual(['crawl-config']);
  });

  it('still authenticates before answering 503 when the extension is disabled', async () => {
    const isEnabled = vi.fn(async () => false);
    const app = makeApp(isEnabled);

    const res = await request(app, 'GET', `/api/v1/workspace/agent/${AGENT_ID}/crawl-config`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'extension unavailable' });
    // #12713: agents back off on this hint instead of asking again each minute.
    expect(res.headers.get('Retry-After')).toBe('1800');
    expect(lookedUpAgentIds).toEqual([AGENT_ID]);
    expect(isEnabled).toHaveBeenCalledWith('workspace');
    expect(handled).not.toHaveBeenCalled();

    // An unknown agent never reaches the enabled check.
    isEnabled.mockClear();
    const flat = await request(app, 'GET', '/api/v1/workspace/agent/crawl-config');
    expect(flat.status).toBe(401);
    expect(flat.headers.get('Retry-After')).toBeNull();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('routes through the real middleware, not a stub', () => {
    // Guard against a future vi.mock of ../middleware/agentAuth in this file.
    expect(vi.isMockFunction(agentAuthMiddleware)).toBe(false);
  });
});
