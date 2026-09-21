import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ rows: [] as { contactId: string }[], observe: vi.fn(), where: vi.fn() }));
vi.mock('../../db', () => ({
  assertInTransaction: vi.fn(),
  db: {
    execute: vi.fn(),
    select: () => ({ from: () => ({ where: (q: unknown) => { m.where(q); return { limit: async () => m.rows }; } }) }),
  },
}));
vi.mock('./subjects', () => ({ observeLogin: m.observe }));

import { observeSessionPrincipal } from './loginObservation';

const org = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const principal = { sid: 'S-1-5-21-1', username: 'alex', upn: 'alex@example.com' };

beforeEach(() => { vi.clearAllMocks(); m.rows = []; });

it.each([{ rows: [] }, { rows: [{ contactId: contact }, { contactId: org }] }])('ignores unmatched and ambiguous UPN', async ({ rows }) => {
  m.rows = rows;
  await observeSessionPrincipal(org, 'host', 'alex', principal);
  expect(m.observe).not.toHaveBeenCalled();
});

it('resolves exactly one existing binding in the authenticated org', async () => {
  m.rows = [{ contactId: contact }];
  await observeSessionPrincipal(org, 'host', 'alex', principal);
  expect(m.observe).toHaveBeenCalledWith({ orgId: org, contactId: contact, osPrincipal: principal.sid, osUsername: 'alex', upn: principal.upn });
  const query = new PgDialect().sqlToQuery(m.where.mock.calls[0]![0]);
  expect(query.sql).toContain('"org_id" =');
  expect(query.params).toContain(org);
  expect(query.sql).toContain('lower(');
});

it('derives a host-scoped principal for uid-only sessions', async () => {
  m.rows = [{ contactId: contact }];
  await observeSessionPrincipal(org, 'host', 'alex', { uid: 501, username: 'alex', upn: principal.upn });
  expect(m.observe).toHaveBeenCalledWith(expect.objectContaining({ osPrincipal: 'uid:501@host' }));
});

it('never substitutes username or inconsistent principal', async () => {
  await observeSessionPrincipal(org, 'host', 'alex', { uid: 0, username: 'alex' });
  await observeSessionPrincipal(org, 'host', 'alex', { uid: 501, username: 'mallory', upn: principal.upn });
  await observeSessionPrincipal(org, 'host', 'alex', { sid: 'S-1-5-21-1', uid: 501, username: 'alex', upn: principal.upn });
  await observeSessionPrincipal(org, 'host', 'alex', undefined);
  expect(m.observe).not.toHaveBeenCalled();
  expect(m.where).not.toHaveBeenCalled();
});
