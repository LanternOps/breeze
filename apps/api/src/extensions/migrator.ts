import { lt, valid } from 'semver';
import type postgres from 'postgres';
import {
  MIGRATION_TABLE,
  hashSql,
  hasNoTransactionDirective,
  recordMigration,
  splitSqlStatements,
} from '../db/autoMigrate';
import { readBoundedZipDirectory, type VerifiedExtensionBundle } from './bundleVerifier';
import type { ExtensionStateStore } from './stateStore';

/**
 * Transactional migrator for a single runtime extension.
 *
 * An extension's SQL migrations are applied into the SAME `breeze_migrations`
 * ledger as core migrations, under namespaced filenames (`<extension>/<file>`),
 * reusing the core boot loop's `hashSql` / `recordMigration` / `MIGRATION_TABLE`
 * so there is exactly one migration-tracking implementation.
 *
 * Concurrency contract (the load-bearing part):
 *   - The whole locked section runs on ONE dedicated connection obtained via
 *     `sql.reserve()`. A SESSION-level `pg_advisory_lock` is taken on that
 *     reserved connection, every per-file `reserved.begin()` transaction runs on
 *     it, and the matching `pg_advisory_unlock` runs on it too. Because a
 *     session advisory lock is per-connection, pinning all three to the reserved
 *     connection is what makes the lock actually protect the migration set that
 *     spans multiple sequential transactions. (A transaction-scoped
 *     `pg_advisory_xact_lock` would release after the first file — wrong here.)
 *   - The applied-set is loaded AFTER the lock is held, so a second caller that
 *     was blocked on the lock sees the first caller's committed rows and skips
 *     them. Two concurrent callers for the same extension therefore apply the
 *     set exactly once.
 *
 * Each pending file executes wholesale inside one `reserved.begin`, and its
 * namespaced ledger row is inserted in that SAME transaction — so a file that
 * fails rolls back with no ledger row (nothing half-applied, nothing recorded).
 */

/** One migration file to apply: the in-bundle filename and its raw SQL text. */
export interface ExtensionMigrationFile {
  filename: string;
  sql: string;
}

/**
 * The migrator's input. Decoupled from `VerifiedExtensionBundle` on purpose:
 * the SQL bytes are read out of the bundle archive up front (see
 * {@link readBundleMigrations} / {@link toMigratableExtension}) so this core is
 * unit-testable with inline SQL and the Task-4 reconciler simply feeds it a
 * value derived from the verified bundle.
 */
export interface MigratableExtension {
  /** Extension name — namespaces ledger rows, keys the advisory lock + store. */
  name: string;
  /** The incoming bundle's manifest version. */
  version: string;
  /** The incoming bundle's declared schema-compatibility floor. */
  schemaCompatibilityFloor: string;
  /** Ordered candidate migration files (already sorted). */
  migrations: readonly ExtensionMigrationFile[];
}

/** The session advisory-lock key string for an extension. Exported for tests. */
export function extensionLockKey(name: string): string {
  return `breeze-extension:${name}`;
}

const TX_CONTROL_RE =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?)\b/i;

const BANNED_STATEMENT_RES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, label: 'CREATE INDEX CONCURRENTLY' },
  { re: /\bREINDEX\b[\s\S]*\bCONCURRENTLY\b/i, label: 'REINDEX CONCURRENTLY' },
  { re: /\bVACUUM\b/i, label: 'VACUUM' },
];

/**
 * Reject a migration file that can't be applied atomically inside a
 * transaction: the `-- @no-transaction` opt-out, `CREATE INDEX CONCURRENTLY`,
 * `REINDEX ... CONCURRENTLY`, `VACUUM`, and explicit transaction-control
 * statements. Extension migrations MUST be transactional so a failure rolls
 * back cleanly with no ledger row. Uses the core splitter (comment/string aware)
 * so a banned keyword inside a string literal or comment is not a false hit.
 */
function assertExtensionMigrationSafe(file: ExtensionMigrationFile): void {
  if (hasNoTransactionDirective(file.sql)) {
    throw new Error(
      `extension migration "${file.filename}" is not permitted: -- @no-transaction migrations run outside a transaction and cannot be applied atomically`,
    );
  }
  for (const stmt of splitSqlStatements(file.sql)) {
    if (TX_CONTROL_RE.test(stmt.trimStart())) {
      throw new Error(
        `extension migration "${file.filename}" must not contain transaction-control statements (BEGIN/COMMIT/ROLLBACK/SAVEPOINT)`,
      );
    }
    for (const { re, label } of BANNED_STATEMENT_RES) {
      if (re.test(stmt)) {
        throw new Error(`extension migration "${file.filename}" must not contain ${label}`);
      }
    }
  }
}

type ReservedSql = Awaited<ReturnType<postgres.Sql['reserve']>>;

async function acquireExtensionLock(conn: ReservedSql, name: string): Promise<void> {
  const key = extensionLockKey(name);
  await conn`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
}

async function releaseExtensionLock(conn: ReservedSql, name: string): Promise<void> {
  const key = extensionLockKey(name);
  await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
}

/** Namespaced ledger rows already applied for this extension. */
async function loadAppliedExtensionMigrations(
  conn: ReservedSql,
  name: string,
): Promise<Set<string>> {
  // MIGRATION_TABLE is a hardcoded constant (never user input); the LIKE
  // pattern is parameterized.
  const rows = await conn.unsafe<{ filename: string }[]>(
    `SELECT filename FROM ${MIGRATION_TABLE} WHERE filename LIKE $1`,
    [`${name}/%`],
  );
  return new Set(rows.map((r) => r.filename));
}

/**
 * Apply an extension's pending migrations transactionally, under a per-extension
 * advisory lock, enforcing the rollback and rolling-update gates first.
 *
 * @param extension  what to apply (name/version/floor/migration files)
 * @param sql        a postgres.js client (its pool is fine; a reserved
 *                   connection is checked out internally for the locked section)
 * @param stateStore persistence for schema floors + active version
 * @param rollout    'rolling' enforces the active-version floor gate; 'replace'
 *                   is the explicit escape hatch for a floor-raising upgrade
 */
export async function reconcileExtensionMigrations(
  extension: MigratableExtension,
  sql: postgres.Sql,
  stateStore: ExtensionStateStore,
  rollout: 'rolling' | 'replace',
): Promise<void> {
  const { name, version } = extension;
  const floor = extension.schemaCompatibilityFloor;

  // ── 1. Validate every candidate file BEFORE any DB work (fail fast). A file
  //       already in the ledger could only have passed this same check when it
  //       was first applied, so validating the whole set is equivalent to
  //       validating just the pending subset — and needs no DB round-trip.
  for (const file of extension.migrations) {
    assertExtensionMigrationSafe(file);
  }

  // ── 2. Rollback refusal: incoming code older than the highest schema floor
  //       ever recorded means the live schema already moved past what this code
  //       supports. Refuse.
  const highestFloor = await stateStore.highestSchemaFloor(name);
  if (highestFloor && valid(version) && valid(highestFloor) && lt(version, highestFloor)) {
    throw new Error(
      `refusing to apply extension "${name}" ${version}: it is OLDER than the highest recorded schema floor ${highestFloor} — a code rollback below the live schema floor is not allowed`,
    );
  }

  // ── 3. Rolling-update gate: during a rolling deploy the previous version is
  //       still serving. If it is below the incoming schema floor, the new
  //       migrations would break it mid-rollout — require an explicit replace.
  if (rollout === 'rolling') {
    const row = await stateStore.get(name);
    const activeVersion = row?.activeVersion ?? null;
    if (activeVersion && valid(activeVersion) && valid(floor) && lt(activeVersion, floor)) {
      throw new Error(
        `refusing rolling update for extension "${name}": the active version ${activeVersion} is below the incoming schema compatibility floor ${floor} — deploy this as a non-rolling (replace) rollout instead`,
      );
    }
  }

  // ── 4. Apply pending files on ONE reserved connection, under the session
  //       advisory lock. Lock, per-file transactions, and unlock all pinned to
  //       `reserved` — see the concurrency contract at the top of this file.
  const reserved = await sql.reserve();
  try {
    await acquireExtensionLock(reserved, name);
    try {
      const applied = await loadAppliedExtensionMigrations(reserved, name);
      for (const file of extension.migrations) {
        const ledgerName = `${name}/${file.filename}`;
        if (applied.has(ledgerName)) continue;
        const checksum = hashSql(file.sql);
        // Explicit transaction on the RESERVED connection. postgres.js reserved
        // connections don't expose `.begin`, and we must not let the tx run on a
        // different pooled connection than the one holding the advisory lock —
        // so drive BEGIN/COMMIT/ROLLBACK by hand on `reserved`. The whole file
        // plus its ledger INSERT share this one transaction, so a failing file
        // rolls back with no ledger row.
        await reserved.unsafe('BEGIN');
        try {
          await reserved.unsafe(file.sql);
          await recordMigration(reserved, ledgerName, checksum);
          await reserved.unsafe('COMMIT');
        } catch (error) {
          await reserved.unsafe('ROLLBACK').catch(() => {});
          throw error;
        }
      }
    } finally {
      await releaseExtensionLock(reserved, name);
    }
  } finally {
    reserved.release();
  }

  // ── 5. Record the floor this version applied (idempotent upsert keyed by
  //       name+version). Only reached once every file committed.
  await stateStore.recordSchemaFloor(name, version, floor);
}

/**
 * Read an extension bundle's migration files out of its verified archive. The
 * `files` map on {@link VerifiedExtensionBundle} carries only hashes, so the SQL
 * bytes are read from the archive members directly. Selects the direct `*.sql`
 * children of the manifest's `migrationsDir`, sorted by filename.
 *
 * This is the seam between "a verified bundle on disk" and "SQL to apply": the
 * Task-4 reconciler composes it via {@link toMigratableExtension}.
 */
export async function readBundleMigrations(
  bundle: Pick<VerifiedExtensionBundle, 'archivePath' | 'manifest'>,
): Promise<ExtensionMigrationFile[]> {
  const prefix = `${bundle.manifest.migrationsDir}/`;
  const archive = await readBoundedZipDirectory(bundle.archivePath);
  try {
    const names = [...archive.files.keys()]
      .filter(
        (member) =>
          member.startsWith(prefix) &&
          member.endsWith('.sql') &&
          !member.slice(prefix.length).includes('/'),
      )
      .sort((a, b) => a.localeCompare(b));

    const out: ExtensionMigrationFile[] = [];
    for (const member of names) {
      const bytes = await archive.read(member);
      out.push({ filename: member.slice(prefix.length), sql: bytes.toString('utf8') });
    }
    return out;
  } finally {
    await archive.close().catch(() => {});
  }
}

/** Derive a {@link MigratableExtension} from a verified bundle (Task-4 seam). */
export async function toMigratableExtension(
  bundle: VerifiedExtensionBundle,
): Promise<MigratableExtension> {
  return {
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    schemaCompatibilityFloor: bundle.manifest.schemaCompatibilityFloor,
    migrations: await readBundleMigrations(bundle),
  };
}
