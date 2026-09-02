import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { captureExceptionMock, resolveLlmConfigMock, checkBudgetMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  resolveLlmConfigMock: vi.fn(),
  checkBudgetMock: vi.fn(),
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
}));

vi.mock('../../db/schema', () => ({
  aiMessages: {},
  aiSessions: {
    id: 'aiSessions.id',
    deviceId: 'aiSessions.deviceId',
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
    status: 'devices.status',
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
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
}));

vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: vi.fn(() => true),
}));

vi.mock('../../services/helperPermissions', () => ({
  resolveHelperPermissionLevelForDevice: vi.fn(),
}));

vi.mock('../../services/helperAiAgent', () => ({
  buildHelperSystemPrompt: vi.fn(() => 'helper system prompt'),
}));

vi.mock('../../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    startTurnTimeout: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../services/aiInputSanitizer', () => ({
  sanitizeUserMessage: vi.fn(() => ({ sanitized: 'hello', flags: [] })),
}));

vi.mock('../../services/screenshotStorage', () => ({
  storeScreenshot: vi.fn(),
}));

vi.mock('../../services/aiCostTracker', () => ({
  checkBudget: (...args: unknown[]) => checkBudgetMock(...args),
  getRemainingBudgetUsd: vi.fn(),
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
  resolveLlmConfig: (...args: unknown[]) => resolveLlmConfigMock(...args),
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

import { helperRoutes } from './index';
import { db } from '../../db';
import { matchAgentTokenHash } from '../../middleware/agentAuth';
import { resolveHelperPermissionLevelForDevice } from '../../services/helperPermissions';
import { buildHelperSystemPrompt } from '../../services/helperAiAgent';
import { streamingSessionManager } from '../../services/streamingSessionManager';
import { LlmUnavailableError } from '../../services/llm/llmConfigResolver';
import { resolveClientDeclaredTool } from '../../services/clientSessionTools';

const VALID_TOOL_DECL = {
  name: 'search_files',
  description: 'search the estate for files',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

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
    resolveLlmConfigMock.mockResolvedValue({
      source: 'partner',
      partnerId: 'partner-1',
      apiKey: 'partner-key',
      model: 'claude-opus-4-6',
      configId: 'config-1',
      configVersion: 5,
    });
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
    expect(insertedValues?.model).toBe('claude-opus-4-6');
    expect(resolveLlmConfigMock).toHaveBeenCalledWith('partner-1');
  });

  it('returns ai_unavailable as 503 before inserting a helper session', async () => {
    mockHelperAuthDevice();
    resolveLlmConfigMock.mockResolvedValue({
      source: 'unavailable',
      partnerId: 'partner-1',
      reason: 'key_error',
    });

    const res = await app.request('/helper/chat/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_agent_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ partnerId: 'attacker-partner' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(resolveLlmConfigMock).toHaveBeenCalledWith('partner-1');
  });

  it('captures resolver throws and returns a generic retryable 503 when creating a session', async () => {
    mockHelperAuthDevice();
    const resolverError = new Error('database driver detail');
    resolveLlmConfigMock.mockRejectedValueOnce(resolverError);

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
    // Isolation: sessions without client tools pass NO mcpServerFactory — the
    // default breeze MCP path is byte-identical to today.
    expect(getOrCreateCall?.[6]).toEqual(expect.objectContaining({
      source: 'partner',
      configId: 'config-1',
      configVersion: 5,
    }));
    expect(getOrCreateCall?.[8]).toBeUndefined();
    expect(resolveLlmConfigMock).toHaveBeenCalledWith('partner-1');
    expect(checkBudgetMock).toHaveBeenCalledWith('org-1', 'partner_key');
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'basic');
  });

  it('returns ai_unavailable as 503 before touching the SDK manager on a turn', async () => {
    mockHelperAuthDevice();
    resolveLlmConfigMock.mockResolvedValue({
      source: 'unavailable',
      partnerId: 'partner-1',
      reason: 'key_error',
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

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    expect(resolveLlmConfigMock).toHaveBeenCalledWith('partner-1');
  });

  /**
   * The resolver-level check above cannot see this one: `getOrCreate` resolves
   * the WIRE model inside the manager, so a pinned revision with no verified
   * mapping for this session's model throws only once the manager is already
   * running (#3922 W3 review round 2). Unmapped, it reached Hono's onError as a
   * 500 — telling the helper "we broke" instead of "reconnect your provider".
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
    resolveLlmConfigMock.mockRejectedValueOnce(new Error('decrypt subsystem failed'));
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
    resolveLlmConfigMock.mockResolvedValue({
      source: 'partner',
      partnerId: 'partner-1',
      apiKey: 'partner-key',
      model: 'claude-opus-4-6',
      configId: 'config-1',
      configVersion: 5,
    });
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
