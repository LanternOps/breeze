/**
 * Work deferred with `runAfterDbContextExit` must never run while the context's
 * transaction still holds its pooled connection. Queue/Redis round trips made
 * inside a held transaction keep the connection idle-in-transaction for as
 * long as Redis takes, and a stalled Redis stalls the request with it.
 *
 * `drizzle` is faked so the transaction's lifetime is observable: `depth` is 1
 * exactly while a transaction callback is running (and until it settles).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory, depth } = vi.hoisted(() => {
  const depth = { value: 0 };
  const tx = {
    execute: () => Promise.resolve([]),
    // Savepoints (withDbTransaction) run on the same connection.
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const drizzleFactory = vi.fn(() => ({
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      depth.value += 1;
      try {
        return await fn(tx);
      } finally {
        depth.value -= 1;
      }
    },
  }));
  return { drizzleFactory, depth };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));

const originalEnv = { ...process.env };

async function loadDb() {
  return import('./index');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('runAfterDbContextExit', () => {
  beforeEach(() => {
    vi.resetModules();
    depth.value = 0;
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('runs deferred work only after the outermost transaction has settled, outside any context', async () => {
    const db = await loadDb();
    const seen: Array<{ depth: number; context: boolean }> = [];
    const task = vi.fn(async () => {
      seen.push({ depth: depth.value, context: db.hasDbAccessContext() });
    });

    await db.withSystemDbAccessContext(async () => {
      // A joined inner context and a savepoint both defer to the outermost exit.
      await db.withDbAccessContext({ scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'] }, async () => {
        await db.withDbTransaction(async () => {
          db.runAfterDbContextExit('test.deferred', task);
        });
      });
      await settle();
      expect(task).not.toHaveBeenCalled();
      expect(depth.value).toBe(1);
    }, 'afterContextExit.test');

    await settle();
    expect(task).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ depth: 0, context: false }]);
  });

  it('still runs after a context whose work failed, and the caller sees the original error', async () => {
    const db = await loadDb();
    const task = vi.fn(async () => undefined);
    const failure = new Error('statement failed');
    await expect(
      db.withSystemDbAccessContext(async () => {
        db.runAfterDbContextExit('test.deferred', task);
        throw failure;
      }),
    ).rejects.toBe(failure);
    await settle();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('never delays the caller and never surfaces a failure of the deferred work', async () => {
    const db = await loadDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hung = vi.fn(() => new Promise<void>(() => {}));
    const failing = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    await expect(
      db.withSystemDbAccessContext(async () => {
        db.runAfterDbContextExit('test.hung', hung);
        db.runAfterDbContextExit('test.failing', failing);
        return 'done';
      }),
    ).resolves.toBe('done');
    await settle();
    expect(hung).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('test.failing'),
      expect.objectContaining({ error: 'queue unavailable' }),
    );
  });

  it('runs promptly, outside any context, when no context is held', async () => {
    const db = await loadDb();
    const seen: boolean[] = [];
    db.runAfterDbContextExit('test.immediate', async () => {
      seen.push(db.hasDbAccessContext());
    });
    await settle();
    expect(seen).toEqual([false]);
  });
});
