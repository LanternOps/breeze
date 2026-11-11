/**
 * (#10428) act mode + standing instructions. Harness copied from runLoop.troubleshoot.test.ts.
 * Wisp delegation W1 (#11084) — the device_troubleshooting run inside
 * `createAgentRunPreToolUse`: one progress step per allowed call (labels from a
 * fixed map, never from tool input/output), Tier-2 AND Tier-3 proposals mint
 * supervised intents, the device pin, the per-run approval cap, and a paused
 * grant. Harness copied from runLoop.grantCeiling.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { AgentRunOutcome } from './runLoopTypes';

const ORG_ID = '00000000-0000-4000-8000-00000000f101';
const AGENT_ID = '00000000-0000-4000-8000-00000000f102';
const RUN_ID = '00000000-0000-4000-8000-00000000f103';
const DEVICE_ID = '00000000-0000-4000-8000-00000000f105';
const OTHER_DEVICE_ID = '00000000-0000-4000-8000-00000000f1ff';
const SITE_ID = '00000000-0000-4000-8000-00000000f106';

vi.mock('../fixMemory/runMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fixMemory/runMemory')>()),
  loadProvenFixesForRun: vi.fn(async () => null),
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

const grantMocks = vi.hoisted(() => ({ resolveGrantCeiling: vi.fn() }));
vi.mock('../wisp/grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wisp/grantAuthority')>();
  return { ...actual, resolveGrantCeiling: grantMocks.resolveGrantCeiling };
});

const intentMocks = vi.hoisted(() => ({ createActionIntent: vi.fn() }));
vi.mock('../actionIntents/intentService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actionIntents/intentService')>()),
  createActionIntent: intentMocks.createActionIntent,
}));

const gateMocks = vi.hoisted(() => ({ evaluateStandingInstructions: vi.fn() }));
vi.mock('../wisp/standingInstructionGate', () => ({
  evaluateStandingInstructions: gateMocks.evaluateStandingInstructions,
  standingConflictDescription: (text: string, description: string) => `Conflicts with a remembered instruction: '${text}'. ${description}`,
  STANDING_CHECK_UNAVAILABLE_MESSAGE: "Couldn't check remembered instructions; try again.",
}));

const progressMocks = vi.hoisted(() => ({ emitRunProgress: vi.fn(async () => undefined) }));
vi.mock('./runProgress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runProgress')>()),
  emitRunProgress: progressMocks.emitRunProgress,
}));

const actMocks = vi.hoisted(() => ({ revalidateActExecution: vi.fn() }));
vi.mock('./actRevalidation', () => ({ revalidateActExecution: actMocks.revalidateActExecution }));

import { createAgentRunCallPairing, createAgentRunPreToolUse, PROPOSAL_RECORDED_TEXT } from './runLoop';
import type { GrantCeiling } from '../wisp/grantAuthority';

function makeOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

function ceiling(): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: 'p1', grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  };
}

function makeActHook(outcome: AgentRunOutcome, intentIds: string[]) {
  return createAgentRunPreToolUse({
    run: {
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full',
      taskId: null, taskStepKey: null, taskAttemptOrdinal: null,
      grantId: 'g1', grantRevisionId: 'r1',
    },
    agentName: 'Triage agent',
    agentAuth: { user: { id: AGENT_ID } } as unknown as AuthContext,
    agentKind: 'triage',
    guardrailPolicy: {
      enabled: true, mode: 'act', toolAllowlist: ['manage_services'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: DEVICE_ID, deviceSiteId: SITE_ID,
    } as never,
    outcome, intentIds, sessionId: null,
    pairing: createAgentRunCallPairing(),
    actReservation: { count: 0 },
    runTargets: [],
    stagedBytesRemaining: 256 * 1024 * 1024,
    deadlineMs: Date.now() + 600_000,
  });
}

const ACT_INPUT = { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' };

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  grantMocks.resolveGrantCeiling.mockReset().mockResolvedValue(ceiling());
  gateMocks.evaluateStandingInstructions.mockReset().mockResolvedValue({ action: 'none' });
  actMocks.revalidateActExecution.mockReset().mockImplementation(async (args: Record<string, unknown>) => ({
    ok: true, pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
  }));
  intentMocks.createActionIntent.mockReset().mockImplementation(async () => ({
    id: 'intent-1', status: 'pending_approval', errorCode: null,
  }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('act mode + standing instructions (#10428)', () => {
  it('control: no standing match -> the act-mode restart executes (allowed, no intent)', async () => {
    const outcome = makeOutcome();
    const pre = makeActHook(outcome, []);
    const result = await pre('manage_services', ACT_INPUT);
    expect(result).toMatchObject({ allowed: true });
    expect(actMocks.revalidateActExecution).toHaveBeenCalledTimes(1);
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
    expect(outcome.proposedActions).toEqual([]);
  });

  it('a standing-instruction warn downgrades the act-mode call to a proposal with the prefixed reason', async () => {
    gateMocks.evaluateStandingInstructions.mockResolvedValue({ action: 'warn', text: 'leave the spooler alone', matches: [] });
    const outcome = makeOutcome();
    const intentIds: string[] = [];
    const pre = makeActHook(outcome, intentIds);
    const result = await pre('manage_services', ACT_INPUT);

    expect(result).toMatchObject({ allowed: false });
    expect(result).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });
    expect(actMocks.revalidateActExecution).not.toHaveBeenCalled();
    expect(intentMocks.createActionIntent).toHaveBeenCalledTimes(1);
    expect(intentMocks.createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'manage_services',
      reason: `Conflicts with a remembered instruction: 'leave the spooler alone'. Proposed by Triage agent for run ${RUN_ID}`,
    }));
    expect(outcome.proposedActions).toEqual([expect.objectContaining({
      tool: 'manage_services', downgradeReason: expect.any(String), intentId: 'intent-1',
    })]);
    expect(outcome.executedActions).toEqual([]);
  });
});
