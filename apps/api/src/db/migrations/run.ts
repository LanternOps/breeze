import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config();

const MIGRATION_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}.*\.sql$/;
// IMPORTANT: MIGRATION_TABLE must remain a hardcoded constant — never accept user input here.
const MIGRATION_TABLE = 'manual_sql_migrations';

function hashSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function runManualSqlMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
      'Cannot run migrations without a database connection string.'
    );
  }

  const client = new Client({ connectionString });

  const currentFile = fileURLToPath(import.meta.url);
  const migrationsDir = path.dirname(currentFile);

  try {
    await client.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to connect to database: ${message}. ` +
      'Ensure DATABASE_URL is correct and the database is reachable.'
    );
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((name) => MIGRATION_FILE_PATTERN.test(name))
      .sort((a, b) => a.localeCompare(b));

    const existingRows = await client.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM ${MIGRATION_TABLE}`
    );
    const existing = new Map(existingRows.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of files) {
      const sqlPath = path.join(migrationsDir, filename);
      const sql = await readFile(sqlPath, 'utf8');
      const checksum = hashSql(sql);
      const priorChecksum = existing.get(filename);

      if (priorChecksum === checksum) {
        console.log(`[db:migrate:sql] skip ${filename} (already applied)`);
        continue;
      }

      if (priorChecksum && priorChecksum !== checksum) {
        throw new Error(
          `Migration checksum mismatch for ${filename}. ` +
          'The file changed after being applied. Add a new migration instead.'
        );
      }

      console.log(`[db:migrate:sql] apply ${filename}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
          [filename, checksum]
        );
        await client.query('COMMIT');
      } catch (migrationError) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('[db:migrate:sql] ROLLBACK also failed:', rollbackError);
        }
        throw migrationError;
      }
    }

    console.log('[db:migrate:sql] complete');
  } finally {
    try {
      await client.end();
    } catch (endError) {
      console.error('[db:migrate:sql] Failed to close database connection:', endError);
    }
  }
}

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectExecution) {
  runManualSqlMigrations().catch((error) => {
    console.error('[db:migrate:sql] failed:', error);
    process.exit(1);
  });
}
