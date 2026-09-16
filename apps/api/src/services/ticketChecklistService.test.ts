import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Chain mock with RECORDED arguments.
 *
 * The queue in `rows` feeds each awaited statement in order; `calls` records
 * every `.set()` / `.where()` / `.values()` argument so an assertion can inspect
 * the actual predicate rather than trusting that the chain was called at all.
 * That distinction matters here: the "already done preserves the original
 * completer" case only discriminates if the guarded UPDATE's `done_at IS NULL`
 * predicate is really compiled into SQL, and if a zero-row result is really
 * followed by a re-read.
 */
const dbMocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  set: [] as unknown[],
  where: [] as unknown[],
  values: [] as unknown[],
  execute: [] as unknown[],
}));

vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of [
      'select', 'from', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy',
      'insert', 'update', 'delete', 'returning',
    ]) {
      c[m] = vi.fn(() => c);
    }
    c.set = vi.fn((v: unknown) => { dbMocks.set.push(v); return c; });
    c.where = vi.fn((v: unknown) => { dbMocks.where.push(v); return c; });
    c.values = vi.fn((v: unknown) => { dbMocks.values.push(v); return c; });
    c.execute = vi.fn(async (v: unknown) => { dbMocks.execute.push(v); return []; });
    c.then = (res: (v: unknown) => void) => res(dbMocks.rows.shift() ?? []);
    c.transaction = async (fn: (tx: unknown) => unknown) => fn(c);
    return c;
  };
  return { db: chain() };
});

import {
  addChecklistItem,
  patchChecklistItem,
  reorderChecklist,
  listChecklist,
  deleteChecklistItem,
  ChecklistServiceError,
} from './ticketChecklistService';

/** Compile a drizzle SQL fragment to its literal text + bound params. */
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(fragment as SQL);
  return { sql, params };
}

const TICKET = { id: '3f2f1d8e-1111-4222-8333-444455556666', orgId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111' };
const ACTOR = { userId: 'user-1' };
const ITEM = 'bbbbcccc-dddd-eeee-ffff-000011112222';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ITEM,
    ticketId: TICKET.id,
    label: 'Step',
    detail: null,
    position: 0,
    doneAt: null,
    doneByUserId: null,
    source: 'manual',
    sourceTemplateItemId: null,
    createdBy: null,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-01T09:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  dbMocks.rows.length = 0;
  dbMocks.set.length = 0;
  dbMocks.where.length = 0;
  dbMocks.values.length = 0;
  dbMocks.execute.length = 0;
});

describe('addChecklistItem', () => {
  it('stamps the ticket org, source manual and max(position) + 1', async () => {
    dbMocks.rows.push([{ maxPosition: 4 }], [row({ position: 5 })]);

    await addChecklistItem(TICKET, { label: 'Check the sign-in log' }, ACTOR);

    expect(dbMocks.values[0]).toEqual(expect.objectContaining({
      orgId: TICKET.orgId, // the TICKET's org, never the caller's
      ticketId: TICKET.id,
      position: 5,
      source: 'manual',
      createdBy: 'user-1',
    }));
  });

  it('appends at position 0 on an empty checklist', async () => {
    dbMocks.rows.push([{ maxPosition: null }], [row({ position: 0 })]);
    await addChecklistItem(TICKET, { label: 'First' }, ACTOR);
    expect(dbMocks.values[0]).toEqual(expect.objectContaining({ position: 0 }));
  });

  it('records a null createdBy for a system actor', async () => {
    dbMocks.rows.push([{ maxPosition: null }], [row()]);
    await addChecklistItem(TICKET, { label: 'Swept' }, { userId: null });
    expect(dbMocks.values[0]).toEqual(expect.objectContaining({ createdBy: null }));
  });
});

describe('patchChecklistItem attestation rules', () => {
  it('done: true stamps done_at and the actor, guarded on done_at IS NULL', async () => {
    const stamped = new Date('2026-09-02T10:00:00.000Z');
    dbMocks.rows.push([row()], [row({ doneAt: stamped, doneByUserId: 'user-1' })]);

    const out = await patchChecklistItem(ITEM, { done: true }, ACTOR);

    expect(out.done).toBe(true);
    expect(out.doneByUserId).toBe('user-1');
    expect(dbMocks.set[0]).toEqual(expect.objectContaining({ doneByUserId: 'user-1' }));
    // The guard is the whole point: compile the real predicate and assert the
    // `done_at is null` leg is in it, so a plain unguarded SET fails here.
    const guard = compile(dbMocks.where[1]).sql.toLowerCase();
    expect(guard).toContain('done_at" is null');
  });

  it('done: true on an ALREADY done item preserves the original completer', async () => {
    const original = new Date('2026-09-01T10:00:00.000Z');
    dbMocks.rows.push(
      [row({ doneAt: original, doneByUserId: 'user-ORIGINAL' })], // getChecklistItemOr404
      [],                                                        // guarded UPDATE matches zero rows
      [row({ doneAt: original, doneByUserId: 'user-ORIGINAL' })], // re-read
    );

    const out = await patchChecklistItem(ITEM, { done: true }, { userId: 'user-SECOND' });

    expect(out.doneByUserId).toBe('user-ORIGINAL');
    expect(out.doneAt).toBe(original.toISOString());
  });

  it('done: false clears BOTH done_at and done_by_user_id', async () => {
    dbMocks.rows.push([row({ doneAt: new Date(), doneByUserId: 'user-1' })], [row()]);

    const out = await patchChecklistItem(ITEM, { done: false }, ACTOR);

    expect(dbMocks.set[0]).toEqual(expect.objectContaining({ doneAt: null, doneByUserId: null }));
    expect(out.done).toBe(false);
    expect(out.doneByUserId).toBeNull();
  });

  it('editing the label of a DONE item clears the attestation', async () => {
    dbMocks.rows.push(
      [row({ doneAt: new Date(), doneByUserId: 'user-1', label: 'Old text' })],
      [row({ label: 'New text' })],
    );

    const out = await patchChecklistItem(ITEM, { label: 'New text' }, ACTOR);

    expect(dbMocks.set[0]).toEqual(expect.objectContaining({
      label: 'New text', doneAt: null, doneByUserId: null,
    }));
    expect(out.done).toBe(false);
  });

  it('editing only the DETAIL of a DONE item also clears the attestation', async () => {
    // `editsText` covers detail as well as label — the note is part of what the
    // tick attested to, so the label-only case above does not prove this branch.
    dbMocks.rows.push(
      [row({ doneAt: new Date(), doneByUserId: 'user-1', detail: 'Old note' })],
      [row({ detail: 'New note' })],
    );

    const out = await patchChecklistItem(ITEM, { detail: 'New note' }, ACTOR);

    expect(dbMocks.set[0]).toEqual(expect.objectContaining({
      detail: 'New note', doneAt: null, doneByUserId: null,
    }));
    expect(out.done).toBe(false);
  });

  it('editing the label of an UNTICKED item does not touch the attestation columns', async () => {
    dbMocks.rows.push([row({ label: 'Old' })], [row({ label: 'New' })]);

    await patchChecklistItem(ITEM, { label: 'New' }, ACTOR);

    const set = dbMocks.set[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(set, 'doneAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(set, 'doneByUserId')).toBe(false);
  });

  it('a text edit arriving WITH done: true ends the item unticked', async () => {
    dbMocks.rows.push([row({ label: 'Old' })], [row({ label: 'New' })]);

    const out = await patchChecklistItem(ITEM, { label: 'New', done: true }, ACTOR);

    expect(dbMocks.set[0]).toEqual(expect.objectContaining({ doneAt: null, doneByUserId: null }));
    expect(out.done).toBe(false);
  });

  it('404s an item that does not exist, before writing anything', async () => {
    dbMocks.rows.push([]);
    await expect(patchChecklistItem(ITEM, { done: true }, ACTOR)).rejects.toMatchObject({
      status: 404, code: 'NOT_FOUND',
    });
    expect(dbMocks.set).toHaveLength(0);
  });
});

describe('reorderChecklist', () => {
  it('rejects a list whose id set differs from the ticket’s current items', async () => {
    dbMocks.rows.push([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await expect(reorderChecklist(TICKET.id, ['a', 'b'])).rejects.toMatchObject({
      status: 400, code: 'CHECKLIST_REORDER_MISMATCH',
    });
    expect(dbMocks.execute).toHaveLength(0);
  });

  it('rejects a list containing an id from another ticket', async () => {
    dbMocks.rows.push([{ id: 'a' }, { id: 'b' }]);
    await expect(reorderChecklist(TICKET.id, ['a', 'FOREIGN'])).rejects.toMatchObject({
      code: 'CHECKLIST_REORDER_MISMATCH',
    });
    expect(dbMocks.execute).toHaveLength(0);
  });

  it('rejects a list that repeats one id to reach the right length', async () => {
    dbMocks.rows.push([{ id: 'a' }, { id: 'b' }]);
    await expect(reorderChecklist(TICKET.id, ['a', 'a'])).rejects.toMatchObject({
      code: 'CHECKLIST_REORDER_MISMATCH',
    });
    expect(dbMocks.execute).toHaveLength(0);
  });

  it('writes every position in ONE statement, in the submitted order', async () => {
    dbMocks.rows.push([{ id: 'a' }, { id: 'b' }, { id: 'c' }], []);
    await reorderChecklist(TICKET.id, ['c', 'a', 'b']);
    expect(dbMocks.execute).toHaveLength(1);
    const { params } = compile(dbMocks.execute[0]);
    // id -> position pairs, plus the trailing ticket id.
    expect(params).toEqual(['c', 0, 'a', 1, 'b', 2, TICKET.id]);
  });
});

describe('listChecklist', () => {
  it('returns done and total derived from done_at, never a stored counter', async () => {
    dbMocks.rows.push([
      row({ id: 'a', doneAt: new Date(), position: 0 }),
      row({ id: 'b', doneAt: null, position: 1 }),
      row({ id: 'c', doneAt: null, position: 2 }),
    ]);
    const out = await listChecklist(TICKET.id);
    expect(out.total).toBe(3);
    expect(out.done).toBe(1);
  });

  it('returns an empty summary for a ticket with no steps', async () => {
    dbMocks.rows.push([]);
    expect(await listChecklist(TICKET.id)).toEqual({ items: [], done: 0, total: 0 });
  });
});

describe('deleteChecklistItem', () => {
  it('404s when nothing was deleted', async () => {
    dbMocks.rows.push([]);
    await expect(deleteChecklistItem(ITEM)).rejects.toBeInstanceOf(ChecklistServiceError);
  });

  it('resolves when a row was deleted', async () => {
    dbMocks.rows.push([{ id: ITEM }]);
    await expect(deleteChecklistItem(ITEM)).resolves.toBeUndefined();
  });
});
