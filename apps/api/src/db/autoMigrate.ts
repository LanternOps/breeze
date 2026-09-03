// Canonicalize NODE_ENV before anything reads it — this is a standalone CLI
// entrypoint (db:migrate) that, via seed, gates on NODE_ENV. See #917 (L-6).
import '../config/normalizeNodeEnv';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { ensureAppRole } from './ensureAppRole';
import { seed } from './seed';

const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;
// IMPORTANT: MIGRATION_TABLE is a hardcoded constant — never accept user input.
// Exported so the extension migrator writes namespaced rows into the SAME
// ledger (`<extension>/<file>`) through the same table name, never a copy.
export const MIGRATION_TABLE = 'breeze_migrations';

export interface PlannedMigration {
  ledgerName: string;
  filePath: string;
}

/**
 * Core filenames (already discovered+sorted), resolved to absolute paths.
 *
 * Core migrations are the ONLY thing this planner knows about. Extension
 * migrations are applied by the extension migrator
 * (`extensions/migrator.ts`), which writes its own namespaced rows
 * (`<extension>/<file>`) into the SAME `breeze_migrations` ledger — this
 * planner never sees them and never applies them.
 */
export function planMigrations(coreFilenames: string[]): PlannedMigration[] {
  return coreFilenames.map((filename) => ({
    ledgerName: filename,
    filePath: path.join(resolveMigrationsDir(), filename),
  }));
}

/**
 * Split ledger rows into checksum-verifiable (core) vs skipped (namespaced
 * extension rows).
 *
 * A row is verifiable here only if it is a bare core filename. Namespaced
 * `<extension>/<file>` rows belong to the extension migrator, which owns their
 * checksums; the core boot loop has no file on disk to hash them against and
 * must not treat their absence from `planMigrations` as drift.
 *
 * Exported for `scripts/check-drift.ts`, which reports the skipped rows.
 */
export function partitionLedgerRows(
  ledgerFilenames: string[],
): { verify: string[]; skip: string[] } {
  const verify: string[] = [];
  const skip: string[] = [];

  for (const filename of ledgerFilenames) {
    if (filename.includes('/')) skip.push(filename);
    else verify.push(filename);
  }

  return { verify, skip };
}

/**
 * Compute a SHA-256 hex hash of SQL content for checksum tracking.
 */
export function hashSql(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Known, verified-safe in-place edits to ALREADY-SHIPPED migrations.
 *
 * The checksum guard (step 6) normally refuses to boot if an applied
 * migration's file content changed — editing shipped migrations is forbidden.
 * The rare exception is a forward-fix that is provably equivalent/idempotent
 * for any DB that already applied the original. For those, we heal the recorded
 * checksum (from -> to) instead of crashing the upgrade.
 *
 * Each entry MUST be a deliberate, reviewed pair of exact checksums. A mismatch
 * that is NOT an exact from->to match still throws. Only DBs that recorded the
 * `from` checksum are touched — fresh installs / DBs that never applied the
 * original are unaffected (they apply the current file normally).
 *
 * #994 edited 2026-05-25-b/c (`::bytea` -> `convert_to(payload, 'UTF8')`) to fix
 * audit-chain hashing; the change is equivalent for already-chained rows. Only
 * v0.67.1 DBs recorded the originals, so without this they crash on the
 * v0.68.x upgrade with a checksum mismatch.
 */
export const CHECKSUM_RECONCILIATIONS: Record<
  string,
  { from: string; to: string; reason: string }
> = {
  '2026-05-25-b-audit-log-checksum-chain.sql': {
    from: 'ccb3893ad6a659bcbebd759c9f3caef777f62ab0b9bc72b1d7a7bf7a6448fd7b',
    to: '813160a82318e5e8da0320749efc2e47ee3319d949b9fc68e2447398c5313fdc',
    reason: "#994: ::bytea -> convert_to(payload,'UTF8') for audit-chain hashing",
  },
  '2026-05-25-c-audit-log-checksum-canonical-fix.sql': {
    from: '71df754e3171079848092df7fda360a3619e8760e288d219bdb76071fa6b0cde',
    to: '214ebca196629d81d54610bad9ff79fef8b2b5bfb19c0b024a4cf2a6b230f693',
    reason: '#994: canonical audit-chain fix (companion to 2026-05-25-b)',
  },
  '2026-06-27-a-update-rings-partner-scope.sql': {
    from: '116206c6dca9085c7b539ce9a0adc00ca686a290ccf103c77476198d2d8ea73d',
    to: '343795b2cdc3ab7ac938d0b0ad71360b69f32e1a6219cd7e4c591842f14e9dd0',
    reason: '#1936: guard patch_policies org_id backfill for already partner-scoped reruns',
  },
  '2026-06-27-b-patch-approvals-partner-scope.sql': {
    from: 'e7047df7bf793525af48e8bd0f6ce9eadee38b8fdb10227bf7b387595fb44384',
    to: '83cf9d01bf2030bb1cf063c4624c3847d9eac71ce90ae4d511228a98d14eaca6',
    reason: '#1936: guard patch_approvals org_id backfill for already partner-scoped reruns; note why step-3 dedup needs no org_id guard',
  },
  '2026-07-16-td-synnex-sftp-price-file.sql': {
    from: '8e08c23f4e1dfc6ceeb8c4624d9536c037f4062d287598b2ae106c3529d5dc08',
    to: 'dc7be5f3209a46f4120f653eb4575ec5b64a6a23126e937a412afad7f26efc6a',
    reason: '0.95.1: GRANT/REVOKE CREATE ON SCHEMA public around ALTER FUNCTION ... OWNER TO breeze_search so a NOSUPERUSER migrator (DO managed doadmin) can complete the owner change. v0.95.0 succeeded only on superuser DBs; heal those (already applied) instead of crashing their upgrade.',
  },
  // #2622 (v0.97.1) rewrote 8 shipped v0.97.0 migrations to move custom-GUC
  // elevation (`SET "breeze.scope" = 'system'`) out of SECURITY DEFINER function
  // ATTRIBUTES and into in-body `set_config()` save/restore, because a NOSUPERUSER
  // migrator (DO managed doadmin) cannot set a dotted GUC via a function attribute
  // (42501). #2622 edited them in place on the premise that they were unrecorded on
  // every prod DB — true only for the hosted droplets, where v0.97.0 crash-looped
  // before recording them. A SELF-HOSTER on a SUPERUSER Postgres (stock compose
  // `postgres` role) applied all 8 successfully under v0.97.0 and recorded the
  // ORIGINAL checksums, so their v0.97.1 upgrade crashes on the first mismatch
  // (2026-07-27-a). The heal only updates the recorded checksum — it never re-runs
  // the file — and the functions already installed from the original v0.97.0 files
  // are correct on a superuser DB (the attribute form works there); the rewrite only
  // matters for NOSUPERUSER fresh installs. So healing from->to is safe for any DB
  // that recorded the original. Same class as #994 (2026-05-25-b/c). See v0.97.2.
  '2026-07-27-a-feature-policy-reference-ownership.sql': {
    from: '9952e3f19bef5dd3b7c220da12b78eeb2913b8ff104ccff36d2b296e30ded5d1',
    to: '457a7b60e3ed3cfd07129555884586571b48dabc8b0faed8d8d00c7a9aadbe4d',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config wrapper/_impl split; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-07-27-c-backup-feature-settings-parity.sql': {
    from: '580c79814c1b052b1e0c754734f5443d8301754d4166f711a8e90a4537d18d1f',
    to: 'ac2bfad2139259d07413a06d868404c9fbf4a48c95fc6d7293fe924422fc9f9a',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-07-29-serialize-config-policy-assignment-integrity.sql': {
    from: '1f86a8d5cfb959b8a05d5cb024a8ea9469ed4f1415c9fd1cc8ab4531b4da9dad',
    to: '764823aaad4d70f79aba2a825ad03312e5f67298fa3b8b90c254c60f39231dbc',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-07-30-serialize-bulk-config-assignment-target-moves.sql': {
    from: 'b2cdbe2abbcae223383d8b08441827d577f029324a49c71b8772b60dbb4aecce',
    to: 'f29f46d509fc61fe189e705b71cbe1990f4782268c59213c0fbe0e531edda52b',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-08-01-a-serialize-feature-policy-references.sql': {
    from: '59155c400eb121d928410921c2ba9398292c6ef5d9281d448583181b94604517',
    to: '33ce95085962995061b610a2b136922f00cba952520c8f2c8c2c6a0e88459da0',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-08-01-b-serialize-backup-policy-references.sql': {
    from: '1521cebd097f33636076c681f8f2ffaca717eac67f3ed109e8156038de5846fc',
    to: '38db1a87a05ff1b48e66cc1e5882e12abdcbd5312aaf7abfc4a6a484c410f77f',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-08-01-c-serialize-onedrive-policy-references.sql': {
    from: '39f7be62ec5711780aea7fcd9d55b5b5078fd2b1c34e0f60258b559fadb50405',
    to: '7b719a186561f6fb2ece633fd974547dcc5bde995d4867e0ce905e964aae7658',
    reason: '#2622 (v0.97.1): move breeze.scope elevation from function attribute to in-body set_config; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-08-01-d-harden-feature-reference-serialization.sql': {
    from: '9183e3acd9c145b76f1bcdcb25f7982826aafe5465fb5ee126fe35df03dfd0e8',
    to: '6be4c7fa5b808e4ca51f63824f6d5b286f0b8dfc081ed8a43cc33f731fdb6148',
    reason: '#2622 (v0.97.1): advisory-lock gate function had breeze.scope attributes dropped outright; superuser DBs applied the original v0.97.0 file, heal their recorded checksum instead of crashing the upgrade.',
  },
  '2026-08-19-contacts.sql': {
    from: '4b6559271dbc35c85e342756a3892909a7f2cee58e4b5bdc8e04207ffe842a64',
    to: 'e586cb0f8474e3a84d06638def12268896bba260d3c4568679e90935cc6e1a52',
    reason:
      "#3316: bound the two backfill projections with left(...) at the destination column widths. The original raises 22001 on a sites.contact / organizations.billing_contact value longer than varchar(255)/(320)/(64), which aborts the whole migration run. Equivalent for any DB that already applied the original: applying it successfully proves no value exceeded a limit, so left(...) would have returned those same strings unchanged — heal the recorded checksum rather than crashing the upgrade.",
  },
};

/**
 * True if a migration file opts out of the default transactional apply.
 *
 * Detection: the directive `-- @no-transaction` must appear at the start
 * of a line (leading whitespace permitted) anywhere in the file. The
 * marker is a plain SQL comment so the file remains executable through
 * stock psql tooling. Statements like `CREATE INDEX CONCURRENTLY`,
 * `REINDEX CONCURRENTLY`, and `VACUUM` are forbidden inside a tx by
 * Postgres and require this opt-out.
 *
 * Exported for unit testing.
 */
export function hasNoTransactionDirective(content: string): boolean {
  return /^\s*--\s*@no-transaction\b/m.test(content);
}

/**
 * Every SQL function/procedure name a migration file (re)defines via
 * `CREATE FUNCTION` / `CREATE OR REPLACE FUNCTION` / `CREATE PROCEDURE` /
 * `CREATE OR REPLACE PROCEDURE`.
 *
 * Names are matched case-insensitively and returned lowercase, schema-
 * qualified exactly as written (e.g. `public.breeze_device_child_orgid_tables`).
 * Line comments (`-- ...`) are stripped first so a comment that merely
 * *mentions* a `CREATE ... FUNCTION` statement (documentation, changelog
 * prose) is never mistaken for a real definition.
 *
 * This is a name-detector, not a SQL parser: it does not understand dollar-
 * quoted bodies, so a `--` sequence inside a string literal or a PL/pgSQL
 * comment would also be stripped. That's fine for this purpose — the only
 * thing scanned for is the `CREATE ... FUNCTION <name>` header itself, which
 * migrations in this repo never construct from a string literal.
 *
 * Used by `__tests__/integration/replayMigration.ts` to find every LATER
 * migration that must be re-applied after a suite replays an EARLIER one by
 * path, so the database ends up in the same state a fresh `autoMigrate` run
 * produces instead of reverting a function to an older body for the rest of
 * that vitest process (#3205 W07 / PR #4838).
 *
 * Exported for unit testing.
 */
export function extractDefinedFunctionNames(content: string): string[] {
  const withoutLineComments = content.replace(/--[^\n]*/g, '');
  const pattern = /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+("?[\w.]+"?)/gi;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutLineComments)) !== null) {
    names.add(match[1]!.replace(/"/g, '').toLowerCase());
  }
  return [...names].sort();
}

/**
 * Split a SQL file into individual statements for no-transaction execution.
 *
 * Postgres's simple-query protocol wraps multi-statement single queries
 * in an implicit transaction — fatal for `CREATE INDEX CONCURRENTLY`,
 * which Postgres refuses to run inside any transaction (CI proved this
 * the first time we tried). The fix is to send each statement as its
 * own command on the wire.
 *
 * This is a small targeted splitter, not a full SQL lexer. It handles
 * the shapes used by no-transaction migrations in this repo:
 *   - Line comments (`-- ...`) — stripped before splitting.
 *   - Single- and double-quoted literals — `;` inside is preserved.
 *   - Dollar-quoted blocks (`$$ ... $$`, `$tag$ ... $tag$`) — `;` inside is preserved.
 *
 * Returns the statements in original order with surrounding whitespace
 * stripped and empty fragments removed.
 *
 * Exported for unit testing.
 */
export function splitSqlStatements(content: string): string[] {
  // 1. Strip line comments — they can carry stray semicolons.
  const stripped = content.replace(/--[^\n]*$/gm, '');

  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i]!;

    // Single-quoted string literal: 'foo''bar'
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < stripped.length) {
        const c = stripped[i]!;
        buf += c;
        i++;
        if (c === "'") {
          if (stripped[i] === "'") {
            buf += stripped[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier: "foo""bar"
    if (ch === '"') {
      buf += ch;
      i++;
      while (i < stripped.length) {
        const c = stripped[i]!;
        buf += c;
        i++;
        if (c === '"') {
          if (stripped[i] === '"') {
            buf += stripped[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Dollar-quoted: $$...$$ or $tag$...$tag$
    if (ch === '$') {
      const tagMatch = stripped.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const close = tagMatch[0];
        buf += close;
        i += close.length;
        const end = stripped.indexOf(close, i);
        if (end === -1) {
          buf += stripped.slice(i);
          i = stripped.length;
        } else {
          buf += stripped.slice(i, end + close.length);
          i = end + close.length;
        }
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
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

/**
 * Decide whether autoMigrate should abort because the unprivileged
 * `breeze_app` role is not going to exist when the migration loop runs.
 *
 * `ensureAppRole()` returning `false` means it was skipped (neither
 * BREEZE_APP_DB_PASSWORD nor POSTGRES_PASSWORD reached this process — most
 * commonly because turbo stripped the var; see #4048). That's only a
 * problem if `breeze_app` doesn't already exist some other way (e.g. a
 * docker-compose dev DB that pre-creates it) — in that case, proceeding
 * anyway lets the migration loop run ~135 files deep before dying on the
 * opaque Postgres 42704 `role "breeze_app" does not exist`. Pulled out as a
 * pure function so the decision is unit-testable without a live database.
 */
export function assertAppRoleBootstrapped(
  roleEnsured: boolean,
  breezeAppRoleExists: boolean,
): void {
  if (roleEnsured || breezeAppRoleExists) return;
  throw new Error(
    '[auto-migrate] Refusing to proceed: the `breeze_app` role does not exist and ' +
      "ensureAppRole() could not create it because neither BREEZE_APP_DB_PASSWORD nor " +
      "POSTGRES_PASSWORD is set in this process's environment. Set one of those two " +
      'variables. If you invoked this via `pnpm db:migrate` (which runs through turbo), ' +
      "confirm the variable is listed in turbo.json's `globalPassThroughEnv` — turbo " +
      'silently strips any env var not declared there or in a task-level `env`/' +
      '`passThroughEnv`, and a plain DATABASE_URL connection will otherwise proceed as ' +
      'the admin/superuser and fail confusingly, many migration files later, with ' +
      'Postgres error 42704.',
  );
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

/**
 * Discover the core migration filenames present in this checkout, in apply
 * order. Exported for the integration-test ledger-drift guard
 * (`__tests__/integration/globalSetup.ts`), which compares the connected
 * database's `breeze_migrations` ledger against exactly this set to detect a
 * shared test DB polluted by another worktree's branch (#3066/#3064).
 */
export async function discoverCoreMigrationFilenames(): Promise<string[]> {
  return (await readdir(resolveMigrationsDir()))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
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

/**
 * Record a migration as applied. Exported so the extension migrator inserts its
 * namespaced ledger row (`<extension>/<file>`) through the exact same statement
 * and table as the core boot loop — no duplicated INSERT logic.
 */
export async function recordMigration(
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
export const LEGACY_CUTOFF = 65;

/**
 * The session advisory-lock key for the CORE migration run. Exported for
 * tests. Mirrors `extensions/migrator.ts`'s per-extension lock
 * (`extensionLockKey` / `hashtextextended(key, 0)`) — same primitive, one
 * lock for the whole core run instead of one per extension.
 */
export const CORE_MIGRATION_LOCK_KEY = 'breeze-core-migrations';

/**
 * Acquire/release the core-migration session advisory lock. Defense-in-depth
 * against two processes racing `autoMigrate()` against the same database
 * (e.g. a rolling deploy briefly running two api-role replicas that both
 * auto-migrate on boot) — normally harmless since every migration is
 * idempotent and the ledger INSERT is `ON CONFLICT DO NOTHING`, but a lock
 * removes the window entirely rather than relying on that.
 *
 * `client` here is the SAME `postgres(connectionString, { max: 1 })` pool
 * used for the rest of the run: with a pool ceiling of 1 there is only ever
 * one physical connection to hand out, so every query for the life of this
 * function — transactional or not — runs on that one backend session, and a
 * session-scoped `pg_advisory_lock` taken on it before any other query stays
 * held for the whole run. A separately `.reserve()`d connection (the
 * extension migrator's approach, needed there because it shares a
 * general-purpose pool) would be redundant here.
 */
async function acquireCoreMigrationLock(client: postgres.Sql): Promise<void> {
  await client`SELECT pg_advisory_lock(hashtextextended(${CORE_MIGRATION_LOCK_KEY}, 0))`;
}

async function releaseCoreMigrationLock(client: postgres.Sql): Promise<void> {
  await client`SELECT pg_advisory_unlock(hashtextextended(${CORE_MIGRATION_LOCK_KEY}, 0))`;
}

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
    await acquireCoreMigrationLock(client);
    try {
      await runCoreMigrations(client);
    } finally {
      await releaseCoreMigrationLock(client);
    }
  } finally {
    await client.end();
  }
}

async function runCoreMigrations(client: postgres.Sql): Promise<void> {
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
    allFiles = await discoverCoreMigrationFilenames();
  } catch (error) {
    // Only a genuinely absent migrations directory is a benign "nothing to
    // do". EACCES/ENOTDIR/etc. must fail loudly — swallowing them here used
    // to let the process continue against an unmigrated database and fail
    // later with confusing missing-table errors.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log('[auto-migrate] No migration files found, skipping');
    return;
  }

  if (allFiles.length === 0) {
    console.log('[auto-migrate] No migration files found, skipping');
    return;
  }

  const migrationPlan = planMigrations(allFiles);

  // ── 4. Load already-applied checksums ────────────────────────────────
  const applied = await loadApplied(client);

  // ── 5. Handle fresh/legacy: baseline pre-consolidation migrations ───
  if (state === 'fresh') {
    // Fresh DB: run the baseline (0001) then mark 0002-0065 as applied
    // since they're already reflected in the baseline.
    const baseline = allFiles.find((f) => f.startsWith('0001-'));
    if (baseline) {
      const sqlPath = path.join(migrationsDir, baseline);
      const content = await readFile(sqlPath, 'utf8');
      const checksum = hashSql(content);
      console.log(`[auto-migrate] Applying baseline: ${baseline}`);
      await client.begin(async (tx) => {
        await tx.unsafe(content);
        await tx.unsafe(
          `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
          [baseline, checksum],
        );
      });
      applied.set(baseline, checksum);
    }
    // Mark 0002-0065 as applied (already in baseline)
    for (const filename of allFiles) {
      const num = parseInt(filename.slice(0, 4), 10);
      if (num <= 1 || num > LEGACY_CUTOFF) continue;
      if (applied.has(filename)) continue;

      const sqlPath = path.join(migrationsDir, filename);
      const content = await readFile(sqlPath, 'utf8');
      const checksum = hashSql(content);

      await recordMigration(client, filename, checksum);
      applied.set(filename, checksum);
    }
    console.log('[auto-migrate] Fresh database: baseline applied, legacy migrations marked');
  } else if (state === 'legacy') {
    // Legacy DB: schema already exists, mark 0001-0065 as applied
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
  const { verify: ledgerRowsToVerify, skip: ledgerRowsToSkip } = partitionLedgerRows([
    ...applied.keys(),
  ]);
  for (const filename of ledgerRowsToSkip) {
    console.warn(
      `[auto-migrate] skipping checksum for ${filename} — extension-owned ledger row`,
    );
  }
  const verifiableLedgerRows = new Set(ledgerRowsToVerify);
  for (const migration of migrationPlan) {
    const filename = migration.ledgerName;
    if (!verifiableLedgerRows.has(filename)) continue;
    const priorChecksum = applied.get(filename);
    if (!priorChecksum) continue;

    const content = await readFile(migration.filePath, 'utf8');
    const currentChecksum = hashSql(content);

    if (priorChecksum !== currentChecksum) {
      const reconciliation = CHECKSUM_RECONCILIATIONS[filename];
      if (
        reconciliation &&
        reconciliation.from === priorChecksum &&
        reconciliation.to === currentChecksum
      ) {
        // Known, verified-safe forward-fix to a shipped migration: heal the
        // recorded checksum instead of crashing the upgrade. Exact from->to
        // match only; any other change still throws below.
        await client.unsafe(
          `UPDATE ${MIGRATION_TABLE} SET checksum = $1 WHERE filename = $2`,
          [currentChecksum, filename],
        );
        applied.set(filename, currentChecksum);
        console.log(
          `[auto-migrate] Reconciled checksum for ${filename} (known forward-fix: ${reconciliation.reason})`,
        );
        continue;
      }
      throw new Error(
        `Migration checksum mismatch for ${filename}. ` +
          'The file changed after being applied. Add a new migration instead.',
      );
    }
  }

  // ── 6b. Ensure the unprivileged `breeze_app` role exists BEFORE applying
  //        post-baseline migrations. Several migrations declare RLS
  //        policies with `FOR ALL TO breeze_app`; on a truly fresh DB those
  //        statements fail with `role "breeze_app" does not exist` if the
  //        role isn't created first. Idempotent — safe on every run. We
  //        still call ensureAppRole again at step 7b so any tables created
  //        in this loop receive the privilege grants.
  //
  //        If ensureAppRole was skipped (no password env var reached this
  //        process — e.g. turbo stripped it) AND breeze_app doesn't already
  //        exist (e.g. a fresh/scratch DB that compose didn't pre-provision),
  //        fail fast here with a pointed error instead of letting the
  //        migration loop run ~135 files deep and die on the opaque
  //        Postgres 42704 `role "breeze_app" does not exist` (#4048).
  const roleEnsured = await ensureAppRole();
  if (!roleEnsured) {
    const roleRow = await client`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') AS exists
    `;
    assertAppRoleBootstrapped(roleEnsured, Boolean(roleRow[0]?.exists));
  }

  // ── 7. Apply pending migrations ──────────────────────────────────────
  let appliedCount = 0;
  for (const migration of migrationPlan) {
    const filename = migration.ledgerName;
    if (applied.has(filename)) continue;

    const content = await readFile(migration.filePath, 'utf8');
    const checksum = hashSql(content);

    // Migrations marked with `-- @no-transaction` at the top run OUTSIDE
    // a transaction. Required for statements Postgres forbids inside a
    // tx — most notably `CREATE INDEX CONCURRENTLY`, which is the
    // non-blocking variant we need on hot multi-million-row tables
    // (devices, audit_logs, agent_logs) where a normal CREATE INDEX
    // takes a SHARE lock and stalls every agent heartbeat / log ship /
    // audit write for the duration of the build (#753 P0).
    //
    // Idempotency contract: a no-transaction migration MUST be safe to
    // re-apply on partial failure — every statement should use
    // `IF NOT EXISTS` / `IF EXISTS` / `CREATE OR REPLACE`. If the SQL
    // succeeds but the breeze_migrations INSERT fails, the next run
    // will re-apply the file; that's why `CREATE INDEX CONCURRENTLY IF
    // NOT EXISTS` is the canonical pattern here. Recovery from a
    // failed CONCURRENTLY (which leaves an invalid index) requires an
    // operator to `DROP INDEX <name>` before the next deploy.
    const isNoTransaction = hasNoTransactionDirective(content);
    console.log(
      `[auto-migrate] Applying: ${filename}${isNoTransaction ? ' (no-transaction)' : ''}`,
    );
    if (isNoTransaction) {
      // Send statements one at a time so each command leaves the
      // driver as its own simple-query exchange. Sending the whole
      // file via `client.unsafe(content)` would group the statements
      // and Postgres treats a multi-statement simple query as an
      // implicit transaction — which `CREATE INDEX CONCURRENTLY`
      // refuses to run inside.
      const statements = splitSqlStatements(content);
      for (const stmt of statements) {
        await client.unsafe(stmt);
      }
      await client.unsafe(
        `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
    } else {
      await client.begin(async (tx) => {
        await tx.unsafe(content);
        await tx.unsafe(
          `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
          [filename, checksum],
        );
      });
    }
    appliedCount++;
  }

  if (appliedCount > 0) {
    console.log(`[auto-migrate] Applied ${appliedCount} migration(s)`);
  } else {
    console.log('[auto-migrate] All migrations already applied');
  }

  // ── 7b. Re-run ensureAppRole so any tables created in step 7 receive
  //        the standard privilege grants. Idempotent.
  await ensureAppRole();

  // ── 8. Auto-seed if no users exist ───────────────────────────────────
  const userCheck = await client`SELECT id FROM users LIMIT 1`;
  if (userCheck.length === 0) {
    console.log('[auto-migrate] No users found, running initial seed...');
    await seed();
    console.log('[auto-migrate] Initial seed complete');
  } else {
    console.log('[auto-migrate] Database already seeded');
  }
}
