import { afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, users } from '../../db/schema';
import { approvalRequests } from '../../db/schema/approvals';

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

// Tables with org_id metadata that are intentionally not generic org-tenant
// tables. OAuth token rows are user/client secrets; org_id is retained for
// lifecycle filtering only, and tenant-wide revocation uses system DB context
// after app-layer authorization.
const ORG_AXIS_POLICY_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  'oauth_authorization_codes',
  'oauth_grants',
  'oauth_refresh_tokens',
]);

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
  ['oauth_clients', 'partner_id'],
  ['oauth_client_partner_grants', 'partner_id'],
  ['email_verification_tokens', 'partner_id'],
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
  'oauth_grants',
  'oauth_refresh_tokens',
  // oauth_sessions: account_id (= users.id) is nullable for anonymous
  // pre-login Sessions. Policy matches the user-scope-OR-system-scope
  // pattern of oauth_authorization_codes; the coverage test only checks
  // that breeze_current_user_id is referenced.
  'oauth_sessions',
  // oauth_interactions: short-lived OAuth interaction records. Pre-login
  // interactions have no accountId; once login happens the policy gates
  // access by (payload->session->accountId)::uuid = breeze_current_user_id().
  // System-scope bypass covers the adapter writes (runOutsideDbContext).
  'oauth_interactions',
  // approval_requests: MCP step-up approval records, scoped to the requesting
  // user via breeze_current_user_id(). Shape 6 policy.
  'approval_requests',
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
  it('oauth_clients shared rows are visible only to system scope or granted partners', async () => {
    const rows = (await db.execute(sql`
      SELECT
        policyname,
        cmd,
        COALESCE(qual, '') AS qual,
        COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'oauth_clients'
      ORDER BY policyname;
    `)) as unknown as Array<{
      policyname: string;
      cmd: string;
      qual: string;
      with_check: string;
    }>;

    const combined = rows.map((row) => `${row.qual}\n${row.with_check}`).join('\n');
    const selectPolicy = rows.find((row) => row.policyname === 'oauth_clients_select_access');
    const writePolicies = rows.filter((row) =>
      [
        'oauth_clients_insert_access',
        'oauth_clients_update_access',
        'oauth_clients_delete_access',
      ].includes(row.policyname)
    );

    expect(selectPolicy?.qual).toContain('breeze_current_scope() = \'system\'');
    expect(selectPolicy?.qual).toContain('oauth_client_partner_grants');
    expect(selectPolicy?.qual).toContain('breeze_has_partner_access(g.partner_id)');
    expect(combined).not.toContain('partner_id IS NULL');
    expect(writePolicies).toHaveLength(3);
    for (const policy of writePolicies) {
      expect(`${policy.qual}\n${policy.with_check}`).not.toContain('partner_id IS NULL');
    }
  });

  it('OAuth token-row policies do not grant generic org-axis access', async () => {
    const rows = (await db.execute(sql`
      SELECT
        tablename,
        policyname,
        COALESCE(qual, '') AS qual,
        COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(ARRAY[
          'oauth_authorization_codes',
          'oauth_grants',
          'oauth_refresh_tokens'
        ]::text[])
      ORDER BY tablename, policyname;
    `)) as unknown as Array<{
      tablename: string;
      policyname: string;
      qual: string;
      with_check: string;
    }>;

    expect(rows.map((row) => row.tablename).sort()).toEqual([
      'oauth_authorization_codes',
      'oauth_grants',
      'oauth_refresh_tokens',
    ]);

    for (const row of rows) {
      const predicate = `${row.qual}\n${row.with_check}`;
      expect(predicate).toContain('breeze_current_scope() = \'system\'');
      expect(predicate).not.toContain('breeze_has_org_access');
    }

    const authCodes = rows.find((row) => row.tablename === 'oauth_authorization_codes');
    const grants = rows.find((row) => row.tablename === 'oauth_grants');
    const refreshTokens = rows.find((row) => row.tablename === 'oauth_refresh_tokens');

    expect(`${authCodes?.qual}\n${authCodes?.with_check}`).toContain('user_id = breeze_current_user_id()');
    expect(`${grants?.qual}\n${grants?.with_check}`).toContain('account_id = breeze_current_user_id()');
    expect(`${refreshTokens?.qual}\n${refreshTokens?.with_check}`).toContain('user_id = breeze_current_user_id()');
  });

  it('every tenant-scoped public table has FORCE ROW LEVEL SECURITY enabled', async () => {
    const explicitTables = Array.from(new Set([
      ...ORG_ID_KEYED_TENANT_TABLES,
      ...PARTNER_TENANT_TABLES.keys(),
      ...DUAL_AXIS_TENANT_TABLES,
      ...DEVICE_ID_JOIN_POLICY_TABLES,
      ...USER_ID_SCOPED_TABLES,
    ]));

    const rows = (await db.execute(sql`
      WITH org_id_tables AS (
        SELECT DISTINCT c.relname, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND col.column_name = 'org_id'
      ),
      explicit_tables AS (
        SELECT c.relname, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${explicitTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      tenant_tables AS (
        SELECT * FROM org_id_tables
        UNION
        SELECT * FROM explicit_tables
      )
      SELECT relname AS table_name, relforcerowsecurity AS force_rls_on
      FROM tenant_tables
      ORDER BY relname;
    `)) as unknown as Array<{ table_name: string; force_rls_on: boolean }>;

    const offenders = rows
      .filter((row) => !EXEMPT_TABLES.has(row.table_name))
      .filter((row) => !row.force_rls_on)
      .map((row) => row.table_name);

    expect(
      offenders,
      `Tenant-scoped tables missing FORCE ROW LEVEL SECURITY:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add an idempotent migration that runs ALTER TABLE ... FORCE ROW LEVEL SECURITY for each offender.`
    ).toEqual([]);
  });

  it('deployment_invites has a database invariant tying org_id to partner_id', async () => {
    const rows = (await db.execute(sql`
      SELECT
        c.conname,
        c.contype,
        src.relname AS source_table,
        target.relname AS target_table,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_class target ON target.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE n.nspname = 'public'
        AND src.relname = 'deployment_invites'
        AND c.conname = 'deployment_invites_org_partner_fk';
    `)) as unknown as Array<{
      conname: string;
      contype: string;
      source_table: string;
      target_table: string;
      definition: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.contype).toBe('f');
    expect(rows[0]?.target_table).toBe('organizations');
    expect(rows[0]?.definition).toContain('FOREIGN KEY (org_id, partner_id)');
    expect(rows[0]?.definition).toContain('REFERENCES organizations(id, partner_id)');
  });

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
          AND c.relname <> ALL(${sql.raw(
            `ARRAY[${Array.from(ORG_AXIS_POLICY_EXCLUDED_TABLES).map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
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

// ===========================================================================
// approval_requests — Shape 6 forge test
//
// The pg_catalog inspection above only checks that a policy referencing
// breeze_current_user_id() exists for each DML command. It does NOT prove
// Postgres actually rejects a cross-user write — a refactor that replaces
// the canonical user_id = breeze_current_user_id() predicate with a
// permissive `true` would still pass the catalog check but silently let
// any user act on any approval row.
//
// This block forges cross-user reads/writes against a real DB connection
// (as `breeze_app`, the unprivileged role) and asserts Postgres enforces
// the Shape 6 policy in practice. It is purposefully self-contained so it
// can run under vitest.config.rls-coverage.ts (which deliberately does NOT
// load setup.ts and thus has no per-test TRUNCATE) — fixtures are seeded
// via withSystemDbAccessContext and torn down by id in an afterAll.
// ===========================================================================
describe('approval_requests RLS — cross-user forge enforcement (Shape 6)', () => {
  // Stable suffix so re-runs against a long-lived DB don't collide on
  // users.email (UNIQUE) but tests within a single run share the fixture.
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partnerSlug = `rls-approvals-partner-${runSuffix}`;
  const userAEmail = `rls-approvals-a-${runSuffix}@example.test`;
  const userBEmail = `rls-approvals-b-${runSuffix}@example.test`;

  let partnerId: string;
  let userAId: string;
  let userBId: string;
  let approvalAId: string | null = null;

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Approvals Partner ${runSuffix}`,
          slug: partnerSlug,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for approvals RLS forge test');
      partnerId = partner.id;

      const [a, b] = await db
        .insert(users)
        .values([
          {
            partnerId: partner.id,
            email: userAEmail,
            name: 'RLS Approvals User A',
            status: 'active',
          },
          {
            partnerId: partner.id,
            email: userBEmail,
            name: 'RLS Approvals User B',
            status: 'active',
          },
        ])
        .returning({ id: users.id });
      if (!a || !b) throw new Error('failed to seed users for approvals RLS forge test');
      userAId = a.id;
      userBId = b.id;
    });
  }

  afterAll(async () => {
    // approval_requests policy has no system-scope OR branch, so system
    // context cannot delete the row directly. Delete it as user A (the
    // row's owner). Users/partners are dual-axis / partner-axis and DO
    // accept system scope, so we tear those down via system context.
    if (approvalAId && userAId) {
      await withDbAccessContext(userContext(userAId), async () =>
        db.delete(approvalRequests).where(eq(approvalRequests.id, approvalAId!))
      );
    }
    await withSystemDbAccessContext(async () => {
      if (userAId) await db.delete(users).where(eq(users.id, userAId));
      if (userBId) await db.delete(users).where(eq(users.id, userBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  // Build a per-user DbAccessContext. Shape 6 only needs `userId`;
  // scope='organization' with empty accessibleOrgIds keeps the caller's
  // org/partner reach to none so no other policy accidentally green-lights
  // the row.
  function userContext(userId: string) {
    return {
      scope: 'organization' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [],
      userId,
    };
  }

  it('user A can INSERT and SELECT their own approval_request row', async () => {
    await ensureFixtures();

    const inserted = await withDbAccessContext(userContext(userAId), async () =>
      db
        .insert(approvalRequests)
        .values({
          userId: userAId,
          requestingClientLabel: 'rls-forge-client',
          actionLabel: 'forge.test',
          actionToolName: 'forge.test',
          riskTier: 'low',
          riskSummary: 'rls forge test seed',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        })
        .returning({ id: approvalRequests.id })
    );

    expect(inserted).toHaveLength(1);
    approvalAId = inserted[0]!.id;

    const visibleToA = await withDbAccessContext(userContext(userAId), async () =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(visibleToA.map((r) => r.id)).toEqual([approvalAId]);
  });

  it('user B SELECT cannot see user A\'s row (RLS hides it via USING)', async () => {
    await ensureFixtures();
    if (!approvalAId) throw new Error('seed test must run first');

    const visibleToB = await withDbAccessContext(userContext(userBId), async () =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(visibleToB).toEqual([]);
  });

  it('user B UPDATE on user A\'s row affects 0 rows (USING filters the WHERE)', async () => {
    await ensureFixtures();
    if (!approvalAId) throw new Error('seed test must run first');

    // The policy USING clause filters the row out before WITH CHECK runs,
    // so this is a no-op rather than an RLS violation. The status remains
    // 'pending' regardless.
    const updated = await withDbAccessContext(userContext(userBId), async () =>
      db
        .update(approvalRequests)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(eq(approvalRequests.id, approvalAId!))
        .returning({ id: approvalRequests.id })
    );
    expect(updated).toEqual([]);

    // Read back as user A (the row's owner) to confirm it is genuinely
    // untouched. We can't use system scope here: the approval_requests
    // policy is `user_id = breeze_current_user_id()` with no system-scope
    // OR branch, so system context has no read access either.
    const actual = await withDbAccessContext(userContext(userAId), async () =>
      db
        .select({ id: approvalRequests.id, status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(actual).toHaveLength(1);
    expect(actual[0]!.status).toBe('pending');
  });

  it('user B INSERT with user_id=A is rejected by WITH CHECK', async () => {
    await ensureFixtures();

    let caught: unknown;
    try {
      await withDbAccessContext(userContext(userBId), async () =>
        db.insert(approvalRequests).values({
          userId: userAId, // forging user A's id while in user B's context
          requestingClientLabel: 'rls-forge-client',
          actionLabel: 'forge.test.crossuser',
          actionToolName: 'forge.test',
          riskTier: 'low',
          riskSummary: 'rls forge test cross-user insert',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        })
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string }; message?: string } | undefined);
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(
      /new row violates row-level security policy for table "approval_requests"/
    );
  });
});
