import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';

// SR2-15 (core-auth-hardening, Task 3) regression: the MCP PARTNER-scope
// branch of buildAuthFromApiKey (apiKey.orgId === null — OAuth bearer token,
// or an API key with no org_id) previously had NO null-perms deny at all. An
// off-boarded partner admin's key was only "data-starved"
// (resolvePartnerAccessibleOrgIds reads partner_users fresh and returns []
// for a gone membership, producing an unsatisfiable org filter) but never
// outright rejected — tools/list still succeeded and the caller looked
// authenticated. Task 3 added an explicit
// `getUserPermissions(apiKey.createdBy, { partnerId: apiKey.partnerId })`
// call in this branch with `return null` (-> 403 via buildCheckedAuthFromApiKey)
// on a null/errored read, matching the org-scope branch's fail-closed
// posture (see mcpServer.creatorPermsNull.test.ts for that sibling coverage).
//
// This suite pins THAT delta closed: an off-boarded partner-admin creator
// (still `status='active'`, so the PR1 creator-status gate passes, but with
// no partner_users row left) must be DENIED, not served on stale authority.

const mocks = vi.hoisted(() => ({
  // Default: a legitimate partner-admin creator whose live permissions still
  // cover the key's stored scope (ai:read = devices/alerts/scripts/
  // automations read). Individual tests override with mockResolvedValueOnce
  // to model an off-boarded creator (null).
  getUserPermissions: vi.fn(async (_userId: string, _ctx: { partnerId?: string; orgId?: string }) => ({
    permissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'alerts', action: 'read' },
      { resource: 'scripts', action: 'read' },
      { resource: 'automations', action: 'read' },
    ],
    partnerId: 'partner-1',
    orgId: null,
    roleId: 'role-1',
    scope: 'partner' as const,
    allowedSiteIds: undefined as string[] | undefined,
  })),
  checkToolPermission: vi.fn(async (
    _toolName: string,
    _input: unknown,
    _auth: { scope?: string; partnerId?: string | null },
  ) => null),
  executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));

vi.mock('../services/tenantStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tenantStatus')>();
  return { ...actual };
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
  // The off-boarded creator's actual org list is irrelevant to THIS guard —
  // buildAuthFromApiKey must deny before it ever reaches this resolver. Kept
  // empty like the sibling org-scope suite; resolveMcpExecutionOrgId is
  // mocked separately below so it doesn't gate the positive-control test.
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

// Partner-scope key: orgId null, partnerId set — an OAuth-provisioned key or
// a manual key with no org_id, driven here via the X-API-Key middleware for
// simplicity (buildAuthFromApiKey's branch selection is purely
// `apiKey.orgId` truthy/falsy, independent of which auth header reached it —
// see mcpServer.bearer.test.ts for the Bearer-header variant of this shape).
function mockApiKey() {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: null,
        partnerId: 'partner-1',
        name: 'test',
        keyPrefix: 'brz_test',
        scopes: ['ai:read'],
        rateLimit: 1000,
        createdBy: 'partner-admin-user',
      });
      c.set('apiKeyOrgId', null);
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

describe('MCP partner-scoped key: creator perms fail closed on null (SR2-15 off-boarding deny)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getUserPermissions.mockClear();
    mocks.checkToolPermission.mockClear();
    mocks.executeTool.mockClear();
    delete process.env.IS_HOSTED;
  });

  afterEach(() => {
    vi.doUnmock('../middleware/apiKeyAuth');
  });

  it('DENIES the request (403) when getUserPermissions(partnerId) returns null (off-boarded partner-admin creator)', async () => {
    // Creator is still active (PR1 gate passes) but their partner_users
    // membership is gone, so the partner-axis getUserPermissions read
    // resolves null. Before this task, the partner branch had no null-perms
    // deny at all: this off-boarded creator's key would still be served
    // (tools/list, tools/call all succeeding on stale authority), only
    // silently data-starved by an empty accessibleOrgIds. This guard closes
    // that: the branch must reject outright, matching the org-scope branch.
    mocks.getUserPermissions.mockResolvedValueOnce(null as any);

    const res = await callListDevices();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.result).toBeUndefined();
    expect(body.error).toBeDefined();
    // The tool never dispatched — auth was rejected before RBAC/execution.
    expect(mocks.checkToolPermission).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('a partner-scoped key whose creator still has an active partner membership is served normally (positive control)', async () => {
    // Default mock (module-level) already models a legitimate partner-admin
    // creator with non-null permissions covering the key's ai:read scope.
    const res = await callListDevices();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(mocks.getUserPermissions).toHaveBeenCalledWith(
      'partner-admin-user',
      expect.objectContaining({ partnerId: 'partner-1' }),
    );
    expect(mocks.checkToolPermission).toHaveBeenCalled();
  });
});
