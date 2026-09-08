/**
 * The AI Operator dispatch claim — real Postgres (#5205 W04, sub-issue #5209,
 * spec §7.3, baseline C8/H3).
 *
 * Drives the REAL `claimTaskLinkedIntentForDispatch`, `revertTaskLinkedDispatchClaim`,
 * `recordOperationResult`, and `reapStaleExecutingIntents`. `dispatchClaim.test.ts`
 * already proves `evaluateTaskClaimPredicate`'s truth table as a pure function —
 * what only a real database can prove is that the SQL wired around it (the
 * `FOR UPDATE` lock order, the intent CAS re-stating the SAME predicate, the
 * concurrent-claim serialisation, the rank-ordered result write) actually
 * behaves the way the module's own header says it does.
 *
 * Fixtures are seeded per-test (not in beforeAll): setup.ts TRUNCATEs core
 * tenant tables in a global beforeEach, and every table here hangs off
 * organizations.
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
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import {
  claimTaskLinkedIntentForDispatch,
  revertTaskLinkedDispatchClaim,
  type TaskLinkedIntentRef,
} from '../../services/aiOperator/dispatchClaim';
import { recordOperationResult } from '../../services/aiOperator/operationService';
import { reapStaleExecutingIntents } from '../../jobs/intentExpiryReaper';
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

/** Same fixture tool as aiOperatorIntentIdentity.integration.test.ts —
 * `manage_services` `restart`, genuinely Tier-3 `supervised`, `shadow` mode
 * proposes (never auto-executes). See that file's header for the full
 * rationale. */
const TOOL_NAME = 'manage_services';
const TASK_STEP_KEY = 'restart-spooler';
const OPERATION_KEY = 'restart:spooler';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  agentId: string;
  deviceId: string;
}

/** Seeds one tenant with a target-eligible human (`devices:execute`) so the
 * supervised fan-out on intent creation does not auto-cancel the proposal
 * with `no_eligible_approvers` before this suite ever gets to a claim. */
async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@opclaim.test`,
  });

  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const eligible = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `eligible-${randomUUID()}@opclaim.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

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
      agentId: `opclaim-agent-${unique}`,
      hostname: `opclaim-host-${unique}`,
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

async function createRun(t: Tenant, task: { taskId: string; taskStepKey: string; attemptOrdinal: number }): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'alert' as const,
        dedupeKey: `opclaim-${randomUUID()}`,
        modeAtStart: 'shadow' as const,
        policySnapshot: agentPolicySnapshot() as never,
        taskId: task.taskId,
        taskStepKey: task.taskStepKey,
        taskAttemptOrdinal: task.attemptOrdinal,
      })
      .returning({ id: aiAgentRuns.id }),
  );
  return row!.id;
}

function serviceInput(t: Tenant): Record<string, unknown> {
  return { deviceId: t.deviceId, action: 'restart', serviceName: 'spooler' };
}

/**
 * Creates the full real chain — task, run, `createActionIntent` proposal — and
 * hand-approves it (`transitionIntent` is the shared CAS primitive; the
 * approve ROUTE's own authorization/notification machinery is not what this
 * suite is about) so the fixture lands exactly where the dispatch claim's
 * precondition starts: `approved`, with a `reserved` operation and a known
 * `release_by`. Returns everything a claim needs.
 */
async function seedApprovedTaskIntent(
  t: Tenant,
  opts: { taskOverrides?: Partial<typeof aiOperatorTasks.$inferInsert>; releaseBy?: Date } = {},
): Promise<{ intentId: string; taskId: string; revision: number; runId: string }> {
  const task = await createTask(t, opts.taskOverrides);
  const runId = await createRun(t, { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, attemptOrdinal: 0 });
  const auth = buildAgentAuthContext(
    { id: t.agentId, orgId: t.orgId, partnerId: null, name: 'Operator', kind: 'triage' },
    { id: runId, orgId: t.orgId, deviceId: t.deviceId, deviceSiteId: t.siteId },
    { id: t.orgId, partnerId: t.partnerId },
  );
  const snapshot = await createActionIntent(auth, {
    toolName: TOOL_NAME,
    input: serviceInput(t),
    source: 'ai_agent',
    task: { taskId: task.taskId, taskStepKey: TASK_STEP_KEY, operationKey: OPERATION_KEY, attemptOrdinal: 0 },
  });
  expect(snapshot.status).toBe('pending_approval');

  const releaseBy = opts.releaseBy ?? new Date(Date.now() + 600_000);
  const won = await transitionIntent(snapshot.id, 'pending_approval', 'approved', {
    decidedAt: new Date(),
  });
  expect(won).toBe(true);
  // `release_by` is not part of `ActionIntentTransitionPatch` — the real
  // approve fan-in stamps it in its own CAS (routes/approvals.ts). Stamped
  // directly here rather than widening a production type for a fixture; the
  // lease is what the claim's deadline predicate reads, so it has to be real.
  await withSystemDbAccessContext(async () => {
    await db.update(actionIntents).set({ releaseBy }).where(eq(actionIntents.id, snapshot.id));
  });

  return { intentId: snapshot.id, taskId: task.taskId, revision: task.revision, runId };
}

async function readIntent(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
    return row ?? null;
  });
}

async function readOperationByIntent(intentId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.intentId, intentId)).limit(1);
    return row ?? null;
  });
}

async function readTask(taskId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)).limit(1);
    return row ?? null;
  });
}

async function updateTask(taskId: string, patch: Partial<typeof aiOperatorTasks.$inferInsert>) {
  await withSystemDbAccessContext(() =>
    db.update(aiOperatorTasks).set(patch).where(eq(aiOperatorTasks.id, taskId)),
  );
}

async function updateOperation(intentId: string, patch: Partial<typeof aiOperatorOperations.$inferInsert>) {
  await withSystemDbAccessContext(() =>
    db.update(aiOperatorOperations).set(patch).where(eq(aiOperatorOperations.intentId, intentId)),
  );
}

function ref(t: Tenant, intentId: string, taskId: string): TaskLinkedIntentRef {
  return { id: intentId, orgId: t.orgId, taskId };
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('claimTaskLinkedIntentForDispatch (real Postgres, spec §7.3)', () => {
  runDb('happy claim: intent -> executing, operation -> dispatched with the observed lease epoch', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t, { taskOverrides: { leaseEpoch: 42 } });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: true, leaseEpoch: 42 });

    const intentRow = await readIntent(fixture.intentId);
    expect(intentRow!.status).toBe('executing');
    expect(intentRow!.executionStartedAt).not.toBeNull();

    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.dispatchState).toBe('dispatched');
    expect(opRow!.dispatchedAt).not.toBeNull();
    expect(opRow!.claimedLeaseEpoch).toBe(42);
  });

  runDb('concurrent double claim on the SAME intent: exactly one wins, exactly one operation ends dispatched', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    const claimRef = ref(t, fixture.intentId, fixture.taskId);

    // Each call opens its OWN transaction (withSystemDbAccessContext) and
    // takes the task row FOR UPDATE first — that lock is what must serialise
    // these rather than letting both read 'approved'/'reserved' and both win.
    const [a, b] = await Promise.all([
      claimTaskLinkedIntentForDispatch(claimRef),
      claimTaskLinkedIntentForDispatch(claimRef),
    ]);

    const wins = [a, b].filter((r) => r.won);
    const losses = [a, b].filter((r) => !r.won);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);

    const intentRow = await readIntent(fixture.intentId);
    expect(intentRow!.status).toBe('executing');
    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.dispatchState).toBe('dispatched');
  });

  describe('refused when the task cannot admit a new effect', () => {
    runDb.each(['paused', 'stopping', 'completed'] as const)('task state = %s', async (state) => {
      const t = await seedTenant();
      const fixture = await seedApprovedTaskIntent(t);
      await updateTask(fixture.taskId, { state });

      const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
      expect(result).toMatchObject({ won: false, refusal: 'task_not_claimable' });

      // Nothing moved — a lost/refused claim writes nothing at all.
      const intentRow = await readIntent(fixture.intentId);
      expect(intentRow!.status).toBe('approved');
      const opRow = await readOperationByIntent(fixture.intentId);
      expect(opRow!.dispatchState).toBe('reserved');
    });
  });

  runDb('refused when the task deadline has passed', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    await updateTask(fixture.taskId, { deadlineAt: new Date(Date.now() - 60_000) });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: false, refusal: 'task_not_claimable' });
    expect((result as { detail: string }).detail).toContain('deadline');

    expect((await readIntent(fixture.intentId))!.status).toBe('approved');
    expect((await readOperationByIntent(fixture.intentId))!.dispatchState).toBe('reserved');
  });

  runDb('FAIL CLOSED: refused when the task has no deadline at all', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    await updateTask(fixture.taskId, { deadlineAt: null });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: false, refusal: 'task_not_claimable' });
    expect((result as { detail: string }).detail).toContain('no deadline_at');

    expect((await readIntent(fixture.intentId))!.status).toBe('approved');
    expect((await readOperationByIntent(fixture.intentId))!.dispatchState).toBe('reserved');
  });

  runDb('refused when the target is detached (device moved/deleted)', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    await updateTask(fixture.taskId, { targetDetachedAt: new Date(), targetDetachedReason: 'device_moved' });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: false, refusal: 'task_not_claimable' });
    expect((result as { detail: string }).detail).toContain('detached');

    expect((await readIntent(fixture.intentId))!.status).toBe('approved');
    expect((await readOperationByIntent(fixture.intentId))!.dispatchState).toBe('reserved');
  });

  runDb('refused when the plan revision moved after the operation was reserved', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    // The operation pinned revision 1 at reservation; bump the task forward —
    // spec §7.1's "a revised plan creates a new operation and approval; a
    // stale one must not dispatch."
    await updateTask(fixture.taskId, { revision: fixture.revision + 1 });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: false, refusal: 'task_not_claimable' });
    expect((result as { detail: string }).detail).toContain('revision moved');

    expect((await readIntent(fixture.intentId))!.status).toBe('approved');
    expect((await readOperationByIntent(fixture.intentId))!.dispatchState).toBe('reserved');
  });

  runDb("refused when the intent's release lease has passed", async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t, { releaseBy: new Date(Date.now() - 60_000) });

    const result = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(result).toMatchObject({ won: false, refusal: 'intent_not_claimable' });

    // The task predicate passed (it's still running/in-revision/in-deadline);
    // it is specifically the intent CAS's own release-lease guard that fired.
    expect((await readIntent(fixture.intentId))!.status).toBe('approved');
    expect((await readOperationByIntent(fixture.intentId))!.dispatchState).toBe('reserved');
  });
});

describe('revertTaskLinkedDispatchClaim (kill-switch reversal, real Postgres)', () => {
  runDb('a won claim reverses cleanly: executing -> approved, dispatched -> reserved with dispatched_at cleared', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    const won = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(won.won).toBe(true);

    const reverted = await revertTaskLinkedDispatchClaim(fixture.intentId, 'kill_switch_engaged');
    expect(reverted).toBe(true);

    const intentRow = await readIntent(fixture.intentId);
    expect(intentRow!.status).toBe('approved');

    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.dispatchState).toBe('reserved');
    expect(opRow!.dispatchedAt).toBeNull();
  });

  runDb('reverting an already-approved (not executing) intent returns false and touches nothing', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    const won = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(won.won).toBe(true);
    const firstRevert = await revertTaskLinkedDispatchClaim(fixture.intentId, 'kill_switch_engaged');
    expect(firstRevert).toBe(true);

    // Intent is now 'approved' again — a second reversal call (a duplicate
    // delivery, or the kill switch firing twice) must lose its CAS and leave
    // the operation exactly as the first reversal left it.
    const secondRevert = await revertTaskLinkedDispatchClaim(fixture.intentId, 'kill_switch_engaged');
    expect(secondRevert).toBe(false);

    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.dispatchState).toBe('reserved');
    expect(opRow!.dispatchedAt).toBeNull();
  });
});

describe('recordOperationResult (real Postgres, independent of the intent CAS)', () => {
  runDb('persists the execution reference and result while the intent is still executing', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    const claim = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(claim.won).toBe(true);

    const execRefId = randomUUID();
    await recordOperationResult({
      intentId: fixture.intentId,
      resultState: 'succeeded',
      result: { status: 'completed', note: 'first' },
      executionRef: { kind: 'device_command', id: execRefId },
    });

    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.executionRefKind).toBe('device_command');
    expect(opRow!.executionRefId).toBe(execRefId);
    expect(opRow!.resultState).toBe('succeeded');
    expect(opRow!.result).toMatchObject({ status: 'completed', note: 'first' });
    expect(opRow!.resultAt).not.toBeNull();

    // The intent itself is untouched by this call — recordOperationResult
    // never CASes action_intents.
    expect((await readIntent(fixture.intentId))!.status).toBe('executing');
  });

  runDb('still lands after the intent is flipped to failed BY HAND — the write does not depend on winning a CAS', async () => {
    const t = await seedTenant();
    const fixture = await seedApprovedTaskIntent(t);
    const claim = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
    expect(claim.won).toBe(true);

    // First write: a low-rank 'unknown' (the reaper's own outcome shape),
    // recorded while everything is still nominally in flight.
    await recordOperationResult({
      intentId: fixture.intentId,
      resultState: 'unknown',
      result: { note: 'reaper-shaped' },
    });
    expect((await readOperationByIntent(fixture.intentId))!.resultState).toBe('unknown');

    // Flip the intent's OWN status to a terminal one by hand — simulating
    // the stale-executing reaper (or any other writer) having already moved
    // it. The intent's CAS state has nothing to do with whether the
    // operation row can still be written.
    await transitionIntent(fixture.intentId, 'executing', 'failed', { errorCode: 'execution_lost' });

    const execRefId = randomUUID();
    await recordOperationResult({
      intentId: fixture.intentId,
      resultState: 'succeeded',
      result: { status: 'completed', note: 'late-real-result' },
      executionRef: { kind: 'device_command', id: execRefId },
    });

    const opRow = await readOperationByIntent(fixture.intentId);
    expect(opRow!.resultState).toBe('succeeded');
    expect(opRow!.result).toMatchObject({ status: 'completed', note: 'late-real-result' });
    expect(opRow!.executionRefKind).toBe('device_command');
    expect(opRow!.executionRefId).toBe(execRefId);

    // The intent stays exactly where the hand-flip left it — recordOperationResult
    // does not (and must not) touch action_intents.
    expect((await readIntent(fixture.intentId))!.status).toBe('failed');
  });

  describe('rank ordering (unknown < succeeded/failed < nothing overwrites a definite outcome)', () => {
    runDb.each(['succeeded', 'failed'] as const)(
      "'unknown' does NOT overwrite a recorded '%s'",
      async (definiteState) => {
        const t = await seedTenant();
        const fixture = await seedApprovedTaskIntent(t);
        await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));

        await recordOperationResult({
          intentId: fixture.intentId,
          resultState: definiteState,
          result: { note: 'definite-first' },
        });
        const before = await readOperationByIntent(fixture.intentId);
        expect(before!.resultState).toBe(definiteState);
        const resultAtBefore = before!.resultAt;

        // A late 'unknown' (e.g. the reaper firing after a real result
        // already landed) must not clobber the definite outcome.
        await recordOperationResult({
          intentId: fixture.intentId,
          resultState: 'unknown',
          result: { note: 'stale-unknown' },
        });

        const after = await readOperationByIntent(fixture.intentId);
        expect(after!.resultState).toBe(definiteState);
        expect(after!.result).toMatchObject({ note: 'definite-first' });
        expect(after!.resultAt?.getTime()).toBe(resultAtBefore?.getTime());
      },
    );

    runDb("a definite 'succeeded' DOES overwrite a recorded 'unknown'", async () => {
      const t = await seedTenant();
      const fixture = await seedApprovedTaskIntent(t);
      await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));

      await recordOperationResult({
        intentId: fixture.intentId,
        resultState: 'unknown',
        result: { note: 'reaper-first' },
      });
      expect((await readOperationByIntent(fixture.intentId))!.resultState).toBe('unknown');

      const execRefId = randomUUID();
      await recordOperationResult({
        intentId: fixture.intentId,
        resultState: 'succeeded',
        result: { status: 'completed', note: 'late-real-result' },
        executionRef: { kind: 'device_command', id: execRefId },
      });

      const after = await readOperationByIntent(fixture.intentId);
      expect(after!.resultState).toBe('succeeded');
      expect(after!.result).toMatchObject({ status: 'completed', note: 'late-real-result' });
      expect(after!.executionRefId).toBe(execRefId);
    });
  });
});

describe('reapStaleExecutingIntents (real Postgres, spec §7.3 "three clocks")', () => {
  runDb(
    "marks a stale-executing task-linked intent failed/execution_lost, and its operation 'unknown' (NEVER 'failed')",
    async () => {
      const t = await seedTenant();
      const fixture = await seedApprovedTaskIntent(t);
      const claim = await claimTaskLinkedIntentForDispatch(ref(t, fixture.intentId, fixture.taskId));
      expect(claim.won).toBe(true);

      // Backdate execution_started_at past the 20-minute stale-executing
      // threshold (jobs/intentExpiryReaper.ts's STALE_EXECUTING_TIMEOUT_MINUTES).
      await withSystemDbAccessContext(() =>
        db
          .update(actionIntents)
          .set({ executionStartedAt: new Date(Date.now() - 25 * 60 * 1000) })
          .where(eq(actionIntents.id, fixture.intentId)),
      );

      // reapStaleExecutingIntents() opens no context of its own — the
      // scheduled loop's own runWithSystemDbAccess wrapper supplies it
      // (intentExpiryReaper.ts:390-391); replicate that here rather than
      // calling it bare.
      const reaped = await withSystemDbAccessContext(() => reapStaleExecutingIntents());
      expect(reaped).toBeGreaterThanOrEqual(1);

      const intentRow = await readIntent(fixture.intentId);
      expect(intentRow!.status).toBe('failed');
      expect(intentRow!.errorCode).toBe('execution_lost');

      // THE property spec §7.3 forbids getting backwards: the server giving
      // up after 20 minutes is not proof the effect failed — the device
      // command itself stays open to a late agent result past its own
      // 5-minute reap. 'unknown', never 'failed'.
      const opRow = await readOperationByIntent(fixture.intentId);
      expect(opRow!.resultState).toBe('unknown');
      expect(opRow!.resultState).not.toBe('failed');
      expect(opRow!.resultAt).not.toBeNull();
    },
  );
});
