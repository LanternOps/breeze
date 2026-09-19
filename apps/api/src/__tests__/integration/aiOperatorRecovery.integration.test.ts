/**
 * The AI Operator recovery scans — real Postgres (#5205 W06, sub-issue #5211,
 * spec §6.3, acceptance scenarios 4 and 7).
 *
 * Spec §6.3 names four recovery sets, and the reason they need a real database
 * is that each one is a PREDICATE, not a branch: a mocked Drizzle chain
 * returns whatever rows the mock was handed regardless of the `WHERE`, which
 * is precisely the class of bug that has shipped here before. Every test below
 * seeds rows that SHOULD and SHOULD NOT match, and asserts the boundary.
 *
 * The reconciler is also the thing that makes acceptance scenario 4 true —
 * "duplicate/out-of-order events, lost Redis delivery, and source-event failure
 * converge through reconciliation without duplicate effects". Nothing here
 * publishes to Redis at all: the scans re-derive from source rows, which is
 * exactly the property under test.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiOperatorOperations,
  aiOperatorTasks,
  devices,
} from '../../db/schema';
import { taskCheckpointSchema } from '@breeze/shared';
import {
  QUEUED_GRACE_MS,
  UNSETTLED_CHASE_HORIZON_MS,
  runReconcilerPass,
} from '../../services/aiOperator/taskReconciler';
import { handleTaskWake } from '../../services/aiOperator/taskCoordinator';
import {
  createOrganization,
  createPartner,
  createSite,
  createUser,
} from './db-utils';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  agentId: string;
  deviceId: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@oprecov.test`,
  });

  // Partner baseline agent — see aiOperatorCoordinator.integration.test.ts for
  // why the effective agent must live at the partner level.
  const [agent] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: partner.id,
      orgId: null,
      kind: 'triage',
      name: 'Operator',
      enabled: true,
      mode: 'shadow',
      toolAllowlist: ['manage_services'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
      triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
      recipients: { userIds: [], roleIds: [] },
      cooldownSeconds: 0,
      createdBy: requester.id,
    }).returning());

  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `oprecov-agent-${unique}`,
    hostname: `oprecov-host-${unique}`,
    osType: 'linux',
    osVersion: '22.04',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    requesterId: requester.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
  };
}

function checkpointFor(t: Tenant, overrides: Record<string, unknown> = {}) {
  return taskCheckpointSchema.parse({
    version: 1,
    recipeInput: {
      deviceId: t.deviceId,
      serviceName: 'spooler',
      triggeringAlertId: null,
      maxRestartAttempts: 1,
    },
    criterion: {
      adapter: 'service_running',
      adapterVersion: 1,
      deviceId: t.deviceId,
      serviceName: 'spooler',
      freshnessSeconds: 120,
      alertId: null,
      resolvableWithoutAlert: false,
    },
    findings: [],
    satisfiedCriteria: [],
    unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0,
    lastVerification: null,
    lastOperationKey: null,
    fixWatchId: null,
    ...overrides,
  });
}


/**
 * A minimal `action_intents` row.
 *
 * `ai_operator_operations.intent_id` carries a DEFERRABLE composite FK to
 * `(action_intents.id, org_id)`, so an operation cannot name an intent that
 * does not exist — verified here: the first version of this fixture used a
 * bare `randomUUID()` and Postgres rejected it with 23503
 * `ai_operator_operations_intent_org_fk`. That FK is a real invariant (an
 * operation's intent IS its authority record), so the fixture creates the row
 * rather than the test working around the constraint.
 */
async function createIntent(t: Tenant, status = 'completed'): Promise<string> {
  // An `ai_agent`-origin intent MUST name its originating run:
  // `action_intents_agent_origin_chk` asserts
  // `(origin_principal_kind = 'ai_agent') = (requesting_agent_run_id IS NOT NULL)`,
  // which is what ties every agent-made proposal to the immutable policy
  // snapshot the release path evaluates. The fixture satisfies the invariant
  // rather than dodging it by claiming a human origin.
  const [run] = await withSystemDbAccessContext(() =>
    db.insert(aiAgentRuns).values({
      agentId: t.agentId,
      orgId: t.orgId,
      deviceId: t.deviceId,
      triggerKind: 'manual' as const,
      dedupeKey: `oprecov-run-${randomUUID()}`,
      modeAtStart: 'shadow' as const,
      policySnapshot: {
        schemaVersion: 1,
        agentId: t.agentId,
        kind: 'triage',
        effective: {
          enabled: true, mode: 'shadow', model: null, toolAllowlist: ['manage_services'],
          protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
          limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] },
          instructions: null, cooldownSeconds: 0,
        },
        resolvedAt: new Date().toISOString(),
      } as never,
      status: 'completed' as const,
    }).returning({ id: aiAgentRuns.id }));

  const [row] = await withSystemDbAccessContext(() =>
    db.insert(actionIntents).values({
      orgId: t.orgId,
      // EXACTLY ONE actor: `action_intents_one_actor_chk` allows one of
      // requested_by_user_id / requesting_api_key_id / requesting_agent_run_id.
      // An agent-originated intent names its run, never also a human.
      requestingAgentRunId: run!.id,
      source: 'ai_agent' as never,
      originPrincipalKind: 'ai_agent' as never,
      originPrincipalId: t.agentId,
      actionName: 'manage_services',
      arguments: {},
      argumentDigest: 'd'.repeat(64),
      targetSummary: 'spooler on the test device',
      impactSummary: 'restarts a service',
      riskTier: 3,
      idempotencyKey: `oprecov-${randomUUID()}`,
      correlationId: randomUUID(),
      status: status as never,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: actionIntents.id }));
  return row!.id;
}

async function createTask(
  t: Tenant,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {},
): Promise<typeof aiOperatorTasks.$inferSelect> {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiOperatorTasks).values({
      orgId: t.orgId,
      agentId: t.agentId,
      agentKind: 'triage',
      agentName: 'Operator',
      workflowKey: 'service_recovery',
      workflowVersion: 1,
      originKind: 'manual' as const,
      requesterUserId: t.requesterId,
      objective: 'Restart the print spooler',
      deviceId: t.deviceId,
      state: 'queued',
      phase: 'investigate',
      currentStepKey: 'investigate',
      checkpoint: checkpointFor(t) as unknown as Record<string, unknown>,
      revision: 1,
      leaseEpoch: 0,
      attemptOrdinal: 0,
      deadlineAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    }).returning());
  return row!;
}

/** `updated_at` has a DB default and is set by every writer, so a test that
 *  needs a row to LOOK old has to age it explicitly. */
async function ageTask(taskId: string, ms: number): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.update(aiOperatorTasks)
      .set({ updatedAt: new Date(Date.now() - ms) })
      .where(eq(aiOperatorTasks.id, taskId)));
}

async function readTask(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, id)).limit(1);
    return row ?? null;
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI Operator reconciler — scan set 1: queued past admission wake', () => {
  runDb('picks up a queued task past the grace period and advances it', async () => {
    const t = await seedTenant();
    const task = await createTask(t, { nextWakeAt: new Date(Date.now() - 1_000) });
    await ageTask(task.id, QUEUED_GRACE_MS + 10_000);

    const pass = await runReconcilerPass();
    expect(pass.queuedPastWake).toBe(1);

    const after = await readTask(task.id);
    // It admitted a reasoning run and yielded — no longer stranded in `queued`.
    expect(after!.state).not.toBe('queued');
    expect(after!.leaseEpoch).toBeGreaterThan(task.leaseEpoch);
  });

  runDb('leaves a freshly-admitted queued task alone (the grace period is real)', async () => {
    const t = await seedTenant();
    // Admitted just now: `updated_at` is current, so it is inside the grace.
    const task = await createTask(t, { nextWakeAt: new Date() });

    const pass = await runReconcilerPass();
    expect(pass.queuedPastWake).toBe(0);

    const after = await readTask(task.id);
    expect(after!.state).toBe('queued');
    expect(after!.leaseEpoch).toBe(0);
  });
});

describe('AI Operator reconciler — scan set 2: waiting past next_wake_at', () => {
  runDb('picks up a waiting task whose wake is due, and leaves one whose wake is not', async () => {
    const t = await seedTenant();

    const due = await createTask(t, {
      state: 'waiting',
      waitReason: 'information',
      currentStepKey: 'investigate',
      nextWakeAt: new Date(Date.now() - 60_000),
    });
    const notDue = await createTask(t, {
      state: 'waiting',
      waitReason: 'approval',
      currentStepKey: 'execute',
      nextWakeAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const pass = await runReconcilerPass();
    expect(pass.waitingPastWake).toBe(1);

    // The due one moved (its `investigate` step found no run and admitted one).
    const dueAfter = await readTask(due.id);
    expect(dueAfter!.leaseEpoch).toBeGreaterThan(0);

    // The not-due one is untouched — the wait is a real wait, not a hint.
    const notDueAfter = await readTask(notDue.id);
    expect(notDueAfter!.state).toBe('waiting');
    expect(notDueAfter!.leaseEpoch).toBe(0);
  });

  runDb('a waiting task with a NULL next_wake_at is never selected', async () => {
    // `next_wake_at IS NOT NULL` is in the predicate on purpose: a wait with no
    // wake time is waiting on an EVENT only, and polling it every 15 seconds
    // forever would be a busy loop against a task that has nothing to do.
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'waiting',
      waitReason: 'information',
      nextWakeAt: null,
    });

    const pass = await runReconcilerPass();
    expect(pass.waitingPastWake).toBe(0);
    expect((await readTask(task.id))!.leaseEpoch).toBe(0);
  });
});

describe('AI Operator reconciler — scan set 3: running past lease expiry', () => {
  runDb('reclaims an expired lease, advancing lease_epoch but not attempt_ordinal', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'running',
      currentStepKey: 'investigate',
      leaseOwner: 'coordinator:dead',
      leaseExpiresAt: new Date(Date.now() - 5_000),
      leaseEpoch: 7,
      attemptOrdinal: 1,
    });

    const pass = await runReconcilerPass();
    expect(pass.runningPastLease).toBe(1);

    const after = await readTask(task.id);
    expect(after!.leaseEpoch).toBeGreaterThan(7);
    // Spec §6.2: a reclaim is not a new reasoning attempt.
    expect(after!.attemptOrdinal).toBe(1);
    expect(after!.revision).toBe(task.revision);
  });

  runDb('leaves a task whose lease is still live', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'running',
      leaseOwner: 'coordinator:alive',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseEpoch: 3,
    });

    const pass = await runReconcilerPass();
    expect(pass.runningPastLease).toBe(0);
    expect((await readTask(task.id))!.leaseEpoch).toBe(3);
  });
});

describe('AI Operator reconciler — scan set 4: terminal task with an unsettled operation', () => {
  async function seedTerminalWithOperation(
    t: Tenant,
    opts: { resultState: 'pending' | 'unknown' | 'succeeded'; executionRefId: string | null; ageMs: number },
  ) {
    const task = await createTask(t, {
      state: 'handed_off',
      outcome: 'unknown_effect',
      currentStepKey: 'observe',
    });
    // Hoisted: the insert callback below is a NON-async arrow, so the
    // `await` cannot live inside the object literal.
    const intentId = await createIntent(t);
    const [op] = await withSystemDbAccessContext(() =>
      db.insert(aiOperatorOperations).values({
        orgId: t.orgId,
        taskId: task.id,
        taskStepKey: 'execute',
        operationKey: `op-${randomUUID().slice(0, 8)}`,
        attemptOrdinal: 0,
        // `recordOperationResult` is keyed by intent id, so the settler
        // skips an operation that has none.
        intentId,
        argumentDigest: 'a'.repeat(64),
        executionRefKind: opts.executionRefId ? 'device_command' : null,
        executionRefId: opts.executionRefId,
        dispatchState: 'dispatched',
        resultState: opts.resultState,
      }).returning());

    await withSystemDbAccessContext(() =>
      db.update(aiOperatorOperations)
        .set({ updatedAt: new Date(Date.now() - opts.ageMs) })
        .where(eq(aiOperatorOperations.id, op!.id)));

    return { task, operationId: op!.id };
  }

  async function readOperation(id: string) {
    return withSystemDbAccessContext(async () => {
      const [row] = await db.select().from(aiOperatorOperations)
        .where(eq(aiOperatorOperations.id, id)).limit(1);
      return row ?? null;
    });
  }

  runDb('force-settles an operation past the chase horizon to `unknown`, breaking the livelock', async () => {
    const t = await seedTenant();
    // A device command id that does not resolve — evidence erased, which is
    // exactly the case that can never settle on its own.
    const { operationId } = await seedTerminalWithOperation(t, {
      resultState: 'pending',
      executionRefId: randomUUID(),
      ageMs: UNSETTLED_CHASE_HORIZON_MS + 60_000,
    });

    const pass = await runReconcilerPass();
    expect(pass.terminalUnsettled).toBe(1);

    const after = await readOperation(operationId);
    // `unknown`, NOT `failed`: the effect could not be PROVEN absent, and
    // spec §6.5 forbids reporting "nothing happened" in that case.
    expect(after!.resultState).toBe('unknown');
    expect((after!.result as { source?: string }).source).toBe('reconciler');

    // And it drops out of the set — no livelock.
    const second = await runReconcilerPass();
    expect(second.terminalUnsettled).toBe(0);
  });

  runDb('does NOT force-settle before the chase horizon', async () => {
    const t = await seedTenant();
    const { operationId } = await seedTerminalWithOperation(t, {
      resultState: 'pending',
      executionRefId: randomUUID(),
      ageMs: 60_000,
    });

    const pass = await runReconcilerPass();
    // Selected (it is genuinely unsettled) but deliberately not settled yet.
    expect(pass.terminalUnsettled).toBe(0);
    expect((await readOperation(operationId))!.resultState).toBe('pending');
  });

  runDb('ignores an operation with NO execution reference', async () => {
    // Nothing was ever sent, so nothing is outstanding — it is not "unsettled"
    // in the sense spec §6.3 means, and chasing it forever would be noise.
    const t = await seedTenant();
    const { operationId } = await seedTerminalWithOperation(t, {
      resultState: 'pending',
      executionRefId: null,
      ageMs: UNSETTLED_CHASE_HORIZON_MS + 60_000,
    });

    const pass = await runReconcilerPass();
    expect(pass.terminalUnsettled).toBe(0);
    expect((await readOperation(operationId))!.resultState).toBe('pending');
  });

  runDb('ignores an already-settled operation', async () => {
    const t = await seedTenant();
    const { operationId } = await seedTerminalWithOperation(t, {
      resultState: 'succeeded',
      executionRefId: randomUUID(),
      ageMs: UNSETTLED_CHASE_HORIZON_MS + 60_000,
    });

    const pass = await runReconcilerPass();
    expect(pass.terminalUnsettled).toBe(0);
    expect((await readOperation(operationId))!.resultState).toBe('succeeded');
  });

  runDb('a LIVE task with an unsettled operation is not in this set', async () => {
    // Set 4 is about task CLOSURE hiding a late result. A live task is still
    // being advanced by sets 1-3 and must not be double-handled here.
    const t = await seedTenant();
    const task = await createTask(t, { state: 'waiting', nextWakeAt: null });
    const intentId = await createIntent(t);
    const [op] = await withSystemDbAccessContext(() =>
      db.insert(aiOperatorOperations).values({
        orgId: t.orgId,
        taskId: task.id,
        taskStepKey: 'execute',
        operationKey: `op-${randomUUID().slice(0, 8)}`,
        attemptOrdinal: 0,
        intentId,
        argumentDigest: 'b'.repeat(64),
        executionRefKind: 'device_command',
        executionRefId: randomUUID(),
        dispatchState: 'dispatched',
        resultState: 'pending',
      }).returning());
    await withSystemDbAccessContext(() =>
      db.update(aiOperatorOperations)
        .set({ updatedAt: new Date(Date.now() - UNSETTLED_CHASE_HORIZON_MS - 60_000) })
        .where(eq(aiOperatorOperations.id, op!.id)));

    const pass = await runReconcilerPass();
    expect(pass.terminalUnsettled).toBe(0);
  });
});

describe('AI Operator wake convergence (acceptance scenario 4)', () => {
  runDb('a duplicate wake for the same task does not advance it twice', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'waiting',
      waitReason: 'information',
      currentStepKey: 'investigate',
      nextWakeAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const first = await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'run', sourceId: randomUUID(),
    });
    const afterFirst = await readTask(task.id);

    // Same wake delivered again (BullMQ at-least-once, or the publisher
    // re-publishing a row whose `published_at` write was lost).
    const second = await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'run', sourceId: randomUUID(),
    });
    const afterSecond = await readTask(task.id);

    expect(first).not.toContain('skipped');
    // The second wake finds the task mid-flight or already advanced past the
    // door and converges to a no-op rather than admitting a second attempt.
    expect(afterSecond!.attemptOrdinal).toBe(afterFirst!.attemptOrdinal);
    expect(typeof second).toBe('string');

    // Exactly one reasoning run was ever admitted for this task+step.
    const runs = await withSystemDbAccessContext(() =>
      db.select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.taskId, task.id)));
    expect(runs.length).toBeLessThanOrEqual(1);
  });

  runDb('a wake for a terminal task is skipped, never resurrects it', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'completed',
      outcome: 'verified_resolved',
      currentStepKey: 'document',
    });

    const outcome = await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: randomUUID(),
    });

    expect(outcome).toContain('skipped');
    const after = await readTask(task.id);
    expect(after!.state).toBe('completed');
    expect(after!.outcome).toBe('verified_resolved');
    expect(after!.leaseEpoch).toBe(0);
  });

  runDb('a wake for a task in another org finds nothing', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const task = await createTask(a, { state: 'waiting', nextWakeAt: null });

    const outcome = await handleTaskWake({
      orgId: b.orgId, taskId: task.id, sourceKind: 'run', sourceId: randomUUID(),
    });

    expect(outcome).toContain('not_found');
    expect((await readTask(task.id))!.leaseEpoch).toBe(0);
  });
});

describe('AI Operator deadline handling (spec §7.3)', () => {
  runDb('a past-deadline task with an in-flight effect hands off as unknown_effect, not "nothing happened"', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'waiting',
      waitReason: 'execution',
      currentStepKey: 'observe',
      deadlineAt: new Date(Date.now() - 1_000),
      nextWakeAt: new Date(Date.now() - 1_000),
    });
    const intentId = await createIntent(t);
    await withSystemDbAccessContext(() =>
      db.insert(aiOperatorOperations).values({
        orgId: t.orgId,
        taskId: task.id,
        taskStepKey: 'execute',
        operationKey: `op-${randomUUID().slice(0, 8)}`,
        attemptOrdinal: 0,
        intentId,
        argumentDigest: 'c'.repeat(64),
        executionRefKind: 'device_command',
        executionRefId: randomUUID(),
        dispatchState: 'dispatched',
        resultState: 'pending',
      }));

    await runReconcilerPass();

    const after = await readTask(task.id);
    expect(after!.state).toBe('handed_off');
    // Spec §7.3's last line: expiry "must never display 'nothing happened' if
    // a change may still finish".
    expect(after!.outcome).toBe('unknown_effect');
    expect(after!.handoffSummary).toContain('may still complete');
  });

  runDb('a past-deadline task with NO in-flight effect fails as unresolved', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'waiting',
      waitReason: 'approval',
      currentStepKey: 'execute',
      deadlineAt: new Date(Date.now() - 1_000),
      nextWakeAt: new Date(Date.now() - 1_000),
    });

    await runReconcilerPass();

    const after = await readTask(task.id);
    expect(after!.state).toBe('failed');
    expect(after!.outcome).toBe('unresolved');
    // Distinguishing these two is the whole point: one says "a restart may
    // have run, check the device", the other says "nothing was sent".
    expect(after!.outcome).not.toBe('unknown_effect');
  });
});
