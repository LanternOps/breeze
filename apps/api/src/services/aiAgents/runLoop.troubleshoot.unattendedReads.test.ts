/**
 * #10973 / Wisp delegation W3 — the unattended-reads switch inside a
 * device_troubleshooting run (plan Decision 9, Review Focus 3). The hook may turn
 * a `propose` into an `allow` only for the four reads, only on this profile, and
 * only on a FRESH read of the switch; a deny is never converted. Harness copied
 * from runLoop.troubleshoot.test.ts.
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

vi.mock('./runProgress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runProgress')>()),
  emitRunProgress: vi.fn(async () => undefined),
}));

const ledgerMocks = vi.hoisted(() => ({ startToolExecution: vi.fn() }));
vi.mock('./executionLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./executionLedger')>()),
  startToolExecution: ledgerMocks.startToolExecution,
}));

const toolMocks = vi.hoisted(() => ({ executeTool: vi.fn(async () => JSON.stringify({ ok: true })) }));
vi.mock('../aiTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeTool: toolMocks.executeTool,
}));

import { __test__ as sdkTools } from '../aiAgentSdkTools';
import { GrantInactiveError, type GrantCeiling } from '../wisp/grantAuthority';
import { createAgentRunCallPairing, createAgentRunPreToolUse } from './runLoop';
import { troubleshootToolAllowlist } from './troubleshootProfile';

function makeOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: 'p1', grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active', unattendedReads: true, ...o,
  };
}

function makeHook(args: {
  outcome: AgentRunOutcome;
  profile?: 'device_troubleshooting' | 'full';
  grantId?: string | null;
  registryKeys?: string[];
  sessionId?: string | null;
}) {
  const profile = args.profile ?? 'device_troubleshooting';
  const grantId = args.grantId === undefined ? 'g1' : args.grantId;
  return createAgentRunPreToolUse({
    run: {
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile,
      taskId: null, taskStepKey: null, taskAttemptOrdinal: null,
      grantId, grantRevisionId: grantId ? 'r1' : null,
    },
    agentName: 'Device troubleshooting (built-in)',
    agentAuth: { user: { id: AGENT_ID } } as unknown as AuthContext,
    agentKind: profile === 'full' ? 'triage' : 'troubleshoot',
    guardrailPolicy: {
      enabled: true, mode: 'shadow', toolAllowlist: troubleshootToolAllowlist([]),
      protectedResources: { services: [], paths: [], registryKeys: args.registryKeys ?? [], deviceTags: [] },
      deviceId: DEVICE_ID, deviceSiteId: SITE_ID,
    } as never,
    outcome: args.outcome,
    intentIds: [],
    sessionId: args.sessionId === undefined ? 'session-1' : args.sessionId,
    pairing: createAgentRunCallPairing(),
    actReservation: { count: 0 },
    runTargets: [],
    stagedBytesRemaining: 256 * 1024 * 1024,
    deadlineMs: Date.now() + 600_000,
  });
}

const REGISTRY = { action: 'get_value', deviceId: DEVICE_ID, keyPath: 'HKLM\\SOFTWARE\\Vendor', valueName: 'Path' };
const SECURITY = {
  deviceId: DEVICE_ID,
  commandType: 'event_logs_query',
  payload: { logName: 'Security', query: '*[System[EventID=4625]]' },
};
const NOTE = { deviceId: DEVICE_ID, contextType: 'issue', summary: 'Disk is failing' };

let intentSeq = 0;
beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  grantMocks.resolveGrantCeiling.mockReset().mockResolvedValue(ceiling());
  ledgerMocks.startToolExecution.mockReset().mockResolvedValue('exec-1');
  toolMocks.executeTool.mockClear();
  intentSeq = 0;
  intentMocks.createActionIntent.mockReset().mockImplementation(async () => ({
    id: `intent-${++intentSeq}`, status: 'pending_approval', errorCode: null,
  }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('device_troubleshooting run, switch on', () => {
  it.each([
    ['registry get_value', 'registry_operations', REGISTRY, 'registry_read'],
    ['registry read_key', 'registry_operations', { action: 'read_key', deviceId: DEVICE_ID, keyPath: 'HKLM\\SOFTWARE' }, 'registry_read'],
    ['Security query', 'execute_command', SECURITY, 'security_event_query'],
    ['device note', 'set_device_context', NOTE, 'device_context'],
  ])('%s executes, mints no intent, and dispatches the pinned call', async (_label, tool, input, kind) => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome })(tool, input as Record<string, unknown>, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: true });
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
    expect(outcome.proposedActions).toEqual([]);
    const context = (result as { context?: { pinnedWispUnattendedRead?: { kind: string; pinned: unknown } } }).context;
    expect(context?.pinnedWispUnattendedRead?.kind).toBe(kind);
    expect(context?.pinnedWispUnattendedRead?.pinned).toEqual(input);
  });

  it('through the real SDK handler, the tool runs on the classified copy, not the model\'s object', async () => {
    const hook = makeHook({ outcome: makeOutcome() });
    const auth = { scope: 'organization', orgId: ORG_ID, accessibleOrgIds: [ORG_ID], partnerId: 'p1', user: { id: AGENT_ID } } as unknown as AuthContext;
    const handler = sdkTools.makeHandler('registry_operations', () => auth, hook);
    const input = { ...REGISTRY };
    await handler(input);
    expect(toolMocks.executeTool).toHaveBeenCalledTimes(1);
    const dispatched = (toolMocks.executeTool.mock.calls[0] as unknown as unknown[])[1];
    expect(dispatched).toEqual(REGISTRY);
    expect(dispatched).not.toBe(input);
  });

  it('writes its ledger row, and the row is what lets it run', async () => {
    await makeHook({ outcome: makeOutcome() })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(ledgerMocks.startToolExecution).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', toolName: 'registry_operations' }));
  });

  it('a failed ledger write asks instead of running with no record', async () => {
    ledgerMocks.startToolExecution.mockRejectedValue(new Error('connection lost'));
    const outcome = makeOutcome();
    const result = await makeHook({ outcome })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
  });

  it('a run with no session has nowhere to record it, so it asks', async () => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome, sessionId: null })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
    expect(ledgerMocks.startToolExecution).not.toHaveBeenCalled();
  });

  it('turned off between two calls inside the 15 s memo: the second call proposes', async () => {
    const outcome = makeOutcome();
    const hook = makeHook({ outcome });
    expect(await hook('registry_operations', REGISTRY, undefined, 'tu-1')).toMatchObject({ allowed: true });
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();

    // The memo still holds the "on" ceiling; only a fresh read can see the change.
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ unattendedReads: false }));
    const second = await hook('registry_operations', REGISTRY, undefined, 'tu-2');
    expect(second).toMatchObject({ allowed: false });
    expect(intentMocks.createActionIntent).toHaveBeenCalledTimes(1);
    expect(outcome.proposedActions).toHaveLength(1);
  });

  it('the grant paused between two calls inside the memo: denied, nothing runs and nothing is minted', async () => {
    const outcome = makeOutcome();
    const hook = makeHook({ outcome });
    await hook('registry_operations', REGISTRY, undefined, 'tu-1');
    grantMocks.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'paused'));
    const second = await hook('registry_operations', REGISTRY, undefined, 'tu-2');
    expect(second).toMatchObject({ allowed: false });
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
    expect(outcome.deniedActions).toHaveLength(1);
  });

  it('a read of another device is denied by the pin, whatever the switch says', async () => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome })('registry_operations', { ...REGISTRY, deviceId: OTHER_DEVICE_ID }, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.deniedActions[0]?.reason).toMatch(/pinned to its device/);
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
  });

  it('a protected registry key stays a deny (a deny is never converted)', async () => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome, registryKeys: ['HKLM\\SOFTWARE\\Vendor'] })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.deniedActions[0]?.reason).toMatch(/^Denied/);
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
  });

  it('outside the ceiling on the fresh read: denied, not run', async () => {
    const outcome = makeOutcome();
    const hook = makeHook({ outcome });
    await hook('registry_operations', REGISTRY, undefined, 'tu-1');
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:read']) }));
    const second = await hook('registry_operations', REGISTRY, undefined, 'tu-2');
    expect(second).toMatchObject({ allowed: false });
    expect(outcome.deniedActions.at(-1)?.reason).toMatch(/delegation ceiling/);
    expect(intentMocks.createActionIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['a registry write', 'registry_operations', { action: 'set_value', deviceId: DEVICE_ID, keyPath: 'HKLM\\A', valueName: 'b', valueData: 'c' }],
    ['a service restart', 'execute_command', { deviceId: DEVICE_ID, commandType: 'restart_service', payload: { name: 'x' } }],
    ['a Security query with a QueryList', 'execute_command', { ...SECURITY, payload: { logName: 'Security', query: '<QueryList><Query Path="Application"/></QueryList>' } }],
    ['another channel', 'execute_command', { ...SECURITY, payload: { logName: 'Application' } }],
  ])('%s still proposes', async (_label, tool, input) => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome })(tool, input as Record<string, unknown>, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
  });
});

describe('device_troubleshooting run, switch off', () => {
  it.each([
    ['registry get_value', 'registry_operations', REGISTRY],
    ['Security query', 'execute_command', SECURITY],
    ['device note', 'set_device_context', NOTE],
  ])('%s proposes exactly as before', async (_label, tool, input) => {
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ unattendedReads: false }));
    const outcome = makeOutcome();
    const result = await makeHook({ outcome })(tool, input as Record<string, unknown>, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
  });

  it('a switch-off read costs no second ceiling evaluation', async () => {
    grantMocks.resolveGrantCeiling.mockResolvedValue(ceiling({ unattendedReads: false }));
    await makeHook({ outcome: makeOutcome() })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(grantMocks.resolveGrantCeiling).toHaveBeenCalledTimes(1);
  });
});

describe('a troubleshooting run with no grant', () => {
  it('proposes, and never reads a ceiling', async () => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome, grantId: null })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
    expect(grantMocks.resolveGrantCeiling).not.toHaveBeenCalled();
  });
});

describe('other profiles are unchanged', () => {
  it('a full-profile run under a switched-on grant still proposes the same read', async () => {
    const outcome = makeOutcome();
    const result = await makeHook({ outcome, profile: 'full' })('registry_operations', REGISTRY, undefined, 'tu-1');
    expect(result).toMatchObject({ allowed: false });
    expect(outcome.proposedActions).toHaveLength(1);
  });
});
