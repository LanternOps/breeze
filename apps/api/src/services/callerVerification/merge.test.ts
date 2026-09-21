import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ execute: vi.fn(), insert: vi.fn() }));
vi.mock('../../db', () => ({ db: m, assertInTransaction: vi.fn() }));

import { resolveBindingMerge, finishBindingMerge, moveBindings, captureLoserContacts } from './merge';

const LOSER = '11111111-1111-4111-8111-111111111111';
const SURVIVOR = '22222222-2222-4222-8222-222222222222';
const toSql = (call: unknown[]) => new PgDialect().sqlToQuery(call[0] as never);

it('revokes both sides and preserves consumed grants', async () => {
  m.execute.mockResolvedValue([]);
  await resolveBindingMerge(LOSER, SURVIVOR);
  const first = toSql(m.execute.mock.calls[0]!).sql;
  expect(first).toContain('UNION');
  expect(first).toContain('revoked_at = now()');
  expect(first).toContain('caller_verification.binding_conflict');

  await finishBindingMerge(['33333333-3333-4333-8333-333333333333'], SURVIVOR);
  const last = toSql(m.execute.mock.calls[1]!).sql;
  expect(last).toContain('consumed_at IS NULL');
  expect(last).toContain("WHEN status='pending' THEN 'expired'");
  const survivorRevoke = toSql(m.execute.mock.calls[2]!);
  expect(survivorRevoke.sql).toContain('consumed_at IS NULL');
  expect(survivorRevoke.params).toContain(SURVIVOR);
});

it('finish is a no-op without loser contacts', async () => {
  m.execute.mockClear();
  await finishBindingMerge([], SURVIVOR);
  expect(m.execute).not.toHaveBeenCalled();
});

it('move repoints org_id only and capture reads loser contact ids', async () => {
  m.execute.mockClear();
  m.execute.mockResolvedValueOnce(Object.assign([], { count: 2 }));
  expect(await moveBindings(LOSER, SURVIVOR)).toEqual({ moved: 2, dropped: 0, notes: [] });
  const move = toSql(m.execute.mock.calls[0]!);
  expect(move.sql).toMatch(/UPDATE caller_verification_subject_bindings SET org_id/);
  expect(move.params).toEqual([SURVIVOR, LOSER]);
  m.execute.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
  expect(await captureLoserContacts(LOSER)).toEqual(['a', 'b']);
});
