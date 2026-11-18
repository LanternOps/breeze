/**
 * `manualWork.ts` (D-R1-5). Every item is created up front, each with its own
 * `manual_work` step row at attempt_ordinal = index; dedupe is by STEP
 * IDENTITY, never by `(ticket_id, label)`; the Operator never completes an
 * item. Real-row behaviour (ticket, items, links, wake) is covered again by
 * `aiOperatorIdentityOffboardingE2E.integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensureTaskTicket: vi.fn(),
  openStep: vi.fn(),
  markStepWaiting: vi.fn(),
  lockTicketForWrite: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./humanWorkService', () => ({ ensureTaskTicket: (...a: unknown[]) => h.ensureTaskTicket(...a) }));
vi.mock('./stepService', () => ({
  openStep: (...a: unknown[]) => h.openStep(...a),
  markStepWaiting: (...a: unknown[]) => h.markStepWaiting(...a),
}));
vi.mock('../ticketRowLock', () => ({ lockTicketForWrite: (...a: unknown[]) => h.lockTicketForWrite(...a) }));

import { TicketMergedError } from '../ticketMerge/errors';
import { clipLabel, ensureManualWorkItems, nextOpenManualItem, type ManualWorkRow } from './manualWork';
import type { IdentityManualWorkItem } from './recipes/identityOffboarding';

const ORG = '00000000-0000-4000-8000-0000000000aa';

/** A fake handle: step rows per task are the "database"; inserts and updates are recorded. */
function fakeDb(stepRowsByTask: Map<string, Array<{ index: number; checklistItemId: string | null }>>) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  let currentTask = '';
  let selectN = 0;
  const dbh: any = {
    select: () => {
      selectN += 1;
      const isAgg = selectN % 2 === 0; // existing-rows read, then the MAX(position) read
      const c: any = {
        from: () => c,
        where: (w: unknown) => {
          wheres.push(w);
          if (!isAgg) return Promise.resolve(stepRowsByTask.get(currentTask) ?? []);
          return Promise.resolve([{ maxPosition: 4 }]);
        },
      };
      return c;
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        const id = `item-${inserts.length}`;
        return { returning: async () => [{ id }] };
      },
    }),
    update: () => ({ set: (s: Record<string, unknown>) => { updates.push(s); return { where: async () => [] }; } }),
  };
  return { dbh, inserts, updates, wheres, setTask: (t: string) => { currentTask = t; selectN = 0; } };
}

function items(...labels: string[]): IdentityManualWorkItem[] {
  return labels.map((label, i) => ({ key: `k${i}`, label, detail: `do ${label}`, origin: 'always', capabilityKey: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ensureTaskTicket.mockResolvedValue({ ticketId: 'ticket-1', targetId: 'tt', created: false });
  h.openStep.mockImplementation(async (_d: unknown, input: { attemptOrdinal: number }) => ({ id: `step-${input.attemptOrdinal}` }));
});

describe('ensureManualWorkItems', () => {
  const task = { id: 'task-A', orgId: ORG, objective: 'Offboard Dana', revision: 1 };

  it('first entry creates every item up front, each bound to its own step row at attempt = index', async () => {
    const f = fakeDb(new Map());
    f.setTask('task-A');
    const r = await ensureManualWorkItems(f.dbh, task, items('Collect laptop', 'Transfer files', 'Update docs'));
    expect(r).toEqual({ ticketId: 'ticket-1', itemIds: ['item-1', 'item-2', 'item-3'], created: 3 });
    expect(f.inserts.map((v) => [v.label, v.position, v.source, v.createdBy])).toEqual([
      ['Collect laptop', 5, 'operator_task', null], ['Transfer files', 6, 'operator_task', null], ['Update docs', 7, 'operator_task', null],
    ]);
    expect(h.openStep.mock.calls.map((c) => [c[1].stepKey, c[1].attemptOrdinal, c[1].stepKind])).toEqual([
      ['manual_work', 0, 'human_work'], ['manual_work', 1, 'human_work'], ['manual_work', 2, 'human_work'],
    ]);
    // Both link directions written; the step waits on ITS item.
    expect(f.updates.filter((u) => 'checklistItemId' in u).map((u) => u.checklistItemId)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(f.updates.filter((u) => 'operatorStepId' in u).map((u) => u.operatorStepId)).toEqual(['step-0', 'step-1', 'step-2']);
    expect(h.markStepWaiting.mock.calls.map((c) => c[1].dependencyId)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(h.lockTicketForWrite).toHaveBeenCalledWith(f.dbh, 'ticket-1');
    // The existing-rows read is task- and org-scoped and keyed on step identity.
    const q = new PgDialect().sqlToQuery(f.wheres[0] as SQL);
    expect(q.params).toEqual(expect.arrayContaining([ORG, 'task-A', 'manual_work']));
    expect(q.sql).not.toContain('"label"');
  });

  it('dedupe 1: called again with the same list inserts ZERO and returns the same ids in the same order', async () => {
    const rows = new Map([['task-A', [{ index: 0, checklistItemId: 'i0' }, { index: 1, checklistItemId: 'i1' }]]]);
    const f = fakeDb(rows);
    f.setTask('task-A');
    const r = await ensureManualWorkItems(f.dbh, task, items('Collect laptop', 'Transfer files'));
    expect(r).toEqual({ ticketId: 'ticket-1', itemIds: ['i0', 'i1'], created: 0 });
    expect(f.inserts).toEqual([]);
    expect(h.lockTicketForWrite).not.toHaveBeenCalled();
  });

  it('dedupe 2: a technician RELABELLED an item — still zero inserts (the step identity is unchanged)', async () => {
    const rows = new Map([['task-A', [{ index: 0, checklistItemId: 'i0' }, { index: 1, checklistItemId: 'i1' }]]]);
    const f = fakeDb(rows);
    f.setTask('task-A');
    // The items on the ticket now carry different labels; the generated list is unchanged.
    const r = await ensureManualWorkItems(f.dbh, task, items('Collect laptop', 'Transfer files'));
    expect(r.created).toBe(0);
    expect(f.inserts).toEqual([]);
  });

  it('dedupe 3: two tasks on ONE ticket with an identical label both get their item', async () => {
    const rows = new Map([['task-A', [{ index: 0, checklistItemId: 'a0' }]]]);
    const f = fakeDb(rows);
    f.setTask('task-B');
    const r = await ensureManualWorkItems(f.dbh, { ...task, id: 'task-B' }, items('Collect laptop'));
    expect(r.created).toBe(1);
    expect(f.inserts.map((v) => v.label)).toEqual(['Collect laptop']);
  });

  it('a partial earlier run creates only the missing indexes', async () => {
    const rows = new Map([['task-A', [{ index: 1, checklistItemId: 'i1' }]]]);
    const f = fakeDb(rows);
    f.setTask('task-A');
    const r = await ensureManualWorkItems(f.dbh, task, items('A', 'B', 'C'));
    expect(r.itemIds).toEqual(['item-1', 'i1', 'item-2']);
    expect(h.openStep.mock.calls.map((c) => c[1].attemptOrdinal)).toEqual([0, 2]);
  });

  it('REFUSES a merged tombstone under the lock (#8972 W1) — no item, no step row', async () => {
    // ensureTaskTicket read the target unlocked; a merge that commits before
    // the lock re-points the target, so the coordinator's retry lands on the survivor.
    h.lockTicketForWrite.mockResolvedValueOnce({ id: 'ticket-1', orgId: ORG, mergedIntoTicketId: 'survivor-1' });
    const f = fakeDb(new Map());
    f.setTask('task-A');
    await expect(ensureManualWorkItems(f.dbh, task, items('Collect laptop'))).rejects.toBeInstanceOf(TicketMergedError);
    expect(h.lockTicketForWrite).toHaveBeenCalledWith(f.dbh, 'ticket-1');
    expect(f.inserts).toEqual([]);
    expect(h.openStep).not.toHaveBeenCalled();
  });

  it('refuses more than 64 items before writing anything', async () => {
    const f = fakeDb(new Map());
    await expect(ensureManualWorkItems(f.dbh, task, items(...Array.from({ length: 65 }, (_, i) => `i${i}`)))).rejects.toThrow(/64/);
    expect(h.ensureTaskTicket).not.toHaveBeenCalled();
  });
});

describe('labels and the cursor', () => {
  it('truncates a label to 500 chars VISIBLY, with an ellipsis', () => {
    const out = clipLabel('x'.repeat(800));
    expect(out).toHaveLength(500);
    expect(out.endsWith('…')).toBe(true);
    expect(clipLabel('  short  ')).toBe('short');
  });

  it('nextOpenManualItem skips done items so out-of-order ticks advance the cursor; null when all done', () => {
    const row = (index: number, done: boolean): ManualWorkRow => ({
      index, stepId: `s${index}`, stepState: 'waiting', checklistItemId: `i${index}`, itemLabel: 'x',
      itemDoneAt: done ? new Date() : null, itemDoneByUserId: done ? 'u1' : null,
    });
    expect(nextOpenManualItem([row(0, true), row(1, false), row(2, false)], 0)).toEqual({ index: 1, itemId: 'i1' });
    expect(nextOpenManualItem([row(0, false), row(1, true), row(2, true)], 1)).toBeNull();
    expect(nextOpenManualItem([row(2, false), row(0, true), row(1, true)], 0)).toEqual({ index: 2, itemId: 'i2' });
    expect(nextOpenManualItem([], 0)).toBeNull();
  });
});

describe('invariant: the Operator never completes a checklist item', () => {
  it('manualWork.ts never writes done_at or done_by_user_id', () => {
    const src = readFileSync(join(__dirname, 'manualWork.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/doneAt\s*:/);
    expect(src).not.toMatch(/doneByUserId\s*:/);
  });
});
