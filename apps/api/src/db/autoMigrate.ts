import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { seed } from './seed';

const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;
// IMPORTANT: MIGRATION_TABLE is a hardcoded constant — never accept user input.
const MIGRATION_TABLE = 'breeze_migrations';

/**
 * Compute a SHA-256 hex hash of SQL content for checksum tracking.
 */
export function hashSql(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine the database state based on whether key tables exist.
 *
 * - `fresh`  — no `users` table → run every migration from scratch
 * - `legacy` — `users` exists but `breeze_migrations` is empty → mark 0001-0065 as applied
 * - `normal` — `breeze_migrations` has rows → run only pending migrations
 */
export function detectState(
  usersExist: boolean,
  breezeMigrationsExist: boolean,
): 'fresh' | 'legacy' | 'normal' {
  if (!usersExist) return 'fresh';
  if (!breezeMigrationsExist) return 'legacy';
  return 'normal';
}

/** Resolve the directory containing numbered .sql migration files. */
function resolveMigrationsDir(): string {
  try {
    // ESM (dev): autoMigrate.ts lives at src/db/ → resolve ../../migrations
    const thisFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(thisFile), '..', '..', 'migrations');
  } catch {
    // CJS bundle (Docker): import.meta.url is unavailable
    return path.join(process.cwd(), 'migrations');
  }
}

async function tableExists(client: postgres.Sql, tableName: string): Promise<boolean> {
  const result = await client`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${tableName}
    )
  `;
  return result[0]?.exists === true;
}

async function trackingTableHasRows(client: postgres.Sql): Promise<boolean> {
  const result = await client.unsafe(
    `SELECT EXISTS (SELECT 1 FROM ${MIGRATION_TABLE} LIMIT 1)`,
  );
  return result[0]?.exists === true;
}

async function ensureTrackingTable(client: postgres.Sql): Promise<void> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Load already-applied migration checksums from the tracking table. */
async function loadApplied(client: postgres.Sql): Promise<Map<string, string>> {
  const rows = await client.unsafe<{ filename: string; checksum: string }[]>(
    `SELECT filename, checksum FROM ${MIGRATION_TABLE}`,
  );
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

/** Record a migration as applied. */
async function recordMigration(
  sql: postgres.Sql | postgres.TransactionSql,
  filename: string,
  checksum: string,
): Promise<void> {
  await sql.unsafe(
    `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING`,
    [filename, checksum],
  );
}

/** The highest legacy migration number that should be marked as applied for legacy DBs. */
const LEGACY_CUTOFF = 65;

/**
 * Single-track migration runner for Breeze.
 *
 * Replaces both Drizzle's built-in migrator and the manual SQL runner with one
 * unified system.  All migrations live in `apps/api/migrations/` as numbered
 * SQL files (0001-baseline.sql through 0065-xxx.sql and beyond).
 */
export async function autoMigrate(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

  const client = postgres(connectionString, { max: 1 });

  try {
    const migrationsDir = resolveMigrationsDir();
    console.log(`[auto-migrate] Migrations directory: ${migrationsDir}`);

    // ── 1. Ensure the tracking table exists ──────────────────────────────
    await ensureTrackingTable(client);

    // ── 2. Detect database state ─────────────────────────────────────────
    const usersExist = await tableExists(client, 'users');
    const hasRows = await trackingTableHasRows(client);
    const state = detectState(usersExist, hasRows);
    console.log(`[auto-migrate] Database state: ${state}`);

    // ── 3. Read migration files ──────────────────────────────────────────
    let allFiles: string[];
    try {
      allFiles = (await readdir(migrationsDir))
        .filter((name) => MIGRATION_FILE_PATTERN.test(name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      console.log('[auto-migrate] No migration files found, skipping');
      return;
    }

    if (allFiles.length === 0) {
      console.log('[auto-migrate] No migration files found, skipping');
      return;
    }

    // ── 4. Load already-applied checksums ────────────────────────────────
    const applied = await loadApplied(client);

    // ── 5. Handle legacy state: mark 0001–0065 as applied ───────────────
    if (state === 'legacy') {
      console.log(
        '[auto-migrate] Legacy database detected, marking existing migrations as applied...',
      );
      for (const filename of allFiles) {
        const num = parseInt(filename.slice(0, 4), 10);
        if (num > LEGACY_CUTOFF) break;
        if (applied.has(filename)) continue;

        const sqlPath = path.join(migrationsDir, filename);
        const content = await readFile(sqlPath, 'utf8');
        const checksum = hashSql(content);

        await recordMigration(client, filename, checksum);
        applied.set(filename, checksum);
        console.log(`[auto-migrate] Baselined: ${filename}`);
      }
    }

    // ── 6. Validate checksums for already-applied migrations ─────────────
    for (const filename of allFiles) {
      const priorChecksum = applied.get(filename);
      if (!priorChecksum) continue;

      const sqlPath = path.join(migrationsDir, filename);
      const content = await readFile(sqlPath, 'utf8');
      const currentChecksum = hashSql(content);

      if (priorChecksum !== currentChecksum) {
        throw new Error(
          `Migration checksum mismatch for ${filename}. ` +
            'The file changed after being applied. Add a new migration instead.',
        );
      }
    }

    // ── 7. Apply pending migrations ──────────────────────────────────────
    let appliedCount = 0;
    for (const filename of allFiles) {
      if (applied.has(filename)) continue;

      const sqlPath = path.join(migrationsDir, filename);
      const content = await readFile(sqlPath, 'utf8');
      const checksum = hashSql(content);

      console.log(`[auto-migrate] Applying: ${filename}`);
      await client.begin(async (tx) => {
        await tx.unsafe(content);
        await tx.unsafe(
          `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
          [filename, checksum],
        );
      });
      appliedCount++;
    }

    if (appliedCount > 0) {
      console.log(`[auto-migrate] Applied ${appliedCount} migration(s)`);
    } else {
      console.log('[auto-migrate] All migrations already applied');
    }

    // ── 8. Auto-seed if no users exist ───────────────────────────────────
    const userCheck = await client`SELECT id FROM users LIMIT 1`;
    if (userCheck.length === 0) {
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
