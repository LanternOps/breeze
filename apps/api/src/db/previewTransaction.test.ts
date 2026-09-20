import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ transaction: m.transaction }) }));
vi.mock('postgres', () => ({ default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })) }));
import { db, getCurrentDbAccessContext, withDbAccessContext } from './index';

const caller = { scope: 'organization' as const, orgId: 'org', accessibleOrgIds: ['org'], userId: 'user' };
beforeEach(() => { m.transaction.mockReset(); });

/**
 * An isolation level cannot be applied to an already-started transaction
 * (Postgres forbids SET TRANSACTION after the first query, and Drizzle's nested
 * transactions are savepoints that ignore isolation options), so it always
 * opens a NEW top-level transaction on a NEW pooled connection. The caller must
 * therefore hold no context of its own — a self-managed route, or a worker —
 * otherwise every such request holds one connection while waiting for a second
 * and the pool stalls at concurrency >= pool size (#1105, #2417).
 */
it('opens a top-level isolated transaction for a caller that holds no context', async () => {
  const inner = { execute: vi.fn(async () => []), transaction: vi.fn() };
  m.transaction.mockImplementationOnce(async (fn, options) => {
    expect(options).toEqual({ isolationLevel: 'repeatable read' });
    return fn(inner);
  });
  await withDbAccessContext(caller, async () => {
    expect(getCurrentDbAccessContext()).toEqual(caller);
    await db.execute('inner' as never);
  }, { isolationLevel: 'repeatable read' });
  expect(m.transaction).toHaveBeenCalledTimes(1);
  expect(inner.execute).toHaveBeenLastCalledWith('inner');
  expect(getCurrentDbAccessContext()).toBeUndefined();
});

it('propagates a rollback and leaves no context behind', async () => {
  const inner = { execute: vi.fn(async () => []), transaction: vi.fn() };
  m.transaction.mockImplementationOnce(async (fn) => fn(inner));
  const rollback = new Error('rollback');
  await expect(withDbAccessContext(caller, async () => { throw rollback; }, { isolationLevel: 'serializable' }))
    .rejects.toBe(rollback);
  expect(getCurrentDbAccessContext()).toBeUndefined();
});

it('refuses to open a second connection while a context is already held', async () => {
  m.transaction.mockImplementation(async (fn) => fn({ execute: vi.fn(async () => []) }));
  await withDbAccessContext(caller, async () => {
    await expect(withDbAccessContext(caller, async () => 'never',
      { isolationLevel: 'repeatable read' })).rejects.toThrow(/SELF_MANAGED_DB_CONTEXT_ROUTES/);
  });
  // Control: only the OUTER transaction was ever opened.
  expect(m.transaction).toHaveBeenCalledTimes(1);
});

it('a nested call without an isolation level still reuses the held context', async () => {
  m.transaction.mockImplementation(async (fn) => fn({ execute: vi.fn(async () => []) }));
  let ran = false;
  await withDbAccessContext(caller, async () => {
    await withDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null } as never, async () => {
      // The ambient caller's permissions are kept; a nested call cannot widen them.
      expect(getCurrentDbAccessContext()).toEqual(caller);
      ran = true;
    });
  });
  expect(ran).toBe(true);
  expect(m.transaction).toHaveBeenCalledTimes(1);
});
