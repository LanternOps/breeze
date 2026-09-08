/**
 * AI Operator task/operation identity — real Postgres (#5205 W04, sub-issue
 * #5209, baseline C6/H1/H4).
 *
 * Drives the REAL `createActionIntent` (never a mock of it or of the
 * guardrail path it re-verifies) against `manage_services` `restart` — a
 * genuinely Tier-3 `supervised` tool an `ai_agent` principal in `shadow` mode
 * is allowed to PROPOSE (never auto-execute) — and asserts the row contents
 * `deriveIntentIdempotencyKey` / `isSameTaskOperationReuse` / the
 * `reserveOperation` reservation exist to produce. A mocked unit suite
 * (`intentOperationIdentity.test.ts`) already proves the two pure helpers'
 * truth table in isolation; what only a real database can prove is that the
 * SQL wired around them — the partial live-only unique on
 * `action_intents_org_idem_uniq`, the permanent `(org_id, task_id,
 * operation_key)` unique on `ai_operator_operations`, and the one transaction
 * spanning both — actually behaves the way the contract says it does.
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
  aiOperatorTasks,
  devices,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import {
  cancelActionIntent,
  createActionIntent,
  deriveIdempotencyKey,
  deriveIntentIdempotencyKey,
  transitionIntent,
} from '../../services/actionIntents/intentService';
import { canonicalizeArguments, computeArgumentDigest } from '../../services/actionIntents/canonicalize';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

/**
 * `manage_services` `restart` — TIER3_SUPERVISED_ACTIONS (aiGuardrails.ts),
 * genuinely mutating, device-bound. Verified against
 * `intentOperationIdentity.test.ts` (same tool) and
 * `agentIntentLifecycle.integration.test.ts` (same tool, proves the fan-out
 * populates for exactly this action). `checkAgentGuardrails` returns
 * `disposition: 'propose'` for it under `mode: 'shadow'` — never `deny`
 * (would need `tool_not_tier3`/`agent_policy_denied` reclassification to pick
 * a different tool) and never `act` (shadow mode never auto-executes).
 */
const TOOL_NAME = 'manage_services';
const TASK_STEP_KEY = 'restart-spooler';
const OPERATION_KEY = 'restart:spooler';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  approverId: string;
  approverEmail: string;
  approverRoleId: string;
  agentId: string;
  deviceId: string;
}

/**
 * Seeds one tenant: an org-owned agent (so `assertRunOwnership`'s org-agent
 * branch applies), a device the run/proposals target, and ONE human who
 * holds both `devices:execute` (the action-and-target authority
 * `resolveAgentIntentApprovers` requires to be fanned a supervised agent
 * proposal — without this the intent's fan-out pool is empty and
 * `runHumanFanout` auto-cancels it with `no_eligible_approvers` before this
 * suite's assertions ever run) and `approvals:decide` (what `cancelActionIntent`
 * requires of a non-requester canceller; agent-originated intents have no
 * requester at all, so this is the ONLY door in).
 */
async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@opintent.test`,
  });

  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.DEVICES_EXECUTE, PERMISSIONS.APPROVALS_DECIDE]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@opintent.test`,
  });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator', createdBy: requester.id })
      .returning(),
  );

  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `opintent-agent-${unique}`,
      hostname: `opintent-host-${unique}`,
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
    approverId: approver.id,
    approverEmail: approver.email,
    approverRoleId: approverRole.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
  };
}

async function createTask(
  t: Tenant,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {},
): Promise<{ taskId: string; revision: number }> {
  const revision = (overrides.revision as number | undefined) ?? 1;
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
        objective: 'Restart the print spooler on PRINTSRV01',
        deviceId: t.deviceId,
        state: 'running',
        revision,
        leaseEpoch: 0,
        deadlineAt: new Date(Date.now() + 3_600_000),
        targetDetachedAt: null,
        ...overrides,
      })
      .returning({ id: aiOperatorTasks.id }),
  );
  return { taskId: row!.id, revision };
}

/** The run's own effective policy: shadow mode, `manage_services` allowlisted
 * — the shape `checkAgentGuardrails` must resolve to `disposition: 'propose'`
 * for a mutating call (never `deny`, never `act`). Mirrors
 * `agentIntentLifecycle.integration.test.ts`'s `effectivePolicyFields`. */
function agentPolicySnapshot() {
  return {
    schemaVersion: 1,
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

/** `task: null` seeds a LEGACY run (all three task columns NULL) — the shape
 * an ordinary, non-task agent proposal (test 9) needs, and the shape whose
 * OWN task linkage a forged task context (test 8c) must be checked against. */
async function createRun(
  t: Tenant,
  task: { taskId: string; taskStepKey: string; attemptOrdinal: number } | null,
): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'alert' as const,
        dedupeKey: `opintent-${randomUUID()}`,
        modeAtStart: 'shadow' as const,
        policySnapshot: agentPolicySnapshot() as never,
        ...(task
          ? { taskId: task.taskId, taskStepKey: task.taskStepKey, taskAttemptOrdinal: task.attemptOrdinal }
          : {}),
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

/** Same AuthContext shape `authMiddleware` produces (reuses
 * `buildOrgAccessClosures`, mirrors `createIntentAtomicity.integration.test.ts`'s
 * `requesterAuth`) — for the human canceller and the "untrusted principal"
 * cases. */
function humanAuth(t: Tenant, user: { id: string; email: string }, roleId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([t.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Human', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId: t.orgId,
      partnerId: t.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: t.partnerId,
    orgId: t.orgId,
    scope: 'organization',
    accessibleOrgIds: [t.orgId],
    orgCondition,
    canAccessOrg,
  };
}

function serviceInput(t: Tenant, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { deviceId: t.deviceId, action: 'restart', serviceName: 'spooler', ...overrides };
}

function taskCtx(taskId: string, taskStepKey: string, operationKey: string, attemptOrdinal: number) {
  return { taskId, taskStepKey, operationKey, attemptOrdinal };
}

async function propose(
  t: Tenant,
  runId: string,
  opts: {
    task?: ReturnType<typeof taskCtx>;
    input?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
) {
  return createActionIntent(authForRun(t, runId), {
    toolName: TOOL_NAME,
    input: opts.input ?? serviceInput(t),
    source: 'ai_agent',
    ...(opts.task ? { task: opts.task } : {}),
    ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
}

async function readIntent(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
    return row ?? null;
  });
}

async function readOperation(taskId: string, operationKey: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(aiOperatorOperations)
      .where(and(eq(aiOperatorOperations.taskId, taskId), eq(aiOperatorOperations.operationKey, operationKey)))
      .limit(1);
    return row ?? null;
  });
}

async function countIntents(taskId: string, operationKey: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: actionIntents.id })
      .from(actionIntents)
      .where(and(eq(actionIntents.taskId, taskId), eq(actionIntents.operationKey, operationKey)));
    return rows.length;
  });
}

async function countOperations(taskId: string, operationKey: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: aiOperatorOperations.id })
      .from(aiOperatorOperations)
      .where(and(eq(aiOperatorOperations.taskId, taskId), eq(aiOperatorOperations.operationKey, operationKey)));
    return rows.length;
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  // The kill switch defaults OFF; checkAgentGuardrails reads it at call time
  // on every proposal this suite drives (mirrors agentIntentLifecycle.integration.test.ts).
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createActionIntent — AI Operator task/operation identity (real Postgres)', () => {
  runDb('writes task_id/task_step_key/operation_key and never yields a null operation_key (baseline H4)', async () => {
    const t = await seedTenant();
    const task = await createTask(t);
    const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

    const snapshot = await propose(t, runId, {
      task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0),
    });

    const row = await readIntent(snapshot.id);
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe(task.taskId);
    expect(row!.taskStepKey).toBe(TASK_STEP_KEY);
    expect(row!.operationKey).toBe(OPERATION_KEY);
    expect(row!.operationKey).not.toBeNull();
  });

  runDb('reserves exactly ONE ai_operator_operations row in the SAME transaction as the intent insert', async () => {
    const t = await seedTenant();
    const task = await createTask(t);
    const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

    const snapshot = await propose(t, runId, {
      task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0),
    });

    const digest = computeArgumentDigest(canonicalizeArguments(serviceInput(t)));
    const ops = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, task.taskId)),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.intentId).toBe(snapshot.id);
    expect(ops[0]!.dispatchState).toBe('reserved');
    expect(ops[0]!.resultState).toBe('pending');
    expect(ops[0]!.planRevision).toBe(task.revision);
    expect(ops[0]!.argumentDigest).toBe(digest);
  });

  runDb('idempotency_key equals the TASK-derived key, NOT the run-derived one', async () => {
    const t = await seedTenant();
    const task = await createTask(t);
    const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

    const snapshot = await propose(t, runId, {
      task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0),
    });
    const row = await readIntent(snapshot.id);

    const digest = computeArgumentDigest(canonicalizeArguments(serviceInput(t)));
    const expectedTaskKey = deriveIntentIdempotencyKey({
      taskContext: { taskId: task.taskId, operationKey: OPERATION_KEY },
      explicitKey: undefined,
      toolName: TOOL_NAME,
      argumentDigest: digest,
      actorId: runId,
      scopeId: null,
    });
    const wouldBeRunDerivedKey = deriveIdempotencyKey(runId, TOOL_NAME, digest, null);

    expect(row!.idempotencyKey).toBe(expectedTaskKey);
    expect(row!.idempotencyKey).not.toBe(wouldBeRunDerivedKey);
  });

  runDb('a continuation run re-proposing the SAME operation ATTACHES to the existing intent (no duplicate)', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    const run1 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
    const first = await propose(t, run1, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });

    // A SECOND run on the same task/step — the shape of attempt 2 after a
    // reasoning-loop restart — re-proposes the identical tool + arguments +
    // operationKey.
    const run2 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 1 });
    const second = await propose(t, run2, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 1) });

    expect(second.id).toBe(first.id);
    expect(await countIntents(task.taskId, OPERATION_KEY)).toBe(1);
    expect(await countOperations(task.taskId, OPERATION_KEY)).toBe(1);
  });

  // NOTE ON THE ERROR CODE (see the "contract I could not test as literally
  // described" note in the suite's final report): `deriveIntentIdempotencyKey`
  // hashes `argumentDigest` INTO the task-derived key material itself
  // (`task:<taskId>:<toolName>:<digest>:<operationKey>`), so a different
  // digest always produces a DIFFERENT idempotency key — it can never collide
  // with the first proposal's LIVE row on `(org_id, idempotency_key)`, and so
  // never reaches the `idempotency_conflict` branch at all (that branch's
  // argumentDigest/actionName checks are for the LEGACY explicit-key path,
  // where two unrelated tool calls really can share a caller-chosen key; a
  // task-derived key can't, by construction — see the `task:` prefix note in
  // intentService.ts). The INSERT with the new key succeeds, and it is
  // `reserveOperation`'s PERMANENT `(org_id, task_id, operation_key)` unique —
  // which carries no digest predicate — that refuses the second proposal,
  // with `operation_replay`. Verified against the real error live below;
  // this is in fact the STRONGER guarantee: it refuses a mismatched-argument
  // re-proposal even while the first operation is still `reserved` (not yet
  // terminal), which is the scenario this test exercises and #7 below does
  // not (there the first intent is already `completed`).
  runDb('the SAME operationKey with DIFFERENT arguments is refused as operation_replay (digest is in the key)', async () => {
    const t = await seedTenant();
    const task = await createTask(t);

    const run1 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
    const first = await propose(t, run1, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });

    const run2 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 1 });
    await expect(
      propose(t, run2, {
        task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 1),
        input: serviceInput(t, { serviceName: 'a-completely-different-service' }),
      }),
    ).rejects.toMatchObject({ code: 'operation_replay' });

    // Only the first intent/operation exist — the mismatched proposal's own
    // (successfully inserted, then rolled back) intent row left no trace,
    // and the operation row still points at the FIRST intent.
    expect(await countIntents(task.taskId, OPERATION_KEY)).toBe(1);
    expect(await countOperations(task.taskId, OPERATION_KEY)).toBe(1);
    const op = await readOperation(task.taskId, OPERATION_KEY);
    expect(op!.intentId).toBe(first.id);
  });

  runDb('two DIFFERENT tasks with identical arguments each get their OWN intent and operation', async () => {
    const t = await seedTenant();
    const taskA = await createTask(t);
    const taskB = await createTask(t);

    const runA = await createRun(t, { taskId: taskA.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
    const runB = await createRun(t, { taskId: taskB.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

    const a = await propose(t, runA, { task: taskCtx(taskA.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });
    const b = await propose(t, runB, { task: taskCtx(taskB.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });

    expect(a.id).not.toBe(b.id);

    const opA = await readOperation(taskA.taskId, OPERATION_KEY);
    const opB = await readOperation(taskB.taskId, OPERATION_KEY);
    expect(opA?.intentId).toBe(a.id);
    expect(opB?.intentId).toBe(b.id);
    expect(await countIntents(taskA.taskId, OPERATION_KEY)).toBe(1);
    expect(await countIntents(taskB.taskId, OPERATION_KEY)).toBe(1);
  });

  runDb(
    'a sequential replay after the first intent terminalizes is refused, rolling back the WHOLE admission',
    async () => {
      const t = await seedTenant();
      const task = await createTask(t);

      const run1 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
      const first = await propose(t, run1, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });

      // Terminalize the first intent. This FREES the live idempotency key
      // (the partial unique only covers pending_approval/approved/executing),
      // which is exactly the gap `ai_operator_operations`'s permanent unique
      // exists to close — the intent-level guard alone would let this replay
      // straight through.
      await transitionIntent(first.id, 'pending_approval', 'completed');

      const run2 = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 1 });
      await expect(
        propose(t, run2, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 1) }),
      ).rejects.toMatchObject({ code: 'operation_replay' });

      // No new intent for this operation — the whole creation transaction
      // (including the fresh action_intents insert that briefly succeeded
      // before the operation reservation tripped) rolled back.
      expect(await countIntents(task.taskId, OPERATION_KEY)).toBe(1);
      // Exactly one operation row, STILL pointing at the ORIGINAL (completed)
      // intent — a confirmed effect is never replayed onto a new one.
      const ops = await withSystemDbAccessContext(() =>
        db
          .select()
          .from(aiOperatorOperations)
          .where(and(eq(aiOperatorOperations.taskId, task.taskId), eq(aiOperatorOperations.operationKey, OPERATION_KEY))),
      );
      expect(ops).toHaveLength(1);
      expect(ops[0]!.intentId).toBe(first.id);
    },
  );

  describe('untrusted task context is refused', () => {
    runDb('(a) a user_session principal passing task throws task_context_not_allowed', async () => {
      const t = await seedTenant();
      const task = await createTask(t);
      const auth = humanAuth(t, { id: t.approverId, email: t.approverEmail }, t.approverRoleId);

      await expect(
        createActionIntent(auth, {
          toolName: TOOL_NAME,
          input: serviceInput(t),
          source: 'chat',
          task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0),
        }),
      ).rejects.toMatchObject({ code: 'task_context_not_allowed' });

      // Refused before anything was written.
      expect(await countIntents(task.taskId, OPERATION_KEY)).toBe(0);
    });

    runDb(
      '(b) an ai_agent principal passing task WITH an explicit idempotencyKey throws task_context_not_allowed',
      async () => {
        const t = await seedTenant();
        const task = await createTask(t);
        const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

        await expect(
          propose(t, runId, {
            task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0),
            idempotencyKey: 'explicit-key-must-not-combine-with-task-context',
          }),
        ).rejects.toMatchObject({ code: 'task_context_not_allowed' });

        expect(await countIntents(task.taskId, OPERATION_KEY)).toBe(0);
      },
    );

    runDb(
      "(c) a run whose OWN ai_agent_runs.task_id does not match the supplied task.taskId throws task_context_invalid",
      async () => {
        const t = await seedTenant();
        const taskA = await createTask(t);
        const taskB = await createTask(t);
        // The run is linked to task A ...
        const runId = await createRun(t, { taskId: taskA.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });

        // ...but the proposal claims task B's identity. The caller ASSERTING a
        // task id proves nothing — only the run's own admitted linkage does.
        await expect(
          propose(t, runId, { task: taskCtx(taskB.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) }),
        ).rejects.toMatchObject({ code: 'task_context_invalid' });

        expect(await countIntents(taskA.taskId, OPERATION_KEY)).toBe(0);
        expect(await countIntents(taskB.taskId, OPERATION_KEY)).toBe(0);
      },
    );
  });

  runDb('an ordinary (non-task) agent intent still gets the run-derived key and creates NO operation row', async () => {
    const t = await seedTenant();
    const runId = await createRun(t, null); // legacy run: no task/step/attempt linkage at all

    const snapshot = await propose(t, runId); // no `task` field — the pre-W04 shape

    const row = await readIntent(snapshot.id);
    expect(row!.taskId).toBeNull();
    expect(row!.taskStepKey).toBeNull();
    expect(row!.operationKey).toBeNull();

    const digest = computeArgumentDigest(canonicalizeArguments(serviceInput(t)));
    expect(row!.idempotencyKey).toBe(deriveIdempotencyKey(runId, TOOL_NAME, digest, null));

    const ops = await withSystemDbAccessContext(() =>
      db.select({ id: aiOperatorOperations.id }).from(aiOperatorOperations).where(eq(aiOperatorOperations.intentId, snapshot.id)),
    );
    expect(ops).toHaveLength(0);
  });

  runDb('cancel on a task-linked pending_approval intent: ok:true, operation terminally cancelled', async () => {
    const t = await seedTenant();
    const task = await createTask(t);
    const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
    const snapshot = await propose(t, runId, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });
    expect(snapshot.status).toBe('pending_approval');

    const auth = humanAuth(t, { id: t.approverId, email: t.approverEmail }, t.approverRoleId);
    const result = await cancelActionIntent(auth, snapshot.id);
    expect(result).toMatchObject({ ok: true, status: 'cancelled' });

    const intentRow = await readIntent(snapshot.id);
    expect(intentRow!.status).toBe('cancelled');

    // Nothing was ever dispatched — terminally 'cancelled', distinct from
    // 'abandoned' (a leaked reservation the reconciler must find separately).
    const op = await readOperation(task.taskId, OPERATION_KEY);
    expect(op!.dispatchState).toBe('cancelled');
    expect(op!.cancelRequestedAt).not.toBeNull();
  });

  runDb(
    "cancel while EXECUTING: records cancel_requested_at but does NOT flip the intent or the operation (in flight, will be reconciled)",
    async () => {
      const t = await seedTenant();
      const task = await createTask(t);
      const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
      const snapshot = await propose(t, runId, { task: taskCtx(task.taskId, TASK_STEP_KEY, OPERATION_KEY, 0) });

      // Move the intent straight to `executing` — the claim mechanics that
      // normally do this are Suite 2's job; here only the STATE matters.
      await transitionIntent(snapshot.id, 'pending_approval', 'executing', { executionStartedAt: new Date() });
      // "seed it so" (brief): the operation must independently read
      // `dispatched` for the cancel-request path to have a real in-flight
      // effect to record against, rather than a reserved one.
      await withSystemDbAccessContext(() =>
        db
          .update(aiOperatorOperations)
          .set({ dispatchState: 'dispatched', dispatchedAt: new Date() })
          .where(eq(aiOperatorOperations.intentId, snapshot.id)),
      );

      const auth = humanAuth(t, { id: t.approverId, email: t.approverEmail }, t.approverRoleId);
      const result = await cancelActionIntent(auth, snapshot.id);
      expect(result).toMatchObject({ ok: false, status: 'executing', inFlight: true });

      const intentRow = await readIntent(snapshot.id);
      // The intent must NOT have moved — an already-dispatched effect may
      // still finish, and §7.3 forbids ever claiming "nothing happened".
      expect(intentRow!.status).toBe('executing');

      const op = await readOperation(task.taskId, OPERATION_KEY);
      expect(op!.dispatchState).toBe('dispatched');
      expect(op!.cancelRequestedAt).not.toBeNull();
    },
  );
});
