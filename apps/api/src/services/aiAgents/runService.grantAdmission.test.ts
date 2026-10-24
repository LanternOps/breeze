/**
 * Wisp W02 — run admission step 1d (Wisp design §4.3, §4.5).
 *
 * Harness copied from analysisProfile.admission.test.ts: `../../db` is a
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
const PARENT_RUN_ID = '00000000-0000-4000-8000-0000000000a7';

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
import { GrantInactiveError, type GrantCeiling } from '../wisp/grantAuthority';
import {
  createAndEnqueueAgentRun, GrantDepthExceededError, registerAgentRunEnqueuer, type CreateAgentRunInput,
} from './runService';

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

/** The queue a non-analysis admission reads (mirrors analysisProfile.admission.test.ts's 'triage' case). */
function seedAdmission(): void {
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  dbMockState.rowQueues.ai_agent_runs = [[], [{ value: 0 }], [{ value: 0 }], [{ totalCostCents: 0 }]];
  dbMockState.rowQueues.ai_agents = [[{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Triage', kind: 'triage' }]];
  dbMockState.insertRows = [{ id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued' }];
}

function input(over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    orgId: ORG_ID, kind: 'triage', triggerKind: 'manual', deviceId: null,
    dedupeKey: 'manual:grant-1', profile: 'triage', ...over,
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

describe('admission step 1d — grant ceiling', () => {
  it('1d runs after 1c and before the policy read: an inactive grant skips grant_inactive with zero resolveEffectiveAgentSystem calls', async () => {
    resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'paused'));
    await expect(createAndEnqueueAgentRun(input({ grant: GRANT }))).resolves.toEqual({ created: false, skipped: 'grant_inactive' });
    expect(resolveGrantCeiling).toHaveBeenCalledWith('g1', 'r1');
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
    expect(dbMockState.insertValues).toEqual([]);
  });

  it('1d skips grant_org_out_of_ceiling when run.orgId ∉ ceiling.orgIds', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling({ orgIds: new Set(['some-other-org']) }));
    await expect(createAndEnqueueAgentRun(input({ grant: GRANT }))).resolves.toEqual({ created: false, skipped: 'grant_org_out_of_ceiling' });
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
  });

  it('a non-GrantInactiveError from the evaluator propagates (caller bug / outage, never a silent admit)', async () => {
    resolveGrantCeiling.mockRejectedValue(new Error('db down'));
    await expect(createAndEnqueueAgentRun(input({ grant: GRANT }))).rejects.toThrow('db down');
  });

  it('intersects the allowlist: policySnapshot.effective.toolAllowlist = effective ∩ ceiling.toolAllowlist \\ ceiling.deniedTools', async () => {
    resolveGrantCeiling.mockResolvedValue(ceiling({ toolAllowlist: new Set(['get_device', 'manage_services', 'manage_ai_agents']) }));
    await expect(createAndEnqueueAgentRun(input({ grant: GRANT }))).resolves.toMatchObject({ created: true });
    const snap = dbMockState.insertValues[0]!.policySnapshot as AiAgentPolicySnapshot;
    expect(snap.effective.toolAllowlist).toEqual(['get_device', 'manage_services:restart']);
  });

  it('with ceiling.toolAllowlist null the inserted allowlist is effective \\ deniedTools', async () => {
    await createAndEnqueueAgentRun(input({ grant: GRANT }));
    const snap = dbMockState.insertValues[0]!.policySnapshot as AiAgentPolicySnapshot;
    expect(snap.effective.toolAllowlist).toEqual(['get_device', 'manage_services:restart', 'list_alerts']);
  });

  it('stamps grantId + grantRevisionId on the inserted row', async () => {
    await createAndEnqueueAgentRun(input({ grant: GRANT }));
    expect(dbMockState.insertValues[0]).toMatchObject({ grantId: 'g1', grantRevisionId: 'r1' });
  });

  it('without `grant` the inserted row has grantId null and resolveGrantCeiling is never called', async () => {
    await createAndEnqueueAgentRun(input());
    expect(resolveGrantCeiling).not.toHaveBeenCalled();
    expect(dbMockState.insertValues[0]).toMatchObject({ grantId: null, grantRevisionId: null });
    const snap = dbMockState.insertValues[0]!.policySnapshot as AiAgentPolicySnapshot;
    expect(snap.effective.toolAllowlist).toEqual(['get_device', 'manage_ai_agents', 'manage_services:restart', 'list_alerts']);
  });
});

describe('enqueue-failed reclaim keeps the pin honest', () => {
  const reclaimed = { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, status: 'queued' };

  it('a reclaim under a grant stamps THIS attempt\'s grant + revision (never leaves the row unpinned)', async () => {
    dbMockState.insertRows = []; // (org, dedupe_key) conflict → reclaim path
    dbMockState.updateRows = [reclaimed];
    await expect(createAndEnqueueAgentRun(input({ grant: GRANT }))).resolves.toMatchObject({ created: true });
    const reclaimSet = dbMockState.updateSets.find((v) => 'policySnapshot' in v);
    expect(reclaimSet).toMatchObject({ grantId: 'g1', grantRevisionId: 'r1' });
  });

  it('a reclaim without a grant writes the pin as null', async () => {
    dbMockState.insertRows = [];
    dbMockState.updateRows = [reclaimed];
    await createAndEnqueueAgentRun(input());
    const reclaimSet = dbMockState.updateSets.find((v) => 'policySnapshot' in v);
    expect(reclaimSet).toMatchObject({ grantId: null, grantRevisionId: null });
  });
});

describe('admission depth guard (w00 A11)', () => {
  it('requestedByRunId naming a run whose grant_id is null throws GrantDepthExceededError (caller bug), no skip, no insert', async () => {
    dbMockState.rowQueues.ai_agent_runs!.unshift([{ grantId: null, orgId: ORG_ID }]);
    const err = await createAndEnqueueAgentRun(input({ grant: { ...GRANT, requestedByRunId: PARENT_RUN_ID } })).catch((e) => e);
    expect(err).toBeInstanceOf(GrantDepthExceededError);
    expect(err).toMatchObject({ code: 'grant_depth_exceeded' });
    expect(dbMockState.insertValues).toEqual([]);
    expect(resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('requestedByRunId under ANOTHER grant, or another org, throws GrantDepthExceededError', async () => {
    dbMockState.rowQueues.ai_agent_runs!.unshift([{ grantId: 'g-other', orgId: ORG_ID }]);
    await expect(createAndEnqueueAgentRun(input({ grant: { ...GRANT, requestedByRunId: PARENT_RUN_ID } }))).rejects.toBeInstanceOf(GrantDepthExceededError);
    dbMockState.rowQueues.ai_agent_runs!.unshift([{ grantId: 'g1', orgId: 'another-org' }]);
    await expect(createAndEnqueueAgentRun(input({ grant: { ...GRANT, requestedByRunId: PARENT_RUN_ID } }))).rejects.toBeInstanceOf(GrantDepthExceededError);
  });

  it('a missing requesting run throws GrantDepthExceededError', async () => {
    dbMockState.rowQueues.ai_agent_runs!.unshift([]);
    await expect(createAndEnqueueAgentRun(input({ grant: { ...GRANT, requestedByRunId: PARENT_RUN_ID } }))).rejects.toBeInstanceOf(GrantDepthExceededError);
  });

  it('requestedByRunId naming a run under the same grant and org (Wisp\'s own assessment) is admitted', async () => {
    dbMockState.rowQueues.ai_agent_runs!.unshift([{ grantId: 'g1', orgId: ORG_ID }]);
    await expect(createAndEnqueueAgentRun(input({ grant: { ...GRANT, requestedByRunId: PARENT_RUN_ID } }))).resolves.toMatchObject({ created: true });
    expect(dbMockState.insertValues[0]).toMatchObject({ grantId: 'g1', grantRevisionId: 'r1' });
  });
});
