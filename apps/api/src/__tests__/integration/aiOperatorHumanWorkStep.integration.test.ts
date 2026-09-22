/**
 * Real-Postgres proof for the AI Operator's `human_work` and `wait` step kinds
 * (Recipe Library wave E3, #6168 — spec §6.1, §6.5).
 *
 * Every case is a row round-trip through the REAL writers: `advanceTask`
 * dispatching by KIND through `KIND_ADVANCERS`, `patchChecklistItem` enqueuing
 * the wake in the request transaction, the coordinator re-reading the item as
 * evidence, the reminder sweep, and the deadline handoff.
 *
 * FIXTURE RECIPE. No recipe in this build declares a `human_work` or `wait`
 * step, so `getRecipe` is extended (not replaced) with a local
 * `fixture_identity` recipe. Every other key resolves to the real registry, so
 * `service_recovery`'s behaviour is untouched. The task rows are seeded
 * directly under that key with a VALID checkpoint, because the coordinator's
 * first act is to parse it.
 *
 * Runs under vitest.integration.config.ts. Fresh fixture per test — setup.ts's
 * beforeEach TRUNCATEs partners/organizations CASCADE.
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
  ticketComments,
  tickets,
  userNotifications,
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
    wait_cutoff: { kind: 'wait', phase: 'execute' },
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

// Imported AFTER the mock so the coordinator binds the extended registry.
import { advanceHumanWork, advanceTask, advanceWait, claimTaskLease } from '../../services/aiOperator/taskCoordinator';
import { sendHumanWorkReminders } from '../../services/aiOperator/humanWorkService';
import { openStep } from '../../services/aiOperator/stepService';
import { deleteChecklistItem, listChecklist, patchChecklistItem } from '../../services/ticketChecklistService';

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

async function seedOrg(): Promise<Org> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({
      partnerId: partner.id, orgId: org.id,
      email: `human-work-${randomUUID().slice(0, 8)}@example.test`,
    });
    const [agent] = await db.insert(aiAgents).values({
      orgId: org.id, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy: user.id,
    }).returning({ id: aiAgents.id });
    const adminDb = getTestDb() as unknown as typeof db;
    const unique = randomUUID().slice(0, 8);
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id, siteId: site!.id,
      agentId: `human-work-agent-${unique}`, hostname: `human-work-host-${unique}`,
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

function checkpointFor(org: Org, extra: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return taskCheckpointSchema.parse({
    version: 1,
    recipeInput: { deviceId: org.deviceId, serviceName: 'spooler', triggeringAlertId: null },
    criterion: {
      adapter: 'service_running', adapterVersion: 1, deviceId: org.deviceId,
      serviceName: 'spooler', alertId: null,
    },
    resumeStepKey: 'discover',
    ...extra,
  });
}

/** A task under the fixture recipe at `currentStepKey`, with a device target
 *  at ordinal 0 (the shape admission gives every task), in `queued` so the
 *  poller door opens on the first claim. */
async function seedTask(org: Org, opts: {
  currentStepKey: string;
  checkpoint?: TaskCheckpoint;
  deadlineAt?: Date;
  requesterUserId?: string | null;
  withTarget?: boolean;
}): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [task] = await db.insert(aiOperatorTasks).values({
      orgId: org.orgId,
      agentId: org.agentId,
      agentKind: 'triage',
      agentName: 'Operator',
      workflowKey: FIXTURE_KEY,
      workflowVersion: 1,
      originKind: 'manual' as const,
      objective: 'Offboard Dana Example',
      deviceId: org.deviceId,
      requesterUserId: opts.requesterUserId ?? null,
      state: 'queued',
      phase: 'plan',
      currentStepKey: opts.currentStepKey,
      revision: 1,
      leaseEpoch: 0,
      checkpoint: (opts.checkpoint ?? checkpointFor(org)) as unknown as Record<string, unknown>,
      deadlineAt: opts.deadlineAt ?? new Date(Date.now() + 3_600_000),
    }).returning({ id: aiOperatorTasks.id });
    let targetId: string | null = null;
    if (opts.withTarget !== false) {
      const [target] = await db.insert(aiOperatorTaskTargets).values({
        orgId: org.orgId, taskId: task!.id, targetKind: 'device', deviceId: org.deviceId,
        targetLabel: 'seeded-device', targetOrdinal: 0, state: 'active',
      }).returning({ id: aiOperatorTaskTargets.id });
      targetId = target!.id;
    }
    // The step row the coordinator's step change would have opened on the way
    // in (recordStepChange -> openStep): running, no dependency, no link. For
    // human_work this is the "pre-opened, never linked" shape the advancer must
    // tell apart from a detached link.
    await openStep(db, {
      orgId: org.orgId, taskId: task!.id, stepKey: opts.currentStepKey,
      stepKind: (fixtureRecipe.steps[opts.currentStepKey]?.kind ?? 'reason') as never,
      targetId, attemptOrdinal: 0, planRevision: 1, actor: { kind: 'coordinator' },
    });
    return task!.id;
  });
}

async function readTask(taskId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)));
  return row!;
}

async function readStep(taskId: string, stepKey: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKey, stepKey)))
      .orderBy(sql`${aiOperatorTaskSteps.attemptOrdinal} DESC`).limit(1));
  return row ?? null;
}

async function readEvents(taskId: string, eventType: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskEvents)
      .where(and(eq(aiOperatorTaskEvents.taskId, taskId), eq(aiOperatorTaskEvents.eventType, eventType as never))));
}

async function readOutbox(taskId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, taskId)));
}

/** Claim (event path, no wake-due requirement) and dispatch ONE tick. */
async function tick(org: Org, taskId: string): Promise<string> {
  const claim = await claimTaskLease({ orgId: org.orgId, taskId, requireWakeDue: false });
  if (!claim.won) throw new Error(`claim lost: ${claim.reason}`);
  return advanceTask(claim.task, claim.leaseEpoch);
}

/** Claim, then call the generic advancer directly with an injected clock. */
async function claimFor(org: Org, taskId: string) {
  const claim = await claimTaskLease({ orgId: org.orgId, taskId, requireWakeDue: false });
  if (!claim.won) throw new Error(`claim lost: ${claim.reason}`);
  const checkpoint = taskCheckpointSchema.parse(claim.task.checkpoint);
  return { task: claim.task, leaseEpoch: claim.leaseEpoch, checkpoint, recipe: fixtureRecipe };
}

/** Open the human-work step (first tick) and return the item it created. */
async function openHumanWork(org: Org, taskId: string) {
  const out = await tick(org, taskId);
  expect(out).toMatch(/^waiting: human work 'confirm_identity'/);
  const step = await readStep(taskId, 'confirm_identity');
  expect(step?.checklistItemId).toBeTruthy();
  return { step: step!, itemId: step!.checklistItemId! };
}

describe('AI Operator human-work + wait steps against real Postgres (E3, #6168)', () => {
  beforeEach(() => {
    process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AI_OPERATOR_TASKS_ENABLED;
  });

  // (1) The step opens a ticket, an item, the link in both directions, and the typed wait.
  runDb('opens a human_work step: ticket target, operator_task item at position 0, both link pointers, user_answer wait', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });

    const { step, itemId } = await openHumanWork(org, taskId);

    const [target] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets)
        .where(and(eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
    expect(target?.ticketId).toBeTruthy();
    const [ticket] = await withSystemDbAccessContext(() =>
      db.select().from(tickets).where(eq(tickets.id, target!.ticketId!)));
    expect(ticket?.orgId).toBe(org.orgId);
    expect(ticket?.source).toBe('ai');

    const [item] = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.id, itemId)));
    expect(item).toMatchObject({
      ticketId: target!.ticketId, orgId: org.orgId, source: 'operator_task', position: 0,
      operatorStepId: step.id, doneAt: null, createdBy: null,
    });
    expect(item!.label).toBe('Confirm identity');

    expect(step).toMatchObject({
      stepKind: 'human_work', state: 'waiting', dependencyKind: 'user_answer', dependencyId: itemId,
    });
    expect(step.remindAfterAt).not.toBeNull();
    expect(step.remindedAt).toBeNull();

    const task = await readTask(taskId);
    expect(task).toMatchObject({
      state: 'waiting', waitReason: 'information', waitDependencyKind: 'user_answer',
      waitDependencyId: itemId, leaseOwner: null, currentStepKey: 'confirm_identity',
    });
    expect(task.nextWakeAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
    // One wait_entered for the wait, and NO second step_opened: the row was
    // pre-opened by the step change and the writer refreshed it (emitOpenEvent
    // false).
    expect((await readEvents(taskId, 'wait_entered')).length).toBe(1);
    expect((await readEvents(taskId, 'step_opened')).length).toBe(1);
  });

  // (2) A second human-work step reuses the ticket.
  runDb('a second human_work step on the same task REUSES the ticket (one ticket target, positions 0 and 1)', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const first = await openHumanWork(org, taskId);

    // Simulate the recipe moving to a second human-work step: re-key the task
    // and its wait so the coordinator sees a fresh step under the same task.
    await withSystemDbAccessContext(() => db.update(aiOperatorTasks)
      .set({ currentStepKey: 'wait_cutoff', state: 'queued', waitDependencyId: null, waitDependencyKind: null })
      .where(eq(aiOperatorTasks.id, taskId)));
    // `wait_cutoff` is declared as a `wait` in the fixture; re-declare it as a
    // second human-work step for this case only.
    const twoHuman = { ...fixtureRecipe, steps: { ...fixtureRecipe.steps, wait_cutoff: { kind: 'human_work', phase: 'plan' } } } as unknown as RecipeDefinition<never>;
    const c = await claimFor(org, taskId);
    await advanceHumanWork({ ...c, recipe: twoHuman, now: new Date() });

    const ticketTargets = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets)
        .where(and(eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
    expect(ticketTargets).toHaveLength(1);
    const items = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems)
        .where(eq(ticketChecklistItems.ticketId, ticketTargets[0]!.ticketId!))
        .orderBy(ticketChecklistItems.position));
    expect(items.map((i) => i.position)).toEqual([0, 1]);
    expect(items[0]!.id).toBe(first.itemId);
    const ticketRows = await withSystemDbAccessContext(() =>
      db.select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, org.orgId)));
    expect(ticketRows).toHaveLength(1);
  });

  // (3) Tick -> wake -> advance, with the completing user as the evidence.
  runDb('a human tick enqueues a user_answer wake in the request tx; the coordinator settles on the row and resumes', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const { itemId } = await openHumanWork(org, taskId);

    // The REQUEST path, as breeze_app under the org's context.
    const view = await withDbAccessContext(org.ctx, () =>
      patchChecklistItem(itemId, { done: true }, { userId: org.userId }));
    expect(view.done).toBe(true);

    const outbox = await readOutbox(taskId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ sourceKind: 'user_answer', sourceId: itemId, transitionSeq: 1 });

    const out = await tick(org, taskId);
    expect(out).toMatch(/resuming at 'discover'/);

    const step = await readStep(taskId, 'confirm_identity');
    expect(step?.state).toBe('succeeded');
    expect(step?.detail).toContain(org.userId);
    expect(step?.dependencyId).toBeNull();
    expect((await readEvents(taskId, 'wait_resolved')).length).toBe(1);

    const task = await readTask(taskId);
    expect(task.currentStepKey).toBe('discover');
    expect(task.phase).toBe('execute');
    expect(task.state).toBe('running');
    expect(task.waitDependencyId).toBeNull();
    const discover = await readStep(taskId, 'discover');
    expect(discover?.stepKind).toBe('probe');
  });

  // (4) Redelivery collapses: a re-tick enqueues nothing new.
  runDb('re-ticking an already-done item enqueues nothing new (fixed ordinal, ON CONFLICT DO NOTHING)', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const { itemId } = await openHumanWork(org, taskId);

    await withDbAccessContext(org.ctx, () => patchChecklistItem(itemId, { done: true }, { userId: org.userId }));
    await withDbAccessContext(org.ctx, () => patchChecklistItem(itemId, { done: true }, { userId: org.userId }));
    expect(await readOutbox(taskId)).toHaveLength(1);
  });

  // (5) Uncheck does NOT rewind.
  runDb('un-ticking after the task advanced records human_work_unticked and never rewinds', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const { itemId } = await openHumanWork(org, taskId);
    await withDbAccessContext(org.ctx, () => patchChecklistItem(itemId, { done: true }, { userId: org.userId }));
    await tick(org, taskId);

    await withDbAccessContext(org.ctx, () => patchChecklistItem(itemId, { done: false }, { userId: org.userId }));

    const unticked = await readEvents(taskId, 'human_work_unticked');
    expect(unticked).toHaveLength(1);
    expect(unticked[0]!.stepKey).toBe('confirm_identity');
    expect(unticked[0]!.actorKind).toBe('system');
    // Still where it advanced to, and the settled step is untouched.
    expect((await readTask(taskId)).currentStepKey).toBe('discover');
    expect((await readStep(taskId, 'confirm_identity'))?.state).toBe('succeeded');
    // And no NEW wake was raised by the untick.
    expect(await readOutbox(taskId)).toHaveLength(1);
  });

  // (6) Delete guard.
  runDb('deleting a waiting item is a 409; deleting a settled one is allowed and SET NULLs the link', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const { itemId, step } = await openHumanWork(org, taskId);

    await expect(withDbAccessContext(org.ctx, () => deleteChecklistItem(itemId)))
      .rejects.toMatchObject({ status: 409, code: 'CHECKLIST_OPERATOR_STEP_WAITING' });
    const [stillThere] = await withSystemDbAccessContext(() =>
      db.select({ id: ticketChecklistItems.id }).from(ticketChecklistItems).where(eq(ticketChecklistItems.id, itemId)));
    expect(stillThere?.id).toBe(itemId);

    await withDbAccessContext(org.ctx, () => patchChecklistItem(itemId, { done: true }, { userId: org.userId }));
    await tick(org, taskId);

    await expect(withDbAccessContext(org.ctx, () => deleteChecklistItem(itemId))).resolves.toBeUndefined();
    const [after] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.id, step.id)));
    expect(after?.checklistItemId).toBeNull();
    expect(after?.state).toBe('succeeded');
  });

  // (7) advanceWait with a future waitUntil.
  runDb('advanceWait writes next_wake_at = waitUntil with reason maintenance_window and releases the lease', async () => {
    const org = await seedOrg();
    const until = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const taskId = await seedTask(org, {
      currentStepKey: 'wait_cutoff',
      checkpoint: checkpointFor(org, { waitUntil: until.toISOString() }),
    });
    const c = await claimFor(org, taskId);
    const now = new Date();
    const out = await advanceWait({ ...c, now });
    expect(out).toMatch(/^waiting: 'wait_cutoff' until/);

    const task = await readTask(taskId);
    expect(task.state).toBe('waiting');
    expect(task.waitReason).toBe('maintenance_window');
    expect(task.leaseOwner).toBeNull();
    expect(Math.abs(task.nextWakeAt!.getTime() - until.getTime())).toBeLessThan(1000);
    expect((await readStep(taskId, 'wait_cutoff'))?.state).toBe('waiting');
  });

  // (8) advanceWait with a PAST waitUntil — through the real dispatch.
  runDb('a wait whose time has already passed advances immediately through advanceTask', async () => {
    const org = await seedOrg();
    const until = new Date(Date.now() - 60_000);
    const taskId = await seedTask(org, {
      currentStepKey: 'wait_cutoff',
      checkpoint: checkpointFor(org, { waitUntil: until.toISOString() }),
    });
    const out = await tick(org, taskId);
    expect(out).toMatch(/window open, resuming at 'discover'/);

    const task = await readTask(taskId);
    expect(task.currentStepKey).toBe('discover');
    expect(task.nextWakeAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const wait = await readStep(taskId, 'wait_cutoff');
    expect(wait?.state).toBe('succeeded');
    expect(wait?.detail).toContain(until.toISOString());
  });

  // (9) Clock-skew clamp.
  runDb('a waitUntil 50 ms out is clamped to at least 1 s of wake interval', async () => {
    const org = await seedOrg();
    const now = new Date();
    const until = new Date(now.getTime() + 50);
    const taskId = await seedTask(org, {
      currentStepKey: 'wait_cutoff',
      checkpoint: checkpointFor(org, { waitUntil: until.toISOString() }),
    });
    const c = await claimFor(org, taskId);
    await advanceWait({ ...c, now });
    const task = await readTask(taskId);
    expect(task.nextWakeAt!.getTime() - now.getTime()).toBeGreaterThanOrEqual(1000);
  });

  // (10) Reminders fire once.
  runDb('an overdue human-work step gets ONE internal ticket comment and ONE notification, then reminded_at is stamped', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity', requesterUserId: org.userId });
    const { step } = await openHumanWork(org, taskId);

    await withSystemDbAccessContext(() => db.update(aiOperatorTaskSteps)
      .set({ remindAfterAt: new Date(Date.now() - 60_000) })
      .where(eq(aiOperatorTaskSteps.id, step.id)));

    expect(await sendHumanWorkReminders()).toBe(1);
    expect(await sendHumanWorkReminders()).toBe(0);

    const [target] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets)
        .where(and(eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
    const comments = await withSystemDbAccessContext(() =>
      db.select().from(ticketComments)
        .where(and(eq(ticketComments.ticketId, target!.ticketId!), eq(ticketComments.commentType, 'internal'))));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ isPublic: false, userId: null, authorType: 'ai_agent' });

    const notes = await withSystemDbAccessContext(() =>
      db.select().from(userNotifications).where(eq(userNotifications.userId, org.userId)));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.link).toBe(`/tickets/${target!.ticketId}`);

    const after = await readStep(taskId, 'confirm_identity');
    expect(after?.remindedAt).not.toBeNull();
  });

  // (10b) Two reconciler pods ticking at once: the guarded stamp serialises
  // them, so exactly ONE comment and ONE notification land.
  runDb('two CONCURRENT reminder passes over the same overdue step post exactly one reminder', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity', requesterUserId: org.userId });
    const { step } = await openHumanWork(org, taskId);
    await withSystemDbAccessContext(() => db.update(aiOperatorTaskSteps)
      .set({ remindAfterAt: new Date(Date.now() - 60_000) })
      .where(eq(aiOperatorTaskSteps.id, step.id)));

    const counts = await Promise.all([sendHumanWorkReminders(), sendHumanWorkReminders()]);
    // Each pass reports the rows it SELECTED; only one of them actually wrote.
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);

    const [target] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets)
        .where(and(eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetKind, 'ticket'))));
    const comments = await withSystemDbAccessContext(() =>
      db.select().from(ticketComments)
        .where(and(eq(ticketComments.ticketId, target!.ticketId!), eq(ticketComments.commentType, 'internal'))));
    expect(comments).toHaveLength(1);
    const notes = await withSystemDbAccessContext(() =>
      db.select().from(userNotifications).where(eq(userNotifications.userId, org.userId)));
    expect(notes).toHaveLength(1);
  });

  // (11) Deadline on human work HANDS OFF.
  runDb('a task whose deadline passes while waiting on a person hands off with a summary — it does not fail', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    await openHumanWork(org, taskId);

    await withSystemDbAccessContext(() => db.update(aiOperatorTasks)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(aiOperatorTasks.id, taskId)));

    const out = await tick(org, taskId);
    expect(out).toBe('handed off: deadline on human work');
    const task = await readTask(taskId);
    expect(task.state).toBe('handed_off');
    expect(task.outcome).toBe('unresolved');
    expect(task.handoffSummary).toMatch(/waiting for someone to complete 'confirm_identity'/);
  });

  // (12) The list projection links the item to its task in the same org.
  runDb('listChecklist projects operatorTaskId for the badge', async () => {
    const org = await seedOrg();
    const taskId = await seedTask(org, { currentStepKey: 'confirm_identity' });
    const { itemId } = await openHumanWork(org, taskId);
    const [item] = await withSystemDbAccessContext(() =>
      db.select({ ticketId: ticketChecklistItems.ticketId }).from(ticketChecklistItems).where(eq(ticketChecklistItems.id, itemId)));
    const summary = await withDbAccessContext(org.ctx, () => listChecklist(item!.ticketId));
    expect(summary.items[0]).toMatchObject({ id: itemId, source: 'operator_task', operatorTaskId: taskId });
  });
});
