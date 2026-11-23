/**
 * #11965 — a device-troubleshooting run parked `awaiting_approval` settles to
 * `completed` once every step it proposed is final, against real Postgres.
 *
 *   - each way a step ends (ran, failed, denied, expired, cancelled) reaches
 *     settlement through the intent outbox job the release worker consumes;
 *   - a run with a step still open (waiting, approved, executing) never moves;
 *   - the settlement fires once under concurrent settlers, and two steps
 *     finalised in overlapping transactions never leave the run parked;
 *   - the reconciler sweep settles a run every fast path missed;
 *   - settlement creates no intent, enqueues no release and never touches a
 *     task-linked or non-troubleshooting run.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const postSpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../services/wisp/specialistResult', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/wisp/specialistResult')>();
  return {
    ...actual,
    postSpecialistResult: vi.fn(async (runId: string) => {
      postSpy.calls.push(runId);
      return { posted: false, reason: 'no_grant' } as const;
    }),
    postSpecialistStepOutcome: vi.fn(async () => ({ posted: false, reason: 'no_grant' } as const)),
  };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents, aiAgentRuns, aiAgents, aiOperatorTasks, devices, intentOutbox, wispGrantRevisions, wispGrants,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { createAndEnqueueAgentRun, registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { requestSpecialist } from '../../services/wisp/coordinator';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import type { AuthContext } from '../../middleware/auth';
import { specialistDedupeKey } from '../../services/wisp/specialistLaunchers';
import { publishEvent } from '../../services/eventBus';
import { processIntentReleaseJob, terminalizeIntent } from '../../jobs/intentReleaseWorker';
import { reapExpiredIntents } from '../../jobs/intentExpiryReaper';
import { loadTriggerSubject, triggerConditionOf } from '../../services/wisp/checkInTriggers';
import {
  settleApprovalParkedRun,
  settleApprovalParkedRunLocked,
  sweepApprovalParkedRuns,
} from '../../services/aiAgents/runApprovalSettlement';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions,
} from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const PERMS = [
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'ai_agents', action: 'write' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `settle-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, PERMS);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
  const admin = await createUser({ partnerId: partner.id, email: `settle-admin-${randomUUID()}@wisp.test` });
  const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');

  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `settle-${unique}`, hostname: `settle-${unique}`,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id, siteId: devices.siteId }));
  await sys(() => db.insert(aiAgents).values({
    partnerId: partner.id, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: admin.id,
  } as never));

  const grant = await sys(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: PERMS.map((p) => `${p.resource}:${p.action}`), orgIds: [org.id], siteIds: null,
      toolAllowlist: null, deniedTools: [],
    };
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
  return { partner, org, admin, deviceId: device!.id, deviceSiteId: device!.siteId, grant };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

/** A real troubleshooting run (admitted through the coordinator), finished `awaiting_approval` as finishRun leaves it. */
async function seedParkedRun(t: Tenant, steps: number) {
  const parent = await createAndEnqueueAgentRun({
    orgId: t.org.id, kind: 'triage', triggerKind: 'manual', deviceId: t.deviceId, dedupeKey: `manual:${randomUUID()}`,
    grant: { grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId },
  });
  if (!parent.created) throw new Error(`expected admission, got ${parent.skipped}`);
  await sys(() => db.update(aiAgentRuns).set({ profile: 'assessment' }).where(eq(aiAgentRuns.id, parent.run.id)));

  const approver = {
    principal: { kind: 'user_session' },
    user: { id: t.admin.id, email: 'admin@wisp.test', name: 'Admin', isPlatformAdmin: false },
    token: null, partnerId: t.partner.id, orgId: null, scope: 'partner',
    accessibleOrgIds: [t.org.id], partnerOrgAccess: 'all',
    orgCondition: () => undefined, canAccessOrg: (id: string) => id === t.org.id,
  } as unknown as AuthContext;
  const requestId = randomUUID();
  const admitted = await requestSpecialist(
    {
      grantId: t.grant.grantId, grantRevisionId: t.grant.revisionId, orgId: t.org.id, kind: 'device_troubleshooting',
      params: { deviceId: t.deviceId, goal: 'Outlook crashes on start' }, requestedByRunId: parent.run.id,
    },
    { requester: { kind: 'approval', intentId: randomUUID(), auth: approver }, requestId },
  );
  expect(admitted).toMatchObject({ admitted: true });
  const [run] = await sys(() => db.select().from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, t.org.id), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId)))));
  const [agent] = await sys(() => db.select().from(aiAgents).where(eq(aiAgents.id, run!.agentId)));
  const agentAuth = buildAgentAuthContext(
    agent!,
    { id: run!.id, orgId: t.org.id, deviceId: t.deviceId, deviceSiteId: t.deviceSiteId },
    { id: t.org.id, partnerId: t.partner.id },
  );
  const intentIds: string[] = [];
  for (let i = 0; i < steps; i++) {
    const intent = await createActionIntent(agentAuth, {
      toolName: 'set_device_context',
      input: { deviceId: t.deviceId, contextType: 'issue', summary: `Finding ${i} ${randomUUID()}` },
      source: 'ai_agent',
      orgId: t.org.id,
    });
    expect(intent).toMatchObject({ status: 'pending_approval' });
    intentIds.push(intent.id);
  }
  // finishRun's terminal write for a run whose proposals await a person.
  await sys(() => db.update(aiAgentRuns).set({
    status: 'awaiting_approval', intentIds, finishedAt: new Date(), startedAt: new Date(),
  }).where(eq(aiAgentRuns.id, run!.id)));
  return { runId: run!.id, intentIds };
}

async function runRow(runId: string) {
  const [row] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
  return row!;
}

async function intentRow(intentId: string) {
  const [row] = await sys(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
  return row!;
}

const completedPublishes = (runId: string) => vi.mocked(publishEvent).mock.calls
  .filter(([type, , payload]) => type === 'ai.agent.run.completed' && (payload as { runId?: string }).runId === runId);

async function decide(intentId: string, to: 'rejected' | 'cancelled' | 'approved') {
  expect(await transitionIntent(intentId, 'pending_approval', to, { decidedAt: new Date() })).toBe(true);
}

/** Approved, claimed and finished by the release worker's own terminal writer. */
async function runStep(intentId: string, to: 'completed' | 'failed') {
  await decide(intentId, 'approved');
  expect(await transitionIntent(intentId, 'approved', 'executing', {})).toBe(true);
  const intent = await intentRow(intentId);
  expect(await terminalizeIntent(intent, to, to === 'completed'
    ? { result: { ok: true }, executedAt: new Date() }
    : { errorCode: 'tool_failed', executedAt: new Date() } as never)).toBe(true);
}

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
  registerAgentRunEnqueuer(async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` }));
  vi.mocked(publishEvent).mockClear();
  postSpy.calls.length = 0;
});
afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('a parked troubleshooting run settles when its last step is final (#11965)', () => {
  it('ran + denied + expired + cancelled + failed: each outbox job settles only once nothing is open', async () => {
    const t = await seedTenant();
    const { runId, intentIds: [ran, denied, expired, cancelled, failed] } = await seedParkedRun(t, 5);

    await runStep(ran!, 'completed');
    await processIntentReleaseJob({ intentId: ran!, eventType: 'intent_completed' });
    expect((await runRow(runId)).status).toBe('awaiting_approval');

    await decide(denied!, 'rejected');
    await processIntentReleaseJob({ intentId: denied!, eventType: 'intent_rejected' });
    expect((await runRow(runId)).status).toBe('awaiting_approval');

    await sys(() => db.update(actionIntents).set({ approvalExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(actionIntents.id, expired!)));
    expect(await sys(() => reapExpiredIntents())).toBeGreaterThanOrEqual(1);
    expect((await intentRow(expired!)).status).toBe('expired');
    await processIntentReleaseJob({ intentId: expired!, eventType: 'intent_expired' });
    expect((await runRow(runId)).status).toBe('awaiting_approval');

    await decide(cancelled!, 'cancelled');
    await processIntentReleaseJob({ intentId: cancelled!, eventType: 'intent_cancelled' });
    expect((await runRow(runId)).status).toBe('awaiting_approval');
    expect(completedPublishes(runId)).toHaveLength(0);
    expect(postSpy.calls).toEqual([]);

    await runStep(failed!, 'failed');
    await processIntentReleaseJob({ intentId: failed!, eventType: 'intent_failed' });
    const settled = await runRow(runId);
    expect(settled.status).toBe('completed');
    expect(completedPublishes(runId)).toHaveLength(1);
    expect(completedPublishes(runId)[0]![2]).toMatchObject({ runId, settledAfterApproval: true });
    expect(postSpy.calls).toEqual([runId]);

    // A redelivered job changes nothing and tells nobody twice.
    await processIntentReleaseJob({ intentId: failed!, eventType: 'intent_failed' });
    expect(completedPublishes(runId)).toHaveLength(1);
    expect(postSpy.calls).toEqual([runId]);
  });

  it('each single final path settles a one-step run', async () => {
    for (const path of ['completed', 'failed', 'rejected', 'cancelled', 'expired'] as const) {
      const t = await seedTenant();
      const { runId, intentIds: [step] } = await seedParkedRun(t, 1);
      if (path === 'completed' || path === 'failed') await runStep(step!, path);
      else if (path === 'expired') {
        await sys(() => db.update(actionIntents).set({ approvalExpiresAt: new Date(Date.now() - 60_000) })
          .where(eq(actionIntents.id, step!)));
        await sys(() => reapExpiredIntents());
      } else await decide(step!, path);
      await processIntentReleaseJob({ intentId: step!, eventType: `intent_${path}` as never });
      expect({ path, status: (await runRow(runId)).status }).toEqual({ path, status: 'completed' });
    }
  });

  it('a step still waiting, approved or executing keeps the run parked', async () => {
    const t = await seedTenant();
    const { runId, intentIds: [a, b] } = await seedParkedRun(t, 2);
    await decide(a!, 'rejected');
    // b waiting for a person
    expect(await settleApprovalParkedRun(runId)).toBe(false);
    // b approved, not yet released
    await decide(b!, 'approved');
    expect(await settleApprovalParkedRun(runId)).toBe(false);
    // b claimed by the release worker
    expect(await transitionIntent(b!, 'approved', 'executing', {})).toBe(true);
    expect(await settleApprovalParkedRun(runId)).toBe(false);
    expect((await runRow(runId)).status).toBe('awaiting_approval');
    expect(completedPublishes(runId)).toHaveLength(0);
  });

  it('run_settled reads the open steps with real SQL: not settled while one is open', async () => {
    const t = await seedTenant();
    const { runId, intentIds: [a, b] } = await seedParkedRun(t, 2);
    const parked = await loadTriggerSubject('run_settled', runId);
    expect(parked).toMatchObject({ status: 'awaiting_approval', openSteps: 2 });
    expect(triggerConditionOf(parked!, new Date()).met).toBe(false);
    await decide(a!, 'rejected');
    await decide(b!, 'approved');
    expect(await loadTriggerSubject('run_settled', runId)).toMatchObject({ status: 'awaiting_approval', openSteps: 1 });
    await sys(() => db.update(actionIntents).set({ status: 'cancelled' }).where(eq(actionIntents.id, b!)));
    const done = await loadTriggerSubject('run_settled', runId);
    expect(done).toMatchObject({ status: 'awaiting_approval', openSteps: 0 });
    expect(triggerConditionOf(done!, new Date()).met).toBe(true);
  });

  it('settlement writes no intent, no outbox row and no release; the run keeps its finish time', async () => {
    const t = await seedTenant();
    const { runId, intentIds: [a] } = await seedParkedRun(t, 1);
    await decide(a!, 'rejected');
    const before = await runRow(runId);
    const intentsBefore = await sys(() => db.select({ id: actionIntents.id, status: actionIntents.status })
      .from(actionIntents).where(eq(actionIntents.requestingAgentRunId, runId)));
    const outboxRows = async () => (await sys(() => db.select({ n: sql<number>`count(*)::int` }).from(intentOutbox)
      .where(inArray(intentOutbox.intentId, intentsBefore.map((i) => i.id)))))[0]?.n;
    const outboxBefore = await outboxRows();

    expect(await settleApprovalParkedRun(runId)).toBe(true);

    const after = await runRow(runId);
    expect(after.status).toBe('completed');
    expect(after.finishedAt?.toISOString()).toBe(before.finishedAt?.toISOString());
    expect(await sys(() => db.select({ id: actionIntents.id, status: actionIntents.status })
      .from(actionIntents).where(eq(actionIntents.requestingAgentRunId, runId)))).toEqual(intentsBefore);
    expect(await outboxRows()).toBe(outboxBefore);
  });

  it('concurrent settlers: one transition, one completed event, one post', async () => {
    const t = await seedTenant();
    const { runId, intentIds } = await seedParkedRun(t, 2);
    for (const id of intentIds) await decide(id, 'rejected');
    const results = await Promise.all(Array.from({ length: 8 }, () => settleApprovalParkedRun(runId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('completed');
    expect(completedPublishes(runId)).toHaveLength(1);
    expect(postSpy.calls).toEqual([runId]);
  });

  it('two last steps finalised in overlapping transactions never leave the run parked', async () => {
    const t = await seedTenant();
    const { runId, intentIds: [a, b] } = await seedParkedRun(t, 2);
    // Both decisions are written before either transaction checks the run:
    // without the row lock each would see the other step still open.
    let release!: () => void;
    const bothWritten = new Promise<void>((r) => { release = r; });
    let written = 0;
    const finalise = (id: string) => sys(async () => {
      await db.update(actionIntents).set({ status: 'rejected', decidedAt: new Date() }).where(eq(actionIntents.id, id));
      written += 1;
      if (written === 2) release();
      await bothWritten;
      return settleApprovalParkedRunLocked(runId);
    });
    const won = await Promise.all([finalise(a!), finalise(b!)]);
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('completed');
  });

  it('the sweep settles a run no job reached, and leaves open, task-linked and other-profile runs alone', async () => {
    const t = await seedTenant();
    const missed = await seedParkedRun(t, 1);
    const open = await seedParkedRun(t, 1);
    const otherProfile = await seedParkedRun(t, 1);
    const taskLinked = await seedParkedRun(t, 1);
    for (const r of [missed, otherProfile, taskLinked]) await decide(r.intentIds[0]!, 'rejected');
    await sys(() => db.update(aiAgentRuns).set({ profile: 'full' }).where(eq(aiAgentRuns.id, otherProfile.runId)));
    const taskAgentId = (await runRow(taskLinked.runId)).agentId;
    const [task] = await sys(() => db.insert(aiOperatorTasks).values({
      orgId: t.org.id, agentId: taskAgentId, agentKind: 'triage', agentName: 'Operator',
      workflowKey: 'service_recovery', workflowVersion: 1, originKind: 'manual' as const,
      objective: 'A task-linked parked run', deviceId: t.deviceId, state: 'running', revision: 1, leaseEpoch: 0,
      deadlineAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: aiOperatorTasks.id }));
    await sys(() => db.update(aiAgentRuns).set({ taskId: task!.id, taskStepKey: 'diagnose', taskAttemptOrdinal: 1 } as never)
      .where(eq(aiAgentRuns.id, taskLinked.runId)));

    const swept = await sweepApprovalParkedRuns();
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    expect((await runRow(missed.runId)).status).toBe('completed');
    expect((await runRow(open.runId)).status).toBe('awaiting_approval');
    expect((await runRow(otherProfile.runId)).status).toBe('awaiting_approval');
    expect((await runRow(taskLinked.runId)).status).toBe('awaiting_approval');
    expect(await settleApprovalParkedRun(otherProfile.runId)).toBe(false);
    expect(await settleApprovalParkedRun(taskLinked.runId)).toBe(false);
  });
});
