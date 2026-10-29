import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C5 — agents call flows (plan Decision 9): Tier-1
 * flows only, named in the allowlist at EVERY tier, and only from runs whose
 * auth carries no device, site or delegation ceiling. No proposal path.
 */

vi.mock('../../config/env', async (orig) => ({ ...(await orig<typeof import('../../config/env')>()), flowsEnabled: vi.fn(() => true) }));
vi.mock('./flowTools', async (orig) => ({ ...(await orig<typeof import('./flowTools')>()), resolveFlowToolForCall: vi.fn() }));
vi.mock('./toolRuns', () => ({ startToolRun: vi.fn() }));

import { flowsEnabled } from '../../config/env';
import { resolveFlowToolForCall, type FlowToolDescriptor } from './flowTools';
import { startToolRun } from './toolRuns';
import { agentFlowToolRunStarter, agentRunMayCallFlows, gateAgentFlowToolCall, resolveAgentFlowTools } from './agentFlowTools';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
function d(name: string, tier: 1 | 2 | 3): FlowToolDescriptor {
  return {
    name, flowId: `f-${name}`, flowName: name, publicationId: `p-${name}`, publicationSeq: 1,
    owner: { orgId: ORG, partnerId: 'p' }, partnerWide: false, tier, revision: `flowpub:p-${name}`,
    definition: { name, description: `Flow: ${name}`, input_schema: { type: 'object', properties: {} } },
    validate: (input: unknown) => ('bad' in ((input ?? {}) as object)
      ? { ok: false, message: 'bad: Unknown input', issues: [{ name: 'bad', message: 'Unknown input' }] }
      : { ok: true, value: { inputs: {}, orgId: null, idempotencyKey: null } }),
  };
}
const unrestricted = { principal: { kind: 'ai_agent', agentId: 'a', runId: RUN }, scope: 'organization', orgId: ORG, user: { id: 'a' } } as unknown as AuthContext;
const run = { id: RUN, orgId: ORG, grantId: null };
const policy = (over: Record<string, unknown> = {}) => ({
  enabled: true, mode: 'shadow', toolAllowlist: ['flow__report', 'flow__fixit'],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] }, deviceId: null, deviceSiteId: null, ...over,
}) as never;

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.mocked(flowsEnabled).mockReturnValue(true);
  vi.mocked(resolveFlowToolForCall).mockReset().mockImplementation(async (_a, name) => (
    name === 'flow__report' ? d('flow__report', 1) : name === 'flow__fixit' ? d('flow__fixit', 2) : null
  ));
  vi.mocked(startToolRun).mockReset().mockResolvedValue({ ok: true, runId: 'run-9', duplicate: false, runPath: '/flows/runs/run-9' });
});

describe('agentRunMayCallFlows', () => {
  it('only a run with no device, site or delegation ceiling', () => {
    expect(agentRunMayCallFlows(run, unrestricted, policy())).toBe(true);
    expect(agentRunMayCallFlows(run, { ...unrestricted, allowedDeviceIds: ['d'] } as AuthContext, policy())).toBe(false);
    expect(agentRunMayCallFlows(run, { ...unrestricted, allowedSiteIds: ['s'] } as AuthContext, policy())).toBe(false);
    expect(agentRunMayCallFlows(run, { ...unrestricted, allowedSiteIds: [] } as AuthContext, policy())).toBe(false);
    expect(agentRunMayCallFlows({ ...run, grantId: 'g' }, unrestricted, policy())).toBe(false);
    expect(agentRunMayCallFlows(run, unrestricted, policy({ deviceId: 'dev-1' }))).toBe(false);
  });
});

describe('resolveAgentFlowTools (exposure)', () => {
  it('exposes the allowlisted tier-1 flows only', async () => {
    const tools = await resolveAgentFlowTools(run, unrestricted, policy());
    expect(tools.map((t) => t.name)).toEqual(['flow__report']);
    expect(resolveFlowToolForCall).toHaveBeenCalledWith(unrestricted, 'flow__report', ORG);
  });

  it('device-bound agent cannot call a tier-1 flow: nothing is exposed', async () => {
    expect(await resolveAgentFlowTools(run, { ...unrestricted, allowedDeviceIds: ['d'] } as AuthContext, policy())).toEqual([]);
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('flag off or no flow names in the allowlist ⇒ nothing, no reads', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await resolveAgentFlowTools(run, unrestricted, policy())).toEqual([]);
    vi.mocked(flowsEnabled).mockReturnValue(true);
    expect(await resolveAgentFlowTools(run, unrestricted, policy({ toolAllowlist: ['query_devices'] }))).toEqual([]);
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('a flow that fails to resolve is skipped, not fatal', async () => {
    vi.mocked(resolveFlowToolForCall).mockRejectedValueOnce(new Error('db down'));
    expect(await resolveAgentFlowTools(run, unrestricted, policy({ toolAllowlist: ['flow__report'] }))).toEqual([]);
  });
});

describe('gateAgentFlowToolCall', () => {
  const gate = (over: { auth?: AuthContext; toolName?: string; input?: Record<string, unknown>; policy?: never; run?: typeof run } = {}) =>
    gateAgentFlowToolCall({ run: over.run ?? run, agentAuth: over.auth ?? unrestricted, toolName: over.toolName ?? 'flow__report', input: over.input ?? {}, guardrailPolicy: over.policy ?? policy() });

  it('allowlisted tier-1 flow from an unrestricted run is allowed with its gate', async () => {
    expect(await gate()).toMatchObject({ ok: true, descriptor: { name: 'flow__report', tier: 1 }, call: { inputs: {} } });
  });

  it('device-bound or site-ceiling agent runs are refused flow_not_allowed_for_agent', async () => {
    for (const auth of [{ ...unrestricted, allowedDeviceIds: ['d'] }, { ...unrestricted, allowedSiteIds: ['s'] }] as AuthContext[]) {
      const g = await gate({ auth });
      expect(g).toMatchObject({ ok: false });
      expect((g as { reason: string }).reason).toMatch(/flow_not_allowed_for_agent/);
    }
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('tier-2 flow is refused for agents (not a proposal)', async () => {
    const g = await gate({ toolName: 'flow__fixit' });
    expect(g).toMatchObject({ ok: false });
    expect((g as { reason: string }).reason).toMatch(/flow_not_allowed_for_agent/);
  });

  it('tier-1 flow not in the allowlist is denied', async () => {
    const g = await gate({ policy: policy({ toolAllowlist: ['flow__fixit'] }) });
    expect(g).toMatchObject({ ok: false });
    expect((g as { reason: string }).reason).toMatch(/allowlist/);
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('mode off denies a flow tool', async () => {
    const g = await gate({ policy: policy({ mode: 'off' }) });
    expect(g).toMatchObject({ ok: false });
    expect((g as { reason: string }).reason).toMatch(/off/i);
  });

  it('a vanished flow, a resolver error and invalid input are denied', async () => {
    expect(await gate({ toolName: 'flow__gone', policy: policy({ toolAllowlist: ['flow__gone'] }) })).toMatchObject({ ok: false });
    vi.mocked(resolveFlowToolForCall).mockRejectedValueOnce(new Error('db down'));
    expect(await gate()).toMatchObject({ ok: false });
    expect(await gate({ input: { bad: 1 } })).toMatchObject({ ok: false });
  });
});

describe('agentFlowToolRunStarter', () => {
  it('starts an ai_agent run with the parent agent run and no user', async () => {
    const start = agentFlowToolRunStarter({ id: RUN, orgId: ORG });
    await start(d('flow__report', 1), { x: 1 });
    expect(startToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'flow__report' }), { x: 1 }, 'ai_agent',
      { kind: 'agent_tier1', agentRunId: RUN, orgId: ORG }, { parentAgentRunId: RUN },
    );
  });
});
