/**
 * PR #5695 review finding 4 — the org-scoped natural key of every upsert was
 * asserted NOWHERE. Every persister does
 * `.onConflictDoUpdate({ target: [table.orgId, table.graphId], ... })`, but
 * the sibling `*.test.ts` files mock `db.insert` and discard the `target`
 * (and `db.update`'s `where(...)`) entirely — so dropping `orgId` from a
 * conflict target, or from `markEntitiesStale`'s WHERE, would cross-tenant
 * corrupt rows (two orgs' rows sharing the same `graph_id` would upsert into
 * ONE row instead of two) with every existing test still green.
 *
 * This file does NOT mock `../../../db`: it wraps the REAL Drizzle query
 * builder (bound to the real, lazily-connecting postgres-js client — no
 * network call happens because nothing here ever awaits/executes the query,
 * only `.toSQL()`s it) so the compiled SQL is the actual statement the
 * persister would send, not a hand-written stand-in that could drift from it.
 * Same technique as claim.sql.test.ts and
 * policyEvaluationService.upsertSql.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CompiledQuery { sql: string; params: unknown[] }

const { capture } = vi.hoisted(() => ({
  capture: {
    inserts: [] as CompiledQuery[],
    updates: [] as CompiledQuery[],
  },
}));

vi.mock('../../../db', async () => {
  const actual = await vi.importActual<typeof import('../../../db')>('../../../db');
  return {
    ...actual,
    db: {
      ...actual.db,
      insert: (table: Parameters<typeof actual.db.insert>[0]) => ({
        values: (rows: unknown) => ({
          onConflictDoUpdate: (cfg: Parameters<
            ReturnType<ReturnType<typeof actual.db.insert>['values']>['onConflictDoUpdate']
          >[0]) => {
            const query = actual.db.insert(table).values(rows as never).onConflictDoUpdate(cfg);
            capture.inserts.push(query.toSQL());
            // Never awaited/executed for real — this stands in for the
            // Promise the production code awaits.
            return Promise.resolve();
          },
        }),
      }),
      update: (table: Parameters<typeof actual.db.update>[0]) => ({
        set: (payload: unknown) => ({
          where: (cond: Parameters<
            ReturnType<ReturnType<typeof actual.db.update>['set']>['where']
          >[0]) => {
            const query = actual.db.update(table).set(payload as never).where(cond);
            capture.updates.push(query.toSQL());
            return Promise.resolve();
          },
        }),
      }),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { persistUsers } from './users';
import { persistIntuneDevices } from './intuneDevices';
import { persistCaPolicies } from './caPolicies';
import { persistSkus } from './skus';
import { markEntitiesStale } from './persist';
import { m365CaPolicies, m365IntuneDevices, m365LicenseSkus, m365Users } from '../../../db/schema';

/** Pull `on conflict (...) do update set ...` apart into columns + set clause. */
function parseOnConflict(sql: string): { columns: string[]; setList: string } {
  const match = /on conflict \(([^)]*)\)\s*do update set (.*)$/is.exec(sql);
  const [, columnList, setList] = match ?? [];
  if (columnList === undefined || setList === undefined) {
    throw new Error(`compiled SQL has no ON CONFLICT ... DO UPDATE clause:\n${sql}`);
  }
  return {
    columns: columnList.split(',').map((c) => c.trim().replace(/"/g, '')),
    setList,
  };
}

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const okResult = (items: unknown[], sources: Record<string, 'ok'>) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z', sources,
});

describe('domain persisters: onConflict target is org-scoped, not JUST graph_id (compiled SQL)', () => {
  beforeEach(() => { vi.clearAllMocks(); capture.inserts = []; capture.updates = []; });

  it('persistUsers arbitrates on (org_id, graph_id)', async () => {
    await persistUsers(ctx(), okResult([{ id: 'u1' }], { users: 'ok' }));
    const { columns } = parseOnConflict(capture.inserts.at(-1)!.sql);
    expect(columns).toEqual(['org_id', 'graph_id']);
  });

  it('persistIntuneDevices arbitrates on (org_id, graph_id)', async () => {
    await persistIntuneDevices(ctx(), okResult([{ id: 'd1' }], { managedDevices: 'ok' }));
    const { columns } = parseOnConflict(capture.inserts.at(-1)!.sql);
    expect(columns).toEqual(['org_id', 'graph_id']);
  });

  it('persistCaPolicies arbitrates on (org_id, graph_id)', async () => {
    await persistCaPolicies(ctx(), okResult([{ id: 'p1', state: 'enabled' }], { policies: 'ok' }));
    const { columns } = parseOnConflict(capture.inserts.at(-1)!.sql);
    expect(columns).toEqual(['org_id', 'graph_id']);
  });

  it('persistSkus arbitrates on (org_id, graph_id)', async () => {
    await persistSkus(ctx(), okResult([{ skuId: 's1' }], { subscribedSkus: 'ok' }));
    const { columns } = parseOnConflict(capture.inserts.at(-1)!.sql);
    expect(columns).toEqual(['org_id', 'graph_id']);
  });
});

describe('markEntitiesStale: the WHERE clause actually constrains org_id (compiled SQL)', () => {
  beforeEach(() => { vi.clearAllMocks(); capture.inserts = []; capture.updates = []; });

  it.each([
    ['m365_users', m365Users],
    ['m365_intune_devices', m365IntuneDevices],
    ['m365_ca_policies', m365CaPolicies],
    ['m365_license_skus', m365LicenseSkus],
  ] as const)('%s: tombstone UPDATE is scoped to org_id, not graph_id alone', async (_name, table) => {
    await markEntitiesStale(table as never, 'org-1', ['gone-1', 'gone-2'], new Date('2026-09-08T00:00:00.000Z'));
    const compiled = capture.updates.at(-1)!;
    const where = compiled.sql.slice(compiled.sql.toLowerCase().indexOf(' where '));
    expect(where).toMatch(/"org_id"\s*=/i);
    expect(compiled.params).toContain('org-1');
    // AND graph_id (chunk) — dropping this leg would tombstone every stale
    // row in the org, not just the ones this run actually saw vanish.
    expect(where).toMatch(/"graph_id"\s+in\b/i);
  });
});
