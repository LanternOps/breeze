/**
 * migrationParity — read-only ledger parity check (wave 3.5d-b, #4086).
 *
 * A `worker`-role process NEVER applies migrations — `autoMigrate()` only
 * runs from an `api`/`all`-role process's boot path. Before a worker starts
 * any global worker it must instead WAIT for the connected database's
 * `breeze_migrations` ledger to already contain every core migration this
 * binary ships with (same filename set, matching checksum). Without this
 * gate a worker replica that comes up before an in-flight api-role rollout
 * has finished migrating could run business logic against a schema that
 * doesn't exist yet.
 *
 * Deliberately read-only: this module never writes to `breeze_migrations`
 * and never runs migration SQL. It reuses `autoMigrate.ts`'s own
 * `discoverCoreMigrationFilenames` / `planMigrations` / `partitionLedgerRows`
 * / `hashSql` so there is exactly one definition of "the core migration set"
 * and exactly one checksum algorithm.
 */
import { sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from './index';
import {
  MIGRATION_TABLE,
  discoverCoreMigrationFilenames,
  hashSql,
  partitionLedgerRows,
  planMigrations,
} from './autoMigrate';

export interface WaitForMigrationParityOptions {
  /** Overall deadline before giving up and throwing. Default 120s. */
  timeoutMs?: number;
  /** Base delay between polls (jittered +/-20%). Default 3s. */
  pollIntervalMs?: number;
  /** Progress/diagnostic sink. Default `console.log`. */
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
// +/-20% jitter so a fleet of worker replicas that all boot at once doesn't
// poll Postgres in lockstep.
const POLL_JITTER_FRACTION = 0.2;

interface LedgerRow {
  filename: string;
  checksum: string;
}

interface ParitySnapshot {
  /** On-disk core filenames absent from the ledger entirely. */
  missing: string[];
  /** On-disk core filenames present in the ledger with a different checksum. */
  mismatched: string[];
  /** Verifiable ledger filenames this binary doesn't ship on disk (a newer
   *  binary applied them elsewhere). Informational only — never fails. */
  extra: string[];
}

/**
 * Read the ledger's core (non-namespaced) rows as a filename->checksum map.
 * A not-yet-created ledger table (fresh DB, migrations never run) is treated
 * as an empty ledger — every on-disk filename correctly reports `missing`
 * rather than throwing a raw 42P01.
 */
async function readCoreLedger(): Promise<Map<string, string>> {
  let rows: LedgerRow[];
  try {
    rows = (await db.execute(
      sql`SELECT filename, checksum FROM ${sql.raw(MIGRATION_TABLE)}`
    )) as unknown as LedgerRow[];
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === '42P01') return new Map();
    throw error;
  }

  const { verify } = partitionLedgerRows(rows.map((row) => row.filename));
  const verifiable = new Set(verify);
  return new Map(rows.filter((row) => verifiable.has(row.filename)).map((row) => [row.filename, row.checksum]));
}

async function computeParitySnapshot(): Promise<ParitySnapshot> {
  const filenames = await discoverCoreMigrationFilenames();
  const plan = planMigrations(filenames);
  const ledger = await readCoreLedger();

  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const { ledgerName, filePath } of plan) {
    const ledgerChecksum = ledger.get(ledgerName);
    if (ledgerChecksum === undefined) {
      missing.push(ledgerName);
      continue;
    }
    const content = await readFile(filePath, 'utf8');
    if (hashSql(content) !== ledgerChecksum) {
      mismatched.push(ledgerName);
    }
  }

  const onDisk = new Set(filenames);
  const extra = [...ledger.keys()].filter((name) => !onDisk.has(name));

  return { missing, mismatched, extra };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs: number): number {
  const jitter = baseMs * POLL_JITTER_FRACTION * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + jitter));
}

/**
 * Polls until the connected database's migration ledger matches this
 * binary's on-disk core migration set exactly (filenames + checksums), or
 * throws once `timeoutMs` elapses. Never applies anything — read-only.
 */
export async function waitForMigrationParity(
  opts: WaitForMigrationParityOptions = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = opts.log ?? ((message: string) => console.log(message));

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { missing, mismatched, extra } = await computeParitySnapshot();

    if (extra.length > 0) {
      log(
        `[migration-parity] ledger has ${extra.length} core migration(s) this binary does not ship on disk (a newer binary was applied elsewhere): ${extra.join(', ')}`
      );
    }

    if (missing.length === 0 && mismatched.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing from ledger: ${missing.join(', ')}`);
      if (mismatched.length > 0) parts.push(`checksum mismatch: ${mismatched.join(', ')}`);
      throw new Error(
        `[migration-parity] timed out after ${timeoutMs}ms waiting for the database to reach migration parity (${parts.join('; ')})`
      );
    }

    log(
      `[migration-parity] not yet at parity — ${missing.length} missing, ${mismatched.length} mismatched; retrying...`
    );
    await sleep(jitteredDelay(pollIntervalMs));
  }
}
