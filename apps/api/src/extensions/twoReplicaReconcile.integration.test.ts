import '../__tests__/integration/setup';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autoMigrate } from '../db/autoMigrate';
import { buildScenarioFixture, type FixtureExtensionSpec } from './__fixtures__/twoReplica';

/**
 * Every extension name used by ANY scenario below. The reconciler's
 * boot-time tenancy tripwire (`tenancyTripwire.ts`,
 * `assertNoUnaccountedPublicTables`) scans the WHOLE `public` schema, not
 * just the extensions configured for the current reconcile — so a table left
 * behind by an EARLIER scenario in this same file (extension migrations have
 * no rollback/uninstall path; the table just persists) would read as an
 * unaccounted table to a LATER scenario's child processes, which only
 * declare their own extensions' tenancy. Resetting the full set before every
 * test — not just the current scenario's own names — is what keeps the three
 * scenarios independent of run order and of each other's leftovers.
 */
const ALL_FIXTURE_EXTENSION_NAMES = ['happyreq', 'happyopt', 'reqfail', 'optfail', 'optfailhealthy'] as const;

/**
 * Two-replica reconcile + failure-policy integration test (Task 8 of the
 * `breeze-ext` packer/signer plan, exit criteria 2 & 3 of issue #2619).
 *
 * ARCHITECTURE — why two CHILD PROCESSES, not two in-process calls: the
 * reconciler's DI (`ReconcilePorts`) only covers the bundle/verify/migration
 * path. The DB pool (`db/index.ts`), the tenancy registry
 * (`tenancyRegistry.ts`), and the extracted-root map (`faultAttribution.ts`)
 * are hardwired process-global singletons with no constructor seam — two
 * `reconcileExtensions()` calls in this one Vitest worker would silently
 * SHARE all three, which would prove "one process reconciling twice", not
 * replica convergence. Each child (`__fixtures__/reconcileChild.ts`) is
 * forked as a genuinely separate OS process — separate `db` pool, separate
 * tenancy registry — with its own env set via `fork()`'s `env` option
 * BEFORE the child's first import (the `db` pool opens at module-load time).
 *
 * This file (the parent) authors every fixture: it packs + signs real
 * `.breeze-ext` bundles with the real `@breeze/extension-cli`
 * (`__fixtures__/twoReplica.ts`, mirroring `packerConformance.test.ts`),
 * forks two children per scenario against the SAME `extensions.yaml`, waits
 * for both, then asserts against the shared `:5433` database.
 *
 * DB is migrated once by `globalSetup.ts` (autoMigrate) before any test file
 * runs, so both children connect to an already-migrated schema. Never runs
 * `test:docker:down`.
 */

// This test drives the FULL `reconcileExtensions`, whose tenancy phase
// (`assertNoUnaccountedPublicTables`) sweeps the ENTIRE `public` schema — so it
// cannot share the standard `breeze_test` database, which accumulates tables
// from other extensions' integration runs across worktrees (e.g. `workspace_*`)
// that would read as "unaccounted" and abort every reconcile here. Instead the
// suite provisions its OWN throwaway database (created + migrated in beforeAll,
// dropped in afterAll), so the schema contains only core tables plus this
// test's own accounted-for extension tables. The name matches the test-DB
// safety allowlist (`/^breeze_test(_[a-z0-9]+)?$/`).
const THROWAWAY_DB = 'breeze_test_2rep';

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const BASE_DATABASE_URL_APP =
  process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';

function withDbName(connectionUrl: string, databaseName: string): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

// Children and the parent's `admin` pool all target the throwaway DB; only the
// create/drop DDL runs against the base DB (via `baseAdmin`).
const DATABASE_URL = withDbName(BASE_DATABASE_URL, THROWAWAY_DB);
const DATABASE_URL_APP = withDbName(BASE_DATABASE_URL_APP, THROWAWAY_DB);
const CHILD_JWT_SECRET = 'test-jwt-secret-for-two-replica-reconcile-min-32-chars';

const CHILD_ENTRY_PATH = fileURLToPath(new URL('./__fixtures__/reconcileChild.ts', import.meta.url));

interface ChildResult {
  ok: boolean;
  requiredAbort: boolean;
  activated?: string[];
  failed?: string[];
  skipped?: string[];
  extensionName?: string;
  phase?: string;
  error?: string;
}

interface ChildOutcome {
  exitCode: number | null;
  result: ChildResult | null;
  stdout: string;
  stderr: string;
}

/**
 * Scan stdout BACKWARDS for the last line that parses as JSON. The
 * reconciler and postgres.js both write plain `console.log` lines (e.g.
 * `[extensions] reconciled "..."`, dotenv's `injected env` banner, NOTICE
 * output) ahead of the child's single structured result line
 * (`reconcileChild.ts`'s `emit`), so the LAST line is not a safe assumption —
 * the last line that actually parses is.
 */
function parseChildResult(stdout: string): ChildResult | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      return JSON.parse(line) as ChildResult;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Fork one replica: `reconcileChild.ts` under `tsx`'s `--import` loader hook
 * (Node 22's native ESM `--import` registration — no build step needed for a
 * `.ts` entry). `silent: true` pipes the child's stdout/stderr to this
 * process instead of inheriting the parent's, so they can be captured and
 * parsed rather than interleaving with Vitest's own output.
 */
function runChild(configPath: string, storeRoot: string, artifactsDir: string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_ENTRY_PATH, [configPath, storeRoot], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        DATABASE_URL,
        DATABASE_URL_APP,
        NODE_ENV: 'test',
        JWT_SECRET: CHILD_JWT_SECRET,
        BREEZE_EXTENSIONS_ARTIFACTS_DIR: artifactsDir,
      },
      silent: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      resolve({ exitCode, result: parseChildResult(stdout), stdout, stderr });
    });
  });
}

describe('two-replica reconcile and failure policy (issue #2619, exit criteria 2 & 3)', () => {
  let admin: Sql;
  let baseAdmin: Sql;
  let scratchRoot: string;

  beforeAll(async () => {
    // Provision a pristine throwaway database. FORCE-drop first so a prior
    // interrupted run can't leave stale schema behind (PG 13+; container is 16).
    baseAdmin = postgres(BASE_DATABASE_URL, { max: 1, onnotice: () => {} });
    await baseAdmin.unsafe(`DROP DATABASE IF EXISTS ${THROWAWAY_DB} WITH (FORCE)`);
    await baseAdmin.unsafe(`CREATE DATABASE ${THROWAWAY_DB}`);

    // Migrate the throwaway DB. autoMigrate() (and the ensureAppRole it calls)
    // read DATABASE_URL / DATABASE_URL_APP from the environment at call time and
    // open their own short-lived clients, so pointing env at the throwaway for
    // the duration of this call migrates it — the parent's import-time `db` pool
    // (bound to the base DB) is untouched. Restore env afterward so nothing else
    // in the process observes the swap.
    // Mutating process.env here is safe ONLY because the integration config
    // sets `fileParallelism: false` (vitest.integration.config.ts) — files run
    // strictly sequentially, so no other test file's module graph can observe
    // this swap during the autoMigrate() window. If file parallelism is ever
    // enabled, this must move to a child process or a per-call config override.
    const prevUrl = process.env.DATABASE_URL;
    const prevApp = process.env.DATABASE_URL_APP;
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATABASE_URL_APP = DATABASE_URL_APP;
    try {
      await autoMigrate();
    } finally {
      process.env.DATABASE_URL = prevUrl;
      process.env.DATABASE_URL_APP = prevApp;
    }

    admin = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
    scratchRoot = await mkdtemp(join(tmpdir(), 'breeze-ext-two-replica-'));
  });

  /**
   * Delete only rows/tables THIS test created, scoped by extension name —
   * never a blanket wipe. `breeze_migrations` is shared with core
   * migrations, so the filename filter is load-bearing (matches
   * migrator.ts's `<name>/<file>` ledger namespacing).
   */
  async function resetExtensionState(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await admin`DELETE FROM breeze_migrations WHERE filename LIKE ${`${name}/%`}`;
      await admin`DELETE FROM extension_schema_history WHERE extension_name = ${name}`;
      await admin`DELETE FROM installed_extensions WHERE name = ${name}`;
      await admin.unsafe(`DROP TABLE IF EXISTS ${name}_x`);
    }
  }

  afterAll(async () => {
    // Close the throwaway pool BEFORE dropping the database — FORCE also
    // terminates any lingering sessions (e.g. a child's pool that outlived it).
    if (admin) await admin.end({ timeout: 5 });
    if (baseAdmin) {
      await baseAdmin.unsafe(`DROP DATABASE IF EXISTS ${THROWAWAY_DB} WITH (FORCE)`);
      await baseAdmin.end({ timeout: 5 });
    }
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  });

  // See ALL_FIXTURE_EXTENSION_NAMES: reset every scenario's tables/rows before
  // EVERY test (not just the current one's), so leftovers from an earlier
  // scenario in this run — or a previous, interrupted run — can never read as
  // "unaccounted" to a later scenario's tenancy tripwire check.
  beforeEach(async () => {
    await resetExtensionState(ALL_FIXTURE_EXTENSION_NAMES);
  });

  async function makeChildRoots(scenario: string, replica: 'a' | 'b') {
    const artifactsDir = join(scratchRoot, scenario, `artifacts-${replica}`);
    const storeRoot = join(scratchRoot, scenario, `store-${replica}`);
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(storeRoot, { recursive: true });
    return { artifactsDir, storeRoot };
  }

  /** Build a scenario's fixtures, fork two replicas against it, and return both outcomes. */
  async function runScenario(
    scenario: string,
    specs: readonly FixtureExtensionSpec[],
  ): Promise<[ChildOutcome, ChildOutcome]> {
    const root = join(scratchRoot, scenario);
    await mkdir(root, { recursive: true });
    const fixture = await buildScenarioFixture(root, 'acme', specs);
    const [rootA, rootB] = await Promise.all([
      makeChildRoots(scenario, 'a'),
      makeChildRoots(scenario, 'b'),
    ]);
    return Promise.all([
      runChild(fixture.configPath, rootA.storeRoot, rootA.artifactsDir),
      runChild(fixture.configPath, rootB.storeRoot, rootB.artifactsDir),
    ]);
  }

  it('happy path: both replicas activate a required + optional extension; each migration applies exactly once', async () => {
    const names = ['happyreq', 'happyopt'] as const;

    const specs: FixtureExtensionSpec[] = [
      {
        name: 'happyreq',
        required: true,
        // No `IF NOT EXISTS`: a genuine second execution of this DDL would
        // throw "relation already exists" — half of the exactly-once proof.
        migrationSql: 'CREATE TABLE happyreq_x (id int NOT NULL);\n',
        nonTenantTables: ['happyreq_x'],
      },
      {
        name: 'happyopt',
        required: false,
        migrationSql: 'CREATE TABLE happyopt_x (id int NOT NULL);\n',
        nonTenantTables: ['happyopt_x'],
      },
    ];

    const [outcomeA, outcomeB] = await runScenario('happy', specs);

    for (const [label, outcome] of [['A', outcomeA], ['B', outcomeB]] as const) {
      expect(outcome.exitCode, `child ${label} did not exit 0 — stdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`).toBe(0);
      expect(outcome.result?.ok, `child ${label} result: ${JSON.stringify(outcome.result)}`).toBe(true);
      expect(outcome.result?.failed).toEqual([]);
      // Both replicas converge on the SAME active set.
      expect([...(outcome.result?.activated ?? [])].sort()).toEqual(['happyopt', 'happyreq']);
    }

    // Exactly-once, evidence 1: the ledger row count for each migration is
    // exactly 1 — `recordMigration` is `ON CONFLICT (filename) DO NOTHING`
    // (autoMigrate.ts), so a bare count of 1 alone can't distinguish "applied
    // once" from "applied twice, second insert absorbed". Evidence 2 (below)
    // closes that gap.
    for (const name of names) {
      const rows = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM breeze_migrations WHERE filename = ${`${name}/0001_init.sql`}`;
      expect(rows[0]?.n, `${name} ledger row count`).toBe(1);
    }
    // Exactly-once, evidence 2: the fixture migration is deliberately
    // NON-IDEMPOTENT (CREATE TABLE with no IF NOT EXISTS). Both children
    // reported ok:true with no failures above; had the migrator's
    // advisory-lock + ledger-skip guard NOT serialized the two replicas, the
    // second replica's raw DDL execution would have thrown "relation
    // \"happyreq_x\" already exists" and that child would have reported a
    // failure instead. A clean pass on both children IS the proof the second
    // replica took the ledger-skip path, not a second real execution.

    const stateRows = await admin<{ name: string; lifecycle_state: string }[]>`
      SELECT name, lifecycle_state FROM installed_extensions WHERE name = ANY(${names as unknown as string[]})`;
    const byName = Object.fromEntries(stateRows.map((row) => [row.name, row.lifecycle_state]));
    expect(byName.happyreq).toBe('active');
    expect(byName.happyopt).toBe('active');
  });

  it('required failure: a genuinely failing required extension aborts boot on both replicas', async () => {
    const names = ['reqfail'] as const;

    const specs: FixtureExtensionSpec[] = [
      {
        name: 'reqfail',
        required: true,
        // Genuinely failing DDL (a real NOT NULL constraint violation, not a
        // stubbed error path): the whole file runs in one transaction, so
        // this rolls back the CREATE TABLE too — no table, no ledger row.
        migrationSql: 'CREATE TABLE reqfail_x (id int NOT NULL);\nINSERT INTO reqfail_x (id) VALUES (NULL);\n',
        nonTenantTables: ['reqfail_x'],
      },
    ];

    const [outcomeA, outcomeB] = await runScenario('reqfail', specs);

    for (const [label, outcome] of [['A', outcomeA], ['B', outcomeB]] as const) {
      expect(outcome.exitCode, `child ${label} — stdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`).toBe(1);
      expect(outcome.result?.requiredAbort, `child ${label} result: ${JSON.stringify(outcome.result)}`).toBe(true);
      expect(outcome.result?.extensionName).toBe('reqfail');
      expect(outcome.result?.phase).toBe('migration');
    }

    // Atomic rollback: the failing file never committed, so its table was
    // never created — by EITHER replica.
    const tableRows = await admin<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reqfail_x'
      ) AS present`;
    expect(tableRows[0]?.present).toBe(false);

    const ledgerRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM breeze_migrations WHERE filename = 'reqfail/0001_init.sql'`;
    expect(ledgerRows[0]?.n).toBe(0);

    const stateRows = await admin<{ lifecycle_state: string }[]>`
      SELECT lifecycle_state FROM installed_extensions WHERE name = 'reqfail'`;
    expect(stateRows[0]?.lifecycle_state).toBe('failed');
  });

  it('optional failure: a genuinely failing optional extension is withdrawn while a co-installed healthy extension still activates on both replicas', async () => {
    const names = ['optfail', 'optfailhealthy'] as const;

    const specs: FixtureExtensionSpec[] = [
      {
        name: 'optfail',
        required: false,
        migrationSql: 'CREATE TABLE optfail_x (id int NOT NULL);\nINSERT INTO optfail_x (id) VALUES (NULL);\n',
        nonTenantTables: ['optfail_x'],
      },
      {
        name: 'optfailhealthy',
        required: true,
        migrationSql: 'CREATE TABLE optfailhealthy_x (id int NOT NULL);\n',
        nonTenantTables: ['optfailhealthy_x'],
      },
    ];

    const [outcomeA, outcomeB] = await runScenario('optfail', specs);

    for (const [label, outcome] of [['A', outcomeA], ['B', outcomeB]] as const) {
      // No throw, resolves, and boot continues: BOTH replicas keep booting.
      expect(outcome.exitCode, `child ${label} — stdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`).toBe(0);
      expect(outcome.result?.ok, `child ${label} result: ${JSON.stringify(outcome.result)}`).toBe(true);
      expect(outcome.result?.failed).toEqual(['optfail']);
      // The co-installed healthy extension still activates.
      expect(outcome.result?.activated).toEqual(['optfailhealthy']);
    }

    const stateRows = await admin<{ name: string; lifecycle_state: string }[]>`
      SELECT name, lifecycle_state FROM installed_extensions WHERE name = ANY(${names as unknown as string[]})`;
    const byName = Object.fromEntries(stateRows.map((row) => [row.name, row.lifecycle_state]));
    // recordSanitizedFailure maps a plain Error to 'failed' (not 'incompatible',
    // which is reserved for ExtensionIncompatibleError — see reconciler.ts).
    expect(byName.optfail).toBe('failed');
    expect(byName.optfailhealthy).toBe('active');

    const tableRows = await admin<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'optfail_x'
      ) AS present`;
    expect(tableRows[0]?.present).toBe(false);
  });
});
