import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// The selection rules themselves are SQL and are proved against Postgres in
// __tests__/integration/backupSnapshotIndexPublish.integration.test.ts. This
// covers the loop: candidates chosen once per run, one header per
// transaction, refusals, timeouts, failures, bounds.

const { executeMock, transactions, captureException } = vi.hoisted(() => ({
  executeMock: vi.fn<(query: SQL) => Promise<unknown>>(),
  transactions: { opened: 0, system: 0, outside: 0 },
  captureException: vi.fn(),
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
vi.mock('./sentry', () => ({ captureException }));

import {
  CHECKPOINT_GC_DELETE_TIMEOUT_MS,
  CHECKPOINT_ORPHAN_TTL_MS,
  collectUnreferencedCheckpoints,
} from './backupTreeCheckpointGc';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const text = (q: SQL) => render(q).sql;
const isCandidates = (q: SQL) => /^\s*SELECT c\.id FROM backup_tree_checkpoints c/.test(text(q)) && /\bLIMIT\b/.test(text(q));
const isLock = (q: SQL) => /^\s*SELECT c\.id FROM backup_tree_checkpoints c/.test(text(q)) && /FOR UPDATE OF c SKIP LOCKED/.test(text(q));
const isTimeout = (q: SQL) => /set_config\(\s*'statement_timeout'/.test(text(q));
const isDelete = (q: SQL) => /^\s*DELETE FROM backup_tree_checkpoints/.test(text(q));
const POINTER_FK = 'backup_snapshots_file_index_checkpoint_fk';
const fkError = (constraint_name = POINTER_FK) =>
  Object.assign(new Error('update or delete violates foreign key constraint'), { code: '23503', constraint_name });
const restrictError = () => Object.assign(new Error('restrict violation'), { code: '23001', constraint_name: POINTER_FK });
const timeoutError = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const rows = <T,>(r: T[]) => Object.assign(r, { count: r.length });

/**
 * The run's candidate select answers `ids`; each header's locked re-check
 * answers it (unless `gone` lists it); each delete goes through `onDelete`,
 * which may throw.
 */
function candidates(
  ids: string[],
  opts: { onDelete?: (id: string) => void; gone?: string[] } = {},
) {
  executeMock.mockImplementation(async (q) => {
    if (isCandidates(q)) return rows(ids.slice(0, Number(render(q).params.at(-1))).map((id) => ({ id })));
    if (isLock(q)) {
      const id = render(q).params[0] as string;
      return rows(opts.gone?.includes(id) ? [] : [{ id }]);
    }
    if (isTimeout(q)) return rows([{ prior_ms: 0, applied: '60000ms' }]);
    if (isDelete(q)) {
      opts.onDelete?.(render(q).params[0] as string);
      return rows([]);
    }
    throw new Error(`unexpected statement: ${text(q)}`);
  });
}

const farDeadline = () => Date.now() + 10 * 60_000;
const zero = { deleted: 0, refused: 0, timedOut: 0, failed: 0 };

beforeEach(() => {
  executeMock.mockReset();
  captureException.mockReset();
  transactions.opened = 0;
  transactions.system = 0;
  transactions.outside = 0;
});

describe('collectUnreferencedCheckpoints', () => {
  it('selects the candidates once, then deletes one header per system-scoped transaction', async () => {
    const deleted: string[] = [];
    candidates(['h1', 'h2'], { onDelete: (id) => deleted.push(id) });

    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 2 });
    expect(deleted).toEqual(['h1', 'h2']);
    expect(executeMock.mock.calls.filter(([q]) => isCandidates(q))).toHaveLength(1);
    // The candidate select, then one transaction per header.
    expect(transactions.opened).toBe(3);
    expect(transactions.system).toBe(3);
    expect(transactions.outside).toBe(3);
  });

  it('selects candidates the way D8 describes, oldest first, bounded', async () => {
    candidates([]);
    const now = new Date('2030-01-08T00:00:00.000Z');
    await collectUnreferencedCheckpoints({ deadlineMs: farDeadline(), now, maxHeaders: 7 });
    const { sql: s, params } = render(executeMock.mock.calls[0]![0]);
    // Never a referenced header.
    expect(s).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM backup_snapshots s WHERE s\.file_index_checkpoint_id = c\.id\s*\)/);
    // A newer header of the same lineage, in the publisher's order, or past the TTL.
    expect(s).toMatch(/\(n\.created_at, n\.id\) > \(c\.created_at, c\.id\)/);
    expect(s).toMatch(/n\.key_prefix IS NOT DISTINCT FROM c\.key_prefix/);
    expect(s).toMatch(/c\.last_referenced_at < /);
    expect(params).toContain(new Date(now.getTime() - CHECKPOINT_ORPHAN_TTL_MS).toISOString());
    expect(s).toMatch(/ORDER BY c\.created_at, c\.id\s+LIMIT \$\d+/);
    expect(params.at(-1)).toBe(7);
  });

  it('re-checks each candidate under its row lock, then deletes it under a statement timeout', async () => {
    candidates(['h1']);
    const now = new Date('2030-01-08T00:00:00.000Z');
    await collectUnreferencedCheckpoints({ deadlineMs: farDeadline(), now });
    const calls = executeMock.mock.calls.map(([q]) => q);
    const lock = calls.findIndex(isLock);
    const timeout = calls.findIndex(isTimeout);
    const del = calls.findIndex(isDelete);
    expect([lock, timeout, del].every((i) => i > 0)).toBe(true);
    expect(lock).toBeLessThan(timeout);
    expect(timeout).toBeLessThan(del);
    const { sql: s, params } = render(calls[lock]!);
    // The same rules as the selection, for this header only, locked from the re-check to the delete.
    expect(s).toMatch(/WHERE c\.id = \$1::uuid/);
    expect(params[0]).toBe('h1');
    expect(s).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM backup_snapshots s WHERE s\.file_index_checkpoint_id = c\.id\s*\)/);
    expect(s).toMatch(/\(n\.created_at, n\.id\) > \(c\.created_at, c\.id\)/);
    expect(params).toContain(new Date(now.getTime() - CHECKPOINT_ORPHAN_TTL_MS).toISOString());
    expect(render(calls[timeout]!).params).toContain(CHECKPOINT_GC_DELETE_TIMEOUT_MS);
  });

  it('the delete timeout never outlasts the run\'s deadline', async () => {
    candidates(['h1']);
    await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 5_000 });
    const timeout = executeMock.mock.calls.map(([q]) => q).find(isTimeout)!;
    const bound = render(timeout).params.find((p) => typeof p === 'number') as number;
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(5_000);
  });

  it('passes over a candidate that is referenced, locked or gone by the time it is re-checked', async () => {
    const deleted: string[] = [];
    candidates(['h1', 'h2'], { gone: ['h1'], onDelete: (id) => deleted.push(id) });
    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 1 });
    expect(deleted).toEqual(['h2']);
  });

  it('an FK refusal is counted, logged with its header, and the sweep continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deleted: string[] = [];
      candidates(['h1', 'h2'], {
        onDelete: (id) => {
          if (id === 'h1') throw fkError();
          deleted.push(id);
        },
      });
      expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 1, refused: 1 });
      expect(deleted).toEqual(['h2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('h1');
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a RESTRICT refusal (23001 on Postgres 18) the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      candidates(['h1'], { onDelete: () => { throw restrictError(); } });
      expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, refused: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it('a delete that times out is skipped for the run, logged with its header, and the sweep continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deleted: string[] = [];
      candidates(['h1', 'h2'], {
        onDelete: (id) => {
          if (id === 'h1') throw timeoutError();
          deleted.push(id);
        },
      });
      expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 1, timedOut: 1 });
      expect(deleted).toEqual(['h2']);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('h1'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a header whose delete keeps failing does not stall the run: logged once with its id, reported, and the next one is deleted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deleted: string[] = [];
      candidates(['h1', 'h2'], {
        onDelete: (id) => {
          if (id === 'h1') throw Object.assign(new Error('could not extend file'), { code: '53100' });
          deleted.push(id);
        },
      });
      expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 1, failed: 1 });
      expect(deleted).toEqual(['h2']);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain('h1');
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('a foreign-key violation from any other constraint is a failure, not a refusal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      candidates(['h1'], { onDelete: () => { throw fkError('some_other_fk'); } });
      expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, failed: 1 });
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('a failing candidate select is thrown (nothing to skip)', async () => {
    executeMock.mockImplementation(async () => { throw new Error('connection terminated'); });
    await expect(collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).rejects.toThrow(/connection terminated/);
  });

  it('stops at the deadline between headers', async () => {
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const deadlineMs = now + 1_000;
      const deleted: string[] = [];
      candidates(['h1', 'h2'], { onDelete: (id) => { deleted.push(id); now = deadlineMs + 1; } });
      expect(await collectUnreferencedCheckpoints({ deadlineMs })).toEqual({ ...zero, deleted: 1 });
      expect(deleted).toEqual(['h1']);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops at the deadline without opening a transaction', async () => {
    candidates(['h1']);
    expect(await collectUnreferencedCheckpoints({ deadlineMs: Date.now() - 1 })).toEqual(zero);
    expect(transactions.opened).toBe(0);
  });

  it('defaults to 100 headers a run', async () => {
    candidates(Array.from({ length: 150 }, (_, i) => `h${i}`));
    expect(await collectUnreferencedCheckpoints({ deadlineMs: farDeadline() })).toEqual({ ...zero, deleted: 100 });
  });
});
