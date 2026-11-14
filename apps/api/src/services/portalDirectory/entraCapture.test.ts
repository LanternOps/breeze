import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  systemDbAccessContext: () => ({ scope: 'system' }),
  withDbAccessContext: vi.fn(),
}));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn() }));
vi.mock('./runStore', () => ({
  recordRefusedRun: vi.fn(),
  recordEvaluatedRun: vi.fn(),
  afterRunCommitted: vi.fn(),
}));
vi.mock('./identityDisable', () => ({ lockPortalDirectorySource: vi.fn() }));

import type { DirectoryObservation, InScopeIdentity } from './evaluate';
import {
  M365_SYNC_MAX_ITEMS_USERS_DEFAULT,
  captureEntraDirectoryRun,
  entraSnapshotKey,
  type EntraCaptureDeps,
} from './entraCapture';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONN = '33333333-3333-4333-8333-333333333333';
const TENANT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-14T10:00:00.000Z');
const RUN_ID = '44444444-4444-4444-8444-444444444444';

function identity(subject: string, i: number): InScopeIdentity {
  return {
    identityId: `00000000-0000-4000-8000-00000000000${i}`, portalUserId: `00000000-0000-4000-8000-10000000000${i}`,
    provider: 'entra', subject, directoryChain: null, directorySeenAt: null, directoryAbsentRuns: 0,
    directoryAbsentSince: null, directoryLastRunId: null, directoryRearmSince: null,
  };
}

const CONNECTION = {
  profile: 'customer-graph-read', status: 'active', revokedAt: null as Date | null, tenantId: TENANT, consentGeneration: 4,
};

function makeDeps(over: Partial<EntraCaptureDeps> = {}) {
  const order: string[] = [];
  const deps: EntraCaptureDeps = {
    transaction: vi.fn(async (fn) => { order.push('begin'); const r = await fn(); order.push('commit'); return r; }),
    lockSource: vi.fn(async () => { order.push('lock'); }),
    readSyncState: vi.fn(async () => {
      order.push('state');
      return { connectionId: CONN, runGeneration: 7, lastCompleteSnapshotAt: NOW, lastItemCount: 120 };
    }),
    loadIdentities: vi.fn(async () => { order.push('identities'); return [identity('oid-a', 1), identity('oid-b', 2)]; }),
    readConnection: vi.fn(async () => { order.push('connection'); return { ...CONNECTION }; }),
    readProvenTenant: vi.fn(async () => { order.push('proof'); return TENANT; }),
    orgActive: vi.fn(async () => { order.push('org'); return true; }),
    readDirectoryRows: vi.fn(async () => { order.push('rows'); return []; }),
    countDirectory: vi.fn(async () => { order.push('count'); return 120; }),
    recordRefusedRun: vi.fn(async () => { order.push('refused'); }),
    recordEvaluatedRun: vi.fn(async () => {
      order.push('evaluated');
      return {
        runId: RUN_ID, orgId: ORG, source: 'entra' as const, disposition: 'reported' as const, holdReason: null,
        affected: 1, usable: 2, created: true,
      };
    }),
    afterRunCommitted: vi.fn(async () => { order.push('after'); }),
    ...over,
  };
  return { deps, order };
}

const ctx = (over: Partial<Parameters<typeof captureEntraDirectoryRun>[0]> = {}) => ({
  orgId: ORG, tenantId: TENANT, connectionId: CONN, generation: 7, now: NOW, persisted: { complete: true }, ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('captureEntraDirectoryRun (plan D4)', () => {
  it('evaluates a complete, fenced, proven run in one transaction, advisory lock first, after-commit last', async () => {
    const { deps, order } = makeDeps();
    const out = await captureEntraDirectoryRun(ctx(), deps);
    expect(out).toEqual({ recorded: true, outcome: 'evaluated', runId: RUN_ID, disposition: 'reported' });
    expect(order).toEqual([
      'begin', 'lock', 'state', 'identities', 'connection', 'proof', 'org', 'rows', 'count', 'evaluated', 'commit', 'after',
    ]);
    expect(deps.lockSource).toHaveBeenCalledWith(ORG);
    expect(deps.loadIdentities).toHaveBeenCalledWith(ORG, TENANT);
    expect(deps.readConnection).toHaveBeenCalledWith(ORG, CONN);
    expect(deps.readDirectoryRows).toHaveBeenCalledWith(ORG, ['oid-a', 'oid-b']);
    const recorded = vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1];
    expect(recorded).toMatchObject({
      orgId: ORG,
      source: 'entra',
      snapshotKey: `${CONN}:4:7`,
      snapshotAt: NOW,
      chainKey: `entra:${TENANT}:${CONN}:4:${ORG}`,
      directoryUserCount: 120,
    });
    expect(recorded.identities).toHaveLength(2);
    expect(deps.afterRunCommitted).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, created: true }));
  });

  it('a capture after a newer claim records nothing (generation fence)', async () => {
    const { deps } = makeDeps({
      readSyncState: vi.fn(async () => ({ connectionId: CONN, runGeneration: 8, lastCompleteSnapshotAt: NOW, lastItemCount: 1 })),
    });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'fenced' });
    expect(deps.loadIdentities).not.toHaveBeenCalled();
    expect(deps.recordRefusedRun).not.toHaveBeenCalled();
    expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
    expect(deps.afterRunCommitted).not.toHaveBeenCalled();
  });

  it('a complete run whose snapshot stamp is not this run\'s is fenced', async () => {
    const { deps } = makeDeps({
      readSyncState: vi.fn(async () => ({
        connectionId: CONN, runGeneration: 7, lastCompleteSnapshotAt: new Date(NOW.getTime() - 1), lastItemCount: 1,
      })),
    });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'fenced' });
  });

  it('disconnect (no state row) and a re-bound state row (another connection) are fenced', async () => {
    const gone = makeDeps({ readSyncState: vi.fn(async () => null) });
    expect(await captureEntraDirectoryRun(ctx(), gone.deps)).toEqual({ recorded: false, reason: 'fenced' });
    const rebound = makeDeps({
      readSyncState: vi.fn(async () => ({
        connectionId: '55555555-5555-4555-8555-555555555555', runGeneration: 7, lastCompleteSnapshotAt: NOW, lastItemCount: 1,
      })),
    });
    expect(await captureEntraDirectoryRun(ctx(), rebound.deps)).toEqual({ recorded: false, reason: 'fenced' });
  });

  it('no in-scope identities writes no run', async () => {
    const { deps } = makeDeps({ loadIdentities: vi.fn(async () => []) });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'no_identities' });
    expect(deps.recordRefusedRun).not.toHaveBeenCalled();
    expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
  });

  it('a truncated or malformed users run records incomplete (sync_incomplete) and acts on nobody', async () => {
    // An incomplete run never stamps last_complete_snapshot_at: the stamp is the PREVIOUS run's.
    const { deps } = makeDeps({
      readSyncState: vi.fn(async () => ({
        connectionId: CONN, runGeneration: 7, lastCompleteSnapshotAt: new Date('2026-11-13T00:00:00Z'), lastItemCount: 900,
      })),
    });
    const out = await captureEntraDirectoryRun(ctx({ persisted: { complete: false } }), deps);
    expect(out).toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });
    expect(deps.recordRefusedRun).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, source: 'entra', snapshotKey: `${CONN}:4:7`, snapshotAt: NOW, outcome: 'incomplete', reason: 'sync_incomplete',
    });
    expect(deps.readProvenTenant).not.toHaveBeenCalled();
    expect(deps.readDirectoryRows).not.toHaveBeenCalled();
    expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
    expect(deps.afterRunCommitted).not.toHaveBeenCalled();
  });

  it('above the item cap records directory_too_large', async () => {
    const { deps } = makeDeps({
      readSyncState: vi.fn(async () => ({
        connectionId: CONN, runGeneration: 7, lastCompleteSnapshotAt: null, lastItemCount: M365_SYNC_MAX_ITEMS_USERS_DEFAULT,
      })),
    });
    const out = await captureEntraDirectoryRun(ctx({ persisted: { complete: false } }), deps);
    expect(out).toEqual({ recorded: true, outcome: 'incomplete', reason: 'directory_too_large' });
  });

  it('connection tenant different from the run tenant or the proven tenant: skipped tenant_mismatch', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const conn = makeDeps({ readConnection: vi.fn(async () => ({ ...CONNECTION, tenantId: other })) });
    expect(await captureEntraDirectoryRun(ctx(), conn.deps)).toEqual({ recorded: true, outcome: 'skipped', reason: 'tenant_mismatch' });
    const proof = makeDeps({ readProvenTenant: vi.fn(async () => other) });
    expect(await captureEntraDirectoryRun(ctx(), proof.deps)).toEqual({ recorded: true, outcome: 'skipped', reason: 'tenant_mismatch' });
    expect(proof.deps.recordRefusedRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'skipped', reason: 'tenant_mismatch', snapshotKey: `${CONN}:4:7`,
    }));
    expect(proof.deps.recordEvaluatedRun).not.toHaveBeenCalled();
  });

  it('tenant ids compare case-insensitively', async () => {
    const { deps } = makeDeps({ readProvenTenant: vi.fn(async () => TENANT.toUpperCase()) });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toMatchObject({ outcome: 'evaluated' });
  });

  it('unproven tenant: skipped tenant_not_proven', async () => {
    const { deps } = makeDeps({ readProvenTenant: vi.fn(async () => null) });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: true, outcome: 'skipped', reason: 'tenant_not_proven' });
  });

  it('a degraded connection is evaluated; a revoked, inactive, missing or other-profile one is skipped', async () => {
    const degraded = makeDeps({ readConnection: vi.fn(async () => ({ ...CONNECTION, status: 'degraded' })) });
    expect(await captureEntraDirectoryRun(ctx(), degraded.deps)).toMatchObject({ outcome: 'evaluated' });
    for (const conn of [
      { ...CONNECTION, revokedAt: new Date() },
      { ...CONNECTION, status: 'needs_consent' },
      { ...CONNECTION, profile: 'customer-graph-actions' },
      null,
    ]) {
      const { deps } = makeDeps({ readConnection: vi.fn(async () => conn) });
      expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: true, outcome: 'skipped', reason: 'connection_inactive' });
      expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
    }
  });

  it('an inactive org or partner: skipped org_inactive', async () => {
    const { deps } = makeDeps({ orgActive: vi.fn(async () => false) });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: true, outcome: 'skipped', reason: 'org_inactive' });
  });

  it('re-consent of the same connection row starts a new chain (and a new snapshot key)', async () => {
    const { deps } = makeDeps({ readConnection: vi.fn(async () => ({ ...CONNECTION, consentGeneration: 5 })) });
    await captureEntraDirectoryRun(ctx(), deps);
    expect(vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1]).toMatchObject({
      chainKey: `entra:${TENANT}:${CONN}:5:${ORG}`,
      snapshotKey: `${CONN}:5:7`,
    });
  });

  it('maps the cache: present + account_enabled false ⇒ account_disabled; stale or missing ⇒ absent; null ⇒ unknown', async () => {
    const { deps } = makeDeps({
      loadIdentities: vi.fn(async () => ['A-OFF', 'on', 'unknown', 'stale', 'missing'].map((s, i) => identity(s, i))),
      readDirectoryRows: vi.fn(async () => [
        { graphId: 'a-off', isStale: false, accountEnabled: false },
        { graphId: 'on', isStale: false, accountEnabled: true },
        { graphId: 'unknown', isStale: false, accountEnabled: null },
        { graphId: 'stale', isStale: true, accountEnabled: true },
      ]),
    });
    await captureEntraDirectoryRun(ctx(), deps);
    const { observe } = vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1];
    const seen: Record<string, DirectoryObservation> = {};
    for (const s of ['A-OFF', 'on', 'unknown', 'stale', 'missing']) seen[s] = observe(s);
    expect(seen).toEqual({
      'A-OFF': { present: true, state: 'disabled', reason: 'account_disabled' },
      on: { present: true, state: 'enabled' },
      unknown: { present: true, state: 'unknown' },
      stale: { present: false },
      missing: { present: false },
    });
  });

  it('lock timeout records nothing and does not throw', async () => {
    const { deps } = makeDeps({
      lockSource: vi.fn(async () => { throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }); }),
    });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'lock_timeout' });
    expect(deps.afterRunCommitted).not.toHaveBeenCalled();
  });

  it('a lock timeout wrapped by the driver (cause chain) is still a lock timeout', async () => {
    const inner = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const { deps } = makeDeps({
      readSyncState: vi.fn(async () => { throw Object.assign(new Error('Failed query'), { cause: inner }); }),
    });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'lock_timeout' });
  });

  it('any other failure is logged without PII and swallowed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = makeDeps({
      readDirectoryRows: vi.fn(async () => { throw new Error('select ... where graph_id in (oid-a, person@example.com)'); }),
    });
    expect(await captureEntraDirectoryRun(ctx(), deps)).toEqual({ recorded: false, reason: 'error' });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('oid-a');
    expect(logged).not.toContain('example.com');
    expect(logged).toContain(ORG);
  });

  it('an after-commit throw is swallowed too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = makeDeps({ afterRunCommitted: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(captureEntraDirectoryRun(ctx(), deps)).resolves.toMatchObject({ recorded: true, outcome: 'evaluated' });
  });
});

describe('entraSnapshotKey', () => {
  it('is <connectionId>:<consentGeneration>:<generation>', () => {
    expect(entraSnapshotKey(CONN, 4, 7)).toBe(`${CONN}:4:7`);
    expect(entraSnapshotKey(CONN, null, 7)).toBe(`${CONN}:none:7`);
  });
});
