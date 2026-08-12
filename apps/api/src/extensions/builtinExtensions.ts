// The startup loading path for BUILT-IN extensions: first-party extensions that
// are compiled into the core image and imported statically, rather than
// acquired as signed runtime bundles.
//
// Compiled in ≠ loaded. Each built-in carries a deployment enable flag
// (BuiltinExtension.enableEnvVar) and is OFF by default; only an explicitly
// enabled built-in runs the pipeline below. See skipDisabledBuiltin for what a
// switched-off built-in still does (one log line, plus a tenancy declaration
// narrowed to whichever of its tables are actually on the database — none, some
// or all — and the RLS tripwire over that declaration).
//
// It mirrors the reconciler's phase order for everything that still applies —
// migration → tenancy → stage → validate → activate → web asset — and drops the
// phases that only make sense for a third-party artifact (acquire / trust /
// verify / extract / load): the code is already here, already ours, already
// covered by the core image's own supply chain.
//
// Failure policy differs from `reconcileExtensions` on purpose. A runtime bundle
// may be OPTIONAL, so its failure is recorded and stepped over. A built-in is
// first-party REQUIRED code shipped inside the image: any phase failure
// propagates and aborts boot. There is no half-working built-in state to
// preserve, and silently degrading one would hide a broken image.
//
// Every I/O seam is an injectable PORT (the same seam `reconcileExtensions`
// uses), so these behaviors are unit-testable with no bundle, filesystem or DB —
// including the built-in LIST itself, so tests never load the real extension.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { BreezeExtensionV1, ExtensionManifestV1 } from '@breeze/extension-sdk';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
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
import { defaultStageExtension } from './reconciler';
import { reconcileExtensionMigrations, type MigratableExtension } from './migrator';
import { registerRuntimeExtensionTenancy } from './tenancyRegistry';
import { assertExtensionTenancyRls } from './tenancyTripwire';
import { registerExtensionWebAsset, type RegisterableExtensionWebAsset } from './webAssets';
import { declaredRuntimeExtensionNames } from './loader';
import { listSourceExtensionCandidates, resolveExtensionsRoot } from './discovery';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';

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
 * `reconcileExtensionMigrations`'s rolling-update gate refuses to apply a
 * bundle whose schema floor is above the still-serving active version, and the
 * escape hatch is an operator flipping `rollout: replace` in extensions.yaml.
 * A built-in has no such entry — its code and its migrations ship together
 * inside the core image, on the core image's own deploy cadence — so a
 * 'rolling' gate here could only wedge boot with no way out. Built-ins
 * therefore migrate like core migrations do (autoMigrate applies core SQL with
 * no such gate): raising a built-in's `schemaCompatibilityFloor` is a breaking
 * change that must be coordinated with the core deploy, exactly as a breaking
 * core migration is.
 */
const BUILTIN_MIGRATION_ROLLOUT = 'replace' as const;

/**
 * Is this built-in switched ON for this deployment?
 *
 * Strict-string convention, matching `BREEZE_LEGACY_SOURCE_EXTENSIONS` in
 * loader.ts: anything other than the exact string `'true'` — unset, empty,
 * `'1'`, `'TRUE'` — leaves the built-in unloaded. Default OFF is the point:
 * being compiled into the image must not oblige every deployment to satisfy the
 * built-in's infrastructure requirements (workspace needs pgvector) or carry its
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
function declaredTenancyTables(manifest: ExtensionManifestV1): string[] {
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
 * Every I/O seam the built-in loader touches, as a port — mirroring
 * {@link import('./reconciler').ReconcilePorts}. Production builds the real set
 * via {@link buildDefaultPorts}; tests inject fakes.
 */
export interface BuiltinPorts {
  /** The built-ins to load. A port so tests never import the real package. */
  builtins: readonly BuiltinExtension[];
  /** Names declared in the runtime deployment config (extensions.yaml). */
  declaredRuntimeNames(): ReadonlySet<string>;
  /** Legacy source-directory extension names present on disk. */
  sourceCandidates(): readonly string[];
  /** The privileged migration connection, opened once and closed in a finally. */
  createMigrationSql(): postgres.Sql | null;
  runMigrations(
    builtin: BuiltinExtension,
    sql: postgres.Sql | null,
    stateStore: ExtensionStateStore,
  ): Promise<void>;
  publishTenancy(manifest: ExtensionManifestV1): void;
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

export interface LoadBuiltinExtensionsArgs {
  registry: ExtensionContributionRegistry;
  stateStore: ExtensionStateStore;
  /** Test seam: overrides merged over {@link buildDefaultPorts}. */
  ports?: Partial<BuiltinPorts>;
}

function buildDefaultPorts(args: LoadBuiltinExtensionsArgs): BuiltinPorts {
  return {
    builtins: BUILTINS,
    declaredRuntimeNames: () => declaredRuntimeExtensionNames(resolveExtensionsRoot()),
    sourceCandidates: () => listSourceExtensionCandidates(),
    createMigrationSql: () => {
      // The migration connection is privileged (it issues extension DDL). Never
      // substitute a guessed DSN for a missing DATABASE_URL — mirroring
      // buildDefaultPorts.createMigrationSql in reconciler.ts.
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
    publishTenancy: (manifest) => registerRuntimeExtensionTenancy(manifest.tenancy),
    existingDeclaredTables: defaultExistingDeclaredTables,
    stageExtension: (module, manifest, opts) =>
      defaultStageExtension(module, manifest, args.registry, undefined, opts),
    validateTenancyDeclaration: (extensionName, tenancy) =>
      assertExtensionTenancyRls(extensionName, tenancy),
    registerRateLimitSkip: registerGlobalRateLimitSkipPrefix,
    webDistExists: (root) => existsSync(path.join(root, 'dist', 'web')),
    readWebDist,
    registerWebAsset: registerExtensionWebAsset,
  };
}

/**
 * One delivery path per extension name.
 *
 * `registry.activate()` REPLACES a same-name snapshot, so a runtime artifact
 * reconciled after this loader would silently shadow the built-in — and a failed
 * optional artifact would withdraw the built-in's live routes. The legacy loader
 * enforces the same rule between its two paths (loader.ts); this extends it to
 * the third. Both gates run before ANY phase, so a collision costs nothing but a
 * failed boot.
 */
function assertNoDeliveryPathCollision(ports: BuiltinPorts): void {
  const builtins = ports.builtins;
  if (builtins.length === 0) return;

  const runtimeNames = ports.declaredRuntimeNames();
  const sourceNames = new Set(ports.sourceCandidates());
  for (const { manifest } of builtins) {
    if (runtimeNames.has(manifest.name)) {
      throw new Error(
        `[extensions] "${manifest.name}" is a BUILT-IN extension AND is declared as a runtime artifact in extensions.yaml; one delivery path per extension name — remove the extensions.yaml entry`,
      );
    }
    if (sourceNames.has(manifest.name)) {
      throw new Error(
        `[extensions] "${manifest.name}" is a BUILT-IN extension AND is present as a legacy source directory; one delivery path per extension name — remove the source directory`,
      );
    }
  }
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

/**
 * The DISABLED path: everything a switched-off built-in still owes the boot,
 * which is one log line and — conditionally — its tenancy declaration.
 *
 * No migrations, no staging, no activation, no `installed_extensions` row, no
 * web-dist requirement: a deployment that never enabled this built-in must boot
 * on plain Postgres with none of the built-in's infrastructure.
 *
 * Tenancy is the one exception, and it cuts BOTH ways:
 *
 *   • If the built-in's tables EXIST (a previous boot had it enabled and its
 *     migrations ran), the declaration must still be published. Two sweeps —
 *     the legacy loader's and the reconciler's repo-wide
 *     `assertNoUnaccountedPublicTables` — would otherwise read those orphaned
 *     `workspace_*` tables as belonging to no manifest and abort boot, and
 *     org-deletion cascades would silently skip the rows in them.
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
 * declaration FILTERED to it. That is safe in both directions: the two
 * unaccounted-table sweeps only examine tables that EXIST, so a filtered
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
): Promise<void> {
  const { manifest } = builtin;
  const raw = process.env[builtin.enableEnvVar];
  console.warn(
    `[extensions] ${JSON.stringify({
      event: 'builtin_extension_disabled',
      extension: manifest.name,
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
 * BOOT ORDER IS PART OF THE CONTRACT: call this AFTER `loadSourceExtensions`
 * and BEFORE `reconcileExtensions`.
 *
 *   • BEFORE `reconcileExtensions` — mandatory. The reconciler ends with one
 *     repo-wide `assertNoUnaccountedPublicTables(getExtensionTenancy())` sweep
 *     whenever extensions.yaml declares at least one extension. If built-ins
 *     load after that sweep, their tenancy has not been published yet while
 *     their tables already exist (created by an earlier boot's migrations), so
 *     the sweep reads every `workspace_*` table as belonging to no manifest and
 *     aborts. The FIRST boot would survive (no tables yet) and every boot after
 *     it would fail — the worst possible failure shape.
 *   • AFTER `loadSourceExtensions` — the legacy loader stages and activates the
 *     deprecated source-directory path first; running built-ins first would let
 *     a built-in's activation be observed by that loader's own gates. Its
 *     repo-wide sweep is made built-in-aware through
 *     {@link builtinTenancyDeclarations} (loader.ts), so this ordering needs no
 *     tenancy to have been published yet.
 */
export async function loadBuiltinExtensions(args: LoadBuiltinExtensionsArgs): Promise<void> {
  const ports: BuiltinPorts = { ...buildDefaultPorts(args), ...args.ports };
  const { registry, stateStore } = args;
  if (ports.builtins.length === 0) return;

  // The gate is deliberately NOT flag-aware: a built-in's name is reserved by
  // the registry whether or not this deployment switched it on, so a colliding
  // extensions.yaml entry or source directory is a misconfiguration to shout
  // about either way — and shouting about it only when the flag happens to be
  // set would make the collision surface for the first time on the day someone
  // enables the built-in.
  assertNoDeliveryPathCollision(ports);

  const enabled: BuiltinExtension[] = [];
  for (const builtin of ports.builtins) {
    if (isBuiltinEnabled(builtin)) enabled.push(builtin);
    else await skipDisabledBuiltin(builtin, ports);
  }
  // Nothing to load: return BEFORE createMigrationSql, which both demands
  // DATABASE_URL and opens a privileged connection.
  if (enabled.length === 0) return;

  const sql = ports.createMigrationSql();
  try {
    for (const builtin of enabled) {
      const { manifest } = builtin;
      const name = manifest.name;

      await runBuiltinMigrations(builtin, sql, stateStore, ports);

      // Publish tenancy the instant migrations succeed — before staging — so
      // cascade/device-move handling for the tables that now exist survives a
      // later failure or a disable (same rationale as reconciler.ts).
      ports.publishTenancy(manifest);

      const staged = await ports.stageExtension(builtin.module, manifest, {
        helperRoutes: builtin.helperRoutes,
      });
      await ports.validateTenancyDeclaration(name, manifest.tenancy);

      // Seed the persisted row from the manifest's facts. A built-in has no
      // artifact digest or publisher: it is delivered by the core image itself.
      const existing = await stateStore.get(name);
      await stateStore.upsertObserved({
        name,
        configuredVersion: manifest.version,
        activeVersion: manifest.version,
        manifestApiVersion: manifest.apiVersion,
        serverSdkVersion: manifest.requires.serverSdk,
        webSdkVersion: manifest.requires.webSdk ?? null,
      });
      // FIRST boot only: default the runtime flag to enabled. On every later
      // boot the persisted flag is authoritative, so an operator's disable
      // survives restarts and deploys.
      if (existing === null) await stateStore.setEnabled(name, true);

      // Activation reads the SAME durable flag runtime bundles do, so the
      // enabled gate, the platform-admin enable/disable surface and the
      // per-org install gate all behave identically for a built-in.
      registry.activate({ ...staged, enabled: await stateStore.isEnabled(name) });
      if (staged.routeApp && manifest.agentRoutes === true) {
        ports.registerRateLimitSkip(`/api/v1/ext/${name}/agent/`);
        ports.registerRateLimitSkip(`/api/v1/${manifest.routeNamespace}/agent/`);
      }
      await stateStore.recordActive(name, manifest.version);

      // NOTE: deliberately no registerExtensionRoot. Fault attribution keys on
      // extracted-bundle stack paths; a built-in is compiled into the core
      // image, so its faults correctly attribute to core.
      registerBuiltinWebAsset(builtin, ports);

      console.log(`[extensions] loaded built-in "${name}" ${manifest.version}`);
    }
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
