/**
 * Execution plane W04 — `analysis`-profile admission (spec §7 step 1, §8, §12).
 *
 * Mock shapes are the ones `runService.test.ts` uses: `../../db` exposes a
 * chainable select/insert stub driven by FIFO row queues keyed by table name,
 * and the system-context wrapper runs its callback inline. The read ORDER the
 * queues encode is itself part of what is pinned here — the analysis gates
 * must run BEFORE any counter, so a refused analysis never consumes a slot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const RUN_ID = '00000000-0000-4000-8000-0000000000a6';
const DEVICE_A = '00000000-0000-4000-8000-0000000000d1';
const DEVICE_B = '00000000-0000-4000-8000-0000000000d2';

const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) throw new Error(`No queued rows for table ${table}`);
  return queue.shift() as unknown[];
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const builder: Record<string, unknown> = {
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: {
      select: vi.fn(() => makeSelect()),
      execute: vi.fn(async (_s: SQL) => [] as unknown[]),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          dbMockState.insertValues.push(values);
          const returning = vi.fn(async () => dbMockState.insertRows);
          return { onConflictDoNothing: vi.fn(() => ({ returning })), returning };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
      })),
    },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

const state = vi.hoisted(() => ({
  hosted: true,
  workspaceFlag: true,
  breakerOpen: false,
  creditsDenial: null as { code: string; message: string } | null,
  reserved: [] as Array<{ runId: string; cents: number; source: string }>,
}));

vi.mock('../workspace/workspaceBreaker', () => ({
  isWorkspaceBreakerOpen: vi.fn(async () => state.breakerOpen),
}));

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    isHosted: () => state.hosted,
    envFlag: (name: string, fallback = false) => (
      name === 'BREEZE_AI_AGENTS_ENABLED' ? true
        : name === 'BREEZE_AI_WORKSPACE_ENABLED' ? state.workspaceFlag
          : fallback
    ),
  };
});

vi.mock('../aiCostTracker', () => ({
  checkBudget: vi.fn(async () => false),
  checkComputeCredits: vi.fn(async () => state.creditsDenial),
  reserveComputeCents: vi.fn(async (orgId: string, runId: string, cents: number, source: string) => {
    state.reserved.push({ runId, cents, source });
  }),
  settleComputeCents: vi.fn(async () => {}),
}));

// AI model registry W03: admission resolves the agent's model (and its funding) first.
const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('../aiModels/resolveModel', () => ({ resolveModel }));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'partner-1') }));
vi.mock('./modelBlocked', () => ({ notifyModelBlocked: vi.fn(async () => undefined) }));

const resolveEffectiveAgentSystem = vi.hoisted(() => vi.fn());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

vi.mock('../deploymentEngine', () => ({ isDeviceInMaintenanceWindow: vi.fn(async () => false) }));
vi.mock('../eventBus', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('./skipVisibility', () => ({ recordAgentRunSkip: vi.fn(async () => {}) }));
vi.mock('./executionLedger', () => ({
  reconcileHungExecutions: vi.fn(async () => 0),
  closeAgentRunSession: vi.fn(async () => {}),
}));
vi.mock('./agentCircuit', () => ({
  isCircuitOpen: vi.fn(async () => false),
  recordRunTerminal: vi.fn(async () => {}),
  isTerminalRunStatus: (status: string) => status !== 'queued' && status !== 'running',
}));

const resolveGrantCeiling = vi.hoisted(() => vi.fn());
vi.mock('../wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wisp/grantAuthority')>()),
  resolveGrantCeiling,
}));

// W02: a pass-through spy over the real frame resolver, so the existing
// too_many_input_devices / device_not_in_org cases keep exercising it.
const resolveAnalysisFrameSpy = vi.hoisted(() => vi.fn());
const realFrame = vi.hoisted(() => ({ fn: null as null | ((...a: unknown[]) => unknown) }));
vi.mock('./analysisFrame', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./analysisFrame')>();
  realFrame.fn = actual.resolveAnalysisFrame as (...a: unknown[]) => unknown;
  return { ...actual, resolveAnalysisFrame: resolveAnalysisFrameSpy };
});

// W03: the chain sum is a real-SQL concern (analysisChain.integration.test.ts);
// here it is a spy, and `chainRootOf` stays real.
const chainCommittedCents = vi.hoisted(() => vi.fn());
vi.mock('./analysisContinuation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analysisContinuation')>()),
  chainCommittedCents,
}));

import { WORKSPACE_TOOL_NAMES } from '../aiGuardrails';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import {
  createAndEnqueueAgentRun, registerAgentRunEnqueuer, type CreateAgentRunInput,
} from './runService';
import type { GrantCeiling } from '../wisp/grantAuthority';
import type { AnalysisSensitiveGate } from '../../db/schema/aiAgents';

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: PARTNER_ID, grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...o,
  };
}

function snapshot(allowlist: string[]): AiAgentPolicySnapshot {
  const effective: AiAgentPolicy = {
    enabled: true,
    mode: 'shadow',
    toolAllowlist: allowlist,
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
  return {
    schemaVersion: 12,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date().toISOString(),
  };
}

interface SeedOptions {
  externalProcessing?: boolean;
  deviceRows?: string[];
  concurrent?: number;
  perHour?: number;
  computeSettled?: number;
  computeReserved?: number;
  computeBudgetRow?: { maxComputeCentsPerDay: number } | null;
}

function seed(options: SeedOptions = {}): void {
  const {
    externalProcessing = true,
    deviceRows = [DEVICE_A, DEVICE_B],
    concurrent = 0,
    perHour = 0,
    computeSettled = 0,
    computeReserved = 0,
    computeBudgetRow = { maxComputeCentsPerDay: 500 },
  } = options;

  dbMockState.rowQueues.organizations = [
    // 4d(a) — the per-org external-processing switch, then step 8's ownership read.
    [{ enabled: externalProcessing }],
    [{ id: ORG_ID, partnerId: PARTNER_ID }],
  ];
  dbMockState.rowQueues.devices = [deviceRows.map((id) => ({ id }))];
  dbMockState.rowQueues.ai_agent_runs = [
    [],                                   // 4c reap candidates
    [{ value: concurrent }],              // 6b concurrency
    [{ value: perHour }],                 // 6b rate
    [{ totalCostCents: 0 }],              // 7 agent daily token spend
    [{ settled: computeSettled, reserved: computeReserved }], // 7b compute spend
  ];
  dbMockState.rowQueues.ai_budgets = [computeBudgetRow ? [computeBudgetRow] : []];
  dbMockState.rowQueues.ai_agents = [
    [{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Triage', kind: 'triage' }],
  ];
  dbMockState.insertRows = [
    {
      id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued', deviceId: null,
      profile: 'analysis',
    },
  ];
}

function analysisInput(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: ORG_ID,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: null,
    dedupeKey: 'manual:analysis-1',
    profile: 'analysis',
    analysis: { scope: 'devices', siteId: null, deviceIds: [DEVICE_A, DEVICE_B], inputHandles: [] },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.hosted = true;
  state.workspaceFlag = true;
  state.breakerOpen = false;
  state.creditsDenial = null;
  state.reserved.length = 0;
  dbMockState.rowQueues = {};
  dbMockState.insertValues = [];
  dbMockState.insertRows = [];
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot([...WORKSPACE_TOOL_NAMES]));
  registerAgentRunEnqueuer(vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })));
  process.env.BREEZE_REGION = 'eu';
  resolveAnalysisFrameSpy.mockReset();
  resolveAnalysisFrameSpy.mockImplementation((...a: unknown[]) => realFrame.fn!(...a));
  resolveGrantCeiling.mockReset();
  chainCommittedCents.mockReset();
  chainCommittedCents.mockResolvedValue({ committedCents: 0, runCount: 1 });
  seed();
});

describe('analysis admission', () => {
  it('skips workspace_unavailable while the backend circuit breaker is open', async () => {
    state.breakerOpen = true;
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'workspace_unavailable',
    });
  });

  it('skips analysis_not_available when self-hosted', async () => {
    state.hosted = false;
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'analysis_not_available',
    });
  });

  it('skips analysis_not_available when BREEZE_AI_WORKSPACE_ENABLED is off', async () => {
    state.workspaceFlag = false;
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'analysis_not_available',
    });
  });

  it('skips external_processing_disabled when the org has not opted in', async () => {
    seed({ externalProcessing: false });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'external_processing_disabled',
    });
  });

  it('skips workspace_capability_missing when a workspace ref is absent from the allowlist', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot([...WORKSPACE_TOOL_NAMES].slice(0, 3)));
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'workspace_capability_missing',
    });
  });

  it('caps the frozen device set at analysisMaxInputDevicesPerRun with its OWN reason', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-00000000e0${i}`);
    await expect(createAndEnqueueAgentRun(analysisInput({
      analysis: { scope: 'devices', siteId: null, deviceIds: tooMany, inputHandles: [] },
    }))).resolves.toEqual({ created: false, skipped: 'too_many_input_devices' });
  });

  it('still reports device_not_in_org for a device outside the org', async () => {
    // The two must not collapse into one reason: this one is a tenancy
    // signal, the one above is "you picked too many of your own".
    seed({ deviceRows: [DEVICE_A] });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'device_not_in_org',
    });
  });

  it('counts concurrency and rate against the analysis counters only', async () => {
    seed({ concurrent: AI_AGENT_LIMIT_DEFAULTS.analysisMaxConcurrentRuns });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'max_concurrent_analysis_runs',
    });
    seed({ perHour: AI_AGENT_LIMIT_DEFAULTS.analysisMaxRunsPerHour });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'analysis_rate',
    });
  });

  it('counts outstanding reservations, not just settled spend, against the daily ceiling', async () => {
    // 480 reserved + the 25¢ this run wants > 500. Settled spend alone is 0,
    // so a version that ignored reservations would admit this.
    seed({ computeReserved: 480 });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'compute_budget_exceeded',
    });
  });

  it('refuses when settled spend would cross ai_budgets.max_compute_cents_per_day', async () => {
    seed({ computeSettled: 490 });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'compute_budget_exceeded',
    });
  });

  it('honours a lowered per-org compute budget', async () => {
    seed({ computeBudgetRow: { maxComputeCentsPerDay: 20 } }); // below the 25¢ reservation
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'compute_budget_exceeded',
    });
  });

  it('falls back to the column default of 500 for an org with no ai_budgets row', async () => {
    // Pins DEFAULT_MAX_COMPUTE_CENTS_PER_DAY === the migration's DEFAULT 500.
    seed({ computeBudgetRow: null, computeSettled: 490 });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'compute_budget_exceeded',
    });
    seed({ computeBudgetRow: null, computeSettled: 0 });
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toMatchObject({ created: true });
  });

  it('refuses a platform run with no credits for the compute leg', async () => {
    state.creditsDenial = { code: 'credits_exhausted', message: 'no credits' };
    await expect(createAndEnqueueAgentRun(analysisInput())).resolves.toEqual({
      created: false, skipped: 'compute_credits_exhausted',
    });
  });

  it('admits, freezes staged_inputs and takes the reservation', async () => {
    const result = await createAndEnqueueAgentRun(analysisInput());
    expect(result.created).toBe(true);
    expect(dbMockState.insertValues[0]!.stagedInputs).toEqual({
      handles: [], deviceIds: [DEVICE_A, DEVICE_B], region: 'eu',
      scope: { kind: 'devices', siteId: null, deviceCount: 2 },
    });
    expect(state.reserved).toEqual([{ runId: RUN_ID, cents: 25, source: 'platform' }]);
  });

  it('writes NO staged_inputs for a non-analysis profile', async () => {
    dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
    dbMockState.rowQueues.ai_agent_runs = [[], [{ value: 0 }], [{ value: 0 }], [{ totalCostCents: 0 }]];
    dbMockState.rowQueues.ai_agents = [
      [{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Triage', kind: 'triage' }],
    ];
    dbMockState.insertRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued' }];
    await createAndEnqueueAgentRun(analysisInput({ profile: 'triage', analysis: undefined }));
    expect(dbMockState.insertValues[0]!.stagedInputs).toBeNull();
    expect(state.reserved).toEqual([]);
  });
});

describe('analysis admission — W02 scope frame and frozen export grants', () => {
  const GRANT = { grantId: 'g1', grantRevisionId: 'r1' };
  const GRANTS = { datasets: ['event_logs', 'metrics'], sensitiveGates: [] as AnalysisSensitiveGate[] };
  const ORG_SCOPE = { scope: 'org' as const, siteId: null, deviceIds: [] as string[], inputHandles: [] as string[], exportGrants: GRANTS };

  it('org scope under a grant: freezes the expanded frame, its scope and the passed export grants verbatim', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    const result = await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
    expect(result.created).toBe(true);
    expect(dbMockState.insertValues[0]!.stagedInputs).toEqual({
      handles: [], deviceIds: [DEVICE_A, DEVICE_B], region: 'eu',
      scope: { kind: 'org', siteId: null, deviceCount: 2 }, exportGrants: GRANTS,
    });
  });

  it('passes the ceiling site allowlist and both limits to resolveAnalysisFrame', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
    expect(resolveAnalysisFrameSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, scope: 'org', allowedSiteIds: null, maxInputDevices: 50, maxFrameDevices: 1000,
    }));
  });

  it('a site-restricted ceiling never reaches the frame: step 1d refuses it (the narrowing is defence in depth)', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['site-1']) }));
    await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE })))
      .resolves.toEqual({ created: false, skipped: 'grant_org_out_of_ceiling' });
    expect(resolveAnalysisFrameSpy).not.toHaveBeenCalled();
  });

  it('a snapshot without analysisMaxFrameDevices falls back to 1000', async () => {
    const { analysisMaxFrameDevices: _drop, ...older } = AI_AGENT_LIMIT_DEFAULTS;
    const snap = snapshot([...WORKSPACE_TOOL_NAMES]);
    resolveEffectiveAgentSystem.mockResolvedValue({ ...snap, effective: { ...snap.effective, limits: older } });
    resolveGrantCeiling.mockResolvedValue(ceiling());
    await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
    expect(resolveAnalysisFrameSpy).toHaveBeenCalledWith(expect.objectContaining({ maxFrameDevices: 1000 }));
  });

  it.each(['frame_too_large', 'site_not_in_scope', 'frame_empty'] as const)('skips %s before any counter or insert', async (refusal) => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    resolveAnalysisFrameSpy.mockResolvedValueOnce({ ok: false, refusal });
    await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE })))
      .resolves.toEqual({ created: false, skipped: refusal });
    expect(dbMockState.insertValues).toEqual([]);
    // No counter was read: the reap / concurrency / rate queue is untouched.
    expect(dbMockState.rowQueues.ai_agent_runs).toHaveLength(5);
  });

  it('an org with no eligible devices is refused frame_empty, never frozen as []', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    seed({ deviceRows: [] });
    await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE })))
      .resolves.toEqual({ created: false, skipped: 'frame_empty' });
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('fails closed: a site/org frame without a grant, or a grant-bearing analysis without export grants', async () => {
    await expect(createAndEnqueueAgentRun(analysisInput({ analysis: ORG_SCOPE })))
      .resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
    seed();
    await expect(createAndEnqueueAgentRun(analysisInput({ analysis: { ...ORG_SCOPE, scope: 'site', siteId: '00000000-0000-4000-8000-0000000000b1' } })))
      .resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
    seed();
    resolveGrantCeiling.mockResolvedValue(ceiling());
    const { exportGrants: _no, ...withoutGrants } = ORG_SCOPE;
    await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: withoutGrants })))
      .resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
    expect(resolveAnalysisFrameSpy).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('export grants without a grant are refused: nothing frozen has no ceiling behind it', async () => {
    await expect(createAndEnqueueAgentRun(analysisInput({
      analysis: { scope: 'devices', siteId: null, deviceIds: [DEVICE_A], inputHandles: [], exportGrants: GRANTS },
    }))).resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
    expect(resolveAnalysisFrameSpy).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('an org membership restricted to sites is refused at step 1d too, before the frame', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling({
      orgTerms: new Map([[ORG_ID, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]),
    }));
    await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE })))
      .resolves.toEqual({ created: false, skipped: 'grant_org_out_of_ceiling' });
    expect(resolveAnalysisFrameSpy).not.toHaveBeenCalled();
  });

  it('grant-less devices scope still admits with no export grants (legacy authority)', async () => {
    const result = await createAndEnqueueAgentRun(analysisInput());
    expect(result.created).toBe(true);
    expect(dbMockState.insertValues[0]!.stagedInputs).not.toHaveProperty('exportGrants');
  });
});

describe('analysis admission — site visibility (W02 review fix)', () => {
  const GRANT = { grantId: 'g1', grantRevisionId: 'r1' };
  const SITE = '00000000-0000-4000-8000-0000000000b1';
  const GRANTS = { datasets: ['event_logs'], sensitiveGates: [] as AnalysisSensitiveGate[] };

  it('a site frame records its site on trigger_ref so site-restricted users see the run', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    dbMockState.rowQueues.sites = [[{ id: SITE }]];
    const result = await createAndEnqueueAgentRun(analysisInput({
      grant: GRANT,
      triggerRef: { source: 'chat_analysis', goal: 'g', siteId: null },
      analysis: { scope: 'site', siteId: SITE, deviceIds: [], inputHandles: [], exportGrants: GRANTS },
    }));
    expect(result.created).toBe(true);
    expect(dbMockState.insertValues[0]!.triggerRef).toEqual({ source: 'chat_analysis', goal: 'g', siteId: SITE });
    expect(dbMockState.insertValues[0]!.stagedInputs).toMatchObject({ scope: { kind: 'site', siteId: SITE, deviceCount: 2 } });
  });

  it('an org or devices frame leaves trigger_ref.siteId as the caller verified it', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling());
    await createAndEnqueueAgentRun(analysisInput({
      grant: GRANT,
      triggerRef: { source: 'chat_analysis', siteId: null },
      analysis: { scope: 'org', siteId: null, deviceIds: [], inputHandles: [], exportGrants: GRANTS },
    }));
    expect(dbMockState.insertValues[0]!.triggerRef).toEqual({ source: 'chat_analysis', siteId: null });
  });
});

describe('analysis chain admission (W03)', () => {
  const PRIOR = '00000000-0000-4000-8000-0000000000f1';
  const ROOT = '00000000-0000-4000-8000-0000000000f0';
  const cont = { fromRunId: PRIOR, chainRootRunId: ROOT, chainDepth: 2 };
  const priorRow = (over: Record<string, unknown> = {}) => ({
    id: PRIOR, profile: 'analysis', grantId: null, chainRootRunId: ROOT, chainDepth: 1, ...over,
  });
  /** Queue the prior read ahead of the reap / counter reads. */
  const withPrior = (rows: unknown[]) => { dbMockState.rowQueues.ai_agent_runs!.unshift(rows); };
  const continuation = (over: Partial<typeof cont> = {}) => analysisInput({
    analysis: { scope: 'devices', siteId: null, deviceIds: [DEVICE_A, DEVICE_B], inputHandles: [], continuation: { ...cont, ...over } },
  });
  const withLimits = (limits: Partial<typeof AI_AGENT_LIMIT_DEFAULTS>) => {
    const snap = snapshot([...WORKSPACE_TOOL_NAMES]);
    resolveEffectiveAgentSystem.mockResolvedValue({ ...snap, effective: { ...snap.effective, limits: { ...snap.effective.limits, ...limits } } });
  };

  it('writes the lineage columns on a continuation and zeros on a fresh run', async () => {
    withPrior([priorRow()]);
    await expect(createAndEnqueueAgentRun(continuation())).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ continuedFromRunId: PRIOR, chainRootRunId: ROOT, chainDepth: 2 });
    expect(chainCommittedCents).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, chainRootRunId: ROOT });
    seed();
    dbMockState.insertValues = [];
    await createAndEnqueueAgentRun(analysisInput());
    expect(dbMockState.insertValues[0]).toMatchObject({ continuedFromRunId: null, chainRootRunId: null, chainDepth: 0 });
  });

  it('a continuation of a root (depth 0) has the prior as its root', async () => {
    withPrior([priorRow({ id: PRIOR, chainRootRunId: null, chainDepth: 0 })]);
    await expect(createAndEnqueueAgentRun(continuation({ chainRootRunId: PRIOR, chainDepth: 1 })))
      .resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ continuedFromRunId: PRIOR, chainRootRunId: PRIOR, chainDepth: 1 });
  });

  it('refuses depth over the limit: prior depth + 1 > analysisMaxChainDepth', async () => {
    withLimits({ analysisMaxChainDepth: 2 });
    withPrior([priorRow({ chainDepth: 2 })]);
    await expect(createAndEnqueueAgentRun(continuation({ chainDepth: 3 })))
      .resolves.toEqual({ created: false, skipped: 'analysis_chain_too_long' });
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('admits at exactly the depth limit', async () => {
    withLimits({ analysisMaxChainDepth: 2 });
    withPrior([priorRow({ chainDepth: 1 })]);
    await expect(createAndEnqueueAgentRun(continuation({ chainDepth: 2 }))).resolves.toMatchObject({ created: true });
  });

  it('refuses the run count at the limit', async () => {
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 0, runCount: 12 });
    await expect(createAndEnqueueAgentRun(continuation()))
      .resolves.toEqual({ created: false, skipped: 'analysis_chain_too_long' });
    seed();
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 0, runCount: 11 });
    await expect(createAndEnqueueAgentRun(continuation())).resolves.toMatchObject({ created: true });
  });

  it('refuses the budget past the limit and admits at it', async () => {
    // Defaults: 150 + 25 per run, 600 per chain.
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 425, runCount: 2 });
    await expect(createAndEnqueueAgentRun(continuation())).resolves.toMatchObject({ created: true });
    seed();
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 426, runCount: 2 });
    await expect(createAndEnqueueAgentRun(continuation()))
      .resolves.toEqual({ created: false, skipped: 'analysis_chain_budget_exceeded' });
  });

  it('a snapshot without the chain limits falls back to the defaults', async () => {
    const { analysisMaxChainDepth: _d, analysisMaxChainRuns: _r, analysisMaxChainBudgetCents: _b, ...older } = AI_AGENT_LIMIT_DEFAULTS;
    const snap = snapshot([...WORKSPACE_TOOL_NAMES]);
    resolveEffectiveAgentSystem.mockResolvedValue({ ...snap, effective: { ...snap.effective, limits: older } });
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 426, runCount: 2 });
    await expect(createAndEnqueueAgentRun(continuation()))
      .resolves.toEqual({ created: false, skipped: 'analysis_chain_budget_exceeded' });
  });

  it('a prior that lost its root refuses analysis_chain_too_long', async () => {
    withPrior([priorRow({ chainDepth: 1, chainRootRunId: null })]);
    await expect(createAndEnqueueAgentRun(continuation()))
      .resolves.toEqual({ created: false, skipped: 'analysis_chain_too_long' });
    expect(chainCommittedCents).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toEqual([]);
  });

  it.each([
    ['a missing prior', [], {}],
    ['a wrong root', [priorRow({ chainRootRunId: '00000000-0000-4000-8000-0000000000f9' })], {}],
    ['a wrong depth', [priorRow({ chainDepth: 2 })], {}],
    ['another grant', [priorRow({ grantId: 'g-other' })], {}],
    ['another profile', [priorRow({ profile: 'full' })], {}],
  ] as const)('a lineage that disagrees with the prior refuses analysis_continuation_not_found (%s)', async (_label, rows) => {
    withPrior([...rows]);
    await expect(createAndEnqueueAgentRun(continuation()))
      .resolves.toEqual({ created: false, skipped: 'analysis_continuation_not_found' });
    expect(chainCommittedCents).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('the chain gates run before any counter, so a refusal consumes no slot', async () => {
    withPrior([priorRow()]);
    chainCommittedCents.mockResolvedValue({ committedCents: 0, runCount: 99 });
    await createAndEnqueueAgentRun(continuation());
    // The prior read was consumed; the reap / concurrency / rate / spend reads were not.
    expect(dbMockState.rowQueues.ai_agent_runs).toHaveLength(5);
  });

  it('a continuation also stamps the lineage on a reclaimed enqueue_failed row', async () => {
    withPrior([priorRow()]);
    dbMockState.insertRows = [];
    await createAndEnqueueAgentRun(continuation());
    const { db } = await import('../../db');
    const setArg = (vi.mocked(db.update).mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0];
    expect(setArg).toMatchObject({ continuedFromRunId: PRIOR, chainRootRunId: ROOT, chainDepth: 2 });
  });
});
