// The startup loading path for BUILT-IN extensions: first-party extensions that
// are compiled into the core image and imported statically, rather than
// acquired as signed runtime bundles.
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
  stageExtension(
    module: BreezeExtensionV1,
    manifest: ExtensionManifestV1,
    opts: { helperRoutes: boolean },
  ): Promise<StagedExtensionContributions>;
  validateTenancy(
    staged: StagedExtensionContributions,
    manifest: ExtensionManifestV1,
  ): Promise<void>;
  registerRateLimitSkip(prefix: string): void;
  readWebDist(root: string): RegisterableExtensionWebAsset;
  registerWebAsset(name: string, asset: RegisterableExtensionWebAsset): void;
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
    stageExtension: (module, manifest, opts) =>
      defaultStageExtension(module, manifest, args.registry, undefined, opts),
    validateTenancy: (_staged, manifest) =>
      assertExtensionTenancyRls(manifest.name, manifest.tenancy),
    registerRateLimitSkip: registerGlobalRateLimitSkipPrefix,
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
 * structured warning is emitted and the server routes activate regardless. Any
 * NON-ENOENT failure (permissions, an unreadable tree) always propagates — it is
 * a real fault, not an absent optional build.
 */
function registerBuiltinWebAsset(builtin: BuiltinExtension, ports: BuiltinPorts): void {
  const name = builtin.manifest.name;
  try {
    ports.registerWebAsset(name, ports.readWebDist(resolveBuiltinRoot(builtin.packageDir)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' || process.env.NODE_ENV === 'production') throw error;
    console.warn(
      `[extensions] ${JSON.stringify({
        event: 'builtin_web_dist_missing',
        extension: name,
        packageDir: builtin.packageDir,
        message: 'built-in web bundle is not built; server routes are active but its pages will not load',
        remedy: `pnpm --filter ${builtin.packageName} build:web`,
      })}`,
    );
  }
}

/**
 * Load every built-in extension at startup. The single entry point boot wires
 * in; resolves when all built-ins are activated, and REJECTS (aborting boot) if
 * any phase of any built-in fails.
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

  assertNoDeliveryPathCollision(ports);

  const sql = ports.createMigrationSql();
  try {
    for (const builtin of ports.builtins) {
      const { manifest } = builtin;
      const name = manifest.name;

      await ports.runMigrations(builtin, sql, stateStore);

      // Publish tenancy the instant migrations succeed — before staging — so
      // cascade/device-move handling for the tables that now exist survives a
      // later failure or a disable (same rationale as reconciler.ts).
      ports.publishTenancy(manifest);

      const staged = await ports.stageExtension(builtin.module, manifest, {
        helperRoutes: builtin.helperRoutes,
      });
      await ports.validateTenancy(staged, manifest);

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
    if (sql) await sql.end();
  }
}
