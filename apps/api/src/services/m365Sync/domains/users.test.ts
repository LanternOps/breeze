import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: {
    inserted: [] as unknown[], setPayloads: [] as Record<string, unknown>[], updates: [] as unknown[],
    executed: [] as Array<{ sql: string; params: unknown[] }>,
  },
}));

vi.mock('../../../db', () => ({
  db: {
    insert: () => ({
      values: (rows: unknown[]) => {
        dbMocks.inserted.push(...rows);
        return { onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          dbMocks.setPayloads.push(cfg.set);
          return Promise.resolve();
        } };
      },
    }),
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
    execute: (query: unknown) => {
      dbMocks.executed.push(compile(query));
      return Promise.resolve([{ updated: 0 }]);
    },
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import {
  deriveIsAdmin,
  persistUsers,
  usersEnrichmentCounts,
  usersEnrichmentInsertColumns,
  usersEnrichmentUpdateSet,
  usersPrimaryProjection,
} from './users';
import { canonicalHash } from '../hash';

function compile(query: unknown): { sql: string; params: unknown[] } {
  const out = new PgDialect().sqlToQuery(query as never);
  return { sql: out.sql, params: out.params };
}

function resetDbMocks() {
  vi.clearAllMocks();
  dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; dbMocks.executed = [];
}

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const user = (over = {}) => ({
  id: 'u1', userPrincipalName: 'a@x.test', displayName: 'A', mail: 'a@x.test',
  accountEnabled: true, jobTitle: null, department: null, usageLocation: 'GB',
  onPremisesSyncEnabled: false, createdDateTime: '2020-01-01T00:00:00Z',
  assignedLicenses: ['sku-1'], mfaRegistered: true, mfaCapable: true,
  defaultMfaMethod: 'app', adminRoles: [{ roleTemplateId: 'r1', displayName: 'GA' }],
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { users: 'ok' as const, mfaRegistration: 'ok' as const, roleAssignments: 'ok' as const },
  ...over,
});

describe('persistUsers', () => {
  beforeEach(resetDbMocks);

  it('never writes last_successful_sign_in_at — that column belongs to the signin_activity domain', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.inserted[0]).not.toHaveProperty('lastSuccessfulSignInAt');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('lastSuccessfulSignInAt');
  });

  it('projects the primary columns and stamps first_seen_at only on insert', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      orgId: 'org-1', graphId: 'u1', userPrincipalName: 'a@x.test', displayName: 'A',
      accountEnabled: true, usageLocation: 'GB', onPremisesSyncEnabled: false,
      assignedSkuIds: ['sku-1'], isStale: false,
    });
    expect(dbMocks.inserted[0]).toHaveProperty('firstSeenAt');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('firstSeenAt');
  });

  it('un-tombstones on conflict: is_stale back to false and stale_since cleared', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.setPayloads[0]).toHaveProperty('isStale');
    expect(dbMocks.setPayloads[0]).toHaveProperty('staleSince');
  });

  it('writes ZERO rows on a second identical run (change-only writes, spec §5.4)', async () => {
    const first = await persistUsers(ctx(), okResult([user()]));
    const hash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = []; dbMocks.setPayloads = [];
    const second = await persistUsers(ctx([['u1', { coreHash: hash, isStale: false }]]), okResult([user()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(second.inserted + second.updated).toBe(0);
    expect(first.inserted).toBe(1);
  });

  it('the hash covers PRIMARY fields only, so enrichment churn is not a change', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const hashA = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistUsers(ctx(), okResult([user({ mfaRegistered: false, adminRoles: [] })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).toBe(hashA);
  });

  it('a primary-field change DOES move the hash', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const hashA = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistUsers(ctx(), okResult([user({ accountEnabled: false })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).not.toBe(hashA);
  });

  it('counts users_total and users_enabled in memory (spec §5.9)', async () => {
    const out = await persistUsers(ctx(), okResult([user(), user({ id: 'u2', accountEnabled: false })]));
    expect(out.counts).toMatchObject({ users_total: 2, users_enabled: 1 });
  });

  it('is complete only when the users source is ok AND the result is not truncated', async () => {
    expect((await persistUsers(ctx(), okResult([user()]))).complete).toBe(true);
    expect((await persistUsers(ctx(), okResult([user()], { truncated: true }))).complete).toBe(false);
    expect((await persistUsers(ctx(), okResult([user()], { sources: { users: 'error' } }))).complete).toBe(false);
  });

  it('does not mark stale on a truncated run, even though a row vanished', async () => {
    const out = await persistUsers(
      ctx([['gone', { coreHash: 'h', isStale: false }]]),
      okResult([user()], { truncated: true }),
    );
    expect(out.stale).toBe(0);
    expect(dbMocks.updates).toEqual([]);
  });

  it('marks a vanished row stale on a complete run', async () => {
    const out = await persistUsers(ctx([['gone', { coreHash: 'h', isStale: false }]]), okResult([user()]));
    expect(out.stale).toBe(1);
    expect(dbMocks.updates).toHaveLength(1);
  });
});

const ALL_OK = { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' } as const;

describe('users enrichment is written only from sources that succeeded (spec §5.5)', () => {
  beforeEach(resetDbMocks);

  it('writes every enrichment column when both secondary sources are ok', () => {
    expect(Object.keys(usersEnrichmentInsertColumns(user(), ALL_OK)).sort()).toEqual([
      'adminRoles', 'defaultMfaMethod', 'isAdmin', 'mfaCapable', 'mfaRegistered',
    ]);
    expect(Object.keys(usersEnrichmentUpdateSet(ALL_OK)).sort()).toEqual([
      'adminRoles', 'defaultMfaMethod', 'isAdmin', 'mfaCapable', 'mfaRegistered',
    ]);
  });

  it('omits the mfa columns entirely when the registration report did not succeed', () => {
    for (const state of ['permission_missing', 'throttled', 'error', 'unlicensed'] as const) {
      const sources = { users: 'ok', mfaRegistration: state, roleAssignments: 'ok' } as const;
      const columns = usersEnrichmentInsertColumns(user(), sources);
      expect(columns).not.toHaveProperty('mfaRegistered');
      expect(columns).not.toHaveProperty('mfaCapable');
      expect(columns).not.toHaveProperty('defaultMfaMethod');
      expect(Object.keys(usersEnrichmentUpdateSet(sources)).sort()).toEqual(['adminRoles', 'isAdmin']);
    }
  });

  it('omits admin_roles AND is_admin together when role assignments failed', () => {
    const set = usersEnrichmentUpdateSet({ users: 'ok', mfaRegistration: 'ok', roleAssignments: 'error' });
    expect(Object.keys(set).sort()).toEqual(['defaultMfaMethod', 'mfaCapable', 'mfaRegistered']);
  });

  it('stores mfa_registered NULL (never false) for a user missing from a SUCCESSFUL report', () => {
    const columns = usersEnrichmentInsertColumns(
      user({ mfaRegistered: null, mfaCapable: undefined, defaultMfaMethod: null }), ALL_OK,
    );
    expect(columns).toHaveProperty('mfaRegistered', null);
    expect(columns).toHaveProperty('mfaCapable', null);
    expect(columns).toHaveProperty('defaultMfaMethod', null);
  });

  it('coerces foreign garbage rather than letting it fail a chunk', () => {
    const columns = usersEnrichmentInsertColumns(
      user({ mfaRegistered: 'yes', defaultMfaMethod: 'x'.repeat(200), adminRoles: 'nope' }), ALL_OK,
    );
    expect(columns.mfaRegistered).toBeNull();
    expect((columns.defaultMfaMethod as string).length).toBe(64);
    expect(columns.adminRoles).toEqual([]);
    expect(columns.isAdmin).toBe(false);
  });

  it('derives is_admin from the same array that populates admin_roles', () => {
    const roles = [{ roleTemplateId: 'r1', displayName: 'Global Administrator' }];
    const columns = usersEnrichmentInsertColumns(user({ adminRoles: roles }), ALL_OK);
    expect(columns.adminRoles).toEqual(roles);
    expect(columns.isAdmin).toBe(true);
    expect(deriveIsAdmin(roles)).toBe(true);
    expect(deriveIsAdmin([])).toBe(false);
    expect(deriveIsAdmin(null)).toBe(false);
    expect(deriveIsAdmin('not-an-array')).toBe(false);
  });

  it('recomputes is_admin from excluded.admin_roles in the conflict branch', () => {
    const { sql } = compile(usersEnrichmentUpdateSet(ALL_OK).isAdmin);
    expect(sql).toContain('jsonb_array_length');
    expect(sql).toContain('excluded.admin_roles');
  });

  it('splices the enrichment into the real upsert statement, source-gated', async () => {
    await persistUsers(ctx(), okResult([user()], {
      sources: { users: 'ok', mfaRegistration: 'error', roleAssignments: 'ok' },
    }));
    expect(dbMocks.inserted[0]).not.toHaveProperty('mfaRegistered');
    expect(dbMocks.inserted[0]).toHaveProperty('adminRoles');
    expect(dbMocks.inserted[0]).toHaveProperty('isAdmin', true);
    expect(Object.keys(dbMocks.setPayloads[0]!)).not.toContain('mfaRegistered');
    expect(Object.keys(dbMocks.setPayloads[0]!)).toContain('isAdmin');
  });

  it('updates enrichment on rows whose PRIMARY fields did not change (change-only, field-wise)', async () => {
    // The primary upsert is change-only (W04), so an MFA registration that
    // changed while the user's primary fields did not would never be written
    // by the upsert alone. The enrichment pass covers exactly those rows.
    await persistUsers(ctx(), okResult([user()]));
    const hash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    resetDbMocks();

    await persistUsers(ctx([['u1', { coreHash: hash, isStale: false }]]), okResult([user({ mfaRegistered: false })]));

    expect(dbMocks.inserted).toEqual([]);
    expect(dbMocks.executed).toHaveLength(1);
    const { sql, params } = dbMocks.executed[0]!;
    expect(sql).toContain('update m365_users');
    expect(sql).toContain('is distinct from');
    expect(sql).toContain('mfa_registered');
    expect(sql).toContain('admin_roles');
    expect(params).toContain('org-1');
    expect(params).toContain('u1');
  });

  it("the enrichment pass omits a failed source's columns entirely", async () => {
    const hash = canonicalHash(usersPrimaryProjection(user()));
    await persistUsers(ctx([['u1', { coreHash: hash, isStale: false }]]), okResult([user()], {
      sources: { users: 'ok', mfaRegistration: 'permission_missing', roleAssignments: 'ok' },
    }));
    const pass = dbMocks.executed.find((q) => q.sql.includes('update m365_users'))!;
    expect(pass.sql).not.toContain('mfa_registered');
    expect(pass.sql).toContain('admin_roles');
  });

  it('issues no enrichment pass when neither secondary source succeeded', async () => {
    const hash = canonicalHash(usersPrimaryProjection(user()));
    await persistUsers(ctx([['u1', { coreHash: hash, isStale: false }]]), okResult([user()], {
      sources: { users: 'ok', mfaRegistration: 'error', roleAssignments: 'throttled' },
    }));
    expect(dbMocks.executed).toEqual([]);
  });

  it('does not re-run the enrichment pass over rows the upsert already wrote', async () => {
    await persistUsers(ctx(), okResult([user()]));
    expect(dbMocks.inserted).toHaveLength(1);
    expect(dbMocks.executed).toEqual([]);
  });
});

describe('users enrichment counters', () => {
  it('counts registered, unknown, admins, admins without mfa and admins unknown', () => {
    const admin = [{ roleTemplateId: 'r1', displayName: 'Global Administrator' }];
    expect(usersEnrichmentCounts([
      user({ id: 'u1', mfaRegistered: true, adminRoles: [] }),
      user({ id: 'u2', mfaRegistered: null, adminRoles: [] }),
      user({ id: 'u3', mfaRegistered: false, adminRoles: admin }),
      user({ id: 'u4', mfaRegistered: null, adminRoles: admin }),
      user({ id: 'u5', mfaRegistered: true, adminRoles: admin }),
    ], ALL_OK)).toEqual({
      users_mfa_registered: 2,
      users_mfa_unknown: 2,
      users_admin: 3,
      admins_without_mfa: 1,
      admins_mfa_unknown: 1,
    });
  });

  it('omits (never zeroes) the mfa counters when the report failed', () => {
    const counts = usersEnrichmentCounts([user({ mfaRegistered: null, adminRoles: [] })], {
      users: 'ok', mfaRegistration: 'error', roleAssignments: 'ok',
    });
    expect(counts).toEqual({ users_admin: 0 });
  });

  it('omits every admin counter when role assignments failed', () => {
    const counts = usersEnrichmentCounts([user()], {
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'permission_missing',
    });
    expect(Object.keys(counts).sort()).toEqual(['users_mfa_registered', 'users_mfa_unknown']);
  });

  it('persistUsers merges the enrichment counters into last_counts', async () => {
    resetDbMocks();
    const out = await persistUsers(ctx(), okResult([user()]));
    expect(out.counts).toMatchObject({ users_total: 1, users_enabled: 1, users_mfa_registered: 1, users_admin: 1 });
  });
});
