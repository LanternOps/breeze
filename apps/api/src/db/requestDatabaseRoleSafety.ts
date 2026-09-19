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
