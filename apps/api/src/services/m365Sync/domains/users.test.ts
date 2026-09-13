import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { inserted: [] as unknown[], setPayloads: [] as Record<string, unknown>[], updates: [] as unknown[] },
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
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { persistUsers } from './users';

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
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('does NOT write the W05 enrichment columns, on insert or on conflict', async () => {
    await persistUsers(ctx(), okResult([user()]));
    const forbidden = ['mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles', 'isAdmin', 'lastSuccessfulSignInAt'];
    for (const key of forbidden) {
      expect(dbMocks.inserted[0]).not.toHaveProperty(key);
      expect(dbMocks.setPayloads[0]).not.toHaveProperty(key);
    }
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
    expect(out.counts).toEqual({ users_total: 2, users_enabled: 1 });
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
