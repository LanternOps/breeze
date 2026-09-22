/**
 * Tenancy proof for the human-work link (Recipe Library wave E3, #6168).
 *
 * The link joins a table whose `org_id` MOVES (`ticket_checklist_items`, in
 * TICKET_ORG_DENORMALIZED_TABLES) to one whose `org_id` is immutable task
 * history (`ai_operator_task_steps`). Migration 2026-10-26-170100 makes the
 * owning FK plain and single-column ON PURPOSE, so nothing in the database
 * raises when the two rows end up in different tenants. This file proves the
 * three things that have to be true instead:
 *
 *   1. RLS still isolates both tables as `breeze_app` (non-vacuous forge).
 *   2. The org-constrained join in `readHumanWorkStep` refuses to read a
 *      foreign item even when the pointer resolves.
 *   3. Every mover that can separate the rows — ticket org-move, org merge,
 *      org erasure — completes WITHOUT 23503 and leaves the task in a state it
 *      can explain (detached + handed off, fenced, or gone).
 *
 * Runs under vitest.integration.config.ts. Fresh fixture per test.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { taskCheckpointSchema, type TaskCheckpoint } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgents,
  aiOperatorTaskEvents,
  aiOperatorTaskOutbox,
  aiOperatorTasks,
  aiOperatorTaskSteps,
  aiOperatorTaskTargets,
  devices,
  ticketChecklistItems,
  tickets,
} from '../../db/schema';
import type { RecipeDefinition } from '../../services/aiOperator/recipes/types';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const FIXTURE_KEY = 'fixture_identity';

const fixtureRecipe = {
  key: FIXTURE_KEY, version: 1, promptVersion: 'fixture/v1',
  gateClass: 'deterministic', targetKinds: ['device'], requires: [],
  inputSchema: { parse: (v: unknown) => v } as never,
  steps: {
    confirm_identity: { kind: 'human_work', phase: 'plan' },
    discover: { kind: 'probe', phase: 'execute' },
  },
  permittedNextSteps: {},
  bounds: {
    maxReasoningRuns: 4, maxMutationAttempts: 2, freshnessSeconds: 120,
    observeWakeAfterMs: 1000, verificationWakeAfterMs: 1000,
    unknownEffectHorizonMs: 1000, deadlineMs: 3_600_000,
  },
  buildPlan: () => [], operationKey: () => 'fixture',
} as unknown as RecipeDefinition<never>;

vi.mock('../../services/aiOperator/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiOperator/recipes')>();
  return {
    ...actual,
    getRecipe: (key: string, version: number) =>
      key === FIXTURE_KEY && version === 1 ? fixtureRecipe : actual.getRecipe(key, version),
  };
});

import { advanceTask, claimTaskLease } from '../../services/aiOperator/taskCoordinator';
import { readHumanWorkStep } from '../../services/aiOperator/humanWorkService';
import { openStep } from '../../services/aiOperator/stepService';
import { moveTicketOrg } from '../../services/ticketService';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Org {
  partnerId: string;
  orgId: string;
  siteId: string;
  agentId: string;
  deviceId: string;
  userId: string;
  ctx: DbAccessContext;
}

async function seedOrg(partnerId?: string): Promise<Org> {
  return withSystemDbAccessContext(async () => {
    const partner = partnerId ? { id: partnerId } : await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({
      partnerId: partner.id, orgId: org.id,
      email: `hw-tenancy-${randomUUID().slice(0, 8)}@example.test`,
    });
    const [agent] = await db.insert(aiAgents).values({
      orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy: user.id,
    }).returning({ id: aiAgents.id });
    const adminDb = getTestDb() as unknown as typeof db;
    const unique = randomUUID().slice(0, 8);
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id, siteId: site!.id,
      agentId: `hw-tenancy-agent-${unique}`, hostname: `hw-tenancy-host-${unique}`,
      osType: 'windows', osVersion: '10', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning();
    return {
      partnerId: partner.id, orgId: org.id, siteId: site!.id, agentId: agent!.id,
      deviceId: (device as { id: string }).id, userId: user.id,
      ctx: {
        scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id],
        accessiblePartnerIds: [partner.id], userId: user.id,
      },
    };
  });
}

function checkpointFor(org: Org): TaskCheckpoint {
  return taskCheckpointSchema.parse({
    version: 1,
    recipeInput: { deviceId: org.deviceId, serviceName: 'spooler', triggeringAlertId: null },
    criterion: {
      adapter: 'service_running', adapterVersion: 1, deviceId: org.deviceId,
      serviceName: 'spooler', alertId: null,
    },
    resumeStepKey: 'discover',
  });
}

async function seedTask(org: Org): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [task] = await db.insert(aiOperatorTasks).values({
      orgId: org.orgId, agentId: org.agentId, agentKind: 'triage', agentName: 'Operator',
      workflowKey: FIXTURE_KEY, workflowVersion: 1, originKind: 'manual' as const,
      objective: 'Offboard Dana Example', deviceId: org.deviceId,
      state: 'queued', phase: 'plan', currentStepKey: 'confirm_identity',
      revision: 1, leaseEpoch: 0,
      checkpoint: checkpointFor(org) as unknown as Record<string, unknown>,
      deadlineAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: aiOperatorTasks.id });
    const [target] = await db.insert(aiOperatorTaskTargets).values({
      orgId: org.orgId, taskId: task!.id, targetKind: 'device', deviceId: org.deviceId,
      targetLabel: 'seeded-device', targetOrdinal: 0, state: 'active',
    }).returning({ id: aiOperatorTaskTargets.id });
    await openStep(db, {
      orgId: org.orgId, taskId: task!.id, stepKey: 'confirm_identity', stepKind: 'human_work',
      targetId: target!.id, attemptOrdinal: 0, planRevision: 1, actor: { kind: 'coordinator' },
    });
    return task!.id;
  });
}

async function tick(org: Org, taskId: string): Promise<string> {
  const claim = await claimTaskLease({ orgId: org.orgId, taskId, requireWakeDue: false });
  if (!claim.won) throw new Error(`claim lost: ${claim.reason}`);
  return advanceTask(claim.task, claim.leaseEpoch);
}

/** Open the human-work step for real (ticket, item, link, wait). */
async function openHumanWork(org: Org, taskId: string) {
  const out = await tick(org, taskId);
  expect(out).toMatch(/^waiting: human work 'confirm_identity'/);
  const [step] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKey, 'confirm_identity'))));
  const [item] = await withSystemDbAccessContext(() =>
    db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, step!.checklistItemId!)));
  return { step: step!, item: item! };
}

async function readStepById(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.id, id)));
  return row ?? null;
}

async function readTask(taskId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)));
  return row ?? null;
}

describe('AI Operator human-work link — tenancy (E3, #6168)', () => {
  beforeEach(() => {
    process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AI_OPERATOR_TASKS_ENABLED;
  });

  // (0) Non-vacuity guard, same as aiOperatorTaskGraphRls.
  runDb('code-under-test runs as a non-BYPASSRLS role', async () => {
    const a = await seedOrg();
    const rows = await withDbAccessContext(a.ctx, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // (1) RLS forge as breeze_app.
  runDb('org A cannot read org B\'s checklist item or step, and cannot forge a step under org B (42501)', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const taskB = await seedTask(b);
    const { step, item } = await openHumanWork(b, taskB);

    const items = await withDbAccessContext(a.ctx, () =>
      db.select({ id: ticketChecklistItems.id }).from(ticketChecklistItems).where(eq(ticketChecklistItems.id, item.id)));
    expect(items).toHaveLength(0);
    const steps = await withDbAccessContext(a.ctx, () =>
      db.select({ id: aiOperatorTaskSteps.id }).from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.id, step.id)));
    expect(steps).toHaveLength(0);

    await expect(
      withDbAccessContext(a.ctx, () =>
        db.insert(aiOperatorTaskSteps).values({
          orgId: b.orgId, taskId: taskB, stepKey: 'forged', stepKind: 'human_work',
          attemptOrdinal: 7, planRevision: 1, checklistItemId: item.id,
        })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (2) The join refuses a foreign item even when the pointer resolves.
  runDb('readHumanWorkStep returns no item evidence when the pointer names an item in ANOTHER org', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const taskB = await seedTask(b);
    const { item } = await openHumanWork(b, taskB);
    const taskA = await seedTask(a);

    // Forge the cross-org pointer at system scope: the plain FK accepts it, and
    // that is exactly the shape a ticket org-move leaves behind.
    await withSystemDbAccessContext(() => db.update(aiOperatorTaskSteps)
      .set({ checklistItemId: item.id, dependencyKind: 'user_answer', dependencyId: item.id, state: 'waiting' })
      .where(and(eq(aiOperatorTaskSteps.taskId, taskA), eq(aiOperatorTaskSteps.stepKey, 'confirm_identity'))));

    const view = await readHumanWorkStep(a.orgId, taskA, 'confirm_identity', 0);
    expect(view?.checklistItemId).toBe(item.id);
    expect(view?.itemLabel).toBeNull();
    expect(view?.itemDoneAt).toBeNull();
  });

  // (3) Ticket org-move detaches and the task hands off.
  runDb('moveTicketOrg detaches the link, wakes the task, and the coordinator hands off instead of waiting', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const a = await seedOrg(partner.id);
    const a2 = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const taskId = await seedTask(a);
    const { step, item } = await openHumanWork(a, taskId);

    await withSystemDbAccessContext(() => moveTicketOrg(item.ticketId, a2.id, { userId: a.userId }));

    // The item moved with its ticket (shipped re-stamp); the step did not.
    const [movedItem] = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, item.id)));
    expect(movedItem?.orgId).toBe(a2.id);
    expect(movedItem?.operatorStepId).toBe(step.id); // provenance survives
    const after = await readStepById(step.id);
    expect(after?.orgId).toBe(a.orgId);
    expect(after?.checklistItemId).toBeNull();

    const detached = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskEvents)
        .where(and(eq(aiOperatorTaskEvents.taskId, taskId), eq(aiOperatorTaskEvents.eventType, 'target_detached'))));
    expect(detached.length).toBeGreaterThanOrEqual(1);
    expect(detached.some((e) => e.stepKey === 'confirm_identity' && /moved to another organization/.test(e.detail ?? ''))).toBe(true);
    const outbox = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskOutbox)
        .where(and(eq(aiOperatorTaskOutbox.taskId, taskId), eq(aiOperatorTaskOutbox.sourceKind, 'user_answer'))));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.sourceId).toBe(item.id);

    const out = await tick(a, taskId);
    expect(out).toBe("handed off: human work 'confirm_identity' detached");
    const task = await readTask(taskId);
    expect(task?.state).toBe('handed_off');
    expect(task?.outcome).toBe('unresolved');
    expect(task?.handoffSummary).toMatch(/moved or removed/);
  });

  // (4) Org merge completes (no 23503) and the fence nulls the link.
  runDb('org merge with a live human-work step completes without 23503 and detaches the link in the fence', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const loser = await seedOrg(partner.id);
    const survivor = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const actor = await withSystemDbAccessContext(() => createUser({
      partnerId: partner.id, orgId: null,
      email: `hw-merge-${randomUUID().slice(0, 8)}@example.test`,
    }));
    const taskId = await seedTask(loser);
    const { step, item } = await openHumanWork(loser, taskId);

    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      await expect(executeOrgMerge({
        loserOrgId: loser.orgId,
        survivorOrgId: survivor.id,
        partnerId: partner.id,
        performedBy: actor.id,
        performedByEmail: actor.email,
      })).resolves.not.toThrow();
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }

    const after = await readStepById(step.id);
    expect(after?.checklistItemId).toBeNull();
    expect(after?.orgId).toBe(loser.orgId); // leave-for-erasure
    // The item followed its ticket to the survivor and still says where it came from.
    const [movedItem] = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, item.id)));
    expect(movedItem?.orgId).toBe(survivor.id);
    expect(movedItem?.operatorStepId).toBe(step.id);
    expect((await readTask(taskId))?.state).toBe('stopping');
  });

  // (5) Org erasure order: steps before items, no FK violation.
  runDb('cascadeDeleteOrg on an org with a live human-work step completes with no FK violation', async () => {
    const org = await seedOrg();
    const actor = await withSystemDbAccessContext(() => createUser({
      partnerId: org.partnerId, orgId: null,
      email: `hw-erase-${randomUUID().slice(0, 8)}@example.test`,
    }));
    const taskId = await seedTask(org);
    const { step, item } = await openHumanWork(org, taskId);

    // Bare, like aiOperatorTaskGraphCascade: the cascade manages its own
    // (audit-admin) context per table.
    const stats = await cascadeDeleteOrg(org.orgId, actor.id);
    expect(stats.tablesDeleted.ai_operator_task_steps ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.tablesDeleted.ticket_checklist_items ?? 0).toBeGreaterThanOrEqual(1);

    expect(await readStepById(step.id)).toBeNull();
    const [gone] = await withSystemDbAccessContext(() =>
      db.select({ id: ticketChecklistItems.id }).from(ticketChecklistItems).where(eq(ticketChecklistItems.id, item.id)));
    expect(gone).toBeUndefined();
    const [ticketGone] = await withSystemDbAccessContext(() =>
      db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, item.ticketId)));
    expect(ticketGone).toBeUndefined();
  });
});
