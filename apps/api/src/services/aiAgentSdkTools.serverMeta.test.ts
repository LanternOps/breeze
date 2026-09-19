/**
 * Review fix for PR #6341 (A-W02): `createBreezeMcpServer` applying
 * `attachRegistryMeta` to every registered tool before handing them to
 * `createSdkMcpServer` was untested. Nothing failed if the
 * `.map(attachRegistryMeta)` at the bottom of `createBreezeMcpServer` were
 * ever dropped — the registry's `searchHint`/`alwaysLoad` would silently stop
 * reaching the model's tool-search metadata.
 *
 * This mocks `createSdkMcpServer` to just hand back the options object it was
 * called with, so the `tools` array it would have registered can be inspected
 * directly. It must stay in its OWN file: the sibling
 * `aiAgentSdkTools.registryParity.contract.test.ts` is explicitly mock-free
 * (needs the real registry wiring), so this mock cannot live there.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn((options: unknown) => options) };
});

import { createBreezeMcpServer } from './aiAgentSdkTools';
import { getAllRegisteredToolNames, getToolSearchHint } from './aiTools';

interface CapturedTool { name: string; _meta?: Record<string, unknown> }
interface CapturedServer { tools: CapturedTool[] }

const fakeAuth = () => { throw new Error('createBreezeMcpServer must not invoke tool handlers in this test'); };

describe('createBreezeMcpServer attaches registry search metadata to every declared tool', () => {
  it('every captured tool that is in the registry carries the registry searchHint in _meta', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const server = createBreezeMcpServer(fakeAuth as never) as unknown as CapturedServer;
    const inRegistry = server.tools.filter((t) => registered.has(t.name));

    // Sanity: the mock actually captured a realistic number of tools, so this
    // test would fail loudly (not vacuously pass on an empty list) if the
    // mock wiring broke.
    expect(inRegistry.length).toBeGreaterThan(100);

    const bad = inRegistry
      .filter((t) => t._meta?.['anthropic/searchHint'] !== getToolSearchHint(t.name))
      .map((t) => t.name);
    expect(bad, 'tools whose captured _meta.searchHint disagrees with (or is missing) the registry hint').toEqual([]);
  });

  it('still attaches the registry metadata when onlyTools restricts the server to a subset', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const onlyTools = new Set(['query_devices', 'get_device_details', 'analyze_metrics']);
    const server = createBreezeMcpServer(
      fakeAuth as never,
      undefined,
      undefined,
      undefined,
      [],
      { onlyTools },
    ) as unknown as CapturedServer;

    expect(server.tools.map((t) => t.name).sort()).toEqual([...onlyTools].sort());
    for (const t of server.tools) {
      expect(registered.has(t.name)).toBe(true);
      expect(t._meta?.['anthropic/searchHint']).toBe(getToolSearchHint(t.name));
    }
  });
});
