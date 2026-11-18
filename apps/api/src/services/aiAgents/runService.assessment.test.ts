/**
 * Wisp W05 — `assessment` profile admission: the kind/grant pairing (rule 2a)
 * and the per-(agent, org) caps (`profileCaps('assessment')`, rule 6b).
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
import { ASSESSMENT_MAX_CONCURRENT_RUNS, ASSESSMENT_MAX_RUNS_PER_HOUR } from './assessmentProfile';

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
    schemaVersion: 12, agentId: AGENT_ID, kind: 'triage', effective,
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
  dbMockState.rowQueues.ai_agents = [[{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Triage', kind: 'triage' }]];
  dbMockState.insertRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued' }];
}

function input(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: ORG_ID, kind: 'triage', triggerKind: 'schedule', deviceId: null,
    dedupeKey: 'wisp:assess-1', profile: 'assessment', grant: GRANT, ...over,
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
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(['get_device', 'manage_ai_agents', 'manage_services:restart', 'list_alerts']));
  resolveGrantCeiling.mockResolvedValue(ceiling());
  registerAgentRunEnqueuer(vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })));
  seedAdmission();
});

describe('admission rule 2a — assessment pairing', () => {
  it('admits a triage-kind agent on the assessment profile under a grant, and records the profile', async () => {
    await expect(createAndEnqueueAgentRun(input())).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ profile: 'assessment', grantId: 'g1', grantRevisionId: 'r1' });
  });

  it('ownership_mismatch when an assessment targets a non-triage agent kind', async () => {
    for (const kind of ['patch', 'helpdesk'] as const) {
      seedAdmission();
      const result = await createAndEnqueueAgentRun(input({ kind, dedupeKey: `wisp:assess-kind-${kind}` }));
      expect(result, kind).toEqual({ created: false, skipped: 'ownership_mismatch' });
    }
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('assessment_requires_grant when an assessment carries no grant (caller bug surfaced as a skip, not a throw)', async () => {
    const result = await createAndEnqueueAgentRun(input({ grant: undefined }));
    expect(result).toEqual({ created: false, skipped: 'assessment_requires_grant' });
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('a non-triage kind without a grant answers ownership_mismatch (kind is checked first)', async () => {
    const result = await createAndEnqueueAgentRun(input({ kind: 'helpdesk', grant: undefined }));
    expect(result).toEqual({ created: false, skipped: 'ownership_mismatch' });
  });

  it('does not touch the plain triage profile: a triage run without a grant is still admitted', async () => {
    const result = await createAndEnqueueAgentRun(input({ profile: 'triage', grant: undefined, dedupeKey: 'manual:t1' }));
    expect(result).toMatchObject({ created: true });
  });
});

describe('assessment runs are always admitted shadow', () => {
  // An assessment's input is tenant-authored text and w00 allows it Tier 1 +
  // auto-approved Tier 2 only: an act-mode start would let intentService's
  // policy decision auto-execute a supervised Tier-3 proposal with no human.
  it("an act-mode agent's assessment run is inserted with modeAtStart 'shadow'", async () => {
    const snap = snapshot([]);
    snap.effective.mode = 'act';
    resolveEffectiveAgentSystem.mockResolvedValue(snap);
    await expect(createAndEnqueueAgentRun(input())).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ profile: 'assessment', modeAtStart: 'shadow' });
  });

  it('the downgrade is assessment-only: an act-mode plain triage run still starts act', async () => {
    const snap = snapshot([]);
    snap.effective.mode = 'act';
    resolveEffectiveAgentSystem.mockResolvedValue(snap);
    await expect(createAndEnqueueAgentRun(input({ profile: 'triage', grant: undefined, dedupeKey: 'manual:t2' })))
      .resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ profile: 'triage', modeAtStart: 'act' });
  });
});

describe("profileCaps('assessment') — pinned per-(agent, org) caps", () => {
  it('max_concurrent_assessment_runs at ASSESSMENT_MAX_CONCURRENT_RUNS (1)', async () => {
    expect(ASSESSMENT_MAX_CONCURRENT_RUNS).toBe(1);
    seedAdmission({ concurrent: 1 });
    await expect(createAndEnqueueAgentRun(input())).resolves.toEqual({
      created: false, skipped: 'max_concurrent_assessment_runs',
    });
  });

  it('assessment_rate at ASSESSMENT_MAX_RUNS_PER_HOUR (6) in the hourly window; 5 admits', async () => {
    expect(ASSESSMENT_MAX_RUNS_PER_HOUR).toBe(6);
    seedAdmission({ perWindow: 6 });
    await expect(createAndEnqueueAgentRun(input())).resolves.toEqual({ created: false, skipped: 'assessment_rate' });
    seedAdmission({ perWindow: 5 });
    await expect(createAndEnqueueAgentRun(input({ dedupeKey: 'wisp:assess-2' }))).resolves.toMatchObject({ created: true });
  });

  it('the caps are constants, not policy: a snapshot with huge triage caps does not lift them', async () => {
    const snap = snapshot([]);
    snap.effective.limits = { ...snap.effective.limits, maxConcurrentTriageRuns: 50, maxTriageRunsPerHour: 500 };
    resolveEffectiveAgentSystem.mockResolvedValue(snap);
    seedAdmission({ concurrent: 1 });
    await expect(createAndEnqueueAgentRun(input())).resolves.toEqual({
      created: false, skipped: 'max_concurrent_assessment_runs',
    });
  });
});
