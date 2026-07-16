export type RequestDatabaseConfigSource =
  | 'explicit'
  | 'derived'
  | 'development-fallback';

export interface RequestDatabaseConfig {
  url: string;
  source: RequestDatabaseConfigSource;
}

export function selectAppRolePassword(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.BREEZE_APP_DB_PASSWORD?.trim()) return env.BREEZE_APP_DB_PASSWORD;
  if (env.POSTGRES_PASSWORD?.trim()) return env.POSTGRES_PASSWORD;
  return undefined;
}

type RequestDatabaseConfigLogger = Pick<Console, 'log' | 'warn'>;

const CONNECTION_URL_GUIDANCE =
  'Configure a valid PostgreSQL URL for a database/HA endpoint.';
const MULTI_HOST_DERIVATION_GUIDANCE =
  'Set an explicit DATABASE_URL_APP for postgres.js multi-host/HA URLs.';

function connectionHostSegment(connectionUrl: string): string | null {
  const authority = connectionUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1];
  if (authority === undefined) return null;
  return authority.slice(authority.lastIndexOf('@') + 1);
}

function usesMultipleHosts(connectionUrl: string): boolean {
  const hostSegment = connectionHostSegment(connectionUrl);
  if (hostSegment === null) return false;
  try {
    return decodeURIComponent(hostSegment).includes(',');
  } catch {
    return /,|%2c/iu.test(hostSegment);
  }
}

function parseConnectionUrl(connectionUrl: string, source: string): URL {
  const error = new Error(`[database] ${source} is invalid. ${CONNECTION_URL_GUIDANCE}`);

  try {
    const match = connectionUrl.match(
      /^((?:postgres|postgresql):\/\/)([^/?#]*)(.*)$/iu,
    );
    if (!match) throw error;

    const scheme = match[1];
    const authority = match[2];
    const suffix = match[3];
    if (!scheme || authority === undefined || suffix === undefined) throw error;
    const userInfoEnd = authority.lastIndexOf('@');
    const userInfo = userInfoEnd >= 0 ? authority.slice(0, userInfoEnd + 1) : '';
    const encodedHosts = authority.slice(userInfoEnd + 1);
    const endpoints = decodeURIComponent(encodedHosts).split(',');
    if (endpoints.length === 0 || endpoints.some((endpoint) => !endpoint)) {
      throw error;
    }

    let firstParsed: URL | undefined;
    for (const endpoint of endpoints) {
      if (/[/?#@\s]/u.test(endpoint)) throw error;
      const parsed = new URL(`${scheme}${userInfo}${endpoint}${suffix}`);
      if (!parsed.hostname || parsed.hostname.includes(',')) throw error;
      firstParsed ??= parsed;
    }
    return firstParsed!;
  } catch {
    // URL parser errors can expose the parser's credential-bearing `.input`.
    // Always replace them with the fixed, actionable message above.
    throw error;
  }
}

export function logRequestDatabaseConfigSource(
  config: RequestDatabaseConfig,
  logger: RequestDatabaseConfigLogger = console,
): void {
  const message = `[database] Request pool configuration source: ${config.source}`;
  if (config.source === 'development-fallback') {
    logger.warn(message);
    return;
  }
  logger.log(message);
}

export function deriveAppConnectionString(
  adminUrl: string,
  appPassword: string | undefined,
): string | null {
  if (!appPassword) return null;

  try {
    const url = parseConnectionUrl(adminUrl, 'DATABASE_URL');
    url.username = 'breeze_app';
    // postgres.js decodes the URL password with decodeURIComponent() at connect
    // time (postgres@3.4.9 src/index.js:550). The WHATWG `password` setter does
    // NOT percent-encode a literal '%', so an unescaped password byte would
    // either silently change (e.g. 'pa%20ss' -> 'pa ss') or throw "URI
    // malformed" (e.g. '50%off') on decode — diverging from the raw bytes
    // ensureAppRole() sets on the role and breaking auth. Percent-encode so the
    // decode round-trips to the exact password bytes.
    url.password = encodeURIComponent(appPassword);
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveRequestDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): RequestDatabaseConfig {
  const explicit = env.DATABASE_URL_APP?.trim();
  if (explicit) {
    parseConnectionUrl(explicit, 'DATABASE_URL_APP');
    return { url: explicit, source: 'explicit' };
  }

  const adminUrl =
    env.DATABASE_URL?.trim() || 'postgresql://breeze:breeze@localhost:5432/breeze';
  const password = selectAppRolePassword(env);
  if (password && usesMultipleHosts(adminUrl)) {
    throw new Error(
      `[database] Cannot derive the request database URL from DATABASE_URL. ${MULTI_HOST_DERIVATION_GUIDANCE}`,
    );
  }
  const derived = deriveAppConnectionString(adminUrl, password);
  if (derived) return { url: derived, source: 'derived' };

  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[database] Cannot configure the unprivileged request pool. Set DATABASE_URL_APP to a NOSUPERUSER/NOBYPASSRLS role, or set BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL from DATABASE_URL. Refusing to use DATABASE_URL for request handlers.',
    );
  }

  return { url: adminUrl, source: 'development-fallback' };
}
