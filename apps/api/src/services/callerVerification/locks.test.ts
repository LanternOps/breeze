import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withSubjectLocks, type Tx } from './locks';

it('deduplicates and orders both identities before work', async () => {
  const execute = vi.fn().mockResolvedValue([]);
  const work = vi.fn().mockResolvedValue(42);
  expect(await withSubjectLocks({ execute } as unknown as Tx, ['b', null, 'a', 'b'], work)).toBe(42);
  expect(execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q).params)).toEqual([['a'], ['b']]);
  expect(work.mock.invocationCallOrder[0]).toBeGreaterThan(execute.mock.invocationCallOrder[1]!);
});

it('runs work immediately when there is nothing to lock', async () => {
  const execute = vi.fn();
  expect(await withSubjectLocks({ execute } as unknown as Tx, [null, null], async () => 'ok')).toBe('ok');
  expect(execute).not.toHaveBeenCalled();
});
