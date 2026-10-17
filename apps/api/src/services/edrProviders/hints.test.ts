import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const executed: Array<{ sql: string; params: unknown[]; depth: number }> = [];
let depth = 0;
let results: unknown[][] = [];
const order: string[] = [];

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      executed.push({ sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params, depth });
      order.push(`db:${r.sql.trim().split(/\s+/)[0]}`);
      return results.shift() ?? [];
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    depth += 1;
    try { return await fn(); } finally { depth -= 1; }
  }),
}));

import {
  ackEdrHints, EDR_HINT_SET_CAP, EDR_HINT_TTL_SECONDS, hintMember, readEdrHints, readLastEdrHintAt, recordEdrHint,
} from './hints';

const CONN = '00000000-0000-4000-8000-0000000000c1';

function fakeRedis(initialCount = 0) {
  const set = new Set<string>();
  const kv = new Map<string, string>();
  let count = initialCount;
  const r = {
    scard: vi.fn(async () => { order.push('redis:scard'); return count + set.size; }),
    sadd: vi.fn(async (_k: string, ...m: string[]) => { order.push('redis:sadd'); m.forEach((x) => set.add(x)); return m.length; }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
    smembers: vi.fn(async () => [...set]),
    srem: vi.fn(async (_k: string, ...m: string[]) => { m.forEach((x) => set.delete(x)); return m.length; }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => kv.get(k) ?? null)),
  };
  return { r, set, kv, setCount: (n: number) => { count = n; } };
}

beforeEach(() => {
  executed.length = 0; order.length = 0; results = []; depth = 0;
});

describe('hintMember', () => {
  it('encodes tenant and tenant+detection hints; a tenantless hint has no member', () => {
    expect(hintMember({ vendorTenantId: 'c1' })).toBe('t:c1');
    expect(hintMember({ vendorTenantId: 'c1', vendorDetectionId: 'i9' })).toBe('d:c1:i9');
    expect(hintMember({ vendorDetectionId: 'i9' })).toBeNull();
  });
});

describe('recordEdrHint', () => {
  it('sets the durable marker FIRST (system context, active + push-enabled only), then the Redis set', async () => {
    results = [[{ id: CONN }]];
    const { r, set } = fakeRedis();
    expect(await recordEdrHint(CONN, [{ vendorTenantId: 'c1' }, { vendorTenantId: 'c2', vendorDetectionId: 'i1' }], r as never)).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.depth).toBe(1);
    expect(executed[0]!.sql).toMatch(/^UPDATE edr_connections SET pending_hint_at = GREATEST\(COALESCE\(pending_hint_at, now\(\)\), now\(\)\)/);
    expect(executed[0]!.sql).toMatch(/WHERE id = \$1::uuid AND is_active AND push_enabled/);
    expect(executed[0]!.params).toEqual([CONN]);
    expect(order[0]).toBe('db:UPDATE');
    expect([...set].sort()).toEqual(['d:c2:i1', 't:c1']);
    expect(r.expire).toHaveBeenCalledWith(`edr:hints:${CONN}`, EDR_HINT_TTL_SECONDS);
    expect(r.set).toHaveBeenCalledWith(`edr:hints:last:${CONN}`, expect.any(String), 'EX', expect.any(Number));
  });

  it('only ever writes edr_connections (never detections, actions or any vendor content)', async () => {
    results = [[{ id: CONN }]];
    await recordEdrHint(CONN, [{ vendorTenantId: 'c1' }], fakeRedis().r as never);
    for (const e of executed) {
      expect(e.sql).not.toMatch(/edr_detections|edr_actions|INSERT/i);
    }
  });

  it('an inactive / push-disabled connection records nothing (no Redis write)', async () => {
    results = [[]];
    const { r } = fakeRedis();
    expect(await recordEdrHint(CONN, [{ vendorTenantId: 'c1' }], r as never)).toBe(false);
    expect(r.sadd).not.toHaveBeenCalled();
    expect(r.set).not.toHaveBeenCalled();
  });

  it(`caps the set at ${EDR_HINT_SET_CAP} members`, async () => {
    results = [[{ id: CONN }]];
    const { r, set } = fakeRedis(EDR_HINT_SET_CAP - 1);
    await recordEdrHint(CONN, [{ vendorTenantId: 'a' }, { vendorTenantId: 'b' }, { vendorTenantId: 'c' }], r as never);
    expect(set.size).toBe(1);
    results = [[{ id: CONN }]];
    const full = fakeRedis(EDR_HINT_SET_CAP);
    await recordEdrHint(CONN, [{ vendorTenantId: 'a' }], full.r as never);
    expect(full.r.sadd).not.toHaveBeenCalled();
  });

  it('Redis null -> the DB marker alone is recorded', async () => {
    results = [[{ id: CONN }]];
    expect(await recordEdrHint(CONN, [{ vendorTenantId: 'c1' }], null)).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('a Redis failure is swallowed (the marker is authoritative); a DB failure throws', async () => {
    results = [[{ id: CONN }]];
    const { r } = fakeRedis();
    r.scard.mockRejectedValue(new Error('redis down'));
    await expect(recordEdrHint(CONN, [{ vendorTenantId: 'c1' }], r as never)).resolves.toBe(true);

    const { db } = await import('../../db');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('pg down'));
    await expect(recordEdrHint(CONN, [{ vendorTenantId: 'c1' }], r as never)).rejects.toThrow('pg down');
  });
});

describe('readEdrHints', () => {
  it('returns members, parsed hints and the marker as exact text; clears nothing', async () => {
    const { r, set } = fakeRedis();
    set.add('t:c1'); set.add('d:c2:i1'); set.add('garbage');
    results = [[{ marker: '2026-10-16 10:00:00.123456+00' }]];
    const snap = await readEdrHints(CONN, r as never);
    expect(snap.markerAt).toBe('2026-10-16 10:00:00.123456+00');
    expect(snap.members.sort()).toEqual(['d:c2:i1', 'garbage', 't:c1']);
    expect(snap.hints).toEqual(expect.arrayContaining([{ vendorTenantId: 'c1' }, { vendorTenantId: 'c2', vendorDetectionId: 'i1' }]));
    expect(snap.hints).toHaveLength(2);
    expect(executed[0]!.sql).toMatch(/SELECT pending_hint_at::text AS marker/);
    expect(r.srem).not.toHaveBeenCalled();
    expect(set.size).toBe(3);
  });

  it('Redis null -> the DB marker alone (still makes the run ack it)', async () => {
    results = [[{ marker: '2026-10-16 10:00:00.5+00' }]];
    expect(await readEdrHints(CONN, null)).toEqual({ members: [], hints: [], markerAt: '2026-10-16 10:00:00.5+00' });
  });
});

describe('ackEdrHints', () => {
  it('removes exactly the snapshotted members and CAS-clears only up to the snapshot marker (text compare)', async () => {
    const { r, set } = fakeRedis();
    set.add('t:c1'); set.add('t:late');
    results = [[], [{ pending: false }]];
    const out = await ackEdrHints(CONN, { members: ['t:c1'], hints: [], markerAt: '2026-10-16 10:00:00.123456+00' }, r as never);
    expect([...set]).toEqual(['t:late']);
    expect(executed[0]!.sql).toMatch(/UPDATE edr_connections SET pending_hint_at = NULL WHERE id = \$1::uuid AND pending_hint_at <= \$2::timestamptz/);
    expect(executed[0]!.params).toEqual([CONN, '2026-10-16 10:00:00.123456+00']);
    expect(out).toEqual({ stillPending: false });
  });

  it('reports stillPending when the marker advanced past the snapshot', async () => {
    results = [[], [{ pending: true }]];
    expect(await ackEdrHints(CONN, { members: [], hints: [], markerAt: '2026-10-16 10:00:00+00' }, null))
      .toEqual({ stillPending: true });
  });

  it('a null snapshot marker never clears (a hint that arrived mid-run survives) but is still reported', async () => {
    results = [[{ pending: true }]];
    expect(await ackEdrHints(CONN, { members: [], hints: [], markerAt: null }, null)).toEqual({ stillPending: true });
    expect(executed.some((e) => /SET pending_hint_at = NULL/.test(e.sql))).toBe(false);
  });
});

describe('readLastEdrHintAt', () => {
  it('reads display timestamps from Redis; null Redis or a failure -> empty map', async () => {
    const { r, kv } = fakeRedis();
    kv.set(`edr:hints:last:${CONN}`, '2026-10-16T10:00:00.000Z');
    expect([...(await readLastEdrHintAt([CONN, 'other'], r as never))]).toEqual([[CONN, '2026-10-16T10:00:00.000Z']]);
    expect((await readLastEdrHintAt([CONN], null)).size).toBe(0);
    r.mget.mockRejectedValue(new Error('down'));
    expect((await readLastEdrHintAt([CONN], r as never)).size).toBe(0);
  });
});
