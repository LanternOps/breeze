import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// MCP-OAUTH-03: resources/read must map the requested URI to a product
// permission (checkPermissionRequirement — extracted from checkToolPermission
// in aiGuardrails.ts) and enforce it BEFORE any site resolution or DB query.
// These tests exercise the REAL mcpServer route + REAL aiGuardrails
// (checkPermissionRequirement) so the enforcement itself — not a mock of it —
// is what's under test. Only the heavy module-graph leaves get lightweight
// mocks, matching the pattern in mcpServer.effectiveTier.test.ts.

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: vi.fn(async () => ({ id: 'ledger-1' })),
  completeMcpToolExecutionLedger: vi.fn(async () => undefined),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => [],
}));

const dbSelectSpy = vi.fn();

function mockDb(rows: any[]) {
  vi.doMock('../db', () => ({
    db: {
      select: (cols?: any) => {
        dbSelectSpy(cols);
        return {
          from: (_table: any) => ({
            where: (_cond: any) => ({
              limit: (_n: number) => Promise.resolve(rows),
            }),
            limit: (_n: number) => Promise.resolve(rows),
          }),
        };
      },
    },
    withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
    withSystemDbAccessContext: vi.fn((fn: any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  }));
}

// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now calls
// getUserPermissions ONCE via authorizeHumanApiKeyCreator to re-validate the
// API key's coarse 'ai:read' scope (API_KEY_SCOPE_POLICIES['ai:read'] bundles
// devices+alerts+scripts+automations read as a single unit — ALL FOUR are
// required or the whole scope is denied) BEFORE resources/read's own
// fine-grained checkPermissionRequirement runs its OWN, SEPARATE
// getUserPermissions call. This suite exists to test that fine-grained gate
// in isolation (MCP-OAUTH-03), including states like "role lacking
// scripts.read" that are otherwise impossible to reach with a valid 'ai:read'
// key scope. So: the FIRST getUserPermissions call (the coarse ceiling) gets
// a full baseline permission set — the creator genuinely holds 'ai:read' —
// and every SUBSEQUENT call (the fine-grained per-resource check inside
// resources/read) returns the scenario's real `perms`, preserving each
// test's actual premise without loosening any resources/read assertion.
const FULL_AI_READ_BASELINE = [
  { resource: 'devices', action: 'read' },
  { resource: 'alerts', action: 'read' },
  { resource: 'scripts', action: 'read' },
  { resource: 'automations', action: 'read' },
];

function mockPermissions(perms: { resource: string; action: string }[]) {
  vi.doMock('../services/permissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/permissions')>();
    const buildResult = (permissions: { resource: string; action: string }[]) => ({
      permissions,
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    });
    const getUserPermissions = vi.fn(async () => buildResult(perms));
    getUserPermissions.mockResolvedValueOnce(buildResult(FULL_AI_READ_BASELINE));
    return { ...actual, getUserPermissions };
  });
}

function mockApiKey() {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
        name: 'test',
        keyPrefix: 'brz_test',
        scopes: ['ai:read'],
        rateLimit: 1000,
        createdBy: 'user-1',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

async function readResource(uri: string) {
  mockApiKey();
  const mod = await import('./mcpServer');
  return mod.mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri },
    }),
  });
}

beforeEach(() => {
  vi.resetModules();
  dbSelectSpy.mockClear();
});

afterEach(() => {
  vi.doUnmock('../db');
  vi.doUnmock('../services/permissions');
  vi.doUnmock('../middleware/apiKeyAuth');
});

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const CASES: Array<{ uri: string; resource: string }> = [
  { uri: 'breeze://devices', resource: 'devices' },
  { uri: `breeze://devices/${DEVICE_ID}`, resource: 'devices' },
  { uri: 'breeze://alerts', resource: 'alerts' },
  { uri: 'breeze://scripts', resource: 'scripts' },
  { uri: 'breeze://automations', resource: 'automations' },
];

describe('resources/read fail-closed resource RBAC (MCP-OAUTH-03)', () => {
  for (const { uri, resource } of CASES) {
    // First-in-suite module import (fresh mcpServer + full transitive graph)
    // is borderline-slow under load, same as mcpServer.effectiveTier.test.ts —
    // give headroom over the 5s default. Passes in well under 1s in isolation.
    it(`denies ${uri} for a role lacking ${resource}.read and runs NO db query`, async () => {
      mockPermissions([]); // role has no permissions at all
      mockDb([]);

      const res = await readResource(uri);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toContain(`requires ${resource}.read`);
      expect(dbSelectSpy).not.toHaveBeenCalled();
    }, 15_000);

    it(`allows ${uri} for a role holding ${resource}.read`, async () => {
      mockPermissions([{ resource, action: 'read' }]);
      mockDb(
        uri.startsWith('breeze://devices/')
          ? [{ id: DEVICE_ID, orgId: 'org-1', siteId: null, hostname: 'host-a', status: 'online' }]
          : [],
      );

      const res = await readResource(uri);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.error).toBeUndefined();
      expect(dbSelectSpy).toHaveBeenCalled();
    }, 15_000);
  }

  it('denies an unknown resource URI family without a db query, even for a fully-permissioned role', async () => {
    mockPermissions([
      { resource: 'devices', action: 'read' },
      { resource: 'alerts', action: 'read' },
      { resource: 'scripts', action: 'read' },
      { resource: 'automations', action: 'read' },
    ]);
    mockDb([]);

    const res = await readResource('breeze://nonsense');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('Unknown resource URI');
    expect(dbSelectSpy).not.toHaveBeenCalled();
  });
});
