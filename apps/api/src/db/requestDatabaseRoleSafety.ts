/**
 * Pure helpers describing what makes the request-pool database role acceptable.
 *
 * Deliberately dependency-free: `db/databaseStartup.ts` imports these at module
 * load, and it must stay importable without instantiating the postgres.js pool
 * that `db/index.ts` creates as a side effect of being imported.
 */

export interface RequestDatabaseRole {
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  /**
   * Whether the request role may `SET ROLE breeze_audit_admin` (#11929): null
   * when that role does not exist, undefined when not probed.
   */
  auditAdminMember?: boolean | null;
}

/**
 * Without AUDIT_ADMIN_DATABASE_URL, permanent device delete, org erasure and
 * the audit, PAM and AI-ledger retention jobs all `SET LOCAL ROLE
 * breeze_audit_admin` on the request pool. When the role cannot do that (the
 * membership is cluster-level and a database-only restore drops it) they fail
 * with 42501 at first use. Permanent device delete needs it even with
 * AUDIT_ADMIN_DATABASE_URL set. Returns the boot message to log, or null when
 * the membership is present or was not probed.
 */
export function auditAdminAccessProblem(
  role: RequestDatabaseRole,
  env: NodeJS.ProcessEnv,
): string | null {
  const dedicated = typeof env.AUDIT_ADMIN_DATABASE_URL === 'string'
    && env.AUDIT_ADMIN_DATABASE_URL.trim().length > 0;
  if (role.auditAdminMember === undefined || role.auditAdminMember === true) return null;
  const what = role.auditAdminMember === null
    ? 'the breeze_audit_admin role does not exist'
    : `"${role.currentUser}" is not a member of breeze_audit_admin`;
  const fix = role.auditAdminMember === null
    ? `CREATE ROLE breeze_audit_admin NOLOGIN; then restart the API so it re-grants its table privileges, and run GRANT breeze_audit_admin TO ${role.currentUser};`
    : `GRANT breeze_audit_admin TO ${role.currentUser};`;
  if (dedicated) {
    // Retention and org erasure use the dedicated connection, but permanent
    // device delete removes evidence in the same transaction as the device
    // and so still switches role on the request connection (deviceDeletion.ts).
    return `[database] ${what}. AUDIT_ADMIN_DATABASE_URL is set, so retention and organization erasure use `
      + 'that connection, but permanent device delete still needs the membership and will fail with '
      + `SQLSTATE 42501. If that is not intended, run as a database superuser: ${fix}`;
  }
  return `[database] ${what}, and AUDIT_ADMIN_DATABASE_URL is not set. Permanent device delete, `
    + 'organization erasure and audit-log retention will fail with SQLSTATE 42501. This usually follows a '
    + 'database-only restore into a new Postgres cluster: roles and memberships belong to the cluster and '
    + `are not in a pg_dump. Run as a database superuser: ${fix} No restart is needed for the GRANT.`;
}

export const REQUEST_DATABASE_ROLE_REMEDIATION =
  'Set DATABASE_URL_APP to a NOSUPERUSER NOBYPASSRLS role, or configure ' +
  'BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL.';

/**
 * Break-glass switch for local setups that knowingly run the request pool as a
 * privileged role (e.g. a bare `pnpm dev` against a single-role Postgres).
 * Honoured only outside production, and only with a loud log line: the whole
 * point is that skipping the check is a deliberate, visible act rather than a
 * side effect of how some other variable happens to be spelled.
 */
export const UNSAFE_DB_ROLE_OPT_OUT_ENV = 'BREEZE_ALLOW_UNSAFE_DB_ROLE';

const OPT_OUT_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isUnsafeDbRoleOptOutEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[UNSAFE_DB_ROLE_OPT_OUT_ENV]?.trim().toLowerCase();
  return raw !== undefined && OPT_OUT_TRUTHY.has(raw);
}

/** Capability names that disqualify a role from serving tenant-scoped queries. */
export function unsafeRequestDatabaseRoleCapabilities(
  role: RequestDatabaseRole,
): string[] {
  const capabilities: string[] = [];
  if (role.isSuperuser) capabilities.push('SUPERUSER');
  if (role.bypassesRls) capabilities.push('BYPASSRLS');
  return capabilities;
}

export function formatUnsafeRequestDatabaseRoleMessage(
  role: RequestDatabaseRole,
  capabilities: string[],
  options: { advertiseOptOut?: boolean } = {},
): string {
  const optOut = options.advertiseOptOut
    ? ` For a local, non-production database only, set ${UNSAFE_DB_ROLE_OPT_OUT_ENV}=true to ` +
      'start anyway — row-level security will not be enforced.'
    : '';
  return (
    `[database] Unsafe effective request database role "${role.currentUser}": ` +
    `${capabilities.join(' and ')}. Request handlers require a ` +
    `NOSUPERUSER NOBYPASSRLS role. ${REQUEST_DATABASE_ROLE_REMEDIATION}${optOut}`
  );
}

/** The banner printed when the opt-out is honoured. Intentionally unmissable. */
export function formatUnsafeDbRoleOptOutBanner(
  role: RequestDatabaseRole,
  capabilities: string[],
): string {
  return [
    '',
    '='.repeat(78),
    `[database] ${UNSAFE_DB_ROLE_OPT_OUT_ENV} is set — starting with an unsafe request role.`,
    `[database]   role: "${role.currentUser}" (${capabilities.join(' and ')})`,
    '[database]   Row-level security is bypassed on the request pool:',
    '[database]   tenant isolation is NOT enforced for any query this process serves.',
    `[database]   Never set ${UNSAFE_DB_ROLE_OPT_OUT_ENV} on a deployment holding real data.`,
    `[database]   ${REQUEST_DATABASE_ROLE_REMEDIATION}`,
    '='.repeat(78),
    '',
  ].join('\n');
}
