// apps/api/src/services/aiOperator/eventService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { appendTaskEvent } from './eventService';

/**
 * A minimal drizzle stub. It records what was asked of it rather than
 * simulating SQL: the assertions below are about the CONTRACT (one seq
 * allocation per event, taken from the task row, never from MAX(); a machine
 * actor never carries a user id), not about query shape.
 */
function stubDb(allocated: number | null) {
  const inserted: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: () => ({
      where: () => ({
        returning: async () => (allocated === null ? [] : [{ eventSeq: allocated }]),
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: async (v: Record<string, unknown>) => { inserted.push(v); },
  }));
  return { dbh: { insert, update, select: vi.fn() } as never, inserted, update, insert };
}

describe('appendTaskEvent (recipe spec §5, Operator spec §11)', () => {
  it('allocates transition_seq from the task row and writes it onto the event', async () => {
    const { dbh, inserted, update } = stubDb(7);
    const seq = await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'step_opened',
      actor: { kind: 'coordinator' },
      stepKey: 'investigate',
    });
    expect(seq).toBe(7);
    // The allocation is an UPDATE ... RETURNING on ai_operator_tasks, which
    // takes that row's lock and serialises concurrent writers. A MAX()+1 read
    // would instead race to a 23505 and abort the caller's transaction.
    expect(update).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', transitionSeq: 7,
      eventType: 'step_opened', actorKind: 'coordinator', stepKey: 'investigate',
    });
  });

  it('never stamps a user id on a machine actor (spec §7.1)', async () => {
    const { dbh, inserted } = stubDb(1);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'task_settled', actor: { kind: 'reconciler' },
    });
    expect(inserted[0].actorUserId).toBeNull();
  });

  it('stamps the user id for a user actor', async () => {
    const { dbh, inserted } = stubDb(2);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'task_settled', actor: { kind: 'user', userId: 'user-9' },
    });
    expect(inserted[0]).toMatchObject({ actorKind: 'user', actorUserId: 'user-9' });
  });

  it('truncates detail to the column bound rather than raising 23514', async () => {
    const { dbh, inserted } = stubDb(3);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'operation_settled', actor: { kind: 'system' },
      detail: 'x'.repeat(9000),
    });
    expect((inserted[0].detail as string).length).toBe(4000);
  });

  it('is a no-op when the task row is gone, and inserts nothing', async () => {
    const { dbh, inserted, insert } = stubDb(null);
    const seq = await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-gone',
      eventType: 'task_settled', actor: { kind: 'system' },
    });
    expect(seq).toBeNull();
    expect(insert).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});
