import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({ execute: vi.fn(), grants: vi.fn() }));
vi.mock('../../db', () => ({
  db: { execute: h.execute },
  assertInTransaction: vi.fn(),
}));
vi.mock('../roleInheritance', () => ({ getRolesPermissionGrants: h.grants }));
vi.mock('../ticketService', () => ({ addCallerVerificationSystemComment: vi.fn() }));
vi.mock('../auditRequestTracking', () => ({ markRequestAuditWritten: vi.fn() }));

import { securityRecipients } from './effects';

const ORG = '11111111-1111-4111-8111-111111111111';
type Grant = { resource: string; action: string };

function candidates(rows: Array<{ id: string; email: string; role_id: string }>, grants: Record<string, Grant[]>) {
  h.execute.mockResolvedValueOnce(rows);
  h.grants.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, grants[id] ?? []])));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.execute.mockResolvedValue([]);
  h.grants.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, []])));
});

describe('securityRecipients', () => {
  it('includes a member whose role holds alerts:read only through inheritance (#11702)', async () => {
    candidates(
      [{ id: 'u-child', email: 'child@x', role_id: 'r-child' }, { id: 'u-bare', email: 'bare@x', role_id: 'r-bare' }],
      { 'r-child': [{ resource: 'alerts', action: 'read' }], 'r-bare': [{ resource: 'tickets', action: 'read' }] },
    );
    await expect(securityRecipients(ORG)).resolves.toEqual([{ id: 'u-child', email: 'child@x' }]);
    expect(h.grants).toHaveBeenCalledTimes(1);
    expect([...h.grants.mock.calls[0]![0]].sort()).toEqual(['r-bare', 'r-child']);
  });

  it('is wildcard-aware on either axis', async () => {
    candidates(
      [
        { id: 'u1', email: '1@x', role_id: 'ra' }, { id: 'u2', email: '2@x', role_id: 'rb' },
        { id: 'u3', email: '3@x', role_id: 'rc' }, { id: 'u4', email: '4@x', role_id: 'rd' },
      ],
      {
        ra: [{ resource: '*', action: '*' }], rb: [{ resource: 'alerts', action: '*' }],
        rc: [{ resource: '*', action: 'read' }], rd: [{ resource: 'alerts', action: 'write' }],
      },
    );
    expect((await securityRecipients(ORG)).map((r) => r.id)).toEqual(['u1', 'u2', 'u3']);
  });

  it('returns each user once even when several memberships qualify', async () => {
    candidates(
      [{ id: 'u1', email: '1@x', role_id: 'ra' }, { id: 'u1', email: '1@x', role_id: 'rb' }],
      { ra: [{ resource: 'alerts', action: 'read' }], rb: [{ resource: 'alerts', action: 'read' }] },
    );
    expect(await securityRecipients(ORG)).toEqual([{ id: 'u1', email: '1@x' }]);
  });

  it('a user with one non-granting and one granting membership is included', async () => {
    candidates(
      [{ id: 'u1', email: '1@x', role_id: 'ra' }, { id: 'u1', email: '1@x', role_id: 'rb' }],
      { rb: [{ resource: 'alerts', action: 'read' }] },
    );
    expect(await securityRecipients(ORG)).toEqual([{ id: 'u1', email: '1@x' }]);
  });

  it('returns [] and skips the resolver when there are no candidate members', async () => {
    await expect(securityRecipients(ORG)).resolves.toEqual([]);
    expect(h.grants).not.toHaveBeenCalled();
  });

  it('keeps the membership rules: active users, unrestricted org members, partner all/selected-covering-org', async () => {
    await securityRecipients(ORG);
    const q = new PgDialect().sqlToQuery(h.execute.mock.calls[0]![0] as SQL);
    expect(q.sql).toContain(`u.status = 'active'`);
    expect(q.sql).toContain('ou.site_ids IS NULL');
    expect(q.sql).toContain(`pu.org_access = 'all'`);
    expect(q.sql).toContain(`pu.org_access = 'selected' AND o.id = ANY(pu.org_ids)`);
    expect(q.sql).not.toContain('role_permissions');
    expect(q.params).toContain(ORG);
  });
});
