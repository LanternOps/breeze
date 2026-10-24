import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3409 PR4c-1 — the inline chat release path's carry channel.
 *
 * The durable worker verifies the pinned effect digest and calls `executeTool`
 * a few lines later, so carrying the verified material between the two is
 * local. The inline path is split: `aiAgentSdk.ts`'s `createSessionPreToolUse`
 * verifies, and the tool actually runs later from THIS module's `makeHandler`.
 * The one thing that already crosses that seam is the preToolUse callback's
 * return value (`intentId` rides it), so the verified material rides it too.
 *
 * These tests pin that forwarding, and — just as importantly — pin that a
 * caller who verified nothing still reaches `executeTool` with exactly three
 * arguments, which is the compatibility contract for direct chat, MCP and the
 * script builder.
 */

const mockExecuteTool = vi.fn(async () => JSON.stringify({ ok: true }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));

// Identity compaction so the assertions read against the raw handler output.
// setToolPaginationHintResolver is a no-op here: aiTools.ts calls it at
// import time (A-W05 D12) and this mock replaces the whole module, so the
// real export must be stubbed too or the top-level call throws.
vi.mock('./aiToolOutput', () => ({
  compactToolResultForChat: vi.fn((_tool: string, raw: string) => raw),
  setToolPaginationHintResolver: vi.fn(),
}));

vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
  registerM365Tools: vi.fn(),
}));

// Only `executeTool` is replaced: the registry (`aiTools`) and every other
// export stay real, so this file cannot pass against a module that no longer
// exports what aiAgentSdkTools imports.
vi.mock('./aiTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeTool: (...args: unknown[]) => mockExecuteTool(...(args as [])),
}));

import { __test__, WISP_UNGATED_CALL_MESSAGE, wrapExtraToolWithHooks } from './aiAgentSdkTools';
import { buildScriptBuilderTools } from './scriptBuilderTools';
import type { PreToolUseCallback } from './aiAgentSdkTools';
import type { ToolExecutionContext } from './toolExecutionContext';

const { makeHandler } = __test__;

const fakeAuth = {
  scope: 'organization',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  partnerId: 'partner-1',
  user: { id: 'user-1' },
} as any;

/** The carrier a release path builds; only its identity matters here. */
const verifiedContext = {
  verifiedRunScript: {
    snapshot: { script: { id: 'script-1' } },
    scriptRow: { id: 'script-1' },
    scope: { orgIds: new Set(['org-1']) },
  },
} as unknown as ToolExecutionContext;

describe.each([
  { name: 'Fleet AI', makeHandler },
  {
    name: 'Script Builder',
    makeHandler: (toolName: string, getAuth: () => typeof fakeAuth, onPreToolUse?: PreToolUseCallback) => {
      const exposedName = toolName === 'run_script' ? 'execute_script_on_device' : toolName;
      const registered = buildScriptBuilderTools(getAuth, onPreToolUse).find(t => t.name === exposedName);
      if (!registered) throw new Error(`Missing tool: ${exposedName}`);
      return (args: Record<string, unknown>) => registered.handler(args as never, undefined);
    },
  },
])('$name forwards pre-verified release material to executeTool', ({ makeHandler }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  it('passes the context returned by onPreToolUse through to executeTool', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const, context: verifiedContext }));
    const handler = makeHandler('run_script', () => fakeAuth, onPreToolUse);

    await handler({ scriptId: 'script-1', deviceIds: ['device-1'] });

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const call = mockExecuteTool.mock.calls[0]! as unknown as unknown[];
    expect(call[0]).toBe('run_script');
    expect(call[2]).toBe(fakeAuth);
    // Identity: the very object the verification produced, not a copy.
    expect((call[3] as { context?: unknown }).context).toBe(verifiedContext);
  });

  // P2-5 (#4192): the SAME seam now also carries the id of the intent whose
  // inline release this invocation IS. `createSessionPreToolUse` sets
  // `intentId` only after it wins the approved -> executing CAS, so its
  // presence is the fact a handler that may run ONLY as an approved release
  // (manage_ai_agents:authorize_supervised_key) keys off.
  it('forwards the released intent id alongside the verified material', async () => {
    const onPreToolUse = vi.fn(async () => ({
      allowed: true as const,
      intentId: 'intent-1',
      context: verifiedContext,
    }));
    const handler = makeHandler('run_script', () => fakeAuth, onPreToolUse);

    await handler({ scriptId: 'script-1', deviceIds: ['device-1'] });

    const context = (mockExecuteTool.mock.calls[0]! as unknown as unknown[])[3] as
      { context: ToolExecutionContext };
    expect(context.context.actionIntentId).toBe('intent-1');
    expect(context.context.verifiedRunScript).toBe(verifiedContext.verifiedRunScript);
  });

  it('forwards the released intent id even when nothing was verified', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const, intentId: 'intent-2' }));
    const handler = makeHandler('run_script', () => fakeAuth, onPreToolUse);

    await handler({ scriptId: 'script-1', deviceIds: ['device-1'] });

    const call = mockExecuteTool.mock.calls[0]! as unknown as unknown[];
    expect(call).toHaveLength(4);
    expect((call[3] as { context: ToolExecutionContext }).context)
      .toEqual({ actionIntentId: 'intent-2' });
  });

  it('calls executeTool with exactly three arguments when nothing was verified and no intent was released', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const }));
    const handler = makeHandler('list_scripts', () => fakeAuth, onPreToolUse);

    await handler({});

    // Not `toHaveBeenCalledWith(a, b, c)` alone — a trailing `undefined`
    // options bag would still be a behavioural change for every non-release
    // caller, and only an arity assertion catches it.
    expect(mockExecuteTool.mock.calls[0]).toHaveLength(3);
  });

  it('calls executeTool with exactly three arguments when there is no preToolUse callback at all', async () => {
    const handler = makeHandler('list_scripts', () => fakeAuth);

    await handler({});

    expect(mockExecuteTool.mock.calls[0]).toHaveLength(3);
  });

  it('never reaches executeTool when onPreToolUse denies, context or not', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: false as const, error: 'approval_required' }));
    const handler = makeHandler('run_script', () => fakeAuth, onPreToolUse);

    await handler({ scriptId: 'script-1', deviceIds: ['device-1'] });

    expect(mockExecuteTool).not.toHaveBeenCalled();
  });
});

// #7931: the result is paired with its tool_use by the id the SDK sends with
// the MCP call (`extra._meta['claudecode/toolUseId']`), so every handler
// factory must hand that id to onPostToolUse — never leave pairing to queue
// position.
describe('the SDK tool_use id reaches onPostToolUse (#7931)', () => {
  const extra = { _meta: { 'claudecode/toolUseId': 'toolu_own_call' } };
  type Post = NonNullable<Parameters<typeof makeHandler>[3]>;
  const sdkTool = (name: string, post: Post) => {
    const registered = buildScriptBuilderTools(() => fakeAuth, undefined, post).find(t => t.name === name);
    if (!registered) throw new Error(`Missing tool: ${name}`);
    return registered;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  it.each([
    {
      name: 'Fleet AI handler',
      call: (post: Post) => makeHandler('list_scripts', () => fakeAuth, undefined, post)({}, extra),
    },
    {
      name: 'Script Builder existing-tool handler',
      call: (post: Post) => sdkTool('list_scripts', post).handler({} as never, extra as never),
    },
    {
      name: 'Script Builder apply handler',
      call: (post: Post) =>
        sdkTool('apply_script_code', post).handler({ code: 'Get-Date', language: 'powershell' } as never, extra as never),
    },
  ])('$name', async ({ call }) => {
    const post = vi.fn(async () => undefined);
    await call(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as unknown[])[7]).toBe('toolu_own_call');
  });

  it('passes undefined when the SDK sent no id', async () => {
    const post = vi.fn(async () => undefined);
    await makeHandler('list_scripts', () => fakeAuth, undefined, post)({}, {});
    expect((post.mock.calls[0] as unknown[])[7]).toBeUndefined();
  });
});

// #8163: an agent run keeps per-call state (ledger row, act pin) between its
// pre and post hooks, keyed by the SDK tool_use id. So every handler factory
// must hand onPreToolUse the SAME id it binds into that call's onPostToolUse.
describe('the SDK tool_use id reaches onPreToolUse, matching onPostToolUse (#8163)', () => {
  const extra = { _meta: { 'claudecode/toolUseId': 'toolu_own_call' } };
  type Post = NonNullable<Parameters<typeof makeHandler>[3]>;
  const extraTool = {
    name: 'submit_test_outcome',
    description: 'test',
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }),
  } as unknown as Parameters<typeof wrapExtraToolWithHooks>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  it.each([
    {
      name: 'Fleet AI handler',
      call: (pre: PreToolUseCallback, post: Post, ex: unknown) =>
        makeHandler('list_scripts', () => fakeAuth, pre, post)({}, ex),
    },
    {
      name: 'Script Builder existing-tool handler',
      call: (pre: PreToolUseCallback, post: Post, ex: unknown) => {
        const registered = buildScriptBuilderTools(() => fakeAuth, pre, post).find(t => t.name === 'list_scripts');
        if (!registered) throw new Error('Missing tool: list_scripts');
        return registered.handler({} as never, ex as never);
      },
    },
    {
      name: 'extra (outcome) tool wrapper',
      call: (pre: PreToolUseCallback, post: Post, ex: unknown) =>
        wrapExtraToolWithHooks(extraTool, pre, post).handler({}, ex),
    },
  ])('$name', async ({ call }) => {
    const pre = vi.fn<PreToolUseCallback>(async () => ({ allowed: true }));
    const post = vi.fn(async () => undefined);
    await call(pre, post, extra);
    expect(pre).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(pre.mock.calls[0]![3]).toBe('toolu_own_call');
    expect((post.mock.calls[0] as unknown[])[7]).toBe('toolu_own_call');

    // No id from the SDK: both hooks see undefined (the agent run then falls
    // back to per-name pairing and reports it).
    pre.mockClear();
    post.mockClear();
    await call(pre, post, {});
    expect(pre.mock.calls[0]![3]).toBeUndefined();
    expect((post.mock.calls[0] as unknown[])[7]).toBeUndefined();
  });
});

describe('plain tool handler: typed caller-verification refusal (#6354 W05)', () => {
  it('emits the refusal JSON intact (isError, no sanitised message) and posts the same text', async () => {
    const { CallerVerificationRequiredError } = await import('./callerVerification/errors');
    const payload = {
      orgId: 'org-1', contactId: null, action: 'disable_user' as const,
      requiredTier: 2, reason: 'no_fresh_verification' as const, latest: null,
    };
    mockExecuteTool.mockRejectedValueOnce(new CallerVerificationRequiredError(payload));
    const post = vi.fn(async () => undefined);
    const handler = makeHandler('query_devices', () => fakeAuth, undefined, post);

    const res = (await handler({}, undefined)) as { content: Array<{ text: string }>; isError?: boolean };

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      error: 'Caller verification required',
      requiresCallerVerification: payload,
    });
    expect((post.mock.calls[0] as unknown[])[2]).toBe(res.content[0]!.text);
    expect((post.mock.calls[0] as unknown[])[3]).toBe(true);
  });
});

// Wisp W04 Task 4: the gate returns the per-call ceiling-narrowed auth on the
// check result, and the handler runs the tool under IT, not the session's
// shared getAuth(). W04 T6b reach: a Wisp session's capture scope names its
// thread; an ordinary session's capture scope gains no key.
describe('Wisp per-call auth and thread capture scope (W04 Task 4)', () => {
  const { makeToolHandler, makeSessionAwareHandler } = __test__;
  const narrowedAuth = { ...fakeAuth, accessibleOrgIds: ['org-1'], wispGrant: { grantId: 'g-1', grantRevisionId: 'r-1', sessionId: 's-1' } };
  const session = (wispGrant: unknown) => ({ orgId: 'org-1', breezeSessionId: 's-1', wispGrant }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  it('executes under check.toolAuth when the gate returns one, and names the thread in the capture scope', async () => {
    const getAuth = vi.fn(() => fakeAuth);
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const, toolAuth: narrowedAuth as never }));
    const handler = makeToolHandler('list_scripts', getAuth, () => session({ grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' }), onPreToolUse);

    await handler({});

    const call = mockExecuteTool.mock.calls[0]! as unknown as unknown[];
    expect(call[2]).toBe(narrowedAuth);
    expect(getAuth).not.toHaveBeenCalled();
    expect((call[3] as { capture: unknown }).capture).toEqual({ orgId: 'org-1', sessionId: 's-1', wispThreadId: 't-1' });
  });

  it('an ordinary session keeps getAuth() and its capture scope gains no wispThreadId key', async () => {
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const }));
    const handler = makeToolHandler('list_scripts', () => fakeAuth, () => session(null), onPreToolUse);

    await handler({});

    const call = mockExecuteTool.mock.calls[0]! as unknown as unknown[];
    expect(call[2]).toBe(fakeAuth);
    expect(Object.keys((call[3] as { capture: object }).capture)).toEqual(['orgId', 'sessionId']);
  });

  it('a Wisp session whose gate allowed a call WITHOUT toolAuth is denied, never run under getAuth() (makeToolHandler)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getAuth = vi.fn(() => fakeAuth);
    const post = vi.fn(async () => undefined);
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const }));
    const handler = makeToolHandler('list_scripts', getAuth, () => session({ grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' }), onPreToolUse, post);

    const res = (await handler({})) as { content: Array<{ text: string }>; isError?: boolean };

    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ error: WISP_UNGATED_CALL_MESSAGE });
    expect((post.mock.calls[0] as unknown[])[3]).toBe(true);
    errSpy.mockRestore();
  });

  it('a Wisp session whose gate allowed a call WITHOUT toolAuth is denied (makeSessionAwareHandler)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getAuth = vi.fn(() => fakeAuth);
    const sessionHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const }));
    const handler = makeSessionAwareHandler('m365_lookup_user', getAuth, () => session({ threadId: 't-1' }), sessionHandler, onPreToolUse);

    const res = (await handler({ userPrincipalName: 'a@b.test' })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(sessionHandler).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ error: WISP_UNGATED_CALL_MESSAGE });
    errSpy.mockRestore();
  });

  it('the session-aware (M365/Google) handler also runs under check.toolAuth', async () => {
    const sessionHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const onPreToolUse = vi.fn(async () => ({ allowed: true as const, toolAuth: narrowedAuth as never }));
    const handler = makeSessionAwareHandler('m365_lookup_user', () => fakeAuth, () => session({ threadId: 't-1' }), sessionHandler, onPreToolUse);

    await handler({ userPrincipalName: 'a@b.test' });

    expect((sessionHandler.mock.calls[0] as unknown[])[1]).toBe(narrowedAuth);
  });
});
