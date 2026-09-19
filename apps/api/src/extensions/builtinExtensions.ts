// The startup loading path for BUILT-IN extensions: first-party extensions that
// are compiled into the core image and imported statically. This is the ONLY
// extension delivery path — the legacy source-directory loader and the signed
// runtime-bundle reconciler are both gone.
//
// Compiled in ≠ loaded. Each built-in carries a deployment enable flag
// (BuiltinExtension.enableEnvVar) and is OFF by default; only an explicitly
// enabled built-in runs the pipeline below. See skipDisabledBuiltin for what a
// switched-off built-in still does (one log line, plus a tenancy declaration
// narrowed to whichever of its tables are actually on the database — none, some
// or all — and the RLS tripwire over that declaration).
//
// The phase order is migration → tenancy → stage → validate → activate → web
// asset. There is no acquire / trust / verify / extract phase: the code is
// already here, already ours, already covered by the core image's own supply
// chain.
//
// Failure policy: a built-in is first-party REQUIRED code shipped inside the
// image, so any phase failure propagates and aborts boot. There is no
// half-working built-in state to preserve, and silently degrading one would
// hide a broken image.
//
// Every I/O seam is an injectable PORT, so these behaviors are unit-testable
// with no filesystem or DB — including the built-in LIST itself, so tests never
// load the real extension.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { SHARED_TABLE_ALLOWLIST } from '@breeze/extension-sdk';
import type {
  BreezeExtensionV1,
  ExtensionManifestV1,
  ExtensionTenancyDeclaration,
} from '@breeze/extension-sdk';
import {
  BUILTINS,
  resolveBuiltinRoot,
  type BuiltinExtension,
} from './builtinRegistry';
import type {
  ExtensionContributionRegistry,
  StagedExtensionContributions,
} from './contributionRegistry';
import type { ExtensionStateStore } from './stateStore';
import { defaultStageExtension } from './stageExtension';
import {
  checkExtensionMigrationParity,
  reconcileExtensionMigrations,
  type MigratableExtension,
} from './migrator';
import { registerRuntimeExtensionTenancy } from './tenancyRegistry';
import { assertExtensionTenancyRls, assertNoUnaccountedPublicTables } from './tenancyTripwire';
import { registerExtensionWebAsset, type RegisterableExtensionWebAsset } from './webAssets';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';
import { MIGRATION_TABLE } from '../db/autoMigrate';

export { BUILTIN_EXTENSION_NAMES, builtinTenancyDeclarations } from './builtinRegistry';
export type { BuiltinExtension } from './builtinRegistry';

/**
 * The built-in's migration files, read from the package directory. A built-in
 * has no signed inventory to read them out of: the files ship inside the core
 * image, so the image itself is the integrity boundary.
 */
function readDiskMigrations(
  root: string,
  migrationsDir: string,
): MigratableExtension['migrations'] {
  const dir = path.join(root, migrationsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ filename, sql: readFileSync(path.join(dir, filename), 'utf8') }));
}

/**
 * Hash `<pkg>/dist/web` at boot into the inventory shape
 * {@link registerExtensionWebAsset} expects — members named `web/<relpath>`,
 * root `<pkg>/dist` — with a digest over the sorted inventory so the
 * digest-addressed asset route stays cache-coherent across deploys (a built-in
 * has no signed `artifactDigest` to borrow).
 *
 * Throws an ENOENT-coded error when the web bundle was never built.
 */
export function readWebDist(root: string): RegisterableExtensionWebAsset {
  const distRoot = path.join(root, 'dist');
  const webDir = path.join(distRoot, 'web');
  if (!existsSync(webDir)) {
    throw Object.assign(new Error(`missing ${webDir}`), { code: 'ENOENT' });
  }
  const files = new Map<string, { sha256: string; uncompressedSize: number }>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const bytes = readFileSync(full);
      files.set(path.relative(distRoot, full).split(path.sep).join('/'), {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uncompressedSize: bytes.length,
      });
    }
  };
  walk(webDir);
  const digest = createHash('sha256')
    .update([...files.keys()].sort().map((key) => `${key}:${files.get(key)!.sha256}`).join('\n'))
    .digest('hex');
  return { root: distRoot, digest: `sha256:${digest}`, files };
}

/**
 * `reconcileExtensionMigrations`'s rolling-update gate refuses to apply
 * migrations whose schema floor is above the still-serving active version. A
 * built-in's code and its migrations ship together inside the core image, on
 * the core image's own deploy cadence, so a 'rolling' gate here could only
 * wedge boot with no way out. Built-ins therefore migrate like core migrations
 * do (autoMigrate applies core SQL with no such gate): raising a built-in's `schemaCompatibilityFloor` is a breaking
 * change that must be coordinated with the core deploy, exactly as a breaking
 * core migration is.
 */
const BUILTIN_MIGRATION_ROLLOUT = 'replace' as const;

/**
 * Is this built-in switched ON for this deployment?
 *
 * Strict-string convention: anything other than the exact string `'true'` —
 * unset, empty, `'1'`, `'TRUE'` — leaves the built-in unloaded. Default OFF is
 * the point: being compiled into the image must not oblige every deployment to
 * satisfy the built-in's infrastructure requirements (workspace needs pgvector) or carry its
 * schema.
 */
export function isBuiltinEnabled(builtin: BuiltinExtension): boolean {
  return process.env[builtin.enableEnvVar] === 'true';
}

/**
 * Every distinct table the manifest's tenancy declaration names, sorted — the
 * exact set that publishing the declaration would hand to core's cascade,
 * device-move and tenant-export code, plus the `nonTenantTables` opt-out list.
 *
 * `nonTenantTables` is included deliberately even though core's cascade/export
 * code never touches it: the RLS tripwire {@link assertExtensionTenancyRls}
 * VERIFIES the opt-out against the live catalog and reports a declared-but-
 * absent entry as a boot-failing problem. Since the disabled path now publishes
 * a declaration filtered to the tables that actually exist (and asserts RLS over
 * it), the opt-out list has to be probed and filtered alongside the four tenant
 * lists or a partially-migrated database would abort boot on it.
 */
function declaredTenancyTables(manifest: Pick<ExtensionManifestV1, 'tenancy'>): string[] {
  const { tenancy } = manifest;
  // `deviceOrgMoveDeleteTables` and `nonTenantTables` are optional in the v1
  // schema; the other three are not.
  return [
    ...new Set([
      ...tenancy.orgCascadeDeleteTables,
      ...tenancy.deviceCascadeDeleteTables,
      ...tenancy.deviceOrgDenormalizedTables,
      ...(tenancy.deviceOrgMoveDeleteTables ?? []),
      ...(tenancy.nonTenantTables ?? []),
    ]),
  ].sort();
}

/**
 * A copy of `tenancy` with every table LIST narrowed to the tables in `present`.
 *
 * Pure — no I/O, no mutation of the input — because it is the load-bearing half
 * of the disabled path's partial-schema handling (see
 * {@link skipDisabledBuiltin}) and has to be assertable on its own.
 *
 * `orgExportColumns` is deliberately left WHOLE. The export registry
 * (`getExtensionOrgExportColumns`) iterates `orgCascadeDeleteTables` and looks
 * each entry UP in `orgExportColumns`; a classification for a table that is no
 * longer declared is never read, so it is inert. Dropping entries would only
 * risk desynchronising the two halves for no benefit.
 */
export function filterTenancyDeclaration(
  tenancy: ExtensionTenancyDeclaration,
  present: ReadonlySet<string>,
): ExtensionTenancyDeclaration {
  const keep = (tables: readonly string[]): string[] =>
    tables.filter((table) => present.has(table));
  return {
    ...tenancy,
    orgCascadeDeleteTables: keep(tenancy.orgCascadeDeleteTables),
    deviceCascadeDeleteTables: keep(tenancy.deviceCascadeDeleteTables),
    deviceOrgDenormalizedTables: keep(tenancy.deviceOrgDenormalizedTables),
    // Preserve "absent" vs "present but empty" for the two optional lists: the
    // v1 schema distinguishes them, and manufacturing an empty array where the
    // manifest had none would change what a downstream `?? []` observes.
    ...(tenancy.deviceOrgMoveDeleteTables === undefined
      ? {}
      : { deviceOrgMoveDeleteTables: keep(tenancy.deviceOrgMoveDeleteTables) }),
    ...(tenancy.nonTenantTables === undefined
      ? {}
      : { nonTenantTables: keep(tenancy.nonTenantTables) }),
  };
}

/**
 * The pgvector-unavailable fragment Postgres puts in `CREATE EXTENSION vector`'s
 * error. It matches the ENGLISH server message; a server running under another
 * `lc_messages` locale simply falls through and the operator sees the raw
 * Postgres error, which is the safe direction. Do NOT loosen this to something
 * locale-independent-looking (e.g. just `vector`) — a broad match would
 * reinterpret unrelated failures as a pgvector problem and send operators after
 * the wrong remedy.
 */
const PGVECTOR_UNAVAILABLE_FRAGMENT = '"vector" is not available';

/**
 * Run a built-in's migrations, translating ONE known-and-actionable
 * infrastructure failure into an operator-facing error.
 *
 * `CREATE EXTENSION vector` on a stock Postgres image fails with a bare
 * `extension "vector" is not available` and an SQL file name — true, but it
 * names neither the requirement nor either way out, and it aborts boot. The
 * match is deliberately narrow (that one message fragment); everything else
 * rethrows untouched rather than being reinterpreted.
 */
async function runBuiltinMigrations(
  builtin: BuiltinExtension,
  sql: postgres.Sql | null,
  stateStore: ExtensionStateStore,
  ports: BuiltinPorts,
): Promise<void> {
  try {
    await ports.runMigrations(builtin, sql, stateStore);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(PGVECTOR_UNAVAILABLE_FRAGMENT)) throw error;
    throw new Error(
      [
        `[extensions] built-in "${builtin.manifest.name}" is enabled ` +
          `(${builtin.enableEnvVar}=true) but its migrations require the PostgreSQL ` +
          '"vector" (pgvector) extension, which this database does not provide.',
        'Either:',
        '  - run a pgvector-enabled Postgres image (e.g. pgvector/pgvector:pg16), or',
        `  - unset ${builtin.enableEnvVar} (or set it to "false") to leave this built-in unloaded.`,
        `Original error: ${message}`,
      ].join('\n'),
      { cause: error },
    );
  }
}

/**
 * Every I/O seam the built-in loader touches, as a port. Production builds the
 * real set via {@link buildDefaultPorts}; tests inject fakes.
 */
export interface BuiltinPorts {
  /** The built-ins to load. A port so tests never import the real package. */
  builtins: readonly BuiltinExtension[];
  /** The privileged migration connection, opened once and closed in a finally. */
  createMigrationSql(): postgres.Sql | null;
  runMigrations(
    builtin: BuiltinExtension,
    sql: postgres.Sql | null,
    stateStore: ExtensionStateStore,
  ): Promise<void>;
  /**
   * The `mode: 'worker'` counterpart to `runMigrations`: verifies (never
   * applies) that this built-in's on-disk migrations are already fully
   * reflected in the ledger. Throws if not — a worker-role process aborts
   * boot rather than proceeding against a schema an api/all-role process
   * hasn't finished migrating yet.
   */
  checkMigrationParity(builtin: BuiltinExtension, sql: postgres.Sql | null): Promise<void>;
  publishTenancy(manifest: ExtensionManifestV1): void;
  /**
   * Has this built-in ever applied even ONE migration on this database? Used
   * ONLY on the disabled path, and ONLY when the manifest could not be
   * resolved, to decide whether an unreadable manifest is survivable.
   *
   * Extension migrations and their namespaced ledger rows commit in the SAME
   * transaction (see migrator.ts), so the ABSENCE of any ledger row means the
   * built-in never created a table here — including for a partially-applied
   * multi-file run, which leaves both the committed tables and their rows.
   *
   * That is an inference about an INTACT ledger, not a survey of the schema:
   * it does not hold on a database whose `breeze_migrations` rows were dropped
   * or restored separately from the tables they describe. The manifest is
   * unreadable on this path, so there is no declared-table list to survey
   * instead — hence the deliberately loud log on the continue branch.
   */
  builtinEverMigrated(extensionName: string): Promise<boolean>;
  /**
   * WHICH of these public tables already exist — the present SUBSET, not a
   * yes/no. Used ONLY on the disabled path, where it decides both whether a
   * switched-off built-in's tenancy declaration still has to be published AND
   * which tables that declaration may name (see {@link skipDisabledBuiltin}: a
   * PARTIAL schema must publish a partial declaration, never the whole
   * manifest's). Opens and closes its own short-lived connection — the disabled
   * path never opens the privileged migration connection, and must not leave one
   * behind either.
   */
  existingDeclaredTables(tables: readonly string[]): Promise<string[]>;
  stageExtension(
    module: BreezeExtensionV1,
    manifest: ExtensionManifestV1,
    opts: { helperRoutes: boolean },
  ): Promise<StagedExtensionContributions>;
  /**
   * The boot-time RLS tripwire over ONE tenancy declaration. Takes the
   * declaration rather than the manifest because the disabled path asserts over
   * a FILTERED copy (only the tables that exist), which is the declaration that
   * actually gets published — asserting the manifest's whole tenancy there would
   * fail on every table whose migration never ran.
   */
  validateTenancyDeclaration(
    extensionName: string,
    tenancy: ExtensionTenancyDeclaration,
  ): Promise<void>;
  /** Final catalog sweep, after every enabled or persisted disabled declaration is known. */
  validatePublicTables(tenancies: readonly ExtensionTenancyDeclaration[]): Promise<void>;
  registerRateLimitSkip(prefix: string): void;
  /** Is `<root>/dist/web` present? An I/O seam, hence a port (see registerBuiltinWebAsset). */
  webDistExists(root: string): boolean;
  readWebDist(root: string): RegisterableExtensionWebAsset;
  registerWebAsset(name: string, asset: RegisterableExtensionWebAsset): void;
}

/**
 * The production {@link BuiltinPorts.existingDeclaredTables}: which of `tables`
 * exist as ordinary/partitioned tables in `public`, on a short-lived connection
 * of its own.
 *
 * Exported so `builtinTableProbe.integration.test.ts` can drive this exact SQL
 * against a real server. It is the one query on the disabled path that the unit
 * tests cannot cover — they stub the port — and the previous binding shape in
 * this function was broken against a live Postgres while passing every unit
 * test.
 */
export async function defaultExistingDeclaredTables(
  tables: readonly string[],
): Promise<string[]> {
  if (tables.length === 0) return [];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to check whether a disabled built-in extension left tables behind',
    );
  }
  // ONE round trip, one connection, always closed. The names are bound as a
  // plain scalar IN-list via postgres.js's documented `sql([...])` list helper —
  // deliberately NO array parameter: binding a `text[]` (via sql.array or a
  // ::json cast) mis-serialized against a real server ("malformed array
  // literal"; caught by the live default-off boot check).
  //
  // `pg_class`, not `information_schema.tables`: the information_schema views
  // are filtered by the CURRENT ROLE'S PRIVILEGES, so a table the connecting
  // role holds no privilege on reads as ABSENT — which on this path would
  // silently drop it from the published declaration and reintroduce exactly the
  // unaccounted-table boot abort the declaration exists to prevent. pg_class is
  // privilege-independent, and `relkind IN ('r','p')` says "ordinary or
  // partitioned TABLE" precisely, with no views/matviews/indexes slipping in.
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname IN ${sql([...tables])}
    `;
    return rows.map((row) => row.name);
  } finally {
    // A close failure must never REPLACE the probe's own result or error: an
    // exception thrown from a `finally` discards the in-flight one.
    await sql.end().catch(() => {});
  }
}

/**
 * The production {@link BuiltinPorts.builtinEverMigrated}: whether the core
 * migration ledger contains any namespaced row for this built-in.
 *
 * Exported for the same reason as {@link defaultExistingDeclaredTables}: an
 * integration test can drive this exact SQL against a real server.
 */
export async function defaultBuiltinEverMigrated(extensionName: string): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to decide whether a disabled built-in with an unreadable manifest ever ran here',
    );
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // MIGRATION_TABLE is a hardcoded constant (never user input); the LIKE
    // pattern is parameterized.
    const rows = await sql.unsafe<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${MIGRATION_TABLE} WHERE filename LIKE $1) AS present`,
      [`${extensionName}/%`],
    );
    return rows[0]?.present === true;
  } finally {
    // A close failure must never REPLACE the probe's own result or error: an
    // exception thrown from a `finally` discards the in-flight one.
    await sql.end().catch(() => {});
  }
}

export interface LoadBuiltinExtensionsArgs {
  registry: ExtensionContributionRegistry;
  stateStore: ExtensionStateStore;
  /** Test seam: overrides merged over {@link buildDefaultPorts}. */
  ports?: Partial<BuiltinPorts>;
  /**
   * `'full'` (default) is today's pipeline, unchanged: migrate → publish
   * tenancy → stage → validate → seed state → activate → register web asset.
   *
   * `'worker'` (wave 3.5d-b, #4086) is for a `BREEZE_ROLE=worker` process,
   * which has no HTTP server to serve a web asset from and must never apply
   * migrations itself: the migrate step is replaced with a read-only parity
   * CHECK (never applies — {@link checkExtensionMigrationParity}), and the
   * final web-asset registration step is skipped entirely. Every other step
   * (publish tenancy, stage, validate, seed state, activate) runs exactly as
   * `'full'` does, because a worker process still needs the extension's
   * staged job/tool contributions registered.
   */
  mode?: 'full' | 'worker';
}

function buildDefaultPorts(args: LoadBuiltinExtensionsArgs): BuiltinPorts {
  return {
    builtins: BUILTINS,
    createMigrationSql: () => {
      // The migration connection is privileged (it issues extension DDL). Never
      // substitute a guessed DSN for a missing DATABASE_URL.
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL is required to run built-in extension migrations');
      }
      return postgres(databaseUrl, { max: 2 });
    },
    runMigrations: async (builtin, sql, stateStore) => {
      if (!sql) throw new Error('migration client is unavailable');
      const root = resolveBuiltinRoot(builtin.packageDir);
      await reconcileExtensionMigrations(
        {
          name: builtin.manifest.name,
          version: builtin.manifest.version,
          schemaCompatibilityFloor: builtin.manifest.schemaCompatibilityFloor,
          migrations: readDiskMigrations(root, builtin.manifest.migrationsDir),
        },
        sql,
        stateStore,
        BUILTIN_MIGRATION_ROLLOUT,
      );
    },
    checkMigrationParity: async (builtin, sql) => {
      if (!sql) throw new Error('migration client is unavailable');
      const root = resolveBuiltinRoot(builtin.packageDir);
      const migrations = readDiskMigrations(root, builtin.manifest.migrationsDir);
      const { missing, mismatched } = await checkExtensionMigrationParity(
        { name: builtin.manifest.name, migrations },
        sql,
      );
      if (missing.length > 0 || mismatched.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing from ledger: ${missing.join(', ')}`);
        if (mismatched.length > 0) parts.push(`checksum mismatch: ${mismatched.join(', ')}`);
        throw new Error(
          `[extensions] built-in "${builtin.manifest.name}" is not at migration parity on a ` +
            `worker-role process (${parts.join('; ')}) — an api/all-role process must apply its ` +
            'migrations first',
        );
      }
    },
    publishTenancy: (manifest) => registerRuntimeExtensionTenancy(manifest.tenancy),
    builtinEverMigrated: defaultBuiltinEverMigrated,
    existingDeclaredTables: defaultExistingDeclaredTables,
    stageExtension: (module, manifest, opts) =>
      defaultStageExtension(module, manifest, args.registry, opts),
    validatePublicTables: assertNoUnaccountedPublicTables,
    validateTenancyDeclaration: (extensionName, tenancy) =>
      assertExtensionTenancyRls(extensionName, tenancy),
    registerRateLimitSkip: registerGlobalRateLimitSkipPrefix,
    webDistExists: (root) => existsSync(path.join(root, 'dist', 'web')),
    readWebDist,
    registerWebAsset: registerExtensionWebAsset,
  };
}

/**
 * Register the built-in's web bundle, or explain why it is missing.
 *
 * In PRODUCTION a missing `dist/web` means a misbuilt image and fails boot: the
 * extension's pages would 404 at runtime with nothing in the logs tying it back
 * to the build. In development it is the ordinary API-only case, so one
 * structured warning is emitted and the server routes activate regardless.
 *
 * The absent-bundle case is decided by an EXPLICIT existence check, not by
 * catching `ENOENT` around the whole operation. Catching was too wide: a walk
 * error inside `readWebDist` (a file vanishing mid-walk, a dangling symlink) or
 * an ENOENT thrown by `registerWebAsset` itself would have been swallowed as
 * "not built" in every non-production environment. Now only the one condition
 * this policy is about — the directory is not there — takes the lenient branch;
 * every other failure, in every environment, propagates and aborts boot.
 */
function registerBuiltinWebAsset(builtin: BuiltinExtension, ports: BuiltinPorts): void {
  const name = builtin.manifest.name;
  const root = resolveBuiltinRoot(builtin.packageDir);
  if (!ports.webDistExists(root)) {
    const webDir = path.join(root, 'dist', 'web');
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `[extensions] built-in "${name}" has no web bundle at ${webDir} — this image is misbuilt. ` +
          `The release build runs "pnpm --filter ${builtin.packageName} build:web" and COPYs ` +
          `"${builtin.packageDir}/dist" into the image; without it the extension's pages 404 at ` +
          'runtime with nothing in the logs pointing back at the build.',
      );
    }
    console.warn(
      `[extensions] ${JSON.stringify({
        event: 'builtin_web_dist_missing',
        extension: name,
        packageDir: builtin.packageDir,
        webDir,
        message: 'built-in web bundle is not built; server routes are active but its pages will not load',
        remedy: `pnpm --filter ${builtin.packageName} build:web`,
      })}`,
    );
    return;
  }
  ports.registerWebAsset(name, ports.readWebDist(root));
}

async function handleUnavailableDisabledManifest(
  builtin: BuiltinExtension,
  ports: BuiltinPorts,
  manifestError: unknown,
): Promise<void> {
  let everMigrated: boolean;
  try {
    everMigrated = await ports.builtinEverMigrated(builtin.name);
  } catch (probeError) {
    throw new Error(
      `[extensions] built-in "${builtin.name}" is DISABLED ` +
        `(${builtin.enableEnvVar} is not "true") and its manifest was also unavailable, so ` +
        'we cannot decide whether it left tables behind on this database.',
      { cause: probeError },
    );
  }

  const manifestErrorMessage =
    manifestError instanceof Error ? manifestError.message : String(manifestError);
  if (everMigrated) {
    throw new Error(
      `[extensions] built-in "${builtin.name}" is DISABLED ` +
        `(${builtin.enableEnvVar} is not "true") but it has applied migrations on this ` +
        'database, so its tables may exist; their tenancy MUST still be declared or ' +
        'org-deletion cascades and the GDPR tenant-export path silently skip their rows. ' +
        'That declaration comes from the manifest, which could not be read. ' +
        `Restore "${builtin.packageDir}/manifest.json" in the image (the release Dockerfile ` +
        'COPYs it), or drop the orphaned tables. ' +
        `Original manifest error: ${manifestErrorMessage}`,
      { cause: manifestError },
    );
  }

  // console.ERROR, not warn, even though boot continues. Every other branch in
  // this file that could strand tenant rows THROWS; this is the one place we
  // proceed on an inference instead, and if that inference is ever wrong the
  // damage (org-cascade and tenant-export skipping real rows) is silent and
  // only discovered at erasure time. The one line an operator gets has to be
  // greppable at error level and has to name the assumption it rests on.
  console.error(
    `[extensions] ${JSON.stringify({
      event: 'builtin_extension_manifest_unavailable',
      extension: builtin.name,
      packageDir: builtin.packageDir,
      enableFlag: builtin.enableEnvVar,
      error: manifestErrorMessage,
      reason:
        'this built-in is disabled and has no row in the migration ledger, so it never ' +
        'created a table on this database and there is no tenancy to declare — boot continues',
      assumption:
        'the migration ledger is intact. If this database had its breeze_migrations rows ' +
        'dropped or restored separately from the tables they describe, this built-in may own ' +
        'tables that org-cascade and tenant-export will NOT cover while its manifest is ' +
        'unreadable',
      remedy:
        `restore "${builtin.packageDir}/manifest.json" in the image; enabling it ` +
        `(${builtin.enableEnvVar}=true) requires it in any case`,
    })}`,
  );
}

/**
 * The DISABLED path: everything a switched-off built-in still owes the boot,
 * which is one log line and — conditionally — its tenancy declaration.
 *
 * No migrations, no staging, no activation, no `installed_extensions` row, no
 * web-dist requirement: a deployment that never enabled this built-in must boot
 * on plain Postgres with none of the built-in's infrastructure.
 *
 * If its manifest is unreadable there is no declared-table list to work from at
 * all, so the decision falls back to the namespaced migration ledger: a built-in
 * with no `<name>/…` row never applied a migration here and therefore created
 * none of its tables. Only then is skipping safe. A ledger row — or a ledger
 * probe that fails — aborts boot instead, because the alternative is dropping
 * tenancy for tables that demonstrably (or possibly) exist. That inference
 * assumes an intact ledger rather than surveying the schema, which is why the
 * continue branch logs at ERROR: see handleUnavailableDisabledManifest.
 *
 * Tenancy is the one exception, and it cuts BOTH ways:
 *
 *   • If the built-in's tables EXIST (a previous boot had it enabled and its
 *     migrations ran), the declaration must still be published. The repo-wide
 *     `assertNoUnaccountedPublicTables` sweep would otherwise read those
 *     orphaned `workspace_*` tables as belonging to no manifest and abort boot,
 *     and org-deletion cascades would silently skip the rows in them.
 *   • If they DO NOT exist, publishing is actively harmful: core cascade,
 *     device-move and tenant-export code iterates the declared tables and
 *     issues SQL against each one, which would now name relations that were
 *     never created.
 *
 * And the two cases are not exhaustive: a PARTIAL schema is a real, reachable
 * state. Enabling the built-in on a database that cannot satisfy its migrations
 * aborts boot mid-sequence, leaving the tables from the files that DID commit
 * and none from the files that did not. (Concretely: workspace on a stock
 * `postgres:16-alpine` gets three of its migration files applied and dies on the
 * fourth's `CREATE EXTENSION vector`.) Unsetting the flag then reaches this
 * function with SOME tables present. Publishing the manifest's WHOLE declaration
 * there would point org-cascade and tenant-export SQL at the relations that were
 * never created — the exact harm the second bullet describes, just triggered by
 * a half-finished migration run instead of a never-started one.
 *
 * So the probe returns the present SUBSET and what gets published is a
 * declaration FILTERED to it. That is safe in both directions: the
 * unaccounted-table sweep only examines tables that EXIST, so a filtered
 * declaration still accounts for every one of them, while cascade/export/
 * device-move never name a missing relation. A partial set also earns a
 * structured warning — a half-migrated built-in is an operator problem, not a
 * steady state.
 *
 * Finally, the published declaration gets the SAME boot-time RLS tripwire the
 * enabled path applies. Orphaned tables still hold tenant rows; whether the
 * feature is switched on has no bearing on whether those rows are protected.
 */
async function skipDisabledBuiltin(
  builtin: BuiltinExtension,
  ports: BuiltinPorts,
): Promise<ExtensionTenancyDeclaration | undefined> {
  const raw = process.env[builtin.enableEnvVar];
  console.warn(
    `[extensions] ${JSON.stringify({
      event: 'builtin_extension_disabled',
      extension: builtin.name,
      reason:
        raw === undefined
          ? 'built-in extensions are opt-in per deployment and this one is not enabled'
          : `${builtin.enableEnvVar} is SET but is not the exact string "true"; the flag is ` +
            'value-strict (no "1"/"TRUE"/"yes"), so this built-in stays OFF',
      enableFlag: builtin.enableEnvVar,
      // Distinguishes "never configured" from "configured wrong" in the log
      // itself, so a typo'd flag does not read identically to an absent one.
      observedValue: raw === undefined ? null : raw,
    })}`,
  );

  let manifest: ExtensionManifestV1;
  try {
    manifest = builtin.manifest;
  } catch (error) {
    await handleUnavailableDisabledManifest(builtin, ports, error);
    return;
  }

  const tables = declaredTenancyTables(manifest);
  if (tables.length === 0) return;

  let present: readonly string[];
  try {
    present = await ports.existingDeclaredTables(tables);
  } catch (error) {
    throw new Error(
      `[extensions] could not determine which of built-in "${manifest.name}"'s declared tables ` +
        `exist on this database. This built-in is DISABLED (${builtin.enableEnvVar} is not "true"), ` +
        'and the probe still runs because tables created by an EARLIER enabled boot must keep ' +
        'their tenancy declared — otherwise the boot-time unaccounted-public-tables sweeps read ' +
        'them as belonging to no manifest and abort, and org-deletion cascades silently skip their ' +
        `rows. Declared tables: ${tables.join(', ')}.`,
      { cause: error },
    );
  }
  if (present.length === 0) return;

  const presentSet = new Set(present);
  const missing = tables.filter((table) => !presentSet.has(table));
  if (missing.length > 0) {
    console.warn(
      `[extensions] ${JSON.stringify({
        event: 'builtin_extension_partial_schema',
        extension: manifest.name,
        enableFlag: builtin.enableEnvVar,
        presentTables: [...presentSet].sort(),
        missingTables: missing,
        impact:
          'publishing only the tables that exist; org-cascade and tenant-export will NOT cover ' +
          'the missing ones',
        remedy:
          `enable this built-in (${builtin.enableEnvVar}=true) on a database that satisfies its ` +
          'requirements so its migrations finish, or drop the orphaned tables',
      })}`,
    );
  }

  const filteredTenancy = filterTenancyDeclaration(manifest.tenancy, presentSet);
  ports.publishTenancy({ ...manifest, tenancy: filteredTenancy });
  await ports.validateTenancyDeclaration(manifest.name, filteredTenancy);
  return filteredTenancy;
}

/**
 * Load every ENABLED built-in extension at startup. The single entry point boot
 * wires in; resolves when all enabled built-ins are activated, and REJECTS
 * (aborting boot) if any phase of any of them fails.
 *
 * Each built-in carries its own deployment enable flag (see
 * {@link isBuiltinEnabled}) and is OFF unless the deployment says otherwise;
 * a disabled one takes {@link skipDisabledBuiltin} instead of the pipeline.
 *
 * BOOT ORDER: this is now the only extension loading step, and it runs after
 * `initializeDatabaseForStartup` (core migrations) and before the startup
 * checks. Nothing else publishes extension tenancy, so nothing else can observe
 * a half-published declaration; the ordering constraints that used to bind this
 * call between the legacy source loader and the signed-bundle reconciler went
 * away with those two paths.
 */
export async function loadBuiltinExtensions(args: LoadBuiltinExtensionsArgs): Promise<void> {
  const mode = args.mode ?? 'full';
  const ports: BuiltinPorts = { ...buildDefaultPorts(args), ...args.ports };
  const { registry, stateStore } = args;
  if (ports.builtins.length === 0) return;

  const tenancies: ExtensionTenancyDeclaration[] = [];
  const enabled: BuiltinExtension[] = [];
  for (const builtin of ports.builtins) {
    if (isBuiltinEnabled(builtin)) enabled.push(builtin);
    else {
      const tenancy = await skipDisabledBuiltin(builtin, ports);
      if (tenancy) tenancies.push(tenancy);
    }
  }
  // Nothing to load: return BEFORE createMigrationSql, which both demands
  // DATABASE_URL and opens a privileged connection.
  if (enabled.length === 0) {
    // Previously enabled built-ins still own tables, even when none is active.
    // A stock install with no extension tables retains its no-sweep behavior.
    // Shared core tables (e.g. memory_blocks) exist even when workspace has
    // never run, so those alone are not evidence of a persisted extension.
    const hasExtensionTables = tenancies.some((tenancy) =>
      declaredTenancyTables({ tenancy }).some((table) => !SHARED_TABLE_ALLOWLIST.has(table)),
    );
    if (hasExtensionTables) await ports.validatePublicTables(tenancies);
    return;
  }

  const sql = ports.createMigrationSql();
  try {
    for (const builtin of enabled) {
      const { manifest } = builtin;
      const name = manifest.name;

      if (mode === 'worker') {
        // wave 3.5d-b (#4086): a worker-role process never applies
        // migrations — it only verifies an api/all-role process already has.
        await ports.checkMigrationParity(builtin, sql);
      } else {
        await runBuiltinMigrations(builtin, sql, stateStore, ports);
      }

      // Publish tenancy the instant migrations succeed (or, in worker mode,
      // are confirmed already applied) — before staging — so cascade/
      // device-move handling for the tables that now exist survives a later
      // failure or a disable.
      ports.publishTenancy(manifest);
      tenancies.push(manifest.tenancy);

      const staged = await ports.stageExtension(builtin.module, manifest, {
        helperRoutes: builtin.helperRoutes,
      });
      await ports.validateTenancyDeclaration(name, manifest.tenancy);

      // Seed the persisted row from the manifest's facts. A built-in has no
      // artifact digest or publisher: it is delivered by the core image itself.
      // `activeVersion` is deliberately NOT included here: this observation
      // runs before registry.activate() below, and writing it here would let a
      // mid-pipeline activation failure leave the row claiming an active
      // version that never actually activated. `recordActive`, called only
      // after activate() succeeds, is the sole writer of `active_version`.
      await stateStore.upsertObserved({
        name,
        configuredVersion: manifest.version,
        manifestApiVersion: manifest.apiVersion,
        serverSdkVersion: manifest.requires.serverSdk,
        webSdkVersion: manifest.requires.webSdk ?? null,
      });

      // Activation reads the durable flag, so the enabled gate and the
      // platform-admin enable/disable surface behave identically for a
      // built-in. No explicit first-boot `setEnabled(true)` is needed: on
      // INSERT, `upsertObserved` relies on the `enabled` column's
      // `default(true)` (db/schema/extensions.ts), and on UPDATE it never
      // touches `enabled` — so a fresh row is already enabled, and an
      // existing row's persisted flag (including an operator's disable)
      // survives restarts and deploys untouched.
      registry.activate({ ...staged, enabled: await stateStore.isEnabled(name) });
      if (staged.routeApp && manifest.agentRoutes === true) {
        ports.registerRateLimitSkip(`/api/v1/ext/${name}/agent/`);
        ports.registerRateLimitSkip(`/api/v1/${manifest.routeNamespace}/agent/`);
      }
      // activeVersion is recorded here — only after activate() succeeds — so a
      // mid-pipeline failure never leaves installed_extensions claiming an
      // active version that was never actually activated.
      await stateStore.recordActive(name, manifest.version);

      // NOTE: deliberately no registerExtensionRoot. Fault attribution keys on
      // per-extension root stack paths; a built-in is compiled into the core
      // image, so its faults correctly attribute to core.
      //
      // Web-asset registration is skipped entirely in worker mode: a worker
      // process has no HTTP server to serve it from (wave 3.5d-b, #4086).
      if (mode !== 'worker') {
        registerBuiltinWebAsset(builtin, ports);
      }

      console.log(
        `[extensions] loaded built-in "${name}" ${manifest.version}${mode === 'worker' ? ' (worker mode)' : ''}`,
      );
    }
    // This is the only extension loader. Sweep once every declaration is known,
    // before API/worker startup can continue; scanning per built-in would blame
    // a later built-in's existing tables on the one loaded first.
    await ports.validatePublicTables(tenancies);
  } finally {
    // Closing the privileged pool must never REPLACE the error that got us
    // here: an exception out of a `finally` discards the in-flight one, so a
    // failed close would erase (say) the pgvector diagnosis and leave the
    // operator with a connection-teardown message instead. Still warn, so a
    // close failure stays visible rather than vanishing.
    if (sql) {
      await sql.end().catch((error: unknown) => {
        console.warn(
          `[extensions] failed to close the built-in migration connection: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }
}
