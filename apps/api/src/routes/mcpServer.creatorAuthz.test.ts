import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';
import { validateApiKeyScopeDelegation } from '../services/apiKeyScopes';

// SR2-15 (core-auth-hardening, Task 3) regression: the MCP org-scope branch of
// buildAuthFromApiKey now authorizes the human creator LIVE via the shared
// authorizeHumanApiKeyCreator() resolver instead of a raw getUserPermissions()
// call. #2510 already fixed the null-perms fail-open (creatorPermsNull suite).
// THIS suite pins the delta #2510 did NOT cover: the resolver ALSO re-clamps
// the key's STORED scopes against the creator's CURRENT permissions.
//
// The guard-bite this suite adds: a creator whose live permissions have been
// reduced below what the key's stored scopes require must be DENIED, not
// served with the key's original (now stale) scope grant. Before this task,
// buildAuthFromApiKey only null-checked getUserPermissions() and used
// creatorPerms.allowedSiteIds — it never re-ran scope delegation, so a key
// minted while its creator was e.g. an org admin kept working at full
// ai:execute strength even after that creator was demoted to read-only.

const mocks = vi.hoisted(() => ({
  getActiveOrgTenant: vi.fn(async (_orgId: string): Promise<{ orgId: string; partnerId: string } | null> => ({
    orgId: 'org-1',
    partnerId: 'partner-1',
  })),
  // Default: a legitimate creator whose live permissions cover devices +
  // alerts + scripts + automations read/write/execute — i.e. enough to back
  // every scope this suite's keys carry. Individual tests override with
  // mockResolvedValueOnce to model a REDUCED creator.
  getUserPermissions: vi.fn(async (_userId: string, _ctx: { partnerId?: string; orgId?: string }) => ({
    permissions: [
      { resource: 'devices', action: 'read' },
      { resource: 'devices', action: 'write' },
      { resource: 'devices', action: 'execute' },
      { resource: 'alerts', action: 'read' },
      { resource: 'scripts', action: 'read' },
      { resource: 'scripts', action: 'execute' },
      { resource: 'automations', action: 'read' },
    ],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization' as const,
    allowedSiteIds: undefined as string[] | undefined,
  })),
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
    { name: 'devices_execute_script', description: 'execute a script on a device', inputSchema: zod.object({}).passthrough() },
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

function mockApiKey(scopes: string[]) {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId: null,
        name: 'test',
        keyPrefix: 'brz_test',
        scopes,
        rateLimit: 1000,
        createdBy: 'creator-user',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

async function callTool(scopes: string[], toolName: string) {
  mockApiKey(scopes);
  const mod = await import('./mcpServer');
  return mod.mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    }),
  });
}

describe('MCP org-scoped key: live scope re-clamp on top of #2510 null-deny (SR2-15)', () => {
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

  it('SR2-15: a permission-reduced creator cannot use a scope above their current permissions', async () => {
    // The key was minted with ai:execute (devices:execute + scripts:execute
    // backing) but the creator's LIVE permissions now cover devices:read only
    // — e.g. demoted from admin to read-only after the key was created.
    mocks.getUserPermissions.mockResolvedValueOnce({
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    } as any);

    const res = await callTool(['ai:read', 'ai:execute'], 'devices_execute_script');

    // Before the fix: buildAuthFromApiKey only null-checked getUserPermissions
    // and never re-validated the key's stored scopes, so this reduced creator's
    // stale ai:execute grant would still be served (200, tool dispatched).
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.result).toBeUndefined();
    expect(body.error).toBeDefined();
    // The tool never dispatched — auth was rejected before RBAC/execution.
    expect(mocks.checkToolPermission).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('SR2-15 (sharper): ai:execute re-clamp bites for a creator who still holds the FULL ai:read baseline (isolated from the ai:read bundle clamp)', async () => {
    // The companion test above ("a permission-reduced creator...") starves
    // devices:read too, so validateApiKeyScopeDelegation actually trips on the
    // ai:read bundle FIRST (devices:read is one of ai:read's four required
    // grants) — it never isolates whether the ai:execute re-clamp itself
    // bites. This test keeps every ai:read grant (devices/alerts/scripts/
    // automations read) intact and strips ONLY the execute-backing
    // permissions (devices:execute, scripts:execute), so a denial here can
    // only be explained by the ai:execute re-clamp specifically.
    const fullReadOnlyExecuteCreator = {
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'alerts', action: 'read' },
        { resource: 'scripts', action: 'read' },
        { resource: 'automations', action: 'read' },
        // Deliberately NO devices:execute / scripts:execute — demoted from an
        // execute-capable role to read-only after the key was minted.
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    } as const;

    // Sanity-check the isolation directly against the REAL (unmocked)
    // validateApiKeyScopeDelegation before driving the HTTP path: ai:read
    // ALONE is satisfied by this fixture (so the denial below cannot be the
    // ai:read bundle clamp), while ai:execute ALONE is not.
    const readOnlyCheck = validateApiKeyScopeDelegation(['ai:read'], fullReadOnlyExecuteCreator as any);
    expect(readOnlyCheck.ok).toBe(true);
    const executeOnlyCheck = validateApiKeyScopeDelegation(['ai:execute'], fullReadOnlyExecuteCreator as any);
    expect(executeOnlyCheck.ok).toBe(false);
    if (!executeOnlyCheck.ok) {
      expect(executeOnlyCheck.error).toContain('ai:execute');
    }

    mocks.getUserPermissions.mockResolvedValueOnce(fullReadOnlyExecuteCreator as any);

    const res = await callTool(['ai:read', 'ai:execute'], 'devices_execute_script');

    // Before this task's re-clamp, buildAuthFromApiKey never re-validated
    // stored scopes at all, so this creator (non-null perms, key carries
    // ai:execute) would have been served (200, tool dispatched) on stale
    // authority.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.result).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(mocks.checkToolPermission).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('SR2-15: a creator whose live permissions still cover the stored scopes is served normally', async () => {
    // Default mock (module-level) already covers devices read/write/execute +
    // scripts read/execute + alerts/automations read — enough for ai:read +
    // ai:execute.
    const res = await callTool(['ai:read', 'ai:execute'], 'devices_execute_script');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(mocks.checkToolPermission).toHaveBeenCalled();
  });

  it('SR2-15: a creator stripped of all membership (null perms) is still DENIED (guards #2510 stays intact)', async () => {
    mocks.getUserPermissions.mockResolvedValueOnce(null as any);

    const res = await callTool(['ai:read'], 'list_devices');

    expect(res.status).toBe(403);
    expect(mocks.checkToolPermission).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
