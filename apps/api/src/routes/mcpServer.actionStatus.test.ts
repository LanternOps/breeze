import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// B-W04 (#6158, D-B31): get_action_status / cancel_action over MCP. Harness
// copied from mcpServer.approvalGate.test.ts; loadOwnedMcpIntent /
// cancelOwnedMcpIntent are controlled mocks (the ownership filter lives in the
// loader), toMcpActionStatus is the REAL one.

// RBAC/rate-limit) rather than the raw-db-chain harness in mcpServer.test.ts.

const testState = vi.hoisted(() => ({
  scopes: ['ai:read', 'ai:write', 'ai:execute'] as string[],
  redis: null as unknown,
  apiKeyExtra: {} as Record<string, unknown>,
  // null = the real hasSatisfiedMfa (ENABLE_2FA defaults on, and MCP callers
  // carry token:{}, so it refuses). true simulates an MFA-satisfied caller
  // (equivalently, an ENABLE_2FA=false deployment).
  mfaSatisfied: null as boolean | null,
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    hasSatisfiedMfa: (auth: Parameters<typeof actual.hasSatisfiedMfa>[0]) =>
      testState.mfaSatisfied ?? actual.hasSatisfiedMfa(auth),
  };
});

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

// B-W04 (#6158): the MCP-side intent creation (its own suite covers it).
const intentMocks = vi.hoisted(() => ({ createMcpActionIntent: vi.fn(), loadOwnedMcpIntent: vi.fn(), cancelOwnedMcpIntent: vi.fn() }));
vi.mock('../services/mcpIntentCreation', () => ({
  createMcpActionIntent: (...args: any[]) => intentMocks.createMcpActionIntent(...args),
  loadOwnedMcpIntent: (...args: any[]) => intentMocks.loadOwnedMcpIntent(...args),
  cancelOwnedMcpIntent: (...args: any[]) => intentMocks.cancelOwnedMcpIntent(...args),
  resolveMcpClientLabel: vi.fn(async () => 'MCP · test'),
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
      id: '11111111-1111-4111-8111-111111111111',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      mcpDomains: null,
      scopes: testState.scopes,
      rateLimit: 1000,
      createdBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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

// An org service-principal key authorizes against the principal (not the human
// creator); the real one reads service_principals through the DB, which this
// suite's ../db mock has no select() for. Stub it as an authorized principal so
// the request reaches the tool handlers.
vi.mock('../services/apiKeyAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/apiKeyAuthorization')>();
  return {
    ...actual,
    authorizeServicePrincipalKey: vi.fn(async (input: { scopes: string[] }) => ({
      ok: true,
      permissions: null,
      allowedSiteIds: undefined,
      clampedScopes: input.scopes,
    })),
  };
});

import { mcpServerRoutes } from './mcpServer';
beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read', 'ai:write', 'ai:execute'];
  testState.apiKeyExtra = {};
  testState.mfaSatisfied = null;
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
  intentMocks.loadOwnedMcpIntent.mockReset().mockResolvedValue(null);
  intentMocks.cancelOwnedMcpIntent.mockReset().mockResolvedValue({ kind: 'not_found' });
  vi.unstubAllEnvs();
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


const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const NOT_FOUND = { code: -32602, message: 'Action not found', data: { reason: 'not_found' } };
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

function intentRow(over: Record<string, unknown> = {}) {
  return {
    id: ACTION_ID,
    status: 'pending_approval',
    actionName: 'execute_command',
    approvalScope: 'four_eyes',
    expiresAt: EXPIRES,
    result: null,
    errorCode: null,
    executedAt: null,
    ...over,
  };
}

function cancelledStatus() {
  return {
    actionId: ACTION_ID, status: 'cancelled', toolName: 'execute_command',
    approvalScope: 'four_eyes', expiresAt: EXPIRES.toISOString(), approvalUrl: 'http://x/approvals#intent-' + ACTION_ID,
  };
}

const HUMAN = {};
const OAUTH = { oauthGrantId: 'grant-1' };
const ORG_SERVICE = { principalType: 'service', principalId: 'sp-1' };
const PARTNER_SP = { partnerServicePrincipalId: 'psp-1', orgId: null };

async function toolList(extra: Record<string, unknown>, scopes?: string[]) {
  testState.apiKeyExtra = extra;
  if (scopes) testState.scopes = scopes;
  const body = await (await listTools()).json();
  return body.result.tools as Array<any>;
}

async function call(name: string, args: Record<string, unknown>, extra: Record<string, unknown> = HUMAN, scopes?: string[]) {
  testState.apiKeyExtra = extra;
  return (await callTool(name, args, scopes)).json();
}

describe('tools/list exposure', () => {
  it.each([
    ['human API key', HUMAN],
    ['OAuth grant', OAUTH],
  ])('lists both tools for a %s, with the right annotations', async (_l, extra) => {
    const tools = await toolList(extra);
    const get = tools.find((t) => t.name === 'get_action_status');
    const cancel = tools.find((t) => t.name === 'cancel_action');
    expect(get.annotations.readOnlyHint).toBe(true);
    expect(cancel.annotations.readOnlyHint).toBe(false);
    expect(get.inputSchema.required).toEqual(['actionId']);
  });

  it.each([
    ['org service-principal key', ORG_SERVICE],
    ['partner service principal', PARTNER_SP],
  ])('lists neither tool for a %s', async (_l, extra) => {
    const names = (await toolList(extra)).map((t) => t.name);
    expect(names).toContain('whoami');
    expect(names).not.toContain('get_action_status');
    expect(names).not.toContain('cancel_action');
  });

  it('lists get_action_status but not cancel_action for an ai:read-only key', async () => {
    const names = (await toolList(HUMAN, ['ai:read'])).map((t) => t.name);
    expect(names).toContain('get_action_status');
    expect(names).not.toContain('cancel_action');
  });
});

describe('get_action_status', () => {
  it.each([
    ['pending_approval', 'pending_approval'],
    ['approved', 'in_progress'],
    ['executing', 'in_progress'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ])('maps intent status %s to %s', async (intentStatus, expected) => {
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow({ status: intentStatus }));
    const body = await call('get_action_status', { actionId: ACTION_ID });
    expect(body.error).toBeUndefined();
    expect(body.result.structuredContent).toMatchObject({
      actionId: ACTION_ID,
      status: expected,
      toolName: 'execute_command',
      approvalScope: 'four_eyes',
      expiresAt: EXPIRES.toISOString(),
    });
    expect(body.result.structuredContent.approvalUrl).toMatch(new RegExp(`/approvals#intent-${ACTION_ID}$`));
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
    expect(intentMocks.loadOwnedMcpIntent).toHaveBeenCalledWith(expect.anything(), ACTION_ID);
  });

  it('works with only ai:read', async () => {
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow());
    const body = await call('get_action_status', { actionId: ACTION_ID }, HUMAN, ['ai:read']);
    expect(body.error).toBeUndefined();
    expect(body.result.structuredContent.status).toBe('pending_approval');
  });

  it('returns an identical not_found for every unowned / invalid / service-principal case', async () => {
    const errors: unknown[] = [];

    // unknown id, another key's / org's / chat / other-credential intent: the loader answers null for all
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(null);
    errors.push((await call('get_action_status', { actionId: ACTION_ID })).error);
    errors.push((await call('get_action_status', { actionId: '44444444-4444-4444-8444-444444444444' }, OAUTH)).error);
    // non-uuid / missing id (the real loader rejects these with null)
    errors.push((await call('get_action_status', { actionId: 'not-a-uuid' })).error);
    errors.push((await call('get_action_status', {})).error);
    // service principals never reach the loader, even if it would return a row
    intentMocks.loadOwnedMcpIntent.mockClear().mockResolvedValue(intentRow());
    errors.push((await call('get_action_status', { actionId: ACTION_ID }, ORG_SERVICE)).error);
    errors.push((await call('get_action_status', { actionId: ACTION_ID }, PARTNER_SP)).error);
    expect(intentMocks.loadOwnedMcpIntent).not.toHaveBeenCalled();

    expect(errors).toHaveLength(6);
    for (const e of errors) expect(e).toEqual(NOT_FOUND);
  });

  it('completed: compacts the stored result under the original action name', async () => {
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow({ status: 'completed', result: { ok: true } }));
    const sc = (await call('get_action_status', { actionId: ACTION_ID })).result.structuredContent;
    expect(typeof sc.result).toBe('string');
    expect(sc.result).toContain('ok');
    expect(sc.resultWithheld).toBeUndefined();
  });

  it('completed secret-bearing tool: withholds the result entirely', async () => {
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow({
      status: 'completed',
      actionName: 'm365_reset_password',
      result: { upn: 'victim@example.com', leakedField: 'S3cr3t-Value-123' },
    }));
    const body = await call('get_action_status', { actionId: ACTION_ID });
    const sc = body.result.structuredContent;
    expect(sc.resultWithheld).toBe('secret_bearing');
    expect(sc.result).toBeUndefined();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('S3cr3t-Value-123');
    expect(raw).not.toContain('victim@example.com');
    expect(raw).not.toContain('leakedField');
  });

  it('failed with executedAt flags outcomeUncertain and carries errorCode', async () => {
    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow({ status: 'failed', errorCode: 'boom', executedAt: new Date() }));
    const sc = (await call('get_action_status', { actionId: ACTION_ID })).result.structuredContent;
    expect(sc).toMatchObject({ status: 'failed', errorCode: 'boom', outcomeUncertain: true });
  });

  it('a loader failure is a generic -32000, not a leak', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    intentMocks.loadOwnedMcpIntent.mockRejectedValue(new Error('secret db detail'));
    const body = await call('get_action_status', { actionId: ACTION_ID });
    expect(body.error).toEqual({ code: -32000, message: 'Unable to read the action status' });
  });
});

describe('cancel_action', () => {
  it('cancelled outcome is reported with status cancelled', async () => {
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({ kind: 'cancelled', status: cancelledStatus() });
    const body = await call('cancel_action', { actionId: ACTION_ID });
    expect(body.result.structuredContent).toMatchObject({ outcome: 'cancelled', status: 'cancelled', actionId: ACTION_ID });
    expect(intentMocks.cancelOwnedMcpIntent).toHaveBeenCalledWith(expect.anything(), ACTION_ID, expect.any(String));
  });

  it('not_cancellable on an executing row reports in_progress', async () => {
    const { toMcpActionStatus } = await import('../services/mcpActionStatus');
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({
      kind: 'not_cancellable',
      status: toMcpActionStatus(intentRow({ status: 'executing' }) as any, 'http://localhost'),
    });
    const body = await call('cancel_action', { actionId: ACTION_ID });
    expect(body.result.structuredContent).toMatchObject({ outcome: 'not_cancellable', status: 'in_progress' });
  });

  it('with only ai:read is refused -32603 insufficient_scope, before touching the canceller', async () => {
    const body = await call('cancel_action', { actionId: ACTION_ID }, HUMAN, ['ai:read']);
    expect(body.error).toEqual({
      code: -32603,
      message: 'Tool "cancel_action" requires ai:write scope',
      data: { reason: 'insufficient_scope', requiredScope: 'ai:write' },
    });
    expect(intentMocks.cancelOwnedMcpIntent).not.toHaveBeenCalled();
  });

  it('returns the same not_found for unknown ids and service principals', async () => {
    const errors: unknown[] = [];
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({ kind: 'not_found' });
    errors.push((await call('cancel_action', { actionId: ACTION_ID })).error);
    errors.push((await call('cancel_action', { actionId: 'nope' }, OAUTH)).error);
    intentMocks.cancelOwnedMcpIntent.mockClear();
    errors.push((await call('cancel_action', { actionId: ACTION_ID }, ORG_SERVICE)).error);
    errors.push((await call('cancel_action', { actionId: ACTION_ID }, PARTNER_SP)).error);
    expect(intentMocks.cancelOwnedMcpIntent).not.toHaveBeenCalled();
    expect(errors).toHaveLength(4);
    for (const e of errors) expect(e).toEqual(NOT_FOUND);
  });
});

describe('MCP_TIER3_INTENTS_ENABLED does not gate the status tools', () => {
  it.each([['unset', undefined], ['true', 'true']])('flag %s: list + get + cancel all work', async (_l, flag) => {
    if (flag !== undefined) vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', flag);
    const names = (await toolList(HUMAN)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_action_status', 'cancel_action']));

    intentMocks.loadOwnedMcpIntent.mockResolvedValue(intentRow({ status: 'approved' }));
    expect((await call('get_action_status', { actionId: ACTION_ID })).result.structuredContent.status).toBe('in_progress');

    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({ kind: 'cancelled', status: cancelledStatus() });
    expect((await call('cancel_action', { actionId: ACTION_ID })).result.structuredContent.outcome).toBe('cancelled');
  });
});

describe('B-W04: initialize serves the flag\'s instructions variant', () => {
  async function initialize() {
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    return (await res.json()).result;
  }
  afterEach(() => { delete process.env.MCP_TIER3_INTENTS_ENABLED; });

  it('flag on → approval-intent rules; flag off → today\'s text', async () => {
    const { MCP_SERVER_INSTRUCTIONS } = await import('../services/mcpGuidance');
    process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
    const on = await initialize();
    expect(on.instructions).toContain('get_action_status');
    expect(on.instructions).not.toBe(MCP_SERVER_INSTRUCTIONS);
    delete process.env.MCP_TIER3_INTENTS_ENABLED;
    expect((await initialize()).instructions).toBe(MCP_SERVER_INSTRUCTIONS);
  });
});
