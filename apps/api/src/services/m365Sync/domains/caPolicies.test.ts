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

import { persistCaPolicies } from './caPolicies';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const policy = (over = {}) => ({
  id: 'p1', displayName: 'Require MFA', state: 'enabled',
  createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-01-01T00:00:00Z',
  conditions: { users: { includeUsers: ['All'] } },
  grantControls: { builtInControls: ['mfa'] },
  sessionControls: null,
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { policies: 'ok' as const }, ...over,
});

describe('persistCaPolicies', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('a RENAME does not move definition_hash (spec §3.2)', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ displayName: 'Require MFA (renamed)' })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).toBe(before);
  });

  it('DISABLING does move definition_hash — state is inside it', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ state: 'disabled' })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).not.toBe(before);
  });

  it('a grant-control change moves definition_hash', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const before = (dbMocks.inserted[0] as { definitionHash: string }).definitionHash;
    dbMocks.inserted = [];
    await persistCaPolicies(ctx(), okResult([policy({ grantControls: { builtInControls: ['block'] } })]));
    expect((dbMocks.inserted[0] as { definitionHash: string }).definitionHash).not.toBe(before);
  });

  it('a rename IS a core change, so the row is still rewritten', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistCaPolicies(
      ctx([['p1', { coreHash, isStale: false }]]),
      okResult([policy({ displayName: 'Renamed' })]),
    );
    expect(out.updated).toBe(1);
    expect(dbMocks.inserted).toHaveLength(1);
  });

  it('counts by state under the ROLLUP column names, mapping enabledForReportingButNotEnforced to report-only', async () => {
    const out = await persistCaPolicies(ctx(), okResult([
      policy({ id: 'a', state: 'enabled' }),
      policy({ id: 'b', state: 'disabled' }),
      policy({ id: 'c', state: 'enabledForReportingButNotEnforced' }),
      policy({ id: 'd', state: 'enabled' }),
      policy({ id: 'e', state: null }),
    ]));
    // EXACTLY the three m365_posture_rollups column names, nothing else:
    // last_counts is read straight into the rollup by key, so a key with no
    // column (a `ca_policies_total`, say) is silently dropped there and reads
    // as an invented counter here.
    expect(out.counts).toEqual({
      ca_policies_enabled: 2, ca_policies_report_only: 1, ca_policies_disabled: 1,
    });
  });

  it('stores the three control objects as jsonb, defaulting a missing one to null not {}', async () => {
    await persistCaPolicies(ctx(), okResult([policy({ sessionControls: undefined })]));
    expect(dbMocks.inserted[0]).toMatchObject({ sessionControls: null });
    expect(dbMocks.inserted[0]).toHaveProperty('conditions');
    expect(dbMocks.inserted[0]).toHaveProperty('grantControls');
  });

  it('is complete only when policies returned ok and nothing truncated', async () => {
    expect((await persistCaPolicies(ctx(), okResult([policy()]))).complete).toBe(true);
    expect((await persistCaPolicies(ctx(), okResult([policy()], { truncated: true }))).complete).toBe(false);
  });

  it('writes nothing on an identical second run', async () => {
    await persistCaPolicies(ctx(), okResult([policy()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistCaPolicies(ctx([['p1', { coreHash, isStale: false }]]), okResult([policy()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });
});
