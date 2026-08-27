import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, recordUsageMock, capturedQueryArgs, settleApprovalWaitsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordUsageMock: vi.fn(() => Promise.resolve()),
  capturedQueryArgs: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  settleApprovalWaitsMock: vi.fn(() => false),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    // Only DB read on this path: the aiBudgets approvalMode lookup
    // (streamingSessionManager.getOrCreate). Return auto_approve so the
    // approval-mode prompt injection is observable.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'auto_approve' }])),
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
  recordUsageFromSdkResult: recordUsageMock,
  // Pure helper on the done path — kept real so these tests exercise the actual
  // summing rule. A factory that omits it does NOT yield undefined: vitest
  // throws on the access, the throw escapes the result handler, and both
  // recordExtraUsage and the `done` publish are skipped. That surfaces as a
  // baffling "Number of calls: 0" rather than a missing-export error.
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: settleApprovalWaitsMock,
}));
vi.mock('./aiToolOutput', () => ({ redactAiToolOutputText: (s: string) => s }));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { StreamingSessionManager } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'finance.user@contoso.com' },
} as unknown as AuthContext;

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

const PARTNER_CONFIG = {
  source: 'partner' as const,
  partnerId: '1a1a1a1a-1111-4222-8333-444455556666',
  apiKey: 'partner-key-v1',
  model: 'claude-sonnet-4-6',
  configId: '2b2b2b2b-2222-4222-8222-222222222222',
  configVersion: 1,
  endpoint: { kind: 'anthropic' as const },
};

const RESULT_MSG = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.03,
  usage: { input_tokens: 100, output_tokens: 50 },
  num_turns: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** queryMock returns an async-iterable Query stub gated on `gate`. */
function mockSdkQuery(messages: unknown[], gate: Promise<void>) {
  queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedQueryArgs.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* messages as never[];
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };
  });
}

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueryArgs.length = 0;
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

describe('getOrCreate — approval-mode prompt injection option', () => {
  it('injects the technician approval-mode suffix by default (existing behavior)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate('sess-default', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG);
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('BASE PROMPT');
    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('## Approval Mode');
  });

  it('suppresses the suffix when injectApprovalModeInstructions is false (client sessions)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-client', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toBe('BASE PROMPT');
  });
});

describe('getOrCreate — resolved LLM configuration snapshots', () => {
  it('uses the resolved partner model unless the stored session has an explicit model', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);
    const resolved = { ...PARTNER_CONFIG, model: 'claude-opus-4-6' };

    const inherited = await manager.getOrCreate(
      'sess-model-inherited',
      { ...DB_SESSION, model: null },
      AUTH,
      undefined,
      'BASE PROMPT',
      undefined,
      resolved,
    );
    const explicit = await manager.getOrCreate(
      'sess-model-explicit',
      { ...DB_SESSION, model: 'claude-haiku-4-5' },
      AUTH,
      undefined,
      'BASE PROMPT',
      undefined,
      resolved,
    );

    expect(inherited.model).toBe('claude-opus-4-6');
    expect(capturedQueryArgs[0]!.options.model).toBe('claude-opus-4-6');
    expect(explicit.model).toBe('claude-haiku-4-5');
    expect(capturedQueryArgs[1]!.options.model).toBe('claude-haiku-4-5');

    gate.resolve();
    await Promise.all([inherited.processorPromise, explicit.processorPromise]);
  });

  it('reuses the SDK query when the source and partner config snapshot still match', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const first = await manager.getOrCreate(
      'sess-config-match', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PARTNER_CONFIG,
    );
    const second = await manager.getOrCreate(
      'sess-config-match', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, { ...PARTNER_CONFIG },
    );

    expect(second).toBe(first);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second.llmConfigSnapshot).toEqual({
      source: 'partner',
      configId: PARTNER_CONFIG.configId,
      configVersion: 1,
    });

    gate.resolve();
    await first.processorPromise;
  });

  it('keeps a processing SDK session on config mismatch so the concurrent-message guard applies', async () => {
    const gate = deferred();
    mockSdkQuery([], gate.promise);

    const first = await manager.getOrCreate(
      'sess-config-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PARTNER_CONFIG,
    );
    first.state = 'processing';
    const rotated = { ...PARTNER_CONFIG, apiKey: 'partner-key-v2', configVersion: 2 };

    const second = await manager.getOrCreate(
      'sess-config-processing', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, rotated,
    );

    expect(second).toBe(first);
    expect(manager.tryTransitionToProcessing(second)).toBe(false);
    expect(first.abortController.signal.aborted).toBe(false);
    expect(first.query.close).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(first.llmConfigSnapshot).toEqual({
      source: 'partner',
      configId: PARTNER_CONFIG.configId,
      configVersion: 1,
    });

    gate.resolve();
    await first.processorPromise;
  });

  it('publishes terminal events and recreates an idle SDK session with fresh credentials when configVersion changes', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const gates = [oldGate.promise, newGate.promise];
    queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
      const gate = gates[capturedQueryArgs.length]!;
      capturedQueryArgs.push(args);
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
        },
        interrupt: vi.fn(),
        close: vi.fn(),
      };
    });

    const first = await manager.getOrCreate(
      'sess-config-rotated', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PARTNER_CONFIG,
    );
    first.state = 'idle';
    const rotated = { ...PARTNER_CONFIG, apiKey: 'partner-key-v2', configVersion: 2 };
    const second = await manager.getOrCreate(
      'sess-config-rotated', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, rotated,
    );

    expect(second).not.toBe(first);
    expect(first.abortController.signal.aborted).toBe(true);
    expect(first.query.close).toHaveBeenCalledOnce();
    expect(first.eventBus.getReplayEvents()).toEqual(expect.arrayContaining([
      { type: 'error', message: 'AI provider configuration changed — please resend your message' },
      { type: 'done' },
    ]));
    expect(infoSpy).toHaveBeenCalledWith(
      '[StreamingSessionManager] rotating idle AI session after provider configuration change',
      {
        breezeSessionId: 'sess-config-rotated',
        oldConfigVersion: 1,
        newConfigVersion: 2,
      },
    );
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(capturedQueryArgs[1]!.options.env).toEqual(expect.objectContaining({
      ANTHROPIC_API_KEY: 'partner-key-v2',
    }));
    expect(second.llmConfigSnapshot).toEqual({
      source: 'partner',
      configId: PARTNER_CONFIG.configId,
      configVersion: 2,
    });

    oldGate.resolve();
    await first.processorPromise;
    expect(manager.get('sess-config-rotated')).toBe(second);

    newGate.resolve();
    await second.processorPromise;
    infoSpy.mockRestore();
  });
});

describe('result handling — usage-bearing done + recordExtraUsage', () => {
  it('publishes done with usage and invokes recordExtraUsage with the turn cost', async () => {
    const gate = deferred();
    mockSdkQuery([RESULT_MSG], gate.promise);

    const session = await manager.getOrCreate(
      'sess-usage', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );

    const recordExtraUsage = vi.fn(() => Promise.resolve());
    session.recordExtraUsage = recordExtraUsage;
    session.clientWriteMode = 'readwrite'; // type-level: field exists on ActiveSession

    const events: AiStreamEvent[] = [];
    const sub = session.eventBus.subscribe('test-sub');
    const consumer = (async () => {
      for await (const e of sub) events.push(e);
    })();

    gate.resolve();
    await session.processorPromise;
    await consumer;

    // 0.03 USD → 3 cents (recordUsageFromSdkResult rounding, aiCostTracker.ts:272)
    expect(recordExtraUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50, costCents: 3 });
    expect(recordUsageMock).toHaveBeenCalled(); // org-level recording still happens
    expect(events).toContainEqual({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, costCents: 3 },
    });
  });

  it('records usage against the session org for a partner-scope login (auth.orgId is null) — #3087 regression guard', async () => {
    // Partner tokens never carry an orgId. Before #3087, the result handler
    // used `auth.orgId` for usage recording, which silently skipped it
    // entirely for partner-scope logins. It must use the canonical
    // session.orgId (dbSession.orgId) instead.
    const gate = deferred();
    mockSdkQuery([RESULT_MSG], gate.promise);

    const PARTNER_AUTH = {
      orgId: null,
      scope: 'partner',
      partnerId: '1a1a1a1a-1111-4222-8333-444455556666',
      accessibleOrgIds: [ORG],
      user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'partner.tech@contoso.com' },
    } as unknown as AuthContext;

    const session = await manager.getOrCreate(
      'sess-partner-usage', DB_SESSION, PARTNER_AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );

    gate.resolve();
    await session.processorPromise;

    expect(recordUsageMock).toHaveBeenCalledWith(
      'sess-partner-usage',
      ORG, // session.orgId (dbSession.orgId) — NOT auth.orgId, which is null here
      expect.objectContaining({ total_cost_usd: 0.03 }),
      'platform',
      // 5th arg: catalog pricing snapshot (#3922 W3) — absent off the catalog path.
      undefined,
    );
  });
});

// ============================================
// #3089 — approval-wait budget lifecycle
// ============================================

describe('approval-wait budget lifecycle (#3089)', () => {
  async function createSession(id: string) {
    const gate = deferred();
    mockSdkQuery([], gate.promise);
    const session = await manager.getOrCreate(id, DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined, PLATFORM_CONFIG);
    return { session, gate };
  }

  it('initializes the approval-wait fields on a new session', async () => {
    const { session, gate } = await createSession('sess-wait-init');
    expect(session.approvalWaitDeadline).toBeNull();
    expect(session.approvalWaitAbort).toBeNull();
    expect(session.pendingApprovalWaits).toBe(0);
    gate.resolve();
    await session.processorPromise;
  });

  it('startTurnTimeout resets the shared budget when no wait is in flight', async () => {
    const { session, gate } = await createSession('sess-wait-reset');
    session.approvalWaitDeadline = Date.now() + 100_000;
    session.approvalWaitAbort = new AbortController();
    session.pendingApprovalWaits = 0;

    manager.startTurnTimeout(session);

    expect(session.approvalWaitDeadline).toBeNull();
    expect(session.approvalWaitAbort).toBeNull();
    gate.resolve();
    await session.processorPromise;
  });

  it('startTurnTimeout preserves a live budget while a wait is still in flight', async () => {
    const { session, gate } = await createSession('sess-wait-preserve');
    const deadline = Date.now() + 100_000;
    const abort = new AbortController();
    session.approvalWaitDeadline = deadline;
    session.approvalWaitAbort = abort;
    session.pendingApprovalWaits = 1;

    manager.startTurnTimeout(session);

    expect(session.approvalWaitDeadline).toBe(deadline);
    expect(session.approvalWaitAbort).toBe(abort);
    gate.resolve();
    await session.processorPromise;
  });

  it('startTurnTimeout resets an EXHAUSTED budget even with a wait mid-settle, so later cycles are not poisoned to zero', async () => {
    const { session, gate } = await createSession('sess-wait-exhausted');
    session.approvalWaitDeadline = Date.now() - 1_000;
    session.approvalWaitAbort = new AbortController();
    session.pendingApprovalWaits = 1;

    manager.startTurnTimeout(session);

    expect(session.approvalWaitDeadline).toBeNull();
    expect(session.approvalWaitAbort).toBeNull();
    gate.resolve();
    await session.processorPromise;
  });

  it('interrupt() settles in-flight approval waits before interrupting the SDK query', async () => {
    const { session, gate } = await createSession('sess-wait-interrupt');
    session.state = 'processing';

    const result = await manager.interrupt('sess-wait-interrupt');

    expect(result.interrupted).toBe(true);
    expect(settleApprovalWaitsMock).toHaveBeenCalledWith(session);
    expect(session.query.interrupt).toHaveBeenCalled();
    gate.resolve();
    await session.processorPromise;
  });
});
