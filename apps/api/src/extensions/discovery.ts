import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseExtensionManifest, type ExtensionManifest } from '@breeze/extension-api';

export interface DiscoveredExtension {
  name: string;
  dir: string;
  manifest: ExtensionManifest;
  migrationsDir: string | null;
}

const MANIFEST_FILENAME = 'breeze-extension.json';

/**
 * Repo-root extensions/ dir. Mirrors resolveMigrationsDir() in autoMigrate.ts:
 * ESM dev resolves relative to this file (src/extensions/ → ../../../../extensions
 * = <repo>/extensions); the CJS Docker bundle falls back to cwd. Overridable via
 * BREEZE_EXTENSIONS_DIR (used by the prod image, where extensions are copied
 * next to the bundle).
 */
export function resolveExtensionsRoot(): string {
  if (process.env.BREEZE_EXTENSIONS_DIR) {
    return path.resolve(process.env.BREEZE_EXTENSIONS_DIR);
  }
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // src/extensions/ → apps/api → apps → <repo> → extensions/
    return path.resolve(path.dirname(thisFile), '..', '..', '..', '..', 'extensions');
  } catch {
    return path.join(process.cwd(), 'extensions');
  }
}

export function discoverExtensions(root: string = resolveExtensionsRoot()): DiscoveredExtension[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredExtension[] = [];
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) continue; // node_modules, stray dirs
    let manifest: ExtensionManifest;
    try {
      manifest = parseExtensionManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch (err) {
      throw new Error(
        `[extensions] invalid manifest in ${dir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (manifest.name !== entry) {
      throw new Error(
        `[extensions] manifest name "${manifest.name}" must match its directory name "${entry}"`
      );
    }
    const migrationsDir = path.join(dir, manifest.migrationsDir);
    out.push({
      name: manifest.name,
      dir,
      manifest,
      migrationsDir: existsSync(migrationsDir) ? migrationsDir : null,
    });
  }
  // Cross-extension collision tripwire. Directory names guarantee unique
  // extension names, but two extensions could still declare the same
  // routeNamespace — the second mount would silently shadow (or interleave
  // with) the first, including its auth guard. Fail discovery instead.
  const namespaceOwners = new Map<string, string>();
  for (const ext of out) {
    const owner = namespaceOwners.get(ext.manifest.routeNamespace);
    if (owner) {
      throw new Error(
        `[extensions] routeNamespace "${ext.manifest.routeNamespace}" is declared by both "${owner}" and "${ext.name}"`,
      );
    }
    namespaceOwners.set(ext.manifest.routeNamespace, ext.name);
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
