import { afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, users, organizations } from '../../db/schema';
import { approvalRequests } from '../../db/schema/approvals';
import { manifestSigningKeys } from '../../db/schema/manifestSigningKeys';
import { automations, automationRuns } from '../../db/schema/automations';
import { configurationPolicies } from '../../db/schema/configurationPolicies';
import { scripts, scriptExecutionBatches } from '../../db/schema/scripts';

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
// Add deliberately, with a comment.
const EXEMPT_TABLES: ReadonlySet<string> = new Set<string>([
  // System-scoped: per-deployment infrastructure with no tenant column.
  // Forced RLS, no policies → only system context can access. See
  // INTENTIONAL_UNSCOPED below for the documented set.
  'manifest_signing_keys',
]);

// System-scoped tables: per-deployment infrastructure with no tenant column.
// These have ENABLE + FORCE ROW LEVEL SECURITY but no permissive policies —
// only the system DB context (superuser / runOutsideDbContext) can access them.
// The auto-discovery query won't surface these (no org_id column, not in any
// tenant list), but they are enumerated here for explicit documentation and
// so that a future "all-tables RLS enabled" audit can assert against this list.
//
// NOTE: device_commands is the canonical prior example (agent WS path, system-
// scoped by design) — see apps/api/src/db/schema/devices.ts.
const INTENTIONAL_UNSCOPED: ReadonlySet<string> = new Set<string>([
  'device_commands', // Agent WS path: system-scoped command queue, no tenant isolation needed.
  'manifest_signing_keys', // System-scoped: per-deployment agent-update signing key. Forced RLS, no policies → only system context.
  'third_party_package_catalog', // System-wide curated catalog of third-party packages; writes gated by platform-admin role at the route layer.
  'third_party_release_tests', // System-wide release test results; references catalog (unscoped) and is platform-admin-only at the route layer.
]);

// Tables with org_id metadata that are intentionally not generic org-tenant
// tables. OAuth token rows are user/client secrets; org_id is retained for
// lifecycle filtering only, and tenant-wide revocation uses system DB context
// after app-layer authorization.
const ORG_AXIS_POLICY_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  'oauth_authorization_codes',
  'oauth_grants',
  'oauth_refresh_tokens',
  // account_deletion_requests: user-id scoped (Shape 6). The denormalised
  // org_id is retained for ops/audit attribution only; the RLS policy uses
  // breeze_current_user_id(), not breeze_has_org_access.
  'account_deletion_requests',
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
  ['ticket_categories', 'partner_id'],
  ['partner_ticket_sequences', 'partner_id'],
]);

// Tables whose policies reference both helpers (org OR partner). `users`
// is the canonical case: a user row is visible if the caller has access
// to the user's partner OR the user's org OR is the user themselves.
const DUAL_AXIS_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'users',
  'deployment_invites',
  'access_reviews',
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

// Tables that reach their tenant through a PARENT FK (no device_id, no
// denormalized org_id). Their RLS policies join through the named parent
// table(s) to the org boundary. Each entry maps the child table to the
// parent table name(s) its policy predicate must reference; the policy must
// contain both `FROM <parent>` and `breeze_has_org_access` in the qual or
// with_check (migration 2026-05-30-fk-child-tables-rls.sql).
//
// This is the generalization of the Phase 5 device-join shape: same EXISTS
// structure, but the join target is the row's actual parent rather than
// `devices`. A child table keyed by a parent FK is the single most common way
// a tenant table escapes the org_id-column auto-discovery above and ships with
// NO rls — keep this list authoritative so the contract test catches the next
// one. automation_runs lists BOTH parents because config-policy-driven runs
// leave automation_id NULL and reach their org via config_policy_id instead.
const PARENT_FK_JOIN_POLICY_TABLES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['automation_runs', ['automations', 'configuration_policies']],
  ['ai_messages', ['ai_sessions']],
  ['ai_tool_executions', ['ai_sessions']],
  // NOTE: script_execution_batches is NOT here — it carries a denormalized
  // org_id column (2026-05-31 migration) and is auto-discovered as an ordinary
  // org-tenant table, because a nested-RLS join through its nullable-org parent
  // `scripts` could not satisfy the system-script INSERT under bound parameters.
  ['software_versions', ['software_catalog']],
  ['alert_correlations', ['alerts']],
  ['alert_notifications', ['alerts']],
]);

// Tables scoped to the calling user via breeze_current_user_id().
// Policies must reference `breeze_current_user_id` in the predicate
// (Phase 6 migration).
const USER_ID_SCOPED_TABLES: ReadonlySet<string> = new Set<string>([
  'user_sso_identities',
  'push_notifications',
  'mobile_devices',
  // ticket_comments: Shape 6 on the author axis, PLUS an extra permissive
  // SELECT policy (breeze_ticket_parent_select, 2026-06-10-a migration)
  // that ORs in visibility when the parent ticket is org-accessible —
  // portal-authored rows (portal_user_id set, user_id NULL) would
  // otherwise be invisible to org/partner technicians. The EXISTS join
  // through tickets is #1016-safe: tickets.org_id is NOT NULL and the
  // tickets policy has no OR branches.
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
  // user via breeze_current_user_id(). Shape 6 policy, plus an
  // `OR breeze_current_scope() = 'system'` branch (migration
  // 2026-05-16-approval-shape6-system-bypass.sql) so the BullMQ expiry
  // reaper can transition rows under system scope.
  'approval_requests',
  // account_deletion_requests: user-initiated deletion queue records, scoped
  // to the requesting user via breeze_current_user_id(). Shape 6 policy with
  // the same system-scope OR branch so the account-deletion admin queue
  // (runWithSystemDbAccess) can read/process the queue.
  'account_deletion_requests',
  // refresh_token_families: OAuth 2.1 refresh-token chain records, scoped to
  // the token owner via breeze_current_user_id(). System-initiated revocation
  // (reuse detection in /auth/refresh) uses withSystemDbAccessContext.
  'refresh_token_families',
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
      ...PARENT_FK_JOIN_POLICY_TABLES.keys(),
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

  // Issue #750: device-child tables denormalize devices.org_id for the
  // RLS hot path. If that copy is not kept in sync on an org move, the
  // stale child row fails the UPDATE policy's USING expression on the
  // agent inventory upserts. The 2026-05-18 migration installs a
  // SECURITY DEFINER cascade trigger on devices + a backfill. Guard both
  // the structural invariant (trigger present, definer-rights, covers
  // every device-child table) and the data invariant (zero drift).
  it('device.org_id changes cascade to every device-child table (no stale org_id drift) [#750]', async () => {
    const trigger = (await db.execute(sql`
      SELECT
        t.tgname,
        t.tgenabled,
        p.prosecdef,
        pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND c.relname = 'devices'
        AND t.tgname = 'breeze_cascade_device_org_id'
        AND NOT t.tgisinternal;
    `)) as unknown as Array<{
      tgname: string;
      tgenabled: string;
      prosecdef: boolean;
      def: string;
    }>;

    expect(
      trigger,
      'Missing breeze_cascade_device_org_id trigger on devices — org moves will leave stale org_id on device-child tables and break agent inventory upserts (#750). Re-apply migration 2026-05-18-device-child-orgid-cascade.sql.'
    ).toHaveLength(1);
    // SECURITY DEFINER: the cascade must run RLS-exempt or it cannot
    // rewrite the stale child rows it exists to fix.
    expect(trigger[0]?.prosecdef).toBe(true);
    // Enabled in "origin/local" mode (fires on normal writes), not disabled.
    expect(trigger[0]?.tgenabled).toBe('O');
    expect(trigger[0]?.def).toContain('UPDATE OF org_id');
    expect(trigger[0]?.def).toContain('FOR EACH ROW');

    // The discovery helper must resolve every table that denormalizes a
    // uuid org_id alongside a uuid device_id — that is exactly the set
    // the cascade and backfill iterate. A new such table is auto-covered.
    const discovered = (await db.execute(sql`
      SELECT count(*)::int AS n FROM public.breeze_device_child_orgid_tables();
    `)) as unknown as Array<{ n: number }>;
    expect(discovered[0]?.n ?? 0).toBeGreaterThan(0);

    // Data invariant: no device-child row may carry an org_id that
    // disagrees with its device. Read under system scope so RLS doesn't
    // hide cross-org rows from the audit.
    const drift = await withSystemDbAccessContext(async () => {
      const tables = (await db.execute(sql`
        SELECT public.breeze_device_child_orgid_tables() AS t;
      `)) as unknown as Array<{ t: string }>;

      const offenders: Array<{ table_name: string; n: number }> = [];
      for (const { t } of tables) {
        const [row] = (await db.execute(sql`
          SELECT count(*)::int AS n
          FROM ${sql.identifier(t)} c
          JOIN public.devices d ON d.id = c.device_id
          WHERE c.org_id IS DISTINCT FROM d.org_id;
        `)) as unknown as Array<{ n: number }>;
        const n = row?.n ?? 0;
        if (n > 0) offenders.push({ table_name: t, n });
      }
      return offenders;
    });

    expect(
      drift,
      `device-child tables with org_id drift vs devices.org_id (#750 regression — cascade trigger not keeping these in sync):\n${JSON.stringify(drift, null, 2)}`
    ).toEqual([]);
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

  it('every parent-FK join-policy table has RLS on and all four DML commands covered by a parent-join org-access policy', async () => {
    const offenders: Array<{ table: string; rls_on: boolean; missing_cmds: string[] }> = [];

    for (const [table, parents] of PARENT_FK_JOIN_POLICY_TABLES) {
      // A covering policy must (a) reach the org via breeze_has_org_access and
      // (b) actually join through one of the declared parent tables — so a
      // policy that referenced breeze_has_org_access without the correct join
      // (or vice versa) does NOT count. parents is a small fixed allowlist, so
      // sql.raw interpolation here is safe (no user input).
      const parentRef = parents
        .map(
          (p) =>
            `(COALESCE(pp.qual, '') LIKE '%FROM ${p}%' OR COALESCE(pp.with_check, '') LIKE '%FROM ${p}%')`,
        )
        .join(' OR ');

      const rows = (await db.execute(sql`
        WITH t AS (
          SELECT c.relname, c.relrowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ${table}
        ),
        covering_policies AS (
          SELECT DISTINCT
            CASE WHEN pp.cmd = 'ALL' THEN cmd_name ELSE pp.cmd END AS cmd
          FROM pg_policies pp
          CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
          WHERE pp.schemaname = 'public'
            AND pp.tablename = ${table}
            AND pp.permissive = 'PERMISSIVE'
            AND (
              COALESCE(pp.qual, '') LIKE '%breeze_has_org_access%'
              OR COALESCE(pp.with_check, '') LIKE '%breeze_has_org_access%'
            )
            AND (${sql.raw(parentRef)})
            AND (pp.cmd = 'ALL' OR pp.cmd = cmd_name)
        )
        SELECT
          t.relname AS table_name,
          t.relrowsecurity AS rls_on,
          ARRAY(SELECT cmd FROM covering_policies ORDER BY cmd) AS covered_cmds
        FROM t;
      `)) as unknown as TableRow[];

      const row = rows[0];
      const covered = new Set<string>(row?.covered_cmds ?? []);
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
      if (!row || !row.rls_on || missing.length > 0) {
        offenders.push({ table, rls_on: Boolean(row?.rls_on), missing_cmds: missing });
      }
    }

    expect(
      offenders,
      `Parent-FK join-policy tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add an idempotent migration that runs ENABLE + FORCE ROW LEVEL SECURITY and installs ` +
        `SELECT/INSERT/UPDATE/DELETE policies whose predicate joins through the table's parent and calls ` +
        `breeze_has_org_access(parent.org_id), e.g.: ` +
        `EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id AND breeze_has_org_access(a.org_id)). ` +
        `See 2026-05-30-fk-child-tables-rls.sql for the canonical shape and the PARENT_FK_JOIN_POLICY_TABLES allowlist.`
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
    // approval_requests now has a system-scope OR branch (migration
    // 2026-05-16-approval-shape6-system-bypass.sql), so system context can
    // tear the row down directly alongside the users/partners fixtures.
    await withSystemDbAccessContext(async () => {
      if (approvalAId) {
        await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalAId!));
      }
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
    // untouched. Reading as the owner is a deliberately stronger assertion
    // than a system-scope read: it proves the row is intact from the user
    // whose tenancy axis governs it, not merely visible to the privileged
    // system context (which the policy now also permits).
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

// ===========================================================================
// manifest_signing_keys RLS lockout (#639)
//
// The catalog test above only proves `manifest_signing_keys` is in
// INTENTIONAL_UNSCOPED as documentation. It does NOT prove Postgres rejects
// a tenant-scoped (non-system) caller's INSERT/SELECT. This block forges
// both as `breeze_app` running under a normal tenant context and asserts
// the table is locked down by FORCE ROW LEVEL SECURITY with no permissive
// policies; the system-scope branch confirms the write path that
// ensureActiveSigningKey relies on still works.
// ===========================================================================
describe('manifest_signing_keys RLS — system-only enforcement (#639)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const insertedKeyIds: string[] = [];

  // Build a tenant-scoped DbAccessContext that grants no orgs / no partners.
  // Under this context, breeze_app should be unable to touch
  // manifest_signing_keys — the table has ENABLE + FORCE RLS and no
  // permissive policies, so only the system context branch (which bypasses
  // RLS via runOutsideDbContext + withSystemDbAccessContext) can read/write.
  const tenantCtx = {
    scope: 'organization' as const,
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [],
    userId: null,
  };

  afterAll(async () => {
    if (insertedKeyIds.length === 0) return;
    await withSystemDbAccessContext(async () => {
      for (const keyId of insertedKeyIds) {
        await db
          .delete(manifestSigningKeys)
          .where(eq(manifestSigningKeys.keyId, keyId));
      }
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT as breeze_app under a tenant context is rejected by RLS',
    async () => {
      let caught: unknown;
      try {
        await withDbAccessContext(tenantCtx, async () =>
          db.insert(manifestSigningKeys).values({
            keyId: `rls-forge-deny-${runSuffix}`,
            publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            privateKeyEnc: 'enc:v1:forge',
            status: 'active',
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const cause = caught as
        | { cause?: { message?: string }; message?: string }
        | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      // Two acceptable rejection surfaces: a row-level-security policy
      // denial (USING/WITH CHECK on a permissive policy) or a permission
      // denied on the relation (no policy = no access by default once
      // FORCE RLS is on for the table's owner-equivalents too).
      expect(message).toMatch(
        /row-level security|permission denied|new row violates row-level security/i,
      );
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'SELECT as breeze_app under a tenant context returns zero rows',
    async () => {
      // Seed a row via system context so there's something to fail to see.
      const seededKeyId = `rls-forge-seed-${runSuffix}`;
      await withSystemDbAccessContext(async () => {
        await db.insert(manifestSigningKeys).values({
          keyId: seededKeyId,
          publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          privateKeyEnc: 'enc:v1:forge',
          status: 'active',
        });
      });
      insertedKeyIds.push(seededKeyId);

      // Now read under a tenant context. RLS with no permissive policy
      // means the SELECT returns 0 rows OR Postgres throws permission
      // denied — assert either outcome explicitly.
      let rows: unknown[] = [];
      let err: unknown = null;
      try {
        rows = await withDbAccessContext(tenantCtx, async () =>
          db
            .select({ keyId: manifestSigningKeys.keyId })
            .from(manifestSigningKeys),
        );
      } catch (e) {
        err = e;
      }

      if (err) {
        const cause = err as
          | { cause?: { message?: string }; message?: string };
        const message = cause?.cause?.message ?? cause?.message ?? '';
        expect(message).toMatch(/permission denied|row-level security/i);
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT under system context succeeds',
    async () => {
      const keyId = `rls-forge-system-${runSuffix}`;
      const result = await withSystemDbAccessContext(async () => {
        return db
          .insert(manifestSigningKeys)
          .values({
            keyId,
            publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            privateKeyEnc: 'enc:v1:forge',
            status: 'retired',
          })
          .returning({ keyId: manifestSigningKeys.keyId });
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.keyId).toBe(keyId);
      insertedKeyIds.push(keyId);
    },
  );
});

// ===========================================================================
// automation_runs — parent-FK join-policy forge test (Shape 7, findings F2/F3)
//
// The pg_catalog assertion above only proves a parent-join policy exists per
// DML command. It does NOT prove Postgres actually hides another tenant's run.
// automation_runs WAS the F2/F3 finding: no org_id, no RLS, and the
// config-policy branch of GET /automations/runs/:runId returned the row with
// no org check. This block forges cross-org reads/writes as `breeze_app` (the
// unprivileged role) under real tenant contexts and asserts the new
// EXISTS-join policy is enforced in practice — the durable backstop behind the
// app-layer canAccessOrg fix in routes/automations.ts. Self-contained so it
// runs under vitest.config.rls-coverage.ts (no setup.ts / no TRUNCATE):
// fixtures are seeded via withSystemDbAccessContext and torn down by id.
// ===========================================================================
describe('automation_runs RLS — cross-org forge enforcement (Shape 7)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let partnerId: string;
  let orgAId: string;
  let orgBId: string;
  let automationAId: string;
  let runAId: string | null = null;
  // Config-policy-driven run: automation_id is NULL, org reached via
  // config_policy_id -> configuration_policies.org_id (the F2/F3 leak path).
  let configPolicyAId: string;
  let configRunAId: string | null = null;

  // Org-scoped context granting access to exactly one org and nothing else,
  // so no other policy can accidentally green-light a cross-org row.
  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS AutoRuns Partner ${runSuffix}`,
          slug: `rls-autoruns-${runSuffix}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for automation_runs forge');
      partnerId = partner.id;

      const [orgA, orgB] = await db
        .insert(organizations)
        .values([
          { partnerId: partner.id, name: 'RLS AutoRuns Org A', slug: `rls-autoruns-a-${runSuffix}` },
          { partnerId: partner.id, name: 'RLS AutoRuns Org B', slug: `rls-autoruns-b-${runSuffix}` },
        ])
        .returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for automation_runs forge');
      orgAId = orgA.id;
      orgBId = orgB.id;

      const [automationA] = await db
        .insert(automations)
        .values({
          orgId: orgA.id,
          name: 'Org A automation',
          trigger: { type: 'manual' },
          actions: [],
        })
        .returning({ id: automations.id });
      if (!automationA) throw new Error('failed to seed automation for automation_runs forge');
      automationAId = automationA.id;

      const [runA] = await db
        .insert(automationRuns)
        .values({
          automationId: automationA.id,
          triggeredBy: 'rls-forge-test',
          status: 'completed',
        })
        .returning({ id: automationRuns.id });
      if (!runA) throw new Error('failed to seed automation_run for forge');
      runAId = runA.id;

      // Config-policy-driven run flavor (automation_id NULL): reaches its org
      // only via config_policy_id -> configuration_policies.org_id.
      const [policyA] = await db
        .insert(configurationPolicies)
        .values({ orgId: orgA.id, name: 'Org A config policy' })
        .returning({ id: configurationPolicies.id });
      if (!policyA) throw new Error('failed to seed configuration_policy for forge');
      configPolicyAId = policyA.id;

      const [configRunA] = await db
        .insert(automationRuns)
        .values({
          configPolicyId: policyA.id, // automationId intentionally left NULL
          configItemName: 'Org A config item',
          triggeredBy: 'rls-forge-test',
          status: 'completed',
        })
        .returning({ id: automationRuns.id });
      if (!configRunA) throw new Error('failed to seed config-policy automation_run for forge');
      configRunAId = configRunA.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      // Delete runs by automation_id (not just the seeded runAId) so a stray
      // run from a forged INSERT — which exists only when RLS is NOT yet
      // enforcing, i.e. a failing pre-migration run — can't block the parent
      // automation delete via FK.
      if (automationAId) {
        await db.delete(automationRuns).where(eq(automationRuns.automationId, automationAId));
      }
      if (automationAId) await db.delete(automations).where(eq(automations.id, automationAId));
      // Config-policy runs (automation_id NULL) aren't caught by the automationId
      // delete above; clear them + the policy before deleting the org (FK order).
      if (configPolicyAId) {
        await db.delete(automationRuns).where(eq(automationRuns.configPolicyId, configPolicyAId));
        await db.delete(configurationPolicies).where(eq(configurationPolicies.id, configPolicyAId));
      }
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'org A (owner) can SELECT its own automation_run via the parent-join policy',
    async () => {
      await ensureFixtures();
      const rows = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, runAId!)),
      );
      expect(rows.map((r) => r.id)).toEqual([runAId]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B cannot SELECT org A's automation_run (RLS hides it — the F2/F3 leak)",
    async () => {
      await ensureFixtures();
      if (!runAId) throw new Error('seed test must run first');
      const rows = await withDbAccessContext(orgContext(orgBId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, runAId!)),
      );
      expect(rows).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT referencing org A's automation is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(automationRuns).values({
            automationId: automationAId, // forging a run under another tenant's automation
            triggeredBy: 'rls-forge-test-crossorg',
            status: 'running',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(
        /new row violates row-level security policy for table "automation_runs"/,
      );
    },
  );

  // --- config-policy-driven runs (automation_id NULL) — the F2/F3 branch ---
  it.runIf(!!process.env.DATABASE_URL)(
    'org A can SELECT its config-policy automation_run (config_policy_id reach)',
    async () => {
      await ensureFixtures();
      const rows = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, configRunAId!)),
      );
      expect(rows.map((r) => r.id)).toEqual([configRunAId]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B cannot SELECT org A's config-policy automation_run (RLS hides it)",
    async () => {
      await ensureFixtures();
      if (!configRunAId) throw new Error('seed test must run first');
      const rows = await withDbAccessContext(orgContext(orgBId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, configRunAId!)),
      );
      expect(rows).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT referencing org A's config policy is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(automationRuns).values({
            configPolicyId: configPolicyAId, // forging a run under another tenant's config policy
            configItemName: 'forged',
            triggeredBy: 'rls-forge-test-crossorg-cp',
            status: 'running',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(
        /new row violates row-level security policy for table "automation_runs"/,
      );
    },
  );
});

// ===========================================================================
// script_execution_batches RLS — denormalized org_id (2026-05-31 review fix)
//
// Batches carry a denormalized org_id (the executing org), so the policy is a
// direct breeze_has_org_access(org_id) — no nested-RLS join through the
// nullable-org `scripts` parent. This forge proves the two things the nested
// `is_system` join FAILED at under the production driver's bound-parameter
// INSERTs: (a) a tenant CAN insert a batch for a SYSTEM script under tenant
// context (org_id = its own org), and (b) cross-org isolation holds — org B
// cannot read org A's batch, and a forged cross-org INSERT is rejected.
// ===========================================================================
describe('script_execution_batches RLS — denormalized org_id', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let partnerId: string;
  let orgAId: string;
  let orgBId: string;
  let systemScriptId: string;
  let batchAId: string | null = null;

  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Batches Partner ${runSuffix}`,
          slug: `rls-batches-${runSuffix}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for batches forge');
      partnerId = partner.id;

      const [orgA, orgB] = await db
        .insert(organizations)
        .values([
          { partnerId: partner.id, name: 'RLS Batches Org A', slug: `rls-batches-a-${runSuffix}` },
          { partnerId: partner.id, name: 'RLS Batches Org B', slug: `rls-batches-b-${runSuffix}` },
        ])
        .returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for batches forge');
      orgAId = orgA.id;
      orgBId = orgB.id;

      // A SYSTEM script (org_id NULL, is_system) — the case the nested-RLS join
      // could not handle. With denormalization the batch (not the script) holds
      // the executing org.
      const [systemScript] = await db
        .insert(scripts)
        .values({
          orgId: null,
          isSystem: true,
          name: 'System script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo sys',
        })
        .returning({ id: scripts.id });
      if (!systemScript) throw new Error('failed to seed system script for batches forge');
      systemScriptId = systemScript.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (systemScriptId) await db.delete(scriptExecutionBatches).where(eq(scriptExecutionBatches.scriptId, systemScriptId));
      if (systemScriptId) await db.delete(scripts).where(eq(scripts.id, systemScriptId));
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'org A CAN INSERT a batch for a system script under tenant context (denormalized org_id; bound-parameter INSERT now works)',
    async () => {
      await ensureFixtures();
      const inserted = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .insert(scriptExecutionBatches)
          .values({ scriptId: systemScriptId, orgId: orgAId, devicesTargeted: 2, status: 'pending' })
          .returning({ id: scriptExecutionBatches.id }),
      );
      expect(inserted).toHaveLength(1);
      batchAId = inserted[0]!.id;
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org A SELECTs its own batch; org B cannot (cross-org isolation)",
    async () => {
      await ensureFixtures();
      if (!batchAId) throw new Error('insert test must run first');
      const a = await withDbAccessContext(orgContext(orgAId), async () =>
        db.select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches).where(eq(scriptExecutionBatches.id, batchAId!)),
      );
      expect(a.map((r) => r.id)).toEqual([batchAId]);
      const b = await withDbAccessContext(orgContext(orgBId), async () =>
        db.select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches).where(eq(scriptExecutionBatches.id, batchAId!)),
      );
      expect(b).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT with org_id = org A is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(scriptExecutionBatches).values({ scriptId: systemScriptId, orgId: orgAId, devicesTargeted: 2, status: 'pending' }),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/new row violates row-level security policy for table "script_execution_batches"/);
    },
  );
});
