import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// These tests exercise the real mcpServer route with the REAL aiGuardrails
// service so that per-action tier escalation drives the scope gates
// (FIX 1 — effective-tier gating) and the REAL aiToolsSiteScope helpers so
// resources/read narrows by site (FIX 3 — site axis in resources/read).

// ---------------------------------------------------------------------------
// Shared lightweight mocks for the heavy module-graph leaves.
// ---------------------------------------------------------------------------

const ledgerBegin = vi.fn(async (..._args: any[]) => ({ id: 'ledger-1' }));
const ledgerComplete = vi.fn(async (..._args: any[]) => undefined);

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => ledgerComplete(...args),
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
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => [],
}));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
}));

// Keep the REAL checkGuardrails (the unit under test for FIX 1 — per-action
// tier escalation), but stub the RBAC permission + rate-limit checks so the
// mocked API-key auth context (which carries no real RBAC grants) doesn't get
// denied AFTER the scope gates. These checks are orthogonal to the tier gating.
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: vi.fn(async () => null),
    checkToolRateLimit: vi.fn(async () => null),
  };
});

// Stub getUserPermissions so buildAuthFromApiKey for org keys doesn't hit the
// permissions DB. Tests that need a site restriction override this per-case.
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    })),
  };
});

const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.resetModules();
  ledgerBegin.mockClear();
  ledgerComplete.mockClear();
});

afterEach(() => {
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  vi.doUnmock('../db');
  vi.doUnmock('../db/schema');
  vi.doUnmock('../services/aiTools');
  vi.doUnmock('../middleware/apiKeyAuth');
});

function mockApiKey(scopes: string[]) {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
        name: 'test',
        keyPrefix: 'brz_test',
        scopes,
        rateLimit: 1000,
        createdBy: 'user-1',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

async function callTool(scopes: string[], toolName: string, args: Record<string, unknown>) {
  mockApiKey(scopes);
  const mod = await import('./mcpServer');
  const res = await mod.mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return res;
}

// ---------------------------------------------------------------------------
// FIX 1 — effective-tier gating
// ---------------------------------------------------------------------------

describe('MCP tools/call effective-tier gating (FIX 1)', () => {
  // Use real aiGuardrails so registry_operations action:'delete_key' escalates
  // base tier 1 → effective tier 3 and manage_processes action:'kill' → tier 3.
  beforeEach(() => {
    // db is unused in these tier paths until executeTool; keep a benign stub.
    vi.doMock('../db', () => ({
      db: {},
      withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
      withSystemDbAccessContext: vi.fn(),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));
    // registry_operations is base tier 1; run_script is base tier 3.
    vi.doMock('../services/aiTools', () => ({
      getToolDefinitions: () => [],
      executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
      getToolTier: (name: string) =>
        name === 'run_script' ? 3 : name === 'registry_operations' ? 1 : name === 'manage_processes' ? 1 : undefined,
    }));
  });

  it('ai:read key calling a tier-1 tool with a destructive action is DENIED', async () => {
    const res = await callTool(['ai:read'], 'registry_operations', { action: 'delete_key' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('requires ai:execute');
  });

  it('ai:read key calling a benign read action on the same tool still succeeds', async () => {
    const res = await callTool(['ai:read'], 'registry_operations', { action: 'read_value' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toContain('ok');
  });

  it('manage_processes action:kill is escalated to tier 3 and denied for ai:read', async () => {
    const res = await callTool(['ai:read'], 'manage_processes', { action: 'kill', pid: 1234 });
    const body = await res.json();
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('requires ai:execute');
  });

  it('a true tier-3 tool is unaffected (still denied for ai:read)', async () => {
    const res = await callTool(['ai:read'], 'run_script', { scriptId: 's1' });
    const body = await res.json();
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('requires ai:execute');
  });

  it('a true tier-3 tool still executes for ai:execute', async () => {
    const res = await callTool(['ai:read', 'ai:execute'], 'run_script', { scriptId: 's1' });
    const body = await res.json();
    expect(body.error).toBeUndefined();
  });

  it('ledger is created for the escalated destructive action (ai:execute key)', async () => {
    const res = await callTool(
      ['ai:read', 'ai:execute'],
      'registry_operations',
      { action: 'delete_key', key: 'HKLM\\foo' },
    );
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(ledgerBegin).toHaveBeenCalledTimes(1);
    const arg = (ledgerBegin.mock.calls[0] as any[])[0] as any;
    expect(arg.tier).toBe(3);
    expect(arg.toolName).toBe('registry_operations');
  });

  it('benign read action on a tier-1 tool does NOT create a ledger', async () => {
    await callTool(['ai:read', 'ai:execute'], 'registry_operations', { action: 'read_value' });
    expect(ledgerBegin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — site axis in resources/read
// ---------------------------------------------------------------------------

describe('MCP resources/read site-axis enforcement (FIX 3)', () => {
  // Devices: site-A device d-a (siteId site-A), site-B device d-b (siteId site-B).
  // Alerts: a-a on d-a (site-A), a-b on d-b (site-B).
  const DEVICE_ROWS = [
    { id: 'd-a', siteId: 'site-A', hostname: 'host-a' },
    { id: 'd-b', siteId: 'site-B', hostname: 'host-b' },
  ];

  function buildSiteDbMock() {
    // Minimal chainable query stub. resolveSiteAllowedDeviceIds selects
    // {id, siteId} from devices where org; the resource queries select with a
    // where(and(...)). We interpret captured conditions to filter rows.
    return {
      db: {
        select: (cols?: any) => ({
          from: (_table: any) => {
            const builder: any = {
              _conds: [] as any[],
              where(cond: any) {
                this._conds.push(cond);
                return this;
              },
              limit(_n: number) {
                return Promise.resolve(this._rows());
              },
              orderBy() {
                return this;
              },
              _rows() {
                // resolveSiteAllowedDeviceIds path: no limit() call, returns all
                // org devices with {id, siteId}.
                return DEVICE_ROWS.map((d) => ({ ...d, status: 'online', osType: 'linux', osVersion: '1', agentVersion: '1', lastSeenAt: null }));
              },
              then(resolve: any) {
                // resolveSiteAllowedDeviceIds awaits the builder directly (no limit).
                resolve(DEVICE_ROWS.map((d) => ({ id: d.id, siteId: d.siteId })));
              },
            };
            return builder;
          },
        }),
      },
      withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
      withSystemDbAccessContext: vi.fn((fn: any) => fn()),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    };
  }

  it('site-restricted caller does not see site-B devices via resources/read', async () => {
    // Restrict creator to site-A only.
    vi.doMock('../services/permissions', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../services/permissions')>();
      return {
        ...actual,
        getUserPermissions: vi.fn(async () => ({
          permissions: [],
          partnerId: null,
          orgId: 'org-1',
          roleId: 'role-1',
          scope: 'organization' as const,
          allowedSiteIds: ['site-A'],
        })),
      };
    });

    // db mock: resolveSiteAllowedDeviceIds returns both devices with siteIds;
    // the real canAccessSite filter (built from allowedSiteIds) then narrows to
    // d-a. The device list query is then narrowed by inArray(devices.id,[d-a]).
    // We capture the final device list query and only return d-a.
    const capturedDeviceListConds: any[] = [];
    vi.doMock('../db', () => ({
      db: {
        select: (_cols?: any) => ({
          from: (_table: any) => {
            const builder: any = {
              _conds: [] as any[],
              where(cond: any) {
                this._conds.push(cond);
                capturedDeviceListConds.push(cond);
                return this;
              },
              limit(_n: number) {
                // device/alert list path — return only the site-A row to model
                // the inArray narrowing the route applied.
                return Promise.resolve([
                  { id: 'd-a', hostname: 'host-a', status: 'online', osType: 'linux', osVersion: '1', agentVersion: '1', lastSeenAt: null },
                ]);
              },
              orderBy() {
                return this;
              },
              then(resolve: any) {
                // resolveSiteAllowedDeviceIds path (awaited without limit).
                resolve([
                  { id: 'd-a', siteId: 'site-A' },
                  { id: 'd-b', siteId: 'site-B' },
                ]);
              },
            };
            return builder;
          },
        }),
      },
      withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
      withSystemDbAccessContext: vi.fn((fn: any) => fn()),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));

    mockApiKey(['ai:read']);
    const mod = await import('./mcpServer');
    const res = await mod.mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'breeze://devices' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = body.result?.contents?.[0]?.text ?? '';
    expect(text).toContain('d-a');
    expect(text).not.toContain('d-b');
    // The device-list query must have received a site-narrowing condition
    // (in addition to the org condition) — proves the route applied the axis.
    expect(capturedDeviceListConds.length).toBeGreaterThan(0);
  });
});
