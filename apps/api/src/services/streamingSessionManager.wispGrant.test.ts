/**
 * Wisp W04 Task 4 — the STRUCTURAL guarantee: every ActiveSession built for a
 * grant-pinned ai_sessions row carries its grant, because getOrCreate resolves
 * it from the row itself (lookupWispGrant), never from a route argument — and
 * a pinned row it cannot resolve never becomes a session that runs tools
 * ungated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, capturedMcpArgs, capturedTenantSdkToolArgs, lookupWispGrantMock, wispSessionToolFilterMock, maybeNotifyChatCrossedBudgetMock, wispEnabledMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  wispEnabledMock: vi.fn(() => false),
  maybeNotifyChatCrossedBudgetMock: vi.fn(),
  capturedMcpArgs: [] as Array<{ getAuth: () => unknown; options?: { admitTool?: (name: string) => boolean } }>,
  capturedTenantSdkToolArgs: [] as Array<{ getOrgId: () => string }>,
  lookupWispGrantMock: vi.fn(),
  wispSessionToolFilterMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../config/env', async (orig) => ({
  ...(await orig<typeof import('../config/env')>()),
  wispEnabled: wispEnabledMock,
}));

// The real module's import graph (aiGuardrails → the tool registry) is far
// beyond this suite's mocks; its behaviour is pinned in wisp/chatCeiling.test.ts.
// Here: the lookup is controllable and the fallback auth is marked.
vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: lookupWispGrantMock,
  wispSessionToolFilter: wispSessionToolFilterMock,
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
  createBreezeMcpServer: vi.fn((getAuth: () => unknown, _pre: unknown, _post: unknown, _session: unknown, _extra: unknown, options?: { admitTool?: (name: string) => boolean }) => {
    capturedMcpArgs.push({ getAuth, options });
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

// Tenant (BYO MCP) tool resolution runs for every default-server session; flow
// tool resolution only for one WITHOUT a Wisp grant (sessionMayStartFlows
// excludes Wisp). Left unmocked, the ordinary-session test lazily imports the
// real ./flows/flowTools graph, whose cold transform alone takes ~5 s: the
// test timed out when this file ran by itself and passed only when another
// file had warmed the transform cache.
// Their behaviour is pinned in streamingSessionManager.{tenantTools,flowTools}.test.ts.
vi.mock('./toolSources/resolver', () => ({ resolveTenantTools: vi.fn(async () => []) }));
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: vi.fn(async () => []) }));
// #10414: the turn-end grant spend notice (behaviour pinned in wisp/chatSpendCheck.test.ts).
vi.mock('./wisp/chatSpendCheck', () => ({ maybeNotifyChatCrossedBudget: maybeNotifyChatCrossedBudgetMock }));
// #10428: the real turn-end hooks, with the before-done half spied so a test can
// hand back a capture id without Redis.
vi.mock('./wisp/turnEnd', async (importOriginal) => {
  const real = await importOriginal<typeof import('./wisp/turnEnd')>();
  return {
    ...real,
    runWispTurnEndBeforeDone: vi.fn(real.runWispTurnEndBeforeDone),
    scheduleWispTurnEndAfterDone: vi.fn(real.scheduleWispTurnEndAfterDone),
  };
});

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import { WispSessionUnavailableError } from './wisp/chatCeiling';
import { captureException } from './sentry';
import { insertedAssistantMessages, scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';
import { db } from '../db';
import { FOLLOW_UP_CORRECTION } from './wisp/promiseLinter';
import { runWispTurnEndBeforeDone, scheduleWispTurnEndAfterDone } from './wisp/turnEnd';

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
    wispSessionToolFilterMock.mockReset();
    wispSessionToolFilterMock.mockResolvedValue((name: string) => name !== 'list_operator_tasks');
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
    expect(wispSessionToolFilterMock).toHaveBeenCalledTimes(1);
  });

  it("registers a Wisp session's tools through its grant's tool filter (#10430)", async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    await create('sess-wisp-index');
    expect(wispSessionToolFilterMock).toHaveBeenCalledWith(GRANT);
    const admitTool = capturedMcpArgs[0]!.options?.admitTool;
    expect(admitTool?.('list_operator_tasks')).toBe(false);
    expect(admitTool?.('query_devices')).toBe(true);
  });

  it('fails closed when the tool filter cannot be read (DB down): no session, no SDK query', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    wispSessionToolFilterMock.mockRejectedValue(new Error('connection refused'));
    await expect(create('sess-filter-down')).rejects.toThrow('connection refused');
    expect(queryMock).not.toHaveBeenCalled();
    expect(manager.get('sess-filter-down')).toBeUndefined();
  });

  it('an ordinary session carries wispGrant null and its handlers keep the session tool auth', async () => {
    lookupWispGrantMock.mockResolvedValue(null);
    const session = await create('sess-plain');
    expect(session.wispGrant).toBeNull();
    expect((capturedMcpArgs[0]!.getAuth() as AuthContext).accessibleOrgIds).toEqual([ORG_A, ORG_B]);
    expect(wispSessionToolFilterMock).not.toHaveBeenCalled();
    expect(capturedMcpArgs[0]!.options).toBeUndefined();
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

describe('turn end — the Wisp grant spend notice (#10414)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    wispSessionToolFilterMock.mockReset();
    wispSessionToolFilterMock.mockResolvedValue(() => true);
    maybeNotifyChatCrossedBudgetMock.mockReset();
    maybeNotifyChatCrossedBudgetMock.mockResolvedValue('under');
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  /** One completed turn; returns the session once its processor has finished. */
  async function runTurn(id: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    queryMock.mockImplementation(() => scriptedQuery([sdkResult()], gate));
    const session = await manager.getOrCreate(id, DB_SESSION, partnerAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
    release();
    await session.processorPromise;
    return session;
  }

  const doneEvents = (session: Awaited<ReturnType<typeof runTurn>>) =>
    session.eventBus.getReplayEvents().filter((e: { type: string }) => e.type === 'done');

  it("a settled Wisp turn fires the notice for the session's grant", async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const session = await runTurn('sess-wisp-turn');
    await vi.waitFor(() => expect(maybeNotifyChatCrossedBudgetMock).toHaveBeenCalledWith('g-1'));
    expect(maybeNotifyChatCrossedBudgetMock).toHaveBeenCalledTimes(1);
    expect(doneEvents(session)).toHaveLength(1);
  });

  it('an ordinary turn never reads grant spend', async () => {
    lookupWispGrantMock.mockResolvedValue(null);
    const session = await runTurn('sess-plain-turn');
    expect(doneEvents(session)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(maybeNotifyChatCrossedBudgetMock).not.toHaveBeenCalled();
  });

  it('a failing notice is reported and never holds back `done`', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    let rejectNotice!: (err: Error) => void;
    maybeNotifyChatCrossedBudgetMock.mockReturnValue(new Promise((_, reject) => (rejectNotice = reject)));
    const session = await runTurn('sess-wisp-failing-notice');
    // `done` went out while the notice was still pending.
    expect(doneEvents(session)).toHaveLength(1);
    await vi.waitFor(() => expect(maybeNotifyChatCrossedBudgetMock).toHaveBeenCalled());
    rejectNotice(new Error('db down'));
    await vi.waitFor(() => expect(captureException).toHaveBeenCalled());
  });
});

describe('turn end — Wisp standing-instruction capture (#10428)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    wispSessionToolFilterMock.mockReset();
    wispSessionToolFilterMock.mockResolvedValue(() => true);
    maybeNotifyChatCrossedBudgetMock.mockReset();
    maybeNotifyChatCrossedBudgetMock.mockResolvedValue('under');
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  async function runTurn(id: string, userMessage?: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    queryMock.mockImplementation(() => scriptedQuery([sdkResult()], gate));
    const session = await manager.getOrCreate(id, DB_SESSION, partnerAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
    expect(manager.tryTransitionToProcessing(session, undefined, userMessage === undefined ? {} : { userMessage })).toBe(true);
    const recorded = session.currentTurn;
    release();
    await session.processorPromise;
    return { session, recorded };
  }

  it('a Wisp turn records the technician\'s text; `done` carries the capture id the hook returned', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    vi.mocked(runWispTurnEndBeforeDone).mockResolvedValueOnce({ wispInstructionCapture: { captureId: 'cap-1' } });
    const { session, recorded } = await runTurn('sess-wisp-capture', "don't reboot PC-01");
    expect(recorded?.userMessage).toBe("don't reboot PC-01");
    const done = session.eventBus.getReplayEvents().filter((e: { type: string }) => e.type === 'done');
    expect(done).toEqual([expect.objectContaining({ type: 'done', wispInstructionCapture: { captureId: 'cap-1' } })]);
    expect(scheduleWispTurnEndAfterDone).toHaveBeenCalledWith(session, { wispInstructionCapture: { captureId: 'cap-1' } });
  });

  it('`done` has no capture field when the hook returns nothing', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const { session } = await runTurn('sess-wisp-no-capture', 'What changed on PC-01?');
    const done = session.eventBus.getReplayEvents().filter((e: { type: string }) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).not.toHaveProperty('wispInstructionCapture');
  });

  it('an ordinary session records no turn and never runs the Wisp hooks', async () => {
    lookupWispGrantMock.mockResolvedValue(null);
    const { recorded } = await runTurn('sess-plain-capture', "don't reboot PC-01");
    expect(recorded).toBeUndefined();
    expect(runWispTurnEndBeforeDone).not.toHaveBeenCalled();
    expect(scheduleWispTurnEndAfterDone).not.toHaveBeenCalled();
  });

  it('a failing before-done hook never costs the turn its `done`', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    vi.mocked(runWispTurnEndBeforeDone).mockRejectedValueOnce(new Error('module broke'));
    const { session } = await runTurn('sess-wisp-hook-throws', "don't reboot PC-01");
    expect(session.eventBus.getReplayEvents().filter((e: { type: string }) => e.type === 'done')).toHaveLength(1);
  });
});

describe('turn end — the promise correction (#10427)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    wispEnabledMock.mockReturnValue(true);
    wispSessionToolFilterMock.mockReset();
    wispSessionToolFilterMock.mockResolvedValue(() => true);
    maybeNotifyChatCrossedBudgetMock.mockReset();
    maybeNotifyChatCrossedBudgetMock.mockResolvedValue('under');
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    wispEnabledMock.mockReturnValue(false);
    manager.shutdown();
  });

  /** One assistant message per string: its own message_start, a text block and one delta. */
  const streamText = (text: string) => [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  ];

  async function runTurn(id: string, reply: string[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    queryMock.mockImplementation(() => scriptedQuery([...reply.flatMap(streamText), sdkResult()], gate));
    const session = await manager.getOrCreate(id, DB_SESSION, partnerAuth(), undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
    expect(manager.tryTransitionToProcessing(session, undefined, { userMessage: 'What changed on PC-01?' })).toBe(true);
    const recorded = session.currentTurn;
    release();
    await session.processorPromise;
    return { session, recorded };
  }

  const streamed = (session: Awaited<ReturnType<typeof runTurn>>['session']) =>
    session.eventBus.getReplayEvents().map((e: { type: string; delta?: string }) => (e.type === 'content_delta' ? `delta:${e.delta}` : e.type));

  it('a Wisp reply that promises a check-back with none scheduled gets one persisted correction, before `done`', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const { session, recorded } = await runTurn('sess-wisp-promise', ['Nothing stands out yet.', "I'll check back in 5 minutes."]);
    // Each assistant message starts on its own line, so sentences never run together.
    expect(recorded?.assistantText).toBe("Nothing stands out yet.\nI'll check back in 5 minutes.");
    const events = streamed(session);
    const at = events.indexOf(`delta:${FOLLOW_UP_CORRECTION}`);
    expect(at).toBeGreaterThan(-1);
    expect(events.filter((e: string) => e === `delta:${FOLLOW_UP_CORRECTION}`)).toHaveLength(1);
    expect(events.slice(at - 1, at + 2)).toEqual(['message_start', `delta:${FOLLOW_UP_CORRECTION}`, 'message_end']);
    expect(events.indexOf('done')).toBeGreaterThan(at);
    expect(insertedAssistantMessages(vi.mocked(db.insert))).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: FOLLOW_UP_CORRECTION }),
    );
  });

  it('a Wisp reply with no promise gets no correction', async () => {
    lookupWispGrantMock.mockResolvedValue(GRANT);
    const { session, recorded } = await runTurn('sess-wisp-no-promise', ['PC-01 is online and its disk is at 91%.']);
    // The reply was buffered and linted; it simply promised nothing.
    expect(recorded?.assistantText).toBe('PC-01 is online and its disk is at 91%.');
    expect(streamed(session).some((e: string) => e.startsWith('delta:Correction'))).toBe(false);
  });

  it('an ordinary session buffers no text and publishes no correction', async () => {
    lookupWispGrantMock.mockResolvedValue(null);
    const { session, recorded } = await runTurn('sess-plain-promise', ["I'll check back in 5 minutes."]);
    expect(recorded).toBeUndefined();
    expect(streamed(session).some((e: string) => e.startsWith('delta:Correction'))).toBe(false);
  });
});
