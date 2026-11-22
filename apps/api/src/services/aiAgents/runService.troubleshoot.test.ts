/**
 * Wisp delegation W1 (#11084) — `device_troubleshooting` admission: the
 * kind/profile/device/grant pairing, the forced-shadow start and the
 * per-(agent, org) caps (`profileCaps('device_troubleshooting')`).
 *
 * Harness copied from runService.grantAdmission.test.ts: `../../db` is a
 * chainable stub driven by FIFO row queues keyed by table name.
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
const DEVICE_ID = '00000000-0000-4000-8000-0000000000a7';

const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
  updateSets: [] as Record<string, unknown>[],
  updateRows: [] as unknown[],
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
        set: vi.fn((values: Record<string, unknown>) => {
          dbMockState.updateSets.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn(async () => dbMockState.updateRows) })) };
        }),
      })),
    },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../workspace/workspaceBreaker', () => ({ isWorkspaceBreakerOpen: vi.fn(async () => false) }));
vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    isHosted: () => true,
    envFlag: (name: string, fallback = false) => (name === 'BREEZE_AI_AGENTS_ENABLED' ? true : fallback),
  };
});
vi.mock('../aiCostTracker', () => ({
  checkBudget: vi.fn(async () => false),
  checkComputeCredits: vi.fn(async () => null),
  reserveComputeCents: vi.fn(async () => {}),
  settleComputeCents: vi.fn(async () => {}),
}));
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

import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import type { GrantCeiling } from '../wisp/grantAuthority';
import { createAndEnqueueAgentRun, registerAgentRunEnqueuer, type CreateAgentRunInput } from './runService';
import { TROUBLESHOOT_MAX_CONCURRENT_RUNS, TROUBLESHOOT_MAX_RUNS_PER_HOUR } from './troubleshootProfile';

const GRANT = { grantId: 'g1', grantRevisionId: 'r1' };

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
    schemaVersion: 12, agentId: AGENT_ID, kind: 'troubleshoot', effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'], resolvedAt: new Date().toISOString(),
  };
}

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: PARTNER_ID, grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(['manage_ai_agents', 'get_user_risk_scores']), orgTerms: new Map(), status: 'active', ...o,
  };
}

/**
 * The queue a non-full admission reads: [4c reap, 6b concurrency, 6b rate,
 * 7 daily spend] (no cooldown probe off the full profile).
 */
function seedAdmission(opts: { concurrent?: number; perWindow?: number } = {}): void {
  const { concurrent = 0, perWindow = 0 } = opts;
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  dbMockState.rowQueues.ai_agent_runs = [[], [{ value: concurrent }], [{ value: perWindow }], [{ totalCostCents: 0 }]];
  dbMockState.rowQueues.ai_agents = [[{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Troubleshoot', kind: 'troubleshoot' }]];
  dbMockState.rowQueues.devices = [[{ id: DEVICE_ID, orgId: ORG_ID, siteId: null }], [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null }]];
  dbMockState.insertRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued' }];
}

function input(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: ORG_ID, kind: 'troubleshoot', triggerKind: 'manual', deviceId: DEVICE_ID,
    dedupeKey: 'wisp:specialist:ts-1', profile: 'device_troubleshooting', grant: GRANT, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.rowQueues = {};
  dbMockState.insertValues = [];
  dbMockState.insertRows = [];
  dbMockState.updateSets = [];
  dbMockState.updateRows = [];
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(['execute_command', 'registry_operations', 'set_device_context', 'run_script', 'file_operations']));
  resolveGrantCeiling.mockResolvedValue(ceiling());
  registerAgentRunEnqueuer(vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })));
  seedAdmission();
});

describe('device_troubleshooting pairing', () => {
  it('admits the troubleshoot agent on one device under a grant, recording profile, device and grant', async () => {
    await expect(createAndEnqueueAgentRun(input())).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({
      profile: 'device_troubleshooting', deviceId: DEVICE_ID, grantId: 'g1', grantRevisionId: 'r1',
    });
  });

  it('ownership_mismatch when another agent kind asks for the device_troubleshooting profile', async () => {
    for (const kind of ['triage', 'patch', 'helpdesk', 'research'] as const) {
      seedAdmission();
      const result = await createAndEnqueueAgentRun(input({ kind, dedupeKey: `wisp:ts-kind-${kind}` }));
      expect(result, kind).toEqual({ created: false, skipped: 'ownership_mismatch' });
    }
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('ownership_mismatch when the troubleshoot agent is admitted on any other profile (e.g. the manual route\'s full default)', async () => {
    for (const profile of [undefined, 'full', 'remediation_research', 'assessment'] as const) {
      seedAdmission();
      const result = await createAndEnqueueAgentRun(input({ profile, dedupeKey: `wisp:ts-profile-${String(profile)}` }));
      expect(result, String(profile)).toEqual({ created: false, skipped: 'ownership_mismatch' });
    }
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('ownership_mismatch without a device: the run is device-pinned by construction', async () => {
    const result = await createAndEnqueueAgentRun(input({ deviceId: null }));
    expect(result).toEqual({ created: false, skipped: 'ownership_mismatch' });
  });

  it('troubleshoot_requires_grant without a grant: the run lives inside a Wisp grant ceiling or not at all', async () => {
    const result = await createAndEnqueueAgentRun(input({ grant: undefined }));
    expect(result).toEqual({ created: false, skipped: 'troubleshoot_requires_grant' });
    expect(dbMockState.insertValues).toEqual([]);
  });
});

describe('device_troubleshooting runs are always admitted shadow', () => {
  // `act` would make the run's supervised intents policy-decidable
  // (intentService resolvePolicyDecisionState), i.e. executable with no human.
  it("an act-mode effective policy still inserts modeAtStart 'shadow'", async () => {
    const snap = snapshot([]);
    snap.effective.mode = 'act';
    resolveEffectiveAgentSystem.mockResolvedValue(snap);
    await expect(createAndEnqueueAgentRun(input())).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ profile: 'device_troubleshooting', modeAtStart: 'shadow' });
  });
});

describe('step 8a row-level pin', () => {
  // The input kind is caller-supplied; the ai_agents ROW is authoritative. A
  // caller claiming 'troubleshoot' over a row that is actually another kind
  // must not get a device_troubleshooting run.
  it("ownership_mismatch and no insert when the ai_agents row's kind is not troubleshoot", async () => {
    dbMockState.rowQueues.ai_agents = [[{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Triage', kind: 'triage' }]];
    const result = await createAndEnqueueAgentRun(input());
    expect(result).toEqual({ created: false, skipped: 'ownership_mismatch' });
    expect(dbMockState.insertValues).toEqual([]);
  });
});

describe("profileCaps('device_troubleshooting') — pinned per-(agent, org) caps", () => {
  it('max_concurrent_troubleshoot_runs at TROUBLESHOOT_MAX_CONCURRENT_RUNS', async () => {
    seedAdmission({ concurrent: TROUBLESHOOT_MAX_CONCURRENT_RUNS });
    await expect(createAndEnqueueAgentRun(input())).resolves.toEqual({
      created: false, skipped: 'max_concurrent_troubleshoot_runs',
    });
  });

  it('troubleshoot_rate at TROUBLESHOOT_MAX_RUNS_PER_HOUR; one fewer admits', async () => {
    seedAdmission({ perWindow: TROUBLESHOOT_MAX_RUNS_PER_HOUR });
    await expect(createAndEnqueueAgentRun(input())).resolves.toEqual({ created: false, skipped: 'troubleshoot_rate' });
    seedAdmission({ perWindow: TROUBLESHOOT_MAX_RUNS_PER_HOUR - 1 });
    await expect(createAndEnqueueAgentRun(input({ dedupeKey: 'wisp:ts-2' }))).resolves.toMatchObject({ created: true });
  });
});
