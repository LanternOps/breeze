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
import { agentDeniedToolNames, ceilingAdmitsTool, ceilingToolTermOf } from './wisp/grantAuthority';

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

// #10430: a Wisp chat session registers only the tools its grant ceiling
// admits, so neither the inline tool list nor the ToolSearch index (built
// from every registered tool) offers one the ceiling gate would refuse.
describe('createBreezeMcpServer admitTool (#10430)', () => {
  const term = ceilingToolTermOf({ deniedTools: ['query_devices'], toolAllowlist: null });
  const admitTool = (name: string) => ceilingAdmitsTool(term, name);

  it('leaves a tool in deniedTools and every agent-denied tool off the server', () => {
    const full = (createBreezeMcpServer(fakeAuth as never) as unknown as CapturedServer).tools.map((t) => t.name);
    const names = (createBreezeMcpServer(fakeAuth as never, undefined, undefined, undefined, [], { admitTool }) as unknown as CapturedServer)
      .tools.map((t) => t.name);

    expect(full).toContain('query_devices');
    expect(full).toContain('list_operator_tasks');
    expect(names).not.toContain('query_devices');
    for (const denied of agentDeniedToolNames()) expect(names, denied).not.toContain(denied);
    expect(names).toContain('get_device_details');
    expect(names.sort()).toEqual(full.filter(admitTool).sort());
  });

  it('applies to extra tools too', () => {
    const extra = (name: string) => ({ name, description: name, inputSchema: {}, handler: async () => ({ content: [] }) });
    const server = createBreezeMcpServer(
      fakeAuth as never, undefined, undefined, undefined,
      [extra('tenant_kept'), extra('tenant_dropped')] as never,
      { admitTool: (name) => name !== 'tenant_dropped' },
    ) as unknown as CapturedServer;
    const names = server.tools.map((t) => t.name);
    expect(names).toContain('tenant_kept');
    expect(names).not.toContain('tenant_dropped');
  });
});
