import { describe, expect, it, vi, beforeEach } from 'vitest';

// MCP-OAUTH-03: resources/read must map the requested URI to a product
// permission (checkPermissionRequirement — extracted from checkToolPermission
// in aiGuardrails.ts) and enforce it BEFORE any site resolution or DB query.
// These tests exercise the REAL mcpServer route + REAL aiGuardrails
// (checkPermissionRequirement) so the enforcement itself — not a mock of it —
// is what's under test. Only the heavy module-graph leaves get lightweight
// mocks, matching the pattern in mcpServer.effectiveTier.test.ts.

const testState = vi.hoisted(() => ({
  scopes: ['ai:read'] as string[],
  permissions: [] as Array<{ resource: string; action: string }>,
  dbRows: [] as any[],
}));

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
  // SR2-15: getUserPermissions is called TWICE per resources/read request —
  // see the FULL_AI_READ_BASELINE comment below — so this needs to be a real
  // vi.fn() that mockPermissions() reprograms per-call, not a plain
  // testState-backed return.
  getUserPermissions: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: (...args: any[]) => mocks.dbSelect(...args) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', async () => {
  const { boolean, jsonb, pgTable, text, timestamp } = await import('drizzle-orm/pg-core');
  return {
    devices: pgTable('test_devices', {
      id: text('id'), orgId: text('org_id'), siteId: text('site_id'), hostname: text('hostname'),
      status: text('status', { enum: ['online', 'offline'] }), osType: text('os_type'),
      osVersion: text('os_version'), agentVersion: text('agent_version'), lastSeenAt: timestamp('last_seen_at'),
    }),
    alerts: pgTable('test_alerts', {
      id: text('id'), orgId: text('org_id'), title: text('title'), severity: text('severity'),
      status: text('status', { enum: ['active', 'resolved'] }), deviceId: text('device_id'),
      triggeredAt: timestamp('triggered_at'),
    }),
    scripts: pgTable('test_scripts', {
      id: text('id'), orgId: text('org_id'), partnerId: text('partner_id'), name: text('name'),
      description: text('description'), language: text('language'), category: text('category'),
      deletedAt: timestamp('deleted_at'),
    }),
    automations: pgTable('test_automations', {
      id: text('id'), orgId: text('org_id'), partnerId: text('partner_id'), name: text('name'),
      description: text('description'), enabled: boolean('enabled'), trigger: jsonb('trigger'),
    }),
    organizations: pgTable('test_organizations', {
      id: text('id'), partnerId: text('partner_id'), createdAt: timestamp('created_at'),
    }),
    partners: pgTable('test_partners', { id: text('id'), billingEmail: text('billing_email') }),
  };
});

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    c.set('apiKey', {
      id: 'key-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      scopes: testState.scopes,
      rateLimit: 1000,
      createdBy: 'user-1',
    });
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

// Resource RBAC does not use the eager 47-tool registry. Keep it inert while
// leaving the real aiGuardrails module (and checkPermissionRequirement) loaded.
vi.mock('../services/aiTools', () => ({
  getToolDefinitions: () => [],
  executeTool: vi.fn(),
  getToolTier: () => undefined,
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

function mockDb(rows: any[]) {
  testState.dbRows = rows;
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

function buildPermsResult(permissions: { resource: string; action: string }[]) {
  return {
    permissions,
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization' as const,
    allowedSiteIds: undefined,
  };
}

function mockPermissions(perms: { resource: string; action: string }[]) {
  testState.permissions = perms;
  mocks.getUserPermissions.mockReset();
  mocks.getUserPermissions.mockResolvedValueOnce(buildPermsResult(FULL_AI_READ_BASELINE));
  mocks.getUserPermissions.mockResolvedValue(buildPermsResult(perms));
}

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: (...args: any[]) => mocks.getUserPermissions(...args),
  };
});

vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));

vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001',
}));

import { mcpServerRoutes } from './mcpServer';

async function readResource(uri: string) {
  return mcpServerRoutes.request('/message', {
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
  vi.clearAllMocks();
  testState.scopes = ['ai:read'];
  testState.permissions = [];
  testState.dbRows = [];
  mocks.dbSelect.mockReset().mockImplementation((_cols?: any) => ({
    from: (_table: any) => ({
      where: (_cond: any) => ({
        limit: (_n: number) => Promise.resolve(testState.dbRows),
      }),
      limit: (_n: number) => Promise.resolve(testState.dbRows),
    }),
  }));
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
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
    it(`denies ${uri} for a role lacking ${resource}.read and runs NO db query`, async () => {
      mockPermissions([]); // role has no permissions at all
      mockDb([]);

      const res = await readResource(uri);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toContain(`requires ${resource}.read`);
      expect(mocks.dbSelect).not.toHaveBeenCalled();
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
      expect(mocks.dbSelect).toHaveBeenCalled();
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
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });
});
