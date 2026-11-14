/**
 * #11395 (W03): the script builder registers its own MCP server through a
 * factory, so `allowedTools` alone never shrank what it ADVERTISES (W01 left
 * this to W03's measurement). Under a constrained session exposure the server
 * registers only the exposed names, with compact descriptions; without one it
 * is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn((options: unknown) => options) };
});

import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from './scriptBuilderTools';
import type { ActiveSession } from './streamingSessionManager';

interface CapturedServer { tools: Array<{ name: string; description: string }> }
const deny = () => { throw new Error('never'); };
const sessionWith = (toolExposure: unknown) => () => ({ toolExposure }) as unknown as ActiveSession;

describe('createScriptBuilderMcpServer under a tool exposure (#11395)', () => {
  it('no session or an identity exposure: every script-builder tool, full descriptions', () => {
    const plain = createScriptBuilderMcpServer(deny as never) as unknown as CapturedServer;
    const identity = createScriptBuilderMcpServer(deny as never, undefined, undefined,
      sessionWith({ names: null, promptMode: 'standard' })) as unknown as CapturedServer;
    expect(plain.tools.map((t) => t.name).sort()).toEqual(SCRIPT_BUILDER_MCP_TOOL_NAMES.map((n) => n.replace(/^mcp__script_builder__/, '')).sort());
    const shape = (s: CapturedServer) => s.tools.map((t) => [t.name, t.description]);
    expect(shape(identity)).toEqual(shape(plain));
  });

  it('a constrained exposure registers only its names, each described in ≤ 200 chars', () => {
    const names = ['apply_script_code', 'query_devices', 'execute_script_on_device', 'get_script_execution'];
    const server = createScriptBuilderMcpServer(deny as never, undefined, undefined,
      sessionWith({ names, promptMode: 'constrained' })) as unknown as CapturedServer;
    expect(server.tools.map((t) => t.name).sort()).toEqual([...names].sort());
    for (const t of server.tools) expect(t.description.length, t.name).toBeLessThanOrEqual(200);
    const full = (createScriptBuilderMcpServer(deny as never) as unknown as CapturedServer).tools.find((t) => t.name === 'get_script_execution')!;
    expect(full.description.length).toBeGreaterThan(200);
  });
});
