import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  captureExceptionMock,
  checkBudgetMock,
  checkSystemAiRateLimitMock,
  reserveAiBudgetMock,
  releaseUnusedAiBudgetMock,
  getEffectiveAiBudgetMock,
} = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  checkSystemAiRateLimitMock: vi.fn(),
  reserveAiBudgetMock: vi.fn(),
  releaseUnusedAiBudgetMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn().mockResolvedValue({ maxTurnsPerSession: 50 }),
}));
const { resolveSessionTurnMock, chooseSessionModelMock } = vi.hoisted(() => ({
  resolveSessionTurnMock: vi.fn(),
  chooseSessionModelMock: vi.fn(),
}));
// W03: helper turns (Task 7) and session create (Task 9) resolve through the registry.
vi.mock('../../services/aiModels/sessionModel', () => ({
  resolveSessionTurn: (...args: unknown[]) => resolveSessionTurnMock(...args),
  chooseSessionModel: (...args: unknown[]) => chooseSessionModelMock(...args),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  aiMessages: {},
  aiSessions: {
    id: 'aiSessions.id',
    deviceId: 'aiSessions.deviceId',
    userId: 'aiSessions.userId',
    clientUserId: 'aiSessions.clientUserId',
    agentId: 'aiSessions.agentId',
    status: 'aiSessions.status',
    title: 'aiSessions.title',
    turnCount: 'aiSessions.turnCount',
    contextSnapshot: 'aiSessions.contextSnapshot',
    createdAt: 'aiSessions.createdAt',
    updatedAt: 'aiSessions.updatedAt',
  },
  aiToolExecutions: {},
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion',
    agentVersion: 'devices.agentVersion',
    helperTokenHash: 'devices.helperTokenHash',
    previousHelperTokenHash: 'devices.previousHelperTokenHash',
    previousHelperTokenExpiresAt: 'devices.previousHelperTokenExpiresAt',
    pendingHelperTokenHash: 'devices.pendingHelperTokenHash',
    pendingTokenExpiresAt: 'devices.pendingTokenExpiresAt',
    status: 'devices.status',
    agentTokenSuspendedAt: 'devices.agentTokenSuspendedAt',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((...args: unknown[]) => ({ desc: args })),
  asc: vi.fn((...args: unknown[]) => ({ asc: args })),
  isNull: vi.fn((...args: unknown[]) => ({ isNull: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
}));

vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: vi.fn(() => true),
}));

// helperAuth now runs the shared device-credential lifecycle gate, whose tenant
// check hits the real `services/tenantStatus` (and therefore the mocked db).
// Stub it as an active tenant; the lifecycle denials are covered by
// middleware/helperAuth.test.ts and helperAuthLifecycle.integration.test.ts.
vi.mock('../../services/tenantStatus', () => ({
  getAgentTenantState: vi.fn(async () => 'active'),
}));

vi.mock('../../services/helperPermissions', () => ({
  resolveHelperPermissionLevelForDevice: vi.fn(),
}));

vi.mock('../../services/helperSettings', () => ({
  buildHelperConfigUpdate: vi.fn(async () => ({ enabled: true })),
}));

vi.mock('../../services/helperAiAgent', () => ({
  buildHelperSystemPrompt: vi.fn(() => 'helper system prompt'),
}));

vi.mock('../../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    get: vi.fn(() => undefined),
    getOrCreate: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    startTurnTimeout: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../services/aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk', name: 'breeze' })),
}));

vi.mock('../../services/aiInputSanitizer', () => ({
  sanitizeUserMessage: vi.fn(() => ({ sanitized: 'hello', flags: [] })),
}));

vi.mock('../../services/screenshotStorage', () => {
  class ScreenshotTooLargeError extends Error {}
  class ScreenshotQuotaExceededError extends Error {}
  return {
    storeScreenshot: vi.fn(),
    ScreenshotTooLargeError,
    ScreenshotQuotaExceededError,
  };
});

vi.mock('../../services/aiCostTracker', () => ({
  checkBudget: (...args: unknown[]) => checkBudgetMock(...args),
  checkSystemAiRateLimit: (...args: unknown[]) => checkSystemAiRateLimitMock(...args),
  getRemainingBudgetUsd: vi.fn(),
}));

vi.mock('../../services/effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

vi.mock('../../services/aiBudgetReservations', () => ({
  reserveAiBudget: (...args: unknown[]) => reserveAiBudgetMock(...args),
  releaseUnusedAiBudgetReservation: (...args: unknown[]) => releaseUnusedAiBudgetMock(...args),
}));

vi.mock('../../services', () => ({
  getRedis: vi.fn(() => null),
  rateLimiter: vi.fn(),
}));

vi.mock('../../services/aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(),
  createSessionPostToolUse: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
}));

vi.mock('../../services/llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {
    readonly status = 503;
    readonly code = 'ai_unavailable';
    constructor(message = 'AI is unavailable.') {
      super(message);
      this.name = 'LlmUnavailableError';
    }
  },
}));

vi.mock('../../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// Keep the real declaration schema + name helpers (used at route-construction
// time and for the allowlist), but stub the bridge resolver so tool-results
// tests can drive its outcome without a live SDK session.
vi.mock('../../services/clientSessionTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/clientSessionTools')>();
  return {
    ...actual,
    resolveClientDeclaredTool: vi.fn(),
    requestClientDeclaredTool: vi.fn(),
    createClientDeclaredMcpServer: vi.fn(() => ({ type: 'sdk', name: 'client_tools' })),
    failPendingClientDeclaredForSession: vi.fn(),
  };
});

import { makeResolvedModel } from '../../services/aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from '../../services/aiModels/turnBinding';
import { helperRoutes } from './index';
import { db, withDbAccessContext } from '../../db';
import { settleBlockedTurnForNewMessage } from '../../services/aiAgentSdk';
import { matchAgentTokenHash } from '../../middleware/agentAuth';
import { resolveHelperPermissionLevelForDevice } from '../../services/helperPermissions';
import { buildHelperSystemPrompt } from '../../services/helperAiAgent';
import { buildHelperConfigUpdate } from '../../services/helperSettings';
import { streamingSessionManager } from '../../services/streamingSessionManager';
import { LlmUnavailableError } from '../../services/llm/llmConfigResolver';
import { resolveClientDeclaredTool } from '../../services/clientSessionTools';
import { storeScreenshot } from '../../services/screenshotStorage';
import { createBreezeMcpServer } from '../../services/aiAgentSdkTools';
import { getHelperAllowedTools } from '../../services/helperToolFilter';

const VALID_TOOL_DECL = {
  name: 'search_files',
  description: 'search the estate for files',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

function helperChoice() {
  return {
    resolved: makeResolvedModel('anthropic_byok', { surface: 'helper' }),
    offeringId: 'off-1',
    offeringPartnerId: 'partner-1',
    options: null,
    model: 'claude-sonnet-5-5',
    billingSource: 'partner_key' as const,
  };
}

function mockHelperAuthDevice() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'device-1',
            agentId: 'agent-1',
            orgId: 'org-1',
            siteId: 'site-1',
            hostname: 'host-1',
            osType: 'linux',
            osVersion: '6.8',
            agentVersion: '1.0.0',
            helperTokenHash: 'hash',
            previousHelperTokenHash: null,
            previousHelperTokenExpiresAt: null,
            status: 'online',
            partnerId: 'partner-1',
          }]),
        }),
      }),
    }),
  } as never);
}

describe('helper routes permission derivation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    reserveAiBudgetMock.mockResolvedValue({
      kind: 'unlimited',
      reservationId: '11111111-1111-4111-8111-111111111111',
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });
    chooseSessionModelMock.mockResolvedValue(helperChoice());
    resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'helper' }));
    app = new Hono();
    app.route('/helper', helperRoutes);
  });

  it('ignores client-selected permissionLevel when creating helper sessions', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');

    let insertedValues: Record<string, unknown> | undefined;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues = values;
        return {
          returning: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        };
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionLevel: 'extended', helperUser: 'alice' }),
    });

    expect(res.status).toBe(201);
    expect(matchAgentTokenHash).toHaveBeenCalledWith(expect.objectContaining({
      agentTokenHash: 'hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }));
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'basic');
    expect((insertedValues?.contextSnapshot as Record<string, unknown>).permissionLevel).toBe('standard');
    // W03 Task 9: the session is created on the registry's helper offering.
    expect(insertedValues).toMatchObject({
      offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null,
      model: 'claude-sonnet-5-5', billingSource: 'partner_key',
    });
    expect(chooseSessionModelMock).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: null, surface: 'helper',
    });
  });

  // #6473 — Helper-originated sessions were the third createSession-shaped
  // call site left silently pinned to the ai_sessions schema default (50).
  it('sets maxTurns from the effective org/partner budget, not the schema default', async () => {
    mockHelperAuthDevice();
    getEffectiveAiBudgetMock.mockResolvedValueOnce({ maxTurnsPerSession: 100 });

    let insertedValues: Record<string, unknown> | undefined;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues = values;
        return {
          returning: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        };
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    expect(getEffectiveAiBudgetMock).toHaveBeenCalledWith('org-1');
    expect(insertedValues?.maxTurns).toBe(100);
  });

  it('returns ai_unavailable as 503 before inserting a helper session', async () => {
    mockHelperAuthDevice();
    chooseSessionModelMock.mockRejectedValue(new LlmUnavailableError());

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ partnerId: 'attacker-partner' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(db.insert).not.toHaveBeenCalled();
    // The body's partnerId is ignored: the device's own partner is resolved.
    expect(chooseSessionModelMock).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'partner-1' }));
  });

  it('captures resolver throws and returns a generic retryable 503 when creating a session', async () => {
    mockHelperAuthDevice();
    const resolverError = new Error('database driver detail');
    chooseSessionModelMock.mockRejectedValueOnce(resolverError);

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'AI configuration could not be loaded. Try again.' });
    expect(captureExceptionMock).toHaveBeenCalledWith(resolverError, expect.anything(), {
      service: 'helperRoutes',
      orgId: 'org-1',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns helper config with server-derived permissionLevel', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('extended');

    const res = await app.request('/helper/config', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionLevel).toBe('extended');
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'basic');
  });

  it('refuses /helper/config with helper_disabled when the effective setting is off', async () => {
    mockHelperAuthDevice();
    vi.mocked(buildHelperConfigUpdate).mockResolvedValueOnce({ enabled: false } as never);

    const res = await app.request('/helper/config', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('helper_disabled');
    expect(buildHelperConfigUpdate).toHaveBeenCalledWith('device-1', 'org-1');
  });

  it('reports enabled:true when the effective setting is enabled', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');
    vi.mocked(buildHelperConfigUpdate).mockResolvedValueOnce({ enabled: true } as never);

    const res = await app.request('/helper/config', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });

  it('uses server-derived permissionLevel and allowlist when sending messages', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'stale extended helper prompt',
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const activeSession = {
      inputController: { pushMessage: vi.fn() },
      eventBus: {
        subscribe: vi.fn(async function* () {
          yield { type: 'done' };
        }),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      state: 'idle',
    };
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession as never);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(buildHelperSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      permissionLevel: 'standard',
      deviceId: 'device-1',
    }));

    const getOrCreateCall = vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0];
    const systemPrompt = getOrCreateCall?.[4];
    const allowedTools = getOrCreateCall?.[7] as string[] | undefined;

    expect(systemPrompt).toBe('helper system prompt');
    expect(allowedTools).toContain('mcp__breeze__file_operations');
    expect(allowedTools).not.toContain('mcp__breeze__execute_command');
    expect(getOrCreateCall?.[6]).toEqual(expect.objectContaining({
      funding: 'partner_key',
      connection: expect.objectContaining({ id: 'conn-1', kind: 'anthropic_byok' }),
      configVersion: 2,
    }));
    // A-W04: Helper REGISTERS only its permission level's tools (onlyTools),
    // not the whole registry behind a permission-only allowlist, and resolves
    // no tenant tools (none are in its allowlist).
    const factory = getOrCreateCall?.[8] as ((...args: unknown[]) => { server: unknown; name: string }) | undefined;
    expect(typeof factory).toBe('function');
    const built = factory!(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    expect(built.name).toBe('breeze');
    const serverCall = vi.mocked(createBreezeMcpServer).mock.calls.at(-1)!;
    expect(serverCall[4]).toEqual([]);
    const onlyTools = (serverCall[5] as { onlyTools: Set<string> }).onlyTools;
    expect([...onlyTools].sort()).toEqual(getHelperAllowedTools('standard').sort());
    expect(allowedTools!.map((n) => n.replace('mcp__breeze__', '')).sort()).toEqual([...onlyTools].sort());
    expect(resolveSessionTurnMock).toHaveBeenCalledWith({ sessionId: 'session-1', surface: 'helper', userId: null });
    expect(chooseSessionModelMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).toHaveBeenCalledWith('org-1', 'partner_key');
    // Org-axis AI rate limiter — the same ceiling technician chat enforces
    // via checkAiRateLimit. Helper sessions are device-scoped with no acting
    // user id, so this must be the org-only (no per-user bucket) form.
    expect(checkSystemAiRateLimitMock).toHaveBeenCalledWith('org-1');
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'basic');
  });

  function mockHelperMessageSession() {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'stale extended helper prompt',
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);
  }

  it('dispatches and reserves exactly the model resolved for the helper surface (finding 13)', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');
    const model = makeResolvedModel('anthropic_byok', { surface: 'helper' });
    resolveSessionTurnMock.mockResolvedValue(model);
    mockHelperMessageSession();
    vi.mocked(db.insert).mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) } as never);
    const activeSession = {
      inputController: { pushMessage: vi.fn() },
      eventBus: {
        subscribe: vi.fn(async function* () { yield { type: 'done' }; }),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      state: 'idle',
    };
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession as never);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(resolveSessionTurnMock).toHaveBeenCalledWith({ sessionId: 'session-1', surface: 'helper', userId: null });
    const call = vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]!;
    expect(call[6]).toBe(model);
    expect(call[1]).not.toHaveProperty('model');
    expect(call[9]).toEqual(expect.objectContaining({ ledgerUserId: null }));
    expect(reserveAiBudgetMock).toHaveBeenCalledWith(expect.objectContaining({
      billingSource: 'partner_key', binding: turnBindingFrom(model),
    }));
    expect(streamingSessionManager.tryTransitionToProcessing).toHaveBeenCalledWith(
      activeSession, expect.any(String), expect.objectContaining({ turnBinding: turnBindingFrom(model) }),
    );
  });

  it('an ineligible stored model is a recoverable 409 and takes no reservation', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');
    resolveSessionTurnMock.mockResolvedValue({
      ok: false, reason: 'model_unavailable', recoverable: true, offeringId: 'off-1',
      message: 'Model Opus 5.5 is no longer available — choose another.',
    });
    mockHelperMessageSession();

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Model Opus 5.5 is no longer available — choose another.', code: 'model_unavailable', recoverable: true,
    });
    expect(reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(checkBudgetMock).not.toHaveBeenCalled();
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('429s a turn when the org-wide AI rate limit is exceeded', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');
    checkSystemAiRateLimitMock.mockResolvedValueOnce('Organization rate limit exceeded. Try again at 2026-01-01T00:00:00.000Z');

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'stale extended helper prompt',
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(429);
    expect(db.insert).not.toHaveBeenCalled();
    expect(reserveAiBudgetMock).not.toHaveBeenCalled();
  });

  // #3127: under its real /api/v1 mount the message-send route is registered in
  // selfManagedDbContextRoutes, so helperAuth opens no request transaction and
  // the settle wait runs with no DB context held, between two short ones.
  it('#3127: settles an approval-blocked turn with no DB context held, between two short ones', async () => {
    let depth = 0;
    vi.mocked(withDbAccessContext).mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    });
    const depths: Record<string, number> = {};
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockImplementation(async () => {
      depths.preflight = depth;
      return 'standard';
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'prompt',
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);
    vi.mocked(db.insert).mockImplementationOnce(() => {
      depths.insert = depth;
      return { values: vi.fn().mockResolvedValue(undefined) } as never;
    });
    const activeSession = {
      inputController: { pushMessage: vi.fn() },
      eventBus: {
        subscribe: vi.fn(async function* () {
          yield { type: 'done' };
        }),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      state: 'processing',
    };
    vi.mocked(streamingSessionManager.get)
      .mockReturnValueOnce(activeSession as never)
      .mockReturnValueOnce(undefined);
    vi.mocked(settleBlockedTurnForNewMessage).mockImplementationOnce(async () => {
      depths.settle = depth;
      return 'concluded';
    });
    reserveAiBudgetMock.mockImplementationOnce(async () => {
      depths.reserve = depth;
      return {
        kind: 'unlimited',
        reservationId: '11111111-1111-4111-8111-111111111111',
        dailyPeriodKey: '2026-09-06',
        monthlyPeriodKey: '2026-09-01',
        status: 'active',
      };
    });
    vi.mocked(streamingSessionManager.getOrCreate).mockImplementation(async () => {
      depths.getOrCreate = depth;
      return activeSession as never;
    });
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);

    const apiApp = new Hono();
    apiApp.route('/api/v1/helper', helperRoutes);
    const res = await apiApp.request('/api/v1/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(depths).toEqual({ preflight: 1, settle: 0, reserve: 0, getOrCreate: 1, insert: 1 });
    expect(activeSession.inputController.pushMessage).toHaveBeenCalledWith('hello');
    expect(depth).toBe(0);
  });

  it('#7783: subscribes to the session events BEFORE the turn is pushed: a transport that answers at once still reaches the helper', async () => {
    // The real SessionEventBus has no replay: an event published while nobody
    // is subscribed is gone. Model a transport fast enough to publish the
    // whole turn synchronously when the message is pushed.
    const subscribers = new Map<string, Array<{ type: string; message?: string }>>();
    const waiters = new Map<string, () => void>();
    const bus = {
      subscribe: vi.fn((id: string) => {
        subscribers.set(id, []);
        return (async function* () {
          for (;;) {
            const queue = subscribers.get(id)!;
            while (queue.length) {
              const event = queue.shift()!;
              yield event;
              if (event.type === 'done') return;
            }
            await new Promise<void>((resolve) => { waiters.set(id, resolve); });
          }
        })();
      }),
      unsubscribe: vi.fn((id: string) => { subscribers.delete(id); }),
      publish: vi.fn((event: { type: string; message?: string }) => {
        for (const [id, queue] of subscribers) { queue.push(event); waiters.get(id)?.(); }
      }),
    };
    mockHelperAuthDevice();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1', orgId: 'org-1', deviceId: 'device-1', sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929', maxTurns: 50, turnCount: 0, status: 'active',
            title: 'Existing title', systemPrompt: 'prompt', createdAt: new Date(),
          }]),
        }),
      }),
    } as never);
    vi.mocked(db.insert).mockImplementationOnce(() => ({ values: vi.fn().mockResolvedValue(undefined) }) as never);
    const activeSession = {
      inputController: {
        pushMessage: vi.fn(() => {
          bus.publish({ type: 'error', message: 'helper turn failed fast' });
          bus.publish({ type: 'done' });
        }),
      },
      eventBus: bus,
      state: 'processing',
    };
    vi.mocked(streamingSessionManager.get).mockReturnValue(undefined as never);
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession as never);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);

    const apiApp = new Hono();
    apiApp.route('/api/v1/helper', helperRoutes);
    const res = await apiApp.request('/api/v1/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('helper turn failed fast');
    expect(bus.unsubscribe).toHaveBeenCalled();
  });

  it('an unusable connection on a turn is a recoverable 409 before touching the SDK manager; a client partnerId is ignored', async () => {
    mockHelperAuthDevice();
    resolveSessionTurnMock.mockResolvedValue({
      ok: false, reason: 'connection_unavailable', recoverable: true, offeringId: 'off-1',
      message: 'The AI provider connection for this model is unavailable. Reconnect it under AI Providers & Models.',
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            status: 'active',
            maxTurns: 50,
            turnCount: 0,
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello', partnerId: 'attacker-partner' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The AI provider connection for this model is unavailable. Reconnect it under AI Providers & Models.',
      code: 'connection_unavailable',
      recoverable: true,
    });
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    expect(reserveAiBudgetMock).not.toHaveBeenCalled();
    expect(resolveSessionTurnMock).toHaveBeenCalledWith({ sessionId: 'session-1', surface: 'helper', userId: null });
  });

  /**
   * Last-resort guard (#3922 W3 review round 2): the model is resolved in
   * preflight now, but an LlmUnavailableError from the manager must still map
   * to 503 ai_unavailable rather than reach Hono's onError as a 500.
   */
  it('maps a wire-model fail-close from the SDK manager to 503 ai_unavailable', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-opus-4-8',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'prompt',
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);
    vi.mocked(streamingSessionManager.getOrCreate).mockRejectedValue(new LlmUnavailableError());

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    // Fail CLOSED: the turn's user message is never persisted under a session
    // that produced no assistant turn.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('captures resolver throws and returns a generic retryable 503 on a turn', async () => {
    mockHelperAuthDevice();
    resolveSessionTurnMock.mockRejectedValueOnce(new Error('decrypt subsystem failed'));
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            status: 'active',
            maxTurns: 50,
            turnCount: 0,
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'AI configuration could not be loaded. Try again.' });
    expect(captureExceptionMock).toHaveBeenCalledOnce();
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });
});

describe('helper client-declared session tools', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    reserveAiBudgetMock.mockResolvedValue({
      kind: 'unlimited',
      reservationId: '11111111-1111-4111-8111-111111111111',
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });
    chooseSessionModelMock.mockResolvedValue(helperChoice());
    resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'helper' }));
    app = new Hono();
    app.route('/helper', helperRoutes);
  });

  it('persists validated clientTools into the session contextSnapshot at create', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('basic');

    let insertedValues: Record<string, unknown> | undefined;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues = values;
        return { returning: vi.fn().mockResolvedValue([{ id: 'session-1' }]) };
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientTools: [VALID_TOOL_DECL] }),
    });

    expect(res.status).toBe(201);
    const snapshot = insertedValues?.contextSnapshot as Record<string, unknown>;
    expect(snapshot.clientTools).toEqual([VALID_TOOL_DECL]);
  });

  it('rejects an invalid clientTools declaration at create (400)', async () => {
    mockHelperAuthDevice();

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientTools: [{ name: 'Bad-Name', description: 'x', inputSchema: { type: 'object' } }] }),
    });

    expect(res.status).toBe(400);
  });

  it('passes the client-declared MCP factory + tool allowlist when the session has clientTools', async () => {
    mockHelperAuthDevice();
    vi.mocked(resolveHelperPermissionLevelForDevice).mockResolvedValue('standard');

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'session-1',
            orgId: 'org-1',
            deviceId: 'device-1',
            sdkSessionId: null,
            model: 'claude-sonnet-4-5-20250929',
            maxTurns: 50,
            turnCount: 0,
            status: 'active',
            title: 'Existing title',
            systemPrompt: 'prompt',
            contextSnapshot: { clientTools: [VALID_TOOL_DECL] },
            createdAt: new Date(),
          }]),
        }),
      }),
    } as never);

    vi.mocked(db.insert).mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) } as never);

    const activeSession = {
      inputController: { pushMessage: vi.fn() },
      eventBus: {
        subscribe: vi.fn(async function* () { yield { type: 'done' }; }),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      state: 'idle',
    };
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(activeSession as never);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);

    const res = await app.request('/helper/chat/sessions/session-1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'find the henderson easement' }),
    });
    await res.text();

    expect(res.status).toBe(200);
    const call = vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0];
    const allowedTools = call?.[7] as string[] | undefined;
    expect(allowedTools).toEqual(['mcp__client_tools__search_files']);
    // The client-declared MCP factory is passed (a function), replacing the default.
    expect(typeof call?.[8]).toBe('function');
  });

  it('resolves a client tool result (200) and persists a tool_result row with the posted output', async () => {
    mockHelperAuthDevice();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        }),
      }),
    } as never);
    vi.mocked(resolveClientDeclaredTool).mockReturnValue('resolved');

    let insertedResult: Record<string, unknown> | undefined;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedResult = values;
        return undefined;
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-1/tool-results', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', output: { files: [] } }),
    });

    expect(res.status).toBe(200);
    expect(resolveClientDeclaredTool).toHaveBeenCalledWith('session-1', 'tu-1', { output: { files: [] }, error: undefined });
    // A generic tool_result transcript row is written so History reopens render.
    expect(insertedResult?.role).toBe('tool_result');
    expect(insertedResult?.toolUseId).toBe('tu-1');
    expect(insertedResult?.toolOutput).toEqual({ files: [] });
  });

  it('409s a duplicate tool result post', async () => {
    mockHelperAuthDevice();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        }),
      }),
    } as never);
    vi.mocked(resolveClientDeclaredTool).mockReturnValue('duplicate');

    const res = await app.request('/helper/chat/sessions/session-1/tool-results', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', output: {} }),
    });

    expect(res.status).toBe(409);
  });

  it('404s an unknown tool result post', async () => {
    mockHelperAuthDevice();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        }),
      }),
    } as never);
    vi.mocked(resolveClientDeclaredTool).mockReturnValue('not_found');

    const res = await app.request('/helper/chat/sessions/session-1/tool-results', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-x', output: {} }),
    });

    expect(res.status).toBe(404);
  });

  it('404s a tool result for a session owned by another device', async () => {
    mockHelperAuthDevice();
    // Session-owner select returns no row (wrong device).
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-9/tool-results', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', output: {} }),
    });

    expect(res.status).toBe(404);
    expect(resolveClientDeclaredTool).not.toHaveBeenCalled();
  });
});

// ============================================
// Helper session ownership scoping
//
// ai_sessions is org-axis RLS only: a technician's device-bound session (userId
// set) and a helper-created session (userId null, contextSnapshot.source =
// 'helper') share the same org_id/device_id. Every helper session route must
// add an app-layer predicate restricting reads/writes to sessions the helper
// itself created, or a helper token for device A can reach a technician's
// device-task session for the same device. These tests build the actual
// `where(...)` predicate tree from the mocked eq/and/isNull/sql and evaluate
// it against fixture rows, so they fail red on the pre-fix query (which never
// added the extra predicate, so every row matched) and pass once the route
// filters on it.
// ============================================

function conditionColumnKey(col: unknown): string {
  return String(col).split('.').pop() ?? String(col);
}

type MockedCond =
  | { eq: [unknown, unknown] }
  | { and: MockedCond[] }
  | { isNull: [unknown] }
  | { sql: unknown; values: unknown[] }
  | Record<string, unknown>;

function conditionMatchesRow(cond: MockedCond, row: Record<string, unknown>): boolean {
  if ('eq' in cond && Array.isArray((cond as { eq: unknown }).eq)) {
    const [col, val] = (cond as { eq: [unknown, unknown] }).eq;
    return row[conditionColumnKey(col)] === val;
  }
  if ('and' in cond && Array.isArray((cond as { and: unknown }).and)) {
    return (cond as { and: MockedCond[] }).and.every((c) => conditionMatchesRow(c, row));
  }
  if ('isNull' in cond && Array.isArray((cond as { isNull: unknown }).isNull)) {
    const [col] = (cond as { isNull: [unknown] }).isNull;
    return row[conditionColumnKey(col)] == null;
  }
  if ('sql' in cond) {
    // helperOwnedSessionConditions' contextSnapshot->>'source' = 'helper' check.
    const snapshot = row.contextSnapshot as Record<string, unknown> | null | undefined;
    return snapshot?.source === 'helper';
  }
  return true;
}

/** Session select that actually filters fixture rows against the route's built WHERE tree. */
function mockFilteredSessionSelect(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn((cond: MockedCond) => ({
        limit: vi.fn().mockResolvedValue(rows.filter((r) => conditionMatchesRow(cond, r))),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows.filter((r) => conditionMatchesRow(cond, r))),
        }),
      })),
    }),
  } as never);
}

const HELPER_OWNED_SESSION = {
  id: 'session-helper',
  orgId: 'org-1',
  deviceId: 'device-1',
  userId: null,
  status: 'active',
  title: null,
  turnCount: 0,
  maxTurns: 50,
  model: 'claude-sonnet-4-5-20250929',
  sdkSessionId: null,
  systemPrompt: 'helper prompt',
  createdAt: new Date(),
  updatedAt: new Date(),
  contextSnapshot: { source: 'helper', deviceId: 'device-1' },
};

// Same device, but created by a technician (device-task "Ask AI" session) —
// this must stay unreachable through any helper-token route.
const TECHNICIAN_SESSION_SAME_DEVICE = {
  id: 'session-tech',
  orgId: 'org-1',
  deviceId: 'device-1',
  userId: 'tech-user-1',
  status: 'active',
  title: 'Reliability panel session',
  turnCount: 1,
  maxTurns: 50,
  model: 'claude-sonnet-4-5-20250929',
  sdkSessionId: 'sdk-session-abc',
  systemPrompt: 'technician prompt',
  createdAt: new Date(),
  updatedAt: new Date(),
  contextSnapshot: { pageContext: 'device-details' },
};

describe('helper session ownership scoping (cross-principal isolation)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    chooseSessionModelMock.mockResolvedValue(helperChoice());
    resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'helper' }));
    app = new Hono();
    app.route('/helper', helperRoutes);
  });

  it('reads messages for a session the helper itself created (same device, allowed)', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{ id: 'm1', role: 'user', content: 'hi', toolName: null, toolOutput: null, createdAt: new Date() }]),
        }),
      }),
    } as never);

    const res = await app.request('/helper/chat/sessions/session-helper/messages', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(200);
  });

  it('denies reading a technician device-task session transcript for the same device', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions/session-tech/messages', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(404);
  });

  it('excludes the technician device-task session from the helper session list', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((s: { id: string }) => s.id)).toEqual(['session-helper']);
  });

  it('denies posting into a technician device-task session (turn resume by the helper)', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions/session-tech/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'planted instruction' }),
    });

    expect(res.status).toBe(404);
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it('denies closing a technician device-task session', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions/session-tech', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(404);
  });

  it('denies flagging a technician device-task session', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions/session-tech/flag', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'suspicious' }),
    });

    expect(res.status).toBe(404);
  });

  it('denies posting a tool-result into a technician device-task session', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/chat/sessions/session-tech/tool-results', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: 'tu-1', output: {} }),
    });

    expect(res.status).toBe(404);
    expect(resolveClientDeclaredTool).not.toHaveBeenCalled();
  });

  // Defense in depth: a session carrying ANY principal (agent run, portal
  // client user) is never helper-owned, even if its snapshot claims
  // source='helper'. The single-principal check constraint keeps userId null
  // on these rows, so the userId predicate alone would not exclude them.
  it.each([
    ['AI-agent run session', { agentId: 'ai-agent-1' }],
    ['portal client-user session', { clientUserId: 'portal-user-1' }],
  ])('denies reading a %s bound to the same device even with a helper source stamp', async (_label, principal) => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([
      { ...HELPER_OWNED_SESSION, id: 'session-principal', ...principal },
    ]);

    const res = await app.request('/helper/chat/sessions/session-principal/messages', {
      headers: { Authorization: 'Bearer brz_agent_token' },
    });

    expect(res.status).toBe(404);
  });

  it('refuses to attach a screenshot to a technician device-task session', async () => {
    mockHelperAuthDevice();
    mockFilteredSessionSelect([HELPER_OWNED_SESSION, TECHNICIAN_SESSION_SAME_DEVICE]);

    const res = await app.request('/helper/screenshots', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: 'aGVsbG8=', width: 10, height: 10,
        sessionId: '00000000-0000-4000-8000-000000000002',
      }),
    });

    expect(res.status).toBe(404);
    expect(storeScreenshot).not.toHaveBeenCalled();
  });

  it('attaches a screenshot to a session the helper itself created', async () => {
    const helperSessionId = '00000000-0000-4000-8000-000000000001';
    mockHelperAuthDevice();
    mockFilteredSessionSelect([{ ...HELPER_OWNED_SESSION, id: helperSessionId }]);
    vi.mocked(storeScreenshot).mockResolvedValueOnce({
      id: 'shot-1', storageKey: 'k', sizeBytes: 5, expiresAt: new Date(),
    } as never);

    const res = await app.request('/helper/screenshots', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'aGVsbG8=', width: 10, height: 10, sessionId: helperSessionId }),
    });

    expect(res.status).toBe(200);
    expect(storeScreenshot).toHaveBeenCalledWith(expect.objectContaining({ sessionId: helperSessionId }));
  });
});

describe('POST /helper/screenshots', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/helper', helperRoutes);
    const { getRedis } = await import('../../services');
    vi.mocked(getRedis).mockReturnValue(null);
  });

  function postScreenshot(body: Record<string, unknown> = {}) {
    return app.request('/helper/screenshots', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: 'dGVzdGltYWdl',
        width: 100,
        height: 100,
        ...body,
      }),
    });
  }

  it('stores the screenshot and returns its metadata on success', async () => {
    mockHelperAuthDevice();
    const { storeScreenshot } = await import('../../services/screenshotStorage');
    vi.mocked(storeScreenshot).mockResolvedValue({
      id: 'shot-1',
      storageKey: 'screenshots/org-1/device-1/shot-1.jpg',
      width: 100,
      height: 100,
      sizeBytes: 9,
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });

    const res = await postScreenshot();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(expect.objectContaining({ id: 'shot-1', sizeBytes: 9 }));
  });

  it('rejects with 429 once the per-device rate limit is hit', async () => {
    mockHelperAuthDevice();
    const { getRedis, rateLimiter } = await import('../../services');
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const { storeScreenshot } = await import('../../services/screenshotStorage');

    const res = await postScreenshot();

    expect(res.status).toBe(429);
    expect(storeScreenshot).not.toHaveBeenCalled();
  });

  it('rejects with 413 when storeScreenshot reports an oversized image', async () => {
    mockHelperAuthDevice();
    const { storeScreenshot, ScreenshotTooLargeError } = await import('../../services/screenshotStorage');
    vi.mocked(storeScreenshot).mockRejectedValue(new ScreenshotTooLargeError(2_000_000, 1_600_000));

    const res = await postScreenshot();

    expect(res.status).toBe(413);
  });

  it('rejects with 429 when storeScreenshot reports the device quota is exceeded', async () => {
    mockHelperAuthDevice();
    const { storeScreenshot, ScreenshotQuotaExceededError } = await import('../../services/screenshotStorage');
    vi.mocked(storeScreenshot).mockRejectedValue(new ScreenshotQuotaExceededError('device-1', 'count'));

    const res = await postScreenshot();

    expect(res.status).toBe(429);
  });
});
