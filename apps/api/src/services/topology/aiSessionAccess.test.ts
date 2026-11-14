import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permissions: vi.fn() }));
vi.mock('../permissions', async (original) => ({ ...await original<object>(), getUserPermissions: mocks.permissions }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { resolveTopologySessionVisibility, topologyAuditSessionCondition } from './aiSessionAccess';

const A = '20000000-0000-4000-8000-00000000000a';
const B = '20000000-0000-4000-8000-00000000000b';
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const auth = (allowedSiteIds?: string[]) => ({ user: { id: 'u' }, scope: 'organization', orgId: 'o', partnerId: null, allowedSiteIds }) as never;

beforeEach(() => vi.clearAllMocks());

describe('topology session visibility (M4-D2)', () => {
  it('shows every pinned session to an unrestricted topology reader', async () => {
    mocks.permissions.mockResolvedValue({ permissions: READ });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'all' });
  });

  it('hides every pinned session without topology:read AND devices:read, or without permissions', async () => {
    mocks.permissions.mockResolvedValue({ permissions: [{ resource: 'topology', action: 'read' }] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
    mocks.permissions.mockResolvedValue(null);
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
  });

  it('narrows to the intersection of the token and permission site ceilings', async () => {
    mocks.permissions.mockResolvedValue({ permissions: READ, allowedSiteIds: [A, B] });
    expect(await resolveTopologySessionVisibility(auth([B]))).toEqual({ kind: 'sites', siteIds: [B] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'sites', siteIds: [A, B] });
    mocks.permissions.mockResolvedValue({ permissions: READ });
    expect(await resolveTopologySessionVisibility(auth([A]))).toEqual({ kind: 'sites', siteIds: [A] });
    expect(await resolveTopologySessionVisibility(auth([]))).toEqual({ kind: 'none' });
  });

  it('accepts wildcard grants like the rest of the permission system', async () => {
    mocks.permissions.mockResolvedValue({ permissions: [{ resource: '*', action: '*' }] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'all' });
  });

  it('fails closed for pinned sessions when permissions cannot be read', async () => {
    mocks.permissions.mockRejectedValue(new Error('db down'));
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
  });
});

/**
 * M4-D2 for audit rows, failing CLOSED (#4342 W4, plan correction 9): an
 * `ai_session` audit row stays visible only when it names no session or
 * EXISTS a session this caller may see. A session that no longer exists
 * (retention hard-deleted it) can no longer be proven visible, so its row is
 * hidden; the old `NOT EXISTS (hidden session)` form showed it.
 */
describe('topologyAuditSessionCondition (fails closed)', () => {
  const render = (where: SQL) => {
    const { sql, params } = new PgDialect().sqlToQuery(where);
    return { sql: sql.replace(/\s+/g, ' '), params };
  };

  it('adds no condition for an unrestricted topology reader', () => {
    expect(topologyAuditSessionCondition({ kind: 'all' })).toBeUndefined();
  });

  it("kind 'none': a row survives only via a non-ai_session type, a NULL resource, or an EXISTING unpinned session", () => {
    const { sql, params } = render(topologyAuditSessionCondition({ kind: 'none' })!);
    expect(sql).toContain('"audit_logs"."resource_type" <> $1');
    expect(params[0]).toBe('ai_session');
    expect(sql).toContain('"audit_logs"."resource_id" is null');
    // EXISTS a VISIBLE session: a missing session (no row) hides the audit row,
    // a topology-pinned one (site not null) hides it, an unpinned one shows it.
    expect(sql).toMatch(/exists \(select 1 from "ai_sessions" where \("ai_sessions"\."id" = "audit_logs"\."resource_id" and "ai_sessions"\."topology_site_id" is null\)\)/);
    expect(sql).not.toMatch(/not exists/);
  });

  it("kind 'sites': the existing session must be unpinned or pinned to one of the caller's sites", () => {
    const { sql, params } = render(topologyAuditSessionCondition({ kind: 'sites', siteIds: [A, B] })!);
    expect(sql).toMatch(/exists \(select 1 from "ai_sessions" where \("ai_sessions"\."id" = "audit_logs"\."resource_id" and \("ai_sessions"\."topology_site_id" is null or "ai_sessions"\."topology_site_id" in \(\$\d+, \$\d+\)\)\)\)/);
    expect(sql).not.toMatch(/not exists/);
    expect(params).toEqual(expect.arrayContaining([A, B]));
  });
});
