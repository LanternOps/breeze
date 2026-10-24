/**
 * Wisp W02 — the per-tool delegation ceiling inside `createAgentRunPreToolUse`
 * (Wisp design §4.3: "the read surface" — Tier-1 reads bypass agent
 * allowlists, so a grant run checks EVERY tool call against the ceiling).
 *
 * Harness copied from runLoop.taskFence.test.ts.
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

function makeHook(args: { grantId: string | null; outcome: AgentRunOutcome; toolAllowlist?: string[] }) {
  return createAgentRunPreToolUse({
    run: {
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full',
      taskId: null, taskStepKey: null, taskAttemptOrdinal: null,
      grantId: args.grantId, grantRevisionId: args.grantId ? 'r1' : null,
    },
    agentName: 'Wisp',
    agentAuth: { user: { id: AGENT_ID } } as unknown as AuthContext,
    agentKind: 'triage',
    guardrailPolicy: {
      enabled: true, mode: 'shadow', toolAllowlist: args.toolAllowlist ?? [],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: DEVICE_ID, deviceSiteId: SITE_ID,
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

describe('delegation ceiling in createAgentRunPreToolUse', () => {
  it('a grant run checks the ceiling for a Tier-1 read before checkAgentGuardrails (deny reason names the term)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['tickets:read']) }));
    // query_devices is allowlisted, so the guardrail alone would let this read through.
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    const result = denied(await pre('query_devices', {}));
    expect(result.error).toContain('outside the delegation ceiling (permission)');
    expect(outcome.deniedActions).toEqual([{ tool: 'query_devices', reason: 'outside the delegation ceiling (permission)' }]);
  });

  it('passes orgId = run.orgId, siteId = the device site, and every TOOL_PERMISSIONS requirement', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling());
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    await pre('query_devices', {});
    expect(grantMocks.resolveGrantCeiling).toHaveBeenCalledWith('g1', 'r1');
    expect(grantMocks.assertToolCallWithinCeiling).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'g1' }),
      { toolName: 'query_devices', orgId: ORG_ID, siteId: SITE_ID },
      [{ resource: 'devices', action: 'read' }],
    );
  });

  it('control: a read inside every ceiling term is ALLOWED (the ceiling is not a blanket deny)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set([SITE_ID]) }));
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    const result = await pre('query_devices', {});
    expect(result.allowed).toBe(true);
    expect(outcome.deniedActions).toEqual([]);
  });

  it('a site-restricted ceiling denies a device outside it (code site)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['other-site']) }));
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    expect(denied(await pre('query_devices', {})).error).toContain('(site)');
  });

  it('a tool with no human permission mapping FAILS CLOSED under a grant (even a wildcard grantor)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['*:*']) }));
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['no_such_tool_mapping'] });
    expect(denied(await pre('no_such_tool_mapping', {})).error).toBe('outside the delegation ceiling (permission)');
  });

  it('a never-delegable tool is denied with code tool', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling());
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['manage_ai_agents'] });
    expect(denied(await pre('manage_ai_agents', { action: 'list' })).error).toContain('(tool)');
  });

  it('GrantInactiveError at tool time denies with "delegation grant is no longer active" and ends "Stop and do not retry."', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'revoked'));
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    const result = denied(await pre('query_devices', {}));
    expect(result.error).toBe('delegation grant is no longer active. Stop and do not retry.');
    expect(outcome.deniedActions).toEqual([{ tool: 'query_devices', reason: 'delegation grant is no longer active' }]);
  });

  it('an inactive grant denies an OUTCOME tool too — nothing is recorded under a dead grant', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'paused'));
    const pre = makeHook({ grantId: 'g1', outcome });
    expect(denied(await pre('submit_alert_verdict', {})).error).toMatch(/no longer active/);
  });

  it('an evaluator failure fails CLOSED (denied, not allowed)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockRejectedValue(new Error('connection terminated'));
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    expect(denied(await pre('query_devices', {})).error).toMatch(/could not be verified/);
  });

  it('a run with grantId null never calls resolveGrantCeiling', async () => {
    const outcome = makeOutcome();
    const pre = makeHook({ grantId: null, outcome, toolAllowlist: ['query_devices'] });
    await pre('query_devices', {}).catch(() => undefined);
    expect(grantMocks.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(grantMocks.assertToolCallWithinCeiling).not.toHaveBeenCalled();
  });

  it('the ceiling is memoised for 15 s inside one run frame (two tool calls → one resolve), then re-resolved', async () => {
    vi.useFakeTimers({ now: new Date('2027-01-05T00:00:00Z') });
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling());
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    await pre('query_devices', {});
    await pre('query_devices', {});
    expect(grantMocks.resolveGrantCeiling).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2027-01-05T00:00:16Z'));
    await pre('query_devices', {});
    expect(grantMocks.resolveGrantCeiling).toHaveBeenCalledTimes(2);
  });

  it('an inactive result is never memoised (a resumed grant is seen on the next call)', async () => {
    const outcome = makeOutcome();
    grantMocks.resolveGrantCeiling
      .mockRejectedValueOnce(new GrantInactiveError('g1', 'paused'))
      .mockResolvedValueOnce(ceiling());
    const pre = makeHook({ grantId: 'g1', outcome, toolAllowlist: ['query_devices'] });
    expect((await pre('query_devices', {})).allowed).toBe(false);
    await pre('query_devices', {});
    expect(grantMocks.resolveGrantCeiling).toHaveBeenCalledTimes(2);
  });
});
