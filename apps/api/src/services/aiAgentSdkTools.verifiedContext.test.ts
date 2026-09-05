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
vi.mock('./aiToolOutput', () => ({
  compactToolResultForChat: vi.fn((_tool: string, raw: string) => raw),
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

import { __test__ } from './aiAgentSdkTools';
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
