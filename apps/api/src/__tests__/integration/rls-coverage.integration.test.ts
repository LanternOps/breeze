import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

/**
 * Contract test: every tenant-scoped public table must have RLS enabled and
 * must have at least one permissive policy per DML command (SELECT, INSERT,
 * UPDATE, DELETE) whose predicate references the appropriate access helper.
 * An ALL-cmd policy counts for all four.
 *
 * Five shapes of tenant-scoping are recognised, each with its own assertion:
 *   1. **org-tenant tables** — tables with an `org_id` column (auto-
 *      discovered) or where the row's own id is the tenant identifier
 *      (explicit list). Policies must reference `breeze_has_org_access`.
 *   2. **partner-tenant tables** — tables where the tenant is a partner:
 *      `partner_users.partner_id` or the partner row's own id. Policies
 *      must reference `breeze_has_partner_access`.
 *   3. **dual-axis tables** — `users` is keyed on BOTH partner_id AND
 *      org_id (OR'd in the policy), plus a self-read branch. Its four
 *      DML commands must be covered by policies that reference either
 *      `breeze_has_org_access` or `breeze_has_partner_access` (or both).
 *   4. **join-policy tables** — tables with a `device_id` FK but no
 *      denormalized `org_id`. Their policies join through `devices` via a
 *      subquery. Policies must contain both `FROM devices` and
 *      `breeze_has_org_access` in the predicate.
 *   5. **user-id-scoped tables** — tables scoped to the calling user via
 *      `breeze_current_user_id()`. Policies must reference
 *      `breeze_current_user_id` in the predicate.
 *
 * All shapes accept per-command policies (new) or a single ALL policy
 * (legacy migration 0008 shape). The test is semantic, not name-bound.
 */

// Tables that intentionally do not carry RLS isolation policies.
// Add deliberately, with a comment. Empty for now.
const EXEMPT_TABLES: ReadonlySet<string> = new Set<string>([]);

// Tables whose own `id` column is the tenant identifier (no `org_id`).
const ORG_ID_KEYED_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'organizations',
]);

// Tables in the partner tenancy axis. Each entry points at the column
// `breeze_has_partner_access` should be called with. `id` means "the row's
// own primary key is the partner id" (e.g. partners.id).
const PARTNER_TENANT_TABLES: ReadonlyMap<string, string> = new Map<string, string>([
  ['partners', 'id'],
  ['partner_users', 'partner_id'],
  ['partner_activations', 'partner_id'],
  ['oauth_clients', 'partner_id'],
  ['oauth_refresh_tokens', 'partner_id'],
]);

// Tables whose policies reference both helpers (org OR partner). `users`
// is the canonical case: a user row is visible if the caller has access
// to the user's partner OR the user's org OR is the user themselves.
const DUAL_AXIS_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'users',
  'deployment_invites',
]);

// Tables that carry a `device_id` FK but no denormalized `org_id`. Their
// RLS policies join through `devices` to reach the org boundary.
// Policies must contain both `FROM devices` and `breeze_has_org_access`
// in the qual or with_check predicate (Phase 5 migration).
const DEVICE_ID_JOIN_POLICY_TABLES: ReadonlySet<string> = new Set<string>([
  'automation_policy_compliance',
  'deployment_devices',
  'deployment_results',
  'patch_job_results',
  'patch_rollbacks',
  'file_transfers',
]);

// Tables scoped to the calling user via breeze_current_user_id().
// Policies must reference `breeze_current_user_id` in the predicate
// (Phase 6 migration).
const USER_ID_SCOPED_TABLES: ReadonlySet<string> = new Set<string>([
  'user_sso_identities',
  'push_notifications',
  'mobile_devices',
  'ticket_comments',
  'access_review_items',
  'oauth_authorization_codes',
]);

const REQUIRED_CMDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

interface TableRow {
  table_name: string;
  rls_on: boolean;
  covered_cmds: string[] | null;
}

function offendersFrom(rows: TableRow[]): Array<{ table: string; rls_on: boolean; missing_cmds: string[] }> {
  return rows
    .filter((r) => !EXEMPT_TABLES.has(r.table_name))
    .map((r) => {
      const covered = new Set<string>(r.covered_cmds ?? []);
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
      return { table: r.table_name, rls_on: r.rls_on, missing_cmds: missing };
    })
    .filter((r) => !r.rls_on || r.missing_cmds.length > 0);
}

describe('RLS coverage contract', () => {
  it('every org-tenant public table has RLS on and all four DML commands covered by breeze_has_org_access', async () => {
    const idKeyedList = Array.from(ORG_ID_KEYED_TENANT_TABLES);

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

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Org-tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Use breeze_has_org_access(org_id) — or breeze_has_org_access(id) for id-keyed tenant tables — in the policy ` +
        `predicate. See 2026-04-11-rewrite-backup-rls-policies.sql for the per-command shape and ` +
        `2026-04-11-organizations-rls.sql for the id-keyed shape.`
    ).toEqual([]);
  });

  it('every partner-tenant public table has RLS on and all four DML commands covered by breeze_has_partner_access', async () => {
    const partnerTables = Array.from(PARTNER_TENANT_TABLES.keys());

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${partnerTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
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
            COALESCE(p.qual, '') LIKE '%breeze_has_partner_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_partner_access%'
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

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Partner-tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Use breeze_has_partner_access(id) or breeze_has_partner_access(partner_id) in the policy predicate. ` +
        `See 2026-04-11-partners-rls.sql for the template.`
    ).toEqual([]);
  });

  it('every dual-axis tenant table has RLS on and all four DML commands covered by breeze_has_org_access or breeze_has_partner_access', async () => {
    const dualTables = Array.from(DUAL_AXIS_TENANT_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${dualTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
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
            OR COALESCE(p.qual, '') LIKE '%breeze_has_partner_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_partner_access%'
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

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Dual-axis tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: each DML command must be covered by a policy referencing at least one of ` +
        `breeze_has_org_access or breeze_has_partner_access. See 2026-04-11-users-rls.sql ` +
        `for the users table template (the canonical dual-axis case with a self-read branch).`
    ).toEqual([]);
  });

  it('every Phase 5 join-policy table has RLS on and all four DML commands covered by a device-join policy', async () => {
    const joinTables = Array.from(DEVICE_ID_JOIN_POLICY_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${joinTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
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
            COALESCE(p.qual, '') LIKE '%FROM devices%'
            OR COALESCE(p.with_check, '') LIKE '%FROM devices%'
          )
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

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Phase 5 join-policy tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Each policy predicate must join through devices and call breeze_has_org_access, e.g.: ` +
        `EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND breeze_has_org_access(d.org_id)). ` +
        `See the Phase 5 migration for the canonical shape.`
    ).toEqual([]);
  });

  it('every Phase 6 user-id-scoped table has RLS on and all four DML commands covered by a breeze_current_user_id policy', async () => {
    const userTables = Array.from(USER_ID_SCOPED_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${userTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
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
            COALESCE(p.qual, '') LIKE '%breeze_current_user_id%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_current_user_id%'
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

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Phase 6 user-id-scoped tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Each policy predicate must reference breeze_current_user_id(), e.g.: ` +
        `user_id = breeze_current_user_id(). ` +
        `See the Phase 6 migration for the canonical shape.`
    ).toEqual([]);
  });
});
