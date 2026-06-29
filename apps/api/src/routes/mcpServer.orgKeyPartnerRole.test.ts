import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';

// Regression coverage for the MCP RBAC bug on self-hosted deployments:
// a Partner Admin with NO organization_users row creates a normal (manual)
// org-scoped API key. apiKeyAuth gates partner-axis resolution to
// mcp_provisioning keys, so such a key reaches the MCP dispatch with
// partnerId: null. buildAuthFromApiKey must resolve the OWNING org's partner
// for ROLE resolution, otherwise getUserPermissions (org-membership-first,
// partner only when partnerId is set) returns null and every tools/call dies
// with "Insufficient permissions: no role assigned" — even though tools/list
// (ungated) works. See buildAuthFromApiKey in ./mcpServer.

const mocks = vi.hoisted(() => ({
  // Owning-org → partner resolver. Per test we set its return to model an org
  // that belongs to a partner (the fix) vs. an org with no usable partner.
  getActiveOrgTenant: vi.fn(async (_orgId: string): Promise<{ orgId: string; partnerId: string } | null> => null),
  // Spy so we can assert the partnerId buildAuthFromApiKey threads into role
  // resolution. Returns a benign org-perms object (its shape is irrelevant to
  // these assertions; checkToolPermission is stubbed below).
  getUserPermissions: vi.fn(async (_userId: string, _ctx: { partnerId?: string; orgId?: string }) => ({
    permissions: [],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization' as const,
    allowedSiteIds: undefined,
  })),
  // Capturing stub: the real gate reads auth.partnerId (3rd arg) to resolve the
  // caller's role. We assert on the captured auth instead of modeling the
  // permissions DB. Returns null = allow, so dispatch completes.
  checkToolPermission: vi.fn(async (_toolName: string, _input: unknown, _auth: { partnerId: string | null }) => null),
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
vi.mock('./mcpExecutionOrg', () => ({ resolveMcpExecutionOrgId: () => 'org-1' }));
vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: async () => ({ id: 'ledger-1' }),
  completeMcpToolExecutionLedger: async () => undefined,
}));

// `partnerId: null` models the manual (user-created) key the Partner Admin
// minted: apiKeyAuth left the partner axis unresolved. `createdBy` is the
// partner-admin user who has no organization_users row.
function mockApiKey(partnerId: string | null) {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId,
        name: 'test',
        keyPrefix: 'brz_test',
        scopes: ['ai:read'],
        rateLimit: 1000,
        createdBy: 'partner-admin-user',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

async function callListDevices(partnerId: string | null) {
  mockApiKey(partnerId);
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

const ORIG_HOSTED = process.env.IS_HOSTED;

describe('MCP org-scoped key resolves owning partner for role lookup', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getActiveOrgTenant.mockClear();
    mocks.getUserPermissions.mockClear();
    mocks.checkToolPermission.mockClear();
    mocks.executeTool.mockClear();
    delete process.env.IS_HOSTED;
  });

  afterEach(() => {
    if (ORIG_HOSTED === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = ORIG_HOSTED;
    vi.doUnmock('../middleware/apiKeyAuth');
  });

  it('manual key (partnerId: null) resolves the org\'s partner so the partner-admin role is found', async () => {
    mocks.getActiveOrgTenant.mockResolvedValueOnce({ orgId: 'org-1', partnerId: 'partner-1' });

    const res = await callListDevices(null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();

    // The owning org was consulted to recover the partner the manual key lacked.
    expect(mocks.getActiveOrgTenant).toHaveBeenCalledWith('org-1');

    // buildAuthFromApiKey threads the resolved partner into role resolution
    // (instead of the null the key carried).
    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      'partner-admin-user',
      expect.objectContaining({ partnerId: 'partner-1', orgId: 'org-1' }),
    );

    // The auth handed to the RBAC gate carries the resolved partner — this is
    // the value aiGuardrails uses to find the caller's role. Without the fix it
    // was null and the gate returned "no role assigned".
    const [, , auth] = mocks.checkToolPermission.mock.calls[0] as [string, unknown, { partnerId: string | null }];
    expect(auth.partnerId).toBe('partner-1');
  });

  it('falls back to null (no crash) when the owning org has no usable partner', async () => {
    mocks.getActiveOrgTenant.mockResolvedValueOnce(null);

    const res = await callListDevices(null);
    expect(res.status).toBe(200);

    expect(mocks.getActiveOrgTenant).toHaveBeenCalledWith('org-1');
    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      'partner-admin-user',
      expect.objectContaining({ partnerId: undefined, orgId: 'org-1' }),
    );
    const [, , auth] = mocks.checkToolPermission.mock.calls[0] as [string, unknown, { partnerId: string | null }];
    expect(auth.partnerId).toBeNull();
  });

  it('already-resolved key (mcp_provisioning) keeps its partner and skips the org lookup', async () => {
    const res = await callListDevices('partner-9');
    expect(res.status).toBe(200);

    // partnerId was already present, so the `??` short-circuits — no extra DB hit.
    expect(mocks.getActiveOrgTenant).not.toHaveBeenCalled();
    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      'partner-admin-user',
      expect.objectContaining({ partnerId: 'partner-9', orgId: 'org-1' }),
    );
    const [, , auth] = mocks.checkToolPermission.mock.calls[0] as [string, unknown, { partnerId: string | null }];
    expect(auth.partnerId).toBe('partner-9');
  });
});
