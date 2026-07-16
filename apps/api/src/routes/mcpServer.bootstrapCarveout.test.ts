import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  apiKey: null as Record<string, unknown> | null,
  db: {} as Record<string, any>,
  bootstrap: { unauthTools: [], authTools: [] } as {
    unauthTools: any[];
    authTools: any[];
  },
  oauthEnabled: true,
  oauthIssuer: 'https://us.example.com',
}));

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  bootstrapHandler: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
  rateLimiter: vi.fn(),
  enforceIpAllowlist: vi.fn(),
}));

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return state.oauthEnabled; },
  get OAUTH_ISSUER() { return state.oauthIssuer; },
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    if (!state.apiKey) throw new Error('should not be called without an X-API-Key header');
    c.set('apiKey', state.apiKey);
    c.set('apiKeyOrgId', state.apiKey.orgId);
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => ['org-1'],
}));

vi.mock('../db', () => ({
  db: new Proxy({}, {
    get: (_target, property) => state.db[property as string],
  }),
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now calls
// getUserPermissions via authorizeHumanApiKeyCreator to re-validate the API
// key's stored scopes (['ai:read', 'ai:execute'] in the authed test below)
// against the creator's live permissions before an AuthContext is ever built.
// checkToolPermission is stubbed to always allow above, so this is the ONLY
// getUserPermissions call in this file's flow — it must hold the full
// devices/alerts/scripts/automations read + devices/scripts execute bundle
// both scopes require, or the carve-out test would be denied by the re-clamp
// before ever reaching the tools/list + tools/call dispatch under test.
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [
        { resource: 'devices', action: 'read' },
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
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: (...args: any[]) => mocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (...args: any[]) => mocks.getToolTier(...args),
}));

vi.mock('../services/aiGuardrails', () => ({
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
  checkPermissionRequirement: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: mocks.requestLikeFromSnapshot,
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => mocks.rateLimiter(...args),
}));
vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: (...args: any[]) => mocks.enforceIpAllowlist(...args),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
}));
vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => state.bootstrap,
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

import { __loadMcpBootstrapForTests, mcpServerRoutes } from './mcpServer';

beforeEach(async () => {
  state.apiKey = null;
  state.db = {};
  state.bootstrap = { unauthTools: [], authTools: [] };
  state.oauthEnabled = true;
  state.oauthIssuer = 'https://us.example.com';
  mocks.executeTool.mockReset();
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.bootstrapHandler.mockReset();
  mocks.ledgerBegin.mockReset().mockResolvedValue({
    executionId: 'exec-1',
    sessionId: 'sess-1',
    orgId: 'org-1',
  });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
  mocks.requestLikeFromSnapshot.mockReset();
  mocks.rateLimiter.mockReset().mockResolvedValue({
    allowed: true,
    resetAt: new Date(Date.now() + 60_000),
  });
  mocks.enforceIpAllowlist.mockReset().mockResolvedValue({ decision: 'allow' });
  await __loadMcpBootstrapForTests();
});

describe('MCP bootstrap carve-out', () => {
  // The route no longer reads IS_HOSTED or starts bootstrap loading at import.
  // A static route graph plus an explicit loader keeps these requests out of
  // the module cold-start path while exercising the real transport handlers.
  it('no auth header → tools/list always returns 401 + WWW-Authenticate', async () => {
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('oauth-protected-resource');
    const body = await res.json();
    expect(body.error?.code).toBe(-32001);
  });

  it('authed key → authTools surface in tools/list AND dispatch to handler', async () => {
    state.apiKey = {
      id: 'key-authtool',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      scopes: ['ai:read', 'ai:execute'],
      rateLimit: 1000,
      createdBy: 'user-1',
    };
    state.db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ partnerId: 'partner-1', billingEmail: 'admin@acme.com' }] }),
        }),
      }),
    };
    mocks.bootstrapHandler.mockResolvedValue({
      invites_sent: 2,
      invite_ids: ['i1', 'i2'],
      skipped_duplicates: 0,
    });
    state.bootstrap = {
      unauthTools: [],
      authTools: [{
        definition: {
          name: 'send_deployment_invites',
          description: 'fake authTool',
          inputSchema: z.object({}).passthrough(),
        },
        handler: (...args: any[]) => mocks.bootstrapHandler(...args),
      }],
    };
    await __loadMcpBootstrapForTests();

    const listRes = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const sendTool = listBody.result.tools.find(
      (tool: any) => tool.name === 'send_deployment_invites',
    );
    expect(sendTool).toBeDefined();
    expect(sendTool?.inputSchema?.type).toBe('object');

    const callRes = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'send_deployment_invites', arguments: { emails: ['a@b.com'] } },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody = await callRes.json();
    expect(callBody.error).toBeUndefined();
    expect(mocks.bootstrapHandler).toHaveBeenCalledTimes(1);
    const [calledInput, calledCtx] = mocks.bootstrapHandler.mock.calls[0] as unknown as [any, any];
    expect(calledInput).toEqual({ emails: ['a@b.com'] });
    expect(calledCtx.apiKey).toMatchObject({
      id: 'key-authtool',
      partnerId: 'partner-1',
      defaultOrgId: 'org-1',
      partnerAdminEmail: 'admin@acme.com',
    });
    expect(JSON.parse(callBody.result.content[0].text)).toEqual({
      invites_sent: 2,
      invite_ids: ['i1', 'i2'],
      skipped_duplicates: 0,
    });
  });
});
