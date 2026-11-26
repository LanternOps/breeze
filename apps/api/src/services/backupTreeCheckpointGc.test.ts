import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// The selection rules themselves are SQL and are proved against Postgres in
// __tests__/integration/backupSnapshotIndexPublish.integration.test.ts. This
// covers the loop: one header per transaction, refusals, bounds and errors.

const { executeMock, transactions } = vi.hoisted(() => ({
  executeMock: vi.fn<(query: SQL) => Promise<unknown>>(),
  transactions: { opened: 0, system: 0, outside: 0 },
}));

vi.mock('../db', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      transactions.opened += 1;
      return cb({ execute: executeMock });
    },
  },
  runOutsideDbContext: async (fn: () => Promise<unknown>) => {
    transactions.outside += 1;
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    transactions.system += 1;
    return fn();
  },
}));

import { CHECKPOINT_ORPHAN_TTL_MS, collectUnreferencedCheckpoints } from './backupTreeCheckpointGc';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const isSelect = (q: SQL) => /^\s*SELECT c\.id FROM backup_tree_checkpoints c/.test(render(q).sql);
const isDelete = (q: SQL) => /^\s*DELETE FROM backup_tree_checkpoints/.test(render(q).sql);
const fkError = () => Object.assign(new Error('update or delete violates foreign key constraint'), { code: '23503' });
const restrictError = () => Object.assign(new Error('restrict violation'), { code: '23001' });

/** Answers each candidate select with the next id of `candidates` (then none), and each delete via `onDelete`. */
function candidates(ids: string[], onDelete: (id: string) => void = () => {}) {
  const queue = [...ids];
  executeMock.mockImplementation(async (q) => {
    if (isSelect(q)) {
      const id = queue.shift();
      return Object.assign(id ? [{ id }] : [], { count: id ? 1 : 0 });
    }
    if (isDelete(q)) {
      onDelete(render(q).params[0] as string);
      return Object.assign([], { count: 1 });
    }
    throw new Error(`unexpected statement: ${render(q).sql}`);
  });
}

const farDeadline = () => Date.now() + 60_000;

beforeEach(() => {
  executeMock.mockReset();
  transactions.opened = 0;
  transactions.system = 0;
  transactions.outside = 0;
});

describe('collectUnreferencedCheckpoints', () => {
  it('deletes one header per system-scoped transaction until none is left', async () => {
    const deleted: string[] = [];
    candidates(['h1', 'h2'], (id) => deleted.push(id));

    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ deleted: 2, refused: 0 });
    expect(deleted).toEqual(['h1', 'h2']);
    // Two deletes and the empty select that ends the run, each its own transaction.
    expect(transactions.opened).toBe(3);
    expect(transactions.system).toBe(3);
    expect(transactions.outside).toBe(3);
  });

  it('selects a candidate the way D8 describes', async () => {
    candidates([]);
    const now = new Date('2030-01-08T00:00:00.000Z');
    await collectUnreferencedCheckpoints({ deadlineMs: farDeadline(), now });
    const { sql: text, params } = render(executeMock.mock.calls[0]![0]);
    // Never a referenced header.
    expect(text).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM backup_snapshots s WHERE s\.file_index_checkpoint_id = c\.id\s*\)/);
    // A newer header of the same lineage, in the publisher's order, or past the TTL.
    expect(text).toMatch(/\(n\.created_at, n\.id\) > \(c\.created_at, c\.id\)/);
    expect(text).toMatch(/n\.key_prefix IS NOT DISTINCT FROM c\.key_prefix/);
    expect(text).toMatch(/c\.last_referenced_at < /);
    expect(params).toContain(new Date(now.getTime() - CHECKPOINT_ORPHAN_TTL_MS).toISOString());
    // Locked from selection to delete; a header a publisher holds is passed over.
    expect(text).toMatch(/FOR UPDATE OF c SKIP LOCKED/);
  });

  it('an FK refusal is counted and the sweep continues, skipping that header for the rest of the run', async () => {
    const deleted: string[] = [];
    let selects = 0;
    executeMock.mockImplementation(async (q) => {
      if (isSelect(q)) {
        selects += 1;
        const { sql: text, params } = render(q);
        // The refused header is excluded from every later select.
        if (selects > 1) {
          expect(text).toMatch(/c\.id NOT IN/);
          expect(params).toContain('h1');
        }
        const id = selects === 1 ? 'h1' : selects === 2 ? 'h2' : undefined;
        return Object.assign(id ? [{ id }] : [], { count: id ? 1 : 0 });
      }
      const id = render(q).params[0] as string;
      if (id === 'h1') throw selects === 1 ? fkError() : new Error('unreachable');
      deleted.push(id);
      return Object.assign([], { count: 1 });
    });

    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ deleted: 1, refused: 1 });
    expect(deleted).toEqual(['h2']);
  });

  it('counts a RESTRICT refusal (23001 on Postgres 18) the same way', async () => {
    let first = true;
    executeMock.mockImplementation(async (q) => {
      if (isSelect(q)) {
        const id = first ? 'h1' : undefined;
        return Object.assign(id ? [{ id }] : [], { count: id ? 1 : 0 });
      }
      first = false;
      throw restrictError();
    });
    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ deleted: 0, refused: 1 });
  });

  it('rethrows anything that is not an FK refusal', async () => {
    executeMock.mockImplementation(async (q) => {
      if (isSelect(q)) return Object.assign([{ id: 'h1' }], { count: 1 });
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    });
    await expect(collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).rejects.toThrow(/statement timeout/);
  });

  it('stops at maxHeaders', async () => {
    candidates(['h1', 'h2', 'h3', 'h4']);
    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline(), maxHeaders: 2 })).toEqual({ deleted: 2, refused: 0 });
    expect(executeMock.mock.calls.filter(([q]) => isSelect(q))).toHaveLength(2);
  });

  it('stops at the deadline without opening a transaction', async () => {
    candidates(['h1']);
    expect(await collectUnreferencedCheckpoints({ deadlineMs: Date.now() - 1 })).toEqual({ deleted: 0, refused: 0 });
    expect(transactions.opened).toBe(0);
  });

  it('defaults to 100 headers a run', async () => {
    candidates(Array.from({ length: 150 }, (_, i) => `h${i}`));
    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ deleted: 100, refused: 0 });
  });
});
