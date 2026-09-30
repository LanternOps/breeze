import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  SETTINGS_SECRET_JSON_PATHS,
  encryptedColumnRegistry,
  transformEncryptedColumnValue,
  type EncryptedColumnSpec,
} from './encryptedColumnRegistry';
import { isEncryptedSecret } from './secretCrypto';

/**
 * Seal values at `SETTINGS_SECRET_JSON_PATHS` that were stored before those
 * paths were sealed on write (notification-channel destinations and
 * credentials in `partners` / `organizations` / `sites` `.settings`).
 *
 * Runs detached at API boot and is idempotent: a row is selected only while
 * one of those paths still holds a plaintext value, so once everything is
 * sealed a boot costs one scan per table that returns nothing.
 *
 * Safety:
 *   - Only the secret leaves are written (`jsonb_set` per path), never the
 *     whole blob, and each write is a compare-and-set on the exact leaf value
 *     it read. A concurrent settings save therefore can never be overwritten;
 *     the leaf is re-read and retried instead.
 *   - Each read and write is its own short system-scope transaction, so the
 *     sweep holds no lock across rows.
 *   - A value is only ever replaced by its own ciphertext; a row whose
 *     sealing fails is left exactly as it was and counted.
 * Readers open these values with `decryptForColumn`, which passes plaintext
 * through, so both states work while the sweep runs.
 */

export const SETTINGS_SECRET_BACKFILL_TABLES = ['partners', 'organizations', 'sites'] as const;
export type SettingsSecretBackfillTable = (typeof SETTINGS_SECRET_BACKFILL_TABLES)[number];

export interface SettingsSecretBackfillStats {
  /** Rows that still held a plaintext value when the sweep reached them. */
  scanned: number;
  /** Rows whose plaintext values were replaced by ciphertext. */
  sealed: number;
  /** Rows changed by concurrent saves on every attempt; left for the next run. */
  contended: number;
  /** Rows that could not be sealed (error logged, row untouched). */
  failed: number;
}

export type SettingsSecretBackfillResult = Record<SettingsSecretBackfillTable, SettingsSecretBackfillStats>;

export interface SettingsSecretBackfillOptions {
  batchSize?: number;
  maxAttempts?: number;
  logger?: Pick<Console, 'error'>;
  /**
   * Test seam: runs between reading a row's leaves and the compare-and-set
   * write, so a test can land a concurrent save in exactly that window.
   */
  beforeWrite?: (table: SettingsSecretBackfillTable, id: string) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

type JsonPath = readonly string[];

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function pathLiteral(path: JsonPath): string {
  return `{${path.join(',')}}`;
}

/** The leaf at `path` as a list of its string values (a string, or a list of strings). */
function leafStringsSql(path: JsonPath): SQL {
  const at = sql`settings #> ${pathLiteral(path)}::text[]`;
  return sql`jsonb_array_elements_text(CASE jsonb_typeof(${at})
    WHEN 'array' THEN ${at}
    WHEN 'string' THEN jsonb_build_array(${at})
    ELSE '[]'::jsonb END)`;
}

/** SQL: this row still holds a non-empty, non-ciphertext string at a secret path. */
function holdsPlaintextSql(): SQL {
  const perPath = SETTINGS_SECRET_JSON_PATHS.map((path) => sql`EXISTS (
    SELECT 1 FROM ${leafStringsSql(path)} AS leaf(value)
    WHERE leaf.value <> '' AND leaf.value NOT LIKE 'enc:v_:%'
  )`);
  return sql.join(perPath, sql` OR `);
}

function holdsPlaintext(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && !isEncryptedSecret(value);
  return Array.isArray(value) && value.some(holdsPlaintext);
}

function atPath(value: unknown, path: JsonPath): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function wrapAtPath(path: JsonPath, leaf: unknown): unknown {
  return path.reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), leaf);
}

function settingsSpec(table: SettingsSecretBackfillTable): EncryptedColumnSpec {
  const spec = encryptedColumnRegistry.find((entry) => entry.table === table && entry.column === 'settings');
  if (!spec) throw new Error(`${table}.settings is not a registered encrypted column`);
  return spec;
}

function inSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function readLeaves(table: SettingsSecretBackfillTable, id: string): Promise<Map<string, unknown> | null> {
  const columns = SETTINGS_SECRET_JSON_PATHS.map(
    (path, index) => sql`settings #> ${pathLiteral(path)}::text[] AS ${sql.identifier(`leaf_${index}`)}`,
  );
  const rows = rowsFromResult(await inSystemScope(() => db.execute(sql`
    SELECT ${sql.join(columns, sql`, `)}
    FROM ${sql.identifier(table)}
    WHERE id = ${id}::uuid
  `)));
  const row = rows[0];
  if (!row) return null;
  const leaves = new Map<string, unknown>();
  SETTINGS_SECRET_JSON_PATHS.forEach((path, index) => leaves.set(pathLiteral(path), row[`leaf_${index}`]));
  return leaves;
}

type RowOutcome = 'sealed' | 'contended' | 'clean';

async function sealRow(
  table: SettingsSecretBackfillTable,
  spec: EncryptedColumnSpec,
  id: string,
  options: ResolvedOptions,
): Promise<RowOutcome> {
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const leaves = await readLeaves(table, id);
    if (!leaves) return 'clean';

    const changes: Array<{ path: JsonPath; original: unknown; sealed: unknown }> = [];
    for (const path of SETTINGS_SECRET_JSON_PATHS) {
      const original = leaves.get(pathLiteral(path));
      if (!holdsPlaintext(original)) continue;
      const sealed = atPath(transformEncryptedColumnValue(spec, wrapAtPath(path, original)), path);
      if (holdsPlaintext(sealed)) {
        throw new Error(`sealing ${table}.settings ${pathLiteral(path)} left a plaintext value`);
      }
      changes.push({ path, original, sealed });
    }
    if (changes.length === 0) return 'clean';

    await options.beforeWrite?.(table, id);
    let next: SQL = sql`settings`;
    const unchanged: SQL[] = [];
    for (const change of changes) {
      next = sql`jsonb_set(${next}, ${pathLiteral(change.path)}::text[], ${JSON.stringify(change.sealed)}::jsonb)`;
      unchanged.push(sql`settings #> ${pathLiteral(change.path)}::text[] = ${JSON.stringify(change.original)}::jsonb`);
    }
    const updated = rowsFromResult(await inSystemScope(() => db.execute(sql`
      UPDATE ${sql.identifier(table)}
      SET settings = ${next}
      WHERE id = ${id}::uuid AND ${sql.join(unchanged, sql` AND `)}
      RETURNING id
    `)));
    if (updated.length > 0) return 'sealed';
  }
  return 'contended';
}

type ResolvedOptions = Required<Omit<SettingsSecretBackfillOptions, 'beforeWrite'>>
  & Pick<SettingsSecretBackfillOptions, 'beforeWrite'>;

async function sealTable(
  table: SettingsSecretBackfillTable,
  options: ResolvedOptions,
): Promise<SettingsSecretBackfillStats> {
  const spec = settingsSpec(table);
  const stats: SettingsSecretBackfillStats = { scanned: 0, sealed: 0, contended: 0, failed: 0 };
  let lastId = NIL_UUID;

  while (true) {
    const batch = rowsFromResult(await inSystemScope(() => db.execute(sql`
      SELECT id::text AS id
      FROM ${sql.identifier(table)}
      WHERE id > ${lastId}::uuid AND (${holdsPlaintextSql()})
      ORDER BY id
      LIMIT ${options.batchSize}
    `)));
    if (batch.length === 0) break;

    for (const row of batch) {
      const id = String(row.id);
      lastId = id;
      stats.scanned += 1;
      try {
        const outcome = await sealRow(table, spec, id, options);
        if (outcome === 'sealed') stats.sealed += 1;
        else if (outcome === 'contended') stats.contended += 1;
      } catch (err) {
        stats.failed += 1;
        options.logger.error(
          `[settings-secrets] could not seal ${table} row ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return stats;
}

export async function sealUnsealedSettingsSecrets(
  options: SettingsSecretBackfillOptions = {},
): Promise<SettingsSecretBackfillResult> {
  const resolved: ResolvedOptions = {
    batchSize: Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000)),
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    logger: options.logger ?? console,
    beforeWrite: options.beforeWrite,
  };
  const result = {} as SettingsSecretBackfillResult;
  for (const table of SETTINGS_SECRET_BACKFILL_TABLES) {
    result[table] = await sealTable(table, resolved);
  }
  return result;
}
