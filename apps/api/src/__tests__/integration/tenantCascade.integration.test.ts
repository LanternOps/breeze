import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  ORG_CASCADE_DELETE_ORDER,
  topologicalCascadeOrder,
} from '../../services/tenantCascade';

/**
 * Contract test for Task 30 — GDPR org-wide erasure.
 *
 * The cascade list (`ORG_CASCADE_DELETE_ORDER`) is the authoritative
 * set of tables that get wiped when a platform admin POSTs to
 * `/admin/tenant-erasure`. This test guarantees the list stays in
 * sync with the actual schema: any new `org_id`-columned public table
 * that is not added to the cascade list will break CI.
 *
 * Mirrors the rls-coverage contract test pattern.
 */

// Mirror of `INTENTIONAL_UNSCOPED` from rls-coverage.integration.test.ts.
// These tables are deliberately not org-scoped and must NOT be in the
// cascade list even if they happen to have an org_id column (none of
// them do today, but listed defensively so adding one later doesn't
// silently leak into cascade scope).
const NOT_CASCADE_SCOPED: ReadonlySet<string> = new Set<string>([
  'device_commands', // agent WS path, system-scoped command queue
  'manifest_signing_keys', // per-deployment system table
  'third_party_package_catalog', // system-wide curated catalog
  'third_party_release_tests', // system-wide release test results
]);

describe('Tenant cascade list contract', () => {
  it('ORG_CASCADE_DELETE_ORDER is alphabetised (organizations last) for determinism', () => {
    // organizations is id-keyed and must be cleared last (after every
    // org_id-FK child). Everything else should be in alpha order.
    const cascade = [...ORG_CASCADE_DELETE_ORDER];
    expect(cascade.at(-1)).toBe('organizations');
    const orgScopedPrefix = cascade.slice(0, -1);
    const sorted = [...orgScopedPrefix].sort((a, b) => a.localeCompare(b));
    expect(orgScopedPrefix).toEqual(sorted);
  });

  it('every org_id-columned public table is in ORG_CASCADE_DELETE_ORDER', async () => {
    const rows = (await db.execute(sql`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'org_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name;
    `)) as unknown as Array<{ table_name: string }>;

    const dbTables = rows
      .map((r) => r.table_name)
      .filter((t) => !NOT_CASCADE_SCOPED.has(t));

    const cascadeSet = new Set(ORG_CASCADE_DELETE_ORDER);
    const missing = dbTables.filter((t) => !cascadeSet.has(t));

    expect(
      missing,
      `New org_id-scoped tables that are missing from ORG_CASCADE_DELETE_ORDER ` +
        `(apps/api/src/services/tenantCascade.ts). Add them to keep the GDPR cascade ` +
        `complete:\n${JSON.stringify(missing, null, 2)}\n\n` +
        `If a table is intentionally not part of the cascade, add it to ` +
        `NOT_CASCADE_SCOPED in this test file with a comment.`,
    ).toEqual([]);
  });

  it('no entry in ORG_CASCADE_DELETE_ORDER references a non-existent table', async () => {
    const rows = (await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)) as unknown as Array<{ table_name: string }>;
    const present = new Set(rows.map((r) => r.table_name));

    const stale = ORG_CASCADE_DELETE_ORDER.filter((t) => !present.has(t));

    expect(
      stale,
      `ORG_CASCADE_DELETE_ORDER references tables that don't exist in this deployment:\n` +
        `${JSON.stringify(stale, null, 2)}\n\n` +
        `Remove them from the cascade list or restore the schema/migration that defines them.`,
    ).toEqual([]);
  });

  it('topologicalCascadeOrder() returns every cascade table exactly once', async () => {
    const order = await topologicalCascadeOrder();
    expect(order.length).toBe(ORG_CASCADE_DELETE_ORDER.length);
    expect(new Set(order)).toEqual(new Set(ORG_CASCADE_DELETE_ORDER));
  });

  it('topological order has all FK children appearing before their parents', async () => {
    const order = await topologicalCascadeOrder();
    const indexOf = new Map<string, number>();
    order.forEach((table, i) => indexOf.set(table, i));

    // Pull FK edges between cascade tables.
    const cascadeSet = new Set(ORG_CASCADE_DELETE_ORDER);
    const edges = (await db.execute(sql`
      SELECT
        tc.relname AS child_table,
        tp.relname AS parent_table
      FROM pg_constraint c
      JOIN pg_class tc ON tc.oid = c.conrelid
      JOIN pg_class tp ON tp.oid = c.confrelid
      JOIN pg_namespace nc ON nc.oid = tc.relnamespace
      JOIN pg_namespace np ON np.oid = tp.relnamespace
      WHERE c.contype = 'f'
        AND nc.nspname = 'public'
        AND np.nspname = 'public'
        AND tc.relname <> tp.relname;
    `)) as unknown as Array<{ child_table: string; parent_table: string }>;

    const violations: Array<{ child: string; parent: string }> = [];
    for (const e of edges) {
      if (!cascadeSet.has(e.child_table) || !cascadeSet.has(e.parent_table)) continue;
      const ci = indexOf.get(e.child_table)!;
      const pi = indexOf.get(e.parent_table)!;
      // Child must be deleted before parent → child must come first.
      if (ci > pi) violations.push({ child: e.child_table, parent: e.parent_table });
    }

    expect(
      violations,
      `Topological order violates FK direction (these children would be deleted ` +
        `AFTER their parents, leaving orphan rows):\n` +
        `${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
