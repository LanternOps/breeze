/**
 * Execution-plane W01 (spec §5.2, §12). The hook sits inside executeTool, after
 * the handler and BEFORE any compaction. It is inert unless the call is
 * attributable — an ai_agent principal (run path) or an ExecuteToolOptions
 * `capture` scope (chat path). `captureExempt` opts a structured tool out by
 * taking the same null-context path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(async (raw: string, _ctx: unknown) => raw),
}));

vi.mock('./artifacts/toolResultCapture', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureLargeToolResult: mocks.capture,
}));

// The fixture tools below are registered at runtime and therefore have no entry
// in `toolInputSchemas`, which `validateToolInput` would reject before the
// handler ever runs ("No input schema registered"). Accept the `cap_*` fixture
// names and defer to the real validator for everything else, so the properties
// under test are the capture hook's — not the schema registry's.
vi.mock('./aiToolSchemas', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const real = actual.validateToolInput as (
    name: string,
    input: Record<string, unknown>,
  ) => { success: boolean; error?: string };
  return {
    ...actual,
    validateToolInput: (name: string, input: Record<string, unknown>) =>
      name.startsWith('cap_') ? { success: true, data: input } : real(name, input),
  };
});

import { aiTools, executeTool, type AiTool } from './aiTools';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const SESSION = '00000000-0000-4000-8000-0000000000a5';

const auth = {
  principal: { kind: 'user_session' },
  user: { id: 'u1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
  token: null,
  partnerId: null,
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as never;

/** What services/aiAgents/agentAuthContext.ts builds for an agent run. */
const runAuth = {
  ...(auth as object),
  principal: { kind: 'ai_agent', agentId: 'ag1', runId: RUN },
} as never;

const BIG = JSON.stringify({ rows: 'r'.repeat(30_000) });

function register(name: string, result: string, extra: Partial<AiTool> = {}): () => void {
  const tool = {
    definition: { name, description: 'test', input_schema: { type: 'object', properties: {} } },
    tier: 1 as const,
    handler: async () => result,
    ...extra,
  } as AiTool;
  aiTools.set(name, tool);
  return () => aiTools.delete(name);
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  mocks.capture.mockClear();
  mocks.capture.mockImplementation(async (raw: string) => raw);
});
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

describe('executeTool capture hook', () => {
  it('is INERT for an ordinary chat call with no scope — result is byte-identical', async () => {
    cleanup.push(register('cap_plain', BIG));
    expect(await executeTool('cap_plain', {}, auth)).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('routes the RAW handler result through capture for an agent RUN, with no caller input', async () => {
    cleanup.push(register('cap_run', BIG));
    mocks.capture.mockResolvedValueOnce('{"artifact":{"handle":"h"},"compacted":"x"}');
    const out = await executeTool('cap_run', {}, runAuth);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture.mock.calls[0]![0]).toBe(BIG); // RAW, uncompacted
    expect(mocks.capture.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      runId: RUN,
      sessionId: null,
    });
    expect(out).toBe('{"artifact":{"handle":"h"},"compacted":"x"}');
  });

  it('routes a CHAT call through when a capture scope is supplied', async () => {
    cleanup.push(register('cap_chat', BIG));
    await executeTool('cap_chat', {}, auth, { capture: { orgId: ORG, sessionId: SESSION } });
    expect(mocks.capture.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      runId: null,
      sessionId: SESSION,
    });
  });

  it('honours captureExempt — a structured tool takes the null-context path and stays inline', async () => {
    cleanup.push(register('cap_exempt', BIG, { captureExempt: true }));
    const out = await executeTool('cap_exempt', {}, auth, {
      capture: { orgId: ORG, sessionId: SESSION },
    });
    expect(out).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('does not capture the tool-error envelopes executeTool returns before the handler', async () => {
    // The Helper device-scope gate is the earliest of executeTool's error
    // returns and needs no database, unlike the deviceArgs gate (which issues a
    // real `devices` lookup). Either way the property is the same: an envelope
    // returned BEFORE the handler never reaches the capture hook.
    cleanup.push(register('cap_gated', BIG));
    const helperAuth = { ...(auth as object), helperDeviceId: 'dev-1' } as never;
    const out = await executeTool('cap_gated', {}, helperAuth, {
      capture: { orgId: ORG, sessionId: SESSION },
    });
    expect(JSON.parse(out)).toHaveProperty('error');
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('tolerates an auth context with no principal — capture must never be what throws', async () => {
    // Regression: `AuthContext.principal` is typed non-optional but is absent on
    // plenty of hand-built contexts. Reading it unguarded turned every such tool
    // call into a TypeError from inside the capture hook.
    cleanup.push(register('cap_no_principal', BIG));
    const noPrincipal = { ...(auth as Record<string, unknown>), principal: undefined } as never;
    expect(await executeTool('cap_no_principal', {}, noPrincipal)).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('never lets a capture fault fail the tool call — the raw result still returns', async () => {
    cleanup.push(register('cap_boom', BIG));
    mocks.capture.mockRejectedValueOnce(new Error('unexpected'));
    expect(
      await executeTool('cap_boom', {}, auth, { capture: { orgId: ORG, sessionId: SESSION } }),
    ).toBe(BIG);
  });
});

describe('the three non-chat call sites are passthrough by design in W01 (reconciliation R2)', () => {
  // Each case builds the EXACT options bag its call site builds today: none of
  // them supplies `capture`. If a later wave starts attributing one of these,
  // this suite goes red and the change becomes a decision rather than an accident.
  it('routes/mcpServer.ts passes no options at all', async () => {
    cleanup.push(register('cap_mcp', BIG));
    expect(await executeTool('cap_mcp', {}, auth)).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('services/scriptBuilderTools.ts passes only verified release material', async () => {
    cleanup.push(register('cap_sb', BIG));
    const context = { verifiedRunScript: undefined } as never;
    expect(await executeTool('cap_sb', {}, auth, { context })).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('jobs/intentReleaseWorker.ts passes an actionIntentId and no capture scope', async () => {
    cleanup.push(register('cap_intent', BIG));
    expect(await executeTool('cap_intent', {}, auth, { context: { actionIntentId: 'i1' } })).toBe(
      BIG,
    );
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });
});
