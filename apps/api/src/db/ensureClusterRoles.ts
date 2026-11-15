import type postgres from 'postgres';
import { pgErrorCode } from '../utils/pgErrors';

/**
 * Re-asserts the cluster-level roles the migrations assume (#11929).
 *
 * Roles and role memberships belong to the Postgres CLUSTER, not to a
 * database. A database-only `pg_dump` / `pg_restore` into a new cluster (a
 * major-version upgrade, a host move) therefore loses them, while the
 * migration ledger that created them comes across intact and says "already
 * applied". Nothing re-ran the migration, so:
 *
 *  - `breeze_app` lost its membership in `breeze_audit_admin`, and every
 *    `SET LOCAL ROLE breeze_audit_admin` (permanent device delete, org erasure,
 *    audit / PAM / AI-ledger retention) failed with 42501 at first use.
 *  - When the roles did not exist at all during the restore, every GRANT and
 *    policy naming them failed too. pg_restore emits one ACL item per object
 *    with all of its grants, so a single missing role rolls back the grants to
 *    the roles that did exist on that object as well.
 *
 * `ensureAppRole()` already recreates `breeze_app`; this does the same for the
 * two roles created only by migrations, and puts back what boot can safely
 * re-assert. It runs from autoMigrate, before migrations (`pre-migration`:
 * roles only, so a newer migration that GRANTs to them can apply on a restored
 * database) and after (`post-migration`: also object privileges).
 *
 * Every step is its own transaction with the catch OUTSIDE it, and no failure
 * is fatal: on managed Postgres the migration role is often not a superuser,
 * and on a restored cluster it may not hold ADMIN OPTION on a role a superuser
 * created. Those land as warnings that print the exact statement to run as a
 * superuser. A boot that worked before this step existed must keep working.
 *
 * The membership is re-granted ONLY when `AUDIT_ADMIN_DATABASE_URL` is unset.
 * With a dedicated audit-admin connection configured, revoking the membership
 * is the documented hardening step (migration 2026-06-11-e); boot must never
 * undo it.
 */

export type ClusterRolePhase = 'pre-migration' | 'post-migration';

export interface ClusterRoleReport {
  /** Changes this run made (one line each). */
  applied: string[];
  /** Things it could not fix, each with the statement to run by hand. */
  warnings: string[];
}

interface Logger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface EnsureClusterRolesOptions {
  phase: ClusterRolePhase;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

const LOG = '[cluster-roles]';
const APP_ROLE = 'breeze_app';
const AUDIT_ADMIN_ROLE = 'breeze_audit_admin';
const SEARCH_ROLE = 'breeze_search';

/**
 * The roles migrations create, with the attributes they create them with
 * (2026-05-25-i: bare `CREATE ROLE breeze_audit_admin`, which defaults to
 * NOLOGIN; 2026-07-16 td-synnex: `CREATE ROLE breeze_search NOLOGIN`). An
 * existing role is never altered: an operator who gave breeze_audit_admin a
 * LOGIN and password for AUDIT_ADMIN_DATABASE_URL keeps them.
 */
export const MIGRATION_CREATED_ROLES = [
  { name: AUDIT_ADMIN_ROLE, create: `CREATE ROLE ${AUDIT_ADMIN_ROLE} NOLOGIN` },
  { name: SEARCH_ROLE, create: `CREATE ROLE ${SEARCH_ROLE} NOLOGIN` },
] as const;

/**
 * Every table privilege the migrations grant to breeze_audit_admin. Pinned
 * against a migrated database by clusterRolesRestore.integration.test.ts: a
 * migration that grants this role a new privilege fails that test until the
 * privilege is listed here, so a restore cannot silently lose it.
 */
export const AUDIT_ADMIN_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  agent_rollback_events: ['SELECT', 'DELETE'],
  ai_invocations: ['SELECT', 'DELETE'],
  ai_operator_task_events: ['SELECT', 'DELETE'],
  audit_chain_anchors: ['SELECT', 'DELETE'],
  audit_log_chain: ['SELECT', 'DELETE'],
  // UPDATE: retention re-anchors the chain after a prefix cut (2026-05-25-j).
  audit_logs: ['SELECT', 'DELETE', 'UPDATE'],
  contract_documents: ['SELECT', 'DELETE'],
  elevation_audit: ['SELECT', 'DELETE'],
  elevation_requests: ['SELECT', 'DELETE'],
  ml_feedback_events: ['SELECT', 'DELETE'],
  org_autopay_consents: ['SELECT', 'DELETE'],
  org_evidence_holds: ['SELECT'],
  pam_actuation_results: ['SELECT', 'DELETE'],
  pam_actuations: ['SELECT', 'DELETE'],
  peripheral_policy_delivery_events: ['SELECT', 'DELETE'],
  script_proposal_reviews: ['SELECT', 'DELETE'],
};

/**
 * Functions the RLS policies on the PAM tables call (2026-12-24-220000). A
 * policy expression runs with the querying role's privileges, so without
 * EXECUTE every breeze_audit_admin statement on those tables fails.
 */
export const AUDIT_ADMIN_FUNCTION_PRIVILEGES: readonly string[] = [
  'public.breeze_merged_lineage_org_ids()',
  'public.breeze_has_merged_lineage_access(uuid)',
];

const SEARCH_TABLE = 'td_synnex_price_availability';
const SEARCH_POLICY = 'td_synnex_pa_search_fn';
const SEARCH_FUNCTION = 'public.breeze_search_td_synnex_pa(text[], boolean, integer, integer)';

/** Same setting autoMigrate gives a migration (migrationSessionSql): a role a
 *  CREATEROLE (non-superuser) migrator creates is granted back to it with SET,
 *  so it can later hand that role object ownership. */
const SESSION_SQL = `DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    PERFORM set_config('createrole_self_grant', 'set, inherit', true);
  END IF;
END $$;`;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function hasDedicatedAuditAdminUrl(env: NodeJS.ProcessEnv): boolean {
  const url = env.AUDIT_ADMIN_DATABASE_URL;
  return typeof url === 'string' && url.trim().length > 0;
}

export async function ensureClusterRoles(
  client: postgres.Sql,
  options: EnsureClusterRolesOptions,
): Promise<ClusterRoleReport> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const report: ClusterRoleReport = { applied: [], warnings: [] };

  /**
   * Run one fix in its own transaction. A failed statement aborts only its own
   * transaction, and the catch sits outside it, so later steps still run.
   */
  const step = async (label: string, statements: string): Promise<boolean> => {
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(SESSION_SQL);
        await tx.unsafe(statements);
      });
      report.applied.push(label);
      logger.log(`${LOG} ${label}`);
      return true;
    } catch (err) {
      const code = pgErrorCode(err);
      const reason = code === '42501'
        ? 'the migration role lacks the privilege (SQLSTATE 42501)'
        : `${describeError(err)}${code ? ` (SQLSTATE ${code})` : ''}`;
      const warning = `${LOG} Could not ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${reason}. `
        + `Run as a database superuser:\n${statements.trim()}`;
      report.warnings.push(warning);
      logger.warn(warning);
      return false;
    }
  };

  let existing: Set<string>;
  try {
    existing = await existingRoles(client);
  } catch (err) {
    // Reading pg_roles needs no privilege; if even that fails, there is
    // nothing useful to do here. Leave the diagnosis to the startup check.
    const warning = `${LOG} Skipped: could not read pg_roles: ${describeError(err)}`;
    report.warnings.push(warning);
    logger.warn(warning);
    return report;
  }

  // 1. Roles.
  for (const role of MIGRATION_CREATED_ROLES) {
    if (existing.has(role.name)) continue;
    if (await step(`Created missing role ${role.name}`, `${role.create};`)) existing.add(role.name);
  }

  // 2. breeze_app's membership in breeze_audit_admin (the 42501 in #11929).
  if (!hasDedicatedAuditAdminUrl(env) && existing.has(APP_ROLE) && existing.has(AUDIT_ADMIN_ROLE)) {
    let member = true;
    try {
      member = await isMember(client, APP_ROLE, AUDIT_ADMIN_ROLE);
    } catch (err) {
      const warning = `${LOG} Could not check ${APP_ROLE}'s membership in ${AUDIT_ADMIN_ROLE}: ${describeError(err)}`;
      report.warnings.push(warning);
      logger.warn(warning);
    }
    if (!member) {
      await step(
        `Restored ${APP_ROLE}'s membership in ${AUDIT_ADMIN_ROLE} (missing: usually a database-only restore into a new cluster)`,
        `GRANT ${AUDIT_ADMIN_ROLE} TO ${APP_ROLE};`,
      );
    }
  }

  if (options.phase === 'post-migration') {
    // The detection queries read catalogs only, but a failure in one must not
    // take boot down either: report it and move on to the next section.
    const section = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        const warning = `${LOG} Skipped the ${label} check: ${describeError(err)}`;
        report.warnings.push(warning);
        logger.error(warning);
      }
    };
    if (existing.has(AUDIT_ADMIN_ROLE)) {
      await section(`${AUDIT_ADMIN_ROLE} privilege`, () => ensureAuditAdminPrivileges(client, step));
    }
    if (existing.has(SEARCH_ROLE)) {
      await section(`${SEARCH_ROLE} object`, () => ensureSearchRoleObjects(client, existing, step));
    }
    await section(`${APP_ROLE} policy`, () => reportLostAppRolePolicies(client, report, logger));
  }

  return report;
}

type Step = (label: string, statements: string) => Promise<boolean>;

async function existingRoles(client: postgres.Sql): Promise<Set<string>> {
  const names = [APP_ROLE, ...MIGRATION_CREATED_ROLES.map((r) => r.name)];
  const rows = await client<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE rolname = ANY(${names})
  `;
  return new Set(rows.map((r) => r.rolname));
}

async function isMember(client: postgres.Sql, member: string, role: string): Promise<boolean> {
  const [row] = await client<{ member: boolean }[]>`
    SELECT pg_has_role(${member}, ${role}, 'MEMBER') AS member
  `;
  return Boolean(row?.member);
}

/** Grant breeze_audit_admin whatever the manifest lists and it lacks. Only
 *  missing privileges are granted, so a healthy database issues no GRANT and a
 *  migration role that cannot grant logs nothing on a healthy boot. */
async function ensureAuditAdminPrivileges(client: postgres.Sql, step: Step): Promise<void> {
  const tablePairs = Object.entries(AUDIT_ADMIN_TABLE_PRIVILEGES)
    .flatMap(([table, privileges]) => privileges.map((privilege) => ({ table, privilege })));
  const missing = await client<{ table: string; privilege: string }[]>`
    SELECT p.table, p.privilege
      FROM unnest(${tablePairs.map((x) => x.table)}::text[], ${tablePairs.map((x) => x.privilege)}::text[])
           AS p("table", privilege)
     WHERE to_regclass('public.' || quote_ident(p.table)) IS NOT NULL
       AND NOT has_table_privilege(${AUDIT_ADMIN_ROLE}, to_regclass('public.' || quote_ident(p.table)), p.privilege)
     ORDER BY 1, 2
  `;
  const byTable = new Map<string, string[]>();
  for (const row of missing) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row.privilege]);
  for (const [table, privileges] of byTable) {
    await step(
      `Granted ${privileges.join(', ')} on ${table} to ${AUDIT_ADMIN_ROLE}`,
      `GRANT ${privileges.join(', ')} ON TABLE public.${table} TO ${AUDIT_ADMIN_ROLE};`,
    );
  }

  const missingFunctions = await client<{ fn: string }[]>`
    SELECT f.fn
      FROM unnest(${AUDIT_ADMIN_FUNCTION_PRIVILEGES as string[]}::text[]) AS f(fn)
     WHERE to_regprocedure(f.fn) IS NOT NULL
       AND NOT has_function_privilege(${AUDIT_ADMIN_ROLE}, to_regprocedure(f.fn), 'EXECUTE')
  `;
  for (const { fn } of missingFunctions) {
    await step(
      `Granted EXECUTE on ${fn} to ${AUDIT_ADMIN_ROLE}`,
      `GRANT EXECUTE ON FUNCTION ${fn} TO ${AUDIT_ADMIN_ROLE};`,
    );
  }
}

/**
 * breeze_search exists only to own one SECURITY DEFINER search function
 * (2026-07-16 td-synnex migration). On a restore without the role, its
 * ownership, its SELECT grant, its policy and the function's ACL are all lost
 * and the function is left owned by whoever restored it — usually a superuser,
 * which a SECURITY DEFINER function must not run as. Each piece is re-asserted
 * exactly as the migration wrote it, and only when it is missing.
 */
async function ensureSearchRoleObjects(
  client: postgres.Sql,
  existing: Set<string>,
  step: Step,
): Promise<void> {
  const [state] = await client<{
    hasTable: boolean;
    hasSelect: boolean;
    hasPolicy: boolean;
    hasFunction: boolean;
    ownedBySearch: boolean;
    publicExecute: boolean;
    appExecute: boolean;
  }[]>`
    SELECT
      to_regclass(${`public.${SEARCH_TABLE}`}) IS NOT NULL AS "hasTable",
      COALESCE(has_table_privilege(${SEARCH_ROLE}, to_regclass(${`public.${SEARCH_TABLE}`}), 'SELECT'), false) AS "hasSelect",
      EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = ${SEARCH_TABLE} AND policyname = ${SEARCH_POLICY}) AS "hasPolicy",
      to_regprocedure(${SEARCH_FUNCTION}) IS NOT NULL AS "hasFunction",
      COALESCE((SELECT pg_get_userbyid(proowner) = ${SEARCH_ROLE} FROM pg_proc WHERE oid = to_regprocedure(${SEARCH_FUNCTION})), false) AS "ownedBySearch",
      COALESCE((SELECT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc WHERE oid = to_regprocedure(${SEARCH_FUNCTION})), false) AS "publicExecute",
      COALESCE((SELECT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) a
         JOIN pg_roles r ON r.oid = a.grantee
         WHERE r.rolname = ${APP_ROLE} AND a.privilege_type = 'EXECUTE')
        FROM pg_proc WHERE oid = to_regprocedure(${SEARCH_FUNCTION})), false) AS "appExecute"
  `;
  if (!state) return;

  if (state.hasTable && !state.hasSelect) {
    await step(
      `Granted SELECT on ${SEARCH_TABLE} to ${SEARCH_ROLE}`,
      `GRANT SELECT ON TABLE public.${SEARCH_TABLE} TO ${SEARCH_ROLE};`,
    );
  }
  if (state.hasTable && !state.hasPolicy) {
    await step(
      `Recreated policy ${SEARCH_POLICY} on ${SEARCH_TABLE}`,
      `CREATE POLICY ${SEARCH_POLICY} ON public.${SEARCH_TABLE} FOR SELECT TO ${SEARCH_ROLE} USING (true);`,
    );
  }
  if (!state.hasFunction) return;
  if (!state.ownedBySearch) {
    // Mirrors the migration: the new owner needs CREATE on the schema for the
    // ALTER on a non-superuser migrator; it is revoked again in the same
    // transaction, so a failure leaves no stray grant behind.
    await step(
      `Made ${SEARCH_ROLE} the owner of ${SEARCH_FUNCTION}`,
      `GRANT CREATE ON SCHEMA public TO ${SEARCH_ROLE};
ALTER FUNCTION ${SEARCH_FUNCTION} OWNER TO ${SEARCH_ROLE};
REVOKE CREATE ON SCHEMA public FROM ${SEARCH_ROLE};`,
    );
  }
  if (state.publicExecute || (existing.has(APP_ROLE) && !state.appExecute)) {
    await step(
      `Restored the EXECUTE grants on ${SEARCH_FUNCTION}`,
      `REVOKE ALL ON FUNCTION ${SEARCH_FUNCTION} FROM PUBLIC;${
        existing.has(APP_ROLE) ? `\nGRANT EXECUTE ON FUNCTION ${SEARCH_FUNCTION} TO ${APP_ROLE};` : ''}`,
    );
  }
}

/**
 * The part boot cannot repair. Dozens of RLS policies are `TO breeze_app`; a
 * restore that ran before breeze_app existed drops every one of them, and their
 * definitions live only in the migrations. A migrated database always has some,
 * so none at all is an unambiguous sign of that restore. Tables with FORCE ROW
 * LEVEL SECURITY then deny the API those rows (fails closed), so say what
 * happened and how to recover instead of leaving it to look like a data loss.
 */
async function reportLostAppRolePolicies(
  client: postgres.Sql,
  report: ClusterRoleReport,
  logger: Logger,
): Promise<void> {
  const [row] = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_policies WHERE ${APP_ROLE} = ANY(roles)
  `;
  if ((row?.n ?? 0) > 0) return;
  const warning = `${LOG} This database has no row-level security policies for ${APP_ROLE}. `
    + 'That happens when a dump is restored into a cluster where the Breeze roles did not exist yet: '
    + 'every policy and grant naming them fails to restore. The API cannot recreate those policies. '
    + 'Restore again into an empty database after creating the roles first (scripts/restore.sh does this, '
    + 'or restore `pg_dumpall --globals-only` from the old cluster). See the Backup and Restore docs.';
  report.warnings.push(warning);
  logger.error(warning);
}
