import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  checkBudget: vi.fn(),
  getRemainingBudgetUsd: vi.fn(),
}));

vi.mock('../../services', () => ({
  getRedis: vi.fn(() => null),
  rateLimiter: vi.fn(),
}));

vi.mock('../../services/aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(),
  createSessionPostToolUse: vi.fn(),
}));

import { helperRoutes } from './index';
import { db } from '../../db';
import { matchAgentTokenHash } from '../../middleware/agentAuth';
import { resolveHelperPermissionLevelForDevice } from '../../services/helperPermissions';
import { buildHelperSystemPrompt } from '../../services/helperAiAgent';
import { streamingSessionManager } from '../../services/streamingSessionManager';

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
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'standard');
    expect((insertedValues?.contextSnapshot as Record<string, unknown>).permissionLevel).toBe('standard');
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
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'standard');
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
    const allowedTools = getOrCreateCall?.[6] as string[] | undefined;

    expect(systemPrompt).toBe('helper system prompt');
    expect(allowedTools).toContain('mcp__breeze__file_operations');
    expect(allowedTools).not.toContain('mcp__breeze__execute_command');
    expect(resolveHelperPermissionLevelForDevice).toHaveBeenCalledWith('device-1', 'standard');
  });
});
