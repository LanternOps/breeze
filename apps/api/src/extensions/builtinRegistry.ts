// The BUILT-IN extension registry: first-party extensions compiled into the
// core image and imported statically.
//
// Deliberately a LEAF module — it imports the built-in packages, the manifest
// parser and node fs/path, and nothing else from `src/extensions/`. The loading
// pipeline (builtinExtensions.ts) and the legacy source loader (loader.ts) both
// need to see this registry, and loader.ts is itself imported by
// builtinExtensions.ts; keeping the registry here is what stops that from being
// an import cycle.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-api';
import workspaceExtension from '@breeze/ext-workspace';

/** One statically-imported, first-party extension. */
export interface BuiltinExtension {
  /** The v1 module, imported at build time into the core bundle. */
  module: BreezeExtensionV1;
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
 * just the directory, so an empty mount-point dir (e.g. the prod image's
 * `BREEZE_EXTENSIONS_DIR` mount) can never shadow the real root. Falls back to
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
  let raw: string;
  try {
    raw = readFileSync(path.join(root, 'manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    throw new Error(missingBuiltinManifestMessage(packageDir));
  }
  return parseExtensionManifestV1(JSON.parse(raw));
}

/**
 * Adding an entry here is the ONLY way an extension becomes built-in; the
 * collision gates in builtinExtensions.ts then make that name unavailable to
 * both other delivery paths.
 */
export const BUILTINS: readonly BuiltinExtension[] = [
  {
    module: workspaceExtension,
    manifest: loadBuiltinManifest('ee/workspace'),
    packageDir: 'ee/workspace',
    packageName: '@breeze/ext-workspace',
    // Workspace's /helper/* tree is called by the device helper, so it needs
    // core helper auth rather than the user default-deny.
    helperRoutes: true,
  },
];

export const BUILTIN_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUILTINS.map((builtin) => builtin.manifest.name),
);

/**
 * Every built-in's tenancy declaration, as a pure read of the compiled-in
 * manifests — available BEFORE (and independently of) the loading pipeline that
 * publishes them to the tenancy registry.
 *
 * This exists for the legacy source loader's repo-wide unaccounted-tables sweep
 * (loader.ts). That sweep runs before `loadBuiltinExtensions` has published
 * anything, so without this accessor every `workspace_*` table created on an
 * earlier boot reads as belonging to no manifest and the sweep aborts boot.
 */
export function builtinTenancyDeclarations(): ExtensionTenancyDeclaration[] {
  return BUILTINS.map((builtin) => builtin.manifest.tenancy);
}
