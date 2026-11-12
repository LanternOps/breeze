/**
 * #11395 (W03): the Office add-in registers its own MCP server through a
 * factory, so `allowedTools` alone never shrank what it advertises. Under a
 * constrained session exposure it registers only the exposed client tools.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn((options: unknown) => options) };
});

import { CLIENT_TOOL_REGISTRIES, createClientWorkbookMcpServer } from './clientAiTools';
import type { ActiveSession } from './streamingSessionManager';

interface CapturedServer { tools: Array<{ name: string; description: string }> }
const sessionWith = (toolExposure: unknown) => () => ({ toolExposure }) as unknown as ActiveSession;

describe('createClientWorkbookMcpServer under a tool exposure (#11395)', () => {
  it('no exposure or the identity exposure: every client tool of the host', () => {
    const all = Object.keys(CLIENT_TOOL_REGISTRIES.excel).sort();
    const none = createClientWorkbookMcpServer('excel', sessionWith(undefined)) as unknown as CapturedServer;
    const identity = createClientWorkbookMcpServer('excel', sessionWith({ names: null, promptMode: 'standard' })) as unknown as CapturedServer;
    expect(none.tools.map((t) => t.name).sort()).toEqual(all);
    expect(identity.tools.map((t) => t.name).sort()).toEqual(all);
    expect(all.length).toBeGreaterThan(3);
  });

  it('a constrained exposure registers only its names', () => {
    const server = createClientWorkbookMcpServer('excel',
      sessionWith({ names: ['read_range', 'read_selection'], promptMode: 'constrained' })) as unknown as CapturedServer;
    expect(server.tools.map((t) => t.name).sort()).toEqual(['read_range', 'read_selection']);
  });
});
