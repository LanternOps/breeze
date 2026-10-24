/**
 * B-W05 (#6159): the MCP Apps pilot over both eras — extension negotiation,
 * the legacy side key, advertisement, the gated `_meta.ui` listing and the
 * gated `ui://` resource read, plus the audit details the go/no-go reads.
 *
 * Harness copied from mcpServer.modern.test.ts (in-memory Redis session store,
 * header-driven API-key context). `checkPermissionRequirement` is a spy so the
 * RBAC leg of the D-B43 predicate can be denied per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn<typeof import('../services/aiTools').getToolDefinitions>(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
  getToolDomain: vi.fn((_: string): string => 'devices'),
  writeAuditEvent: vi.fn(),
  rateLimiter: vi.fn(),
  checkPermissionRequirement: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  dbSelect: vi.fn(),
}));

const envState = vi.hoisted(() => ({
  oauthEnabled: true,
  oauthIssuer: 'https://us.example.com',
}));

const redisState = vi.hoisted(() => ({
  available: true,
  setex: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return envState.oauthEnabled; },
  get OAUTH_ISSUER() { return envState.oauthIssuer; },
}));

const KEY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const KEY_B = '0b0b0b0b-0000-4000-8000-00000000000b';

type KeyOverrides = { id?: string; scopes?: string[]; mcpDomains?: unknown };
let currentKey: KeyOverrides = {};

const setApiKeyContext = (c: any) => {
  c.set('apiKey', {
    id: currentKey.id ?? KEY_A,
    orgId: 'org-1',
    name: 'test',
    keyPrefix: 'brz_test',
    mcpDomains: currentKey.mcpDomains ?? null,
    partnerId: 'partner-1',
    scopes: currentKey.scopes ?? ['ai:read'],
    rateLimit: 1000,
    createdBy: 'user-1',
    oauthGrantId: null,
  });
  c.set('apiKeyOrgId', 'org-1');
};

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware,
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => {
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const makeWhere = () => {
    const thenable = Promise.resolve(rows) as Promise<typeof rows> & {
      limit: (n: number) => Promise<typeof rows>;
    };
    thenable.limit = async () => rows;
    return thenable;
  };
  return {
    db: {
      select: (...args: unknown[]) => {
        mocks.dbSelect(...args);
        return { from: () => ({ where: makeWhere }) };
      },
    },
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
  partnerUsers: {
    userId: 'partner_users.user_id',
    partnerId: 'partner_users.partner_id',
    orgAccess: 'partner_users.org_access',
    orgIds: 'partner_users.org_ids',
  },
}));

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
        { resource: 'alerts', action: 'read' },
        { resource: 'alerts', action: 'write' },
        { resource: 'scripts', action: 'read' },
        { resource: 'scripts', action: 'write' },
        { resource: 'scripts', action: 'execute' },
        { resource: 'automations', action: 'read' },
        { resource: 'automations', action: 'write' },
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  aiTools: new Map(),
  getToolDefinitions: mocks.getToolDefinitions,
  executeTool: mocks.executeTool,
  getToolTier: mocks.getToolTier,
  getToolDomain: mocks.getToolDomain,
}));

vi.mock('../services/aiGuardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/aiGuardrails')>(),
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
  checkPermissionRequirement: (...args: unknown[]) => mocks.checkPermissionRequirement(...args),
  checkPermissionRequirements: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: vi.fn(),
  completeMcpToolExecutionLedger: vi.fn(),
}));

vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: vi.fn(async () => []),
  resolveTenantToolByName: vi.fn(async () => null),
  resolveTenantToolHealthByName: vi.fn(async () => ({ found: false })),
}));
vi.mock('../services/toolSources/execute', () => ({
  executeTenantTool: vi.fn(),
  executeTenantToolDetailed: vi.fn(),
}));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

const __sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => redisState.available
    ? { setex: redisState.setex, get: redisState.get }
    : null,
}));
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: mocks.captureMessage,
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => mocks.rateLimiter(...args),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

import { mcpServerRoutes } from './mcpServer';
import { __resetMcpHeaderMismatchWindowForTests } from '../services/mcpModernResult';
import { API_VERSION } from '../version';

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';
const UI_EXT = 'io.modelcontextprotocol/ui';
const APP_URI = 'ui://breeze/fleet-health/v1';
const UI_CAPS = { extensions: { [UI_EXT]: { mimeTypes: ['text/html;profile=mcp-app'] } } };

const FLEET_TOOL = {
  name: 'get_fleet_health',
  description: 'Fleet reliability scores.',
  input_schema: { type: 'object' as const, properties: { limit: { type: 'number' } } },
};
const OTHER_TOOL = {
  name: 'query_devices',
  description: 'Query devices.',
  input_schema: { type: 'object' as const, properties: { hostname: { type: 'string' } } },
};
const FLEET_OUTPUT = {
  devices: [{ deviceId: 'd1', hostname: 'ws-01.example.test', reliabilityScore: 42, trendDirection: 'degrading' }],
  showing: 1, limit: 25, offset: 0, total: 1, totalMode: 'exact', hasMore: false, nextCursor: null,
  summary: { criticalDevices: 1, poorDevices: 0, fairDevices: 0, goodDevices: 0, degradingDevices: 1, averageScore: 42 },
};

function app() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

function nameHeaderFor(method: string, params: Record<string, unknown>): string | undefined {
  if (method === 'tools/call' || method === 'prompts/get') return typeof params.name === 'string' ? params.name : undefined;
  if (method === 'resources/read') return typeof params.uri === 'string' ? params.uri : undefined;
  return undefined;
}

async function modern(method: string, opts: { params?: Record<string, unknown>; caps?: Record<string, unknown> } = {}) {
  const meta = { [PV]: '2026-07-28', [CAPS]: opts.caps ?? {}, [INFO]: { name: 'inspector', version: '1.0' } };
  const params = { ...(opts.params ?? {}), _meta: meta };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': 'k',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  const name = nameHeaderFor(method, params);
  if (name !== undefined) headers['Mcp-Name'] = name;
  return app().request('/mcp/sse', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

async function legacyInit(caps?: Record<string, unknown>) {
  const res = await app().request('/mcp/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', ...(caps ? { capabilities: caps } : {}), clientInfo: { name: 'host', version: '1' } },
    }),
  });
  expect(res.status).toBe(200);
  return { sessionId: res.headers.get('mcp-session-id')!, body: await res.json() };
}

async function legacy(method: string, sessionId: string, params?: Record<string, unknown>) {
  return app().request('/mcp/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) }),
  });
}

async function sse(method: string, params?: Record<string, unknown>) {
  return app().request('/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method, ...(params ? { params } : {}) }),
  });
}

function requestAuditRows() {
  return mocks.writeAuditEvent.mock.calls
    .map((call) => call[1] as Record<string, any>)
    .filter((e) => e.resourceType === 'mcp_request');
}

function sideKeyReads() {
  return redisState.get.mock.calls.filter((call) => String(call[0]).startsWith('mcp:session-ext:'));
}
function sideKeyWrites() {
  return redisState.setex.mock.calls.filter((call) => String(call[0]).startsWith('mcp:session-ext:'));
}

/** Strip the per-release parts so a snapshot pins only what W05 could change. */
function stableInit(result: Record<string, any>) {
  const { instructions, serverInfo, ...rest } = result;
  expect(typeof instructions).toBe('string');
  expect(serverInfo).toEqual({ name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION });
  return rest;
}

beforeEach(() => {
  process.env.MCP_STATELESS_ENABLED = 'true';
  delete process.env.MCP_APPS_ENABLED;
  envState.oauthEnabled = true;
  currentKey = {};
  redisState.available = true;
  __sessionStore.clear();
  redisState.setex.mockReset().mockImplementation(async (k: string, _ttl: number, v: string) => {
    __sessionStore.set(k, v);
    return 'OK';
  });
  redisState.get.mockReset().mockImplementation(async (k: string) => __sessionStore.get(k) ?? null);
  mocks.captureMessage.mockReset();
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify(FLEET_OUTPUT));
  mocks.getToolDefinitions.mockReset().mockReturnValue([FLEET_TOOL, OTHER_TOOL] as any);
  mocks.getToolTier.mockReset().mockImplementation((name: string) => (name === FLEET_TOOL.name || name === OTHER_TOOL.name ? 1 : undefined));
  mocks.getToolDomain.mockReset().mockReturnValue('devices');
  mocks.writeAuditEvent.mockReset();
  mocks.checkPermissionRequirement.mockReset().mockResolvedValue(null);
  mocks.dbSelect.mockReset();
  mocks.rateLimiter.mockReset().mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
  mocks.apiKeyAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c);
    return next();
  });
  mocks.bearerTokenAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c);
    return next();
  });
  __resetMcpHeaderMismatchWindowForTests();
});

afterEach(() => {
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_APPS_ENABLED;
});

// ---------------------------------------------------------------------------
// Flag off: pre-W05 bytes. These inline snapshots were captured against the
// server BEFORE any W05 change to routes/mcpServer.ts; they must never move.
// ---------------------------------------------------------------------------
describe('flag off: byte-identical to the pre-W05 server', () => {
  it('legacy streamable initialize (declaring or not) has the pre-W05 capabilities', async () => {
    const declaring = await legacyInit(UI_CAPS);
    const plain = await legacyInit();
    expect(declaring.body).toEqual(plain.body);
    expect(stableInit(declaring.body.result)).toMatchInlineSnapshot(`
      {
        "capabilities": {
          "prompts": {
            "listChanged": false,
          },
          "resources": {
            "listChanged": false,
            "subscribe": false,
          },
          "tools": {
            "listChanged": false,
          },
        },
        "protocolVersion": "2025-11-25",
      }
    `);
    expect(sideKeyWrites()).toHaveLength(0);
  });

  it('modern server/discover has the pre-W05 capabilities', async () => {
    const res = await modern('server/discover', { caps: UI_CAPS });
    const body = await res.json();
    const plain = await (await modern('server/discover')).json();
    expect(body).toEqual(plain);
    expect(body.result.capabilities).toMatchInlineSnapshot(`
      {
        "prompts": {},
        "resources": {},
        "tools": {},
      }
    `);
  });

  it('tools/list, resources/list, resources/templates/list are unchanged for a declaring client', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    const tools = await (await legacy('tools/list', sessionId)).json();
    expect(tools.result.tools.map((t: any) => ({ name: t.name, _meta: t._meta }))).toMatchInlineSnapshot(`
      [
        {
          "_meta": {
            "app.breeze/domain": "core",
          },
          "name": "get_action_status",
        },
        {
          "_meta": {
            "app.breeze/domain": "devices",
          },
          "name": "get_fleet_health",
        },
        {
          "_meta": {
            "app.breeze/domain": "devices",
          },
          "name": "query_devices",
        },
        {
          "_meta": {
            "app.breeze/domain": "core",
          },
          "name": "whoami",
        },
      ]
    `);
    // Raw serialization pins key order too (inline snapshots sort keys).
    expect(JSON.stringify(tools.result.tools.find((t: any) => t.name === 'get_fleet_health'))).toMatchInlineSnapshot(`"{"title":"Get fleet health","annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},"_meta":{"app.breeze/domain":"devices"},"name":"get_fleet_health","description":"Fleet reliability scores.","inputSchema":{"type":"object","properties":{"limit":{"type":"number"}}}}"`);
    expect(JSON.stringify(stableInit((await legacyInit(UI_CAPS)).body.result))).toMatchInlineSnapshot(`"{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"prompts":{"listChanged":false}}}"`);
    const modernTools = await (await modern('tools/list', { caps: UI_CAPS })).json();
    expect(modernTools.result.tools).toEqual(tools.result.tools);
    const resources = await (await legacy('resources/list', sessionId)).json();
    expect(resources.result).toMatchInlineSnapshot(`
      {
        "resources": [
          {
            "description": "List of all managed devices",
            "mimeType": "application/json",
            "name": "Device Inventory",
            "uri": "breeze://devices",
          },
          {
            "description": "Currently active alerts across all devices",
            "mimeType": "application/json",
            "name": "Active Alerts",
            "uri": "breeze://alerts",
          },
          {
            "description": "Available scripts for execution",
            "mimeType": "application/json",
            "name": "Script Library",
            "uri": "breeze://scripts",
          },
          {
            "description": "Configured automation rules",
            "mimeType": "application/json",
            "name": "Automation Rules",
            "uri": "breeze://automations",
          },
        ],
      }
    `);
    const templates = await (await legacy('resources/templates/list', sessionId)).json();
    expect(templates.result).toMatchInlineSnapshot(`
      {
        "resourceTemplates": [
          {
            "mimeType": "application/json",
            "name": "Device Detail",
            "uriTemplate": "breeze://devices/{id}",
          },
        ],
      }
    `);
    expect(sideKeyReads()).toHaveLength(0);
    expect(mocks.checkPermissionRequirement).not.toHaveBeenCalled();
  });

  it('resources/read of the app URI answers the unknown-URI body', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    const body = await (await legacy('resources/read', sessionId, { uri: APP_URI })).json();
    expect(body).toMatchInlineSnapshot(`
      {
        "error": {
          "code": -32602,
          "message": "Unknown resource URI: ui://breeze/fleet-health/v1",
        },
        "id": 2,
        "jsonrpc": "2.0",
      }
    `);
  });

  it('tools/call get_fleet_health result is the plain text + structured result', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    const body = await (await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} })).json();
    expect(body.result).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "{"devices":[{"deviceId":"d1","hostname":"ws-01.example.test","reliabilityScore":42,"trendDirection":"degrading"}],"showing":1,"limit":25,"offset":0,"total":1,"totalMode":"exact","hasMore":false,"nextCursor":null,"summary":{"criticalDevices":1,"poorDevices":0,"fairDevices":0,"goodDevices":0,"degradingDevices":1,"averageScore":42}}",
            "type": "text",
          },
        ],
        "structuredContent": {
          "devices": [
            {
              "deviceId": "d1",
              "hostname": "ws-01.example.test",
              "reliabilityScore": 42,
              "trendDirection": "degrading",
            },
          ],
          "hasMore": false,
          "limit": 25,
          "nextCursor": null,
          "offset": 0,
          "showing": 1,
          "summary": {
            "averageScore": 42,
            "criticalDevices": 1,
            "degradingDevices": 1,
            "fairDevices": 0,
            "goodDevices": 0,
            "poorDevices": 0,
          },
          "total": 1,
          "totalMode": "exact",
        },
      }
    `);
    const rows = requestAuditRows();
    for (const row of rows) {
      expect(row.details).not.toHaveProperty('uiExtension');
      expect(row.details).not.toHaveProperty('mcpApp');
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2: negotiation in both eras + advertisement (flag on)
// ---------------------------------------------------------------------------
describe('flag on: negotiation and advertisement (D-B40, D-B42)', () => {
  beforeEach(() => {
    process.env.MCP_APPS_ENABLED = 'true';
  });

  it('streamable initialize advertises extensions["io.modelcontextprotocol/ui"] = {} to every client', async () => {
    for (const caps of [UI_CAPS, undefined]) {
      const { body } = await legacyInit(caps);
      expect(body.result.capabilities).toEqual({
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        extensions: { [UI_EXT]: {} },
      });
    }
  });

  it('modern server/discover advertises the extension', async () => {
    const body = await (await modern('server/discover')).json();
    expect(body.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {}, extensions: { [UI_EXT]: {} } });
  });

  it('HTTP+SSE /message initialize never advertises it, flag on or off', async () => {
    const on = await (await sse('initialize', { protocolVersion: '2024-11-05', capabilities: UI_CAPS })).json();
    expect(on.result.capabilities).not.toHaveProperty('extensions');
    delete process.env.MCP_APPS_ENABLED;
    const off = await (await sse('initialize', { protocolVersion: '2024-11-05', capabilities: UI_CAPS })).json();
    expect(off.result).toEqual(on.result);
  });

  it('legacy initialize declaring ui writes the side key with MCP_SESSION_TTL_SECONDS right after the ownership key', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    const keys = redisState.setex.mock.calls.map((call) => String(call[0]));
    expect(keys).toEqual([`mcp-session:${sessionId}`, `mcp:session-ext:${sessionId}`]);
    const [ownership, side] = redisState.setex.mock.calls;
    expect(side![1]).toBe(ownership![1]);
    expect(side![1]).toBe(11 * 60);
    expect(side![2]).toBe('{"ui":true}');
  });

  it('legacy initialize not declaring ui, or flag off, writes nothing', async () => {
    await legacyInit();
    await legacyInit({ extensions: { [UI_EXT]: {} } });
    await legacyInit({ extensions: { [UI_EXT]: { mimeTypes: ['text/html'] } } });
    expect(sideKeyWrites()).toHaveLength(0);
    delete process.env.MCP_APPS_ENABLED;
    await legacyInit(UI_CAPS);
    expect(sideKeyWrites()).toHaveLength(0);
  });

  it('legacy tools/list, resources/read and tools/call read the side key at most once per request; prompts/list never does', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    for (const [method, params] of [
      ['tools/list', undefined],
      ['resources/read', { uri: APP_URI }],
      ['tools/call', { name: 'get_fleet_health', arguments: {} }],
    ] as const) {
      redisState.get.mockClear();
      const res = await legacy(method, sessionId, params as Record<string, unknown> | undefined);
      expect(res.status).toBe(200);
      expect(sideKeyReads()).toHaveLength(1);
      expect(sideKeyReads()[0]![0]).toBe(`mcp:session-ext:${sessionId}`);
    }
    for (const method of ['prompts/list', 'resources/list', 'resources/templates/list']) {
      redisState.get.mockClear();
      await legacy(method, sessionId);
      expect(sideKeyReads()).toHaveLength(0);
    }
  });

  it('flag off: no legacy request ever reads the side key', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    delete process.env.MCP_APPS_ENABLED;
    redisState.get.mockClear();
    await legacy('tools/list', sessionId);
    await legacy('resources/read', sessionId, { uri: APP_URI });
    await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} });
    expect(sideKeyReads()).toHaveLength(0);
  });

  it('a session presented by a foreign principal is rejected before any side-key read', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    currentKey = { id: KEY_B };
    redisState.get.mockClear();
    const res = await legacy('tools/list', sessionId);
    expect(res.status).toBe(404);
    expect(sideKeyReads()).toHaveLength(0);
  });

  it('side-key miss or Redis error degrades to text-only, never a 5xx', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    // Expired side key while the ownership key is still live.
    __sessionStore.delete(`mcp:session-ext:${sessionId}`);
    let res = await legacy('tools/list', sessionId);
    expect(res.status).toBe(200);
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
    // Redis throws on the side-key read only (ownership read still succeeds).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisState.get.mockImplementation(async (k: string) => {
      if (k.startsWith('mcp:session-ext:')) throw new Error('redis down');
      return __sessionStore.get(k) ?? null;
    });
    res = await legacy('tools/list', sessionId);
    expect(res.status).toBe(200);
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
    warn.mockRestore();
  });

  it('audit details carry uiExtension: true only when declared; key absent otherwise', async () => {
    const declaring = await legacyInit(UI_CAPS);
    expect(requestAuditRows().at(-1)!.details.uiExtension).toBe(true);
    await legacy('tools/list', declaring.sessionId);
    expect(requestAuditRows().at(-1)!.details.uiExtension).toBe(true);
    const plain = await legacyInit();
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
    await legacy('tools/list', plain.sessionId);
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
  });

  it('modern request declaring ui resolves ui (asserted through the audit row)', async () => {
    await modern('tools/list', { caps: UI_CAPS });
    expect(requestAuditRows().at(-1)!.details.uiExtension).toBe(true);
    await modern('tools/list');
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
    expect(sideKeyReads()).toHaveLength(0);
  });

  it('/message (HTTP+SSE) never resolves ui', async () => {
    await sse('initialize', { protocolVersion: '2024-11-05', capabilities: UI_CAPS });
    await sse('tools/list');
    for (const row of requestAuditRows()) expect(row.details).not.toHaveProperty('uiExtension');
    expect(sideKeyReads()).toHaveLength(0);
    expect(sideKeyWrites()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4: the gated tools/list `_meta.ui` and resources/read (D-B43)
// ---------------------------------------------------------------------------
const UI_META = { resourceUri: APP_URI, visibility: ['model'] };
const unknownUri = (id: number, uri: string) => ({
  jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource URI: ${uri}` },
});

async function listFor(era: 'legacy' | 'modern', caps?: Record<string, unknown>) {
  if (era === 'modern') return (await (await modern('tools/list', { caps })).json()).result.tools as any[];
  const { sessionId } = await legacyInit(caps);
  return (await (await legacy('tools/list', sessionId)).json()).result.tools as any[];
}

async function readFor(era: 'legacy' | 'modern', uri: string, caps?: Record<string, unknown>) {
  if (era === 'modern') return modern('resources/read', { params: { uri }, caps });
  const { sessionId } = await legacyInit(caps);
  return legacy('resources/read', sessionId, { uri });
}

async function callFor(era: 'legacy' | 'modern', name: string, caps?: Record<string, unknown>) {
  if (era === 'modern') return modern('tools/call', { params: { name, arguments: {} }, caps });
  const { sessionId } = await legacyInit(caps);
  return legacy('tools/call', sessionId, { name, arguments: {} });
}

describe.each(['legacy', 'modern'] as const)('flag on, %s era: tools/list _meta.ui', (era) => {
  beforeEach(() => {
    process.env.MCP_APPS_ENABLED = 'true';
  });

  it('declaring client: get_fleet_health has _meta.ui and keeps app.breeze/domain; no other entry changes', async () => {
    const declared = await listFor(era, UI_CAPS);
    const plain = await listFor(era);
    const fleet = declared.find((t) => t.name === 'get_fleet_health');
    expect(fleet._meta).toEqual({ 'app.breeze/domain': 'devices', ui: UI_META });
    // The entry's key order is unchanged; only `_meta` gained `ui`.
    expect(Object.keys(fleet)).toEqual(Object.keys(plain.find((t) => t.name === 'get_fleet_health')));
    expect(declared.filter((t) => t.name !== 'get_fleet_health')).toEqual(plain.filter((t) => t.name !== 'get_fleet_health'));
    expect(declared.map((t) => t.name)).toEqual(plain.map((t) => t.name));
    expect({ ...fleet, _meta: { 'app.breeze/domain': 'devices' } }).toEqual(plain.find((t) => t.name === 'get_fleet_health'));
    expect(mocks.checkPermissionRequirement).toHaveBeenCalledWith(expect.anything(), { resource: 'devices', action: 'read' });
  });

  it('non-declaring client or flag off: tools/list has no _meta.ui; checkPermissionRequirement not called', async () => {
    const plain = await listFor(era);
    expect(plain.some((t) => t._meta?.ui !== undefined)).toBe(false);
    for (const caps of [{ extensions: { [UI_EXT]: {} } }, { extensions: { [UI_EXT]: { mimeTypes: ['text/html'] } } }]) {
      expect(await listFor(era, caps)).toEqual(plain);
    }
    delete process.env.MCP_APPS_ENABLED;
    expect(await listFor(era, UI_CAPS)).toEqual(plain);
    expect(mocks.checkPermissionRequirement).not.toHaveBeenCalled();
  });

  it('restricted grant or missing devices.read: no _meta.ui and no view', async () => {
    // A domain-restricted key without `devices`.
    currentKey = { mcpDomains: ['tickets'] };
    let tools = await listFor(era, UI_CAPS);
    expect(tools.some((t) => t._meta?.ui !== undefined)).toBe(false);
    let body = await (await readFor(era, APP_URI, UI_CAPS)).json();
    const nope = await (await readFor(era, 'ui://breeze/nope', UI_CAPS)).json();
    expect(body.error).toEqual(unknownUri(1, APP_URI).error);
    expect(nope.error).toEqual(unknownUri(1, 'ui://breeze/nope').error);
    expect(body.error).not.toHaveProperty('data');

    // A role without devices.read.
    currentKey = {};
    mocks.checkPermissionRequirement.mockResolvedValue('Permission denied: devices.read required');
    tools = await listFor(era, UI_CAPS);
    expect(tools.find((t) => t.name === 'get_fleet_health')._meta).toEqual({ 'app.breeze/domain': 'devices' });
    body = await (await readFor(era, APP_URI, UI_CAPS)).json();
    expect(body.error).toEqual(unknownUri(1, APP_URI).error);
  });

  it('a throwing permission check fails closed: no _meta.ui, unknown-URI body, never a 5xx', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.checkPermissionRequirement.mockRejectedValue(new Error('db down'));
    const listRes = era === 'modern' ? await modern('tools/list', { caps: UI_CAPS }) : null;
    if (listRes) expect(listRes.status).toBe(200);
    const tools = await listFor(era, UI_CAPS);
    expect(tools.find((t) => t.name === 'get_fleet_health')._meta).toEqual({ 'app.breeze/domain': 'devices' });
    const res = await readFor(era, APP_URI, UI_CAPS);
    expect(res.status).toBe(200);
    expect((await res.json()).error).toEqual(unknownUri(1, APP_URI).error);
    error.mockRestore();
  });

  it('resources/list and resources/templates/list are unchanged for a declaring client', async () => {
    if (era === 'modern') {
      const a = await (await modern('resources/list', { caps: UI_CAPS })).json();
      const b = await (await modern('resources/list')).json();
      expect(a).toEqual(b);
      const c = await (await modern('resources/templates/list', { caps: UI_CAPS })).json();
      const d = await (await modern('resources/templates/list')).json();
      expect(c).toEqual(d);
      return;
    }
    const declaring = await legacyInit(UI_CAPS);
    const plain = await legacyInit();
    for (const method of ['resources/list', 'resources/templates/list']) {
      const a = await (await legacy(method, declaring.sessionId)).json();
      const b = await (await legacy(method, plain.sessionId)).json();
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toContain('ui://');
    }
  });

  it('tools/call get_fleet_health is identical for declaring and non-declaring clients (text parity)', async () => {
    const declared = await (await callFor(era, 'get_fleet_health', UI_CAPS)).json();
    const plain = await (await callFor(era, 'get_fleet_health')).json();
    expect(declared.result).toEqual(plain.result);
    expect(JSON.stringify(declared.result)).toBe(JSON.stringify(plain.result));
    expect(declared.result.structuredContent).toEqual(FLEET_OUTPUT);
    expect(declared.result.content).toEqual([{ type: 'text', text: JSON.stringify(FLEET_OUTPUT) }]);
    expect(declared.result._meta?.ui).toBeUndefined();
    if (era === 'legacy') expect(declared.result).not.toHaveProperty('_meta');
  });
});

describe('flag on: resources/read of the app URI (D-B43)', () => {
  beforeEach(() => {
    process.env.MCP_APPS_ENABLED = 'true';
  });

  type Row = { flagOn: boolean; declared: boolean; listed: boolean; permitted: boolean };
  const rows: Row[] = [];
  for (let mask = 0; mask < 16; mask += 1) {
    rows.push({ flagOn: (mask & 1) !== 0, declared: (mask & 2) !== 0, listed: (mask & 4) !== 0, permitted: (mask & 8) !== 0 });
  }

  async function setUp(row: Row) {
    if (!row.flagOn) delete process.env.MCP_APPS_ENABLED;
    currentKey = row.listed ? {} : { mcpDomains: ['tickets'] };
    mocks.checkPermissionRequirement.mockResolvedValue(row.permitted ? null : 'Permission denied');
    const { sessionId } = await legacyInit(row.declared ? UI_CAPS : undefined);
    return sessionId;
  }

  it.each(rows)('resources/read gate matrix: %j', async (row) => {
    const sessionId = await setUp(row);
    const res = await legacy('resources/read', sessionId, { uri: APP_URI });
    expect(res.status).toBe(200);
    const body = await res.json();
    if (row.flagOn && row.declared && row.listed && row.permitted) {
      expect(body.error).toBeUndefined();
      expect(body.result.contents).toHaveLength(1);
      const [content] = body.result.contents;
      expect(content.uri).toBe(APP_URI);
      expect(content.mimeType).toBe('text/html;profile=mcp-app');
      const { FLEET_HEALTH_VIEW_HTML } = await import('../services/mcpApps/fleetHealthView');
      expect(content.text).toBe(FLEET_HEALTH_VIEW_HTML);
      expect(content._meta).toEqual({ ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } });
    } else {
      expect(body).toEqual(unknownUri(2, APP_URI));
    }
  });

  it('serves the view with no DB read beyond what an unknown URI costs', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    mocks.dbSelect.mockClear();
    await legacy('resources/read', sessionId, { uri: 'ui://breeze/nope' });
    const baseline = mocks.dbSelect.mock.calls.length;
    mocks.dbSelect.mockClear();
    const body = await (await legacy('resources/read', sessionId, { uri: APP_URI })).json();
    expect(body.result.contents).toHaveLength(1);
    expect(mocks.dbSelect.mock.calls.length).toBe(baseline);
  });

  it.each(['ui://breeze/fleet-health/v2', 'ui://breeze/fleet-health/v1?x', 'ui://breeze/fleet-health/v1/', 'UI://breeze/fleet-health/v1'])(
    '%s falls through to unknown-URI even when everything else holds',
    async (uri) => {
      const { sessionId } = await legacyInit(UI_CAPS);
      expect(await (await legacy('resources/read', sessionId, { uri })).json()).toEqual(unknownUri(2, uri));
    },
  );

  it('existing breeze:// resources still read as before for a declaring client', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    const body = await (await legacy('resources/read', sessionId, { uri: 'breeze://secrets' })).json();
    expect(body).toEqual(unknownUri(2, 'breeze://secrets'));
  });

  it('modern era: resources/read result decorated with resultType complete, ttlMs 0, cacheScope private', async () => {
    const body = await (await modern('resources/read', { params: { uri: APP_URI }, caps: UI_CAPS })).json();
    expect(body.result.resultType).toBe('complete');
    expect(body.result.ttlMs).toBe(0);
    expect(body.result.cacheScope).toBe('private');
    expect(body.result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    const plain = await (await modern('resources/read', { params: { uri: APP_URI } })).json();
    expect(plain.error).toEqual(unknownUri(1, APP_URI).error);
  });

  it('HTTP+SSE /message never serves the view', async () => {
    const body = await (await sse('resources/read', { uri: APP_URI })).json();
    expect(body).toEqual(unknownUri(3, APP_URI));
  });

  it('audit: resources/read of the app and tools/call of get_fleet_health carry mcpApp fleet-health/v1; other calls do not', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    await legacy('resources/read', sessionId, { uri: APP_URI });
    expect(requestAuditRows().at(-1)!.details).toMatchObject({ mcpApp: 'fleet-health/v1', uiExtension: true });
    await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} });
    expect(requestAuditRows().at(-1)!.details).toMatchObject({ mcpApp: 'fleet-health/v1', uiExtension: true });
    await legacy('tools/call', sessionId, { name: 'query_devices', arguments: {} });
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('mcpApp');
    await legacy('tools/list', sessionId);
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('mcpApp');
    await legacy('resources/read', sessionId, { uri: 'ui://breeze/fleet-health/v2' });
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('mcpApp');
    // A non-declaring caller's tools/call of the app tool is counted, without uiExtension.
    const plain = await legacyInit();
    await legacy('tools/call', plain.sessionId, { name: 'get_fleet_health', arguments: {} });
    expect(requestAuditRows().at(-1)!.details.mcpApp).toBe('fleet-health/v1');
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('uiExtension');
    // A denied read of the app URI is not counted as a fetch.
    mocks.checkPermissionRequirement.mockResolvedValue('Permission denied');
    await legacy('resources/read', sessionId, { uri: APP_URI });
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('mcpApp');
  });

  it('audit: a denied tools/call of get_fleet_health still carries mcpApp, with result failure (the go/no-go reads result)', async () => {
    currentKey = { mcpDomains: ['tickets'] };
    const { sessionId } = await legacyInit(UI_CAPS);
    const body = await (await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} })).json();
    expect(body.error).toMatchObject({ code: -32003 });
    expect(requestAuditRows().at(-1)).toMatchObject({ result: 'failure', details: { mcpApp: 'fleet-health/v1', uiExtension: true } });
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('degraded side key (expired or Redis error): no _meta.ui and the unknown-URI body, never a 5xx', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    __sessionStore.delete(`mcp:session-ext:${sessionId}`);
    let tools = (await (await legacy('tools/list', sessionId)).json()).result.tools as any[];
    expect(tools.find((t) => t.name === 'get_fleet_health')._meta).toEqual({ 'app.breeze/domain': 'devices' });
    expect(await (await legacy('resources/read', sessionId, { uri: APP_URI })).json()).toEqual(unknownUri(2, APP_URI));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await legacyInit(UI_CAPS);
    redisState.get.mockImplementation(async (k: string) => {
      if (k.startsWith('mcp:session-ext:')) throw new Error('redis down');
      return __sessionStore.get(k) ?? null;
    });
    const listRes = await legacy('tools/list', second.sessionId);
    expect(listRes.status).toBe(200);
    tools = (await listRes.json()).result.tools;
    expect(tools.find((t) => t.name === 'get_fleet_health')._meta).toEqual({ 'app.breeze/domain': 'devices' });
    const readRes = await legacy('resources/read', second.sessionId, { uri: APP_URI });
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual(unknownUri(2, APP_URI));
    warn.mockRestore();
  });

  it('the side key is written once on initialize and never refreshed by later requests', async () => {
    const { sessionId } = await legacyInit(UI_CAPS);
    expect(sideKeyWrites()).toHaveLength(1);
    await legacy('tools/list', sessionId);
    await legacy('resources/read', sessionId, { uri: APP_URI });
    await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} });
    expect(sideKeyWrites()).toHaveLength(1);
  });

  it('flag off: tools/call of get_fleet_health carries no mcpApp', async () => {
    delete process.env.MCP_APPS_ENABLED;
    const { sessionId } = await legacyInit(UI_CAPS);
    await legacy('tools/call', sessionId, { name: 'get_fleet_health', arguments: {} });
    expect(requestAuditRows().at(-1)!.details).not.toHaveProperty('mcpApp');
  });
});
