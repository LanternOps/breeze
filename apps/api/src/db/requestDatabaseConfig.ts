import { canonicalizeSingleEndpointPostgresUrl } from '../lib/postgresConnectionUrl';

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

function canonicalizeRequestDatabaseUrl(
  connectionUrl: string,
  source: 'DATABASE_URL' | 'DATABASE_URL_APP',
): string {
  return canonicalizeSingleEndpointPostgresUrl(
    connectionUrl,
    `[database] ${source} is invalid. ${SINGLE_ENDPOINT_GUIDANCE}`,
  );
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
    const url = new URL(canonicalizeRequestDatabaseUrl(adminUrl, 'DATABASE_URL'));
    url.username = 'breeze_app';
    url.password = encodeURIComponent(appPassword);
    return canonicalizeRequestDatabaseUrl(url.toString(), 'DATABASE_URL');
  } catch {
    return null;
  }
}

export function resolveRequestDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): RequestDatabaseConfig {
  const explicit = env.DATABASE_URL_APP?.trim();
  if (explicit) {
    return {
      url: canonicalizeRequestDatabaseUrl(explicit, 'DATABASE_URL_APP'),
      source: 'explicit',
    };
  }

  const rawAdminUrl =
    env.DATABASE_URL?.trim() || 'postgresql://breeze:breeze@localhost:5432/breeze';
  const adminUrl = canonicalizeRequestDatabaseUrl(rawAdminUrl, 'DATABASE_URL');
  const password =
    env.BREEZE_APP_DB_PASSWORD?.trim() || env.POSTGRES_PASSWORD?.trim();
  const derived = deriveAppConnectionString(adminUrl, password);
  if (derived) return { url: derived, source: 'derived' };

  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[database] Cannot configure the unprivileged request pool. Set DATABASE_URL_APP to a NOSUPERUSER/NOBYPASSRLS role, or set BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL from DATABASE_URL. Refusing to use DATABASE_URL for request handlers.',
    );
  }

  return { url: adminUrl, source: 'development-fallback' };
}
