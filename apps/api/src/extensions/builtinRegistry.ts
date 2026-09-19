// The BUILT-IN extension registry: first-party extensions compiled into the
// core image and imported statically.
//
// Deliberately a LEAF module — it imports the built-in packages, the manifest
// parser and node fs/path, and nothing else from `src/extensions/`. It is
// imported by the loading pipeline; keeping the registry separate keeps the
// pipeline's own import graph acyclic and lets tests import the registry without
// importing the pipeline.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-sdk';
import workspaceExtension from '@breeze/ext-workspace';

/** One statically-imported, first-party extension. */
export interface BuiltinExtension {
  /** The v1 module, imported at build time into the core bundle. */
  module: BreezeExtensionV1;
  /**
   * The STATIC, authoritative extension name. The disabled path uses this
   * identity when the manifest is unavailable; resolution enforces that it
   * equals `manifest.name`.
   *
   * IMMUTABLE ONCE MIGRATIONS HAVE SHIPPED UNDER IT. Extension migrations are
   * recorded in the core ledger under `<manifest.name>/<file>` (see
   * builtinExtensions.ts `runMigrations`), and — because resolution pins
   * `manifest.name === name` — that is this string. `builtinEverMigrated` finds
   * those rows by the same string, so renaming a built-in that has already
   * migrated somewhere would make the probe answer "never ran here" about a
   * database that has its tables. A rename must therefore be paired with a
   * ledger backfill, not done on its own.
   */
  name: string;
  /** Its parsed v1 manifest (read from the package's manifest.json). */
  manifest: ExtensionManifestV1;
  /** Package dir under the repo/image root, e.g. 'ee/workspace'. */
  packageDir: string;
  /** Package name, used only to name the build command in operator messages. */
  packageName: string;
  /**
   * Opt in to core helper auth on `/helper/*` (the legacy `helperRoutes` flag
   * the gateway reads off the STAGED manifest; see defaultStageExtension).
   */
  helperRoutes: boolean;
  /**
   * The DEPLOYMENT enable flag for this built-in. Being compiled into the image
   * makes a built-in *available*, not *loaded*: the loading pipeline runs only
   * when `process.env[enableEnvVar] === 'true'` (strict string: no `'1'`,
   * `'TRUE'` or `'yes'`). Default OFF, so a
   * deployment that never asks for the built-in never pays for its migrations,
   * its infrastructure requirements (workspace needs pgvector) or its routes.
   *
   * This is a DIFFERENT switch from the persisted `installed_extensions.enabled`
   * flag: that one is per-deployment operator state stored in the DB and toggled
   * at runtime by a platform admin; this one is boot-time deployment
   * configuration that decides whether the built-in is loaded at all.
   */
  enableEnvVar: string;
}

/**
 * Ordered, bounded candidates for `<root>/<packageDir>`, most-trustworthy
 * first — {@link resolveBuiltinRoot} and {@link loadBuiltinManifest} both walk
 * this SAME list so a miss can be reported against exactly what was tried:
 *
 *   1. the source-file walk-up (src/extensions → apps/api → apps → repo) —
 *      exact for dev tsx/vitest, where this file's real location is on disk.
 *   2. `process.cwd()` — exact for both Docker images: the Dockerfile COPYs
 *      `<packageDir>/{manifest.json,migrations,dist}` to the image root, and
 *      the process is always started from there.
 *   3. up to 3 ancestors of `process.cwd()` — covers running the bundle from
 *      inside a plain repo checkout (e.g. `cwd = <repo>/apps/api`, so
 *      `<repo>/ee/workspace` is `cwd/../../ee/workspace`).
 *
 * Deliberately bounded — no unbounded upward search.
 */
function candidateBuiltinRoots(packageDir: string): string[] {
  const candidates: string[] = [];
  try {
    const thisFile = fileURLToPath(import.meta.url);
    candidates.push(path.resolve(path.dirname(thisFile), '..', '..', '..', '..', packageDir));
  } catch {
    // CJS bundle: the import.meta shim may not resolve to a real path.
  }
  const cwd = process.cwd();
  candidates.push(path.join(cwd, packageDir));
  candidates.push(path.join(cwd, '..', packageDir));
  candidates.push(path.join(cwd, '..', '..', packageDir));
  candidates.push(path.join(cwd, '..', '..', '..', packageDir));
  return candidates;
}

/**
 * Resolve `<repo or image root>/<packageDir>`: the first candidate (see
 * {@link candidateBuiltinRoots}) whose `manifest.json` actually exists — not
 * just the directory, so an empty same-named directory can never shadow the
 * real root. Falls back to
 * `cwd/<packageDir>` when nothing matched, so callers (and error messages)
 * still get a sensible expected path rather than an arbitrary walk-up guess.
 */
export function resolveBuiltinRoot(packageDir: string): string {
  for (const candidate of candidateBuiltinRoots(packageDir)) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return path.join(process.cwd(), packageDir);
}

/**
 * Build the contextual error for a built-in whose manifest could not be found
 * in ANY candidate root — naming the package, every path tried, and the
 * Dockerfile/runtime contract that's supposed to guarantee one of them exists,
 * so the failure is diagnosable from the message alone instead of a bare
 * `ENOENT` with no indication of what root(s) were even considered.
 */
function missingBuiltinManifestMessage(packageDir: string): string {
  const tried = candidateBuiltinRoots(packageDir).map((root) => path.join(root, 'manifest.json'));
  return [
    `[extensions] could not find manifest.json for built-in "${packageDir}". Tried:`,
    ...tried.map((manifestPath) => `  - ${manifestPath}`),
    '',
    'Runtime contract: the release Dockerfile COPYs ' +
      `"${packageDir}/{manifest.json,migrations,dist}" into the image root, so ` +
      'process.cwd() must be the image root (typically /app) in production. ' +
      `In a plain repo checkout, the manifest is expected at "<repo>/${packageDir}", ` +
      'found either by walking up from this compiled file (dev) or by walking up ' +
      'to 3 ancestors of process.cwd() (e.g. running the bundled API from apps/api).',
  ].join('\n');
}

/**
 * Read and parse a built-in's manifest, resolving its root the same way
 * {@link resolveBuiltinRoot} does. A miss is NOT a bare `ENOENT` — every
 * candidate root was already computed to resolve `root`, so re-using that list
 * to name what was tried costs nothing and turns an opaque boot failure into
 * an actionable one.
 */
export function loadBuiltinManifest(packageDir: string): ExtensionManifestV1 {
  const root = resolveBuiltinRoot(packageDir);
  const manifestPath = path.join(root, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    throw new Error(missingBuiltinManifestMessage(packageDir));
  }
  // A FOUND-but-unreadable manifest is a different failure from a missing one,
  // and its raw form says nothing about where it came from: `JSON.parse` throws
  // "Unexpected end of JSON input" and the zod parse throws a path-less list of
  // field issues. Neither names the file. Resolution is lazy now, so this error
  // surfaces from the built-in loading phase after core DB initialization and
  // the first log lines rather than during module evaluation. The contextual
  // path, byte length (a truncated COPY's tell), and likely cause still matter
  // because this is what an operator sees when boot aborts.
  try {
    return parseExtensionManifestV1(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `[extensions] built-in "${packageDir}" has an unreadable manifest at ${manifestPath} ` +
        `(${raw.length} bytes). It exists but could not be parsed as a valid v1 manifest, which ` +
        'means a misbuilt image or a truncated/partial COPY of the package directory rather than ' +
        `a configuration mistake. Original error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      { cause: error },
    );
  }
}

/**
 * Define a built-in whose manifest is read from disk LAZILY — on first access
 * to `.manifest`, never during module evaluation (#3470).
 *
 * Importing this registry must touch no filesystem. `apps/api/src/index.ts`
 * imports it transitively at module scope, so an eager read made
 * `ee/workspace/manifest.json` a hard boot requirement for EVERY deployment,
 * including one that had opted out via `BREEZE_WORKSPACE_ENABLED`. Laziness is
 * what lets a slimmed image that omits a disabled built-in's files boot; the
 * ENABLED path resolves the manifest immediately and still fails hard.
 *
 * BOTH outcomes are memoised, and neither re-reads disk:
 *   - success → every later access returns the SAME manifest object.
 *   - failure → every later access rethrows the IDENTICAL error instance, so a
 *     retrying caller cannot hammer the disk and the operator sees one stable
 *     diagnostic instead of a different one per attempt.
 *
 * A cached failure is NOT retried for the lifetime of the process, deliberately:
 * the manifest ships inside the image, so it cannot legitimately appear after
 * boot, and a per-access retry would turn one diagnosable failure into a
 * stuttering series of them. The remedy for a fixed image is a restart.
 *
 * Resolution also enforces `manifest.name === spec.name`. The static name is
 * the identity the disabled path uses when the manifest is unavailable
 * (skipDisabledBuiltin), so a silent disagreement between the registry entry
 * and the shipped manifest would let the two paths talk about different
 * extensions.
 */
export function defineBuiltin(spec: Omit<BuiltinExtension, 'manifest'>): BuiltinExtension {
  let outcome:
    | { status: 'success'; manifest: ExtensionManifestV1 }
    | { status: 'failure'; error: unknown }
    | undefined;

  return {
    ...spec,
    get manifest(): ExtensionManifestV1 {
      if (outcome?.status === 'success') return outcome.manifest;
      if (outcome?.status === 'failure') throw outcome.error;

      try {
        const manifest = loadBuiltinManifest(spec.packageDir);
        if (manifest.name !== spec.name) {
          throw new Error(
            `[extensions] built-in registry entry "${spec.name}" for "${spec.packageDir}" ` +
              `disagrees with shipped manifest name "${manifest.name}"`,
          );
        }
        outcome = { status: 'success', manifest };
        return manifest;
      } catch (error) {
        outcome = { status: 'failure', error };
        throw error;
      }
    },
  };
}

/**
 * Adding an entry here is the ONLY way an extension becomes built-in; the
 * collision gates in builtinExtensions.ts then make that name unavailable to
 * both other delivery paths.
 */
export const BUILTINS: readonly BuiltinExtension[] = [
  defineBuiltin({
    module: workspaceExtension,
    name: 'workspace',
    packageDir: 'ee/workspace',
    packageName: '@breeze/ext-workspace',
    // Workspace's /helper/* tree is called by the device helper, so it needs
    // core helper auth rather than the user default-deny.
    helperRoutes: true,
    // Default OFF: workspace's migrations require a pgvector-enabled Postgres,
    // which a stock `postgres:16-alpine` deployment does not have.
    enableEnvVar: 'BREEZE_WORKSPACE_ENABLED',
  }),
];

export const BUILTIN_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUILTINS.map((builtin) => builtin.name),
);

/**
 * Every built-in's tenancy declaration, as a pure read of the compiled-in
 * manifests — available BEFORE (and independently of) the loading pipeline that
 * publishes them to the tenancy registry.
 *
 * The source loader is gone, so this accessor now has no production caller. It
 * is retained for the tenancy/tenant-export contract tests in
 * builtinExtensions.test.ts, which pin the real manifest's classification.
 *
 * DELIBERATELY STATIC — it ignores {@link BuiltinExtension.enableEnvVar}, and
 * must keep doing so. That property is inherited from the boot-time sweep this
 * once fed, which only examined tables that EXIST: declaring a table that was
 * never created was inert there, while gating the accessor on the enable flag
 * would have resurrected exactly the failure it was written to prevent — a
 * deployment that enabled workspace once (creating `workspace_*`) and later
 * unset the flag would have had those tables read as unaccounted and abort
 * boot. That sweep is no longer wired into any boot path; the property is kept
 * because the contract tests still assert it, and because a future caller would
 * want the same semantics.
 * The narrower, existence-checked publication that the DISABLED path performs
 * (builtinExtensions.ts) is a different thing: that one feeds the live tenancy
 * registry, which core cascade/export code iterates and issues SQL against, so
 * it must never name a table that does not exist.
 */
export function builtinTenancyDeclarations(): ExtensionTenancyDeclaration[] {
  return BUILTINS.map((builtin) => builtin.manifest.tenancy);
}
