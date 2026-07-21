import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExtensions, listSourceExtensionCandidates } from './discovery';

const MANIFEST = {
  name: 'sample',
  routeNamespace: 'sample',
  entry: 'src/index.ts',
  migrationsDir: 'migrations',
  tenancy: { orgCascadeDeleteTables: ['sample_items'] },
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'breeze-ext-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function scaffold(name: string, manifest: unknown, withMigrations = true) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'breeze-extension.json'), JSON.stringify(manifest));
  if (withMigrations) mkdirSync(join(dir, 'migrations'));
  return dir;
}

describe('discoverExtensions', () => {
  it('returns [] for a missing or empty root', () => {
    expect(discoverExtensions(join(root, 'nope'))).toEqual([]);
    expect(discoverExtensions(root)).toEqual([]);
  });

  it('discovers a valid extension with absolute migrationsDir', () => {
    const dir = scaffold('sample', MANIFEST);
    const found = discoverExtensions(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('sample');
    expect(found[0]!.dir).toBe(dir);
    expect(found[0]!.migrationsDir).toBe(join(dir, 'migrations'));
  });

  it('sets migrationsDir null when the directory is absent', () => {
    scaffold('sample', MANIFEST, false);
    expect(discoverExtensions(root)[0]!.migrationsDir).toBeNull();
  });

  it('ignores directories without a manifest (e.g. README.md, node_modules)', () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'README.md'), 'seam docs');
    scaffold('sample', MANIFEST);
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['sample']);
  });

  it('ignores dangling symlinks alongside valid extensions', () => {
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));
    scaffold('sample', MANIFEST);
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['sample']);
  });

  it('throws with the extension dir named when a manifest is invalid', () => {
    scaffold('broken', { ...MANIFEST, name: 'NOT VALID' });
    expect(() => discoverExtensions(root)).toThrow(/broken/);
  });

  it('throws when manifest.name does not match its directory name', () => {
    scaffold('wrongdir', MANIFEST); // manifest says "sample"
    expect(() => discoverExtensions(root)).toThrow(/directory/i);
  });

  it('sorts by name', () => {
    scaffold('zeta', { ...MANIFEST, name: 'zeta', routeNamespace: 'zeta', tenancy: {} });
    scaffold('alpha', { ...MANIFEST, name: 'alpha', routeNamespace: 'alpha', tenancy: {} });
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['alpha', 'zeta']);
  });

  it('throws when two extensions declare the same routeNamespace', () => {
    scaffold('alpha', { ...MANIFEST, name: 'alpha', routeNamespace: 'shared', tenancy: {} });
    scaffold('beta', { ...MANIFEST, name: 'beta', routeNamespace: 'shared', tenancy: {} });
    expect(() => discoverExtensions(root)).toThrow(/routeNamespace "shared" is declared by both/);
  });

  it('allows distinct routeNamespaces that differ from the extension name', () => {
    scaffold('alpha', { ...MANIFEST, name: 'alpha', routeNamespace: 'alpha-routes', tenancy: {} });
    scaffold('beta', { ...MANIFEST, name: 'beta', routeNamespace: 'beta-routes', tenancy: {} });
    expect(discoverExtensions(root).map((e) => e.manifest.routeNamespace)).toEqual([
      'alpha-routes', 'beta-routes',
    ]);
  });
});

describe('listSourceExtensionCandidates', () => {
  it('returns [] for a missing or empty root', () => {
    expect(listSourceExtensionCandidates(join(root, 'nope'))).toEqual([]);
    expect(listSourceExtensionCandidates(root)).toEqual([]);
  });

  it('lists directories carrying a manifest file, ignoring everything else', () => {
    scaffold('sample', MANIFEST);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'README.md'), 'seam docs');
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));
    expect(listSourceExtensionCandidates(root)).toEqual(['sample']);
  });

  // The candidate scan feeds the flag-off deprecation warning in the loader. It
  // must never PARSE the manifest: a broken manifest in a disabled legacy path
  // must not be able to fail the boot.
  it('lists a candidate whose manifest is unparseable JSON, without throwing', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'breeze-extension.json'), '{ not json');
    expect(listSourceExtensionCandidates(root)).toEqual(['broken']);
    expect(() => listSourceExtensionCandidates(root)).not.toThrow();
  });

  it('sorts candidates by name', () => {
    scaffold('zeta', { ...MANIFEST, name: 'zeta', routeNamespace: 'zeta', tenancy: {} });
    scaffold('alpha', { ...MANIFEST, name: 'alpha', routeNamespace: 'alpha', tenancy: {} });
    expect(listSourceExtensionCandidates(root)).toEqual(['alpha', 'zeta']);
  });
});
