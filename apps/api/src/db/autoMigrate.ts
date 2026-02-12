import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { seed } from './seed';

/**
 * Runs Drizzle schema migrations and seeds the database on first boot.
 *
 * Handles three scenarios:
 * 1. Fresh database — applies all migrations, then seeds default data.
 * 2. Existing database from `drizzle-kit push` — baselines current migrations
 *    so they aren't re-applied, then applies any new ones.
 * 3. Previously migrated database — applies only pending migrations.
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

    if (!existsSync(metaFolder)) {
      console.log('[auto-migrate] No migration files found, skipping');
      return;
    }

    // Detect existing databases created via `drizzle-kit push` (has tables but
    // no Drizzle migration tracking schema). Baseline them so the initial
    // migration isn't re-applied.
    const hasSchema = await tableExists(client, 'users');
    const hasMigrationTracking = await schemaExists(client, 'drizzle');

    if (hasSchema && !hasMigrationTracking) {
      console.log('[auto-migrate] Existing database detected, baselining...');
      await baselineMigrations(client, migrationsFolder);
    }

    console.log('[auto-migrate] Applying pending migrations...');
    await migrate(migrationDb, { migrationsFolder });
    console.log('[auto-migrate] Migrations complete');

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
