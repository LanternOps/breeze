import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { rows: [] as unknown[][], selectCalls: 0, depth: 0, maxDepthAtSelect: 0, updates: [] as unknown[] },
}));

vi.mock('../../db', () => ({
  db: {
    select: () => { dbMocks.selectCalls += 1; dbMocks.maxDepthAtSelect = dbMocks.depth;
      const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: () => chain, for: () => chain,
        then: (res: (v: unknown) => unknown) => Promise.resolve(dbMocks.rows.shift() ?? []).then(res) };
      return chain; },
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbMocks.depth += 1; try { return await fn(); } finally { dbMocks.depth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { assertStillFenced, loadSyncRunContext, releaseLease } from './run';

const JOB = {
  orgId: 'org-1', domain: 'users' as const, generation: 5,
  connectionId: 'conn-1', tenantId: 'tenant-1', consentGeneration: 2, priority: 10 as const,
};
const stateRow = (over = {}) => ({
  runGeneration: 5, intervalSeconds: 21600, continuation: null, lastCompleteSnapshotAt: null,
  lastSuccessAt: null, connectionId: 'conn-1', ...over,
});
const connRow = (over = {}) => ({
  id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2, status: 'active',
  permissionManifestVersion: 3, vaultRef: 'akv://x', credentialVersion: 'v1', ...over,
});

describe('loadSyncRunContext (Phase A, spec §5.3)', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.rows = []; dbMocks.selectCalls = 0; dbMocks.depth = 0; dbMocks.updates = []; });

  it('reads inside a SYSTEM context — a cross-org scheduler read is denied without one', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow() }], []];
    await loadSyncRunContext(JOB);
    expect(dbMocks.maxDepthAtSelect).toBeGreaterThan(0);
  });

  it('fences when the state row is gone', async () => {
    dbMocks.rows = [[]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'state_missing' });
  });

  it('fences on a generation mismatch — a late job from an expired lease must not persist', async () => {
    dbMocks.rows = [[{ ...stateRow({ runGeneration: 6 }), ...connRow() }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'generation_mismatch' });
  });

  it.each(['pending-consent', 'verifying', 'suspended', 'revoked'])(
    'fences when the connection is %s', async (status) => {
      dbMocks.rows = [[{ ...stateRow(), ...connRow({ status }) }]];
      await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'connection_not_executable' });
    });

  it('fences when the tenant was rebound between claim and run', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ tenantId: 'tenant-2' }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'tenant_changed' });
  });

  it('fences when the connection row itself was replaced', async () => {
    dbMocks.rows = [[{ ...stateRow({ connectionId: 'conn-2' }), ...connRow({ id: 'conn-2' }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'connection_changed' });
  });

  it('fences when consent was re-granted (consentGeneration moved)', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ consentGeneration: 3 }) }]];
    await expect(loadSyncRunContext(JOB)).resolves.toEqual({ fenced: 'consent_changed' });
  });

  it('returns the snapshot, the stored interval, and the existing hash map on the happy path', async () => {
    dbMocks.rows = [
      [{ ...stateRow(), ...connRow() }],
      [{ graphId: 'u1', coreHash: 'h1', isStale: false }, { graphId: 'u2', coreHash: 'h2', isStale: true }],
    ];
    const ctx = await loadSyncRunContext(JOB) as { snapshot: unknown; state: { intervalSeconds: number; lastSuccessAt: Date | null }; existing: Map<string, unknown> };
    expect(ctx.snapshot).toMatchObject({ id: 'conn-1', orgId: 'org-1', tenantId: 'tenant-1', consentGeneration: 2 });
    expect(ctx.state.intervalSeconds).toBe(21600);
    // last_success_at is what Phase B turns into `backfill` for secure_score;
    // omitting it from the SELECT would make every secure_score run a backfill.
    expect(ctx.state.lastSuccessAt).toBeNull();
    expect(ctx.existing.get('u1')).toEqual({ coreHash: 'h1', isStale: false });
    expect(ctx.existing.get('u2')).toEqual({ coreHash: 'h2', isStale: true });
  });

  it('carries a non-null last_success_at through, so a repeat run is not treated as a backfill', async () => {
    const lastSuccess = new Date('2026-09-01T00:00:00.000Z');
    dbMocks.rows = [[{ ...stateRow({ lastSuccessAt: lastSuccess }), ...connRow() }], []];
    const ctx = await loadSyncRunContext(JOB) as { state: { lastSuccessAt: Date | null } };
    expect(ctx.state.lastSuccessAt).toEqual(lastSuccess);
  });

  it('does NOT read the entity hash map when it fenced — one wasted 25k-row scan per late job', async () => {
    dbMocks.rows = [[]];
    await loadSyncRunContext(JOB);
    expect(dbMocks.selectCalls).toBe(1);
  });
});

describe('assertStillFenced (Phase C re-check)', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.rows = []; dbMocks.depth = 0; });

  it('returns null when nothing moved during the fetch', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow() }]];
    await expect(assertStillFenced(JOB)).resolves.toBeNull();
  });

  it('detects a disconnect that happened DURING the Graph fetch', async () => {
    dbMocks.rows = [[{ ...stateRow(), ...connRow({ status: 'revoked', tenantId: null }) }]];
    await expect(assertStillFenced(JOB)).resolves.toBe('connection_not_executable');
  });

  it('detects a re-claim that happened during the fetch', async () => {
    dbMocks.rows = [[{ ...stateRow({ runGeneration: 6 }), ...connRow() }]];
    await expect(assertStillFenced(JOB)).resolves.toBe('generation_mismatch');
  });
});

describe('releaseLease', () => {
  it('clears the lease without touching next_sync_at, so the row stays due', async () => {
    await releaseLease(JOB);
    expect(dbMocks.updates).toHaveLength(1);
  });
});
