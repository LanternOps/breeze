/**
 * B-W04 (#6158, PR B, D-B32): URL-mode elicitation for Tier-3 approvals on the
 * stateless `2026-07-28` era, and the `requestState` continuation.
 *
 * Harness copied from mcpServer.modern.test.ts (era headers / `_meta`) and
 * mcpServer.approvalGate.test.ts (Tier-3 gate, `mcpIntentCreation` mock). The
 * real `mcpRequestState` and `mcpActionStatus` services are NOT mocked: the
 * sealed state and the status projection are part of the contract under test.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
  getToolDomain: vi.fn((_: string): string => 'devices'),
  writeAuditEvent: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  waitForIntentTerminalOutcome: vi.fn(),
}));

const testState = vi.hoisted(() => ({
  scopes: ['ai:read', 'ai:write', 'ai:execute'] as string[],
  keyId: '0a0a0a0a-0000-4000-8000-00000000000a',
}));

// B-W04: MCP-side intent creation / ownership / cancel (their own suites cover them).
const intentMocks = vi.hoisted(() => ({
  createMcpActionIntent: vi.fn(),
  loadOwnedMcpIntent: vi.fn(),
  cancelOwnedMcpIntent: vi.fn(),
}));
vi.mock('../services/mcpIntentCreation', () => ({
  createMcpActionIntent: (...args: any[]) => intentMocks.createMcpActionIntent(...args),
  loadOwnedMcpIntent: (...args: any[]) => intentMocks.loadOwnedMcpIntent(...args),
  cancelOwnedMcpIntent: (...args: any[]) => intentMocks.cancelOwnedMcpIntent(...args),
  resolveMcpClientLabel: vi.fn(async () => 'MCP · test'),
}));

// The route imports this lazily; mocked minimally so the suite never needs the
// real intent service (and its schema graph).
vi.mock('../services/actionIntents/intentService', () => ({
  waitForIntentTerminalOutcome: (...args: any[]) => mocks.waitForIntentTerminalOutcome(...args),
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return { ...actual, hasSatisfiedMfa: () => true };
});

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return false; },
  get OAUTH_ISSUER() { return 'https://us.example.com'; },
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => [],
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    c.set('apiKey', {
      id: testState.keyId,
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      mcpDomains: null,
      scopes: testState.scopes,
      rateLimit: 1000,
      createdBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      oauthGrantId: null,
    });
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(() => { throw new Error('Unexpected db.select call'); }) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {}, apiKeys: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
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
      permissions: [
        { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' }, { resource: 'alerts', action: 'read' },
        { resource: 'alerts', action: 'write' }, { resource: 'scripts', action: 'read' },
        { resource: 'scripts', action: 'write' }, { resource: 'scripts', action: 'execute' },
        { resource: 'automations', action: 'read' }, { resource: 'automations', action: 'write' },
      ],
      partnerId: null, orgId: 'org-1', roleId: 'role-1', scope: 'organization' as const, allowedSiteIds: undefined,
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  aiTools: new Map(),
  getToolDefinitions: (...args: any[]) => mocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (...args: any[]) => mocks.getToolTier(...(args as [string])),
  getToolDomain: (...args: any[]) => mocks.getToolDomain(...(args as [string])),
}));

vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: vi.fn(async () => null),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
    checkPermissionRequirements: vi.fn(async () => null),
  };
});

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));
vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
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
vi.mock('../services/toolSources/guardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/toolSources/guardrails')>(),
  checkTenantToolRateLimit: async () => null,
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));
vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001',
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: mocks.captureMessage }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

import { mcpServerRoutes } from './mcpServer';
import { checkToolRateLimit } from '../services/aiGuardrails';
import { __resetMcpHeaderMismatchWindowForTests } from '../services/mcpModernResult';

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';
const KEY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const KEY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ID = '77777777-7777-4777-8777-777777777777';
const URL_CAPS = { elicitation: { url: {} } };
const ARGS = { deviceId: 'd1', command: 'whoami' };

const allBodies: string[] = [];

function app() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

async function rpc(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  allBodies.push(text);
  return { status: res.status, body: JSON.parse(text) };
}

/** A `2026-07-28` tools/call. `caps` is the declared client capabilities. */
function modernCall(
  name: string,
  args: Record<string, unknown>,
  opts: { caps?: Record<string, unknown>; requestState?: string; inputResponses?: unknown } = {},
) {
  const params: Record<string, unknown> = {
    name,
    arguments: args,
    _meta: { [PV]: '2026-07-28', [CAPS]: opts.caps ?? {}, [INFO]: { name: 'inspector', version: '1.0' } },
  };
  if (opts.requestState !== undefined) params.requestState = opts.requestState;
  if (opts.inputResponses !== undefined) params.inputResponses = opts.inputResponses;
  return rpc('/mcp/sse', {
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    'Mcp-Name': name,
  }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params });
}

function legacyCall(name: string, args: Record<string, unknown>) {
  return rpc('/mcp/message', {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

function pendingOutcome(toolName: string) {
  return {
    kind: 'pending', isNew: true,
    status: {
      actionId: ID, status: 'pending_approval', toolName, approvalScope: 'four_eyes',
      expiresAt: '2027-01-01T00:00:00.000Z', approvalUrl: `https://app.example.com/approvals#intent-${ID}`,
    },
  };
}

function intentRow(status: string, actionName = 'execute_command', extra: Record<string, unknown> = {}) {
  return {
    id: ID, status, actionName, approvalScope: 'four_eyes',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'), result: null, errorCode: null, executedAt: null,
    ...extra,
  };
}

/** Ownership read returns `owned`; the post-wait re-read returns `final`. */
function setRows(owned: unknown, final: unknown = owned) {
  intentMocks.loadOwnedMcpIntent.mockReset()
    .mockResolvedValueOnce(owned)
    .mockResolvedValue(final);
}

function useTools() {
  const defs = [
    { name: 'execute_command', tier: 3 },
    { name: 'm365_reset_password', tier: 3 },
    { name: 'run_script_x', tier: 3 },
    { name: 'query_devices', tier: 1 },
  ];
  mocks.getToolDefinitions.mockReturnValue(defs.map((d) => ({ name: d.name, description: `${d.name}.`, input_schema: {} })));
  mocks.getToolTier.mockImplementation((name: string) => defs.find((d) => d.name === name)?.tier);
}

/** First call by a URL-capable modern client → the sealed requestState. */
async function firstCall(name = 'execute_command', args: Record<string, unknown> = ARGS): Promise<string> {
  intentMocks.createMcpActionIntent.mockReset().mockResolvedValue(pendingOutcome(name));
  const { body } = await modernCall(name, args, { caps: URL_CAPS });
  const state = body.result?.requestState;
  expect(typeof state).toBe('string');
  return state;
}

function retry(state: string, action: unknown, name = 'execute_command', args: Record<string, unknown> = ARGS) {
  vi.mocked(checkToolRateLimit).mockClear();
  intentMocks.createMcpActionIntent.mockClear();
  return modernCall(name, args, {
    caps: URL_CAPS,
    requestState: state,
    inputResponses: action === undefined ? undefined : { breeze_approval: action },
  });
}

beforeEach(() => {
  process.env.MCP_STATELESS_ENABLED = 'true';
  process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
  testState.scopes = ['ai:read', 'ai:write', 'ai:execute'];
  testState.keyId = KEY_A;
  vi.mocked(checkToolRateLimit).mockReset().mockResolvedValue(null);
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.getToolDomain.mockReset().mockReturnValue('devices');
  mocks.writeAuditEvent.mockReset();
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.waitForIntentTerminalOutcome.mockReset().mockResolvedValue(null);
  intentMocks.createMcpActionIntent.mockReset();
  intentMocks.loadOwnedMcpIntent.mockReset().mockResolvedValue(intentRow('pending_approval'));
  intentMocks.cancelOwnedMcpIntent.mockReset();
  useTools();
  __resetMcpHeaderMismatchWindowForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_TIER3_INTENTS_ENABLED;
  delete process.env.MCP_APPROVAL_WAITS_PER_PRINCIPAL;
});

afterAll(() => {
  expect(allBodies.length).toBeGreaterThan(0);
  for (const b of allBodies) expect(b).not.toContain('"mode":"form"');
});

describe('B-W04 URL elicitation: first call', () => {
  it('modern client declaring elicitation.url gets input_required with one url elicitation and a requestState (HTTP 200)', async () => {
    intentMocks.createMcpActionIntent.mockResolvedValue(pendingOutcome('execute_command'));
    const { status, body } = await modernCall('execute_command', ARGS, { caps: URL_CAPS });
    expect(status).toBe(200);
    const result = body.result;
    expect(result.resultType).toBe('input_required');
    expect(Object.keys(result.inputRequests)).toEqual(['breeze_approval']);
    const req = result.inputRequests.breeze_approval;
    expect(req.method).toBe('elicitation/create');
    expect(req.params.mode).toBe('url');
    expect(typeof req.params.message).toBe('string');
    expect(req.params.url).toBe(`https://app.example.com/approvals#intent-${ID}`);
    expect(typeof result.requestState).toBe('string');
    expect(result).not.toHaveProperty('ttlMs');
    expect(result).not.toHaveProperty('cacheScope');
    expect(result).not.toHaveProperty('content');
    expect(intentMocks.createMcpActionIntent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['elicitation: {} (form only)', { elicitation: {} }],
    ['no elicitation key', {}],
  ])('%s → plain pending_approval, no inputRequests', async (_label, caps) => {
    intentMocks.createMcpActionIntent.mockResolvedValue(pendingOutcome('execute_command'));
    const { status, body } = await modernCall('execute_command', ARGS, { caps });
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result.structuredContent.status).toBe('pending_approval');
    expect(body.result).not.toHaveProperty('inputRequests');
    expect(body.result).not.toHaveProperty('requestState');
  });

  it('legacy-era call → plain pending_approval, no inputRequests', async () => {
    intentMocks.createMcpActionIntent.mockResolvedValue(pendingOutcome('execute_command'));
    const { body } = await legacyCall('execute_command', ARGS);
    expect(body.result.structuredContent.status).toBe('pending_approval');
    expect(body.result).not.toHaveProperty('inputRequests');
    expect(body.result).not.toHaveProperty('requestState');
  });
});

describe('B-W04 URL elicitation: requestState binding', () => {
  it('a valid retry never creates an intent and never charges the per-tool rate limit', async () => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    const { body } = await retry(state, { action: 'cancel' });
    expect(body.error).toBeUndefined();
    expect(intentMocks.createMcpActionIntent).not.toHaveBeenCalled();
    expect(checkToolRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['other credential', async (state: string) => { testState.keyId = KEY_B; return retry(state, { action: 'accept' }); }],
    ['other tool name', (state: string) => retry(state, { action: 'accept' }, 'run_script_x')],
    ['edited arguments', (state: string) => retry(state, { action: 'accept' }, 'execute_command', { ...ARGS, command: 'rm -rf /' })],
    ['one flipped character', (state: string) => {
      const i = 5;
      const flipped = state.slice(0, i) + (state[i] === 'A' ? 'B' : 'A') + state.slice(i + 1);
      return retry(flipped, { action: 'accept' });
    }],
  ])('%s → -32602 invalid_request_state, nothing created, nothing waited', async (_label, mutate) => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    const { body } = await mutate(state);
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.reason).toBe('invalid_request_state');
    expect(intentMocks.createMcpActionIntent).not.toHaveBeenCalled();
    expect(checkToolRateLimit).not.toHaveBeenCalled();
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });

  it('601 s later → -32602 request_state_expired carrying data.actionId', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const state = await firstCall();
    vi.setSystemTime(t0 + 601_000);
    setRows(intentRow('pending_approval'));
    const { body } = await retry(state, { action: 'accept' });
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.reason).toBe('request_state_expired');
    expect(body.error.data.actionId).toBe(ID);
    expect(intentMocks.createMcpActionIntent).not.toHaveBeenCalled();
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });

  it('expired state presented by ANOTHER credential → -32602 without data.actionId', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const state = await firstCall();
    vi.setSystemTime(t0 + 601_000);
    testState.keyId = KEY_B;
    const { body } = await retry(state, { action: 'accept' });
    expect(body.error.code).toBe(-32602);
    expect(body.error.data?.actionId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(ID);
  });

  it('unknown / not-owned intent → -32602 not_found', async () => {
    const state = await firstCall();
    intentMocks.loadOwnedMcpIntent.mockReset().mockResolvedValue(null);
    const { body } = await retry(state, { action: 'accept' });
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.reason).toBe('not_found');
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });
});

describe('B-W04 URL elicitation: accept', () => {
  it('waits (id, 20000, AbortSignal) then re-reads; completed → normal result rendered via toMcpActionStatus', async () => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'), intentRow('completed', 'execute_command', { result: { ok: 1 } }));
    const { status, body } = await retry(state, { action: 'accept' });
    expect(status).toBe(200);
    expect(mocks.waitForIntentTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(mocks.waitForIntentTerminalOutcome).toHaveBeenCalledWith(ID, 20000, expect.any(AbortSignal));
    expect(intentMocks.loadOwnedMcpIntent).toHaveBeenCalledTimes(2);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.resultType).toBe('complete');
    expect(body.result.structuredContent.status).toBe('completed');
    expect(JSON.stringify(body.result)).toContain('ok');
    expect(body.result).not.toHaveProperty('inputRequests');
  });

  it('completed m365_reset_password → resultWithheld secret_bearing, no result, no stored values', async () => {
    const state = await firstCall('m365_reset_password', { userId: 'u1' });
    const secret = 'S3cr3t-Temp-Pw-9f8e7d';
    setRows(
      intentRow('pending_approval', 'm365_reset_password'),
      intentRow('completed', 'm365_reset_password', { result: { temporaryPassword: secret, upn: 'bob@example.com' } }),
    );
    const { body } = await retry(state, { action: 'accept' }, 'm365_reset_password', { userId: 'u1' });
    expect(body.result.structuredContent.resultWithheld).toBe('secret_bearing');
    expect(body.result.structuredContent).not.toHaveProperty('result');
    const json = JSON.stringify(body);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('bob@example.com');
  });

  it('still pending after the wait → complete pending_approval, no second elicitation', async () => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'), intentRow('pending_approval'));
    const { body } = await retry(state, { action: 'accept' });
    expect(body.result.resultType).toBe('complete');
    expect(body.result.structuredContent.status).toBe('pending_approval');
    expect(body.result).not.toHaveProperty('inputRequests');
    expect(body.result).not.toHaveProperty('requestState');
  });

  it.each([
    ['rejected', 'rejected'],
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ])('final row %s → isError true with structuredContent.status %s', async (rowStatus, expected) => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'), intentRow(rowStatus, 'execute_command', rowStatus === 'failed' ? { errorCode: 'boom' } : {}));
    const { body } = await retry(state, { action: 'accept' });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.status).toBe(expected);
  });

  it('MCP_APPROVAL_WAITS_PER_PRINCIPAL=1: a second concurrent accept skips the wait and returns the current status', async () => {
    process.env.MCP_APPROVAL_WAITS_PER_PRINCIPAL = '1';
    const state = await firstCall();
    let release!: (v: unknown) => void;
    mocks.waitForIntentTerminalOutcome.mockReset().mockReturnValue(new Promise((r) => { release = r; }));
    setRows(intentRow('pending_approval'), intentRow('pending_approval'));
    const first = retry(state, { action: 'accept' });
    await vi.waitFor(() => expect(mocks.waitForIntentTerminalOutcome).toHaveBeenCalledTimes(1));

    intentMocks.loadOwnedMcpIntent.mockReset().mockResolvedValue(intentRow('pending_approval'));
    const second = await retry(state, { action: 'accept' });
    expect(mocks.waitForIntentTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(second.body.result.structuredContent.status).toBe('pending_approval');
    expect(second.body.result.resultType).toBe('complete');

    release(null);
    await first;
  });
});

describe('B-W04 URL elicitation: decline / cancel / malformed', () => {
  it('decline → cancelOwnedMcpIntent; cancelled outcome → status cancelled', async () => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({
      kind: 'cancelled',
      status: { actionId: ID, status: 'cancelled', toolName: 'execute_command', approvalScope: 'four_eyes', expiresAt: '2027-01-01T00:00:00.000Z', approvalUrl: 'x' },
    });
    const { body } = await retry(state, { action: 'decline' });
    expect(intentMocks.cancelOwnedMcpIntent).toHaveBeenCalledTimes(1);
    expect(body.result.structuredContent.status).toBe('cancelled');
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });

  it('decline when the worker already claimed it → not_cancellable reports in_progress', async () => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({
      kind: 'not_cancellable',
      status: { actionId: ID, status: 'in_progress', toolName: 'execute_command', approvalScope: 'four_eyes', expiresAt: '2027-01-01T00:00:00.000Z', approvalUrl: 'x' },
    });
    const { body } = await retry(state, { action: 'decline' });
    expect(body.result.structuredContent.status).toBe('in_progress');
  });

  it('decline with an ai:read-only key → -32603 requiredScope ai:write, nothing cancelled', async () => {
    const state = await firstCall();
    testState.scopes = ['ai:read'];
    setRows(intentRow('pending_approval'));
    const { body } = await retry(state, { action: 'decline' });
    expect(body.error.code).toBe(-32603);
    expect(body.error.data.requiredScope).toBe('ai:write');
    expect(intentMocks.cancelOwnedMcpIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel (dismissed)', { action: 'cancel' }],
    ['absent inputResponses', undefined],
  ])('%s → current status, no cancel, no wait', async (_label, action) => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    const { body } = await retry(state, action);
    expect(body.result.structuredContent.status).toBe('pending_approval');
    expect(body.result.resultType).toBe('complete');
    expect(body.result).not.toHaveProperty('inputRequests');
    expect(intentMocks.cancelOwnedMcpIntent).not.toHaveBeenCalled();
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown action', { action: 'maybe' }],
    ['non-object response', 'x'],
  ])('malformed inputResponses (%s) → -32602', async (_label, response) => {
    const state = await firstCall();
    setRows(intentRow('pending_approval'));
    const { body } = await retry(state, response);
    expect(body.error.code).toBe(-32602);
    expect(intentMocks.cancelOwnedMcpIntent).not.toHaveBeenCalled();
    expect(mocks.waitForIntentTerminalOutcome).not.toHaveBeenCalled();
  });
});
