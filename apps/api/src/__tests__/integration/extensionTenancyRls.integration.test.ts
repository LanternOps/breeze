import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
import { getTestDb } from './setup';
import { assertExtensionTenancyRls } from '../../extensions/loader';

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
] as const;

async function dropFixtures() {
  const db = getTestDb();
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

  it('is a no-op (no DB round-trip needed) when the manifest declares no tenancy tables', async () => {
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
