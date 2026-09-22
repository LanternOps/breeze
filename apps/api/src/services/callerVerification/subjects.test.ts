import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) },
  assertInTransaction: vi.fn(),
}));

import { resolveTargetBinding } from './subjects';

it.each([0, 2])('fails closed for %s active matches', async (n) => {
  m.rows = Array.from({ length: n }, () => ({ id: '11111111-1111-4111-8111-111111111111' }));
  await expect(resolveTargetBinding('22222222-2222-4222-8222-222222222222', { entraTenantId: 'tenant', entraOid: 'oid' }))
    .rejects.toMatchObject({ payload: { reason: n ? 'subject_ambiguous' : 'subject_unmatched', contactId: null } });
});

it('returns the single active binding', async () => {
  m.rows = [{ id: '11111111-1111-4111-8111-111111111111', contactId: 'c' }];
  expect(await resolveTargetBinding('22222222-2222-4222-8222-222222222222', { entraTenantId: 'tenant', entraOid: 'oid' }))
    .toMatchObject({ contactId: 'c' });
});
