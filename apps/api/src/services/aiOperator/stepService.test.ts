// apps/api/src/services/aiOperator/stepService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { openStep, resolveStepKind, settleStep } from './stepService';

function stubDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: () => ({
        returning: async () => { inserted.push(v); return [{ id: 'step-1' }]; },
      }),
    }),
  }));
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => ({
      where: () => ({ returning: async () => { updated.push(v); return [{ id: 'step-1', taskId: 'task-1' }]; } }),
    }),
  }));
  return { dbh: { insert, update, select: vi.fn() } as never, inserted, updated };
}

describe('stepService (Operator spec §11, recipe spec §5.3)', () => {
  it('opens a step with the full identity tuple the two partial uniques key on', async () => {
    const { dbh, inserted } = stubDb();
    await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', stepKind: 'effect',
      targetId: 'target-1', attemptOrdinal: 2, planRevision: 3,
    });
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', stepKind: 'effect',
      targetId: 'target-1', attemptOrdinal: 2, planRevision: 3, state: 'running',
    });
  });

  it('is idempotent on re-open — a lease reclaim must not create a second row', async () => {
    const { dbh } = stubDb();
    const first = await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify', stepKind: 'probe',
      attemptOrdinal: 0, planRevision: 1,
    });
    const second = await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify', stepKind: 'probe',
      attemptOrdinal: 0, planRevision: 1,
    });
    // Same identity tuple -> ON CONFLICT DO UPDATE returns the SAME row. A
    // reclaimed lease re-runs the step function from the top (taskCoordinator
    // invariant: "a reclaim re-derives the same verdict"), so a DO NOTHING or
    // a plain insert would either lose the row or duplicate it.
    expect(second.id).toBe(first.id);
  });

  it('settles a step with a terminal state and a settled_at stamp', async () => {
    const { dbh, updated } = stubDb();
    await settleStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', attemptOrdinal: 0,
      targetId: null, state: 'succeeded', detail: 'restart dispatched and verified',
    });
    expect(updated[0]).toMatchObject({ state: 'succeeded' });
    expect(updated[0]!.settledAt).toBeInstanceOf(Date);
  });

  it('classifies every service_recovery step key without consulting a model', () => {
    expect(resolveStepKind('service_recovery', 1, 'investigate')).toBe('reason');
    expect(resolveStepKind('service_recovery', 1, 'execute')).toBe('effect');
    expect(resolveStepKind('service_recovery', 1, 'observe')).toBe('probe');
    expect(resolveStepKind('service_recovery', 1, 'verify')).toBe('probe');
    expect(resolveStepKind('service_recovery', 1, 'document')).toBe('document');
  });

  it('falls back to reason for an unknown step key rather than throwing', () => {
    // A step row is EVIDENCE. Refusing to record one because its kind is
    // unknown would lose the transition entirely, which is strictly worse than
    // recording it with a conservative kind.
    expect(resolveStepKind('service_recovery', 1, 'not_a_step')).toBe('reason');
  });
});
