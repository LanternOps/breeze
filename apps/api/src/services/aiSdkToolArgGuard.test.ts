import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createArgCheckedSdkMcpServer, unknownToolArgsHooks, unknownToolArgsHooksForTools } from './aiSdkToolArgGuard';
import { createBreezeMcpServer } from './aiAgentSdkTools';
import { createScriptBuilderMcpServer } from './scriptBuilderTools';

const noop = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
const findDevices = tool('find_devices', 'Find devices', { search: z.string().optional(), sub: z.object({ a: z.string() }).optional() }, noop);
const signal = new AbortController().signal;

function pre(toolName: string, toolInput: unknown, source: string | undefined = 'sdk'): HookInput {
  return {
    hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't1',
    session_id: 's', transcript_path: '', cwd: '',
    ...(source ? { mcp_server: { name: 'breeze', source } } : {}),
  } as unknown as HookInput;
}

async function decide(hooks: ReturnType<typeof unknownToolArgsHooks>, input: HookInput) {
  const out = await hooks.PreToolUse[0]!.hooks[0]!(input, 't1', { signal });
  return (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
}

describe('unknownToolArgsHooks (#11861)', () => {
  const server = createArgCheckedSdkMcpServer({ name: 'breeze', version: '1.0.0', tools: [findDevices] });
  const hooks = unknownToolArgsHooks({ breeze: server });

  it('denies a call with an unknown top-level key, naming it and the accepted keys', async () => {
    expect(await decide(hooks, pre('mcp__breeze__find_devices', { search: 'web', filter: 'x' }))).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Invalid input: unknown argument "filter" (accepted: search, sub)',
    });
  });

  it('denies a nested unknown key', async () => {
    expect((await decide(hooks, pre('mcp__breeze__find_devices', { sub: { a: '1', b: 2 } })))?.permissionDecisionReason)
      .toBe('Invalid input: sub: unknown argument "b" (accepted: a)');
  });

  it('lets a call with known keys through untouched', async () => {
    expect(await decide(hooks, pre('mcp__breeze__find_devices', { search: 'web' }))).toBeUndefined();
  });

  it('ignores other tools, other servers, unrecorded servers and non-SDK servers of the same name', async () => {
    expect(await decide(hooks, pre('ToolSearch', { query: 'x', filter: 1 }, undefined))).toBeUndefined();
    expect(await decide(hooks, pre('mcp__breeze__not_registered', { filter: 1 }))).toBeUndefined();
    expect(await decide(hooks, pre('mcp__other__find_devices', { filter: 1 }))).toBeUndefined();
    expect(await decide(hooks, pre('mcp__breeze__find_devices', { filter: 1 }, 'project'))).toBeUndefined();
    const unrecorded = unknownToolArgsHooks({ breeze: { type: 'sdk', name: 'breeze', instance: {} } as never });
    expect(await decide(unrecorded, pre('mcp__breeze__find_devices', { filter: 1 }))).toBeUndefined();
  });

  it('resolves the longest server prefix (a server name containing "__"-adjacent underscores)', async () => {
    const a = createArgCheckedSdkMcpServer({ name: 'script', version: '1', tools: [tool('builder__x', 'd', { p: z.string() }, noop)] });
    const ab = createArgCheckedSdkMcpServer({ name: 'script_builder', version: '1', tools: [tool('x', 'd', { q: z.string() }, noop)] });
    const both = unknownToolArgsHooks({ script: a, script_builder: ab });
    expect((await decide(both, pre('mcp__script_builder__x', { q: '1', p: '2' })))?.permissionDecisionReason)
      .toBe('Invalid input: unknown argument "p" (accepted: q)');
  });

  it('unknownToolArgsHooksForTools builds the same hook from declarations', async () => {
    const fromTools = unknownToolArgsHooksForTools({ breeze: [findDevices] });
    expect((await decide(fromTools, pre('mcp__breeze__find_devices', { filter: 1 })))?.permissionDecision).toBe('deny');
  });

  it('never fires for a non-PreToolUse event', async () => {
    const out = await hooks.PreToolUse[0]!.hooks[0]!({ hook_event_name: 'PostToolUse' } as unknown as HookInput, 't1', { signal });
    expect(out).toEqual({});
  });

  it('fails closed when the check itself throws (a throwing hook would let the stripped call run)', async () => {
    const throwing = tool('boom', 'd', { sub: z.lazy(() => { throw new Error('getter broke'); }) }, noop);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const guarded = unknownToolArgsHooks({ breeze: createArgCheckedSdkMcpServer({ name: 'breeze', version: '1', tools: [throwing] }) });
      const out = await decide(guarded, pre('mcp__breeze__boom', { sub: { a: 1 } }));
      expect(out?.permissionDecision).toBe('deny');
      expect(out?.permissionDecisionReason).toMatch(/^Invalid input: the arguments could not be checked/);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('reports an in-process server it did not record instead of skipping it in silence', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      unknownToolArgsHooks({ breeze: { type: 'sdk', name: 'breeze', instance: {} } as never });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server "breeze" was not built by createArgCheckedSdkMcpServer'));
      errSpy.mockClear();
      unknownToolArgsHooks({ breeze: server });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

/** The production builders, not a fixture server: the server they return is the one the hook recognizes. */
describe('production SDK servers are recognized by the hook (#11861)', () => {
  const fakeAuth = (() => { throw new Error('handlers must not run in this test'); }) as never;

  it('chat/agent server (createBreezeMcpServer): query_devices({ filter }) is denied, a known call is not', async () => {
    const breeze = createBreezeMcpServer(fakeAuth);
    const h = unknownToolArgsHooks({ breeze });
    const denied = await decide(h, pre('mcp__breeze__query_devices', { filter: 'online' }));
    expect(denied?.permissionDecision).toBe('deny');
    expect(denied?.permissionDecisionReason).toMatch(/^Invalid input: unknown argument "filter" \(accepted: .*search/);
    expect(await decide(h, pre('mcp__breeze__query_devices', { search: 'web' }))).toBeUndefined();
  });

  it('script builder server (createScriptBuilderMcpServer): an unknown key on a delegated tool is denied', async () => {
    const sb = createScriptBuilderMcpServer(fakeAuth);
    const h = unknownToolArgsHooks({ script_builder: sb });
    expect((await decide(h, pre('mcp__script_builder__query_devices', { filter: 'x' })))?.permissionDecision).toBe('deny');
  });
});

/**
 * Production wiring: an SDK server not built through createArgCheckedSdkMcpServer,
 * or a query() without the hook, would silently strip unknown arguments again.
 * Measurement harnesses that do not run production turns are listed with why.
 */
describe('every production SDK server and query() is guarded (#11861)', () => {
  const srcRoot = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== '__scripts__' && name !== 'node_modules') walk(full); continue; }
      if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) files.push(full);
    }
  };
  walk(srcRoot);
  const rel = (f: string) => path.relative(srcRoot, f).split(path.sep).join('/');
  const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  /** Offline measurement / fidelity tooling: never a production turn. */
  const UNGUARDED: Record<string, string> = {
    'services/aiSdkToolArgGuard.ts': 'the guard itself wraps createSdkMcpServer',
    'services/llm/toolCapture/runSurface.ts': 'tool-capture measurement of the advertised prefix (deny mode at the handler); no real tool runs',
    'services/llm/providerFidelityHarness.ts': 'provider tool-fidelity probe with its own fixture tool; never a Breeze tool',
  };

  it('createSdkMcpServer is only called through the guard', () => {
    const offenders = files.filter((f) => /\bcreateSdkMcpServer\(/.test(code(f)) && !UNGUARDED[rel(f)]).map(rel)
      // The verify harness builds through an injected SDK and passes the declaration-based hook.
      .filter((f) => !(f === 'services/llm/surfaceTurnHarness.ts' && /unknownToolArgsHooksForTools\(/.test(code(path.join(srcRoot, f)))));
    expect(offenders).toEqual([]);
  });

  it('every query() call site passes the unknown-argument hook (counted per call site, not per file)', () => {
    const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
    const offenders = files
      .filter((f) => /\bquery\(\{/.test(code(f)) && !UNGUARDED[rel(f)])
      .filter((f) => count(code(f), /hooks: unknownToolArgsHooks(ForTools)?\(/g) < count(code(f), /\bquery\(\{/g))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the scan sees the real call sites (vacuity guard)', () => {
    const queried = files.filter((f) => /\bquery\(\{/.test(code(f))).map(rel);
    expect(queried).toEqual(expect.arrayContaining(['services/streamingSessionManager.ts', 'services/aiAgents/runLoop.ts']));
  });
});
