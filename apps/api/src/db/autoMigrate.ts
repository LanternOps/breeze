// Canonicalize NODE_ENV before anything reads it — this is a standalone CLI
// entrypoint (db:migrate) that, via seed, gates on NODE_ENV. See #917 (L-6).
import '../config/normalizeNodeEnv';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { discoverExtensions } from '../extensions/discovery';
import { ensureAppRole } from './ensureAppRole';
import { seed } from './seed';

const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;
// IMPORTANT: MIGRATION_TABLE is a hardcoded constant — never accept user input.
const MIGRATION_TABLE = 'breeze_migrations';

export interface PlannedMigration {
  ledgerName: string;
  filePath: string;
}

/** Core filenames (already discovered+sorted) + extension files, extensions last. */
export function planMigrations(
  coreFilenames: string[],
  extensionsRoot?: string,
): PlannedMigration[] {
  const core: PlannedMigration[] = coreFilenames.map((filename) => ({
    ledgerName: filename,
    filePath: path.join(resolveMigrationsDir(), filename),
  }));
  const extensions: PlannedMigration[] = [];

  for (const extension of discoverExtensions(extensionsRoot)) {
    if (!extension.migrationsDir) continue;
    const files = readdirSync(extension.migrationsDir)
      .filter((name) => MIGRATION_FILE_PATTERN.test(name))
      .sort((a, b) => a.localeCompare(b));
    for (const filename of files) {
      extensions.push({
        ledgerName: `${extension.name}/${filename}`,
        filePath: path.join(extension.migrationsDir, filename),
      });
    }
  }

  return [...core, ...extensions];
}

/** Split ledger rows into checksum-verifiable vs skip (absent extension). */
export function partitionLedgerRows(
  ledgerFilenames: string[],
  extensionsRoot?: string,
): { verify: string[]; skip: string[] } {
  const presentExtensions = new Set(
    discoverExtensions(extensionsRoot).map((extension) => extension.name),
  );
  const verify: string[] = [];
  const skip: string[] = [];

  for (const filename of ledgerFilenames) {
    const slash = filename.indexOf('/');
    if (slash === -1 || presentExtensions.has(filename.slice(0, slash))) {
      verify.push(filename);
    } else {
      skip.push(filename);
    }
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
export const LEGACY_CUTOFF = 65;

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
        `[auto-migrate] skipping checksum for ${filename} — extension not present`,
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
    await ensureAppRole();

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
  } finally {
    await client.end();
  }
}
