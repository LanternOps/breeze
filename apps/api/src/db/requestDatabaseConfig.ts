export type RequestDatabaseConfigSource =
  | 'explicit'
  | 'derived'
  | 'development-fallback';

export interface RequestDatabaseConfig {
  url: string;
  source: RequestDatabaseConfigSource;
}

export function deriveAppConnectionString(
  adminUrl: string,
  appPassword: string | undefined,
): string | null {
  if (!appPassword) return null;

  try {
    const url = new URL(adminUrl);
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
  if (explicit) return { url: explicit, source: 'explicit' };

  const adminUrl =
    env.DATABASE_URL?.trim() || 'postgresql://breeze:breeze@localhost:5432/breeze';
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
