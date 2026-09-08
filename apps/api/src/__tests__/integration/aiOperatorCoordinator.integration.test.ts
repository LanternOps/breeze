/**
 * The AI Operator task coordinator's lease and run admission — real Postgres
 * (#5205 W06, sub-issue #5211, spec §6.2, §6.3).
 *
 * `taskTransitions.test.ts` already proves the state table as pure data. What
 * only a real database can prove is the SQL wrapped around it: that the lease
 * CAS leaves `revision` alone, that a stale epoch cannot commit, that a
 * task-linked run admission stamps the identity columns the partial unique
 * index depends on, and — the one that matters most — that taking a lease does
 * NOT invalidate an approval that is already waiting to dispatch.
 *
 * THE HEADLINE TEST is `a lease claim does not invalidate an approved
 * task-linked intent`. It is a regression test for a design that was
 * considered and rejected during this wave's advisory quorum (2026-09-08,
 * Claude + Codex agreeing independently): making the lease CAS bump `revision`
 * as an optimistic-concurrency token. `evaluateTaskClaimPredicate`
 * (`dispatchClaim.ts`, shipped in W04) refuses a dispatch whose approved
 * `plan_revision` no longer equals `tasks.revision`, so a lease that bumped
 * `revision` would make every approval decided while the coordinator happened
 * to tick permanently undispatchable — silently, and precisely on acceptance
 * scenario 3's "approve after the browser closed" path. Nothing else in the
 * codebase would have caught it: the two modules are correct in isolation.
 *
 * Fixtures are seeded per-test (not in beforeAll): setup.ts TRUNCATEs core
 * tenant tables in a global beforeEach, and every table here hangs off
 * organizations.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
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
import { claimTaskLease, TASK_LEASE_MS } from '../../services/aiOperator/taskCoordinator';
import { readServiceRunning } from '../../services/aiOperator/verification';
import {
  createAndEnqueueAgentRun,
  transitionRunStatus,
} from '../../services/aiAgents/runService';
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
const TASK_STEP_KEY = 'investigate';
const OPERATION_KEY = 'investigate:manage_services:dev:r1:n0';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  agentId: string;
  deviceId: string;
}

/** Mirrors `aiOperatorDispatchClaim.integration.test.ts`'s tenant: one
 *  target-eligible human (`devices:execute`) so the supervised fan-out on
 *  intent creation does not auto-cancel with `no_eligible_approvers`. */
async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@opcoord.test`,
  });

  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const eligible = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `eligible-${randomUUID()}@opcoord.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

  // PARTNER-level, not org-level. `resolveEffectiveAgentSystem` (the agent
  // `createAndEnqueueAgentRun` resolves) reads the partner baseline as the
  // agent row; an org row only NARROWS it, and with no partner row at all the
  // effective policy resolves to nothing and every admission skips
  // `no_effective_agent`. This is the same fixture shape
  // `agentCircuit.integration.test.ts` uses for the same reason.
  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Operator',
        enabled: true,
        mode: 'shadow',
        toolAllowlist: [TOOL_NAME],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
        triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
        recipients: { userIds: [], roleIds: [] },
        cooldownSeconds: 0,
        createdBy: requester.id,
      })
      .returning(),
  );

  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `opcoord-agent-${unique}`,
      hostname: `opcoord-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    requesterId: requester.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
  };
}

async function createTask(
  t: Tenant,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {},
): Promise<typeof aiOperatorTasks.$inferSelect> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiOperatorTasks)
      .values({
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
        currentStepKey: TASK_STEP_KEY,
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        deadlineAt: new Date(Date.now() + 3_600_000),
        nextWakeAt: new Date(),
        ...overrides,
      })
      .returning(),
  );
  return row!;
}

function agentPolicySnapshot() {
  return {
    schemaVersion: 1,
    agentId: 'unused-in-this-suite',
    kind: 'triage' as const,
    effective: {
      enabled: true,
      mode: 'shadow' as const,
      model: null,
      toolAllowlist: [TOOL_NAME],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {},
      triggers: {},
      recipients: { userIds: [], roleIds: [] },
      instructions: null,
      cooldownSeconds: 900,
    },
    resolvedAt: new Date().toISOString(),
  };
}

async function insertRun(
  t: Tenant,
  link: { taskId: string; taskStepKey: string; attemptOrdinal: number } | null,
): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'manual' as const,
        dedupeKey: `opcoord-${randomUUID()}`,
        modeAtStart: 'shadow' as const,
        policySnapshot: agentPolicySnapshot() as never,
        status: 'running' as const,
        taskId: link?.taskId ?? null,
        taskStepKey: link?.taskStepKey ?? null,
        taskAttemptOrdinal: link?.attemptOrdinal ?? null,
      })
      .returning({ id: aiAgentRuns.id }),
  );
  return row!.id;
}

function authForRun(t: Tenant, runId: string): AuthContext {
  return buildAgentAuthContext(
    { id: t.agentId, orgId: t.orgId, partnerId: null, name: 'Operator', kind: 'triage' },
    { id: runId, orgId: t.orgId, deviceId: t.deviceId, deviceSiteId: t.siteId },
    { id: t.orgId, partnerId: t.partnerId },
  );
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

describe('AI Operator lease CAS (real Postgres)', () => {
  runDb('claims a queued task: state -> running, lease_epoch + 1, revision UNCHANGED', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    const claim = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: true });
    expect(claim.won).toBe(true);

    const after = await readTask(task.id);
    expect(after!.state).toBe('running');
    expect(after!.leaseEpoch).toBe(task.leaseEpoch + 1);
    expect(after!.leaseOwner).not.toBeNull();
    expect(after!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after!.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + TASK_LEASE_MS + 5_000);

    // THE invariant. See this file's header.
    expect(after!.revision).toBe(task.revision);
    // A lease is not a reasoning attempt (spec §6.2).
    expect(after!.attemptOrdinal).toBe(task.attemptOrdinal);
  });

  runDb('a second claimant loses while the first lease is live', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    const first = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: true });
    expect(first.won).toBe(true);

    const second = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: true });
    expect(second.won).toBe(false);
    if (!second.won) expect(second.reason).toBe('not_claimable');
  });

  runDb('reclaims an EXPIRED running lease: epoch advances, attempt_ordinal does not', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'running',
      leaseOwner: 'coordinator:dead',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      leaseEpoch: 4,
      attemptOrdinal: 2,
    });

    const claim = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: true });
    expect(claim.won).toBe(true);

    const after = await readTask(task.id);
    expect(after!.state).toBe('running');
    expect(after!.leaseEpoch).toBe(5);
    // Spec §6.2: "Reclaiming a lease advances that fencing epoch but does not
    // change attempt_ordinal or operation identity."
    expect(after!.attemptOrdinal).toBe(2);
    expect(after!.revision).toBe(task.revision);
  });

  runDb('the poller refuses a waiting task whose next_wake_at is in the future; the wake path claims it', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'waiting',
      waitReason: 'approval',
      nextWakeAt: new Date(Date.now() + 60 * 60 * 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    // Poll path: not due, so nothing to do.
    const polled = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: true });
    expect(polled.won).toBe(false);

    // Event path: an authoritative source row changed, so the polling deadline
    // is irrelevant. This is the difference that makes an approval granted 20
    // minutes into a 1-hour fallback window continue immediately rather than
    // 40 minutes later (quorum finding Q1b).
    const woken = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue: false });
    expect(woken.won).toBe(true);
    expect((await readTask(task.id))!.state).toBe('running');
  });

  runDb('refuses to claim a terminal task from either path', async () => {
    const t = await seedTenant();
    const task = await createTask(t, { state: 'completed', outcome: 'verified_resolved' });

    for (const requireWakeDue of [true, false]) {
      const claim = await claimTaskLease({ orgId: t.orgId, taskId: task.id, requireWakeDue });
      expect(claim.won).toBe(false);
    }
    expect((await readTask(task.id))!.state).toBe('completed');
  });

  runDb('a lease claim does not invalidate an approved task-linked intent', async () => {
    // The regression this whole design decision exists for. See the header.
    const t = await seedTenant();
    const task = await createTask(t, { state: 'running' });
    const runId = await insertRun(t, {
      taskId: task.id, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0,
    });

    const intent = await createActionIntent(authForRun(t, runId), {
      toolName: TOOL_NAME,
      input: { deviceId: t.deviceId, action: 'restart', serviceName: 'spooler' },
      source: 'ai_agent',
      task: {
        taskId: task.id,
        taskStepKey: TASK_STEP_KEY,
        operationKey: OPERATION_KEY,
        attemptOrdinal: 0,
      },
    });
    expect(intent.status).toBe('pending_approval');

    // The human approves — while the coordinator is ticking. Move the intent
    // to `approved` the way the decide path does.
    await withSystemDbAccessContext(() =>
      transitionIntent(intent.id, 'pending_approval', 'approved', { decidedAt: new Date() }));

    // The coordinator wakes, takes a lease, and yields again — several times,
    // as a restart loop or a busy tick would.
    for (let i = 0; i < 3; i += 1) {
      const claim = await claimTaskLease({
        orgId: t.orgId, taskId: task.id, requireWakeDue: false,
      });
      expect(claim.won).toBe(true);
      await withSystemDbAccessContext(() =>
        db.update(aiOperatorTasks)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(eq(aiOperatorTasks.id, task.id)));
    }

    const afterTicks = await readTask(task.id);
    expect(afterTicks!.leaseEpoch).toBe(3);
    expect(afterTicks!.revision).toBe(1);

    // And the approval is STILL dispatchable. If `claimTaskLease` bumped
    // `revision`, `evaluateTaskClaimPredicate` would refuse here with
    // "plan revision moved" and the approval would be dead.
    const dispatch = await claimTaskLinkedIntentForDispatch({
      id: intent.id, orgId: t.orgId, taskId: task.id,
    });
    expect(dispatch).toMatchObject({ won: true });

    const [op] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.intentId, intent.id)));
    expect(op!.dispatchState).toBe('dispatched');
  });
});

describe('AI Operator task-linked run admission (real Postgres)', () => {
  runDb('stamps task_id/task_step_key/task_attempt_ordinal, prompt_version and resolved_model', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    const result = await createAndEnqueueAgentRun({
      orgId: t.orgId,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: t.deviceId,
      dedupeKey: `operator-task:${task.id}:investigate:0`,
      task: {
        taskId: task.id,
        taskStepKey: 'investigate',
        attemptOrdinal: 0,
        agentId: t.agentId,
        promptVersion: 'service_recovery/v1',
      },
    });

    expect(result.created).toBe(true);
    if (!result.created) return;

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, result.run.id)));
    expect(row!.taskId).toBe(task.id);
    expect(row!.taskStepKey).toBe('investigate');
    expect(row!.taskAttemptOrdinal).toBe(0);
    expect(row!.promptVersion).toBe('service_recovery/v1');
    // The CONFIGURED model at admission (null here — the agent inherits the
    // org default). `runLoop.ts` overwrites it with the model actually used.
    expect(row!.resolvedModel).toBeNull();
  });

  runDb('a pinned agent that is no longer the effective one cannot inherit the task (spec §6.2)', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    // A DIFFERENT live agent row for this partner. Standing in for the
    // "replacement same-kind agent" case, which cannot be staged literally:
    // `ai_operator_tasks.agent_id` is `ON DELETE RESTRICT`, so Postgres itself
    // refuses to delete an agent a live task is pinned to (verified — the
    // delete raises 23503 `ai_operator_tasks_agent_id_fkey`). That FK is a
    // genuine second line of defence, and this test covers the case it does
    // NOT cover: a pinned id that simply is not what `resolveEffectiveAgent`
    // returns any more.
    const [other] = await withSystemDbAccessContext(() =>
      db.insert(aiAgents)
        .values({
          partnerId: t.partnerId, orgId: null, kind: 'patch',
          name: 'Some Other Agent', enabled: true, mode: 'shadow',
          toolAllowlist: [], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
          limits: {}, triggers: {}, recipients: { userIds: [], roleIds: [] },
          cooldownSeconds: 0, createdBy: t.requesterId,
        })
        .returning({ id: aiAgents.id }));

    const result = await createAndEnqueueAgentRun({
      orgId: t.orgId,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: t.deviceId,
      dedupeKey: `operator-task:${task.id}:investigate:1`,
      task: {
        taskId: task.id,
        taskStepKey: 'investigate',
        attemptOrdinal: 1,
        // Not the agent this org's `triage` kind resolves to.
        agentId: other!.id,
        promptVersion: 'service_recovery/v1',
      },
    });

    expect(result.created).toBe(false);
    if (!result.created) expect(result.skipped).toBe('ownership_mismatch');

    // And nothing was written: a refused admission leaves no row to reconcile.
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.taskId, task.id)));
    expect(rows).toHaveLength(0);
  });

  runDb('the enqueue_failed reclaim path refuses a task-linked row', async () => {
    const t = await seedTenant();
    const task = await createTask(t);
    const dedupeKey = `operator-task:${task.id}:investigate:0`;

    // A prior admission that failed to enqueue — exactly the row the legacy
    // reclaim path exists to recycle.
    await withSystemDbAccessContext(() =>
      db.insert(aiAgentRuns).values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'manual' as const,
        dedupeKey,
        modeAtStart: 'shadow' as const,
        policySnapshot: agentPolicySnapshot() as never,
        status: 'failed' as const,
        errorCode: 'enqueue_failed',
        taskId: task.id,
        taskStepKey: 'investigate',
        taskAttemptOrdinal: 0,
      }));

    const result = await createAndEnqueueAgentRun({
      orgId: t.orgId,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: t.deviceId,
      dedupeKey,
      task: {
        taskId: task.id,
        taskStepKey: 'investigate',
        attemptOrdinal: 0,
        agentId: t.agentId,
        promptVersion: 'service_recovery/v1',
      },
    });

    // Spec §6.2: "Do not apply the legacy generic reset path to a task-linked
    // row." Refusing costs at most a wasted attempt; reclaiming would rewrite
    // the row's policy snapshot and let the rest of an already-reviewed task
    // run under authority nobody reviewed.
    expect(result.created).toBe(false);
    if (!result.created) expect(result.skipped).toBe('duplicate');

    const rows = await withSystemDbAccessContext(() =>
      db.select({ status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode })
        .from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.orgId, t.orgId), eq(aiAgentRuns.dedupeKey, dedupeKey))));
    expect(rows).toHaveLength(1);
    // Untouched — not re-stamped back to `queued`.
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.errorCode).toBe('enqueue_failed');
  });

  runDb('a legacy (non-task) enqueue_failed row still ENTERS the reclaim path — the refusal is scoped', async () => {
    // POSITIVE CONTROL. Without it, the test above would pass just as happily
    // if the reclaim path were broken outright, or if `skip('duplicate')` had
    // been added unconditionally.
    //
    // What it asserts is that a legacy row REACHES the reclaim UPDATE, not
    // that the reclaim succeeds. It cannot assert the latter: this fixture
    // hand-writes a `policy_snapshot`, and the reclaim rewrites that column
    // with the freshly-resolved one, which `ai_agent_runs_immutable_guard()`
    // rejects with 23000 whenever the two differ. That is pre-existing
    // behaviour of the legacy path (unchanged by this wave) and is out of
    // scope here — reaching the UPDATE at all is exactly the discrimination
    // this control needs, since the task-linked case returns `duplicate`
    // BEFORE the UPDATE is ever issued.
    const t = await seedTenant();
    const dedupeKey = `legacy-${randomUUID()}`;

    await withSystemDbAccessContext(() =>
      db.insert(aiAgentRuns).values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'manual' as const,
        dedupeKey,
        modeAtStart: 'shadow' as const,
        policySnapshot: agentPolicySnapshot() as never,
        status: 'failed' as const,
        errorCode: 'enqueue_failed',
      }));

    await expect(createAndEnqueueAgentRun({
      orgId: t.orgId,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: t.deviceId,
      dedupeKey,
      // Drizzle wraps the Postgres error, so the guard's own message
      // ("ai_agent_runs: immutable column changed") is on `.cause`; the
      // wrapper carries the failed statement. Matching the statement is the
      // assertion that matters anyway: it IS the reclaim UPDATE, which the
      // task-linked path never reaches.
    })).rejects.toThrow(/update "ai_agent_runs" set "agent_id"/);
  });
});

describe('AI Operator run-terminal outbox (real Postgres)', () => {
  runDb('writes exactly one ai_operator_task_outbox row per task-linked terminal transition', async () => {
    const t = await seedTenant();
    const task = await createTask(t, { state: 'waiting', waitReason: 'information' });
    const runId = await insertRun(t, {
      taskId: task.id, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0,
    });

    const moved = await transitionRunStatus(runId, 'running', 'awaiting_approval', {
      finishedAt: new Date(),
    });
    expect(moved).toBe(true);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, task.id)));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKind).toBe('run');
    expect(rows[0]!.sourceId).toBe(runId);
    expect(rows[0]!.publishedAt).toBeNull();
    // `awaiting_approval` is the ordinal that matters most for the thin slice:
    // it is the moment a task must move to `waiting(approval)` and release its
    // worker (see RUN_TERMINAL_OUTBOX_TRANSITION_SEQ).
    expect(rows[0]!.transitionSeq).toBe(6);
  });

  runDb('writes NO outbox row for a legacy (non-task) run', async () => {
    const t = await seedTenant();
    const runId = await insertRun(t, null);

    const moved = await transitionRunStatus(runId, 'running', 'completed', { finishedAt: new Date() });
    expect(moved).toBe(true);

    const rows = await withSystemDbAccessContext(() => db.select().from(aiOperatorTaskOutbox));
    expect(rows).toHaveLength(0);
  });

  runDb('the outbox row and the run status commit together, or not at all', async () => {
    // A lost CAS writes NOTHING — not a status change and not a wake. A wake
    // for a transition that did not happen would make the coordinator read a
    // run that is still `running` and re-arm its wait forever.
    const t = await seedTenant();
    const task = await createTask(t, { state: 'waiting' });
    const runId = await insertRun(t, {
      taskId: task.id, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0,
    });

    const first = await transitionRunStatus(runId, 'running', 'completed', { finishedAt: new Date() });
    expect(first).toBe(true);

    // Second writer loses: the run is no longer `running`.
    const second = await transitionRunStatus(runId, 'running', 'failed', { finishedAt: new Date() });
    expect(second).toBe(false);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, task.id)));
    // One row for the transition that happened, none for the one that did not.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transitionSeq).toBe(1); // completed
  });

  runDb('duplicate delivery of the same terminal transition collapses to one row', async () => {
    const t = await seedTenant();
    const task = await createTask(t, { state: 'waiting' });
    const runId = await insertRun(t, {
      taskId: task.id, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0,
    });

    await transitionRunStatus(runId, 'running', 'completed', { finishedAt: new Date() });
    // Force a second identical outbox insert the way a retried writer would.
    await withSystemDbAccessContext(() =>
      db.insert(aiOperatorTaskOutbox)
        .values({
          orgId: t.orgId, taskId: task.id, sourceKind: 'run', sourceId: runId, transitionSeq: 1,
        })
        .onConflictDoNothing({
          target: [
            aiOperatorTaskOutbox.orgId, aiOperatorTaskOutbox.taskId,
            aiOperatorTaskOutbox.sourceKind, aiOperatorTaskOutbox.sourceId,
            aiOperatorTaskOutbox.transitionSeq,
          ],
        }));

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, task.id)));
    expect(rows).toHaveLength(1);
  });
});

describe('AI Operator verification device scoping (real Postgres)', () => {
  runDb('refuses to read service state on a device that has left the org', async () => {
    // THE CROSS-TENANT DISPATCH GUARD (review finding, 2026-09-08).
    //
    // `readServiceRunning` ends up in `executeCommandWithSystemPrecheck`,
    // whose `precheckCommandExecution` resolves the device with
    // `WHERE devices.id = $1` and NO org predicate, under a system scope that
    // bypasses RLS. For a short-lived act-mode run that is academic. For a
    // DURABLE task — which can sit `waiting` for days, which is the point of
    // this wave — it is not: a device moved to another organization in the
    // meantime would still receive a live `list_services` command attributed
    // to the original org's frozen agent principal.
    //
    // This test drives the REAL `readServiceRunning` against a device that is
    // genuinely in another org and asserts it never gets that far. If the
    // ownership probe were removed, the call would proceed to a device
    // dispatch instead of returning `inconclusive` here.
    const a = await seedTenant();
    const b = await seedTenant();

    const result = await readServiceRunning({
      orgId: a.orgId,
      // b's device — the "moved to another tenant" case.
      deviceId: b.deviceId,
      serviceName: 'spooler',
      agentUserId: a.agentId,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.detail).toMatch(/no longer in this organization/i);
    // `inconclusive`, NOT `failed` — nothing was learned about the service,
    // and `failed` would authorize another restart attempt.
    expect(result.verdict).not.toBe('failed');
  });

  runDb('reads normally for a device that IS in the org', async () => {
    // The control: without it the assertion above would pass just as happily
    // against an implementation that refused unconditionally. The device is
    // offline in this fixture, so the read cannot complete — but it gets PAST
    // the ownership probe, which is what distinguishes the two paths.
    const t = await seedTenant();

    const result = await readServiceRunning({
      orgId: t.orgId,
      deviceId: t.deviceId,
      serviceName: 'spooler',
      agentUserId: t.agentId,
    });

    expect(result.detail).not.toMatch(/no longer in this organization/i);
  });
});

describe('AI Operator admission fencing (real Postgres)', () => {
  runDb('an intent cannot be created for a task whose deadline has passed', async () => {
    const t = await seedTenant();
    const task = await createTask(t, {
      state: 'running',
      deadlineAt: new Date(Date.now() - 1_000),
    });
    const runId = await insertRun(t, {
      taskId: task.id, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0,
    });

    // Creating the intent is still permitted (the intent layer does not read
    // the task's deadline) — but DISPATCH is fenced, which is where spec §7.3
    // puts the linearization point.
    const intent = await createActionIntent(authForRun(t, runId), {
      toolName: TOOL_NAME,
      input: { deviceId: t.deviceId, action: 'restart', serviceName: 'spooler' },
      source: 'ai_agent',
      task: {
        taskId: task.id, taskStepKey: TASK_STEP_KEY,
        operationKey: OPERATION_KEY, attemptOrdinal: 0,
      },
    });
    await withSystemDbAccessContext(() =>
      transitionIntent(intent.id, 'pending_approval', 'approved', { decidedAt: new Date() }));

    const dispatch = await claimTaskLinkedIntentForDispatch({
      id: intent.id, orgId: t.orgId, taskId: task.id,
    });
    expect(dispatch.won).toBe(false);
    if (!dispatch.won) {
      expect(dispatch.refusal).toBe('task_not_claimable');
      expect(dispatch.detail).toContain('deadline');
    }

    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: actionIntents.status })
        .from(actionIntents)
        .where(eq(actionIntents.id, intent.id)));
    expect(row!.status).toBe('approved'); // never became `executing`
  });
});
