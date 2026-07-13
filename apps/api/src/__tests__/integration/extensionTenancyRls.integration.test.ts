import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
import { getTestDb } from './setup';
import {
  assertExtensionTenancyRls,
  assertNoUnaccountedPublicTables,
  coreTableNames,
} from '../../extensions/tenancyTripwire';

/**
 * Real-DB contract test for the extension RLS tripwire (#2424).
 *
 * WHY THIS FILE EXISTS: the unit tests in `extensions/loader.test.ts` mock
 * `db.execute`, so they assert the *verdict logic* but prove nothing about the
 * catalog query itself. That gap already bit once — the first cut of this
 * assertion embedded the table list as `= ANY(${tables})`, which drizzle
 * expands into a TUPLE (`= ANY(($1, $2, ...))`) that Postgres rejects outright.
 * Every mocked test passed while the real query would have crashed the boot
 * with a SQL syntax error instead of an RLS verdict — a tripwire that only
 * ever fired the wrong alarm.
 *
 * So this suite runs `assertExtensionTenancyRls` against REAL Postgres, over
 * fixture tables that reproduce each failure mode. It is the only thing that
 * can prove the tripwire actually reads the catalog and actually distinguishes
 * a compliant extension table from a non-compliant one.
 */

/**
 * NOTE — these fixtures deliberately have NO `org_id` column. Do not add one.
 *
 * `rls-coverage.integration.test.ts` auto-discovers org-tenant tables purely by
 * `column_name = 'org_id'` and then asserts RLS enabled + forced + policies.
 * It runs against the SAME CI database as this suite. Three of these fixtures
 * are intentionally RLS-broken, so giving them an `org_id` would make a leaked
 * fixture (hook timeout, worker crash, cancelled run — anything that skips
 * `afterAll`) look exactly like a real cross-tenant breach to the repo's
 * highest-signal alarm, and `cleanupDatabase`'s TRUNCATE hand-list would never
 * DROP an unknown table, so it would keep failing on unrelated PRs.
 *
 * The column buys the test nothing — `assertExtensionTenancyRls` reads only
 * `pg_class` / `pg_policies` and never inspects columns.
 */
const FIXTURES = [
  'ext_rls_good',
  'ext_rls_notforced',
  'ext_rls_nopolicy',
  'ext_rls_bare',
  // #2466 — catalog-derived ownership. Each of these belongs to a DIFFERENT
  // fake extension name so that one test's undeclared table can't leak into
  // another's prefix scan (ownership is `<extensionName>_`, so `extundeclared_`
  // and `extglobal_` never cross-match).
  'extundeclared_docs',
  'extglobal_lookup',
  'extliar_docs',
  // Carries a real FK into `organizations` but NO column named org_id — the
  // rename-the-column bypass that a name-only check cannot see.
  'extfk_docs',
] as const;

/** Materialized views need their own DROP — `DROP TABLE` will not touch them. */
const MATVIEW_FIXTURES = ['extmv_all'] as const;

async function dropFixtures() {
  const db = getTestDb();
  // Matviews first — they depend on the tables below.
  await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MATVIEW_FIXTURES.join(', ')} CASCADE`));
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${FIXTURES.join(', ')} CASCADE`));
}

beforeAll(async () => {
  const db = getTestDb();
  await dropFixtures();
  // Fully compliant: RLS enabled + forced + a policy.
  await db.execute(sql.raw(`
    CREATE TABLE ext_rls_good (id uuid PRIMARY KEY);
    ALTER TABLE ext_rls_good ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ext_rls_good FORCE ROW LEVEL SECURITY;
    CREATE POLICY ext_rls_good_p ON ext_rls_good FOR ALL USING (true);
  `));
  // Enabled but NOT forced — the table owner would bypass RLS.
  await db.execute(sql.raw(`
    CREATE TABLE ext_rls_notforced (id uuid PRIMARY KEY);
    ALTER TABLE ext_rls_notforced ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ext_rls_notforced_p ON ext_rls_notforced FOR ALL USING (true);
  `));
  // Enabled + forced but zero policies — deny-all, which is a misconfiguration
  // we still want surfaced loudly rather than silently shipping a dead table.
  await db.execute(sql.raw(`
    CREATE TABLE ext_rls_nopolicy (id uuid PRIMARY KEY);
    ALTER TABLE ext_rls_nopolicy ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ext_rls_nopolicy FORCE ROW LEVEL SECURITY;
  `));
  // No RLS at all — the case the tripwire exists to catch.
  await db.execute(sql.raw(`CREATE TABLE ext_rls_bare (id uuid PRIMARY KEY)`));

  // ---- #2466 fixtures: tables that EXIST but were never declared ----
  //
  // The tenant-scope columns below are `device_id` / `partner_id`, never
  // `org_id`, and they are PLAIN uuids with NO foreign key. That is deliberate
  // and load-bearing, for the same reason as the note above: `org_id` is the
  // sole column rls-coverage auto-discovers on, and its FK/cascade contracts
  // key off real foreign keys. A leaked fixture must not be able to impersonate
  // a real tenant table on an unrelated PR. `assertExtensionTenancyRls` reads
  // only column NAMES out of pg_attribute, so an FK would buy nothing.

  // Tenant-scoped (device_id) with no RLS, and declared by nobody — the exact
  // hole #2466 closes: pre-fix this table sailed through boot unexamined.
  await db.execute(sql.raw(`CREATE TABLE extundeclared_docs (id uuid PRIMARY KEY, device_id uuid)`));
  // Genuinely global: no tenant column at all. Legal — but only via an explicit
  // nonTenantTables opt-out, never by silent omission.
  await db.execute(sql.raw(`CREATE TABLE extglobal_lookup (id uuid PRIMARY KEY, label text)`));
  // Claims to be global but carries partner_id. The opt-out must not launder it.
  await db.execute(sql.raw(`CREATE TABLE extliar_docs (id uuid PRIMARY KEY, partner_id uuid)`));

  // The rename-the-column bypass: unmistakably tenant data (a real FK into
  // `organizations`) whose column is called `organization_id`, so it scores ZERO
  // against TENANT_SCOPE_COLUMNS. Only the FK check can see this one. Note the
  // column is deliberately NOT `org_id` — that keeps it invisible to
  // rls-coverage's auto-discovery, exactly as the note above requires.
  await db.execute(sql.raw(`
    CREATE TABLE extfk_docs (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id)
    )
  `));

  // Postgres cannot apply RLS to a materialized view at all, so an extension-owned
  // one is an unfixable cross-tenant copy. It must be rejected, not merely skipped.
  await db.execute(sql.raw(`CREATE MATERIALIZED VIEW extmv_all AS SELECT id FROM extglobal_lookup`));
});

afterAll(async () => {
  await dropFixtures();
});

function tenancy(
  overrides: Partial<ExtensionTenancyDeclaration> = {},
): ExtensionTenancyDeclaration {
  return {
    orgCascadeDeleteTables: [],
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
    ...overrides,
  };
}

describe('assertExtensionTenancyRls (real Postgres)', () => {
  it('passes for a table with RLS enabled + forced + at least one policy', async () => {
    await expect(
      assertExtensionTenancyRls('demo', tenancy({ orgCascadeDeleteTables: ['ext_rls_good'] })),
    ).resolves.toBeUndefined();
  });

  it('throws when the declared table has no RLS at all', async () => {
    await expect(
      assertExtensionTenancyRls('demo', tenancy({ orgCascadeDeleteTables: ['ext_rls_bare'] })),
    ).rejects.toThrow(/ext_rls_bare.*ROW LEVEL SECURITY enabled/s);
  });

  it('throws when RLS is enabled but not FORCEd', async () => {
    await expect(
      assertExtensionTenancyRls('demo', tenancy({ orgCascadeDeleteTables: ['ext_rls_notforced'] })),
    ).rejects.toThrow(/FORCE ROW LEVEL SECURITY/);
  });

  it('throws when the table has RLS but zero policies', async () => {
    await expect(
      assertExtensionTenancyRls('demo', tenancy({ orgCascadeDeleteTables: ['ext_rls_nopolicy'] })),
    ).rejects.toThrow(/no RLS policies/);
  });

  it('throws when a declared table does not exist in the catalog', async () => {
    await expect(
      assertExtensionTenancyRls('demo', tenancy({ orgCascadeDeleteTables: ['ext_rls_never_created'] })),
    ).rejects.toThrow(/does not exist/);
  });

  it('reports every non-compliant table across all tenancy arrays in one error', async () => {
    const err = await assertExtensionTenancyRls(
      'demo',
      tenancy({
        orgCascadeDeleteTables: ['ext_rls_good', 'ext_rls_bare'],
        deviceCascadeDeleteTables: ['ext_rls_notforced'],
        deviceOrgDenormalizedTables: ['ext_rls_nopolicy'],
      }),
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('ext_rls_bare');
    expect(msg).toContain('ext_rls_notforced');
    expect(msg).toContain('ext_rls_nopolicy');
    // The compliant table must NOT be reported as a problem.
    expect(msg).not.toContain('ext_rls_good');
    expect(msg).toContain('refusing to boot');
  });

  it('passes for an extension that declares nothing AND created nothing', async () => {
    // Still a real catalog round-trip (#2466): "declares nothing" is only benign
    // once the catalog confirms the extension also OWNS nothing. `demo_` matches
    // no table here. Pre-#2466 this returned early without ever asking Postgres.
    await expect(assertExtensionTenancyRls('demo', tenancy())).resolves.toBeUndefined();
  });

  it('verifies real core tables pass the same assertion (proves it reads the live catalog)', async () => {
    // `devices` is a core tenant table — RLS enabled, forced, with policies.
    // If the catalog query were broken, this would throw too.
    await expect(
      assertExtensionTenancyRls('core-sanity', tenancy({ orgCascadeDeleteTables: ['devices'] })),
    ).resolves.toBeUndefined();
  });
});

/**
 * #2466 — the manifest is a claim written by the policed party. These tests are
 * the ones that reconcile it against what the database ACTUALLY contains, which
 * is the whole point: a declaration-only tripwire can never catch the table an
 * extension simply chose not to mention.
 */
describe('undeclared extension tables (real Postgres, #2466)', () => {
  it('fails the boot on a tenant-scoped table that exists but is declared nowhere', async () => {
    // `extundeclared_docs` has device_id and no RLS. Pre-fix, a manifest with
    // empty tenancy arrays short-circuited before touching the catalog and this
    // table shipped completely unexamined.
    const err = await assertExtensionTenancyRls('extundeclared', tenancy()).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('extundeclared_docs');
    expect(msg).toContain('is tenant-scoped');
    expect(msg).toContain('refusing to boot');
    // The remedy must be to declare it — never to switch the tripwire off.
    expect(msg).toContain('BREEZE_EXTENSIONS_ENABLED=false');
  });

  it('fails the boot on an undeclared table with no tenant column, pointing at the opt-out', async () => {
    const err = await assertExtensionTenancyRls('extglobal', tenancy()).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('extglobal_lookup');
    expect((err as Error).message).toContain('nonTenantTables');
  });

  it('passes once a genuinely global table is opted out via nonTenantTables', async () => {
    // Same table, same missing RLS — the difference is purely that the manifest
    // now says so out loud. That is the reviewable act the opt-out exists for.
    await expect(
      assertExtensionTenancyRls('extglobal', tenancy({ nonTenantTables: ['extglobal_lookup'] })),
    ).resolves.toBeUndefined();
  });

  it('rejects a nonTenantTables opt-out for a table that actually carries a tenant column', async () => {
    // The anti-bypass. Without this, #2466's fix would ship a hole exactly as
    // wide as the one it closes — "just call your tenant table global".
    // `extliar_docs` carries partner_id.
    await expect(
      assertExtensionTenancyRls('extliar', tenancy({ nonTenantTables: ['extliar_docs'] })),
    ).rejects.toThrow(/extliar_docs.*carries a tenant column/s);
  });

  // THE bypass a name-only check cannot close. `extfk_docs` has a real FK into
  // `organizations` but calls the column `organization_id`, so it scores zero
  // against TENANT_SCOPE_COLUMNS. If the opt-out were verified by column names
  // alone, this table would boot clean with no RLS and full cross-tenant reads.
  it('rejects a nonTenantTables opt-out for a table whose tenant link is an FK with a renamed column', async () => {
    const err = await assertExtensionTenancyRls(
      'extfk',
      tenancy({ nonTenantTables: ['extfk_docs'] }),
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('extfk_docs');
    expect((err as Error).message).toContain('FOREIGN KEY into a core tenant table');
  });

  it('rejects an extension-owned materialized view outright (Postgres cannot RLS one)', async () => {
    // Even declared, even opted out — there is no compliant matview.
    await expect(
      assertExtensionTenancyRls('extmv', tenancy({ nonTenantTables: ['extmv_all'] })),
    ).rejects.toThrow(/extmv_all.*materialized view.*cannot protect with RLS/s);
  });

  it('does not blame an extension for CORE tables sharing its name prefix', async () => {
    // Nothing stops an extension being named `device`, and this database holds
    // ~30 real core `device_*` tables. They must be subtracted via the core
    // Drizzle schema, or a legally-named extension bricks the boot over tables
    // it never created — and the operator's only lever is the env var that
    // disables every tripwire at once.
    //
    // This runs against the LIVE catalog, so it also proves the core-schema
    // barrel actually covers the device_* tables that really exist.
    await expect(assertExtensionTenancyRls('device', tenancy())).resolves.toBeUndefined();
  });
});

/**
 * The core-table subtraction is what stops an extension named `device`, `backup`
 * or `s1` from being blamed for tables core created. It is only as good as
 * `coreTableNames()`, which reads the Drizzle barrel — and the barrel is NOT a
 * complete inventory: five live core tables (`backup_profiles`,
 * `breeze_migrations`, `s1_site_mappings`, `td_synnex_*`) have no Drizzle model
 * and are hand-listed in CORE_NON_DRIZZLE_TABLES.
 *
 * A silent drift there is a production boot-brick with no operator remedy, so
 * this test reds on the PR that adds the NEXT migration-only core table, instead
 * of an extension author discovering it at 3am.
 */
describe('core table inventory (guards CORE_NON_DRIZZLE_TABLES drift)', () => {
  it('coreTableNames() covers every core public table in the live catalog', async () => {
    const db = getTestDb();
    const rows = (await db.execute(sql`
      SELECT c.relname::text AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'm', 'f')
        AND NOT c.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          JOIN pg_extension e ON e.oid = d.refobjid
          WHERE d.objid = c.oid AND d.deptype = 'e')
      ORDER BY 1
    `)) as unknown as Array<{ table_name: string }>;

    // `extensions/` is empty in this repo, so every real table here is core's.
    // The only non-core relations are this suite's own fixtures.
    const testFixtures = new Set<string>([...FIXTURES, ...MATVIEW_FIXTURES]);
    const uncovered = rows
      .map((r) => r.table_name)
      .filter((t) => !coreTableNames().has(t) && !testFixtures.has(t));

    expect(uncovered).toEqual([]);
  });
});

/**
 * The per-extension scan infers ownership from the `<name>_` prefix — but that
 * prefix is enforced only on manifest DECLARATIONS, never on the DDL an
 * extension's migration actually runs. `CREATE TABLE documents (org_id uuid)` in
 * extension `demo` matches no prefix and is declared nowhere. This reconciliation
 * catches it by elimination: anything that is neither core's nor declared by some
 * extension has no business existing.
 */
describe('assertNoUnaccountedPublicTables (real Postgres, #2466)', () => {
  it('flags tables that belong to no core schema and to no manifest', async () => {
    const err = await assertNoUnaccountedPublicTables([]).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // The fixtures stand in for undeclared extension tables. Crucially,
    // `extundeclared_docs` would be invisible to a prefix scan run for any
    // extension not literally named `extundeclared`.
    expect(msg).toContain('extundeclared_docs');
    expect(msg).toContain('belong to no core schema and to no extension manifest');
    // Core tables must NOT be dragged in — that would be the boot-brick.
    expect(msg).not.toContain('devices\n');
    expect(msg).not.toContain('breeze_migrations');
  });

  it('passes once every extension table is declared somewhere in a manifest', async () => {
    // Declaring them (in any array) is what makes them accounted for.
    await expect(
      assertNoUnaccountedPublicTables([
        tenancy({ nonTenantTables: [...FIXTURES, ...MATVIEW_FIXTURES] }),
      ]),
    ).resolves.toBeUndefined();
  });
});
