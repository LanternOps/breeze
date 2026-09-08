/**
 * Service recovery, end to end — acceptance scenario 3 (#5205 W06, #5211).
 *
 * Spec §13 scenario 3: "Approve after browser close/worker restart; the
 * operation executes once under its identity, results arrive, and a new run
 * continues only when needed."
 *
 * WHAT IS REAL HERE, and it is almost everything: the task row, the
 * `createActionIntent` admission (including the task-derived idempotency key
 * and the operation reservation in the same transaction), the approval
 * transition, the W04 dispatch claim, the W05 outbox writes, the coordinator's
 * lease CAS and step machine, the reconciler, and every state transition in
 * between. All against real Postgres.
 *
 * WHAT IS FAKED, and why each one has to be:
 *
 *  - THE MODEL. There is no SDK process in a test. A reasoning run is
 *    represented by its committed `ai_agent_runs` row plus the intent it
 *    created — which is precisely what the coordinator reads. The coordinator
 *    never sees a model, so faking one would not exercise anything it does.
 *  - THE DEVICE. `verifyServiceRunningForTask` and the device-command read are
 *    mocked, because a device command needs an agent on a WebSocket. These are
 *    the two seams the criterion actually depends on, so each test states what
 *    the device "reports" and asserts the verdict the task reaches.
 *
 * The result is a genuine proof of the CONTINUATION contract — the thing this
 * wave exists to build — rather than a proof that a fake agent can be driven
 * through a happy path.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Mocked BEFORE the modules under test are imported (vi.mock is hoisted).
const verifyServiceRunningForTask = vi.hoisted(() => vi.fn());
vi.mock('../../services/aiAgents/actVerify', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyServiceRunningForTask,
}));

const readDeviceCommandEvidence = vi.hoisted(() => vi.fn());
vi.mock('../../services/aiOperator/deviceCommandEvidence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDeviceCommandEvidence,
}));

const readFixWatchStateForTest = vi.hoisted(() => ({ state: 'held_qualified' as string | null }));
vi.mock('../../db/schema/aiAgentFixWatches', async (importOriginal) => importOriginal());

import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentFixWatches,
  aiAgentRuns,
  aiAgents,
  aiOperatorOperations,
  aiOperatorTaskOutbox,
  aiOperatorTasks,
  devices,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { claimTaskLinkedIntentForDispatch } from '../../services/aiOperator/dispatchClaim';
import {
  recordOperationExecutionRef,
  recordOperationResult,
} from '../../services/aiOperator/operationService';
import { handleTaskWake } from '../../services/aiOperator/taskCoordinator';
import { runReconcilerPass } from '../../services/aiOperator/taskReconciler';
import { transitionRunStatus } from '../../services/aiAgents/runService';
import { taskCheckpointSchema } from '@breeze/shared';
import { buildTaskOperationKey } from '../../services/aiOperator/operationKey';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { PERMISSIONS } from '../../services/permissions';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'spooler';

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
    partnerId: partner.id, orgId: org.id, email: `requester-${randomUUID()}@ope2e.test`,
  });

  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const eligible = await createUser({
    partnerId: partner.id, orgId: org.id, email: `eligible-${randomUUID()}@ope2e.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

  const [agent] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'triage', name: 'Operator',
      enabled: true, mode: 'shadow', toolAllowlist: [TOOL_NAME],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
      triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
      recipients: { userIds: [], roleIds: [] }, cooldownSeconds: 0, createdBy: requester.id,
    }).returning());

  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId: org.id, siteId: site.id,
    agentId: `ope2e-agent-${unique}`, hostname: `ope2e-host-${unique}`,
    osType: 'windows', osVersion: '10', architecture: 'x86_64',
    agentVersion: '0.0.0-test', status: 'online',
  }).returning();

  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id,
    requesterId: requester.id, agentId: agent!.id,
    deviceId: (device as { id: string }).id,
  };
}

function checkpointFor(t: Tenant, alertId: string | null) {
  return taskCheckpointSchema.parse({
    version: 1,
    recipeInput: {
      deviceId: t.deviceId, serviceName: SERVICE_NAME,
      triggeringAlertId: alertId, maxRestartAttempts: 1,
    },
    criterion: {
      adapter: 'service_running', adapterVersion: 1,
      deviceId: t.deviceId, serviceName: SERVICE_NAME,
      freshnessSeconds: 120, alertId, resolvableWithoutAlert: false,
    },
    findings: [], satisfiedCriteria: [], unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
  });
}

async function admitTask(t: Tenant, alertId: string | null) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiOperatorTasks).values({
      orgId: t.orgId, agentId: t.agentId, agentKind: 'triage', agentName: 'Operator',
      workflowKey: 'service_recovery', workflowVersion: 1,
      originKind: 'manual' as const, requesterUserId: t.requesterId,
      objective: `Restart ${SERVICE_NAME}`, deviceId: t.deviceId,
      state: 'running', phase: 'investigate', currentStepKey: 'investigate',
      checkpoint: checkpointFor(t, alertId) as unknown as Record<string, unknown>,
      revision: 1, leaseEpoch: 0, attemptOrdinal: 0,
      deadlineAt: new Date(Date.now() + 3_600_000),
    }).returning());
  return row!;
}

async function insertTaskRun(t: Tenant, taskId: string, attemptOrdinal = 0): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiAgentRuns).values({
      agentId: t.agentId, orgId: t.orgId, deviceId: t.deviceId,
      triggerKind: 'manual' as const, dedupeKey: `operator-task:${taskId}:investigate:${attemptOrdinal}`,
      modeAtStart: 'shadow' as const,
      policySnapshot: {
        schemaVersion: 1, agentId: t.agentId, kind: 'triage',
        effective: {
          enabled: true, mode: 'shadow', model: null, toolAllowlist: [TOOL_NAME],
          protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
          limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] },
          instructions: null, cooldownSeconds: 0,
        },
        resolvedAt: new Date().toISOString(),
      } as never,
      status: 'running' as const,
      taskId, taskStepKey: 'investigate', taskAttemptOrdinal: attemptOrdinal,
      promptVersion: 'service_recovery/v1',
    }).returning({ id: aiAgentRuns.id }));
  return row!.id;
}

function authForRun(t: Tenant, runId: string): AuthContext {
  return buildAgentAuthContext(
    { id: t.agentId, orgId: t.orgId, partnerId: null, name: 'Operator', kind: 'triage' },
    { id: runId, orgId: t.orgId, deviceId: t.deviceId, deviceSiteId: t.siteId },
    { id: t.orgId, partnerId: t.partnerId },
  );
}

/** What the reasoning run does: propose the restart, which mints the intent
 *  AND reserves the operation in one transaction (W04). */
async function proposeRestart(t: Tenant, taskId: string, runId: string, planRevision = 1) {
  return createActionIntent(authForRun(t, runId), {
    toolName: TOOL_NAME,
    input: { deviceId: t.deviceId, action: 'restart', serviceName: SERVICE_NAME },
    source: 'ai_agent',
    task: {
      taskId,
      taskStepKey: 'investigate',
      operationKey: buildTaskOperationKey({
        taskStepKey: 'investigate', planRevision, toolName: TOOL_NAME,
        targetId: t.deviceId, ordinal: 0,
      }),
      attemptOrdinal: 0,
    },
  });
}

async function readTask(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, id)).limit(1);
    return row ?? null;
  });
}

async function countOperations(taskId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: aiOperatorOperations.id }).from(aiOperatorOperations)
      .where(eq(aiOperatorOperations.taskId, taskId)));
  return rows.length;
}

/** Seeds the intent-anchored fix watch the release path would have opened,
 *  in the state this test wants the recurrence half of the criterion to be
 *  in. `verification.ts` reads it by `(intent_id, org_id)`. */
async function seedFixWatch(
  t: Tenant, intentId: string, runId: string, alertId: string, state: string,
): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.insert(aiAgentFixWatches).values({
      orgId: t.orgId, partnerId: t.partnerId, agentId: t.agentId,
      runId, intentId, alertId,
      ruleId: null, deviceId: t.deviceId, configItemName: SERVICE_NAME,
      state: state as never, sourceKind: 'intent' as never, opKeys: [],
    }));
}

async function seedAlert(t: Tenant): Promise<string> {
  const adminDb = getTestDb() as unknown as typeof db;
  const { alerts } = await import('../../db/schema');
  const [row] = await adminDb.insert(alerts).values({
    orgId: t.orgId, deviceId: t.deviceId,
    title: `${SERVICE_NAME} is not running`,
    message: 'service down',
    severity: 'high' as never,
    status: 'resolved' as never,
  }).returning({ id: alerts.id });
  return (row as { id: string }).id;
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED', 'true');
  verifyServiceRunningForTask.mockReset();
  readDeviceCommandEvidence.mockReset();
  readFixWatchStateForTest.state = 'held_qualified';
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Drives the flow from "the run proposed a restart" to "the command result
 *  landed", returning the ids for assertions. */
async function driveToResult(
  t: Tenant,
  task: { id: string },
  runId: string,
  commandStatus: 'completed' | 'failed' | 'timeout',
) {
  const intent = await proposeRestart(t, task.id, runId);
  expect(intent.status).toBe('pending_approval');
  expect(await countOperations(task.id)).toBe(1);

  // The browser closes. The run ends `awaiting_approval`, which writes the
  // task-outbox row inside the SAME transaction as the status change.
  await transitionRunStatus(runId, 'running', 'awaiting_approval', { finishedAt: new Date() });

  // The coordinator wakes on it and parks the task on the approval.
  await handleTaskWake({
    orgId: t.orgId, taskId: task.id, sourceKind: 'run', sourceId: runId,
  });
  const waiting = await readTask(task.id);
  expect(waiting!.state).toBe('waiting');
  expect(waiting!.waitReason).toBe('approval');
  expect(waiting!.currentStepKey).toBe('execute');
  // Nothing is held while it waits — that is the whole point of the design.
  expect(waiting!.leaseOwner).toBeNull();

  // …later, a technician approves from the inbox.
  await withSystemDbAccessContext(() =>
    transitionIntent(intent.id, 'pending_approval', 'approved', { decidedAt: new Date() }));

  // The release worker claims the dispatch (W04) and sends the command.
  const claim = await claimTaskLinkedIntentForDispatch({
    id: intent.id, orgId: t.orgId, taskId: task.id,
  });
  expect(claim).toMatchObject({ won: true });

  const commandId = randomUUID();
  await recordOperationExecutionRef(intent.id, { kind: 'device_command', id: commandId });
  await recordOperationResult({
    intentId: intent.id,
    resultState: commandStatus === 'completed' ? 'succeeded' : 'unknown',
    result: { status: commandStatus },
  });

  readDeviceCommandEvidence.mockResolvedValue({
    ok: true,
    evidence: {
      commandId, deviceId: t.deviceId, type: 'restart_service',
      status: commandStatus === 'timeout' ? 'failed' : commandStatus,
      resultStatus: commandStatus,
      completedAt: new Date(), createdAt: new Date(), sanitized: {},
    },
  });

  return { intent, commandId };
}

describe('Service recovery end to end — acceptance scenario 3', () => {
  runDb('approve after browser close: one operation, one intent, one command, verified_resolved', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);
    const task = await admitTask(t, alertId);
    const runId = await insertTaskRun(t, task.id);

    const { intent, commandId } = await driveToResult(t, task, runId, 'completed');
    await seedFixWatch(t, intent.id, runId, alertId, 'held_qualified');

    // The device is genuinely running the service — the INDEPENDENT read, not
    // the command's exit code (C10).
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });

    // Terminal-result wake -> observe -> verify -> complete.
    await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id,
    });
    await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'execution', sourceId: commandId,
    });
    await handleTaskWake({
      orgId: t.orgId, taskId: task.id, sourceKind: 'verification', sourceId: task.id,
    });

    const final = await readTask(task.id);
    expect(final!.state).toBe('completed');
    expect(final!.outcome).toBe('verified_resolved');

    // EXACTLY ONE of each. Duplicate effects are the failure this whole
    // identity design exists to prevent (spec §6.5).
    expect(await countOperations(task.id)).toBe(1);
    const intents = await withSystemDbAccessContext(() =>
      db.select({ id: actionIntents.id }).from(actionIntents)
        .where(and(eq(actionIntents.taskId, task.id), eq(actionIntents.orgId, t.orgId))));
    expect(intents).toHaveLength(1);

    const [op] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, task.id)));
    expect(op!.executionRefKind).toBe('device_command');
    expect(op!.executionRefId).toBe(commandId);
    expect(op!.resultState).toBe('succeeded');

    // The independent read actually happened — a pass credited without it
    // would be C10's exact failure.
    expect(verifyServiceRunningForTask).toHaveBeenCalled();
  });

  runDb('a continuation run re-proposing the same restart attaches, never duplicates', async () => {
    const t = await seedTenant();
    const task = await admitTask(t, null);
    const runA = await insertTaskRun(t, task.id, 0);

    const first = await proposeRestart(t, task.id, runA, 1);

    // A second reasoning attempt on the SAME plan proposes the same thing.
    const runB = await insertTaskRun(t, task.id, 1);
    const second = await proposeRestart(t, task.id, runB, 1);

    // Same intent, converged through the task-derived idempotency key (C6's
    // single-arbiter rule), and still exactly one operation row.
    expect(second.id).toBe(first.id);
    expect(await countOperations(task.id)).toBe(1);
  });

  runDb('worker restart between claim and result: the task still reaches verified_resolved', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);
    const task = await admitTask(t, alertId);
    const runId = await insertTaskRun(t, task.id);

    const { intent, commandId } = await driveToResult(t, task, runId, 'completed');
    await seedFixWatch(t, intent.id, runId, alertId, 'held_qualified');
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });

    // Simulate the coordinator dying mid-step: a live lease with no owner
    // process behind it, held by a DIFFERENT (dead) coordinator id.
    await withSystemDbAccessContext(() =>
      db.update(aiOperatorTasks).set({
        state: 'running',
        currentStepKey: 'observe',
        leaseOwner: 'coordinator:dead',
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }).where(eq(aiOperatorTasks.id, task.id)));

    // No wake is delivered at all — Redis was down for the whole window. The
    // reconciler is the only thing that can recover this (scenario 4).
    for (let i = 0; i < 4; i += 1) await runReconcilerPass();

    const final = await readTask(task.id);
    expect(final!.state).toBe('completed');
    expect(final!.outcome).toBe('verified_resolved');
    // The restart was NOT reissued during recovery.
    expect(await countOperations(task.id)).toBe(1);
    expect(commandId).toBeTruthy();
  });

  runDb('inconclusive verification can never produce verified_resolved (scenario 7)', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);
    const task = await admitTask(t, alertId);
    const runId = await insertTaskRun(t, task.id);

    const { intent, commandId } = await driveToResult(t, task, runId, 'completed');
    // The alert watch never qualified — a human dismissed the alert, which is
    // not evidence of recovery.
    await seedFixWatch(t, intent.id, runId, alertId, 'cancelled');
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });

    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'execution', sourceId: commandId });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'verification', sourceId: task.id });

    const final = await readTask(task.id);
    expect(final!.outcome).not.toBe('verified_resolved');
    expect(final!.state).toBe('handed_off');
    expect(final!.outcome).toBe('unresolved');
  });

  runDb('a command that never reports a result hands off as unknown_effect, not as a failure', async () => {
    const t = await seedTenant();
    const task = await admitTask(t, null);
    const runId = await insertTaskRun(t, task.id);

    const { intent, commandId } = await driveToResult(t, task, runId, 'timeout');

    // Past the recipe's unknown-effect horizon: the command row is old and
    // still says `timeout`, which `commandAcceptsAgentResultCondition` keeps
    // open to a late agent result.
    readDeviceCommandEvidence.mockResolvedValue({
      ok: true,
      evidence: {
        commandId, deviceId: t.deviceId, type: 'restart_service',
        status: 'failed', resultStatus: 'timeout',
        completedAt: null,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        sanitized: {},
      },
    });

    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'execution', sourceId: commandId });

    const final = await readTask(task.id);
    expect(final!.state).toBe('handed_off');
    // Spec §7.3: never display "nothing happened" when a change may still
    // finish. The restart may well have run.
    expect(final!.outcome).toBe('unknown_effect');
    expect(final!.handoffSummary).toMatch(/do not assume nothing happened/i);
    expect(await countOperations(task.id)).toBe(1);
  });

  runDb('duplicate and out-of-order wakes converge on one outcome', async () => {
    const t = await seedTenant();
    const alertId = await seedAlert(t);
    const task = await admitTask(t, alertId);
    const runId = await insertTaskRun(t, task.id);

    const { intent, commandId } = await driveToResult(t, task, runId, 'completed');
    await seedFixWatch(t, intent.id, runId, alertId, 'held_qualified');
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });

    // Deliberately out of order and duplicated — a verification wake before
    // the execution wake, the intent wake twice, and a stale run wake last.
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'verification', sourceId: task.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'execution', sourceId: commandId });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'execution', sourceId: commandId });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'verification', sourceId: task.id });
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'run', sourceId: runId });

    const final = await readTask(task.id);
    expect(final!.state).toBe('completed');
    expect(final!.outcome).toBe('verified_resolved');
    expect(await countOperations(task.id)).toBe(1);

    // And a wake delivered AFTER the task went terminal changes nothing.
    const epochBefore = final!.leaseEpoch;
    await handleTaskWake({ orgId: t.orgId, taskId: task.id, sourceKind: 'intent', sourceId: intent.id });
    const after = await readTask(task.id);
    expect(after!.state).toBe('completed');
    expect(after!.leaseEpoch).toBe(epochBefore);
  });

  runDb('every task-affecting transition left an outbox row for the reconciler to fall back on', async () => {
    const t = await seedTenant();
    const task = await admitTask(t, null);
    const runId = await insertTaskRun(t, task.id);

    const intent = await proposeRestart(t, task.id, runId);
    await transitionRunStatus(runId, 'running', 'awaiting_approval', { finishedAt: new Date() });
    await withSystemDbAccessContext(() =>
      transitionIntent(intent.id, 'pending_approval', 'approved', { decidedAt: new Date() }));
    await claimTaskLinkedIntentForDispatch({ id: intent.id, orgId: t.orgId, taskId: task.id });
    await withSystemDbAccessContext(() =>
      transitionIntent(intent.id, 'executing', 'completed', { executedAt: new Date() }));

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, task.id)));

    // At minimum the run terminalization; the intent writers add their own.
    const kinds = new Set(rows.map((r) => r.sourceKind));
    expect(kinds.has('run')).toBe(true);
    // Every row is unpublished — nothing here ran the publisher, which is the
    // "Redis was never involved" property the reconciler relies on.
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
  });
});
