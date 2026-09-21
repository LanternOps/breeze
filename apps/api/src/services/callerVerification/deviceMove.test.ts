import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { revokeWorkstationGrantsForMove } from './deviceMove';

it('uses the move transaction, ordered shared locks, original org and unused-only update', async () => {
  const execute = vi.fn().mockResolvedValueOnce([{ requester_binding_id: 'b', target_binding_id: 'a' }]).mockResolvedValue([]);
  await revokeWorkstationGrantsForMove({ execute } as never, 'org', 'device');
  const queries = execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q));
  expect(queries.map((q) => q.params)).toEqual([['org', 'device'], ['a'], ['b'], ['org', 'device']]);
  expect(queries[3]!.sql).toContain('consumed_at IS NULL');
  expect(queries[3]!.sql).toContain("method='workstation'");
  expect(queries[3]!.sql).not.toContain('SET org_id');
  expect(queries[3]!.sql).not.toContain('consumed_at=');
});

it('still issues the revocation update when no grant names a binding', async () => {
  const execute = vi.fn().mockResolvedValue([]);
  await revokeWorkstationGrantsForMove({ execute } as never, 'org', 'device');
  expect(execute).toHaveBeenCalledTimes(2);
});
