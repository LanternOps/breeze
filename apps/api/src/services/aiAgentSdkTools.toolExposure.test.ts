/**
 * #11395 (W03): `createBreezeMcpServer` applies the live tool exposure itself.
 * A constrained exposure (from `options.toolExposure` or the session's
 * `toolExposure`) narrows what the SERVER advertises to `exposure.names` and
 * swaps each description for its compact form; the identity exposure (or none)
 * registers exactly what it did before. `createSdkMcpServer` is mocked to hand
 * back its options so the advertised tools can be read directly.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn((options: unknown) => options) };
});

import { createBreezeMcpServer } from './aiAgentSdkTools';
import { getToolCompactDescription } from './aiTools';
import type { ActiveSession } from './streamingSessionManager';
import type { ToolExposure } from './aiModels/toolExposure';

interface CapturedTool { name: string; description: string }
interface CapturedServer { tools: CapturedTool[] }

const fakeAuth = () => { throw new Error('handlers never run here'); };
const exposure = (over: Partial<ToolExposure>): ToolExposure => ({
  profile: 'minimal', names: ['query_devices', 'get_device_details', 'set_device_context'], extraToolNames: [],
  promptMode: 'constrained', toolSearchAllowed: false, compactSchemas: true, resultCharBudget: 2000,
  fingerprint: 'abc', droppedCustomNames: [], tooSmall: false, ...over,
});
const serve = (...args: Parameters<typeof createBreezeMcpServer>) => createBreezeMcpServer(...args) as unknown as CapturedServer;
const sessionWith = (e: ToolExposure | undefined) => () => ({ toolExposure: e }) as unknown as ActiveSession;

describe('createBreezeMcpServer under a tool exposure (#11395)', () => {
  it('no exposure: registers and describes exactly as before', () => {
    const plain = serve(fakeAuth as never);
    const withIdentity = serve(fakeAuth as never, undefined, undefined, sessionWith(exposure({ names: null, promptMode: 'standard' })));
    expect(withIdentity.tools.map((t) => [t.name, t.description])).toEqual(plain.tools.map((t) => [t.name, t.description]));
    expect(plain.tools.length).toBeGreaterThan(100);
  });

  it('a constrained session exposure narrows the advertised tools to its names (factory surfaces like the helper)', () => {
    const helperLevel = new Set(['query_devices', 'get_device_details', 'set_device_context', 'execute_command']);
    const server = serve(fakeAuth as never, undefined, undefined, sessionWith(exposure({})), [], { onlyTools: helperLevel });
    expect(server.tools.map((t) => t.name).sort()).toEqual(['get_device_details', 'query_devices', 'set_device_context']);
  });

  it('options.toolExposure applies without a session (headless agent runs)', () => {
    const server = serve(fakeAuth as never, undefined, undefined, undefined, [], { toolExposure: exposure({}) });
    expect(server.tools.map((t) => t.name).sort()).toEqual(['get_device_details', 'query_devices', 'set_device_context']);
  });

  it('a constrained exposure advertises compact descriptions; the full one keeps registry descriptions', () => {
    const full = new Map(serve(fakeAuth as never).tools.map((t) => [t.name, t.description]));
    const compact = new Map(serve(fakeAuth as never, undefined, undefined, sessionWith(exposure({}))).tools.map((t) => [t.name, t.description]));
    expect(compact.get('query_devices')).toBe(getToolCompactDescription('query_devices'));
    expect(compact.get('query_devices')).not.toBe(full.get('query_devices'));
    for (const [name, description] of compact) expect(description.length, name).toBeLessThanOrEqual(200);
  });

  it('names kept as extras count as exposed (a session whose tools are all kept extras keeps them)', () => {
    const server = serve(fakeAuth as never, undefined, undefined, sessionWith(exposure({ names: [], extraToolNames: ['query_devices'] })));
    expect(server.tools.map((t) => t.name)).toEqual(['query_devices']);
  });

  it('extra tools are never filtered here (the caller filters them by the exposure)', () => {
    const extra = { name: 'submit_alert_verdict', description: 'outcome', inputSchema: {}, handler: async () => ({ content: [] }) };
    const server = serve(fakeAuth as never, undefined, undefined, undefined, [extra as never], { toolExposure: exposure({}) });
    expect(server.tools.map((t) => t.name)).toContain('submit_alert_verdict');
  });
});
