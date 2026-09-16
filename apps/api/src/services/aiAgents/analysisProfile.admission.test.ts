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

const getLlmBillingSourceForOrg = vi.hoisted(() => vi.fn(async () => 'platform'));
vi.mock('../llm/llmConfigResolver', () => ({ getLlmBillingSourceForOrg }));

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

import { WORKSPACE_TOOL_NAMES } from '../aiGuardrails';
import {
  createAndEnqueueAgentRun, registerAgentRunEnqueuer, type CreateAgentRunInput,
} from './runService';

function snapshot(allowlist: string[]): AiAgentPolicySnapshot {
  const effective: AiAgentPolicy = {
    enabled: true,
    mode: 'shadow',
    model: null,
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
    analysis: { deviceIds: [DEVICE_A, DEVICE_B], inputHandles: [] },
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
  getLlmBillingSourceForOrg.mockResolvedValue('platform');
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot([...WORKSPACE_TOOL_NAMES]));
  registerAgentRunEnqueuer(vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })));
  process.env.BREEZE_REGION = 'eu';
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
      analysis: { deviceIds: tooMany, inputHandles: [] },
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
