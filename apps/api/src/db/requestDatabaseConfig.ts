export type RequestDatabaseConfigSource =
  | 'explicit'
  | 'derived'
  | 'development-fallback';

export interface RequestDatabaseConfig {
  url: string;
  source: RequestDatabaseConfigSource;
}

type RequestDatabaseConfigLogger = Pick<Console, 'log' | 'warn'>;

const SINGLE_ENDPOINT_GUIDANCE =
  'Configure a valid PostgreSQL URL for a single database/HA endpoint.';

function connectionHostSegment(connectionUrl: string): string | null {
  const authority = connectionUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1];
  if (authority === undefined) return null;
  return authority.slice(authority.lastIndexOf('@') + 1);
}

function usesMultipleHosts(connectionUrl: string): boolean {
  return connectionHostSegment(connectionUrl)?.includes(',') ?? false;
}

function parseSingleEndpointUrl(connectionUrl: string, source: string): URL {
  const error = new Error(`[database] ${source} is invalid. ${SINGLE_ENDPOINT_GUIDANCE}`);

  if (usesMultipleHosts(connectionUrl)) throw error;

  try {
    const parsed = new URL(connectionUrl);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
      || !parsed.hostname
      || parsed.hostname.includes(',')
    ) {
      throw error;
    }
    return parsed;
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
    const url = parseSingleEndpointUrl(adminUrl, 'DATABASE_URL');
    url.username = 'breeze_app';
    url.password = appPassword;
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
    parseSingleEndpointUrl(explicit, 'DATABASE_URL_APP');
    return { url: explicit, source: 'explicit' };
  }

  const adminUrl =
    env.DATABASE_URL?.trim() || 'postgresql://breeze:breeze@localhost:5432/breeze';
  const password =
    env.BREEZE_APP_DB_PASSWORD?.trim() || env.POSTGRES_PASSWORD?.trim();
  if (password && usesMultipleHosts(adminUrl)) {
    throw new Error(
      `[database] Cannot derive the request database URL from DATABASE_URL. ${SINGLE_ENDPOINT_GUIDANCE}`,
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
