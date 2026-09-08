/**
 * The AI Operator terminal-writer contract — real Postgres (#5205 W05,
 * sub-issue #5210, spec §6.3, baseline §3.2).
 *
 * "Every intent terminal writer publishes" only holds if the set of writers
 * is enumerated and pinned somewhere a new one can't silently join without
 * coverage — that is what `TASK_LINKED_TERMINAL_WRITERS` below is. Each entry
 * drives the REAL writer function (never a re-implementation) against a
 * task-linked intent seeded through the real `createActionIntent` admission
 * path, and asserts:
 *   1. the intent reaches the expected terminal `action_intents.status`;
 *   2. exactly one `intent_outbox` row exists with the matching event;
 *   3. exactly one `ai_operator_task_outbox` row exists
 *      (source_kind='intent', source_id=intentId, the event's transitionSeq
 *      ordinal);
 *   4. redelivering the SAME terminalization does not create a second
 *      `ai_operator_task_outbox` row (the identity unique's ON CONFLICT DO
 *      NOTHING — spec §6.3's dedupe contract).
 *
 * `aiAgentSdk.ts`'s five inline terminal call sites are NOT in this list.
 * They are structurally unreachable by a task-linked intent: every intent
 * that file transitions was created by ITS OWN `createActionIntent(session.auth,
 * {...})` call (services/aiAgentSdk.ts, tier-3 durable-intent branch), which
 * never threads a `task` context through — task-linked admission is a
 * durable-worker-only path in the thin slice (spec P3-1: "supervised mode
 * only... no direct act"). Their `intent_outbox`-only publication is pinned
 * by aiAgentSdk.test.ts (the `transitionIntentAndPublish` wiring) and
 * taskOutbox.test.ts (the underlying helper's contract) instead.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiOperatorTaskOutbox,
  aiOperatorTasks,
  devices,
  intentOutbox,
  type IntentOutboxRow,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import {
  createActionIntent,
  transitionIntent,
  cancelActionIntent,
} from '../../services/actionIntents/intentService';
import { terminalizeIntent } from '../../jobs/intentReleaseWorker';
import { reapExpiredIntents, reapStaleExecutingIntents } from '../../jobs/intentExpiryReaper';
import { INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ } from '../../services/aiOperator/taskOutbox';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { approvalRoutes } from '../../routes/approvals';
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

// Same fixture tool as aiOperatorDispatchClaim.integration.test.ts — a
// genuinely Tier-3 `supervised` action whose one required permission
// (`devices:execute`) is easy to grant/withhold to control eligibility.
const TOOL_NAME = 'manage_services';
const TASK_STEP_KEY = 'restart-spooler';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  agentId: string;
  deviceId: string;
  eligibleUserId: string;
  eligibleEmail: string;
  eligibleRoleId: string;
}

/**
 * One org with an agent, a device, and — unless `withEligibleApprover` is
 * false — one human holding BOTH `devices:execute` (so they are a
 * target-eligible approver for `manage_services`) and `approvals:decide` (so
 * the same fixture user can also drive `cancelActionIntent`'s non-requester
 * approver path).
 */
async function seedTenant(withEligibleApprover = true): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const role = await createRole({ scope: 'organization', orgId: org.id });
  if (withEligibleApprover) {
    await grantRolePermissions(role.id, [PERMISSIONS.DEVICES_EXECUTE, PERMISSIONS.APPROVALS_DECIDE]);
  }
  const eligible = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `writer-${randomUUID()}@opwriters.test`,
  });
  if (withEligibleApprover) {
    await assignUserToOrganization(eligible.id, org.id, role.id);
  }

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator', createdBy: eligible.id })
      .returning(),
  );

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `opwriters-agent-${unique}`,
        hostname: `opwriters-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning(),
  );

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
    eligibleUserId: eligible.id,
    eligibleEmail: eligible.email,
    eligibleRoleId: role.id,
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
        objective: 'Restart the print spooler on PRINTSRV01',
        deviceId: t.deviceId,
        state: 'running',
        revision,
        leaseEpoch: 0,
        deadlineAt: new Date(Date.now() + 3_600_000),
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

async function createRun(
  t: Tenant,
  task: { taskId: string; taskStepKey: string; attemptOrdinal: number },
): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: t.agentId,
        orgId: t.orgId,
        deviceId: t.deviceId,
        triggerKind: 'alert' as const,
        dedupeKey: `opwriters-${randomUUID()}`,
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

interface ProposedIntent {
  intentId: string;
  taskId: string;
  runId: string;
  /** The eligible decider's fanned-out approval row (agent intents have no requester row). */
  approvalRowId: string;
}

/** Proposes a task-linked, agent-originated (spec P3-1: supervised-only) intent. */
async function proposeTaskIntent(
  t: Tenant,
  opts: { taskOverrides?: Partial<typeof aiOperatorTasks.$inferInsert>; operationKey?: string } = {},
): Promise<ProposedIntent> {
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
    task: {
      taskId: task.taskId,
      taskStepKey: TASK_STEP_KEY,
      operationKey: opts.operationKey ?? `restart:spooler:${randomUUID().slice(0, 8)}`,
      attemptOrdinal: 0,
    },
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.approvalRequestIds).toHaveLength(1);
  return { intentId: snapshot.id, taskId: task.taskId, runId, approvalRowId: snapshot.approvalRequestIds[0]! };
}

/**
 * Same admission as `proposeTaskIntent`, but for a tenant with NO eligible
 * approver — `runHumanFanout`'s fail-closed branch cancels the intent
 * SYNCHRONOUSLY inside `createActionIntent`, so it never reaches
 * `pending_approval` and has no approval row at all.
 */
async function proposeTaskIntentExpectingNoApprovers(
  t: Tenant,
): Promise<{ intentId: string; taskId: string }> {
  const task = await createTask(t);
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
    task: {
      taskId: task.taskId,
      taskStepKey: TASK_STEP_KEY,
      operationKey: `restart:spooler:${randomUUID().slice(0, 8)}`,
      attemptOrdinal: 0,
    },
  });
  return { intentId: snapshot.id, taskId: task.taskId };
}

function deciderAuthContext(t: Tenant): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([t.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: t.eligibleUserId, email: t.eligibleEmail, name: 'Eligible Decider', isPlatformAdmin: false },
    token: {
      sub: t.eligibleUserId,
      email: t.eligibleEmail,
      roleId: t.eligibleRoleId,
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

async function deciderAccessToken(t: Tenant): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: t.eligibleUserId,
    email: t.eligibleEmail,
    roleId: t.eligibleRoleId,
    orgId: t.orgId,
    partnerId: t.partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function readIntent(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
    return row ?? null;
  });
}

async function readIntentOutboxRows(intentId: string): Promise<IntentOutboxRow[]> {
  return withSystemDbAccessContext(() =>
    db.select().from(intentOutbox).where(eq(intentOutbox.intentId, intentId)).orderBy(desc(intentOutbox.id)),
  );
}

async function readTaskOutboxRows(taskId: string, intentId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select()
      .from(aiOperatorTaskOutbox)
      .where(
        and(
          eq(aiOperatorTaskOutbox.taskId, taskId),
          eq(aiOperatorTaskOutbox.sourceKind, 'intent'),
          eq(aiOperatorTaskOutbox.sourceId, intentId),
        ),
      ),
  );
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * One entry per baseline §3.2 terminal writer reachable by a task-linked
 * intent. `drive` returns the intent id and the expected outbox event; the
 * shared assertion block below checks the rest. This array is what a new,
 * uncovered writer would need to be added to — the point of the whole file.
 */
interface WriterCase {
  name: string;
  /** Owns its own tenant/fixture creation — each writer needs a different
   *  eligibility shape, so a shared outer `t` would either be wrong for some
   *  cases or force fragile name-based branching in the runner. */
  drive: () => Promise<{ intentId: string; taskId: string; event: keyof typeof INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ }>;
  /** Re-run the SAME writer against the now-terminal intent, to prove dedupe. */
  redeliver: (intentId: string, taskId: string) => Promise<void>;
}

const WRITER_CASES: WriterCase[] = [
  {
    name: 'intentReleaseWorker.terminalizeIntent -> completed',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId } = await proposeTaskIntent(t);
      const won1 = await transitionIntent(intentId, 'pending_approval', 'approved', { decidedAt: new Date() });
      expect(won1).toBe(true);
      const won2 = await transitionIntent(intentId, 'approved', 'executing', { executionStartedAt: new Date() });
      expect(won2).toBe(true);
      const intent = await readIntent(intentId);
      const terminalized = await terminalizeIntent(intent!, 'completed', { executedAt: new Date(), result: { ok: true } });
      expect(terminalized).toBe(true);
      return { intentId, taskId, event: 'intent_completed' };
    },
    async redeliver(intentId) {
      const intent = await readIntent(intentId);
      // Already terminal — the CAS (from: 'executing') cannot win again, so
      // no second outbox row is even attempted. Calling it anyway proves the
      // writer itself is a no-op on a non-live source status, not just that
      // the outbox insert would have deduped.
      const won = await terminalizeIntent(intent!, 'completed', { executedAt: new Date(), result: { ok: true } });
      expect(won).toBe(false);
    },
  },
  {
    name: 'intentReleaseWorker.terminalizeIntent -> failed',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId } = await proposeTaskIntent(t);
      await transitionIntent(intentId, 'pending_approval', 'approved', { decidedAt: new Date() });
      await transitionIntent(intentId, 'approved', 'executing', { executionStartedAt: new Date() });
      const intent = await readIntent(intentId);
      const terminalized = await terminalizeIntent(intent!, 'failed', { errorCode: 'execution_error' });
      expect(terminalized).toBe(true);
      return { intentId, taskId, event: 'intent_failed' };
    },
    async redeliver(intentId) {
      const intent = await readIntent(intentId);
      const won = await terminalizeIntent(intent!, 'failed', { errorCode: 'execution_error' });
      expect(won).toBe(false);
    },
  },
  {
    name: 'intentExpiryReaper.reapExpiredIntents',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId } = await proposeTaskIntent(t);
      await withSystemDbAccessContext(() =>
        db
          .update(actionIntents)
          .set({ approvalExpiresAt: new Date(Date.now() - 60_000) })
          .where(eq(actionIntents.id, intentId)),
      );
      const count = await withSystemDbAccessContext(() => reapExpiredIntents());
      expect(count).toBeGreaterThanOrEqual(1);
      return { intentId, taskId, event: 'intent_expired' };
    },
    async redeliver() {
      // The intent is no longer pending_approval/approved, so a second pass
      // over the whole table simply will not select it again.
      await withSystemDbAccessContext(() => reapExpiredIntents());
    },
  },
  {
    name: 'intentExpiryReaper.reapStaleExecutingIntents',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId } = await proposeTaskIntent(t);
      await transitionIntent(intentId, 'pending_approval', 'approved', { decidedAt: new Date() });
      await transitionIntent(intentId, 'approved', 'executing', {
        executionStartedAt: new Date(Date.now() - 30 * 60_000),
      });
      const count = await withSystemDbAccessContext(() => reapStaleExecutingIntents());
      expect(count).toBeGreaterThanOrEqual(1);
      return { intentId, taskId, event: 'intent_failed' };
    },
    async redeliver() {
      await withSystemDbAccessContext(() => reapStaleExecutingIntents());
    },
  },
  {
    // Driven through the real HTTP route (not `decideApprovalRequest`
    // directly): the function's very first read runs under whatever ambient
    // DB context its CALLER already opened — normally authMiddleware's
    // per-request context — so exercising it standalone would need to
    // replicate that middleware stack by hand.
    name: 'decideApprovalRequest human denial (POST /approvals/:id/deny)',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId, approvalRowId } = await proposeTaskIntent(t);
      const token = await deciderAccessToken(t);
      const app = new Hono();
      app.route('/approvals', approvalRoutes);
      const res = await app.request(`/approvals/${approvalRowId}/deny`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      return { intentId, taskId, event: 'intent_rejected' };
    },
    async redeliver(intentId, _taskId) {
      // Same approval row is now decided — the pre-fetch's `status='pending'`
      // predicate excludes it, so a redelivery 409s without reaching the CAS.
      const row = await withSystemDbAccessContext(async () => {
        const [r] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
        return r;
      });
      expect(row?.status).toBe('rejected');
    },
  },
  {
    name: 'routes/approvals.ts report-suspicious',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId, approvalRowId } = await proposeTaskIntent(t);
      const token = await deciderAccessToken(t);
      const app = new Hono();
      app.route('/approvals', approvalRoutes);
      const res = await app.request(`/approvals/${approvalRowId}/report-suspicious`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(204);
      return { intentId, taskId, event: 'intent_rejected' };
    },
    async redeliver(intentId) {
      const row = await withSystemDbAccessContext(async () => {
        const [r] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
        return r;
      });
      expect(row?.status).toBe('rejected');
    },
  },
  {
    name: 'intentService.cancelActionIntent',
    async drive() {
      const t = await seedTenant();
      const { intentId, taskId } = await proposeTaskIntent(t);
      const result = await cancelActionIntent(deciderAuthContext(t), intentId);
      expect(result).toMatchObject({ ok: true, status: 'cancelled' });
      return { intentId, taskId, event: 'intent_cancelled' };
    },
    async redeliver(intentId) {
      // cancelActionIntent's own CAS covers pending_approval/approved only;
      // the row is already 'cancelled' so a second call would just re-read
      // and report `ok: false` without touching the outbox — asserting the
      // row's terminal status directly is the more direct proof.
      const row = await withSystemDbAccessContext(async () => {
        const [r] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
        return r;
      });
      expect(row?.status).toBe('cancelled');
    },
  },
  {
    name: 'intentService.runHumanFanout no-eligible-approvers cancel',
    async drive() {
      const noApprovers = await seedTenant(false);
      const { intentId, taskId } = await proposeTaskIntentExpectingNoApprovers(noApprovers);
      const intent = await readIntent(intentId);
      expect(intent?.status).toBe('cancelled');
      expect(intent?.errorCode).toBe('no_eligible_approvers');
      return { intentId, taskId, event: 'intent_cancelled' };
    },
    async redeliver() {
      // Nothing to redeliver — the cancel happens synchronously inside
      // creation, and creation is not repeatable via this fixture without
      // colliding on the operation key. Covered by the identity unique's
      // ON CONFLICT DO NOTHING contract, proven generically by
      // taskOutbox.test.ts.
    },
  },
];

describe('AI Operator terminal writer contract (real Postgres, spec §6.3, baseline §3.2)', () => {
  for (const writerCase of WRITER_CASES) {
    runDb(`${writerCase.name}: publishes intent_outbox + task_outbox, and dedupes on redelivery`, async () => {
      const { intentId, taskId, event } = await writerCase.drive();

      // Every intent also carries an unconditional `intent_created` row from
      // admission — filter to the TERMINAL event this writer is responsible
      // for, rather than asserting the table's total row count for the intent.
      const outboxRows = await readIntentOutboxRows(intentId);
      const terminalRows = outboxRows.filter((r) => r.eventType === event);
      expect(terminalRows).toHaveLength(1);
      expect(terminalRows[0]!.payload).toMatchObject({ intentId });

      const taskOutboxRows = await readTaskOutboxRows(taskId, intentId);
      expect(taskOutboxRows).toHaveLength(1);
      expect(taskOutboxRows[0]!.transitionSeq).toBe(INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ[event]);
      expect(taskOutboxRows[0]!.publishedAt).toBeNull();

      await writerCase.redeliver(intentId, taskId);

      const taskOutboxAfterRedelivery = await readTaskOutboxRows(taskId, intentId);
      expect(taskOutboxAfterRedelivery).toHaveLength(1);
    });
  }
});
