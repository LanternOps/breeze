/**
 * #10933: `wakeMapping` must never reach BullMQ while a DB access context is
 * held. The real db module, the real instrumented queue and the real #1105
 * tripwire (in strict mode, so a violation throws) are all in play; only the
 * postgres driver and the BullMQ Queue class are faked. `drizzle` is faked so
 * the transaction's lifetime is observable: `depth` counts open transactions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory, depth, add } = vi.hoisted(() => {
  const depth = { value: 0 };
  const add = vi.fn(async (..._args: unknown[]) => ({}));
  const tx = {
    execute: () => Promise.resolve([]),
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
  return { drizzleFactory, depth, add };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = add;
    close = vi.fn(async () => {});
  },
}));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));

const originalEnv = { ...process.env };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function load() {
  const db = await import('../../db');
  const { wakeMapping } = await import('./queue');
  return { db, wakeMapping };
}

describe('wakeMapping inside a held DB context (#10933)', () => {
  beforeEach(() => {
    vi.resetModules();
    add.mockReset();
    add.mockResolvedValue({});
    depth.value = 0;
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_CONTEXT_TRIPWIRE_STRICT = '1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('enqueues only after the transaction settled, outside any context', async () => {
    const { db, wakeMapping } = await load();
    const seen: Array<{ depth: number; context: boolean }> = [];
    add.mockImplementation(async () => {
      seen.push({ depth: depth.value, context: db.hasDbAccessContext() });
      return {};
    });

    await db.withSystemDbAccessContext(async () => {
      await expect(wakeMapping('mapping', 'create')).resolves.toBeUndefined();
      await settle();
      expect(add).not.toHaveBeenCalled();
      expect(depth.value).toBe(1);
    });

    await settle();
    expect(seen).toEqual([{ depth: 0, context: false }]);
    expect(add).toHaveBeenCalledWith(
      'reconcile',
      { mappingId: 'mapping', op: 'create' },
      expect.objectContaining({ jobId: expect.stringContaining('mapping') }),
    );
  });

  // POST /alerts/:id/psa-ticket: admission commits on its own connection
  // (runOutsideDbContext + a system context), then wakes back inside the
  // request's still-open context. The wake must wait for the OUTER context.
  it('waits for the request context when the wake follows an independent inner transaction', async () => {
    const { db, wakeMapping } = await load();

    await db.withSystemDbAccessContext(async () => {
      await db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => undefined));
      await wakeMapping('mapping', 'create');
      await settle();
      expect(add).not.toHaveBeenCalled();
    });

    await settle();
    expect(add).toHaveBeenCalledTimes(1);
  });

  // Admission and resumeTicketingConnection commit on their own connection, so a
  // request rollback must not lose their wake. The worker derives
  // its operation from committed state, so a wake after a rollback is a no-op.
  it('still enqueues when the request transaction rolls back', async () => {
    const { db, wakeMapping } = await load();

    await expect(db.withSystemDbAccessContext(async () => {
      await wakeMapping('mapping', 'create');
      throw new Error('request failed');
    })).rejects.toThrow('request failed');

    await settle();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('logs a deferred enqueue failure with the mapping instead of throwing into the request', async () => {
    const { db, wakeMapping } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    add.mockRejectedValue(new Error('redis offline'));

    await db.withSystemDbAccessContext(async () => {
      await wakeMapping('mapping', 'create');
    });

    await settle();
    expect(add).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[psa-ticketing] deferred wake failed'),
      expect.objectContaining({ mappingId: 'mapping', op: 'create', message: 'redis offline' }),
    );
  });

  // BullMQ's offline queue makes add() hang rather than reject while Redis is
  // down, and nothing logs a promise that never settles.
  it('reports a deferred enqueue that never settles', async () => {
    const { db, wakeMapping } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    add.mockReturnValue(new Promise(() => {}));

    await db.withSystemDbAccessContext(async () => {
      await wakeMapping('mapping', 'create');
    });

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[psa-ticketing] deferred wake failed'),
        expect.objectContaining({ mappingId: 'mapping', message: expect.stringContaining('timed out') }),
      );
    }, { timeout: 5_000 });
  }, 10_000);

  // Worker callers run with no context: a failed enqueue must still reject so
  // the job fails and BullMQ's retry/observability see it.
  it('enqueues directly and propagates failure with no context held', async () => {
    const { wakeMapping } = await load();

    await wakeMapping('mapping', 'create');
    expect(add).toHaveBeenCalledTimes(1);

    add.mockRejectedValueOnce(new Error('redis offline'));
    await expect(wakeMapping('mapping', 'close')).rejects.toThrow('redis offline');
  });
});
