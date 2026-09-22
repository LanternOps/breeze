/**
 * The human-work writer, unit level (recipe spec §5.3, §6.5).
 *
 * These assert the CONTRACT, not query shape: the ordinal scheme, the refusal
 * that must happen BEFORE the database sees anything, and the two directions
 * of the link being written in one call. The real-Postgres behaviour (RLS, the
 * FK, the org-move detach) is the integration suite's job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Record<string, unknown[]> = {
  openStep: [], markStepWaiting: [], appendTaskEvent: [], createTicket: [], createTaskTarget: [], enqueue: [],
};

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./stepService', () => ({
  openStep: async (_d: unknown, i: unknown) => { calls.openStep.push(i); return { id: 'step-1' }; },
  markStepWaiting: async (_d: unknown, i: unknown) => { calls.markStepWaiting.push(i); return 1; },
  settleStep: vi.fn(),
}));
vi.mock('./eventService', () => ({
  appendTaskEvent: async (_d: unknown, i: unknown) => { calls.appendTaskEvent.push(i); return 1; },
}));
vi.mock('./targetService', () => ({
  createTaskTarget: async (_d: unknown, i: unknown) => { calls.createTaskTarget.push(i); return { id: 'target-t' }; },
}));
vi.mock('../ticketService', () => ({
  createTicket: async (i: unknown) => { calls.createTicket.push(i); return { id: 'ticket-1' }; },
}));
vi.mock('./taskOutbox', () => ({
  enqueueTaskOutbox: async (_d: unknown, i: unknown) => { calls.enqueue.push(i); },
}));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn() }));

import {
  CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
  HumanWorkStepWaitingError,
  OPERATOR_TASK_ACTOR,
  onChecklistItemDone,
  onChecklistItemUnticked,
  openHumanWorkStep,
} from './humanWorkService';

beforeEach(() => {
  for (const k of Object.keys(calls)) calls[k] = [];
});

describe('humanWorkService constants (recipe spec §6.5)', () => {
  it('uses a FIXED outbox ordinal, because the sourceId is the item and a step settles once', () => {
    // taskOutbox.ts's two shipped schemes (RUN_/INTENT_TERMINAL_OUTBOX_
    // TRANSITION_SEQ) are fixed terminal-status ordinals chosen so a redelivered
    // wake collapses onto ONE row. A checklist item reaching `done` is terminal
    // for its step, and the sourceId is the ITEM id, so two human-work steps on
    // one task never collide on this ordinal.
    expect(CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ).toBe(1);
  });

  it('creates tickets as a named system principal with the nil user id', () => {
    // createTicket requires a TicketActor with a non-null userId, and the
    // Operator is not a users row. Precedent: DELIVERABLE_SWEEP_ACTOR
    // (services/serviceDeliverableService.ts).
    expect(OPERATOR_TASK_ACTOR.userId).toBe('00000000-0000-0000-0000-000000000000');
    expect(OPERATOR_TASK_ACTOR.name).toBe('AI Operator');
  });

  it('the delete refusal is a typed 409, not a bare throw', () => {
    const err = new HumanWorkStepWaitingError('x');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CHECKLIST_OPERATOR_STEP_WAITING');
    expect(err).toBeInstanceOf(Error);
  });
});

/**
 * A drizzle stub keyed on the SELECT's projection, since the service issues
 * three differently-shaped selects. Each `select(projection)` returns a chain
 * whose terminal resolves to the row the projection's first key names.
 */
function makeDbh(rows: {
  ticketTarget?: Array<{ id: string; ticketId: string | null }>;
  maxOrdinal?: number | null;
  maxPosition?: number | null;
  link?: Array<Record<string, unknown>>;
}) {
  const updated: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.leftJoin = () => c;
    c.limit = async () => result;
    c.then = (res: (v: unknown) => void) => Promise.resolve(result).then(res);
    return c;
  };
  const dbh = {
    select: vi.fn((projection: Record<string, unknown>) => {
      const keys = Object.keys(projection);
      if (keys.includes('ticketId') && keys.includes('id')) return chain(rows.ticketTarget ?? []);
      if (keys.includes('maxOrdinal')) return chain([{ maxOrdinal: rows.maxOrdinal ?? null }]);
      if (keys.includes('maxPosition')) return chain([{ maxPosition: rows.maxPosition ?? null }]);
      return chain(rows.link ?? []);
    }),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'item-9' }] };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { updated.push({ table, set }); },
      }),
    })),
  };
  return { dbh: dbh as never, updated, inserted, spies: dbh };
}

describe('openHumanWorkStep', () => {
  it('writes BOTH directions of the link and yields the item id as the wait dependency', async () => {
    const { dbh, updated, inserted } = makeDbh({
      ticketTarget: [{ id: 'target-t', ticketId: 'ticket-1' }],
      maxPosition: 2,
    });

    const result = await openHumanWorkStep(dbh, {
      task: { id: 'task-1', orgId: 'org-1', objective: 'Offboard Dana', revision: 3, attemptOrdinal: 0 },
      stepKey: 'collect_hardware',
      label: 'Collect the laptop',
      detail: 'Dock and charger too',
      remindAfterMs: 86_400_000,
      now: new Date('2026-10-20T10:00:00.000Z'),
    });

    expect(result).toEqual({ stepId: 'step-1', checklistItemId: 'item-9', ticketId: 'ticket-1' });
    // The ticket target existed, so no ticket was created.
    expect(calls.createTicket).toHaveLength(0);
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1', ticketId: 'ticket-1', label: 'Collect the laptop', detail: 'Dock and charger too',
      position: 3, source: 'operator_task', createdBy: null,
    });
    expect(calls.openStep[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'collect_hardware',
      stepKind: 'human_work', attemptOrdinal: 0, planRevision: 3,
    });
    // The wait dependency is the ITEM, not the step: that is what a human acts
    // on and what the wake carries as its sourceId (spec §6.5).
    expect(calls.markStepWaiting[0]).toMatchObject({
      dependencyKind: 'user_answer', dependencyId: 'item-9',
    });
    // Both directions written: the step's owning pointer and the item's
    // provenance pointer.
    const stepLink = updated.find((u) => u.set.checklistItemId === 'item-9');
    expect(stepLink).toBeDefined();
    expect(stepLink!.set.remindAfterAt).toEqual(new Date('2026-10-21T10:00:00.000Z'));
    expect(stepLink!.set.remindedAt).toBeNull();
    expect(updated.some((u) => u.set.operatorStepId === 'step-1')).toBe(true);
  });

  it('creates a ticket as a `ticket` target row when the task has none', async () => {
    const { dbh } = makeDbh({ ticketTarget: [], maxOrdinal: 0, maxPosition: null });
    const result = await openHumanWorkStep(dbh, {
      task: { id: 'task-1', orgId: 'org-1', objective: 'Offboard Dana', revision: 1, attemptOrdinal: 0 },
      stepKey: 'collect_hardware',
      label: 'Collect the laptop',
    });
    expect(result.ticketId).toBe('ticket-1');
    expect(calls.createTicket[0]).toMatchObject({ orgId: 'org-1', source: 'ai', subject: 'Offboard Dana' });
    expect(calls.createTaskTarget[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', targetKind: 'ticket', ticketId: 'ticket-1', targetOrdinal: 1,
    });
    expect(calls.appendTaskEvent.some((e) => (e as { eventType: string }).eventType === 'target_attached')).toBe(true);
  });

  it('refuses an empty label BEFORE touching the database', async () => {
    const { dbh, spies } = makeDbh({});
    await expect(openHumanWorkStep(dbh, {
      task: { id: 'task-1', orgId: 'org-1', objective: 'o', revision: 1, attemptOrdinal: 0 },
      stepKey: 'collect_hardware', label: '   ',
    })).rejects.toThrow(/label/);
    expect(spies.insert).not.toHaveBeenCalled();
    expect(spies.select).not.toHaveBeenCalled();
  });
});

describe('onChecklistItemDone / onChecklistItemUnticked', () => {
  it('enqueues a user_answer wake keyed on the ITEM with the fixed ordinal', async () => {
    const { dbh } = makeDbh({ link: [{ orgId: 'org-1', taskId: 'task-1' }] });
    await expect(onChecklistItemDone(dbh, 'item-9')).resolves.toBe('enqueued');
    expect(calls.enqueue[0]).toEqual({
      orgId: 'org-1', taskId: 'task-1', sourceKind: 'user_answer', sourceId: 'item-9', transitionSeq: 1,
    });
  });

  it('is a no-op for an item no step points at', async () => {
    const { dbh } = makeDbh({ link: [] });
    await expect(onChecklistItemDone(dbh, 'item-manual')).resolves.toBe('not_operator_item');
    expect(calls.enqueue).toHaveLength(0);
  });

  it('untick records a human_work_unticked event and enqueues NOTHING', async () => {
    const { dbh } = makeDbh({ link: [{ orgId: 'org-1', taskId: 'task-1', stepKey: 'collect_hardware', state: 'succeeded' }] });
    await expect(onChecklistItemUnticked(dbh, 'item-9')).resolves.toBe('recorded');
    expect(calls.appendTaskEvent[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', eventType: 'human_work_unticked', stepKey: 'collect_hardware',
    });
    expect(calls.enqueue).toHaveLength(0);
  });
});
