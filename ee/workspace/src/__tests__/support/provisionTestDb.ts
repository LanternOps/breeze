// Self-provisioning integration DB for ee/workspace (#3475).
//
// When DATABASE_URL is unset, vitest.integration.globalSetup.ts creates a
// uniquely-named throwaway database on the local test Postgres, applies the
// API's core migrations plus ee/workspace's own, and points DATABASE_URL /
// DATABASE_URL_APP at it — so concurrent worktrees/sessions never share rows
// (the shared-:5433 FK violations and deadlocks in the issue). CI and any
// .env.test-driven run set DATABASE_URL themselves and skip all of this.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_MIGRATIONS_DIR = join(here, '..', '..', '..', 'migrations');
const API_DIR = join(here, '..', '..', '..', '..', '..', 'apps', 'api');

const DEFAULT_ADMIN_URL = 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

export interface ProvisionServer {
  /** Privileged URL on the server; used to CREATE/DROP the throwaway DB. */
  adminUrl: string;
  appUser: string;
  appPassword: string;
}

export interface ProvisionedUrls {
  databaseUrl: string;
  databaseUrlApp: string;
}

/**
 * `breeze_test_ws<12 hex>`: matches the API migrator's test-DB name guard
 * (`^breeze_test(_[a-z0-9]+)?$`), which is why the suffix has no extra `_`.
 */
export function makeProvisionedDbName(): string {
  return `breeze_test_ws${randomBytes(6).toString('hex')}`;
}

export function resolveProvisionServer(env: NodeJS.ProcessEnv): ProvisionServer {
  return {
    adminUrl: env.WORKSPACE_IT_PG_ADMIN_URL || DEFAULT_ADMIN_URL,
    appUser: 'breeze_app',
    appPassword: env.BREEZE_APP_DB_PASSWORD || 'breeze_test',
  };
}

function withDatabase(url: string, dbName: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

export function buildProvisionedUrls(server: ProvisionServer, dbName: string): ProvisionedUrls {
  return {
    databaseUrl: withDatabase(server.adminUrl, dbName),
    databaseUrlApp: withDatabase(server.adminUrl, dbName, server.appUser, server.appPassword),
  };
}

export function listWorkspaceMigrationFiles(
  dir: string = WORKSPACE_MIGRATIONS_DIR,
): { filename: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({ filename, sql: readFileSync(join(dir, filename), 'utf8') }));
}

export interface ProvisionedDb extends ProvisionedUrls {
  dbName: string;
  drop(): Promise<void>;
}

/** Create the DB, apply core + workspace migrations. Drops it again on failure. */
export async function provisionTestDb(env: NodeJS.ProcessEnv = process.env): Promise<ProvisionedDb> {
  const server = resolveProvisionServer(env);
  if ((new URL(server.adminUrl).port || '5432') === '5432') {
    throw new Error('[ee/workspace integration] refusing to provision on :5432 — use the test stack');
  }
  const dbName = makeProvisionedDbName();
  const urls = buildProvisionedUrls(server, dbName);

  const control = postgres(server.adminUrl, { max: 1, onnotice: () => {} });
  const drop = async (): Promise<void> => {
    const c = postgres(server.adminUrl, { max: 1, onnotice: () => {} });
    try {
      // FORCE: kick any straggling pool connections so teardown can't hang.
      await c.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await c.end({ timeout: 5 });
    }
  };

  try {
    await control.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    throw new Error(
      `[ee/workspace integration] cannot create a test database on ${new URL(server.adminUrl).host} ` +
        `(is the test Postgres up? \`pnpm test-stack up\`, or set DATABASE_URL / WORKSPACE_IT_PG_ADMIN_URL): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  } finally {
    await control.end({ timeout: 5 });
  }

  try {
    // Core schema + breeze_app role/grants via the API's own migrator.
    const res = spawnSync('pnpm', ['exec', 'tsx', 'scripts/migrate.ts'], {
      cwd: API_DIR,
      encoding: 'utf8',
      timeout: 300_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...env,
        DATABASE_URL: urls.databaseUrl,
        DATABASE_URL_APP: urls.databaseUrlApp,
        BREEZE_APP_DB_PASSWORD: server.appPassword,
        POSTGRES_PASSWORD: env.POSTGRES_PASSWORD || 'breeze_test',
      },
    });
    if (res.error || res.status !== 0) {
      throw new Error(
        `core migrations failed (exit ${res.status}, signal ${res.signal}${res.error ? `, ${res.error.message}` : ''}):\n${res.stdout}\n${res.stderr}`,
        res.error ? { cause: res.error } : undefined,
      );
    }

    const admin = postgres(urls.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const files = listWorkspaceMigrationFiles();
      if (files.length === 0) throw new Error('no ee/workspace migrations found — refusing to provision an empty schema');
      for (const { filename, sql } of files) {
        try {
          // One transaction per file, as autoMigrate does; files are idempotent.
          await admin.begin((tx) => tx.unsafe(sql));
        } catch (err) {
          throw new Error(`workspace migration ${filename} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  } catch (err) {
    await drop().catch((dropErr) => {
      console.warn(`[ee/workspace integration] failed to drop ${dbName}; clean up manually: DROP DATABASE "${dbName}" WITH (FORCE) (${dropErr})`);
    });
    throw err;
  }

  return { dbName, ...urls, drop };
}
