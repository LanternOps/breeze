/**
 * The two generic advancers (recipe spec §6.1's step-kind table rows
 * `human_work` and `wait`), Recipe Library wave E3.
 *
 * Driven against a FIXTURE recipe, not against `service_recovery`: that recipe
 * declares neither kind, and E1's and E2's contracts require its dispatch to be
 * bit-for-bit unchanged by this wave. The fixture is what proves these branches
 * are reachable at all.
 *
 * The clock is injected, never read: "already past" and "clock skew" are the two
 * cases a timed wait gets wrong, and neither is testable against `Date.now()`.
 *
 * These assert WIRING (what was written under the lease CAS, and with what
 * detail), not SQL — the real-Postgres behaviour is
 * aiOperatorHumanWorkStep.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from './recipes/types';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  targetRows: [{ id: 'target-1' }] as Array<{ id: string }>,
  taskPatches: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.taskPatches.push(patch);
        return { where: () => ({ returning: async () => dbState.casRows }) };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => dbState.targetRows }) }),
    }),
  };
  return {
    db,
    runOutsideDbContext: <T>(fn: () => T) => fn(),
    withSystemDbAccessContext: <T>(fn: () => T) => fn(),
  };
});

vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => 1),
  settleStep: vi.fn(async () => 1),
  resolveStepKind: vi.fn(() => 'probe'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => true,
}));
vi.mock('../aiAgents/runService', () => ({
  createAndEnqueueAgentRun: vi.fn(async () => ({ created: true, run: { id: 'run-2' } })),
}));
vi.mock('./humanWorkService', () => ({
  HUMAN_WORK_POLL_WAKE_MS: 6 * 60 * 60 * 1000,
  ensureTaskTicket: vi.fn(async () => ({ ticketId: 'ticket-1', targetId: 'target-t', created: false })),
  openHumanWorkStep: vi.fn(async () => ({ stepId: 'step-1', checklistItemId: 'item-9', ticketId: 'ticket-1' })),
  readHumanWorkStep: vi.fn(async () => null),
}));

import { openStep, settleStep } from './stepService';
import { appendTaskEvent } from './eventService';
import { openHumanWorkStep, readHumanWorkStep } from './humanWorkService';
import { advanceHumanWork, advanceWait } from './taskCoordinator';

const fixtureRecipe = {
  key: 'fixture_identity', version: 1, promptVersion: 'fixture/v1',
  gateClass: 'deterministic', targetKinds: ['contact'], requires: [],
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
    unknownEffectHorizonMs: 1000, deadlineMs: 1000,
  },
  buildPlan: () => [], operationKey: () => 'fixture',
} as unknown as RecipeDefinition<never>;

const NOW = new Date('2026-10-20T10:00:00.000Z');

const baseTask = {
  id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
  state: 'running', workflowKey: 'fixture_identity', workflowVersion: 1,
  objective: 'Offboard Dana', deadlineAt: null,
};

const readMock = readHumanWorkStep as unknown as ReturnType<typeof vi.fn>;

function humanWorkArgs(over: { checkpoint?: Record<string, unknown>; task?: Record<string, unknown> } = {}) {
  return {
    task: { ...baseTask, currentStepKey: 'confirm_identity', ...(over.task ?? {}) } as never,
    leaseEpoch: 4,
    checkpoint: { resumeStepKey: 'discover', ...(over.checkpoint ?? {}) } as never,
    recipe: fixtureRecipe,
    now: NOW,
  };
}

function waitArgs(checkpoint: Record<string, unknown>) {
  return {
    task: { ...baseTask, currentStepKey: 'wait_cutoff' } as never,
    leaseEpoch: 4,
    checkpoint: checkpoint as never,
    recipe: fixtureRecipe,
    now: NOW,
  };
}

const lastPatch = () => dbState.taskPatches.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  dbState.casRows = [{ id: 'task-1' }];
  dbState.targetRows = [{ id: 'target-1' }];
  dbState.taskPatches = [];
  readMock.mockResolvedValue(null);
});

describe('advanceHumanWork (spec §6.5)', () => {
  it('opens the step and waits on the checklist item when no linked step row exists yet', async () => {
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/^waiting: human work 'confirm_identity'/);
    expect(openHumanWorkStep).toHaveBeenCalledTimes(1);
    expect(openHumanWorkStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      task: expect.objectContaining({ id: 'task-1', orgId: 'org-1', revision: 3, attemptOrdinal: 0 }),
      stepKey: 'confirm_identity',
      targetId: 'target-1',
      label: expect.stringMatching(/\S/),
      remindAfterMs: expect.any(Number),
    }));
    // The task waits on the ITEM as a user_answer, lease released, poll fallback
    // armed. Two UPDATEs in ONE CAS transaction: the wait transition first, then
    // the dependency id once the item exists.
    const waitPatch = dbState.taskPatches.find((p) => p.state === 'waiting')!;
    expect(waitPatch).toMatchObject({
      state: 'waiting', waitReason: 'information', waitDependencyKind: 'user_answer',
      leaseOwner: null, leaseExpiresAt: null,
      nextWakeAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    });
    expect(lastPatch()).toMatchObject({ waitDependencyId: 'item-9' });
  });

  it('treats a pre-opened but never-linked row (dependencyId null) as "open it", not as detached', async () => {
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'running', dependencyId: null, checklistItemId: null,
      itemDoneAt: null, itemDoneByUserId: null, itemLabel: null,
    });
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/^waiting: human work/);
    expect(openHumanWorkStep).toHaveBeenCalledTimes(1);
    // The step change already wrote step_opened; the writer must not repeat it.
    expect(openHumanWorkStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ emitOpenEvent: false }));
    expect(lastPatch().state).not.toBe('handed_off');
  });

  it('does NOT open anything when the lease CAS is lost', async () => {
    dbState.casRows = [];
    await advanceHumanWork(humanWorkArgs());
    expect(openHumanWorkStep).not.toHaveBeenCalled();
  });

  it('re-reads the item authoritatively and keeps waiting while done_at is null', async () => {
    // Invariant 2: the wake payload said "an answer arrived"; the row is what
    // decides. A wake can be a duplicate, a retry, or the reconciler's poll.
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: null, itemDoneByUserId: null, itemLabel: 'Collect the laptop',
    });
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/not yet ticked/);
    expect(openHumanWorkStep).not.toHaveBeenCalled();
    expect(settleStep).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({
      state: 'waiting', waitDependencyKind: 'user_answer', waitDependencyId: 'item-9', leaseOwner: null,
    });
  });

  it('settles the step SUCCEEDED with the completing user and timestamp as the evidence', async () => {
    // Spec §6.5: "Evidence is the completing user id and timestamp — never
    // model-graded free text."
    const doneAt = new Date('2026-10-20T09:30:00.000Z');
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: doneAt, itemDoneByUserId: 'user-7', itemLabel: 'Collect the laptop',
    });
    await advanceHumanWork(humanWorkArgs());
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'confirm_identity', targetId: 'target-1', attemptOrdinal: 0, state: 'succeeded',
      detail: expect.stringContaining('user-7'),
    }));
    expect((settleStep as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].detail)
      .toContain(doneAt.toISOString());
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'wait_resolved', stepKey: 'confirm_identity',
    }));
  });

  it('advances to checkpoint.resumeStepKey with THAT step definition\'s phase', async () => {
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: NOW, itemDoneByUserId: 'user-7', itemLabel: 'x',
    });
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/resuming at 'discover'/);
    expect(lastPatch()).toMatchObject({
      currentStepKey: 'discover', phase: 'execute',
      waitReason: null, waitDependencyKind: null, waitDependencyId: null, leaseOwner: null,
    });
    // Due immediately, with an EXPIRED (not null) lease — the running-past-lease
    // scan's predicate is `lease_expires_at IS NOT NULL`.
    expect((lastPatch().leaseExpiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'discover', targetId: 'target-1', attemptOrdinal: 0, planRevision: 3,
    }));
  });

  it('hands off — never spins — when the link has been detached (checklist_item_id NULL)', async () => {
    // A ticket org-move or an org merge nulls the pointer. Waiting on a row in
    // another tenant forever is the failure this branch exists to prevent.
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: null,
      itemDoneAt: null, itemDoneByUserId: null, itemLabel: null,
    });
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/^handed off/);
    expect(openHumanWorkStep).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
    expect(lastPatch().handoffSummary).toMatch(/moved or removed/);
  });

  it('hands off when the item row is unreadable in the TASK\'s org (a moved ticket)', async () => {
    // The pointer is still set but the org-constrained join missed: the item
    // now lives in another tenant.
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: null, itemDoneByUserId: null, itemLabel: null,
    });
    const out = await advanceHumanWork(humanWorkArgs());
    expect(out).toMatch(/^handed off/);
    expect(lastPatch()).toMatchObject({ state: 'handed_off', outcome: 'unresolved' });
  });

  it('fails loudly when resumeStepKey is absent — a recipe bug is never guessed', async () => {
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: NOW, itemDoneByUserId: 'user-7', itemLabel: 'x',
    });
    const out = await advanceHumanWork(humanWorkArgs({ checkpoint: { resumeStepKey: undefined } }));
    expect(out).toMatch(/^failed/);
    expect(lastPatch()).toMatchObject({ state: 'failed', outcome: 'unresolved' });
    expect(lastPatch().outcomeDetail).toMatch(/no resume step/);
    expect(openStep).not.toHaveBeenCalled();
  });

  it('fails when resumeStepKey names a step the recipe does not declare', async () => {
    readMock.mockResolvedValue({
      stepId: 'step-1', state: 'waiting', dependencyId: 'item-9', checklistItemId: 'item-9',
      itemDoneAt: NOW, itemDoneByUserId: 'user-7', itemLabel: 'x',
    });
    const out = await advanceHumanWork(humanWorkArgs({ checkpoint: { resumeStepKey: 'nope' } }));
    expect(out).toMatch(/^failed/);
    expect(lastPatch().outcomeDetail).toMatch(/'nope'/);
  });
});

describe('advanceWait (spec §6.1 wait row, §6.3 wait_cutoff)', () => {
  it('writes next_wake_at = waitUntil and yields with reason maintenance_window', async () => {
    const until = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const out = await advanceWait(waitArgs({ waitUntil: until.toISOString(), resumeStepKey: 'discover' }));
    expect(out).toMatch(/^waiting: 'wait_cutoff' until/);
    expect(lastPatch()).toMatchObject({
      state: 'waiting', waitReason: 'maintenance_window',
      waitDependencyKind: null, waitDependencyId: null,
      nextWakeAt: until, leaseOwner: null, leaseExpiresAt: null,
    });
  });

  it('advances IMMEDIATELY when waitUntil is already past — a past cutoff is not an error', async () => {
    // The common case after a lost wake or a slow queue, and the one a naive
    // `setTimeout(until - now)` gets wrong by sleeping a negative interval.
    const until = new Date(NOW.getTime() - 60_000);
    const out = await advanceWait(waitArgs({ waitUntil: until.toISOString(), resumeStepKey: 'discover' }));
    expect(out).toMatch(/resuming at 'discover'/);
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'wait_cutoff', state: 'succeeded', detail: expect.stringContaining(until.toISOString()),
    }));
    expect(lastPatch()).toMatchObject({ currentStepKey: 'discover', phase: 'execute' });
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'discover' }));
  });

  it('clamps a NEGATIVE-or-tiny wake interval to a minimum rather than yielding into the past', async () => {
    // Clock skew between the API pod and Postgres is real. `wakeAfterMs` is
    // added to the coordinator's own `now`, so a skewed `waitUntil` must not
    // produce a wake that is already due and re-enters in a tight loop.
    const until = new Date(NOW.getTime() + 50);
    await advanceWait(waitArgs({ waitUntil: until.toISOString(), resumeStepKey: 'discover' }));
    const wake = lastPatch().nextWakeAt as Date;
    expect(wake.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(1000);
  });

  it('fails when waitUntil is absent or unparseable, naming the step', async () => {
    const out1 = await advanceWait(waitArgs({ resumeStepKey: 'discover' }));
    expect(out1).toMatch(/^failed: wait 'wait_cutoff'/);
    expect(lastPatch()).toMatchObject({ state: 'failed', outcome: 'unresolved' });
    const out2 = await advanceWait(waitArgs({ waitUntil: 'friday', resumeStepKey: 'discover' }));
    expect(out2).toMatch(/^failed: wait 'wait_cutoff'/);
  });

  it('fails when the resume step is missing or undeclared', async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const out = await advanceWait(waitArgs({ waitUntil: until.toISOString() }));
    expect(out).toMatch(/no usable resume step/);
    expect(lastPatch()).toMatchObject({ state: 'failed' });
  });
});
