/**
 * #8052 — the RLS session-context prologue is ONE statement that writes all
 * seven `breeze.*` GUCs.
 *
 * Every context opener (`withDbAccessContext`, `withSystemDbAccessContext`,
 * `withResolvedDbAccessContext`, `withArchivedOrgReadContext`) funnels through
 * `applyAccessContextGucs`. It used to issue six sequential `set_config`
 * round trips per transaction; it now issues one. What must NOT change:
 *
 *  - all seven GUCs are written on EVERY context, `''` for unset (so an opener
 *    that re-applies onto an ambient transaction never inherits stale values);
 *  - every write is `is_local = true` (SET LOCAL — unwinds with the tx);
 *  - the values per scope are exactly what the old six statements wrote;
 *  - the statement still starts with `select set_config('breeze.` — the
 *    #6048/#6348 wedged-backend reclaimer matches on that prefix.
 *
 * `drizzle` is faked so every statement the prologue issues is captured, then
 * rendered through the real `PgDialect` to recover SQL text + bound params.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { drizzleFactory, transactionImpl } = vi.hoisted(() => {
  const transactionImpl = vi.fn();
  const drizzleFactory = vi.fn((_client: unknown, _config?: unknown) => ({
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionImpl(fn),
  }));
  return { drizzleFactory, transactionImpl };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));

const dialect = new PgDialect();
const originalEnv = { ...process.env };

const ORG_A = '7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f';
const ORG_B = '0a6c3f2e-9d1b-4e7a-8c5f-1b2d3e4f5a6b';
const PARTNER = '3c9e1d2f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const USER = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const HIST_1 = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const HIST_2 = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a';

const GUC_NAMES = [
  'breeze.scope',
  'breeze.org_id',
  'breeze.accessible_org_ids',
  'breeze.accessible_partner_ids',
  'breeze.user_id',
  'breeze.current_partner_id',
  'breeze.report_history_org_ids',
] as const;

interface Rendered {
  sql: string;
  params: unknown[];
}

function captureTx() {
  const issued: Rendered[] = [];
  const tx = {
    execute: vi.fn((query: SQL) => {
      issued.push(dialect.sqlToQuery(query));
      return Promise.resolve([]);
    }),
  };
  transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return issued;
}

const SET_CONFIG_RE = /set_config\('([a-z_.]+)', \$(\d+), (true|false)\)/g;

/** GUC name → { value, isLocal } for one rendered statement. */
function parseGucs(statement: Rendered): Map<string, { value: unknown; isLocal: boolean }> {
  const out = new Map<string, { value: unknown; isLocal: boolean }>();
  for (const match of statement.sql.matchAll(SET_CONFIG_RE)) {
    const [, name, paramIndex, isLocal] = match;
    expect(out.has(name!), `GUC ${name} written twice in one statement`).toBe(false);
    out.set(name!, { value: statement.params[Number(paramIndex) - 1], isLocal: isLocal === 'true' });
  }
  return out;
}

/** Merge every set_config across a list of statements (order-preserving). */
function gucValues(statements: Rendered[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const statement of statements) {
    for (const [name, { value, isLocal }] of parseGucs(statement)) {
      expect(isLocal, `${name} must be written with is_local = true`).toBe(true);
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * The prologue contract: one statement, all seven GUCs, SET LOCAL, and the
 * values the old six-statement prologue wrote. The value check runs FIRST and
 * merges across statements, so on the old code it passes and only the
 * single-statement assertion fails — i.e. it pins "same values as before".
 */
function expectSinglePrologue(statements: Rendered[], expected: Record<(typeof GUC_NAMES)[number], string>) {
  expect(gucValues(statements)).toEqual(expected);
  expect(statements).toHaveLength(1);
  const [only] = statements;
  expect([...parseGucs(only!).keys()].sort()).toEqual([...GUC_NAMES].sort());
  expect(only!.sql.startsWith("select set_config('breeze.")).toBe(true);
}

async function loadDb() {
  return import('./index');
}

// `vi.resetModules()` makes every test re-import `./index` cold, which can
// exceed the 5s default on a loaded host.
describe('#8052 single-statement RLS prologue', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('system scope: one statement, "*" on both allowlists, "" for everything unset', async () => {
    const issued = captureTx();
    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'ok', 'gucTest')).resolves.toBe('ok');

    expectSinglePrologue(issued, {
      'breeze.scope': 'system',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': '*',
      'breeze.accessible_partner_ids': '*',
      'breeze.user_id': '',
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
  });

  it('organization scope: org allowlist, no partner axis, current partner for the read branch', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      { scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], currentPartnerId: PARTNER },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'organization',
      'breeze.org_id': ORG_A,
      'breeze.accessible_org_ids': ORG_A,
      'breeze.accessible_partner_ids': '',
      'breeze.user_id': '',
      'breeze.current_partner_id': PARTNER,
      'breeze.report_history_org_ids': '',
    });
  });

  it('partner scope: comma-joined org + partner allowlists', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [ORG_A, ORG_B],
        accessiblePartnerIds: [PARTNER],
        currentPartnerId: PARTNER,
      },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'partner',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': `${ORG_A},${ORG_B}`,
      'breeze.accessible_partner_ids': PARTNER,
      'breeze.user_id': '',
      'breeze.current_partner_id': PARTNER,
      'breeze.report_history_org_ids': '',
    });
  });

  it('partner scope with an EMPTY org allowlist fails closed to ""', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [PARTNER] },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'partner',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': '',
      'breeze.accessible_partner_ids': PARTNER,
      'breeze.user_id': '',
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
  });

  it('user-bearing context: writes the user id for the users self-read branch', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      {
        scope: 'organization',
        orgId: ORG_A,
        accessibleOrgIds: [ORG_A],
        userId: USER,
        currentPartnerId: PARTNER,
      },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'organization',
      'breeze.org_id': ORG_A,
      'breeze.accessible_org_ids': ORG_A,
      'breeze.accessible_partner_ids': '',
      'breeze.user_id': USER,
      'breeze.current_partner_id': PARTNER,
      'breeze.report_history_org_ids': '',
    });
  });

  it('report-history (partner scope): comma-joined report-history org ids', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [ORG_A],
        accessiblePartnerIds: [PARTNER],
        userId: USER,
        currentPartnerId: PARTNER,
        reportHistoryOrgIds: [HIST_1, HIST_2],
      },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'partner',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': ORG_A,
      'breeze.accessible_partner_ids': PARTNER,
      'breeze.user_id': USER,
      'breeze.current_partner_id': PARTNER,
      'breeze.report_history_org_ids': `${HIST_1},${HIST_2}`,
    });
  });

  it('report-history ids on a NON-partner scope are written as ""', async () => {
    const issued = captureTx();
    const { withDbAccessContext } = await loadDb();
    await withDbAccessContext(
      { scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], reportHistoryOrgIds: [HIST_1] },
      async () => 'ok',
    );

    expectSinglePrologue(issued, {
      'breeze.scope': 'organization',
      'breeze.org_id': ORG_A,
      'breeze.accessible_org_ids': ORG_A,
      'breeze.accessible_partner_ids': '',
      'breeze.user_id': '',
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
  });

  it('withResolvedDbAccessContext: one system prologue, then ONE narrowing prologue that overwrites all seven', async () => {
    const issued = captureTx();
    const { withResolvedDbAccessContext } = await loadDb();
    await withResolvedDbAccessContext(
      async () => ({
        context: { scope: 'organization' as const, orgId: ORG_A, accessibleOrgIds: [ORG_A], userId: USER },
        value: 1,
      }),
      async () => 'ok',
    );

    expect(issued).toHaveLength(2);
    expectSinglePrologue([issued[0]!], {
      'breeze.scope': 'system',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': '*',
      'breeze.accessible_partner_ids': '*',
      'breeze.user_id': '',
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
    expectSinglePrologue([issued[1]!], {
      'breeze.scope': 'organization',
      'breeze.org_id': ORG_A,
      'breeze.accessible_org_ids': ORG_A,
      'breeze.accessible_partner_ids': '',
      'breeze.user_id': USER,
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
  });

  it('withArchivedOrgReadContext: SET TRANSACTION READ ONLY, then exactly one prologue', async () => {
    const issued = captureTx();
    const { withArchivedOrgReadContext } = await loadDb();
    await withArchivedOrgReadContext([ORG_A, ORG_B], async () => 'ok');

    expect(issued).toHaveLength(2);
    expect(issued[0]!.sql).toBe('SET TRANSACTION READ ONLY');
    expectSinglePrologue([issued[1]!], {
      'breeze.scope': 'partner',
      'breeze.org_id': '',
      'breeze.accessible_org_ids': `${ORG_A},${ORG_B}`,
      'breeze.accessible_partner_ids': '',
      'breeze.user_id': '',
      'breeze.current_partner_id': '',
      'breeze.report_history_org_ids': '',
    });
  });

  it('constructs the request drizzle instance without the relational schema', async () => {
    // Relational builders are built per table on EVERY transaction/savepoint
    // when a schema is passed; nothing in production uses `db.query.*`.
    await loadDb();
    expect(drizzleFactory).toHaveBeenCalled();
    for (const [, config] of drizzleFactory.mock.calls) {
      expect((config as { schema?: unknown } | undefined)?.schema).toBeUndefined();
    }
  });
});
