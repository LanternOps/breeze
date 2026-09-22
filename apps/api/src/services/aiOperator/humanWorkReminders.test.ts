/**
 * Recipe spec §6.5: "a human-work step past its `remind_after` writes a ticket
 * comment and a notification; past the task deadline the task hands off, it
 * does not fail."
 *
 * The second half is the coordinator's deadline branch
 * (taskCoordinatorHumanWork / aiOperatorHumanWorkStep integration). This file
 * owns the first half, and the assertion that matters most is the ONE: the
 * coordinator tick runs every 15 s (COORDINATOR_TICK_INTERVAL_MS), so a
 * reminder that does not stamp `reminded_at` would post four ticket comments a
 * minute for the life of the step. That is not a cosmetic bug — it is a ticket
 * a technician stops reading.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  overdue: [] as Array<Record<string, unknown>>,
  stampRows: [{ id: 'step-1' }] as Array<{ id: string }>,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  executes: 0,
  log: [] as string[],
}));

vi.mock('../../db', () => {
  const db = {
    select: () => {
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.innerJoin = () => c;
      c.leftJoin = () => c;
      c.where = () => c;
      c.orderBy = () => c;
      c.limit = async () => state.overdue;
      return c;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        state.updates.push(patch);
        state.log.push('update');
        return { where: () => ({ returning: async () => state.stampRows }) };
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => { state.inserts.push(v); state.log.push('insert'); },
    }),
    execute: async () => { state.executes += 1; return { rows: [], rowCount: 0 }; },
  };
  return {
    db,
    runOutsideDbContext: <T>(fn: () => T) => fn(),
    withSystemDbAccessContext: <T>(fn: () => T) => fn(),
  };
});
vi.mock('./eventService', () => ({
  appendTaskEvent: vi.fn(async (_d: unknown, e: Record<string, unknown>) => { state.events.push(e); return 1; }),
}));
vi.mock('../userNotifications', () => ({
  createNotification: vi.fn(async (n: Record<string, unknown>) => { state.notifications.push(n); state.log.push('notify'); return 'n-1'; }),
}));
vi.mock('../ticketService', () => ({ createTicket: vi.fn() }));
vi.mock('./targetService', () => ({ createTaskTarget: vi.fn() }));
vi.mock('./stepService', () => ({ openStep: vi.fn(), markStepWaiting: vi.fn(), settleStep: vi.fn() }));
vi.mock('./taskOutbox', () => ({ enqueueTaskOutbox: vi.fn() }));
vi.mock('../aiOperatorCoordinatorMetrics', () => ({
  recordAiOperatorReconcilerScan: vi.fn(),
  recordAiOperatorTaskStates: vi.fn(),
  recordAiOperatorWaitingAgeMax: vi.fn(),
}));
vi.mock('./taskCoordinator', () => ({ advanceTask: vi.fn(), claimTaskLease: vi.fn() }));
vi.mock('./deviceCommandEvidence', () => ({ classifyDeviceCommandEvidence: vi.fn(), readDeviceCommandEvidence: vi.fn() }));
vi.mock('./operationService', () => ({ recordOperationResult: vi.fn() }));
vi.mock('./taskService', () => ({ parseTaskCheckpoint: vi.fn() }));

import { sendHumanWorkReminders } from './humanWorkService';
import { runReconcilerPass } from './taskReconciler';

const NOW = new Date('2026-10-21T10:00:00.000Z');
const overdueRow = {
  stepId: 'step-1', orgId: 'org-1', taskId: 'task-1', stepKey: 'collect_hardware',
  ticketId: 'ticket-1', label: 'Collect the laptop', requesterUserId: 'user-7',
};

beforeEach(() => {
  state.overdue = [];
  state.stampRows = [{ id: 'step-1' }];
  state.updates = [];
  state.inserts = [];
  state.events = [];
  state.notifications = [];
  state.executes = 0;
  state.log = [];
});

describe('sendHumanWorkReminders (spec §6.5)', () => {
  it('posts ONE internal ticket comment and ONE notification per overdue step', async () => {
    state.overdue = [overdueRow];
    const n = await sendHumanWorkReminders(NOW);
    expect(n).toBe(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ ticketId: 'ticket-1' });
    expect(String(state.inserts[0]!.content)).toContain('Collect the laptop');
  });

  it('stamps reminded_at BEFORE the side-effects, so the next tick skips the row', async () => {
    state.overdue = [overdueRow];
    await sendHumanWorkReminders(NOW);
    // The stamp is the FIRST write; the comment and the notification follow it.
    expect(state.log).toEqual(['update', 'insert', 'notify']);
    expect(state.updates[0]).toMatchObject({ remindedAt: NOW });
    // A second pass over the same (now stamped) row: the guarded UPDATE matches
    // nothing and NO second comment or notification is posted.
    state.stampRows = [];
    await sendHumanWorkReminders(NOW);
    expect(state.inserts).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
  });

  it('never posts a PUBLIC comment — the customer is not the audience for internal chasing', async () => {
    state.overdue = [overdueRow];
    await sendHumanWorkReminders(NOW);
    expect(state.inserts[0]).toMatchObject({ isPublic: false, commentType: 'internal' });
  });

  it('writes the comment with a NULL user id and an ai_agent author, never a synthetic user', async () => {
    // The Operator is not a `users` row; ticket_comments.user_id is a real FK.
    state.overdue = [overdueRow];
    await sendHumanWorkReminders(NOW);
    expect(state.inserts[0]).toMatchObject({
      userId: null, authorType: 'ai_agent', originPrincipalKind: 'ai_agent', authorName: 'AI Operator',
    });
  });

  it('links the notification to the TICKET, with a relative path and a per-step dedupe key', async () => {
    // user_notifications.link carries a CHECK constraint requiring a relative
    // same-origin path.
    state.overdue = [overdueRow];
    await sendHumanWorkReminders(NOW);
    expect(state.notifications[0]).toMatchObject({
      userId: 'user-7', orgId: 'org-1', type: 'ai',
      link: '/tickets/ticket-1', dedupeKey: 'operator-human-work:step-1',
    });
  });

  it('skips the notification (but still comments) when the task has no requester', async () => {
    state.overdue = [{ ...overdueRow, requesterUserId: null }];
    await sendHumanWorkReminders(NOW);
    expect(state.inserts).toHaveLength(1);
    expect(state.notifications).toHaveLength(0);
  });

  it('records a reconciler-attributed event per reminder', async () => {
    state.overdue = [overdueRow];
    await sendHumanWorkReminders(NOW);
    expect(state.events[0]).toMatchObject({
      taskId: 'task-1', stepKey: 'collect_hardware', actor: { kind: 'reconciler' },
    });
  });
});

describe('runReconcilerPass — set 5 (E3)', () => {
  it('runs the reminder sweep LAST and reports its count', async () => {
    state.overdue = [overdueRow];
    const pass = await runReconcilerPass(NOW);
    expect(pass.humanWorkReminders).toBe(1);
    // The four recovery scans still ran (raw executes) before the sweep.
    expect(state.executes).toBeGreaterThan(0);
  });
});
