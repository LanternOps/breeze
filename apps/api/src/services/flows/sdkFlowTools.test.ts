import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C3 — the chat side of flows as tools: the SDK tools a
 * session exposes, the call-time gate (live resolution, input validation) and
 * the handler that starts the run on exactly the publication the gate checked.
 */

vi.mock('./flowTools', async (orig) => ({ ...(await orig<typeof import('./flowTools')>()), resolveFlowToolForCall: vi.fn() }));
vi.mock('./toolRuns', () => ({ startToolRun: vi.fn() }));

import { resolveFlowToolForCall, type FlowToolDescriptor } from './flowTools';
import { startToolRun } from './toolRuns';
import { wrapExtraToolWithHooks } from '../aiAgentSdkTools';
import { buildFlowSdkTools, flowMcpToolNames } from './sdkFlowTools';
import {
  flowToolIntentBinding,
  flowToolPermissionRequirement,
  gateFlowToolCall,
  guardrailCheckForFlowTool,
  type FlowToolSessionView,
} from './flowToolGate';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const PUB = '77777777-7777-4777-8777-777777777777';

function descriptor(over: Partial<FlowToolDescriptor> = {}): FlowToolDescriptor {
  return {
    name: 'flow__disk', flowId: FLOW, flowName: 'Disk', publicationId: PUB, publicationSeq: 2,
    owner: { orgId: ORG, partnerId: PARTNER }, partnerWide: false, tier: 1, revision: `flowpub:${PUB}`,
    definition: {
      name: 'flow__disk', description: 'Flow: Disk — cleans disks',
      input_schema: { type: 'object', properties: { count: { type: 'number' }, idempotencyKey: { type: 'string' } }, additionalProperties: false },
    },
    validate: (input: unknown) => {
      const rec = (input ?? {}) as Record<string, unknown>;
      if ('bad' in rec) return { ok: false, message: 'bad: Unknown input', issues: [{ name: 'bad', message: 'Unknown input' }] };
      return { ok: true, value: { inputs: { count: (rec.count as number) ?? null }, orgId: (rec.orgId as string) ?? null, idempotencyKey: (rec.idempotencyKey as string) ?? null } };
    },
    ...over,
  };
}

const userAuth = { principal: { kind: 'user_session' }, scope: 'organization', orgId: ORG, user: { id: 'u' } } as unknown as AuthContext;
function session(over: Partial<FlowToolSessionView> = {}): FlowToolSessionView {
  return {
    breezeSessionId: 'sess-1', orgId: ORG, auth: userAuth, toolAuth: userAuth,
    flowTools: new Map([['flow__disk', descriptor()]]), ...over,
  };
}

beforeEach(() => {
  vi.mocked(resolveFlowToolForCall).mockReset().mockResolvedValue(descriptor());
  vi.mocked(startToolRun).mockReset().mockResolvedValue({ ok: true, runId: 'run-1', duplicate: false, runPath: '/flows/runs/run-1' });
});

describe('gateFlowToolCall', () => {
  it('flow tool resolves live at call time (session map stale, live publication newer ⇒ live tier used)', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(descriptor({ publicationId: 'p-new', publicationSeq: 3, tier: 3 }));
    const g = await gateFlowToolCall(session(), 'flow__disk', { count: 2 });
    expect(g).toMatchObject({ ok: true, descriptor: { publicationId: 'p-new', tier: 3 }, call: { inputs: { count: 2 } } });
    expect(resolveFlowToolForCall).toHaveBeenCalledWith(userAuth, 'flow__disk', ORG);
  });

  it('a flow the session never exposed is refused, even if it resolves', async () => {
    const g = await gateFlowToolCall(session({ flowTools: new Map() }), 'flow__disk', {});
    expect(g).toMatchObject({ ok: false });
    expect((g as { error: string }).error).toMatch(/flow_tool_unavailable/);
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('a flow that no longer resolves (disabled, deleted, flag off) is flow_tool_unavailable', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(null);
    expect((await gateFlowToolCall(session(), 'flow__disk', {}) as { error: string }).error).toMatch(/flow_tool_unavailable/);
  });

  it('a resolver error denies the call (fail closed)', async () => {
    vi.mocked(resolveFlowToolForCall).mockRejectedValue(new Error('db down'));
    expect(await gateFlowToolCall(session(), 'flow__disk', {})).toMatchObject({ ok: false });
  });

  it('invalid input is refused before any approval exists', async () => {
    const g = await gateFlowToolCall(session(), 'flow__disk', { bad: 1 });
    expect(g).toMatchObject({ ok: false });
    expect((g as { error: string }).error).toContain('bad');
  });

  it('Wisp-grant, helper and topology-investigation sessions never start flows', async () => {
    for (const s of [
      session({ wispGrant: { id: 'g' } }),
      session({ auth: { ...userAuth, helperDeviceId: 'd' } as AuthContext }),
      session({ topologyInvestigation: {} }),
    ]) {
      expect(await gateFlowToolCall(s, 'flow__disk', {})).toMatchObject({ ok: false });
    }
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });
});

describe('guardrail shape and RBAC', () => {
  it('tier 1 is read-only and needs automations.read; tier 2 and 3 need automations.write', () => {
    expect(guardrailCheckForFlowTool(descriptor({ tier: 1 }))).toMatchObject({ tier: 1, allowed: true, requiresApproval: false, readOnly: true });
    expect(guardrailCheckForFlowTool(descriptor({ tier: 2 }))).toMatchObject({ tier: 2, allowed: true, requiresApproval: true, readOnly: false });
    expect(guardrailCheckForFlowTool(descriptor({ tier: 3 }))).toMatchObject({ tier: 3, requiresApproval: true, approvalScope: 'supervised' });
    expect(guardrailCheckForFlowTool(descriptor()).description).toContain('Disk');
    expect(flowToolPermissionRequirement(1)).toEqual({ resource: 'automations', action: 'read' });
    expect(flowToolPermissionRequirement(2)).toEqual({ resource: 'automations', action: 'write' });
    expect(flowToolPermissionRequirement(3)).toEqual({ resource: 'automations', action: 'write' });
  });

  it('tier-3 flow tool creates a chat intent with invokedFlow (binding, coerced arguments, run org)', () => {
    const b = flowToolIntentBinding(descriptor({ tier: 3 }), { inputs: { count: 2 }, orgId: null, idempotencyKey: 'k' }, ORG);
    expect(b).toEqual({
      orgId: ORG,
      input: { inputs: { count: 2 }, orgId: ORG, idempotencyKey: 'k' },
      invokedFlow: { flowId: FLOW, publicationId: PUB, publicationSeq: 2, flowName: 'Disk' },
    });
    // A partner-wide flow runs in the named org, else the session org.
    const pw = descriptor({ partnerWide: true, owner: { orgId: null, partnerId: PARTNER } });
    expect(flowToolIntentBinding(pw, { inputs: {}, orgId: ORG_B, idempotencyKey: null }, ORG).orgId).toBe(ORG_B);
    expect(flowToolIntentBinding(pw, { inputs: {}, orgId: null, idempotencyKey: null }, ORG).orgId).toBe(ORG);
  });
});

describe('buildFlowSdkTools', () => {
  it('one [Flow] tool per descriptor, exposed under mcp__breeze__', () => {
    const tools = buildFlowSdkTools([descriptor()], () => session());
    expect(tools.map((t) => t.name)).toEqual(['flow__disk']);
    expect(tools[0]!.description.startsWith('[Flow] Flow: Disk')).toBe(true);
    expect(flowMcpToolNames([descriptor()])).toEqual(['mcp__breeze__flow__disk']);
  });

  it('tier-1 flow tool runs without approval and returns runPath (on the gated publication)', async () => {
    const gated = descriptor({ publicationId: 'p-gated', publicationSeq: 9 });
    const call = { inputs: { count: 2 }, orgId: null, idempotencyKey: null };
    const [t] = buildFlowSdkTools([descriptor()], () => session());
    // The real carry channel: the gate's context rides the call's `extra`.
    const wrapped = wrapExtraToolWithHooks(t!, async () => ({ allowed: true as const, context: { flowToolGate: { descriptor: gated, call } } }));
    const res = await wrapped.handler({ count: 2 }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ runId: 'run-1', runPath: '/flows/runs/run-1', duplicate: false });
    expect(startToolRun).toHaveBeenCalledWith(gated, { count: 2 }, 'ai_tool', { kind: 'user', auth: userAuth }, { aiSessionId: 'sess-1', defaultOrgId: ORG });
  });

  it('a handler reached without a gate context refuses and starts nothing', async () => {
    const [t] = buildFlowSdkTools([descriptor()], () => session());
    const res = await t!.handler({}, {} as never);
    expect(res.isError).toBe(true);
    expect(startToolRun).not.toHaveBeenCalled();
  });

  it('a run refusal is an error result carrying its code', async () => {
    vi.mocked(startToolRun).mockResolvedValue({ ok: false, error: 'flow_tool_changed' });
    const [t] = buildFlowSdkTools([descriptor()], () => session());
    const wrapped = wrapExtraToolWithHooks(t!, async () => ({
      allowed: true as const, context: { flowToolGate: { descriptor: descriptor(), call: { inputs: {}, orgId: null, idempotencyKey: null } } },
    }));
    const res = await wrapped.handler({}, {} as never);
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ error: 'flow_tool_changed' });
  });
});
