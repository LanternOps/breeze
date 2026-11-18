import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C4 — flows as MCP tools: what `tools/list` advertises
 * (listed ⇒ callable) and how a `tools/call` resolves, at the LIVE tier. The
 * HTTP dispatch half (flow__ before the tenant branch) is
 * routes/mcpServer.flowsGate.test.ts.
 */

vi.mock('../../config/env', async (orig) => ({ ...(await orig<typeof import('../../config/env')>()), flowsEnabled: vi.fn(() => true) }));
vi.mock('./flowTools', async (orig) => ({ ...(await orig<typeof import('./flowTools')>()), resolveFlowTools: vi.fn(), resolveFlowToolForCall: vi.fn() }));
vi.mock('./toolRuns', () => ({ startToolRun: vi.fn() }));

import { flowsEnabled } from '../../config/env';
import { resolveFlowToolForCall, resolveFlowTools, type FlowToolDescriptor } from './flowTools';
import { startToolRun } from './toolRuns';
import { callMcpFlowTool, listMcpFlowTools } from './mcpFlowTools';

const ORG = '11111111-1111-4111-8111-111111111111';
function d(name: string, tier: 1 | 2 | 3, over: Partial<FlowToolDescriptor> = {}): FlowToolDescriptor {
  return {
    name, flowId: `f-${name}`, flowName: name, publicationId: `p-${name}`, publicationSeq: 1,
    owner: { orgId: ORG, partnerId: 'p' }, partnerWide: false, tier, revision: `flowpub:p-${name}`,
    definition: { name, description: `Flow: ${name}`, input_schema: { type: 'object', properties: {} } },
    validate: () => ({ ok: true, value: { inputs: {}, orgId: null, idempotencyKey: null } }),
    ...over,
  };
}
const keyAuth = { principal: { kind: 'api_key', apiKeyId: 'k' }, scope: 'organization', orgId: ORG, user: { id: 'u' } } as unknown as AuthContext;

beforeEach(() => {
  vi.mocked(flowsEnabled).mockReturnValue(true);
  vi.mocked(resolveFlowTools).mockReset().mockResolvedValue([d('flow__aa', 1), d('flow__bb', 2), d('flow__cc', 3)]);
  vi.mocked(resolveFlowToolForCall).mockReset();
  vi.mocked(startToolRun).mockReset().mockResolvedValue({ ok: true, runId: 'run-1', duplicate: false, runPath: '/flows/runs/run-1' });
});

describe('listMcpFlowTools', () => {
  it('tier-1 flow listed for ai:read; tier-2 flow needs ai:write; tier-3 flow never listed', async () => {
    expect((await listMcpFlowTools(keyAuth, ORG, { hasWrite: false })).map((t) => t.name)).toEqual(['flow__aa']);
    expect((await listMcpFlowTools(keyAuth, ORG, { hasWrite: true })).map((t) => t.name)).toEqual(['flow__aa', 'flow__bb']);
    expect(resolveFlowTools).toHaveBeenCalledWith(keyAuth, ORG);
  });

  it('entries carry the descriptor schema and description', async () => {
    const [entry] = await listMcpFlowTools(keyAuth, ORG, { hasWrite: false });
    expect(entry).toEqual({ name: 'flow__aa', description: 'Flow: flow__aa', inputSchema: { type: 'object', properties: {} }, tier: 1 });
  });

  it('flag off: nothing is listed, nothing is read', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await listMcpFlowTools(keyAuth, ORG, { hasWrite: true })).toEqual([]);
    expect(resolveFlowTools).not.toHaveBeenCalled();
  });
});

describe('callMcpFlowTool', () => {
  it('a tier-1 flow starts an mcp run as the API key', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(d('flow__aa', 1));
    const out = await callMcpFlowTool('flow__aa', { x: 1 }, keyAuth, ['ai:read'], ORG);
    expect(out).toEqual({ kind: 'result', tier: 1, isError: false, text: JSON.stringify({ runId: 'run-1', runPath: '/flows/runs/run-1', duplicate: false }) });
    expect(startToolRun).toHaveBeenCalledWith(expect.objectContaining({ name: 'flow__aa' }), { x: 1 }, 'mcp', { kind: 'api_key', auth: keyAuth }, { defaultOrgId: ORG });
  });

  it('re-enabled tier-3 flow is refused over MCP (listed at tier 2, live tier 3 at call)', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(d('flow__bb', 3));
    expect(await callMcpFlowTool('flow__bb', {}, keyAuth, ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'], ORG))
      .toEqual({ kind: 'approval_required', tier: 3 });
    expect(startToolRun).not.toHaveBeenCalled();
  });

  it('tier-2 flow needs ai:write', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(d('flow__bb', 2));
    expect(await callMcpFlowTool('flow__bb', {}, keyAuth, ['ai:read'], ORG)).toEqual({ kind: 'scope_required', tier: 2, scope: 'ai:write' });
    expect(startToolRun).not.toHaveBeenCalled();
  });

  it('flag off, a non-flow name or an unresolvable flow is unknown (no existence oracle)', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await callMcpFlowTool('flow__aa', {}, keyAuth, ['ai:read'], ORG)).toEqual({ kind: 'unknown' });
    vi.mocked(flowsEnabled).mockReturnValue(true);
    expect(await callMcpFlowTool('hudu__x', {}, keyAuth, ['ai:read'], ORG)).toEqual({ kind: 'unknown' });
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(null);
    expect(await callMcpFlowTool('flow__zzz', {}, keyAuth, ['ai:read'], ORG)).toEqual({ kind: 'unknown' });
  });

  it('a run refusal is an error result', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(d('flow__aa', 1));
    vi.mocked(startToolRun).mockResolvedValue({ ok: false, error: 'permission_missing', missing: [{ stepId: 's', permission: 'devices.read' }] });
    const out = await callMcpFlowTool('flow__aa', {}, keyAuth, ['ai:read'], ORG);
    expect(out).toMatchObject({ kind: 'result', isError: true });
    expect(JSON.parse((out as { text: string }).text)).toMatchObject({ error: 'permission_missing' });
  });
});
