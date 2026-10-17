import { describe, expect, it, vi } from 'vitest';
import { applyGrace, observeRows, ONBOARDING_GRACE_MS, toHealthObservation, validUuids } from './observeRows';
import type { HealthVerdict } from '../../integrationStates';

const NOW = new Date('2026-10-16T12:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ORGS_READ = { resource: 'organizations', action: 'read' };
const ORGS_WRITE = { resource: 'organizations', action: 'write' };

type Row = { id: string; verdict: HealthVerdict; error?: string | null; createdAt?: Date };
const broken: HealthVerdict = { state: 'broken', severity: 'transient', condition: 'sync_failed' };
const permanent: HealthVerdict = { state: 'broken', severity: 'permanent', condition: 'reauth_required' };

const toObs = (r: Row, now: Date) => toHealthObservation({
  kind: 'huntress', verdict: r.verdict, now, createdAt: r.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  sourceId: r.id, partnerId: 'p1', orgId: null, displayName: 'Huntress', rawDetail: r.error ?? null,
  fixHref: '/integrations#huntress', viewPermission: ORGS_READ, repairPermission: ORGS_WRITE,
});

const run = (brokenRows: Row[], trackedRows: Row[], tracked: string[]) => {
  const loadTracked = vi.fn(async (_ids: string[]) => trackedRows);
  return {
    loadTracked,
    result: observeRows<Row>({
      now: NOW, trackedSourceIds: tracked,
      loadBroken: async () => brokenRows, loadTracked,
      sourceIdOf: (r) => r.id, toObservation: toObs,
    }),
  };
};

describe('observeRows', () => {
  it('reports broken rows and drops healthy untracked ones', async () => {
    const { result, loadTracked } = run([{ id: A, verdict: broken }, { id: B, verdict: { state: 'healthy' } }], [], []);
    expect((await result).map((o) => [o.sourceId, o.state])).toEqual([[A, 'broken']]);
    expect(loadTracked).not.toHaveBeenCalled();
  });

  it('reports tracked rows whatever their state and dedupes a row both queries return', async () => {
    const { result, loadTracked } = run(
      [{ id: A, verdict: broken }],
      [{ id: A, verdict: broken }, { id: B, verdict: { state: 'healthy' } }],
      [A, B, C],
    );
    expect((await result).map((o) => [o.sourceId, o.state])).toEqual([[A, 'broken'], [B, 'healthy']]);
    expect(loadTracked).toHaveBeenCalledWith([A, B, C]);
  });

  it('skips the tracked lookup when no tracked id is a uuid', async () => {
    const { result, loadTracked } = run([], [], ['not-a-uuid', '']);
    expect(await result).toEqual([]);
    expect(loadTracked).not.toHaveBeenCalled();
  });

  it('rethrows a query failure instead of returning a partial set', async () => {
    await expect(observeRows<Row>({
      now: NOW, trackedSourceIds: [A], loadBroken: async () => [],
      loadTracked: async () => { throw new Error('boom'); },
      sourceIdOf: (r) => r.id, toObservation: toObs,
    })).rejects.toThrow('boom');
  });

  it('validUuids keeps only uuids, deduplicated', () => {
    expect(validUuids([A, 'x', A, B.toUpperCase()])).toEqual([A, B.toUpperCase()]);
  });
});

describe('applyGrace (spec §1.2 onboarding grace)', () => {
  const young = new Date(NOW.getTime() - ONBOARDING_GRACE_MS + 60_000);
  const old = new Date(NOW.getTime() - ONBOARDING_GRACE_MS - 60_000);
  it('turns a transient failure on a connection under 2 hours old into unknown', () => {
    expect(applyGrace(broken, young, NOW)).toEqual({ state: 'unknown' });
    expect(applyGrace(broken, old, NOW)).toEqual(broken);
    expect(applyGrace(broken, null, NOW)).toEqual(broken);
  });
  it('never delays a permanent failure', () => {
    expect(applyGrace(permanent, young, NOW)).toEqual(permanent);
  });
  it('pins 2 hours', () => expect(ONBOARDING_GRACE_MS).toBe(7_200_000));
});

describe('toHealthObservation', () => {
  it('builds a full observation and sanitizes the provider detail only when broken', () => {
    expect(toObs({ id: A, verdict: broken, error: 'failed https://api.example.com/x?token=abc' }, NOW)).toEqual({
      sourceKind: 'huntress', sourceId: A, partnerId: 'p1', orgId: null, ownerUserId: null,
      state: 'broken', severity: 'transient', condition: 'sync_failed',
      detail: 'failed https://api.example.com', displayName: 'Huntress',
      fixHref: '/integrations#huntress', ownerFixHref: null,
      viewPermission: ORGS_READ, repairPermission: ORGS_WRITE, observedAt: NOW,
    });
    expect(toObs({ id: A, verdict: { state: 'healthy' }, error: 'stale text' }, NOW)).toMatchObject({
      state: 'healthy', detail: null,
    });
  });
  it('applies grace', () => {
    expect(toObs({ id: A, verdict: broken, createdAt: new Date(NOW.getTime() - 60_000) }, NOW).state).toBe('unknown');
  });
});
