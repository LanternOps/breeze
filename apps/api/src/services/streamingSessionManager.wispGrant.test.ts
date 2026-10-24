/**
 * Wisp W04 Task 4 — the STRUCTURAL guarantee: every ActiveSession built for a
 * grant-pinned ai_sessions row carries its grant, because getOrCreate resolves
 * it from the row itself (lookupWispGrant), never from a route argument — and
 * a pinned row it cannot resolve never becomes a session that runs tools
 * ungated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, capturedMcpArgs, capturedTenantSdkToolArgs, lookupWispGrantMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  capturedMcpArgs: [] as Array<{ getAuth: () => unknown }>,
  capturedTenantSdkToolArgs: [] as Array<{ getOrgId: () => string }>,
  lookupWispGrantMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

// The real module's import graph (aiGuardrails → the tool registry) is far
// beyond this suite's mocks; its behaviour is pinned in wisp/chatCeiling.test.ts.
// Here: the lookup is controllable and the fallback auth is marked.
vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: lookupWispGrantMock,
  unreachableWispAuth: (auth: Record<string, unknown>) => ({ ...auth, accessibleOrgIds: [], __unreachable: true }),
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {
    readonly code = 'wisp_session_unavailable';
    constructor(public readonly reason: string, public readonly sessionId: string) { super('unavailable'); }
  },
}));

vi.mock('../db', () => ({
  db: {
    // Only DB read on this path: the aiBudgets approvalMode lookup.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({
  // Also consumed on the result/done path — see the note in clientLoop.test.ts.
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
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
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn((getAuth: () => unknown) => {
    capturedMcpArgs.push({ getAuth });
    return { type: 'sdk' };
  }),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (s: unknown) => s,
}));
vi.mock('./toolSources/sdkBridge', () => ({
  buildTenantSdkTools: vi.fn((_descriptors: unknown, _getAuth: unknown, getOrgId: () => string) => {
    capturedTenantSdkToolArgs.push({ getOrgId });
    return [];
  }),
  tenantMcpToolNames: vi.fn(() => []),
}));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import { WispSessionUnavailableError } from './wisp/chatCeiling';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const PARTNER_ID = 'cccccccc-1111-4222-8333-444455556666';
const USER_ID = 'eeeeeeee-1111-4222-8333-444455556666';
const GRANT = { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' };

function partnerAuth(): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'all',
    accessibleOrgIds: [ORG_A, ORG_B],
    ...buildOrgAccessClosures([ORG_A, ORG_B]),
    user: { id: USER_ID, email: 'tech@msp.example' },
  } as unknown as AuthContext;
}

const DB_SESSION = { orgId: ORG_A, sdkSessionId: null, maxTurns: 50, turnCount: 0, systemPrompt: null };
const PLATFORM_CONFIG = makeResolvedModel('platform');

describe('getOrCreate — a Wisp session always carries its grant', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMcpArgs.length = 0;
    capturedTenantSdkToolArgs.length = 0;
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  const create = (id: string, factory?: Parameters<StreamingSessionManager['getOrCreate']>[8]) =>
    manager.getOrCreate(id, DB_SESSION, partnerAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, factory);

  it('resolves the grant from the session row itself (no route argument) and pins it on the session', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const session = await create('sess-wisp');
    expect(lookupWispGrantMock).toHaveBeenCalledWith('sess-wisp');
    expect(session.wispGrant).toEqual(GRANT);
  });

  it('a reused in-memory session keeps the grant and is not re-resolved', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const first = await create('sess-reuse');
    const second = await create('sess-reuse');
    expect(second).toBe(first);
    expect(second.wispGrant).toEqual(GRANT);
    expect(lookupWispGrantMock).toHaveBeenCalledTimes(1);
  });

  it('an ordinary session carries wispGrant null and its handlers keep the session tool auth', async () => {
    lookupWispGrantMock.mockResolvedValue(null);
    const session = await create('sess-plain');
    expect(session.wispGrant).toBeNull();
    expect((capturedMcpArgs[0]!.getAuth() as AuthContext).accessibleOrgIds).toEqual([ORG_A, ORG_B]);
  });

  it("a Wisp session's shared handler auth reaches no org (handlers run under the gate's per-call auth)", async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    await create('sess-wisp-auth');
    const fallback = capturedMcpArgs[0]!.getAuth() as AuthContext & { __unreachable?: boolean };
    expect(fallback.__unreachable).toBe(true);
    expect(fallback.accessibleOrgIds).toEqual([]);
  });

  it.each(['thread_unlinked', 'grant_unpinned', 'session_not_found'] as const)(
    'fails closed when the pinned row cannot be resolved (%s): no session, no SDK query',
    async (reason) => {
      lookupWispGrantMock.mockRejectedValue(new WispSessionUnavailableError(reason, 'sess-broken'));
      await expect(create('sess-broken')).rejects.toMatchObject({ code: 'wisp_session_unavailable', reason });
      expect(queryMock).not.toHaveBeenCalled();
      expect(manager.get('sess-broken')).toBeUndefined();
    },
  );

  it('fails closed when the lookup itself errors (DB down)', async () => {
    lookupWispGrantMock.mockRejectedValue(new Error('connection refused'));
    await expect(create('sess-db-down')).rejects.toThrow('connection refused');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('refuses a Wisp session on a custom-factory surface (script builder, helper, client AI, topology)', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const factory = vi.fn(() => ({ server: { type: 'sdk' } as never, name: 'custom' }));
    await expect(create('sess-factory', factory)).rejects.toMatchObject({ reason: 'surface_unsupported' });
    expect(factory).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
