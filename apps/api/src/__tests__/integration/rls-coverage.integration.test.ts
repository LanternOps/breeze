import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

/**
 * Contract test: every tenant-scoped public table must have RLS enabled and
 * must have at least one permissive policy per DML command (SELECT, INSERT,
 * UPDATE, DELETE) whose predicate references `breeze_has_org_access`. An
 * ALL-cmd policy counts for all four.
 *
 * Two shapes of tenant-scoping are recognised:
 *   1. **org_id column** — standard case. Any public table with an `org_id`
 *      column must be RLS-covered.
 *   2. **id is tenant key** — tables where the row's own id is the tenant
 *      identifier (e.g. `organizations`). These are listed explicitly in
 *      ID_KEYED_TENANT_TABLES below.
 *
 * This enforces the *semantic* contract — not a specific naming convention.
 * Both the new `breeze_org_isolation_{select,insert,update,delete}` shape
 * (see `2026-04-11-rewrite-backup-rls-policies.sql`) and the legacy
 * `<table>_org_isolation` ALL-cmd shape from migration 0008 satisfy it.
 *
 * If a table is intentionally exempt (e.g. a global reference table that
 * happens to have an org_id column, or a table that is deliberately
 * accessed only from system scope), add it to EXEMPT_TABLES with a comment
 * explaining why.
 */

// Tables that intentionally do not carry RLS org-isolation policies.
// Add deliberately, with a comment. Empty for now.
const EXEMPT_TABLES: ReadonlySet<string> = new Set<string>([]);

// Tables whose own `id` column is the tenant identifier (no `org_id`).
// Add to this list when a new tenant-root table is introduced.
const ID_KEYED_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'organizations',
]);

const REQUIRED_CMDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

interface TableRow {
  table_name: string;
  rls_on: boolean;
  covered_cmds: string[] | null;
}

describe('RLS coverage contract', () => {
  it('every tenant-scoped public table has RLS on and all four DML commands covered by breeze_has_org_access', async () => {
    const idKeyedList = Array.from(ID_KEYED_TENANT_TABLES);

    const rows = (await db.execute(sql`
      WITH org_id_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND col.column_name = 'org_id'
      ),
      id_keyed_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${idKeyedList.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      tenant_tables AS (
        SELECT * FROM org_id_tables
        UNION
        SELECT * FROM id_keyed_tables
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_org_access%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const offenders = rows
      .filter((r) => !EXEMPT_TABLES.has(r.table_name))
      .map((r) => {
        const covered = new Set<string>(r.covered_cmds ?? []);
        const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
        return { table: r.table_name, rls_on: r.rls_on, missing_cmds: missing };
      })
      .filter((r) => !r.rls_on || r.missing_cmds.length > 0);

    expect(
      offenders,
      `Tables missing RLS coverage for one or more DML commands:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Use breeze_has_org_access(org_id) — or breeze_has_org_access(id) for id-keyed tenant tables — in the policy ` +
        `predicate. See 2026-04-11-rewrite-backup-rls-policies.sql for the per-command shape and ` +
        `2026-04-11-organizations-rls.sql for the id-keyed shape.`
    ).toEqual([]);
  });
});
