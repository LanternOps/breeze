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
import { checkGuardrails } from '../services/aiGuardrails';

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

const MANAGE_POLICY_FEATURE_LINK_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'remove', 'list'] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read', 'ai:write', 'ai:execute'];
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

    it('action:"get_value" (stays Tier 1) proceeds past the gate to the normal handler path', async () => {
      const res = await callTool('registry_operations', {
        action: 'get_value', deviceId: 'dev-1', keyPath: 'HKLM\\Software\\Foo', valueName: 'Bar',
      }, ['ai:read']);
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

  // (c2) manage_policy_feature_link (RMM-QA-176 D9) — mixed multiplexer, base
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
