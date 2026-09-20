import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ transaction: m.transaction }) }));
vi.mock('postgres', () => ({ default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })) }));
import { db, getCurrentDbAccessContext, withDbAccessContext } from './index';

const caller = { scope: 'organization' as const, orgId: 'org', accessibleOrgIds: ['org'], userId: 'user' };
beforeEach(() => { m.transaction.mockReset(); });

it('opens a fresh repeatable-read transaction before GUC reads and restores the outer caller on rollback', async () => {
  const outer = { execute: vi.fn(async () => []), transaction: vi.fn() };
  const inner = { execute: vi.fn(async () => []), transaction: vi.fn() };
  m.transaction.mockImplementationOnce(async (fn) => fn(outer)).mockImplementationOnce(async (fn, options) => {
    expect(options).toEqual({ isolationLevel: 'repeatable read' });
    expect(inner.execute).not.toHaveBeenCalled();
    return fn(inner);
  });
  await withDbAccessContext(caller, async () => {
    const rollback = new Error('rollback');
    await expect(withDbAccessContext(caller, async () => {
      expect(inner.execute).toHaveBeenCalled();
      expect(getCurrentDbAccessContext()).toEqual(caller);
      await db.execute('inner' as never);
      throw rollback;
    }, { isolationLevel: 'repeatable read' })).rejects.toBe(rollback);
    expect(m.transaction).toHaveBeenCalledTimes(2);
    expect(inner.execute).toHaveBeenLastCalledWith('inner');
    expect(getCurrentDbAccessContext()).toEqual(caller);
    await db.execute('outer' as never);
    expect(outer.execute).toHaveBeenLastCalledWith('outer');
    expect(outer.transaction).not.toHaveBeenCalled();
  });
  expect(getCurrentDbAccessContext()).toBeUndefined();
});

it('retains ambient permissions even if a fresh transaction is passed a wider context', async () => {
  m.transaction.mockImplementation(async (fn) => fn({ execute: vi.fn(async () => []) }));
  await withDbAccessContext(caller, async () => {
    await withDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null }, async () => {
      expect(getCurrentDbAccessContext()).toEqual(caller);
    }, { isolationLevel: 'repeatable read' });
  });
  expect(m.transaction).toHaveBeenCalledTimes(2);
});
