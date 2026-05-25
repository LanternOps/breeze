import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB so we can drive cascade behavior deterministically. The
// integration test exercises the real Postgres flow.
const mockState = vi.hoisted(() => ({
  /** queued execute() responses (FIFO). Each can be either an array
   *  (matches `result.length`) or `{ rowCount }` for delete results. */
  executeResponses: [] as Array<unknown>,
  /** captured SQL strings (best-effort .toString()) for verification. */
  executedSql: [] as string[],
  /** captured fkEdges to return for topological lookup. */
  fkEdges: [] as Array<{ child_table: string; parent_table: string }>,
}));

function sqlToText(q: unknown): string {
  // Drizzle's sql template stringifies as `[object Object]`; reach into
  // `queryChunks` for the literal text fragments. Nested sql.raw()
  // chunks have their own queryChunks → recurse.
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object') {
          if ('value' in c && Array.isArray((c as { value: unknown[] }).value)) {
            return ((c as { value: string[] }).value).join('');
          }
          if ('queryChunks' in c) return sqlToText(c);
        }
        return '';
      })
      .join(' ');
  }
  return String(q);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(<T,>(fn: () => Promise<T>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    execute: vi.fn((q: unknown) => {
      const text = sqlToText(q);
      mockState.executedSql.push(text);
      // Topological query: if it asks for FK edges, return those.
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      // SET LOCAL statements don't consume the queue (they're bookkeeping
      // for the audit_logs DELETE bypass).
      if (text.includes('SET LOCAL')) {
        return Promise.resolve({ rowCount: 0 });
      }
      const next = mockState.executeResponses.shift();
      if (next === undefined) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve(next as any);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve(undefined)),
    })),
  },
}));

import {
  ORG_CASCADE_DELETE_ORDER,
  cascadeDeleteOrg,
  topologicalCascadeOrder,
  __testOnly,
} from './tenantCascade';
import { db } from '../db';

describe('ORG_CASCADE_DELETE_ORDER', () => {
  it('has every entry as a safe identifier', () => {
    for (const t of ORG_CASCADE_DELETE_ORDER) {
      expect(t).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('has no duplicates', () => {
    const set = new Set(ORG_CASCADE_DELETE_ORDER);
    expect(set.size).toBe(ORG_CASCADE_DELETE_ORDER.length);
  });

  it('places `organizations` last (it is the id-keyed root)', () => {
    expect(ORG_CASCADE_DELETE_ORDER.at(-1)).toBe('organizations');
  });

  it('includes the canonical tenant tables', () => {
    const set = new Set(ORG_CASCADE_DELETE_ORDER);
    for (const required of [
      'devices',
      'users',
      'sites',
      'alerts',
      'audit_logs',
      'agent_logs',
      'organizations',
    ]) {
      expect(set.has(required), `missing required table ${required}`).toBe(true);
    }
  });
});

describe('topologicalCascadeOrder', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.fkEdges = [];
  });

  it('returns the same set as ORG_CASCADE_DELETE_ORDER', async () => {
    mockState.fkEdges = []; // no FKs → any order is valid, default is alpha
    const order = await topologicalCascadeOrder();
    expect(new Set(order)).toEqual(new Set(ORG_CASCADE_DELETE_ORDER));
    expect(order.length).toBe(ORG_CASCADE_DELETE_ORDER.length);
  });

  it('places a child before its parent when an FK edge exists', async () => {
    // devices.user_id → users.id is contrived but illustrates the
    // direction; if it existed, devices would have to come before users.
    mockState.fkEdges = [{ child_table: 'devices', parent_table: 'users' }];
    const order = await topologicalCascadeOrder();
    const devicesIdx = order.indexOf('devices');
    const usersIdx = order.indexOf('users');
    expect(devicesIdx).toBeLessThan(usersIdx);
  });

  it('throws on FK cycles', async () => {
    mockState.fkEdges = [
      { child_table: 'devices', parent_table: 'users' },
      { child_table: 'users', parent_table: 'devices' },
    ];
    await expect(topologicalCascadeOrder()).rejects.toThrow(/cycle/i);
  });

  it('ignores edges between cascade and non-cascade tables', async () => {
    mockState.fkEdges = [
      { child_table: 'something_not_in_list', parent_table: 'users' },
      { child_table: 'devices', parent_table: 'also_not_in_list' },
    ];
    const order = await topologicalCascadeOrder();
    expect(order.length).toBe(ORG_CASCADE_DELETE_ORDER.length);
  });
});

describe('cascadeDeleteOrg', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.fkEdges = [];
    vi.mocked(db.execute).mockClear();
  });

  it('issues a DELETE for every cascade table plus the audit + cleanup SQL', async () => {
    // Default to 0 rows for every DELETE; the function should still
    // walk through every table.
    mockState.executeResponses = []; // empty queue → 0 rowCount default
    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'admin@example.com',
    );

    // tablesDeleted should contain every cascade table (plus device_commands).
    expect(Object.keys(stats.tablesDeleted)).toEqual(
      expect.arrayContaining([
        ...ORG_CASCADE_DELETE_ORDER,
        'device_commands',
      ]),
    );
    expect(stats.totalRowsDeleted).toBe(0);
    expect(stats.orgId).toBe('00000000-0000-0000-0000-000000000001');
    expect(stats.performedBy).toBe('00000000-0000-0000-0000-000000000002');
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sums rowCount across tables into totalRowsDeleted', async () => {
    // Provide a non-zero rowCount for the first few execute() calls;
    // device_commands is cleared first then the cascade walk begins.
    mockState.executeResponses = [
      { rowCount: 5 }, // device_commands
      ...Array(ORG_CASCADE_DELETE_ORDER.length).fill({ rowCount: 3 }),
    ];
    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    // 5 from device_commands + 3 per cascade table.
    expect(stats.totalRowsDeleted).toBe(5 + 3 * ORG_CASCADE_DELETE_ORDER.length);
  });

  it('tolerates a missing associated system-scoped table (42P01)', async () => {
    // Override the default mock to make ONLY the device_commands DELETE
    // throw 42P01; everything else returns 0.
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      if (text.includes('device_commands')) {
        const err: any = new Error('relation "device_commands" does not exist');
        err.code = '42P01';
        return Promise.reject(err);
      }
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(stats.totalRowsDeleted).toBe(0);
  });

  it('re-throws and aborts cascade on a non-42P01 error', async () => {
    // FK edge query returns []; the next DELETE call throws a non-42P01.
    let callIdx = 0;
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve([]);
      }
      callIdx += 1;
      if (callIdx === 2) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    await expect(
      cascadeDeleteOrg(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      ),
    ).rejects.toThrow(/DELETE from "/);
  });
});

describe('quoteIdent', () => {
  it('quotes safe identifiers', () => {
    expect(__testOnly.quoteIdent('devices')).toBe('"devices"');
    expect(__testOnly.quoteIdent('audit_logs')).toBe('"audit_logs"');
  });

  it('refuses unsafe identifiers', () => {
    expect(() => __testOnly.quoteIdent('devices; DROP TABLE users')).toThrow();
    expect(() => __testOnly.quoteIdent('"injected"')).toThrow();
    expect(() => __testOnly.quoteIdent('123_starts_with_digit')).toThrow();
  });
});
