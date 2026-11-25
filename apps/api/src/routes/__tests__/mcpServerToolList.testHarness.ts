/**
 * Shared request helpers for the MCP tool-list / meta-tool suites (#12427).
 *
 * Only transport plumbing lives here; every suite declares its own vi.mock
 * calls (they are hoisted per file) and passes its own audit spy.
 */
import { Hono } from 'hono';
import { vi } from 'vitest';
import type { mcpServerRoutes as McpServerRoutes } from '../mcpServer';

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

/** Every flag that adds tools or changes instructions, on (the measurement and budget tests). */
export const ALL_FLAGS_ON: Readonly<Record<string, string>> = {
  // The chat index's flag set (aiToolIndex.test.ts) ...
  M365_ENABLED: 'true',
  GOOGLE_WORKSPACE_ENABLED: 'true',
  BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true',
  FLOWS_ENABLED: 'true',
  DELEGANT_BASE_URL: 'https://delegant.example.com',
  IS_HOSTED: 'true',
  BREEZE_AI_AGENTS_ENABLED: 'true',
  BREEZE_WISP_ENABLED: 'true',
  BREEZE_WORKSPACE_ENABLED: 'true',
  // ... plus the MCP ones.
  MCP_APPS_ENABLED: 'true',
  MCP_TIER3_INTENTS_ENABLED: 'true',
  MCP_TASKS_ENABLED: 'true',
};

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
//   vi.mock('../db', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).dbMock(orig));
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
  ledgerBegin: vi.fn(async (..._args: unknown[]) => ({ aiOrigin: { kind: 'ai_assistant', sessionId: 's' }, executionId: 'e', sessionId: 's', orgId: 'org-1' }) as unknown),
  ledgerComplete: vi.fn(async (..._args: unknown[]) => undefined),
  /** Return a GuardrailCheck to override checkGuardrails for one tool; undefined keeps the default. */
  guardrailOverride: undefined as undefined | ((name: string, input: Record<string, unknown>) => { allowed: boolean; tier: number; reason?: string } | undefined),
  executeTenantToolDetailed: vi.fn(async (..._args: unknown[]) => ({ isError: false, text: JSON.stringify({ tenant: true }) })),
  callMcpFlowTool: vi.fn(async (..._args: unknown[]) => ({ kind: 'result', tier: 1, text: JSON.stringify({ flow: true }), isError: false }) as unknown),
  /** MCP_SKIP_AMBIENT_DB_CONTEXT_KEY as the auth middleware saw it, per request. */
  observedSkipFlags: [] as unknown[],
  resolveTenantTools: vi.fn(async (..._args: unknown[]) => harnessState.tenantTools),
  listMcpFlowTools: vi.fn(async (..._args: unknown[]) => harnessState.flowTools),
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
  harnessState.observedSkipFlags = [];
  harnessState.ledgerBegin.mockReset().mockImplementation(async () => ({ aiOrigin: { kind: 'ai_assistant', sessionId: 's' }, executionId: 'e', sessionId: 's', orgId: 'org-1' }));
  harnessState.ledgerComplete.mockReset().mockResolvedValue(undefined);
  harnessState.guardrailOverride = undefined;
  harnessState.executeTenantToolDetailed.mockReset().mockImplementation(async () => ({ isError: false, text: JSON.stringify({ tenant: true }) }));
  harnessState.callMcpFlowTool.mockReset().mockImplementation(async () => ({ kind: 'result', tier: 1, text: JSON.stringify({ flow: true }), isError: false }));
  harnessState.resolveTenantTools.mockReset().mockImplementation(async () => harnessState.tenantTools);
  harnessState.listMcpFlowTools.mockReset().mockImplementation(async () => harnessState.flowTools);
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
      harnessState.observedSkipFlags.push(c.get('mcpSkipAmbientDbContext'));
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
  const actual = await orig<typeof import('../../services/aiTools')>();
  return {
    ...actual,
    getToolDefinitions: () => (harnessState.realRegistry ? actual.getToolDefinitions() : fixtureDefinitions()),
    getToolTier: (name: string) => (harnessState.realRegistry ? actual.getToolTier(name) : harnessState.catalog[name]?.tier),
    getToolDomain: (name: string) => (harnessState.realRegistry ? actual.getToolDomain(name) : harnessState.catalog[name]?.domain),
    executeTool: (name: string, input: unknown) => harnessState.executeTool(name, input),
  };
}

export async function guardrailsMock(orig: Orig) {
  const actual = await orig<typeof import('../../services/aiGuardrails')>();
  return {
    ...actual,
    checkGuardrails: (name: string, input: Record<string, unknown>, context?: unknown) => (harnessState.guardrailOverride?.(name, input)
      ?? (harnessState.realRegistry
        ? actual.checkGuardrails(name, input, context as never)
        : { allowed: true, tier: harnessState.catalog[name]?.tier ?? 1 })),
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
    resolveTenantTools: (...args: unknown[]) => harnessState.resolveTenantTools(...args),
    resolveTenantToolByName: async (_auth: unknown, name: string) => harnessState.tenantTools.find((t) => t.definition.name === name) ?? null,
    resolveTenantToolHealthByName: async () => ({ found: false }),
  };
}

export function flowToolsMock() {
  return {
    listMcpFlowTools: (...args: unknown[]) => harnessState.listMcpFlowTools(...args),
    callMcpFlowTool: (...args: unknown[]) => harnessState.callMcpFlowTool(...args),
  };
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
    beginMcpToolExecutionLedger: (...args: unknown[]) => harnessState.ledgerBegin(...args),
    completeMcpToolExecutionLedger: (...args: unknown[]) => harnessState.ledgerComplete(...args),
  };
}

export async function tenantExecuteMock(orig: Orig) {
  return { ...await orig<Record<string, unknown>>(), executeTenantToolDetailed: (...args: unknown[]) => harnessState.executeTenantToolDetailed(...args) };
}

export async function tenantGuardrailsMock(orig: Orig) {
  return { ...await orig<Record<string, unknown>>(), checkTenantToolRateLimit: async () => null };
}

export function rateLimitMock() {
  return { rateLimiter: async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) }) };
}
