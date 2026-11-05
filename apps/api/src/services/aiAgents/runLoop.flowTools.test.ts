/**
 * W5 PR C (#5220), Task C5 — flow tools inside `createAgentRunPreToolUse`:
 * an unrestricted run may start an allowlisted Tier-1 flow; a ceiling-bound
 * run, a Tier ≥ 2 flow or a flow outside the allowlist is denied, never a
 * proposal. Harness copied from runLoop.grantCeiling.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { AgentRunOutcome } from './runLoopTypes';

const ORG_ID = '00000000-0000-4000-8000-00000000f101';
const AGENT_ID = '00000000-0000-4000-8000-00000000f102';
const RUN_ID = '00000000-0000-4000-8000-00000000f103';
const DEVICE_ID = '00000000-0000-4000-8000-00000000f105';
const SITE_ID = '00000000-0000-4000-8000-00000000f106';

const loadProvenFixesForRun = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('../fixMemory/runMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fixMemory/runMemory')>()),
  loadProvenFixesForRun,
}));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    },
    withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
    runOutsideDbContext: async (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  };
});

vi.mock('../permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => null) };
});

const grantMocks = vi.hoisted(() => ({ resolveGrantCeiling: vi.fn(), assertWithinCeiling: vi.fn(), assertToolCallWithinCeiling: vi.fn() }));
vi.mock('../wisp/grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wisp/grantAuthority')>();
  grantMocks.assertWithinCeiling.mockImplementation(actual.assertWithinCeiling);
  grantMocks.assertToolCallWithinCeiling.mockImplementation(actual.assertToolCallWithinCeiling);
  return { ...actual, resolveGrantCeiling: grantMocks.resolveGrantCeiling, assertWithinCeiling: grantMocks.assertWithinCeiling, assertToolCallWithinCeiling: grantMocks.assertToolCallWithinCeiling };
});

const flowMocks = vi.hoisted(() => ({ resolveFlowToolForCall: vi.fn() }));
vi.mock('../flows/flowTools', () => ({ resolveFlowToolForCall: (...a: unknown[]) => flowMocks.resolveFlowToolForCall(...a) }));
vi.mock('../../config/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../config/env')>()), flowsEnabled: () => true }));

import { createAgentRunCallPairing, createAgentRunPreToolUse } from './runLoop';
import { GrantInactiveError, type GrantCeiling } from '../wisp/grantAuthority';

function makeOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: 'p1', grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['devices:read']), toolAllowlist: null,
    deniedTools: new Set(['manage_ai_agents']), orgTerms: new Map(), status: 'active', ...o,
  };
}

function makeHook(args: { grantId: string | null; outcome: AgentRunOutcome; toolAllowlist?: string[]; agentAuth?: AuthContext; deviceId?: string | null; mode?: string }) {
  return createAgentRunPreToolUse({
    run: {
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full',
      taskId: null, taskStepKey: null, taskAttemptOrdinal: null,
      grantId: args.grantId, grantRevisionId: args.grantId ? 'r1' : null,
    },
    agentName: 'Wisp',
    agentAuth: args.agentAuth ?? ({ user: { id: AGENT_ID }, scope: 'organization', orgId: ORG_ID } as unknown as AuthContext),
    agentKind: 'triage',
    guardrailPolicy: {
      enabled: true, mode: args.mode ?? 'shadow', toolAllowlist: args.toolAllowlist ?? [],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: args.deviceId === undefined ? null : args.deviceId, deviceSiteId: args.deviceId ? SITE_ID : null,
    } as never,
    outcome: args.outcome,
    intentIds: [],
    sessionId: null,
    pairing: createAgentRunCallPairing(),
    actReservation: { count: 0 },
    runTargets: [],
    stagedBytesRemaining: 256 * 1024 * 1024,
    deadlineMs: Date.now() + 600_000,
  });
}

function denied(result: Awaited<ReturnType<ReturnType<typeof createAgentRunPreToolUse>>>): { allowed: false; error: string } {
  if (result.allowed) throw new Error('expected the pre-tool hook to DENY the call, but it allowed it');
  return result;
}

beforeEach(() => {
  grantMocks.resolveGrantCeiling.mockReset();
  grantMocks.assertWithinCeiling.mockClear();
  grantMocks.assertToolCallWithinCeiling.mockClear();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
});


function flowTool(name: string, tier: 1 | 2 | 3) {
  return {
    name, flowId: `f-${name}`, flowName: name, publicationId: `p-${name}`, publicationSeq: 1,
    owner: { orgId: ORG_ID, partnerId: 'p' }, partnerWide: false, tier, revision: `flowpub:p-${name}`,
    definition: { name, description: `Flow: ${name}`, input_schema: { type: 'object', properties: {} } },
    validate: () => ({ ok: true, value: { inputs: {}, orgId: null, idempotencyKey: null } }),
  };
}

describe('flow tools in createAgentRunPreToolUse (W5 PR C)', () => {
  beforeEach(() => {
    flowMocks.resolveFlowToolForCall.mockReset().mockImplementation(async (_a: unknown, name: string) => (
      name === 'flow__report' ? flowTool('flow__report', 1) : name === 'flow__fixit' ? flowTool('flow__fixit', 2) : null
    ));
  });

  it('allowlisted tier-1 flow runs from an unrestricted agent run, with the gate context for the handler', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['flow__report'] });
    const result = await pre('flow__report', {});
    expect(result.allowed).toBe(true);
    expect((result as { context?: { flowToolGate?: { descriptor: { name: string } } } }).context?.flowToolGate?.descriptor.name).toBe('flow__report');
    expect(outcome.deniedActions).toEqual([]);
    expect(outcome.proposedActions).toEqual([]);
  });

  it('device-bound agent cannot call a tier-1 flow', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['flow__report'], deviceId: DEVICE_ID,
      agentAuth: { user: { id: AGENT_ID }, scope: 'organization', orgId: ORG_ID, allowedDeviceIds: [DEVICE_ID], allowedSiteIds: [SITE_ID] } as unknown as AuthContext });
    expect(denied(await pre('flow__report', {})).error).toMatch(/flow_not_allowed_for_agent/);
    expect(flowMocks.resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('site-ceiling agent run is refused', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['flow__report'],
      agentAuth: { user: { id: AGENT_ID }, scope: 'organization', orgId: ORG_ID, allowedSiteIds: [SITE_ID] } as unknown as AuthContext });
    expect(denied(await pre('flow__report', {})).error).toMatch(/flow_not_allowed_for_agent/);
  });

  it('tier-2 flow is refused for agents (not a proposal; no intent row written)', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['flow__fixit'], mode: 'act' });
    expect(denied(await pre('flow__fixit', {})).error).toMatch(/flow_not_allowed_for_agent/);
    expect(outcome.proposedActions).toEqual([]);
    expect(outcome.deniedActions).toHaveLength(1);
  });

  it('tier-1 flow not in the allowlist is denied', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['query_devices'] });
    expect(denied(await pre('flow__report', {})).error).toMatch(/allowlist/);
  });

  it('mode off denies a flow tool', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['flow__report'], mode: 'off' });
    expect(denied(await pre('flow__report', {})).error).toMatch(/off/i);
  });

  it('a delegation-grant run is refused before the ceiling or the flow is read', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue({
      grantId: 'g1', revisionId: 'r1', partnerId: 'p1', grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
      orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['automations:read']), toolAllowlist: null,
      deniedTools: new Set(), orgTerms: new Map(), status: 'active',
    });
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['flow__report'] });
    expect(denied(await pre('flow__report', {})).error).toMatch(/flow_not_allowed_for_agent/);
    expect(flowMocks.resolveFlowToolForCall).not.toHaveBeenCalled();
  });
});
