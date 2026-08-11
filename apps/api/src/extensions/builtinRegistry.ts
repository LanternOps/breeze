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
 * Resolve `<repo or image root>/<packageDir>`. Dev walks up from this file
 * (src/extensions → apps/api → apps → repo); the CJS Docker bundle falls back to
 * cwd (`/app`), where the Dockerfile copies `ee/<name>/{manifest.json,migrations,dist}`.
 * Same pattern as discovery.ts's `resolveExtensionsRoot`.
 */
export function resolveBuiltinRoot(packageDir: string): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const fromSource = path.resolve(path.dirname(thisFile), '..', '..', '..', '..', packageDir);
    if (existsSync(fromSource)) return fromSource;
  } catch {
    // CJS bundle: the import.meta shim may not resolve to a real path.
  }
  return path.join(process.cwd(), packageDir);
}

function loadBuiltinManifest(root: string): ExtensionManifestV1 {
  return parseExtensionManifestV1(
    JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')),
  );
}

/**
 * Adding an entry here is the ONLY way an extension becomes built-in; the
 * collision gates in builtinExtensions.ts then make that name unavailable to
 * both other delivery paths.
 */
export const BUILTINS: readonly BuiltinExtension[] = [
  {
    module: workspaceExtension,
    manifest: loadBuiltinManifest(resolveBuiltinRoot('ee/workspace')),
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
