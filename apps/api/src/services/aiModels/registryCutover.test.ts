import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rows: new Set<string>(),
  pending: [] as string[],
  lease: { owner: null as string | null, expired: true },
  completedAt: null as Date | null,
  reconcile: vi.fn(),
  disable: vi.fn(),
  capture: vi.fn(),
  order: [] as string[],
}));
// A tiny in-memory stand-in for the two tables; registryCutover.ts reaches them only
// through the helpers below, which it imports from './registryCutoverStore'.
vi.mock('./registryCutoverStore', () => ({
  withPartnerCutoverTx: async (partnerId: string, fn: (exists: boolean) => Promise<void>) => {
    const exists = m.rows.has(partnerId);
    await fn(exists);   // a throw here aborts the "transaction": no row
    if (!exists) m.rows.add(partnerId);
  },
  hasCutoverRow: async (id: string) => m.rows.has(id),
  takeLease: async (owner: string) => {
    if (m.completedAt) return 'complete';
    if (m.lease.owner && m.lease.owner !== owner && !m.lease.expired) return 'held';
    m.lease = { owner, expired: false };
    return 'taken';
  },
  renewLease: async (owner: string) => m.lease.owner === owner,
  nextUncutPartners: async (after: string | null, limit: number) =>
    m.pending.filter((p) => !m.rows.has(p) && (after === null || p > after)).slice(0, limit),
  markComplete: async (owner: string) => {
    if (m.lease.owner !== owner) return false;
    m.completedAt ??= new Date(); m.lease = { owner: null, expired: true };
    return true;
  },
  releaseLease: async (owner: string) => { if (m.lease.owner === owner) m.lease = { owner: null, expired: true }; },
  disableUnproducedOfferings: m.disable,
}));
vi.mock('../sentry', () => ({ captureException: m.capture }));
vi.mock('./legacyReconcile', () => ({ reconcilePartnerFromLegacyInTx: m.reconcile }));

import {
  __resetRegistryCutoverMemoForTests, cutoverPartner, ensurePartnerCutover, isPartnerCutOver, runRegistryCutoverSweep,
} from './registryCutover';

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Set(); m.pending = []; m.lease = { owner: null, expired: true }; m.completedAt = null; m.order = [];
  m.reconcile.mockImplementation(async (id: string) => { m.order.push(`reconcile:${id}`); return { producedOfferingIds: [`${id}-o1`] }; });
  m.disable.mockImplementation(async (id: string) => { m.order.push(`disable:${id}`); return 0; });
  __resetRegistryCutoverMemoForTests();
});

describe('cutoverPartner', () => {
  it('reconciles a partner exactly once, ever', async () => {
    expect(await cutoverPartner('p1')).toBe('done');
    expect(await cutoverPartner('p1')).toBe('already');
    expect(m.reconcile).toHaveBeenCalledTimes(1);
  });

  it('disables offerings the projection did not produce, after the projection, in the same transaction', async () => {
    await cutoverPartner('p1');
    expect(m.order).toEqual(['reconcile:p1', 'disable:p1']);
    expect(m.disable).toHaveBeenCalledWith('p1', ['p1-o1']);
  });

  it('a failed stale-offering disable leaves the partner un-rowed (the cutover rolls back as a whole)', async () => {
    m.disable.mockRejectedValueOnce(new Error('disable failed'));
    await expect(cutoverPartner('p1')).rejects.toThrow('disable failed');
    expect(m.rows.has('p1')).toBe(false);
  });

  it('an already cut-over partner is neither re-projected nor touched', async () => {
    m.rows.add('p1');
    expect(await cutoverPartner('p1')).toBe('already');
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.disable).not.toHaveBeenCalled();
  });
});

describe('ensurePartnerCutover (the resolver gate)', () => {
  it('cuts an un-reconciled partner over on demand, then serves from memo', async () => {
    expect(await ensurePartnerCutover('p1')).toBe(true);
    expect(await ensurePartnerCutover('p1')).toBe(true);
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    expect(await isPartnerCutOver('p1')).toBe(true);
  });

  it('a failing reconcile refuses (never routes on a stale registry) and is retried next time', async () => {
    m.reconcile.mockRejectedValueOnce(new Error('boom'));
    expect(await ensurePartnerCutover('p1')).toBe(false);
    expect(await isPartnerCutOver('p1')).toBe(false);
    expect(await ensurePartnerCutover('p1')).toBe(true);
  });

  it('a query-bearing failure reaches Sentry scrubbed: no SQL params', async () => {
    const drizzle = Object.assign(new Error('Failed query: insert into x\nparams: sk-secret-ciphertext'), {
      params: ['sk-secret-ciphertext'],
      cause: Object.assign(new Error('duplicate key value violates unique constraint "x_pk"'), { code: '23505', constraint_name: 'x_pk' }),
    });
    m.reconcile.mockRejectedValueOnce(drizzle);
    expect(await ensurePartnerCutover('p1')).toBe(false);
    expect(m.capture).toHaveBeenCalledTimes(1);
    const [reported, , tags] = m.capture.mock.calls[0]!;
    expect(reported).not.toBe(drizzle);
    expect(String((reported as Error).message)).not.toContain('sk-secret-ciphertext');
    expect(String((reported as Error).message)).toContain('23505');
    expect(tags).toMatchObject({ area: 'ai_model_registry_cutover', partnerId: 'p1' });
  });
});

describe('runRegistryCutoverSweep', () => {
  it('a second concurrent sweep is not the coordinator', async () => {
    m.pending = ['a', 'b'];
    m.lease = { owner: 'other', expired: false };
    expect((await runRegistryCutoverSweep({ owner: 'me' })).outcome).toBe('not_coordinator');
    expect(m.reconcile).not.toHaveBeenCalled();
  });

  it('processes every un-cut partner, completes monotonically, and a later run is a no-op', async () => {
    m.pending = ['a', 'b', 'c'];
    m.rows.add('b');                                   // cut over on demand earlier
    const first = await runRegistryCutoverSweep({ owner: 'me', batch: 2 });
    expect(first).toMatchObject({ outcome: 'complete', processed: 2, failed: [] });
    const completedAt = m.completedAt;
    expect((await runRegistryCutoverSweep({ owner: 'me' })).outcome).toBe('complete');
    expect(m.completedAt).toBe(completedAt);
    expect(m.reconcile).toHaveBeenCalledTimes(2);
  });

  it('a failure leaves completion unset and the partner un-rowed for retry, and releases the lease', async () => {
    m.pending = ['a', 'b'];
    m.reconcile.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('x'); return { producedOfferingIds: [] }; });
    expect(await runRegistryCutoverSweep({ owner: 'me' })).toMatchObject({ outcome: 'incomplete', failed: ['b'] });
    expect(m.completedAt).toBeNull();
    expect(m.rows.has('b')).toBe(false);
    expect(m.lease.owner).toBeNull();
  });

  it('stops as soon as the lease is lost', async () => {
    m.pending = ['a', 'b', 'c'];
    m.reconcile.mockImplementation(async (id: string) => {
      if (id === 'a') m.lease = { owner: 'thief', expired: false };
      return { producedOfferingIds: [] };
    });
    expect(await runRegistryCutoverSweep({ owner: 'me' })).toMatchObject({ outcome: 'not_coordinator', processed: 1 });
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    expect(m.completedAt).toBeNull();
  });
});
