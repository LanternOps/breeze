import { describe, expect, it, vi, beforeEach } from 'vitest';

// MCP interactive-approval-only gate (user decision, 2026-08-02): ALL Tier 3
// tools now require interactive approval, unconditionally, including tools
// that predate this change (execute_command, etc.) — MCP has no interactive
// approval surface, so it fails closed on the SAME effective-tier resolution
// tools/call already computes (Math.max(baseTier, checkGuardrails(...).tier),
// honoring TIER1/2/3_ACTIONS per-action escalation/downgrade). One small
// extras constant (MCP_APPROVAL_REQUIRED_EXTRA_TOOLS) additionally gates
// collect_evidence, whose Tier 2 in-app rating understates its risk over an
// unattended transport. This suite reuses the lightweight ledger-based
// harness from mcpServer.effectiveTier.test.ts (real checkGuardrails, stubbed
// RBAC/rate-limit) rather than the raw-db-chain harness in mcpServer.test.ts.

const testState = vi.hoisted(() => ({
  scopes: ['ai:read', 'ai:write', 'ai:execute'] as string[],
  redis: null as unknown,
  apiKeyExtra: {} as Record<string, unknown>,
}));

const mocks = vi.hoisted(() => ({
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
  db: { select: vi.fn(() => { throw new Error('Unexpected db.select call'); }) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

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
      ...testState.apiKeyExtra,
    });
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../services/aiTools', () => ({
  getToolDomain: vi.fn(() => 'devices'),
  getToolDefinitions: (...args: any[]) => mocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (...args: any[]) => mocks.getToolTier(...args),
}));

vi.mock('../services/redis', () => ({ getRedis: () => testState.redis }));
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
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

// Real checkGuardrails (and real TIER1/2/3_ACTIONS) so effective-tier
// resolution behaves exactly as production does — this is the unit under
// test. RBAC/rate-limit stubbed since they're orthogonal to this gate.
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: vi.fn(async () => null),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
  };
});

// Must cover every permission API_KEY_SCOPE_POLICIES (apps/api/src/services/apiKeyScopes.ts)
// maps ai:read/ai:write/ai:execute to, or authorizeHumanApiKeyCreator's live
// scope-delegation re-clamp denies the request before it ever reaches the
// tier gate under test here (checkToolPermission/RBAC is stubbed separately
// below — this baseline only has to satisfy the SCOPE re-clamp).
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
      allowedSiteIds: undefined,
    })),
  };
});

import { mcpServerRoutes } from './mcpServer';
import { checkGuardrails, TIER3_ACTIONS } from '../services/aiGuardrails';

// Real JSON schemas for the multiplexed tools these tests target, trimmed to
// just the `action` enum the gate inspects (mirrors the real registry
// definitions in aiToolsScripts.ts / aiToolsBilling.ts).
const REGISTRY_OPERATIONS_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read_key', 'get_value', 'set_value', 'create_key', 'delete_key'] },
  },
};
const MANAGE_INVOICES_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
        'update_line', 'remove_line', 'update_header', 'delete_draft',
        'assemble_from_org', 'assemble_from_ticket',
        'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
      ],
    },
  },
};

// manage_organizations' four actions, mirroring the real registry definition
// the same way the two schemas above do. The enforced schema itself cannot be
// imported here — aiToolSchemas reaches into `../db/schema`, which this suite
// mocks down to five tables — so the corresponding "the REAL enum is fully
// Tier 3" assertion lives next to the real registry, in
// services/aiAgentSdkTools.mcpCoverage.test.ts.
const MANAGE_ORGANIZATIONS_ACTIONS = ['create_org', 'update_org', 'create_site', 'add_contact'];
const MANAGE_ORGANIZATIONS_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', enum: MANAGE_ORGANIZATIONS_ACTIONS } },
};

const MANAGE_POLICY_FEATURE_LINK_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'remove', 'list'] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read', 'ai:write', 'ai:execute'];
  testState.apiKeyExtra = {};
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
});

async function callTool(toolName: string, args: Record<string, unknown>, scopes?: string[]) {
  if (scopes) testState.scopes = scopes;
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

async function listTools() {
  const res = await mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return res;
}

describe('MCP interactive-approval-only gate (all Tier 3, tier-driven)', () => {
  // (a) A flat Tier 3 tool — absent from tools/list, denied on tools/call.
  describe('flat Tier 3 tool (execute_command) — wholly gated', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'execute_command', description: 'Execute a system command.', input_schema: {} },
        { name: 'query_devices', description: 'List devices.', input_schema: {} },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => {
        if (name === 'execute_command') return 3;
        if (name === 'query_devices') return 1;
        return undefined;
      });
    });

    it('is absent from tools/list', async () => {
      const res = await listTools();
      const body = await res.json();
      const names = body.result.tools.map((t: any) => t.name);
      expect(names).not.toContain('execute_command');
      expect(names).toContain('query_devices');
    });

    it('tools/call returns MCP_APPROVAL_REQUIRED without executing (this is a NEW denial — execute_command used to auto-execute)', async () => {
      const res = await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('is denied even for a caller with full scopes — not a scope-insufficiency error', async () => {
      const res = await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' }, ['ai:read']);
      const body = await res.json();
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });
  });

  // (b) registry_operations — mixed multiplexer: writes Tier 3, reads not.
  describe('registry_operations — mixed multiplexer (base tier 1)', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'registry_operations', description: 'Read or modify the registry.', input_schema: REGISTRY_OPERATIONS_SCHEMA },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'registry_operations' ? 1 : undefined));
    });

    it('stays listed (mixed tool), with a description note naming the gated write actions', async () => {
      const res = await listTools();
      const body = await res.json();
      const tool = body.result.tools.find((t: any) => t.name === 'registry_operations');
      expect(tool).toBeDefined();
      expect(tool.description).toContain('set_value');
      expect(tool.description).toContain('create_key');
      expect(tool.description).toContain('delete_key');
      expect(tool.description).toContain('not available over MCP');
      // Reads are not gated — must not be listed as requiring the web app.
      expect(tool.description).not.toContain('"get_value"');
      expect(tool.description).not.toContain('"read_key"');
    });

    it('action:"set_value" (escalates to Tier 3) returns MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('registry_operations', {
        action: 'set_value', deviceId: 'dev-1', keyPath: 'HKLM\\Software\\Foo', valueName: 'Bar', valueData: '1',
      });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    // SR5-01 applied to registry reads (2026-09-17 ROLE audit §2.4): read_key /
    // get_value moved into TIER2_ACTIONS, so they still clear the Tier-3
    // approval gate but are no longer reachable on an `ai:read` key.
    it('action:"get_value" (now Tier 2) is refused on an ai:read-only key', async () => {
      const res = await callTool('registry_operations', {
        action: 'get_value', deviceId: 'dev-1', keyPath: 'HKLM\\Software\\Foo', valueName: 'Bar',
      }, ['ai:read']);
      const body = await res.json();
      // Review finding #5: assert the SPECIFIC scope/tier refusal, not just
      // "some error code exists" — that would pass identically for an
      // unrelated failure (a thrown exception, a malformed request, …) and
      // never actually pin that this is the tier-2-requires-ai:write gate.
      expect(body.error).toEqual({
        code: -32603,
        message: 'Tool "registry_operations" requires ai:write scope',
      });
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('action:"get_value" proceeds past the approval gate with ai:write', async () => {
      const res = await callTool('registry_operations', {
        action: 'get_value', deviceId: 'dev-1', keyPath: 'HKLM\\Software\\Foo', valueName: 'Bar',
      }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(mocks.executeTool).toHaveBeenCalledWith(
        'registry_operations',
        expect.objectContaining({ action: 'get_value' }),
        expect.anything(),
      );
    });
  });

  // (c) manage_invoices — mixed multiplexer: issue/void/payment Tier 3, drafting is not.
  describe('manage_invoices — mixed multiplexer (draft actions stay usable)', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'manage_invoices', description: 'Create and manage invoices.', input_schema: MANAGE_INVOICES_SCHEMA },
      ]);
      // manage_invoices base tier is 1 in the real registry (billing draft ops
      // auto-execute; issue/void/payment escalate via TIER3_ACTIONS).
      mocks.getToolTier.mockImplementation((name: string) => (name === 'manage_invoices' ? 1 : undefined));
    });

    it('stays listed with a description note naming the gated finalize/payment actions', async () => {
      const res = await listTools();
      const body = await res.json();
      const tool = body.result.tools.find((t: any) => t.name === 'manage_invoices');
      expect(tool).toBeDefined();
      expect(tool.description).toContain('issue');
      expect(tool.description).toContain('void');
      expect(tool.description).toContain('record_payment');
      expect(tool.description).toContain('void_payment');
    });

    it('action:"issue" (escalates to Tier 3) returns MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('manage_invoices', { action: 'issue', invoiceId: 'inv-1' });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('action:"create_draft" (the automation surface) proceeds past the gate — drafting must keep working', async () => {
      const res = await callTool('manage_invoices', { action: 'create_draft', orgId: 'org-1' }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(mocks.executeTool).toHaveBeenCalledWith(
        'manage_invoices',
        expect.objectContaining({ action: 'create_draft' }),
        expect.anything(),
      );
    });
  });

  // (c2) manage_organizations — a mixed multiplexer that became WHOLLY gated.
  describe('manage_organizations — every action is now Tier 3 (#3258 W02)', () => {
    // add_contact (#3258 wave W02) writes customer PII and can replace an
    // organization's billing contact, so it escalated to Tier 3 — which made
    // ALL FOUR of manage_organizations' actions Tier 3 and flipped the tool
    // from "mixed multiplexer" to wholly gated. The consequence is deliberate
    // and easy to mistake for a regression: MCP has no interactive approval
    // channel, so the tool disappears from tools/list entirely and every call
    // over MCP is refused. Pinned here so the day someone adds a NON-Tier-3
    // action back (which would re-list the tool) is a decision, not an
    // accident. New-customer intake over MCP is unaffected in the only sense
    // that matters: it never worked without approval, it now says so up front
    // instead of advertising a tool that always fails.
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'manage_organizations', description: 'Create and manage organizations, sites, and contacts.', input_schema: MANAGE_ORGANIZATIONS_SCHEMA },
        { name: 'query_devices', description: 'List devices.', input_schema: {} },
      ]);
      // Base tier 2 in the real registry — the gate here comes purely from
      // TIER3_ACTIONS covering the whole enum, not from the base tier.
      mocks.getToolTier.mockImplementation((name: string) => {
        if (name === 'manage_organizations') return 2;
        if (name === 'query_devices') return 1;
        return undefined;
      });
    });

    it('every declared action escalates to Tier 3 — the premise of the suppression', () => {
      const tier3 = TIER3_ACTIONS.manage_organizations ?? [];
      expect(MANAGE_ORGANIZATIONS_ACTIONS).toContain('add_contact');
      for (const action of MANAGE_ORGANIZATIONS_ACTIONS) {
        expect(tier3, `${action} is not Tier 3 — the tool is no longer wholly gated`).toContain(action);
      }
    });

    it('is absent from tools/list despite base tier 2', async () => {
      const res = await listTools();
      const body = await res.json();
      const names = body.result.tools.map((t: any) => t.name);
      expect(names).not.toContain('manage_organizations');
      expect(names).toContain('query_devices');
    });

    it('tools/call add_contact returns MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('manage_organizations', {
        action: 'add_contact', orgId: 'org-1', name: 'Jane Ops', email: 'jane@acme.example',
      });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });
  });

  // (c3) manage_policy_feature_link (RMM-QA-176 D9) — mixed multiplexer, base
  // tier 2, escalated by INPUT content rather than by action name.
  describe('manage_policy_feature_link — maintenance links escalate by input', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'manage_policy_feature_link', description: 'Manage feature links.', input_schema: MANAGE_POLICY_FEATURE_LINK_SCHEMA },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'manage_policy_feature_link' ? 2 : undefined));
    });

    it('add of a MAINTENANCE link is denied MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
        inlineSettings: { recurrence: 'weekly', durationHours: 2 },
      });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('update of a MAINTENANCE link is denied the same way', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', featureType: 'maintenance',
        inlineSettings: { durationHours: 8 },
      });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('add of a MONITORING link still executes — this gate is narrow, not a tool ban', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'monitoring',
        inlineSettings: { checkIntervalSeconds: 60, watches: [] },
      });
      const body = await res.json();
      expect(body.result.isError).toBeFalsy();
      expect(mocks.executeTool).toHaveBeenCalledWith(
        'manage_policy_feature_link',
        expect.objectContaining({ featureType: 'monitoring' }),
        expect.anything(),
      );
    });

    it('the denial does not depend on MFA at all — the caller carries token:{} and no MFA gate runs on this transport', async () => {
      // mcpServer.ts builds api_key/oauth_grant contexts with token:{} (:2246),
      // so hasSatisfiedMfa would return true for them on an ENABLE_2FA=false
      // deployment. The MCP denial is the EFFECTIVE-TIER gate (:1194-1206),
      // which never consults MFA — asserted here by the fact that the deny
      // above happens with no MFA state configured anywhere in this harness,
      // and holds for the widest scope set this harness's caller can actually
      // hold. (NOT 'ai:execute_admin': API_KEY_SCOPE_POLICIES maps that to
      // PERMISSIONS.ADMIN_ALL, which FULL_PERMISSIONS_BASELINE above does not
      // grant, so the live scope-delegation re-clamp rejects the request with a
      // JSON-RPC error before the tier gate is ever reached — a denial for the
      // wrong reason, which would make this control decorative.)
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
      }, ['ai:read', 'ai:write', 'ai:execute']);
      const body = await res.json();
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });
  });

  // (d) A plain Tier 2 tool proceeds fully ungated.
  describe('Tier 2 tools proceed ungated', () => {
    it('manage_tags {action: "add"} (Tier 2) is not gated — needs only ai:write, not approval', async () => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'manage_tags', description: 'Manage device tags.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'remove'] } } } },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'manage_tags' ? 2 : undefined));

      const res = await callTool('manage_tags', { action: 'add', deviceId: 'dev-1', tags: ['x'] }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(mocks.executeTool).toHaveBeenCalledWith('manage_tags', expect.objectContaining({ action: 'add' }), expect.anything());
    });

    it('acknowledge_network_device (Tier 2) is not gated', async () => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'acknowledge_network_device', description: 'Acknowledge a network change event.', input_schema: {} },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'acknowledge_network_device' ? 2 : undefined));

      const res = await callTool('acknowledge_network_device', { eventId: 'evt-1' }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(mocks.executeTool).toHaveBeenCalledWith('acknowledge_network_device', expect.anything(), expect.anything());
    });
  });

  // (e) collect_evidence — gated via the extras constant despite Tier 2.
  describe('collect_evidence — sub-Tier-3 extra (Tier 2 understates its risk)', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'collect_evidence', description: 'Collect forensic evidence.', input_schema: {} },
        { name: 'query_devices', description: 'List devices.', input_schema: {} },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => {
        if (name === 'collect_evidence') return 2;
        if (name === 'query_devices') return 1;
        return undefined;
      });
    });

    it('is absent from tools/list despite being Tier 2', async () => {
      const res = await listTools();
      const body = await res.json();
      const names = body.result.tools.map((t: any) => t.name);
      expect(names).not.toContain('collect_evidence');
      expect(names).toContain('query_devices');
    });

    it('tools/call returns MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('collect_evidence', {
        incidentId: 'inc-1', deviceId: 'dev-1', evidenceTypes: ['screenshot'],
      }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });
  });

  // (f) The gate lives ONLY in the MCP route — the shared in-app guardrail
  // service still reports Tier 3 tools as ALLOWED (the in-app approval flow,
  // not a blanket denial, is what gates them there).
  describe('in-app (non-MCP) path is untouched — no gate outside the MCP route', () => {
    beforeEach(() => {
      // checkGuardrails (real, via importOriginal) reads getToolTier from
      // '../services/aiTools' for its base-tier fallback — give it the same
      // base tiers the real registry carries for these two tools.
      mocks.getToolTier.mockImplementation((name: string) => {
        if (name === 'execute_containment') return 3;
        if (name === 'collect_evidence') return 2;
        return undefined;
      });
    });

    it('the real checkGuardrails still ALLOWS a Tier 3 tool (execute_containment) — the MCP deny is route-only', () => {
      const result = checkGuardrails('execute_containment', {
        incidentId: 'inc-1', deviceId: 'dev-1', actionType: 'process_kill',
      });
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe(3);
      expect(result.requiresApproval).toBe(true);
    });

    it('the real checkGuardrails still ALLOWS collect_evidence at Tier 2 — the MCP extras gate is route-only', () => {
      const result = checkGuardrails('collect_evidence', {
        incidentId: 'inc-1', deviceId: 'dev-1', evidenceTypes: ['screenshot'],
      });
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe(2);
    });
  });
});

// Operator opt-in MCP_UNATTENDED_TIER3_PRINCIPALS (default: nobody). It removes
// ONLY the approval-only deny, ONLY for the named principals; scope gates,
// RBAC, ledger and audit still run.
describe('MCP_UNATTENDED_TIER3_PRINCIPALS operator opt-in', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.getToolDefinitions.mockReturnValue([
      { name: 'execute_command', description: 'Execute a system command.', input_schema: {} },
      { name: 'registry_operations', description: 'Read or modify the registry.', input_schema: REGISTRY_OPERATIONS_SCHEMA },
      { name: 'collect_evidence', description: 'Collect forensic evidence.', input_schema: {} },
    ]);
    mocks.getToolTier.mockImplementation((name: string) => {
      if (name === 'execute_command') return 3;
      if (name === 'registry_operations') return 1;
      if (name === 'collect_evidence') return 2;
      return undefined;
    });
  });

  it.each([undefined, '', 'true', 'key-1', 'api_key:other-key', 'oauth_client:key-1', ' api_key:key-2'])('stays gated for this key when MCP_UNATTENDED_TIER3_PRINCIPALS is %s', async (value) => {
    if (value !== undefined) vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', value);
    const res = await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' });
    const payload = JSON.parse((await res.json()).result.content[0].text);
    expect(payload.code).toBe('MCP_APPROVAL_REQUIRED');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    const names = (await (await listTools()).json()).result.tools.map((t: any) => t.name);
    expect(names).not.toContain('execute_command');
    expect(names).not.toContain('collect_evidence');
    vi.unstubAllEnvs();
  });

  describe('when enabled', () => {
    beforeEach(() => { vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', 'oauth_client_user:someone/user-9, api_key:key-1'); });

    it('never lifts Tier 4 (no approval path): unlisted and denied even for a designated principal', async () => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'forbidden_tool', description: 'Tier 4.', input_schema: {} },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'forbidden_tool' ? 4 : undefined));
      const names = (await (await listTools()).json()).result.tools.map((t: any) => t.name);
      expect(names).not.toContain('forbidden_tool');
      const body = await (await callTool('forbidden_tool', {})).json();
      if (body.result) {
        expect(body.result.isError).toBe(true);
      } else {
        expect(body.error).toBeDefined();
      }
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('lists Tier 3 tools for an ai:execute caller, with no "not available over MCP" note', async () => {
      const tools = (await (await listTools()).json()).result.tools;
      const names = tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(['execute_command', 'registry_operations', 'collect_evidence']));
      const registry = tools.find((t: any) => t.name === 'registry_operations');
      expect(registry.description).not.toContain('not available over MCP');
    });

    it('still hides Tier 3 tools from a caller without ai:execute', async () => {
      testState.scopes = ['ai:read', 'ai:write'];
      const names = (await (await listTools()).json()).result.tools.map((t: any) => t.name);
      expect(names).not.toContain('execute_command');
    });

    it('executes a flat Tier 3 tool through the ledger and audit', async () => {
      const res = await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' });
      const body = await res.json();
      expect(body.result.isError).toBeFalsy();
      expect(mocks.executeTool).toHaveBeenCalledTimes(1);
      expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
      expect(mocks.ledgerComplete).toHaveBeenCalledTimes(1);
    });

    it('executes a Tier-3-escalated multiplexer action (registry set_value)', async () => {
      await callTool('registry_operations', {
        action: 'set_value', deviceId: 'dev-1', keyPath: 'HKLM\\Software\\Foo', valueName: 'Bar', valueData: '1',
      });
      expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    });

    it('treats the approval extra (collect_evidence) as Tier 3: denied and unlisted without ai:execute', async () => {
      const res = await callTool('collect_evidence', {
        incidentId: 'inc-1', deviceId: 'dev-1', evidenceTypes: ['screenshot'],
      }, ['ai:read', 'ai:write']);
      expect((await res.json()).error.message).toContain('requires ai:execute scope');
      expect(mocks.executeTool).not.toHaveBeenCalled();
      const names = (await (await listTools()).json()).result.tools.map((t: any) => t.name);
      expect(names).not.toContain('collect_evidence');
    });

    it('executes the approval extra (collect_evidence) through the Tier 3 ledger for an ai:execute caller', async () => {
      await callTool('collect_evidence', {
        incidentId: 'inc-1', deviceId: 'dev-1', evidenceTypes: ['screenshot'],
      });
      expect(mocks.executeTool).toHaveBeenCalledTimes(1);
      expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
    });

    it('production: a Tier 3 tool missing from MCP_EXECUTE_TOOL_ALLOWLIST is neither listed nor callable', async () => {
      // MCP_EXECUTE_TOOL_ALLOWLIST is parsed at module load and is empty in
      // this suite, so every Tier 3 tool is outside the production allowlist.
      vi.stubEnv('NODE_ENV', 'production');
      // Isolate the allowlist predicate from the execute_admin lever.
      vi.stubEnv('MCP_REQUIRE_EXECUTE_ADMIN', 'false');
      testState.redis = {};
      try {
        const names = (await (await listTools()).json()).result.tools.map((t: any) => t.name);
        expect(names).not.toContain('execute_command');
        expect(names).not.toContain('collect_evidence');
        const body = await (await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' })).json();
        expect(body.error.message).toContain('MCP_EXECUTE_TOOL_ALLOWLIST');
        expect(mocks.executeTool).not.toHaveBeenCalled();
      } finally {
        testState.redis = null;
      }
    });

    it('production: ai:execute_admin is still required for Tier 3', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      testState.redis = {};
      try {
        const body = await (await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' })).json();
        expect(body.error.message).toContain('ai:execute_admin');
        expect(mocks.executeTool).not.toHaveBeenCalled();
      } finally {
        testState.redis = null;
      }
    });

    it('binds OAuth callers by client AND user, never by client alone or the synthetic oauth:<jti> id', async () => {
      const call = () => callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' });
      const expectDenied = async () => {
        const body = await (await call()).json();
        expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      };
      // Billy's grant (user-1) and another user's grant through the SAME shared client.
      testState.apiKeyExtra = { id: 'oauth:jti-1', oauthGrantId: 'grant-1', oauthClientId: 'cc-1', createdBy: 'user-1' };
      for (const value of ['api_key:oauth:jti-1', 'oauth_client:cc-1', 'oauth_client_user:cc-1/user-2', 'oauth_client_user:cc-2/user-1']) {
        vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', value);
        await expectDenied();
      }
      expect(mocks.executeTool).not.toHaveBeenCalled();

      vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', 'oauth_client_user:cc-1/user-1');
      await call();
      expect(mocks.executeTool).toHaveBeenCalledTimes(1);

      // Same client, different user: still approval-only.
      testState.apiKeyExtra = { id: 'oauth:jti-2', oauthGrantId: 'grant-2', oauthClientId: 'cc-1', createdBy: 'user-2' };
      await expectDenied();
      expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    });

    it('still requires ai:execute for Tier 3 — the scope gate is not bypassed', async () => {
      const res = await callTool('execute_command', { deviceId: 'dev-1', commandType: 'list_processes' }, ['ai:read', 'ai:write']);
      const body = await res.json();
      expect(body.error.message).toContain('requires ai:execute scope');
      expect(mocks.executeTool).not.toHaveBeenCalled();
      expect(mocks.ledgerBegin).not.toHaveBeenCalled();
    });
  });
});
