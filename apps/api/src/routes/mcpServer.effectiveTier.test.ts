import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// These tests exercise the real mcpServer route with the REAL aiGuardrails
// service so that per-action tier escalation drives the scope gates
// (FIX 1 — effective-tier gating) and the REAL aiToolsSiteScope helpers so
// resources/read narrows by site (FIX 3 — site axis in resources/read).

// ---------------------------------------------------------------------------
// Shared lightweight mocks for the heavy module-graph leaves.
// ---------------------------------------------------------------------------

const testState = vi.hoisted(() => ({
  scopes: ['ai:read'] as string[],
  permissions: [] as Array<{ resource: string; action: string }>,
  allowedSiteIds: undefined as string[] | undefined,
}));

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: (...args: any[]) => mocks.dbSelect(...args) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

// Keep schema initialization out of the timed test bodies while still giving
// Drizzle real table/column objects for eq/inArray/getTableColumns.
vi.mock('../db/schema', async () => {
  const { boolean, jsonb, pgTable, text, timestamp } = await import('drizzle-orm/pg-core');
  return {
    devices: pgTable('test_devices', {
      id: text('id'), orgId: text('org_id'), siteId: text('site_id'), hostname: text('hostname'),
      status: text('status', { enum: ['online', 'offline'] }), osType: text('os_type'),
      osVersion: text('os_version'), agentVersion: text('agent_version'), lastSeenAt: timestamp('last_seen_at'),
    }),
    alerts: pgTable('test_alerts', {
      id: text('id'), orgId: text('org_id'), title: text('title'), severity: text('severity'),
      status: text('status', { enum: ['active', 'resolved'] }), deviceId: text('device_id'),
      triggeredAt: timestamp('triggered_at'),
    }),
    scripts: pgTable('test_scripts', {
      id: text('id'), orgId: text('org_id'), partnerId: text('partner_id'), name: text('name'),
      description: text('description'), language: text('language'), category: text('category'),
      deletedAt: timestamp('deleted_at'),
    }),
    automations: pgTable('test_automations', {
      id: text('id'), orgId: text('org_id'), partnerId: text('partner_id'), name: text('name'),
      description: text('description'), enabled: boolean('enabled'), trigger: jsonb('trigger'),
    }),
    organizations: pgTable('test_organizations', {
      id: text('id'), partnerId: text('partner_id'), createdAt: timestamp('created_at'),
    }),
    partners: pgTable('test_partners', { id: text('id'), billingEmail: text('billing_email') }),
  };
});

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    c.set('apiKey', {
      id: 'key-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      scopes: testState.scopes,
      rateLimit: 1000,
      createdBy: 'user-1',
    });
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: (...args: any[]) => mocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (...args: any[]) => mocks.getToolTier(...args),
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

vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));

vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001',
}));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  // Task 6 routed the ordinary Tier 3 path through resolveMcpExecutionContext +
  // McpExecutionOrgError (replacing the bare resolveMcpExecutionOrgId call). This
  // mock must export both or the route's execution-org resolution throws before
  // the ledger/tier assertions below can run.
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

// Keep the REAL checkGuardrails (the unit under test for FIX 1 — per-action
// tier escalation), but stub the RBAC permission + rate-limit checks so the
// mocked API-key auth context (which carries no real RBAC grants) doesn't get
// denied AFTER the scope gates. These checks are orthogonal to the tier gating.
//
// checkPermissionRequirement (MCP-OAUTH-03 resource RBAC, used by
// resources/read) is stubbed here too, for the same reason: the FIX-3
// site-axis tests below exercise site narrowing, not RBAC. The dedicated
// resource-RBAC suite retains the real permission primitive.
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: vi.fn(async () => null),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
  };
});

// Stub getUserPermissions so buildAuthFromApiKey for org keys doesn't hit the
// permissions DB. Site-axis cases mutate only allowedSiteIds, without
// rebuilding the route graph. Keep the real hasPermission helper for the
// real guardrails.
//
// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now
// re-validates a key's stored scopes against these permissions via
// authorizeHumanApiKeyCreator before an AuthContext is ever built — the
// single getUserPermissions() call in this flow (checkToolPermission and
// checkPermissionRequirement are BOTH stubbed to `null` for this whole file,
// so neither makes its own separate call) has to double as that coarse
// scope-ceiling check. `permissions` is therefore always this fixed FULL
// baseline — covering devices/alerts/scripts/automations read/write/execute,
// a superset of every `ai:read`/`ai:write`/`ai:execute` combination this file
// exercises — never `testState.permissions`; the fine-grained RBAC these
// tests actually target is stubbed out, so what the mock returns for
// `permissions` doesn't drive any assertion. `allowedSiteIds` is the one
// field the site-axis (FIX 3) tests DO depend on, so it stays testState-driven.
const FULL_PERMISSIONS_BASELINE = [
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
];

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: FULL_PERMISSIONS_BASELINE,
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: testState.allowedSiteIds,
    })),
  };
});

import { mcpServerRoutes } from './mcpServer';

const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read'];
  testState.permissions = [];
  testState.allowedSiteIds = undefined;
  mocks.dbSelect.mockReset().mockImplementation(() => {
    throw new Error('Unexpected db.select call');
  });
  mocks.executeTool.mockReset();
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
});

afterEach(() => {
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
});

async function callTool(scopes: string[], toolName: string, args: Record<string, unknown>) {
  testState.scopes = scopes;
  const res = await mcpServerRoutes.request('/message', {
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
    // registry_operations / manage_processes / manage_patches are base tier 1;
    // run_script is base tier 3; security_scan is base tier 2 (its
    // action:'vulnerabilities' downgrades to tier 1 in guardrails — used by the
    // downgrade-clamp test to prove Math.max ignores the downgrade).
    mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
    mocks.getToolTier.mockImplementation((name: string) =>
      name === 'run_script'
        ? 3
        : name === 'security_scan'
          ? 2
          : name === 'registry_operations' ||
              name === 'manage_processes' ||
              name === 'manage_patches'
            ? 1
            : undefined,
    );
  });

  // C1 — tier-2 escalation: manage_patches is base tier 1, action:'approve'
  // escalates to tier 2 (TIER2_ACTIONS). An ai:read-only key is denied with a
  // message naming ai:write; an ai:write key (no ai:execute) succeeds.
  it('C1: ai:read key calling base-tier-1 manage_patches {approve} is denied (requires ai:write)', async () => {
    const res = await callTool(['ai:read'], 'manage_patches', { action: 'approve', patchId: 'p1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('requires ai:write');
  });

  it('C1: ai:write key (no ai:execute) calling manage_patches {approve} succeeds', async () => {
    const res = await callTool(['ai:read', 'ai:write'], 'manage_patches', { action: 'approve', patchId: 'p1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toContain('ok');
  });

  // C3 — the audit event records the EFFECTIVE (escalated) tier, not the base
  // tier. registry_operations base tier 1 + action:'delete_key' → tier 3; the
  // ledger already asserts tier:3 (in the existing ledger test), so here we
  // assert the audit-event payload carries details.tier === 3.
  it('C3: audit event records the escalated effective tier (3), not base tier (1)', async () => {
    const res = await callTool(
      ['ai:read', 'ai:execute'],
      'registry_operations',
      { action: 'delete_key', key: 'HKLM\\foo' },
    );
    const body = await res.json();
    expect(body.error).toBeUndefined();
    // The route writes two audit events: a request-level 'mcp_request' and the
    // tool-level 'mcp_tool_execution'. Select the tool-level one and assert it
    // records the EFFECTIVE (escalated) tier 3, not the base tier 1.
    const toolAudit = mocks.writeAuditEvent.mock.calls
      .map((call: any[]) => call[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit).toBeDefined();
    expect(toolAudit.action).toBe('mcp.tool.registry_operations');
    expect(toolAudit.details.tier).toBe(3);
  });

  // Downgrade-clamp: security_scan base tier 2 + action:'vulnerabilities'
  // downgrades to tier 1 in guardrails, but Math.max(baseTier, guardrailTier)
  // clamps the effective tier back to 2 — so an ai:read-only key is still
  // denied (tier 2 requires ai:write). Pins the behavior the comment documents.
  // (Split into two tests: callTool can only mint one apiKey mock per imported
  // module instance — calling it twice in one test reuses the first scopes.)
  it('downgrade-clamp: ai:read on a TIER1 action of a base-tier-2 tool is still denied (tier 2)', async () => {
    const denied = await callTool(['ai:read'], 'security_scan', { action: 'vulnerabilities' });
    const deniedBody = await denied.json();
    expect(deniedBody.error?.code).toBe(-32603);
    expect(deniedBody.error?.message).toContain('requires ai:write');
  });

  it('downgrade-clamp: ai:write on a TIER1 action of a base-tier-2 tool succeeds (gated at tier 2)', async () => {
    const ok = await callTool(['ai:read', 'ai:write'], 'security_scan', { action: 'vulnerabilities' });
    const okBody = await ok.json();
    expect(okBody.error).toBeUndefined();
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
    expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
    const arg = (mocks.ledgerBegin.mock.calls[0] as any[])[0] as any;
    expect(arg.tier).toBe(3);
    expect(arg.toolName).toBe('registry_operations');
  });

  it('benign read action on a tier-1 tool does NOT create a ledger', async () => {
    await callTool(['ai:read', 'ai:execute'], 'registry_operations', { action: 'read_value' });
    expect(mocks.ledgerBegin).not.toHaveBeenCalled();
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

  it('site-restricted caller does not see site-B devices via resources/read', async () => {
    // Restrict creator to site-A only. MCP-OAUTH-03: resources/read now
    // requires devices.read before it will even reach the site-axis
    // narrowing under test here, so the role must hold it.
    testState.permissions = [{ resource: 'devices', action: 'read' }];
    testState.allowedSiteIds = ['site-A'];

    // db mock: resolveSiteAllowedDeviceIds returns both devices with siteIds;
    // the real canAccessSite filter (built from allowedSiteIds) then narrows to
    // d-a. The device list query is then narrowed by inArray(devices.id,[d-a]).
    // We capture the final device list query and only return d-a.
    const capturedDeviceListConds: any[] = [];
    mocks.dbSelect.mockImplementation((_cols?: any) => ({
      from: (_table: any) => {
        const builder: any = {
          _conds: [] as any[],
          where(cond: any) {
            this._conds.push(cond);
            capturedDeviceListConds.push(cond);
            return this;
          },
          limit(_n: number) {
            // device list path — return only the site-A row to model the
            // inArray narrowing the route applied.
            return Promise.resolve([
              { id: 'd-a', hostname: 'host-a', status: 'online', osType: 'linux', osVersion: '1', agentVersion: '1', lastSeenAt: null },
            ]);
          },
          orderBy() {
            return this;
          },
          then(resolve: any) {
            // resolveSiteAllowedDeviceIds path (awaited without limit).
            resolve(DEVICE_ROWS.map((d) => ({ id: d.id, siteId: d.siteId })));
          },
        };
        return builder;
      },
    }));

    testState.scopes = ['ai:read'];
    const res = await mcpServerRoutes.request('/message', {
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
  }, 15_000);

  // C4 — alerts list site axis. Alert a-a is on site-A device d-a; a-b is on
  // site-B device d-b. A site-A-restricted caller must see a-a but not a-b. We
  // model the route's inArray(alerts.deviceId, [d-a]) narrowing by returning
  // only a-a from the alert list query.
  it('C4: site-restricted caller does not see site-B alerts via resources/read', async () => {
    // MCP-OAUTH-03: resources/read now requires alerts.read before the
    // site-axis narrowing under test here even runs.
    testState.permissions = [{ resource: 'alerts', action: 'read' }];
    testState.allowedSiteIds = ['site-A'];

    const capturedAlertConds: any[] = [];
    mocks.dbSelect.mockImplementation((_cols?: any) => ({
      from: (_table: any) => {
        const builder: any = {
          where(cond: any) {
            capturedAlertConds.push(cond);
            return this;
          },
          limit(_n: number) {
            // alert list path — return only the site-A alert to model the
            // inArray(alerts.deviceId,[d-a]) narrowing the route applied.
            return Promise.resolve([
              { id: 'a-a', title: 'alert-a', severity: 'high', status: 'active', deviceId: 'd-a', triggeredAt: null },
            ]);
          },
          orderBy() {
            return this;
          },
          then(resolve: any) {
            // resolveSiteAllowedDeviceIds path (awaited without limit).
            resolve(DEVICE_ROWS.map((d) => ({ id: d.id, siteId: d.siteId })));
          },
        };
        return builder;
      },
    }));

    testState.scopes = ['ai:read'];
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'breeze://alerts' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = body.result?.contents?.[0]?.text ?? '';
    expect(text).toContain('a-a');
    expect(text).not.toContain('a-b');
    // The alert-list query must have received a site-narrowing condition.
    expect(capturedAlertConds.length).toBeGreaterThan(0);
  }, 15_000);

  // C4 — single-device read breeze://devices/{id}. A site-A-restricted caller
  // reading an out-of-site device id (d-b on site-B) gets 'Device not found'
  // (-32602, fail-closed via deviceSiteDenied); an in-site id (d-a) returns the
  // safe projection. UUID-shaped ids are required by the route's URI regex.
  const D_A = '11111111-1111-1111-1111-111111111111';
  const D_B = '22222222-2222-2222-2222-222222222222';

  function mockSingleDeviceDb(returnedDevice: any) {
    mocks.dbSelect.mockImplementation((_cols?: any) => ({
      from: (_table: any) => {
        const builder: any = {
          where() {
            return this;
          },
          limit(_n: number) {
            return Promise.resolve(returnedDevice ? [returnedDevice] : []);
          },
          then(resolve: any) {
            resolve([
              { id: D_A, siteId: 'site-A' },
              { id: D_B, siteId: 'site-B' },
            ]);
          },
        };
        return builder;
      },
    }));
  }

  function restrictToSiteA() {
    // MCP-OAUTH-03: resources/read now requires devices.read before the
    // site-axis narrowing under test here even runs.
    testState.permissions = [{ resource: 'devices', action: 'read' }];
    testState.allowedSiteIds = ['site-A'];
  }

  async function readDevice(id: string) {
    testState.scopes = ['ai:read'];
    return mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: `breeze://devices/${id}` },
      }),
    });
  }

  it('C4: single-device read of an out-of-site id returns Device not found (-32602)', async () => {
    restrictToSiteA();
    // The DB returns the (site-B) device row; deviceSiteDenied must reject it.
    mockSingleDeviceDb({ id: D_B, siteId: 'site-B', hostname: 'host-b', status: 'online' });
    const res = await readDevice(D_B);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain('Device not found');
  });

  it('C4: single-device read of an in-site id returns the projection', async () => {
    restrictToSiteA();
    mockSingleDeviceDb({ id: D_A, siteId: 'site-A', hostname: 'host-a', status: 'online' });
    const res = await readDevice(D_A);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    const text = body.result?.contents?.[0]?.text ?? '';
    expect(text).toContain(D_A);
    expect(text).toContain('host-a');
  });
});
