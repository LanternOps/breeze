/**
 * W5 PR C (#5220), Task C3 — getOrCreate wires the session's flow tools
 * (`flow__<slug>`, resolveFlowTools) beside its tenant tools: what resolves
 * is what the session exposes; a failure degrades to none; the flag off (the
 * resolver answers []) leaves none.
 *
 * Mock harness copied from streamingSessionManager.tenantTools.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, getEffectiveAiBudgetMock, resolveTenantToolsMock, captureExceptionMock, resolveFlowToolsMock } = vi.hoisted(() => ({
  resolveFlowToolsMock: vi.fn(),
  queryMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn(),
  resolveTenantToolsMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock, tool: vi.fn() }));

const dbSelectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
  })),
}));

// Wisp W04 Task 4: getOrCreate resolves the session's delegation grant itself
// (lookupWispGrant); every session in this suite is an ordinary one.
vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: vi.fn(async () => null),
  unreachableWispAuth: (auth: unknown) => auth,
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {},
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...(args as [])),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

vi.mock('./aiCostTracker', () => ({
  sumInputTokens: () => 0,
}));
vi.mock('./aiBudgetReservations', () => ({
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({ kind: 'indeterminate' })),
  readSdkUsageSnapshot: vi.fn(async () => null),
}));
vi.mock('./aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('./aiModels/platformModels')>()),
  getPlatformModelByModelId: vi.fn(async () => null),
}));
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: [], deferred: false })),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
}));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (s: unknown) => s,
  compactToolResultForChat: (_name: string, s: string) => s,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

// The seam under test: a real `resolveTenantTools` failure (source
// unreachable, decrypt error, etc.) must not propagate out of `getOrCreate`.
vi.mock('./toolSources/resolver', () => ({
  resolveTenantTools: (...args: unknown[]) => resolveTenantToolsMock(...args),
}));

const flagState = vi.hoisted(() => ({ on: true }));
vi.mock('../config/env', async (orig) => ({ ...(await orig<typeof import('../config/env')>()), flowsEnabled: () => flagState.on }));
vi.mock('./flows/flowTools', () => ({
  resolveFlowTools: (...args: unknown[]) => resolveFlowToolsMock(...args),
}));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { buildOrgAccessClosures } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';

const ORG_ID = 'aaaaaaaa-1111-4222-8333-444455556666';
const USER_ID = 'eeeeeeee-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG_ID,
  sdkSessionId: null,
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
  deviceId: null,
};

const PLATFORM_CONFIG = makeResolvedModel('platform');

function makeAuth(): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    accessibleOrgIds: [ORG_ID],
    ...buildOrgAccessClosures([ORG_ID]),
    user: { id: USER_ID, email: 'tech@msp.example' },
  } as unknown as AuthContext;
}

function budget(approvalMode: string) {
  return {
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode,
    alertThresholdPercents: [],
  };
}

function create(manager: StreamingSessionManager, id: string) {
  return manager.getOrCreate(id, DB_SESSION, makeAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
}

describe('getOrCreate — flow tools (W5 PR C)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    getEffectiveAiBudgetMock.mockResolvedValue(budget('per_step'));
    resolveTenantToolsMock.mockResolvedValue([]);
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('exposes the flow tools that resolve for the session org', async () => {
    const d = (name: string) => ({ name, flowId: name, definition: { name, description: `Flow: ${name}`, input_schema: { type: 'object', properties: {} } } });
    resolveFlowToolsMock.mockResolvedValue([d('flow__disk'), d('flow__sweep')]);
    const session = await create(manager, 'sess-flow-tools-ok');
    expect([...(session.flowTools?.keys() ?? [])]).toEqual(['flow__disk', 'flow__sweep']);
    expect(resolveFlowToolsMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }), ORG_ID);
  });

  it('flag off ⇒ no flow tools in the session, and the resolver is never reached', async () => {
    flagState.on = false;
    try {
      resolveFlowToolsMock.mockResolvedValue([{ name: 'flow__disk', flowId: 'f1', definition: { name: 'flow__disk', description: 'x', input_schema: { type: 'object', properties: {} } } }]);
      const session = await create(manager, 'sess-flow-tools-off');
      expect(session.flowTools?.size).toBe(0);
      expect(resolveFlowToolsMock).not.toHaveBeenCalled();
    } finally {
      flagState.on = true;
    }
  });

  it('degrades to no flow tools instead of failing the chat session', async () => {
    resolveFlowToolsMock.mockRejectedValue(new Error('db down'));
    const session = await create(manager, 'sess-flow-tools-fail');
    expect(session.flowTools?.size).toBe(0);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
