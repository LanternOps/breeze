/**
 * #11004: the Breeze tool surface (~340 Zod-declared tools) is static per
 * process, but it used to be rebuilt on every chat session — and a second time
 * inside `buildSystemPrompt` via `listChatSurfaceToolNames`. The declarations
 * are now built once into a template whose handlers are late-bound, and each
 * session binds its own handlers onto the shared static definitions.
 *
 * What this suite pins:
 *  - the static parts (name, description, inputSchema, registry _meta) are the
 *    SAME objects across sessions, and are not re-declared per session;
 *  - the per-session parts (handlers) are distinct per binding and dispatch to
 *    THAT binding's callbacks only — never another session's;
 *  - env exposure gates still apply per call (the template is keyed on them).
 *
 * `createSdkMcpServer` is mocked to hand back its options (same technique as
 * aiAgentSdkTools.serverMeta.test.ts) and `tool` is wrapped in a counting spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    tool: vi.fn(actual.tool),
    createSdkMcpServer: vi.fn((options: unknown) => options),
  };
});

import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import {
  __test__ as sdkToolsTest,
  buildBreezeSdkTools,
  createBreezeMcpServer,
  listChatSurfaceToolNames,
  warmBreezeToolSurface,
  type PostToolUseCallback,
  type PreToolUseCallback,
} from './aiAgentSdkTools';

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
interface CapturedServer { tools: CapturedTool[] }

const toolSpy = vi.mocked(sdkTool);

function binding(label: string) {
  const getAuth = vi.fn(() => { throw new Error(`${label}: getAuth must not run — preToolUse denies first`); });
  const onPreToolUse = vi.fn(async (_toolName: string, _input: Record<string, unknown>) => ({ allowed: false as const, error: `${label} denied` }));
  const onPostToolUse = vi.fn(async () => {});
  return {
    getAuth,
    onPreToolUse: onPreToolUse as unknown as PreToolUseCallback & typeof onPreToolUse,
    onPostToolUse: onPostToolUse as unknown as PostToolUseCallback & typeof onPostToolUse,
  };
}

function byName<T extends { name: string }>(tools: readonly T[], name: string): T {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not declared`);
  return found;
}

const GATE_ENV = [
  'BREEZE_AI_SCRIPT_AUTHORING_ENABLED', 'FLOWS_ENABLED', 'IS_HOSTED', 'BREEZE_AI_AGENTS_ENABLED',
  'BREEZE_WISP_ENABLED', 'M365_ENABLED', 'DELEGANT_BASE_URL', 'GOOGLE_WORKSPACE_ENABLED',
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => { savedEnv = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]])); });
afterEach(() => {
  for (const k of GATE_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const declaredNames = () => buildBreezeSdkTools((() => { throw new Error('unused'); }) as never).map((t) => t.name);

describe('Breeze tool template cache (#11004)', () => {
  it('declares the static tool set once and reuses it for every later session and the system-prompt name list', () => {
    warmBreezeToolSurface();
    const afterWarm = toolSpy.mock.calls.length;
    // Sanity: the warm-up really declared the surface (not a vacuous zero).
    expect(afterWarm).toBeGreaterThan(300);

    const a = binding('A');
    const b = binding('B');
    createBreezeMcpServer(a.getAuth as never, a.onPreToolUse, a.onPostToolUse);
    createBreezeMcpServer(b.getAuth as never, b.onPreToolUse, b.onPostToolUse);
    buildBreezeSdkTools(a.getAuth as never, a.onPreToolUse, a.onPostToolUse);
    listChatSurfaceToolNames();
    listChatSurfaceToolNames();

    expect(toolSpy.mock.calls.length, 'tool() re-declared after the template was warm').toBe(afterWarm);
  });

  it('shares static definitions across sessions but binds distinct handlers per session', () => {
    const a = binding('A');
    const b = binding('B');
    const serverA = createBreezeMcpServer(a.getAuth as never, a.onPreToolUse, a.onPostToolUse) as unknown as CapturedServer;
    const serverB = createBreezeMcpServer(b.getAuth as never, b.onPreToolUse, b.onPostToolUse) as unknown as CapturedServer;

    expect(serverA.tools.length).toBeGreaterThan(300);
    expect(serverA.tools.map((t) => t.name)).toEqual(serverB.tools.map((t) => t.name));
    for (const toolA of serverA.tools) {
      const toolB = byName(serverB.tools, toolA.name);
      expect(toolB.inputSchema, `${toolA.name}: inputSchema should be the shared static object`).toBe(toolA.inputSchema);
      expect(toolB._meta, `${toolA.name}: registry _meta should be the shared static object`).toBe(toolA._meta);
      expect(toolB.description).toBe(toolA.description);
      expect(toolB.handler, `${toolA.name}: handler must be bound per session`).not.toBe(toolA.handler);
      expect(toolB).not.toBe(toolA);
    }
  });

  it('each bound handler dispatches to its own session callbacks only', async () => {
    const a = binding('A');
    const b = binding('B');
    const serverA = createBreezeMcpServer(a.getAuth as never, a.onPreToolUse, a.onPostToolUse) as unknown as CapturedServer;
    const serverB = createBreezeMcpServer(b.getAuth as never, b.onPreToolUse, b.onPostToolUse) as unknown as CapturedServer;

    const resultA = await byName(serverA.tools, 'query_devices').handler({}, {});
    expect(resultA.isError).toBe(true);
    expect(resultA.content[0]!.text).toContain('A denied');
    expect(a.onPreToolUse).toHaveBeenCalledTimes(1);
    expect(a.onPreToolUse.mock.calls[0]![0]).toBe('query_devices');
    expect(b.onPreToolUse).not.toHaveBeenCalled();

    // A session-aware (non-makeToolHandler) declaration binds the same way.
    const sessionA = { breezeSessionId: 'session-a' };
    const sessionB = { breezeSessionId: 'session-b' };
    const plansA = buildBreezeSdkTools(a.getAuth as never, a.onPreToolUse, a.onPostToolUse, () => sessionA as never);
    const plansB = buildBreezeSdkTools(b.getAuth as never, b.onPreToolUse, b.onPostToolUse, () => sessionB as never);
    expect(byName(plansA, 'propose_action_plan').handler).not.toBe(byName(plansB, 'propose_action_plan').handler);

    const resultB = await byName(serverB.tools, 'get_device_details').handler({ deviceId: crypto.randomUUID() }, {});
    expect(resultB.content[0]!.text).toContain('B denied');
    expect(b.onPreToolUse).toHaveBeenCalledTimes(1);
    expect(a.onPreToolUse).toHaveBeenCalledTimes(1);
  });

  it('a session with no callbacks never inherits another session\'s callbacks', async () => {
    const a = binding('A');
    createBreezeMcpServer(a.getAuth as never, a.onPreToolUse, a.onPostToolUse);
    const getAuthC = vi.fn(() => { throw new Error('C auth unavailable'); });
    const serverC = createBreezeMcpServer(getAuthC as never) as unknown as CapturedServer;

    const result = await byName(serverC.tools, 'query_devices').handler({}, {});
    expect(result.isError).toBe(true);
    expect(getAuthC).toHaveBeenCalled();
    expect(a.onPreToolUse).not.toHaveBeenCalled();
  });

  it('still honours env exposure gates read at call time (system-prompt names follow the flag)', () => {
    process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = 'false';
    expect(listChatSurfaceToolNames()).not.toContain('propose_script');
    process.env.BREEZE_AI_SCRIPT_AUTHORING_ENABLED = 'true';
    expect(listChatSurfaceToolNames()).toContain('propose_script');
  });

  // Every gate in toolSurfaceGateKey(): flipping it after the template is warm
  // must change the declared surface, or the cache is serving a stale set.
  it.each([
    { gate: 'script authoring', probe: 'propose_script', off: { BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false' }, on: { BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true' } },
    { gate: 'flows', probe: 'draft_flow', off: { FLOWS_ENABLED: 'false' }, on: { FLOWS_ENABLED: 'true' } },
    {
      gate: 'wisp', probe: 'recall',
      off: { IS_HOSTED: 'true', BREEZE_AI_AGENTS_ENABLED: 'true', BREEZE_WISP_ENABLED: 'false' },
      on: { IS_HOSTED: 'true', BREEZE_AI_AGENTS_ENABLED: 'true', BREEZE_WISP_ENABLED: 'true' },
    },
    { gate: 'm365', probe: 'm365_lookup_user', off: { M365_ENABLED: 'false', DELEGANT_BASE_URL: '' }, on: { M365_ENABLED: 'true', DELEGANT_BASE_URL: '' } },
    { gate: 'google workspace', probe: 'google_lookup_user', off: { GOOGLE_WORKSPACE_ENABLED: 'false' }, on: { GOOGLE_WORKSPACE_ENABLED: 'true' } },
  ])('re-declares the surface when the $gate gate flips', ({ probe, off, on }) => {
    Object.assign(process.env, off);
    expect(declaredNames()).not.toContain(probe);
    Object.assign(process.env, on);
    expect(declaredNames()).toContain(probe);
    Object.assign(process.env, off);
    expect(declaredNames()).not.toContain(probe);
  });

  it('listChatSurfaceToolNames returns a fresh array each call (callers may not mutate the cache)', () => {
    const first = listChatSurfaceToolNames();
    first.push('not_a_real_tool');
    expect(listChatSurfaceToolNames()).not.toContain('not_a_real_tool');
  });

  it('bindBreezeSdkTools refuses a template entry whose handler is not late-bound (no shared closures)', () => {
    const shared = { name: 'inline_tool', description: 'd', inputSchema: {}, handler: async () => ({ content: [] }) };
    const b = binding('A');
    expect(() => sdkToolsTest.bindBreezeSdkTools([shared as never], {
      getAuth: b.getAuth as never, getActiveSession: undefined, onPreToolUse: b.onPreToolUse, onPostToolUse: b.onPostToolUse,
    })).toThrow(/no late-bound handler/);
  });

  it('bindBreezeSdkTools returns new objects and never mutates the template; the placeholder refuses to run', () => {
    const factory = vi.fn(() => async () => ({ content: [] }));
    const template = Object.freeze({ name: 't', description: 'd', inputSchema: {}, handler: sdkToolsTest.lateBound(factory) });
    expect(() => (template.handler as () => unknown)()).toThrow(/unbound template tool handler/);
    const b = binding('A');
    const bindingA = { getAuth: b.getAuth as never, getActiveSession: undefined, onPreToolUse: b.onPreToolUse, onPostToolUse: b.onPostToolUse };
    const [bound] = sdkToolsTest.bindBreezeSdkTools([template as never], bindingA);
    expect(bound).not.toBe(template);
    expect(bound!.handler).not.toBe(template.handler);
    expect(factory).toHaveBeenCalledWith(bindingA);
    expect(bound!.inputSchema).toBe(template.inputSchema);
  });

  it('propose_action_plan reads ITS session through the binding', async () => {
    const a = binding('A');
    const noSession = buildBreezeSdkTools(a.getAuth as never, a.onPreToolUse, a.onPostToolUse, (() => undefined) as never);
    const refused = await (byName(noSession, 'propose_action_plan').handler as CapturedTool['handler'])(
      { title: 't', steps: [{ toolName: 'query_devices', input: {}, reasoning: 'r' }] }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('No active session');

    const getSessionB = vi.fn(() => ({ breezeSessionId: 'session-b' }));
    const withSession = buildBreezeSdkTools(a.getAuth as never, a.onPreToolUse, a.onPostToolUse, getSessionB as never);
    const unknown = await (byName(withSession, 'propose_action_plan').handler as CapturedTool['handler'])(
      { title: 't', steps: [{ toolName: 'not_a_tool', input: {}, reasoning: 'r' }] }, {});
    expect(getSessionB).toHaveBeenCalled();
    expect(unknown.content[0]!.text).toContain('Unknown tool in plan');
  });

  it('an onlyTools server binds just its subset onto the shared template and leaves the full surface intact', () => {
    const fullBefore = buildBreezeSdkTools((() => { throw new Error('unused'); }) as never).length;
    const onlyTools = new Set(['query_devices', 'get_device_details']);
    const a = binding('A');
    const b = binding('B');
    const serverA = createBreezeMcpServer(a.getAuth as never, a.onPreToolUse, a.onPostToolUse, undefined, [], { onlyTools }) as unknown as CapturedServer;
    const serverB = createBreezeMcpServer(b.getAuth as never, b.onPreToolUse, b.onPostToolUse, undefined, [], { onlyTools }) as unknown as CapturedServer;
    expect(serverA.tools.map((t) => t.name).sort()).toEqual([...onlyTools].sort());
    const full = createBreezeMcpServer(a.getAuth as never) as unknown as CapturedServer;
    for (const name of onlyTools) {
      expect(byName(serverA.tools, name).handler).not.toBe(byName(serverB.tools, name).handler);
      expect(byName(serverA.tools, name).inputSchema).toBe(byName(full.tools, name).inputSchema);
    }
    expect(buildBreezeSdkTools((() => { throw new Error('unused'); }) as never)).toHaveLength(fullBefore);
    expect(() => createBreezeMcpServer(a.getAuth as never, undefined, undefined, undefined, [], { onlyTools: new Set(['no_such_tool']) }))
      .toThrow(/onlyTools referenced unknown tool name/);
  });

  it('warmBreezeToolSurface reports the surface and is idempotent', () => {
    const first = warmBreezeToolSurface();
    const calls = toolSpy.mock.calls.length;
    const second = warmBreezeToolSurface();
    expect(first.tools).toBeGreaterThan(300);
    expect(second.tools).toBe(first.tools);
    expect(second.ms).toBeGreaterThanOrEqual(0);
    expect(toolSpy.mock.calls.length).toBe(calls);
  });
});
