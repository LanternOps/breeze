import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C2 — starting a flow as a tool. The reads are a queue
 * fake; createFlowRun is mocked (its tool branch is runService.test.ts) so the
 * assertions are on what startToolRun authorizes and passes.
 */

const { selects } = vi.hoisted(() => ({ selects: [] as unknown[] }));

vi.mock('../../db', () => {
  function chain() {
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = selects.shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  };
});
vi.mock('../../config/env', async (orig) => ({ ...(await orig<typeof import('../../config/env')>()), flowsEnabled: vi.fn(() => true) }));
vi.mock('../permissions', async (orig) => ({ ...(await orig<typeof import('../permissions')>()), getUserPermissions: vi.fn() }));
vi.mock('./runService', async (orig) => ({ ...(await orig<typeof import('./runService')>()), createFlowRun: vi.fn() }));
vi.mock('./triggererAccess', async (orig) => ({ ...(await orig<typeof import('./triggererAccess')>()), clampToCallerCredential: vi.fn() }));
vi.mock('./flowTools', async (orig) => ({ ...(await orig<typeof import('./flowTools')>()), flowInvocationTier: vi.fn() }));

import { getUserPermissions, type UserPermissions } from '../permissions';
import { createFlowRun } from './runService';
import { clampToCallerCredential } from './triggererAccess';
import { flowInvocationTier, type FlowToolDescriptor } from './flowTools';
import { startToolRun } from './toolRuns';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-222222222222';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const PUB = '77777777-7777-4777-8777-777777777777';
const USER = '44444444-4444-4444-8444-444444444444';
const AGENT_RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '66666666-6666-4666-8666-666666666666';
const SCRIPT = '55555555-5555-4555-8555-555555555555';

const STEP_DEFAULTS = { approval: 'default', onFailure: 'stop', timeoutSec: 300 } as const;
const DOC = {
  version: 1, name: 'Disk', trigger: { type: 'manual' }, inputs: [{ name: 'count', type: 'number', required: false }],
  steps: [{ id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: [DEVICE] }, ...STEP_DEFAULTS }],
};
const PINS = [{ stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' }];

function descriptor(over: Partial<FlowToolDescriptor> = {}): FlowToolDescriptor {
  return {
    name: 'flow__disk', flowId: FLOW, flowName: 'Disk', publicationId: PUB, publicationSeq: 2,
    owner: { orgId: ORG, partnerId: PARTNER }, partnerWide: false, tier: 1, revision: `flowpub:${PUB}`,
    definition: { name: 'flow__disk', description: 'Flow: Disk', input_schema: { type: 'object' } },
    validate: (input: unknown) => {
      const rec = (input ?? {}) as Record<string, unknown>;
      if (rec.bad) return { ok: false, message: 'bad: Unknown input', issues: [{ name: 'bad', message: 'Unknown input' }] };
      return { ok: true, value: { inputs: { count: (rec.count as number) ?? null }, orgId: (rec.orgId as string) ?? null, idempotencyKey: (rec.idempotencyKey as string) ?? null } };
    },
    ...over,
  };
}

function userAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' }, scope: 'organization', orgId: ORG, partnerId: PARTNER,
    canAccessOrg: (id: string) => id === ORG, user: { id: USER }, ...over,
  } as unknown as AuthContext;
}
const keyAuth = () => userAuth({ principal: { kind: 'api_key', apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } } as Partial<AuthContext>);

function perms(over: Partial<UserPermissions> = {}): UserPermissions {
  return { permissions: [{ resource: '*', action: '*' }], partnerId: PARTNER, orgId: ORG, roleId: 'r', scope: 'organization', ...over };
}

/** The live flow, its live publication, the run org's partner. */
function queueLive(opts: { flow?: Record<string, unknown>; pub?: Record<string, unknown> | null; orgPartner?: string | null } = {}) {
  selects.push(
    [{ id: FLOW, orgId: ORG, partnerId: null, status: 'enabled', enabledPublicationSeq: 2, ...opts.flow }],
    opts.pub === null ? [] : [{ id: PUB, definition: DOC, stepPins: PINS, ...opts.pub }],
    opts.orgPartner === null ? [] : [{ partnerId: opts.orgPartner ?? PARTNER }],
  );
}

beforeEach(() => {
  selects.length = 0;
  vi.mocked(getUserPermissions).mockReset().mockResolvedValue(perms());
  vi.mocked(createFlowRun).mockReset().mockResolvedValue({ created: true, runId: 'run-1', preApprovalsHonored: false });
  vi.mocked(clampToCallerCredential).mockReset().mockImplementation(async (_a, p) => p);
  // The live tier at start equals the descriptor's unless a test says otherwise.
  vi.mocked(flowInvocationTier).mockReset().mockImplementation(async () => 1);
});

const lastCreate = () => vi.mocked(createFlowRun).mock.calls.at(-1)![0] as unknown as Record<string, unknown>;

describe('startToolRun — human triggerers', () => {
  it('a chat user runs a flow: tool kind, ai_tool lane, the resolved publication pinned, session recorded', async () => {
    queueLive();
    const r = await startToolRun(descriptor(), { count: 3, idempotencyKey: 'k1' }, 'ai_tool', { kind: 'user', auth: userAuth() }, { aiSessionId: 'sess-1' });
    expect(r).toEqual({ ok: true, runId: 'run-1', duplicate: false, runPath: '/flows/runs/run-1' });
    expect(lastCreate()).toMatchObject({
      triggerKind: 'tool', triggeredVia: 'ai_tool', triggeredByUserId: USER, triggeredByApiKeyId: null, parentAgentRunId: null,
      aiSessionId: 'sess-1', expectedPublicationSeq: 2, flowId: FLOW, orgId: ORG, inputs: { count: 3 },
    });
    expect(lastCreate().dedupeKey).toBe(`tool:ai_tool:${USER}:k1`);
  });

  it('chat user lacking scripts.execute is permission_missing', async () => {
    queueLive();
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'automations', action: 'read' }, { resource: 'automations', action: 'write' }] }));
    const r = await startToolRun(descriptor({ tier: 3 }), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {});
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    expect((r as { missing: Array<{ permission: string }> }).missing.map((m) => m.permission)).toContain('scripts.execute');
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('a tier-1 flow needs automations.read and a tier ≥ 2 flow automations.write of the triggerer', async () => {
    const readDoc = { ...DOC, steps: [{ id: 'read', tool: 'get_device_details', input: { deviceId: DEVICE }, ...STEP_DEFAULTS }] };
    const readPins = [{ stepId: 'read', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null }];
    queueLive({ pub: { stepPins: readPins, definition: readDoc } });
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'devices', action: 'read' }] }));
    const r1 = await startToolRun(descriptor({ tier: 1 }), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {});
    expect(r1).toMatchObject({ ok: false, error: 'permission_missing', missing: [{ stepId: '*', permission: 'automations.read' }] });
    queueLive({ pub: { stepPins: readPins, definition: readDoc } });
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'devices', action: 'read' }, { resource: 'automations', action: 'read' }] }));
    const r2 = await startToolRun(descriptor({ tier: 2 }), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {});
    expect(r2).toMatchObject({ ok: false, error: 'permission_missing', missing: [{ stepId: '*', permission: 'automations.write' }] });
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('site-limited user is delegation_scope_restricted', async () => {
    queueLive();
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: ['s1'] }));
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
    queueLive();
    vi.mocked(getUserPermissions).mockResolvedValue(perms());
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth({ allowedSiteIds: [] } as Partial<AuthContext>) }, {}))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
  });

  it('an exact-device ceiling on the caller is delegation_scope_restricted', async () => {
    queueLive();
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth({ allowedDeviceIds: [DEVICE] } as Partial<AuthContext>) }, {}))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
  });

  it('api key clamp applies', async () => {
    queueLive();
    vi.mocked(clampToCallerCredential).mockResolvedValue(perms({ permissions: [{ resource: 'automations', action: 'read' }] }));
    const r = await startToolRun(descriptor({ tier: 3 }), {}, 'mcp', { kind: 'api_key', auth: keyAuth() }, {});
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    queueLive();
    vi.mocked(clampToCallerCredential).mockResolvedValue(null);
    expect(await startToolRun(descriptor({ tier: 1 }), {}, 'mcp', { kind: 'api_key', auth: keyAuth() }, {}))
      .toMatchObject({ ok: false, error: 'permission_missing' });
  });

  it('an MCP run records the API key and is via mcp', async () => {
    queueLive();
    await startToolRun(descriptor(), {}, 'mcp', { kind: 'api_key', auth: keyAuth() }, {});
    expect(lastCreate()).toMatchObject({ triggeredVia: 'mcp', triggeredByApiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', triggeredByUserId: USER, aiSessionId: null });
  });

  it('a chat lane needs an interactive user session', async () => {
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: keyAuth() }, {}))
      .toEqual({ ok: false, error: 'interactive_user_required' });
    expect(await startToolRun(descriptor(), {}, 'mcp', { kind: 'api_key', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'interactive_user_required' });
    expect(selects).toHaveLength(0);
  });
});

describe('startToolRun — publication binding', () => {
  it('changed publication is flow_tool_changed', async () => {
    queueLive({ pub: { id: 'another-publication' } });
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'flow_tool_changed' });
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('re-publish between resolve and insert is flow_tool_changed', async () => {
    queueLive();
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'not_enabled' });
    // The re-read after the refusal: the flow is live on another publication.
    selects.push([{ status: 'enabled', enabledPublicationSeq: 3 }]);
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'flow_tool_changed' });
    expect(lastCreate().expectedPublicationSeq).toBe(2);
  });

  it('a refusal at insert for a flow that was disabled, or is still on the same publication, is not_enabled (not a retry signal)', async () => {
    queueLive();
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'not_enabled' });
    selects.push([{ status: 'disabled', enabledPublicationSeq: null }]);
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'not_enabled' });
    selects.length = 0;
    queueLive();
    selects.push([{ status: 'enabled', enabledPublicationSeq: 2 }]);
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'not_enabled' });
  });

  it('a tier that rose since the gate (same publication, e.g. a tenant tool reclassified) is flow_tool_changed', async () => {
    queueLive();
    vi.mocked(flowInvocationTier).mockResolvedValue(3);
    expect(await startToolRun(descriptor({ tier: 2 }), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'flow_tool_changed' });
    expect(createFlowRun).not.toHaveBeenCalled();
    // A tier at or below the gated one proceeds.
    selects.length = 0;
    queueLive();
    vi.mocked(flowInvocationTier).mockResolvedValue(2);
    vi.mocked(getUserPermissions).mockResolvedValue(perms());
    expect(await startToolRun(descriptor({ tier: 2 }), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toMatchObject({ ok: true });
  });

  it('a flow disabled since resolution is not_enabled', async () => {
    queueLive({ flow: { status: 'disabled', enabledPublicationSeq: null } });
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'not_enabled' });
  });

  it('inputs that fail the declarations are inputs_invalid', async () => {
    queueLive();
    expect(await startToolRun(descriptor(), { bad: 1 }, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toMatchObject({ ok: false, error: 'inputs_invalid', issues: [{ name: 'bad' }] });
  });

  it('tool run never honours pre-approvals (none is asked for)', async () => {
    queueLive();
    await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {});
    expect(lastCreate()).not.toHaveProperty('triggererCleared');
    expect(lastCreate().triggerKind).toBe('tool');
  });

  it('same idempotencyKey returns the first run', async () => {
    queueLive();
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'duplicate', runId: 'run-0', preApprovalsHonored: false });
    expect(await startToolRun(descriptor(), { idempotencyKey: 'k1' }, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: true, runId: 'run-0', duplicate: true, runPath: '/flows/runs/run-0' });
  });

  it('an admission refusal is returned as is', async () => {
    queueLive();
    vi.mocked(createFlowRun).mockResolvedValue({ created: false, reason: 'flow_monthly_cap_reached' });
    expect(await startToolRun(descriptor(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'flow_monthly_cap_reached' });
  });
});

describe('startToolRun — run org', () => {
  const partnerWide = () => descriptor({ partnerWide: true, owner: { orgId: null, partnerId: PARTNER } });
  const partnerAuth = () => userAuth({ scope: 'partner', orgId: null, canAccessOrg: (id: string) => id === ORG || id === ORG_B } as Partial<AuthContext>);

  it('partner-wide flow from a partner caller without orgId is org_required', async () => {
    queueLive({ flow: { orgId: null, partnerId: PARTNER } });
    expect(await startToolRun(partnerWide(), {}, 'ai_tool', { kind: 'user', auth: partnerAuth() }, {}))
      .toEqual({ ok: false, error: 'org_required' });
  });

  it('partner-wide flow runs in the session org by default, or the orgId argument', async () => {
    queueLive({ flow: { orgId: null, partnerId: PARTNER } });
    await startToolRun(partnerWide(), {}, 'ai_tool', { kind: 'user', auth: partnerAuth() }, { defaultOrgId: ORG });
    expect(lastCreate().orgId).toBe(ORG);
    queueLive({ flow: { orgId: null, partnerId: PARTNER } });
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ orgId: ORG_B }));
    expect(await startToolRun(partnerWide(), { orgId: ORG_B }, 'ai_tool', { kind: 'user', auth: partnerAuth() }, { defaultOrgId: ORG }))
      .toMatchObject({ ok: true });
    expect(lastCreate().orgId).toBe(ORG_B);
  });

  it('partner-wide flow in an org of another partner is org_forbidden', async () => {
    queueLive({ flow: { orgId: null, partnerId: PARTNER }, orgPartner: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect(await startToolRun(partnerWide(), { orgId: ORG_B }, 'ai_tool', { kind: 'user', auth: partnerAuth() }, {}))
      .toEqual({ ok: false, error: 'org_forbidden' });
  });

  it('an org the caller cannot reach is org_forbidden', async () => {
    queueLive({ flow: { orgId: null, partnerId: PARTNER } });
    expect(await startToolRun(partnerWide(), {}, 'ai_tool', { kind: 'user', auth: userAuth() }, { defaultOrgId: ORG_B }))
      .toEqual({ ok: false, error: 'org_forbidden' });
  });

  it('an org flow named for another org is org_forbidden', async () => {
    queueLive();
    expect(await startToolRun(descriptor(), { orgId: ORG_B }, 'ai_tool', { kind: 'user', auth: userAuth() }, {}))
      .toEqual({ ok: false, error: 'org_forbidden' });
  });
});

describe('startToolRun — agents', () => {
  const agent = (orgId = ORG) => ({ kind: 'agent_tier1' as const, agentRunId: AGENT_RUN, orgId });

  it('agent tier-1 run needs no user', async () => {
    queueLive();
    const r = await startToolRun(descriptor({ tier: 1 }), {}, 'ai_agent', agent(), { parentAgentRunId: AGENT_RUN });
    expect(r).toMatchObject({ ok: true, runId: 'run-1' });
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(lastCreate()).toMatchObject({ triggeredVia: 'ai_agent', triggeredByUserId: null, parentAgentRunId: AGENT_RUN, aiSessionId: null, orgId: ORG });
    expect(String(lastCreate().dedupeKey)).toMatch(new RegExp(`^tool:ai_agent:${AGENT_RUN}:`));
  });

  it('agent_tier1 on a tier-2 flow is refused', async () => {
    expect(await startToolRun(descriptor({ tier: 2 }), {}, 'ai_agent', agent(), { parentAgentRunId: AGENT_RUN }))
      .toEqual({ ok: false, error: 'flow_not_allowed_for_agent' });
    expect(createFlowRun).not.toHaveBeenCalled();
  });

  it('an agent runs only in its own org', async () => {
    queueLive();
    expect(await startToolRun(descriptor({ tier: 1 }), {}, 'ai_agent', agent(ORG_B), { parentAgentRunId: AGENT_RUN }))
      .toEqual({ ok: false, error: 'org_forbidden' });
    selects.length = 0;
    queueLive({ flow: { orgId: null, partnerId: PARTNER } });
    await startToolRun(descriptor({ tier: 1, partnerWide: true, owner: { orgId: null, partnerId: PARTNER } }), {}, 'ai_agent', agent(ORG_B), { parentAgentRunId: AGENT_RUN });
    expect(lastCreate().orgId).toBe(ORG_B);
  });

  it('lane and triggerer must agree (caller bug)', async () => {
    await expect(startToolRun(descriptor(), {}, 'ai_agent', { kind: 'user', auth: userAuth() }, {})).rejects.toThrow();
    await expect(startToolRun(descriptor(), {}, 'ai_tool', agent(), { parentAgentRunId: AGENT_RUN })).rejects.toThrow();
    await expect(startToolRun(descriptor(), {}, 'ai_agent', agent(), { parentAgentRunId: 'other' })).rejects.toThrow();
  });
});
