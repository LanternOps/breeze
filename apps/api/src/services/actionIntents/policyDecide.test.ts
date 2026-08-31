import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicySnapshot } from '@breeze/shared';

const dialect = new PgDialect();
const renderSql = (value: unknown) => dialect.sqlToQuery(value as SQL).sql;

// ---------------------------------------------------------------------------
// DB mock — generic, table-name-keyed (mirrors runService.test.ts's pattern):
// real drizzle-orm + real schema modules are used, so `where`/`and`/`eq`/`gt`
// conditions are REAL SQL objects; only what row(s) a given table's next
// select/insert/update returns is faked, via a per-table FIFO queue.
// ---------------------------------------------------------------------------

const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  executed: [] as unknown[],
  insertValues: {} as Record<string, Record<string, unknown>[]>,
  updateSets: {} as Record<string, Record<string, unknown>[]>,
  updateWheres: {} as Record<string, unknown[]>,
  ambientContext: undefined as { scope: string } | undefined,
  // Per-invocation "which withSystemDbAccessContext call did this write
  // happen inside" tracking — lets a test assert that a set of writes shared
  // ONE real transaction rather than merely counting them. `txCounter`
  // increments once per NEW (non-nested) withSystemDbAccessContext call;
  // `currentTxId` is that call's id for the duration of its callback.
  txCounter: 0,
  currentTxId: null as number | null,
  executedTx: [] as (number | null)[],
  insertTx: {} as Record<string, (number | null)[]>,
  updateTx: {} as Record<string, (number | null)[]>,
}));

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
}

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) {
    throw new Error(`No queued rows for table ${table}`);
  }
  return queue.shift() as unknown[];
}

function pushRows(table: string, rows: unknown[]): void {
  (dbMockState.rowQueues[table] ??= []).push(rows);
}

function resetDbMock(): void {
  dbMockState.rowQueues = {};
  dbMockState.executed = [];
  dbMockState.insertValues = {};
  dbMockState.updateSets = {};
  dbMockState.updateWheres = {};
  dbMockState.ambientContext = undefined;
  dbMockState.txCounter = 0;
  dbMockState.currentTxId = null;
  dbMockState.executedTx = [];
  dbMockState.insertTx = {};
  dbMockState.updateTx = {};
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = tableNameOf(table);
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
      execute: vi.fn(async (statement: unknown) => {
        dbMockState.executed.push(statement);
        dbMockState.executedTx.push(dbMockState.currentTxId);
        return [];
      }),
      insert: vi.fn((table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          values: vi.fn((values: Record<string, unknown>) => {
            (dbMockState.insertValues[tableName] ??= []).push(values);
            (dbMockState.insertTx[tableName] ??= []).push(dbMockState.currentTxId);
            // intent_outbox is awaited directly (no .returning() chain) —
            // matches policyDecide.ts's own call shape.
            if (tableName === 'intent_outbox') return Promise.resolve(undefined);
            return { returning: vi.fn(async () => nextRows(tableName)) };
          }),
        };
      }),
      update: vi.fn((table: unknown) => {
        const tableName = tableNameOf(table);
        return {
          set: vi.fn((values: Record<string, unknown>) => {
            (dbMockState.updateSets[tableName] ??= []).push(values);
            (dbMockState.updateTx[tableName] ??= []).push(dbMockState.currentTxId);
            return {
              where: vi.fn((cond: unknown) => {
                (dbMockState.updateWheres[tableName] ??= []).push(cond);
                return { returning: vi.fn(async () => nextRows(tableName)) };
              }),
            };
          }),
        };
      }),
    },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    // Each call opens a NEW numbered "transaction" (mirrors the real
    // withSystemDbAccessContext opening one real Postgres transaction per
    // call — db/index.ts) unless already nested inside one (matches
    // inSystemDbContext's own skip-if-already-system behavior in
    // policyDecide.ts, so a nested call reuses its parent's txId rather than
    // minting a spurious new one).
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previousContext = dbMockState.ambientContext;
      const previousTxId = dbMockState.currentTxId;
      const isNested = previousContext?.scope === 'system';
      dbMockState.ambientContext = { scope: 'system' };
      if (!isNested) {
        dbMockState.txCounter += 1;
        dbMockState.currentTxId = dbMockState.txCounter;
      }
      try {
        return await fn();
      } finally {
        dbMockState.ambientContext = previousContext;
        dbMockState.currentTxId = previousTxId;
      }
    }),
  };
});

// ---------------------------------------------------------------------------
// External collaborator mocks
// ---------------------------------------------------------------------------

const envMock = vi.hoisted(() => ({ policyDecideEnabled: vi.fn(() => true) }));
vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return { ...actual, policyDecideEnabled: envMock.policyDecideEnabled };
});

const guardrailMock = vi.hoisted(() => ({ checkAgentGuardrails: vi.fn() }));
vi.mock('../aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiGuardrails')>();
  return { ...actual, checkAgentGuardrails: guardrailMock.checkAgentGuardrails };
});

const killStateMock = vi.hoisted(() => ({ readAiKillState: vi.fn() }));
vi.mock('../aiKillState', () => ({ readAiKillState: killStateMock.readAiKillState }));

const effectivePolicyMock = vi.hoisted(() => ({ resolveEffectiveAgentSystem: vi.fn() }));
vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgentSystem: effectivePolicyMock.resolveEffectiveAgentSystem,
}));

const recipientsMock = vi.hoisted(() => ({ resolveRecipientUserIds: vi.fn(async () => [] as string[]) }));
vi.mock('../aiAgents/recipients', () => ({ resolveRecipientUserIds: recipientsMock.resolveRecipientUserIds }));

const contractMock = vi.hoisted(() => ({ countContractDevices: vi.fn(async () => 100) }));
vi.mock('../contractQuantities', () => ({ countContractDevices: contractMock.countContractDevices }));

const notifyMock = vi.hoisted(() => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('../userNotifications', () => ({ createNotification: notifyMock.createNotification }));

const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: sentryMock.captureException }));

const metricsMock = vi.hoisted(() => ({ recordActionIntentEvent: vi.fn() }));
vi.mock('./metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metrics')>();
  return { ...actual, recordActionIntentEvent: metricsMock.recordActionIntentEvent };
});

const intentServiceMock = vi.hoisted(() => ({
  runDeferredHumanFanout: vi.fn(async () => {}),
  RELEASE_LEASE_MS: 10 * 60 * 1000,
}));
vi.mock('./intentService', () => ({
  runDeferredHumanFanout: intentServiceMock.runDeferredHumanFanout,
  RELEASE_LEASE_MS: intentServiceMock.RELEASE_LEASE_MS,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  attemptPolicyDecision,
  computePolicySnapshotDigest,
  PolicyDecisionTransientError,
} from './policyDecide';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_ID = 'intent-attempt-1';

const POLICY_SNAPSHOT: AiAgentPolicySnapshot = {
  schemaVersion: 3,
  agentId: AGENT_ID,
  kind: 'patch',
  effective: {
    enabled: true,
    mode: 'act',
    model: null,
    toolAllowlist: ['manage_services'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {
      maxDevicesPerRun: 1,
      maxConcurrentRuns: 1,
      maxRunsPerHour: 20,
      maxTurnsPerRun: 25,
      maxBudgetCentsPerRun: 50,
      maxBudgetCentsPerDay: 1000,
      wallClockSeconds: 600,
      maxFleetPercentPerDay: 5,
      maxActionsPerRun: 3,
      maxPolicyDecisionsPerDay: 10,
      maxConsecutiveFailures: 3,
      maxVerdictRunsPerHour: 200,
      maxConcurrentVerdictRuns: 4,
      verdictBudgetCentsPerRun: 2,
      // v6 (phase 2 wave P2-2) sweep-profile caps — `AiAgentLimits` requires
      // them, so this fixture has to carry them even though nothing on the
      // policy-decision path reads a sweep limit.
      maxConcurrentSweepRuns: 2,
      maxSweepRunsPerHour: 20,
      sweepBudgetCentsPerRun: 30,
      sweepMaxTurns: 8,
      // v7 (phase 2 wave P2-3) narrative-profile caps — same reason as the v6
      // sweep block above: `AiAgentLimits` requires them, and nothing on the
      // policy-decision path reads a narrative limit.
      maxConcurrentNarrativeRuns: 1,
      maxNarrativeRunsPerHour: 5,
      narrativeBudgetCentsPerRun: 20,
      narrativeMaxTurns: 3,
      // v8 (phase 2 wave P2-4) triage-profile caps — same reason as the v6/v7
      // blocks above: `AiAgentLimits` requires them, and nothing on the
      // policy-decision path reads a triage limit.
      maxConcurrentTriageRuns: AI_AGENT_LIMIT_DEFAULTS.maxConcurrentTriageRuns,
      maxTriageRunsPerHour: AI_AGENT_LIMIT_DEFAULTS.maxTriageRunsPerHour,
      triageBudgetCentsPerRun: AI_AGENT_LIMIT_DEFAULTS.triageBudgetCentsPerRun,
      triageMaxTurns: AI_AGENT_LIMIT_DEFAULTS.triageMaxTurns,
    },
    triggers: { alertSeverities: [], respectMaintenanceWindows: false },
    recipients: { userIds: ['recipient-1'], roleIds: [] },
    actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart'] },
    instructions: null,
    cooldownSeconds: 900,
  },
  provenance: {} as AiAgentPolicySnapshot['provenance'],
  resolvedAt: new Date().toISOString(),
};

function makeIntentRow(overrides?: Record<string, unknown>) {
  return {
    id: INTENT_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    requestedByUserId: null,
    requestingAgentRunId: RUN_ID,
    source: 'ai_agent',
    actionName: 'manage_services',
    arguments: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'spooler' },
    argumentDigest: 'digest-1',
    targetSummary: 'manage_services(action=restart, ...)',
    riskTier: 3,
    status: 'pending_approval',
    policyDecisionState: 'unattempted',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

function makeRunRow(overrides?: Record<string, unknown>) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    policySnapshot: POLICY_SNAPSHOT,
    ...overrides,
  };
}

function makeAgentRow(overrides?: Record<string, unknown>) {
  return { id: AGENT_ID, name: 'Patch agent', kind: 'patch', ...overrides };
}

/** Queues the loadRunAndAgent reads in the exact order policyDecide.ts performs them. */
function queueRunAndAgent(opts?: {
  run?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  org?: Record<string, unknown>;
  device?: Record<string, unknown> | null;
}): void {
  const run = makeRunRow(opts?.run);
  pushRows('ai_agent_runs', [run]);
  pushRows('ai_agents', [makeAgentRow(opts?.agent)]);
  pushRows('organizations', [{ partnerId: PARTNER_ID, ...opts?.org }]);
  if (opts?.device !== null) {
    pushRows('devices', [{ siteId: SITE_ID, ...opts?.device }]);
  }
}

/** Queues the cap-check + reservation + CAS + outbox reads/writes for a
 *  successful authorize transaction. */
function queueSuccessfulAuthorize(opts?: { exposedDeviceIds?: string[]; dayCount?: number }): void {
  pushRows('ai_unattended_exposure', (opts?.exposedDeviceIds ?? []).map((deviceId) => ({ deviceId })));
  pushRows('ai_unattended_exposure', [{ n: opts?.dayCount ?? 0 }]);
  pushRows('ai_unattended_exposure', [{ id: 'reservation-1' }]);
  pushRows('action_intents', [{ id: INTENT_ID }]);
}

beforeEach(() => {
  resetDbMock();
  vi.clearAllMocks();
  envMock.policyDecideEnabled.mockReturnValue(true);
  guardrailMock.checkAgentGuardrails.mockReturnValue({
    tier: 3,
    allowed: false,
    requiresApproval: false,
    disposition: 'propose',
    description: 'Manage services on a device',
  });
  killStateMock.readAiKillState.mockResolvedValue({ killed: false, epoch: 3 });
  effectivePolicyMock.resolveEffectiveAgentSystem.mockResolvedValue({
    schemaVersion: 3,
    agentId: AGENT_ID,
    kind: 'patch',
    effective: POLICY_SNAPSHOT.effective,
    provenance: POLICY_SNAPSHOT.provenance,
    resolvedAt: POLICY_SNAPSHOT.resolvedAt,
  });
  contractMock.countContractDevices.mockResolvedValue(100);
  recipientsMock.resolveRecipientUserIds.mockResolvedValue(['recipient-1']);
  intentServiceMock.runDeferredHumanFanout.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// computePolicySnapshotDigest — pure helper
// ---------------------------------------------------------------------------

describe('computePolicySnapshotDigest', () => {
  it('is deterministic for the same snapshot content', () => {
    const a = computePolicySnapshotDigest(POLICY_SNAPSHOT);
    const b = computePolicySnapshotDigest(JSON.parse(JSON.stringify(POLICY_SNAPSHOT)));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the snapshot content changes', () => {
    const a = computePolicySnapshotDigest(POLICY_SNAPSHOT);
    const changed = { ...POLICY_SNAPSHOT, effective: { ...POLICY_SNAPSHOT.effective, enabled: false } };
    expect(computePolicySnapshotDigest(changed)).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// attemptPolicyDecision — the full pipeline
// ---------------------------------------------------------------------------

describe('attemptPolicyDecision', () => {
  it('review fix (#3827): invariant guard — throws immediately, before any read, if called with an already-held DB access context', async () => {
    dbMockState.ambientContext = { scope: 'system' };
    await expect(attemptPolicyDecision(INTENT_ID)).rejects.toThrow(/ALREADY-HELD DB access context/);
    expect(sentryMock.captureException).toHaveBeenCalled();
    // Never even read the intent — the guard fires before loadIntentForAttempt.
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
  });

  it('idempotence preconditions: no-ops (no writes, no fanout) when already resolved, not pending, or not agent-originated', async () => {
    pushRows('action_intents', [makeIntentRow({ policyDecisionState: 'authorized' })]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);

    pushRows('action_intents', [makeIntentRow({ status: 'cancelled' })]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();

    pushRows('action_intents', [makeIntentRow({ requestingAgentRunId: null })]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
  });

  it('gone intent: no-op', async () => {
    pushRows('action_intents', []);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
  });

  it('flag off + a genuinely unattempted intent: degrades to human_required (review fix, #3827 — the call site in intentReleaseWorker.ts is unconditional now, so this function owns flag-off inertness)', async () => {
    envMock.policyDecideEnabled.mockReturnValue(false);
    pushRows('action_intents', [makeIntentRow()]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    // The intent IS read (to confirm it's genuinely `unattempted`), but the
    // flag check short-circuits before the run/agent load or any write.
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
  });

  it('flag off + an intent NOT in `unattempted` state: true no-op, no writes, no fanout', async () => {
    envMock.policyDecideEnabled.mockReturnValue(false);
    pushRows('action_intents', [makeIntentRow({ status: 'approved', policyDecisionState: 'authorized' })]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
  });

  it('expired intent -> human path (deterministic failure)', async () => {
    pushRows('action_intents', [makeIntentRow({ approvalExpiresAt: new Date(Date.now() - 1000) })]);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
  });

  it('deterministic: agent run invalid (missing/cross-org) -> human path', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    pushRows('ai_agent_runs', []);
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
  });

  it('deterministic: key not registry-decidable (unknown action) -> human path', async () => {
    pushRows('action_intents', [
      makeIntentRow({ actionName: 'manage_services', arguments: { deviceId: DEVICE_ID, action: 'list' } }),
    ]);
    queueRunAndAgent();
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    // Never even reached the guardrail re-run or the authorize transaction.
    expect(guardrailMock.checkAgentGuardrails).not.toHaveBeenCalled();
  });

  it('deterministic: agent identity changed (current effective agent differs from the run) -> human path', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    effectivePolicyMock.resolveEffectiveAgentSystem.mockResolvedValueOnce({
      schemaVersion: 3,
      agentId: 'a-different-agent',
      kind: 'patch',
      effective: POLICY_SNAPSHOT.effective,
      provenance: POLICY_SNAPSHOT.provenance,
      resolvedAt: POLICY_SNAPSHOT.resolvedAt,
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
  });

  it('SAFETY GATE (review fix, #3827): agent CURRENTLY in shadow mode -> human path, never authorized — the live guardrail re-run alone does NOT catch this (checkAgentGuardrails returns `propose`, not `deny`, for a shadow-mode mutation)', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    effectivePolicyMock.resolveEffectiveAgentSystem.mockResolvedValueOnce({
      schemaVersion: 3,
      agentId: AGENT_ID,
      kind: 'patch',
      effective: { ...POLICY_SNAPSHOT.effective, mode: 'shadow' },
      provenance: POLICY_SNAPSHOT.provenance,
      resolvedAt: POLICY_SNAPSHOT.resolvedAt,
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    // Never reached the authorize transaction: no reservation, no CAS.
    expect(dbMockState.insertValues.ai_unattended_exposure ?? []).toHaveLength(0);
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
    // Gated BEFORE the guardrail re-run, exactly like the key-authorization gate.
    expect(guardrailMock.checkAgentGuardrails).not.toHaveBeenCalled();
  });

  it('deterministic: key not in the agent\'s CURRENT supervisedActionKeys -> human path', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    effectivePolicyMock.resolveEffectiveAgentSystem.mockResolvedValueOnce({
      schemaVersion: 3,
      agentId: AGENT_ID,
      kind: 'patch',
      effective: { ...POLICY_SNAPSHOT.effective, actAssets: { scriptIds: [], supervisedActionKeys: [] } },
      provenance: POLICY_SNAPSHOT.provenance,
      resolvedAt: POLICY_SNAPSHOT.resolvedAt,
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(guardrailMock.checkAgentGuardrails).not.toHaveBeenCalled();
  });

  it('review fix (#3827): key authorized on the CURRENT policy but NOT in the run\'s own policySnapshot -> human path (mirrors agentReleaseAuthority.ts checking both)', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    // Current effective policy (the default mock) authorizes the key; the
    // RUN's own snapshot never opted it in — simulates an operator adding
    // the key to supervisedActionKeys mid-run, after this run's snapshot was
    // already taken.
    queueRunAndAgent({
      run: {
        policySnapshot: {
          ...POLICY_SNAPSHOT,
          effective: { ...POLICY_SNAPSHOT.effective, actAssets: { scriptIds: [], supervisedActionKeys: [] } },
        },
      },
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    // Never reached the guardrail re-run or the authorize transaction.
    expect(guardrailMock.checkAgentGuardrails).not.toHaveBeenCalled();
    expect(dbMockState.insertValues.ai_unattended_exposure ?? []).toHaveLength(0);
  });

  it('review fix (#3827): key authorized in the run\'s snapshot but since REMOVED from the CURRENT policy -> human path (the pre-existing current-policy check, unaffected by adding the snapshot check)', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent(); // run's snapshot still has the key (default fixture)
    effectivePolicyMock.resolveEffectiveAgentSystem.mockResolvedValueOnce({
      schemaVersion: 3,
      agentId: AGENT_ID,
      kind: 'patch',
      effective: { ...POLICY_SNAPSHOT.effective, actAssets: { scriptIds: [], supervisedActionKeys: [] } },
      provenance: POLICY_SNAPSHOT.provenance,
      resolvedAt: POLICY_SNAPSHOT.resolvedAt,
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(dbMockState.insertValues.ai_unattended_exposure ?? []).toHaveLength(0);
  });

  it('deterministic: live guardrail re-run denies (not kill-switch) -> human path', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    guardrailMock.checkAgentGuardrails.mockReturnValue({
      tier: 3, allowed: false, requiresApproval: false, disposition: 'deny', reason: 'Denied: protected resource',
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
  });

  it('deterministic: kill-switch engaged -> human path, distinguished from a plain guardrail denial', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    killStateMock.readAiKillState.mockResolvedValue({ killed: true, epoch: 9 });
    guardrailMock.checkAgentGuardrails.mockReturnValue({
      tier: 3, allowed: false, requiresApproval: false, disposition: 'deny', reason: 'Autonomous AI agents are kill-switched',
    });
    await attemptPolicyDecision(INTENT_ID);
    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
  });

  it('deterministic: fleet-percent cap exhausted -> human path, no exposure row written', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    // allowance = floor(100 * 5 / 100) = 5; 5 devices already exposed today,
    // none of them this device -> projected 6 > 5.
    pushRows('ai_unattended_exposure', [
      { deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }, { deviceId: 'd4' }, { deviceId: 'd5' },
    ]);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(dbMockState.insertValues.ai_unattended_exposure ?? []).toHaveLength(0);
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
  });

  it('a device already exposed today does not count twice against the fleet cap', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    // Fleet allowance is 5; THIS device is already one of the 5 exposed
    // today, so authorizing it again must not push the projected count to 6.
    pushRows('ai_unattended_exposure', [
      { deviceId: DEVICE_ID }, { deviceId: 'd2' }, { deviceId: 'd3' }, { deviceId: 'd4' }, { deviceId: 'd5' },
    ]);
    pushRows('ai_unattended_exposure', [{ n: 0 }]);
    pushRows('ai_unattended_exposure', [{ id: 'reservation-1' }]);
    pushRows('action_intents', [{ id: INTENT_ID }]);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(dbMockState.updateSets.action_intents?.[0]).toMatchObject({ status: 'approved' });
  });

  it('deterministic: day cap exhausted -> human path, no exposure row written', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    pushRows('ai_unattended_exposure', []); // fleet check passes
    pushRows('ai_unattended_exposure', [{ n: 10 }]); // >= maxPolicyDecisionsPerDay (10)

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(dbMockState.insertValues.ai_unattended_exposure ?? []).toHaveLength(0);
  });

  it('success: all writes happen in one authorize transaction (advisory lock, exposure insert, CAS, outbox)', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    queueSuccessfulAuthorize();

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    // Advisory lock taken — exactly one statement, and it's actually the
    // advisory lock (compiled through the real Postgres dialect, not just
    // counted), and it ran BEFORE the cap reads that follow it inside the
    // same transaction.
    expect(dbMockState.executed).toHaveLength(1);
    expect(renderSql(dbMockState.executed[0])).toMatch(/pg_advisory_xact_lock\(hashtextextended\(/);

    // Exposure reservation written.
    expect(dbMockState.insertValues.ai_unattended_exposure?.[0]).toMatchObject({
      orgId: ORG_ID,
      partnerId: PARTNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      deviceId: DEVICE_ID,
      intentId: INTENT_ID,
      source: 'policy_intent',
    });

    // ATOMICITY (the quorum's central requirement): the advisory lock, the
    // exposure reservation, the intent CAS, and the outbox write all happened
    // inside the SAME `withSystemDbAccessContext` invocation — i.e. one real
    // Postgres transaction — not four separate ones. Splitting
    // `runAuthorizeTransaction` into multiple `inSystemDbContext` calls would
    // destroy this and still leave the earlier (weaker) assertions green, so
    // this checks the transaction BOUNDARY, not just that the writes happened.
    expect(dbMockState.txCounter).toBeGreaterThanOrEqual(1);
    const authorizeTxIds = new Set([
      dbMockState.executedTx[0],
      dbMockState.insertTx.ai_unattended_exposure?.[0],
      dbMockState.updateTx.action_intents?.[0],
      dbMockState.insertTx.intent_outbox?.[0],
    ]);
    expect(authorizeTxIds.size).toBe(1);
    expect([...authorizeTxIds][0]).not.toBeNull();

    // Intent CASed to approved with full provenance, NEVER a synthetic human decider.
    const set = dbMockState.updateSets.action_intents?.[0];
    expect(set).toMatchObject({
      status: 'approved',
      policyDecisionState: 'authorized',
      decidedByUserId: null,
      decidedAssuranceLevel: null,
      decidedVia: 'policy',
      policyAuthorizationKey: 'manage_services:restart',
      policyReservationId: 'reservation-1',
      policyKillEpoch: 3,
    });
    expect(set?.policySnapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    // Outbox intent_approved written.
    expect(dbMockState.insertValues.intent_outbox?.[0]).toMatchObject({
      intentId: INTENT_ID,
      eventType: 'intent_approved',
    });
    // Audit trail: initiatedBy: 'policy', never a person.
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'approved',
        actorType: 'ai_agent',
        initiatedBy: 'policy',
        details: expect.objectContaining({ decidedVia: 'policy', policyAuthorizationKey: 'manage_services:restart' }),
      }),
    );
    // Notification to recipients. Review fix (#3827): `link: null`, not
    // '/approvals' — a policy-decided intent has no approval_requests row for
    // that link to point at; no run-detail page exists yet (wave 6).
    expect(notifyMock.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'recipient-1', orgId: ORG_ID, link: null }),
    );
  });

  it('double-attempt idempotence: a second attempt after authorization sees state !== unattempted and no-ops', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    queueSuccessfulAuthorize();
    await attemptPolicyDecision(INTENT_ID);
    expect(dbMockState.insertValues.ai_unattended_exposure).toHaveLength(1);

    vi.clearAllMocks();
    envMock.policyDecideEnabled.mockReturnValue(true);
    pushRows('action_intents', [makeIntentRow({ status: 'approved', policyDecisionState: 'authorized' })]);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    // Still exactly ONE reservation total — the second attempt wrote nothing.
    expect(dbMockState.insertValues.ai_unattended_exposure).toHaveLength(1);
  });

  it('never synthesizes a human approval row: no approval_requests writes on the success path', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    queueSuccessfulAuthorize();

    await attemptPolicyDecision(INTENT_ID);

    expect(dbMockState.insertValues.approval_requests).toBeUndefined();
  });

  it('transient: a DB read failure leaves the intent unattempted and throws the discriminated PolicyDecisionTransientError (review fix, #3827 — real at-least-once relies on this propagating to the outbox recovery branch)', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    // ai_agent_runs queue left empty on purpose -> nextRows throws, simulating
    // a transient DB fault mid-pipeline.
    await expect(attemptPolicyDecision(INTENT_ID)).rejects.toBeInstanceOf(PolicyDecisionTransientError);
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(sentryMock.captureException).toHaveBeenCalled();
  });

  it('transient: a lost CAS deep inside the authorize transaction is a silent no-op, not a degrade', async () => {
    pushRows('action_intents', [makeIntentRow()]);
    queueRunAndAgent();
    pushRows('ai_unattended_exposure', []);
    pushRows('ai_unattended_exposure', [{ n: 0 }]);
    pushRows('ai_unattended_exposure', [{ id: 'reservation-1' }]);
    // Empty .returning() on the final CAS — someone else already resolved it.
    pushRows('action_intents', []);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // P2-2 (Task A3, #4189): explicit device scope
  // -------------------------------------------------------------------------

  it('authorizes a SCOPED intent from a DEVICE-LESS run — never the "run has no deviceId" throw', async () => {
    // Pre-P2-2 this shape was unreachable-by-construction and
    // runAuthorizeTransaction threw on it. A sweep makes it the normal case:
    // the run has no device, the intent carries the target.
    pushRows('action_intents', [
      makeIntentRow({ scopeKind: 'device', scopeDeviceId: DEVICE_ID }),
    ]);
    pushRows('ai_agent_runs', [makeRunRow({ deviceId: null })]);
    pushRows('ai_agents', [makeAgentRow()]);
    pushRows('organizations', [{ partnerId: PARTNER_ID }]);
    // The scope branch projects org_id alongside site_id.
    pushRows('devices', [{ orgId: ORG_ID, siteId: SITE_ID }]);
    queueSuccessfulAuthorize();

    await attemptPolicyDecision(INTENT_ID);

    // No degrade, no transient throw, and the intent WAS authorized.
    expect(intentServiceMock.runDeferredHumanFanout).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(dbMockState.updateSets.action_intents?.[0]).toMatchObject({ status: 'approved' });
    // Both device-derived decisions used the SCOPE device: the live guardrail
    // re-run (which denies a null deviceId outright) and the exposure
    // reservation the fleet cap is computed from.
    expect(guardrailMock.checkAgentGuardrails).toHaveBeenCalledWith(
      'manage_services',
      expect.anything(),
      expect.objectContaining({ deviceId: DEVICE_ID, deviceSiteId: SITE_ID }),
    );
    expect(dbMockState.insertValues.ai_unattended_exposure?.[0]).toMatchObject({ deviceId: DEVICE_ID });
  });

  it('deterministic: a tombstoned scope degrades to the human path, it never authorizes', async () => {
    pushRows('action_intents', [makeIntentRow({ scopeKind: 'device', scopeDeviceId: null })]);
    pushRows('ai_agent_runs', [makeRunRow({ deviceId: null })]);
    pushRows('ai_agents', [makeAgentRow()]);
    pushRows('organizations', [{ partnerId: PARTNER_ID }]);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it('deterministic: a scoped device that moved to another org degrades, it never authorizes', async () => {
    pushRows('action_intents', [makeIntentRow({ scopeKind: 'device', scopeDeviceId: DEVICE_ID })]);
    pushRows('ai_agent_runs', [makeRunRow({ deviceId: null })]);
    pushRows('ai_agents', [makeAgentRow()]);
    pushRows('organizations', [{ partnerId: PARTNER_ID }]);
    pushRows('devices', [{ orgId: 'some-other-org', siteId: SITE_ID }]);

    await attemptPolicyDecision(INTENT_ID);

    expect(intentServiceMock.runDeferredHumanFanout).toHaveBeenCalledWith(INTENT_ID);
    expect(dbMockState.updateSets.action_intents ?? []).toHaveLength(0);
  });
});
