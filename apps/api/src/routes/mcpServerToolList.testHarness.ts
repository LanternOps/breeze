/**
 * Shared request helpers for the MCP tool-list / meta-tool suites (#12427).
 *
 * Only transport plumbing lives here; every suite declares its own vi.mock
 * calls (they are hoisted per file) and passes its own audit spy.
 */
import { Hono } from 'hono';
import { vi } from 'vitest';
import type { mcpServerRoutes as McpServerRoutes } from './mcpServer';

export type HarnessResponse = {
  status: number;
  wwwAuthenticate: string | null;
  text: string;
  body: any;
  requestAudits: Array<Record<string, any>>;
  toolAudits: Array<Record<string, any>>;
};

export type HarnessCallOptions = {
  headers?: Record<string, string>;
  meta?: Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
  /** Overrides the modern `Mcp-Name` header. */
  mcpName?: string;
};

type AuditSpy = { mock: { calls: unknown[][] }; mockClear: () => unknown };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-API-Key': 'k' };

export function createMcpHarness(routes: typeof McpServerRoutes, writeAuditEvent: AuditSpy) {
  const app = () => new Hono().route('/mcp', routes);

  async function capture(res: Response): Promise<HarnessResponse> {
    const text = await res.text();
    const rows = writeAuditEvent.mock.calls.map((call) => call[1] as Record<string, any>);
    return {
      status: res.status,
      wwwAuthenticate: res.headers.get('www-authenticate'),
      text,
      body: text ? JSON.parse(text) : null,
      requestAudits: rows.filter((r) => r.resourceType === 'mcp_request'),
      toolAudits: rows.filter((r) => r.resourceType === 'mcp_tool_execution'),
    };
  }

  async function initialize(opts: HarnessCallOptions = {}) {
    writeAuditEvent.mockClear();
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...opts.headers },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', ...(opts.clientCapabilities ? { capabilities: opts.clientCapabilities } : {}) },
      }),
    });
    return { sessionId: res.headers.get('mcp-session-id'), response: await capture(res) };
  }

  /** Legacy Streamable HTTP: initialize (no mode override), then the call on the owned session. */
  async function legacy(method: string, params?: Record<string, unknown>, opts: HarnessCallOptions = {}): Promise<HarnessResponse> {
    const { sessionId } = await initialize({ clientCapabilities: opts.clientCapabilities });
    writeAuditEvent.mockClear();
    const merged = opts.meta ? { ...(params ?? {}), _meta: opts.meta } : params;
    return capture(await app().request('/mcp/sse', {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        'MCP-Protocol-Version': '2025-11-25',
        ...opts.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(merged ? { params: merged } : {}) }),
    }));
  }

  /** Stateless 2026-07-28 era on POST /sse. */
  async function modern(method: string, params?: Record<string, unknown>, opts: HarnessCallOptions = {}): Promise<HarnessResponse> {
    writeAuditEvent.mockClear();
    const headers: Record<string, string> = {
      ...JSON_HEADERS, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    };
    if (method === 'tools/call') headers['Mcp-Name'] = opts.mcpName ?? String(params?.name);
    if (method === 'resources/read') headers['Mcp-Name'] = String(params?.uri);
    if (method.startsWith('tasks/')) headers['Mcp-Name'] = String(params?.taskId);
    return capture(await app().request('/mcp/sse', {
      method: 'POST',
      headers: { ...headers, ...opts.headers },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method,
        params: {
          ...(params ?? {}),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': opts.clientCapabilities ?? {},
            ...opts.meta,
          },
        },
      }),
    }));
  }

  return { app, initialize, legacy, modern };
}

// ---------------------------------------------------------------------------
// Shared mock factories. A suite wires them with
//   vi.mock('../db', async (orig) => (await import('./mcpServerToolList.testHarness')).dbMock(orig));
// and drives behaviour through `harnessState` (one module instance per file).
// ---------------------------------------------------------------------------
type Orig = <T>() => Promise<T>;
export type FixtureTool = { tier: number; domain: string; description?: string; inputSchema?: Record<string, unknown> };

export const DEFAULT_FIXTURE_CATALOG: Record<string, FixtureTool> = {
  get_fleet_health: { tier: 1, domain: 'devices' },
  get_alert_summary: { tier: 1, domain: 'monitoring' },
  get_invite_funnel: { tier: 1, domain: 'admin' },
  acknowledge_alert: { tier: 2, domain: 'monitoring' },
  reboot_device: { tier: 3, domain: 'devices' },
};

export const UNRESTRICTED_KEY = {
  id: '0a0a0a0a-0000-4000-8000-00000000000a', orgId: 'org-1', partnerId: 'partner-1',
  scopes: ['ai:read', 'ai:write', 'ai:execute'], mcpDomains: null,
} as Record<string, unknown>;

export const harnessState = {
  /** true → the real registry's definitions, tiers and domains. */
  realRegistry: false,
  catalog: { ...DEFAULT_FIXTURE_CATALOG } as Record<string, FixtureTool>,
  context: { ...UNRESTRICTED_KEY } as Record<string, unknown>,
  writeAuditEvent: vi.fn(),
  executeTool: vi.fn(async (_name: string, _input: unknown) => JSON.stringify({ ok: true })),
  checkToolRateLimit: vi.fn(async (..._args: unknown[]) => null as string | null),
  checkToolPermission: vi.fn(async (..._args: unknown[]) => null as string | null),
  tenantTools: [] as Array<{ tier: number; definition: { name: string; description: string; input_schema: Record<string, unknown> } }>,
  flowTools: [] as Array<{ name: string; description: string; tier: number; inputSchema: Record<string, unknown> }>,
  sessions: new Map<string, string>(),
};

export function resetHarnessState(): void {
  harnessState.realRegistry = false;
  harnessState.catalog = { ...DEFAULT_FIXTURE_CATALOG };
  harnessState.context = { ...UNRESTRICTED_KEY };
  harnessState.writeAuditEvent.mockReset();
  harnessState.executeTool.mockReset().mockImplementation(async () => JSON.stringify({ ok: true }));
  harnessState.checkToolRateLimit.mockReset().mockResolvedValue(null);
  harnessState.checkToolPermission.mockReset().mockResolvedValue(null);
  harnessState.tenantTools = [];
  harnessState.flowTools = [];
  harnessState.sessions.clear();
}

export function fixtureDefinitions() {
  return Object.entries(harnessState.catalog).map(([name, t]) => ({
    name,
    description: t.description ?? `${name} description.`,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

export async function envMock(orig: Orig) {
  return { ...await orig<Record<string, unknown>>(), MCP_OAUTH_ENABLED: false, OAUTH_ISSUER: 'https://us.example.com' };
}

export function apiKeyAuthMock() {
  return {
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', { name: 'test', keyPrefix: 'brz_test', rateLimit: 1000, createdBy: 'user-1', ...harnessState.context });
      return next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  };
}

export function bearerMock() {
  return {
    bearerTokenAuthMiddleware: async (_c: any, next: any) => next(),
    resolvePartnerAccessibleOrgIds: async () => ['org-1'],
  };
}

export async function dbMock(orig: Orig) {
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const where = () => Object.assign(Promise.resolve(rows), { limit: async () => rows, orderBy: () => ({ limit: async () => rows }) });
  return {
    ...await orig<Record<string, unknown>>(),
    db: { select: () => ({ from: () => ({ where }) }) },
    withDbAccessContext: async (_ctx: unknown, fn: () => any) => fn(),
    withSystemDbAccessContext: async (fn: () => any) => fn(),
    runOutsideDbContext: (fn: () => any) => fn(),
  };
}

export async function permissionsMock(orig: Orig) {
  return {
    ...await orig<Record<string, unknown>>(),
    getUserPermissions: async () => ({
      permissions: [{ resource: '*', action: '*' }], partnerId: 'partner-1', orgId: 'org-1', roleId: 'role-1', scope: 'organization',
    }),
  };
}

export async function aiToolsMock(orig: Orig) {
  const actual = await orig<typeof import('../services/aiTools')>();
  return {
    ...actual,
    getToolDefinitions: () => (harnessState.realRegistry ? actual.getToolDefinitions() : fixtureDefinitions()),
    getToolTier: (name: string) => (harnessState.realRegistry ? actual.getToolTier(name) : harnessState.catalog[name]?.tier),
    getToolDomain: (name: string) => (harnessState.realRegistry ? actual.getToolDomain(name) : harnessState.catalog[name]?.domain),
    executeTool: (name: string, input: unknown) => harnessState.executeTool(name, input),
  };
}

export async function guardrailsMock(orig: Orig) {
  const actual = await orig<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkGuardrails: (name: string, input: Record<string, unknown>, context?: unknown) => (harnessState.realRegistry
      ? actual.checkGuardrails(name, input, context as never)
      : { allowed: true, tier: harnessState.catalog[name]?.tier ?? 1 }),
    checkToolPermission: (...args: unknown[]) => harnessState.checkToolPermission(...args),
    checkToolRateLimit: (...args: unknown[]) => harnessState.checkToolRateLimit(...args),
    checkPermissionRequirement: async () => null,
    checkPermissionRequirements: async () => null,
  };
}

export function auditMock() {
  return {
    writeAuditEvent: (...args: unknown[]) => harnessState.writeAuditEvent(...args),
    requestLikeFromSnapshot: vi.fn(),
  };
}

export function resolverMock() {
  return {
    resolveTenantTools: async () => harnessState.tenantTools,
    resolveTenantToolByName: async () => null,
    resolveTenantToolHealthByName: async () => ({ found: false }),
  };
}

export function flowToolsMock() {
  return { listMcpFlowTools: async () => harnessState.flowTools, callMcpFlowTool: vi.fn() };
}

export function executionOrgMock() {
  return {
    resolveMcpExecutionOrgId: () => 'org-1',
    resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
    McpExecutionOrgError: class McpExecutionOrgError extends Error {},
    mcpExecutionOrgRpcError: () => ({ message: 'Invalid params' }),
  };
}

export function redisMock() {
  return {
    getRedis: () => ({
      setex: async (k: string, _t: number, v: string) => { harnessState.sessions.set(k, v); return 'OK'; },
      get: async (k: string) => harnessState.sessions.get(k) ?? null,
    }),
  };
}

export function ledgerMock() {
  return {
    beginMcpToolExecutionLedger: vi.fn(async () => ({ aiOrigin: { kind: 'ai_assistant', sessionId: 's' }, executionId: 'e', sessionId: 's', orgId: 'org-1' })),
    completeMcpToolExecutionLedger: vi.fn(async () => undefined),
  };
}
