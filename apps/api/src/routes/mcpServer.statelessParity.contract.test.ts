/**
 * B-W03 (#6157, D-B16) parity contract: the stateless `2026-07-28` era is the
 * same authorization surface as legacy Streamable HTTP (`initialize` + an
 * owned `Mcp-Session-Id` on `POST /sse`).
 *
 * For every principal × case pair the modern and legacy requests must produce
 * the same JSON-RPC error, the same result once the modern decoration is
 * stripped, the same HTTP status, the same `WWW-Authenticate`, and the same
 * audit details once correlation is stripped. The only documented exception
 * is an unknown method (modern 404 vs legacy 200), asserted on its own below.
 *
 * Legacy HTTP+SSE's owned-session 202 is out of the comparison by design.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  apiKeyAuthMiddleware: vi.fn(),
  bearerTokenAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  getToolDomain: vi.fn(),
  writeAuditEvent: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  enforceIpAllowlist: vi.fn(),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: true,
  OAUTH_ISSUER: 'https://us.example.com',
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware,
  resolvePartnerAccessibleOrgIds: async () => ['org-1'],
}));
vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => {
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const makeWhere = () => {
    const thenable = Promise.resolve(rows) as Promise<typeof rows> & { limit: (n: number) => Promise<typeof rows> };
    thenable.limit = async () => rows;
    (thenable as any).orderBy = () => ({ limit: async () => rows });
    return thenable;
  };
  return {
    db: { select: () => ({ from: () => ({ where: makeWhere }) }) },
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
  partnerUsers: {
    userId: 'partner_users.user_id', partnerId: 'partner_users.partner_id',
    orgAccess: 'partner_users.org_access', orgIds: 'partner_users.org_ids',
  },
}));

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  aiTools: new Map(),
  getToolDefinitions: (...a: any[]) => mocks.getToolDefinitions(...a),
  executeTool: (...a: any[]) => mocks.executeTool(...a),
  getToolTier: (...a: any[]) => mocks.getToolTier(...a),
  getToolDomain: (...a: any[]) => mocks.getToolDomain(...a),
}));

vi.mock('../services/aiGuardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/aiGuardrails')>(),
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
  checkPermissionRequirement: async () => null,
  checkPermissionRequirements: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));
vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...a: any[]) => mocks.ledgerBegin(...a),
  completeMcpToolExecutionLedger: (...a: any[]) => mocks.ledgerComplete(...a),
}));
vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: vi.fn(async () => []),
  resolveTenantToolByName: vi.fn(async () => null),
  resolveTenantToolHealthByName: vi.fn(async () => ({ found: false })),
}));
vi.mock('../services/ipAllowlist', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/ipAllowlist')>(),
  enforceIpAllowlist: (...a: any[]) => mocks.enforceIpAllowlist(...a),
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

const sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => ({
    setex: async (k: string, _t: number, v: string) => { sessionStore.set(k, v); return 'OK'; },
    get: async (k: string) => sessionStore.get(k) ?? null,
  }),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
}));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { mcpServerRoutes } from './mcpServer';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const ALL_SCOPES = ['ai:read', 'ai:write', 'ai:execute'];
const KEY_ALL = '0a0a0a0a-0000-4000-8000-00000000000a';
const KEY_READ = '0b0b0b0b-0000-4000-8000-00000000000b';
const KEY_SP = '0c0c0c0c-0000-4000-8000-00000000000c';

type Principal = {
  label: string;
  context: Record<string, unknown>;
  ipBlocked?: boolean;
};

const PRINCIPALS: Principal[] = [
  { label: 'API key with all scopes', context: { id: KEY_ALL, orgId: 'org-1', partnerId: 'partner-1', scopes: ALL_SCOPES, mcpDomains: null } },
  { label: 'API key with ai:read only', context: { id: KEY_READ, orgId: 'org-1', partnerId: 'partner-1', scopes: ['ai:read'], mcpDomains: null } },
  { label: 'OAuth bearer with all scopes', context: { id: 'oauth:jti-all', orgId: null, partnerId: 'partner-1', scopes: ALL_SCOPES, mcpDomains: null, oauthGrantId: 'grant-all', keyPrefix: 'oauth' } },
  { label: 'OAuth bearer with a [monitoring] domain grant (ai:read)', context: { id: 'oauth:jti-mon', orgId: null, partnerId: 'partner-1', scopes: ['ai:read'], mcpDomains: ['monitoring'], oauthGrantId: 'grant-mon', keyPrefix: 'oauth' } },
  { label: 'partner service principal key', context: { id: KEY_SP, orgId: null, partnerId: 'partner-1', scopes: ALL_SCOPES, mcpDomains: null, partnerServicePrincipalId: 'psp-1' } },
  { label: 'OAuth bearer from a non-allowlisted IP', context: { id: 'oauth:jti-ip', orgId: null, partnerId: 'partner-1', scopes: ALL_SCOPES, mcpDomains: null, oauthGrantId: 'grant-ip', keyPrefix: 'oauth' }, ipBlocked: true },
];

let current: Principal = PRINCIPALS[0]!;

function setContext(c: any) {
  c.set('apiKey', { name: 'test', keyPrefix: 'brz_test', rateLimit: 1000, createdBy: 'user-1', ...current.context });
  c.set('apiKeyOrgId', current.context.orgId ?? null);
}

// ---------------------------------------------------------------------------
// Tool catalog (tier / domain per name)
// ---------------------------------------------------------------------------

const CATALOG: Record<string, { tier: number; domain: string }> = {
  get_alert_summary: { tier: 1, domain: 'monitoring' },
  list_patches: { tier: 1, domain: 'patching' },
  acknowledge_alert: { tier: 2, domain: 'monitoring' },
  reboot_device: { tier: 3, domain: 'devices' },
};

function toolDefinitions() {
  return Object.keys(CATALOG).map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } }));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Case = { label: string; method: string; params?: Record<string, unknown>; stepUp?: boolean };

const CASES: Case[] = [
  { label: 'tools/list', method: 'tools/list' },
  { label: 'tools/call tier-1 in a granted domain', method: 'tools/call', params: { name: 'get_alert_summary', arguments: {} } },
  { label: 'tools/call outside the domain grant', method: 'tools/call', params: { name: 'list_patches', arguments: {} } },
  { label: 'tools/call tier-2 (step-up off)', method: 'tools/call', params: { name: 'acknowledge_alert', arguments: {} }, stepUp: false },
  { label: 'tools/call tier-2 (step-up on)', method: 'tools/call', params: { name: 'acknowledge_alert', arguments: {} }, stepUp: true },
  { label: 'tools/call tier-3 (approval required)', method: 'tools/call', params: { name: 'reboot_device', arguments: {} } },
  { label: 'resources/read outside the grant', method: 'resources/read', params: { uri: 'breeze://scripts' } },
  { label: 'tools/call unknown tool', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
  { label: 'resources/templates/list', method: 'resources/templates/list' },
];

function app() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

async function legacyCall(method: string, params?: Record<string, unknown>) {
  const init = await app().request('/mcp/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
  });
  const sid = init.headers.get('mcp-session-id');
  mocks.writeAuditEvent.mockClear();
  const res = await app().request('/mcp/sse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-API-Key': 'k',
      ...(sid ? { 'Mcp-Session-Id': sid } : {}),
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) }),
  });
  return capture(res);
}

async function modernCall(method: string, params?: Record<string, unknown>) {
  mocks.writeAuditEvent.mockClear();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'X-API-Key': 'k',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params?.name);
  if (method === 'resources/read') headers['Mcp-Name'] = String(params?.uri);
  const res = await app().request('/mcp/sse', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method,
      params: {
        ...(params ?? {}),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  return capture(res);
}

async function capture(res: Response) {
  const text = await res.text();
  const auditRows = mocks.writeAuditEvent.mock.calls.map((call) => call[1] as Record<string, any>);
  return {
    status: res.status,
    wwwAuthenticate: res.headers.get('www-authenticate'),
    body: text ? JSON.parse(text) : null,
    requestAudit: auditRows.find((r) => r.resourceType === 'mcp_request'),
    toolAudit: auditRows.find((r) => r.resourceType === 'mcp_tool_execution'),
  };
}

const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

/** Removes exactly the modern decoration keys, nothing else. */
function stripModernDecoration(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const { resultType: _r, ttlMs: _t, cacheScope: _c, ...rest } = result as Record<string, unknown>;
  if (rest._meta && typeof rest._meta === 'object') {
    const { [SERVER_INFO_KEY]: _s, ...meta } = rest._meta as Record<string, unknown>;
    if (Object.keys(meta).length === 0) delete rest._meta;
    else rest._meta = meta;
  }
  return rest;
}

function omitCorrelation(details: Record<string, unknown> | undefined) {
  if (!details) return details;
  const { correlation: _c, clientInfoTrust: _t, sessionId: _s, hasSession: _h, rawResourceId: _r, ...rest } = details;
  return rest;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  process.env.MCP_STATELESS_ENABLED = 'true';
  sessionStore.clear();
  mocks.apiKeyAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => { setContext(c); return next(); });
  mocks.bearerTokenAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => { setContext(c); return next(); });
  mocks.getToolDefinitions.mockReset().mockImplementation(() => toolDefinitions());
  mocks.getToolTier.mockReset().mockImplementation((name: string) => CATALOG[name]?.tier);
  mocks.getToolDomain.mockReset().mockImplementation((name: string) => CATALOG[name]?.domain);
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.writeAuditEvent.mockReset();
  mocks.ledgerBegin.mockReset().mockResolvedValue({ aiOrigin: { kind: 'ai_assistant', sessionId: 's' }, executionId: 'e', sessionId: 's', orgId: 'org-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.enforceIpAllowlist.mockReset().mockImplementation(async () => (
    current.ipBlocked ? { decision: 'deny', reason: 'not_in_allowlist' } : { decision: 'allow', reason: 'no_allowlist' }
  ));
});

afterEach(() => {
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_INSUFFICIENT_SCOPE_HTTP_403;
});

describe.each(PRINCIPALS)('stateless parity — $label', (principal) => {
  beforeEach(() => {
    current = principal;
  });

  it.each(CASES)('$label', async (testCase) => {
    if (testCase.stepUp !== undefined) process.env.MCP_INSUFFICIENT_SCOPE_HTTP_403 = String(testCase.stepUp);
    const legacy = await legacyCall(testCase.method, testCase.params);
    const modern = await modernCall(testCase.method, testCase.params);

    expect(modern.body?.error ?? null).toEqual(legacy.body?.error ?? null);
    expect(stripModernDecoration(modern.body?.result)).toEqual(legacy.body?.result);
    expect(modern.status).toBe(legacy.status);
    expect(modern.wwwAuthenticate).toBe(legacy.wwwAuthenticate);

    // A request refused before dispatch (creator authority / IP allowlist)
    // writes no audit row in either era.
    expect(Boolean(modern.requestAudit)).toBe(Boolean(legacy.requestAudit));
    if (legacy.requestAudit) {
      expect(omitCorrelation(modern.requestAudit!.details)).toEqual(omitCorrelation(legacy.requestAudit.details));
      expect(modern.requestAudit!.resourceId).toMatch(UUID_RE);
      expect(legacy.requestAudit.resourceId).toMatch(UUID_RE);
      expect(modern.requestAudit!.details.hasSession).toBe(false);
      expect(modern.requestAudit!.details).not.toHaveProperty('sessionId');
      expect(modern.requestAudit!.details.correlation.era).toBe('modern');
      expect(legacy.requestAudit.details.correlation.era).toBe('legacy');
    }
    expect(Boolean(modern.toolAudit)).toBe(Boolean(legacy.toolAudit));
    if (legacy.toolAudit) {
      // durationMs is wall-clock; everything else must match.
      const { durationMs: _md, ...modernTool } = omitCorrelation(modern.toolAudit!.details)!;
      const { durationMs: _ld, ...legacyTool } = omitCorrelation(legacy.toolAudit.details)!;
      expect(modernTool).toEqual(legacyTool);
      expect(modern.toolAudit!.resourceId).toBe(modern.requestAudit!.resourceId);
    }
  });

  it('documented exception: an unknown method is modern 404 vs legacy 200, same error body', async () => {
    const legacy = await legacyCall('no/such_method');
    const modern = await modernCall('no/such_method');
    expect(modern.body?.error ?? null).toEqual(legacy.body?.error ?? null);
    if (legacy.body?.error?.code === -32601) {
      expect(legacy.status).toBe(200);
      expect(modern.status).toBe(404);
    } else {
      // Refused before dispatch (e.g. IP allowlist): identical in both eras.
      expect(modern.status).toBe(legacy.status);
    }
  });
});

describe('cacheable results', () => {
  it('cacheable results are per-principal and private', async () => {
    current = PRINCIPALS[0]!;
    const all = await modernCall('tools/list');
    current = PRINCIPALS[3]!;
    const monitoring = await modernCall('tools/list');
    const names = (r: typeof all) => (r.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(all.body.result.cacheScope).toBe('private');
    expect(monitoring.body.result.cacheScope).toBe('private');
    expect(names(all)).toContain('list_patches');
    expect(names(monitoring)).not.toContain('list_patches');
    expect(names(monitoring)).toContain('get_alert_summary');
    expect(names(all)).not.toEqual(names(monitoring));
    // A, B, A: a module-level cache keyed on anything coarser than the
    // principal would hand A's third call B's list.
    current = PRINCIPALS[0]!;
    const allAgain = await modernCall('tools/list');
    expect(names(allAgain)).toEqual(names(all));
  });
});
