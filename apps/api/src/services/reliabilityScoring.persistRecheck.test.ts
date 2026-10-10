import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Chainable, awaitable query stub: every method returns the chain, awaiting yields rows.
  const chain = (rows: unknown[]): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (res: (v: unknown) => void) => res(rows) : () => chain(rows)),
    });
  return {
    chain,
    select: vi.fn(),
    insert: vi.fn(),
    setWheres: [] as unknown[],
    upserts: [] as unknown[],
    getActive: vi.fn(),
  };
});

vi.mock('../db', () => ({ db: { select: mocks.select, insert: mocks.insert } }));
vi.mock('./mlFeatureFlags', () => ({ shouldProduceMlOutput: vi.fn(async () => true) }));
vi.mock('./reliabilityBaselineQueries', async (orig) => ({
  ...(await orig<typeof import('./reliabilityBaselineQueries')>()),
  getActiveReliabilityBaseline: mocks.getActive,
}));

import { computeAndPersistDeviceReliability } from './reliabilityScoring';

const params = (q: unknown) =>
  JSON.stringify(new PgDialect().sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]).params);

const marker = (id: string) => ({
  id,
  baselineAt: new Date('2026-10-01T00:00:00Z'),
  reason: 'r',
  source: 'manual',
});

describe('computeAndPersistDeviceReliability post-write marker re-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upserts.length = 0;
    let first = true;
    mocks.select.mockImplementation(() => {
      if (first) {
        first = false;
        return mocks.chain([{ id: 'device-1', orgId: 'org-1', enrolledAt: null, deviceRole: 'workstation' }]);
      }
      return mocks.chain([]);
    });
    mocks.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: (cfg: { setWhere: unknown }) => {
          mocks.upserts.push(cfg.setWhere);
          return Promise.resolve();
        },
      }),
    }));
  });

  it('re-scores once when the active marker changes during the upsert', async () => {
    const A = marker('aaaaaaaa-0000-0000-0000-000000000001');
    const B = marker('bbbbbbbb-0000-0000-0000-000000000002');
    // pre-score read A, post-write re-check B, next pre-score B, re-check B
    mocks.getActive.mockResolvedValueOnce(A).mockResolvedValueOnce(B).mockResolvedValue(B);

    await expect(computeAndPersistDeviceReliability('device-1')).resolves.toBe(true);

    expect(mocks.upserts).toHaveLength(2);
    expect(params(mocks.upserts[0])).toContain(A.id);
    expect(params(mocks.upserts[1])).toContain(B.id);
  });

  it('persists exactly once when the marker is stable', async () => {
    const A = marker('aaaaaaaa-0000-0000-0000-000000000001');
    mocks.getActive.mockResolvedValue(A);
    await expect(computeAndPersistDeviceReliability('device-1')).resolves.toBe(true);
    expect(mocks.upserts).toHaveLength(1);
  });

  it('gives up after 3 attempts when the marker keeps changing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    mocks.getActive.mockImplementation(async () => marker(`00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`));
    await expect(computeAndPersistDeviceReliability('device-1')).resolves.toBe(true);
    expect(mocks.upserts).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('giving up after 3 attempts'), { deviceId: 'device-1' });
    warn.mockRestore();
  });
});
