import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { seed } from './seed';
import { runManualSqlMigrations } from './migrations/run';

/**
 * Runs schema migrations and seeds the database on first boot.
 *
 * Handles three scenarios:
 * 1. Fresh database — applies the full schema dump (complete DDL) then seeds.
 * 2. Existing database from `drizzle-kit push` — baselines current Drizzle
 *    migrations so they aren't re-applied, then applies any new ones.
 * 3. Previously migrated database — applies only pending Drizzle migrations.
 *
 * The full-schema.sql approach ensures fresh deployments always get the
 * complete current schema, avoiding gaps from incomplete Drizzle migrations.
 */
export async function autoMigrate(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

  // Dedicated single-connection client for DDL operations
  const client = postgres(connectionString, { max: 1 });
  const migrationDb = drizzle(client);

  try {
    const migrationsFolder = path.join(process.cwd(), 'drizzle');
    const metaFolder = path.join(migrationsFolder, 'meta');

    const hasSchema = await tableExists(client, 'users');
    const hasMigrationTracking = await schemaExists(client, 'drizzle');

    if (!hasSchema) {
      // Fresh database — apply the full schema dump which contains all DDL
      console.log('[auto-migrate] Fresh database detected');
      const applied = await applyFullSchema(client);
      if (applied) {
        // Baseline Drizzle migrations so they aren't re-applied on next boot
        if (existsSync(metaFolder)) {
          await baselineMigrations(client, migrationsFolder);
        }
      } else if (existsSync(metaFolder)) {
        // Fallback: no full-schema.sql found, use Drizzle migrations
        console.log('[auto-migrate] Falling back to Drizzle migrations...');
        await migrate(migrationDb, { migrationsFolder });
        console.log('[auto-migrate] Drizzle migrations complete');
      } else {
        console.log('[auto-migrate] No migration files found, skipping');
        return;
      }
    } else {
      // Existing database — use incremental Drizzle migrations
      if (!existsSync(metaFolder)) {
        console.log('[auto-migrate] No migration files found, skipping');
        return;
      }

      if (!hasMigrationTracking) {
        console.log('[auto-migrate] Existing database detected, baselining...');
        await baselineMigrations(client, migrationsFolder);
      }

      console.log('[auto-migrate] Applying pending Drizzle migrations...');
      await migrate(migrationDb, { migrationsFolder });
      console.log('[auto-migrate] Drizzle migrations complete');
    }

    // Run manual SQL migrations (config policies, RLS, etc.)
    try {
      console.log('[auto-migrate] Applying manual SQL migrations...');
      await runManualSqlMigrations();
    } catch (err) {
      console.warn('[auto-migrate] Manual SQL migrations failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    // Auto-seed when the database is empty (first boot)
    const result = await client`SELECT id FROM users LIMIT 1`;
    if (result.length === 0) {
      console.log('[auto-migrate] No users found, running initial seed...');
      await seed();
      console.log('[auto-migrate] Initial seed complete');
    } else {
      console.log('[auto-migrate] Database already seeded');
    }
  } finally {
    await client.end();
  }
}

/**
 * Applies the full schema dump (pg_dump --schema-only output) to bootstrap
 * a fresh database with the complete current schema in one shot.
 * Returns true if the schema was applied, false if the file wasn't found.
 */
async function applyFullSchema(client: postgres.Sql): Promise<boolean> {
  // In Docker the CWD is /app, so full-schema.sql lands at /app/db/full-schema.sql
  // In dev, it's relative to the api package root
  const candidates = [
    path.join(process.cwd(), 'db', 'full-schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'full-schema.sql'),
  ];

  let schemaPath: string | undefined;
  for (const p of candidates) {
    if (existsSync(p)) {
      schemaPath = p;
      break;
    }
  }

  if (!schemaPath) {
    console.warn('[auto-migrate] full-schema.sql not found, cannot apply full schema');
    return false;
  }

  console.log(`[auto-migrate] Applying full schema from ${schemaPath}...`);
  const sql = readFileSync(schemaPath, 'utf8');

  // Filter out psql meta-commands (lines starting with \) that pg_dump may include
  const cleanedSql = sql
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

  await client.unsafe(cleanedSql);
  console.log('[auto-migrate] Full schema applied successfully');
  return true;
}

async function tableExists(
  client: postgres.Sql,
  tableName: string
): Promise<boolean> {
  const result = await client`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${tableName}
    )
  `;
  return result[0]?.exists === true;
}

async function schemaExists(
  client: postgres.Sql,
  schemaName: string
): Promise<boolean> {
  const result = await client`
    SELECT EXISTS (
      SELECT FROM information_schema.schemata
      WHERE schema_name = ${schemaName}
    )
  `;
  return result[0]?.exists === true;
}

/**
 * Marks all current Drizzle migrations as applied without executing them.
 * This is necessary for databases that were created with `drizzle-kit push`
 * (which doesn't use the migration tracking table).
 */
async function baselineMigrations(
  client: postgres.Sql,
  migrationsFolder: string
): Promise<void> {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return;

  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const entries = journal.entries || [];

  // Create the tracking schema and table (mirrors what migrate() does internally)
  await client`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await client`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  for (const entry of entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue;

    const sqlContent = readFileSync(sqlPath, 'utf8');
    const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');

    const existing = await client`
      SELECT id FROM "drizzle"."__drizzle_migrations" WHERE hash = ${hash}
    `;

    if (existing.length === 0) {
      await client`
        INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      console.log(`[auto-migrate] Baselined: ${entry.tag}`);
    }
  }
}
