import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';

// SR2-15 (core-auth-hardening) regression: an org-scoped MCP API key inherits
// its creator's site-axis restriction via getUserPermissions(...).allowedSiteIds.
//
// THE FAIL-OPEN this suite pins closed: when the creator has been stripped of the
// membership the key derives from — they're still `status='active'`, so PR 1's
// creator-status gate passes — getUserPermissions returns **null**. The old code
// read `creatorPerms?.allowedSiteIds`, so null collapsed to `undefined`, and
// siteAccessCheck(undefined) means "full access to EVERY site in the org". A key
// whose creator has NO authority got unrestricted org+site access.
//
// Fix: buildAuthFromApiKey returns null on null perms → buildCheckedAuthFromApiKey
// denies with 403 (fail CLOSED). A legitimate full-access admin (non-null perms,
// allowedSiteIds undefined) and a site-restricted creator (explicit list) are
// unaffected.

const mocks = vi.hoisted(() => ({
  getActiveOrgTenant: vi.fn(async (_orgId: string): Promise<{ orgId: string; partnerId: string } | null> => ({
    orgId: 'org-1',
    partnerId: 'partner-1',
  })),
  // Default: a legitimate FULL-ACCESS org admin (non-null, allowedSiteIds
  // undefined). Individual tests override with mockResolvedValueOnce.
  getUserPermissions: vi.fn(async (_userId: string, _ctx: { partnerId?: string; orgId?: string }) => ({
    permissions: [],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization' as const,
    allowedSiteIds: undefined as string[] | undefined,
  })),
  // Capturing stub: 3rd arg is the full AuthContext handed to the RBAC gate, so
  // we can inspect allowedSiteIds / canAccessSite. Returns null = allow.
  checkToolPermission: vi.fn(async (
    _toolName: string,
    _input: unknown,
    _auth: { allowedSiteIds?: string[]; canAccessSite: (s: string | null | undefined) => boolean },
  ) => null),
  executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));

vi.mock('../services/tenantStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tenantStatus')>();
  return { ...actual, getActiveOrgTenant: mocks.getActiveOrgTenant };
});

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: mocks.getUserPermissions };
});

vi.mock('../services/aiGuardrails', () => ({
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: mocks.checkToolPermission,
  checkToolRateLimit: async () => null,
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: () => [
    { name: 'list_devices', description: 'list', inputSchema: zod.object({}).passthrough() },
  ],
  executeTool: mocks.executeTool,
  getToolTier: () => 1,
}));

vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
  partnerUsers: {}, apiKeys: {},
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
  bearerTokenAuthMiddleware: async () => { throw new Error('should not be called without a Bearer header'); },
  resolvePartnerAccessibleOrgIds: async () => [],
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));
vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: async () => ({ id: 'ledger-1' }),
  completeMcpToolExecutionLedger: async () => undefined,
}));

function mockApiKey() {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId: null,
        name: 'test',
        keyPrefix: 'brz_test',
        scopes: ['ai:read'],
        rateLimit: 1000,
        createdBy: 'creator-user',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

async function callListDevices() {
  mockApiKey();
  const mod = await import('./mcpServer');
  return mod.mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_devices', arguments: {} },
    }),
  });
}

describe('MCP org-scoped key: creator perms fail closed on null (SR2-15)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getActiveOrgTenant.mockClear();
    mocks.getUserPermissions.mockClear();
    mocks.checkToolPermission.mockClear();
    mocks.executeTool.mockClear();
    delete process.env.IS_HOSTED;
  });

  afterEach(() => {
    vi.doUnmock('../middleware/apiKeyAuth');
  });

  it('DENIES the request (403) when getUserPermissions returns null (creator stripped of membership)', async () => {
    // Creator is still active (PR 1 gate passes) but has NO org role and NO
    // partner role → getUserPermissions returns null.
    mocks.getUserPermissions.mockResolvedValueOnce(null as any);

    const res = await callListDevices();

    expect(res.status).toBe(403);
    // The tool never dispatched — auth was rejected before RBAC/execution.
    expect(mocks.checkToolPermission).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('a legitimate FULL-access admin (non-null perms, allowedSiteIds undefined) still gets all-site access', async () => {
    // Default mock already models this (allowedSiteIds: undefined).
    const res = await callListDevices();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();

    const [, , auth] = mocks.checkToolPermission.mock.calls[0] as [
      string, unknown, { allowedSiteIds?: string[]; canAccessSite: (s: string | null | undefined) => boolean },
    ];
    expect(auth.allowedSiteIds).toBeUndefined();
    // Unrestricted: every site allowed.
    expect(auth.canAccessSite('any-site-at-all')).toBe(true);
  });

  it('a site-restricted creator keeps EXACTLY their sites (no widening)', async () => {
    mocks.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: ['site-a'],
    } as any);

    const res = await callListDevices();

    expect(res.status).toBe(200);
    const [, , auth] = mocks.checkToolPermission.mock.calls[0] as [
      string, unknown, { allowedSiteIds?: string[]; canAccessSite: (s: string | null | undefined) => boolean },
    ];
    expect(auth.allowedSiteIds).toEqual(['site-a']);
    expect(auth.canAccessSite('site-a')).toBe(true);
    expect(auth.canAccessSite('site-b')).toBe(false);
  });
});
