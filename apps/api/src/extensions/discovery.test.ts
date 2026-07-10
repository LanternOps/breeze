import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExtensions } from './discovery';

const MANIFEST = {
  name: 'workspace',
  routeNamespace: 'workspace',
  entry: 'src/index.ts',
  migrationsDir: 'migrations',
  tenancy: { orgCascadeDeleteTables: ['workspace_sources'] },
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
    const dir = scaffold('workspace', MANIFEST);
    const found = discoverExtensions(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('workspace');
    expect(found[0]!.dir).toBe(dir);
    expect(found[0]!.migrationsDir).toBe(join(dir, 'migrations'));
  });

  it('sets migrationsDir null when the directory is absent', () => {
    scaffold('workspace', MANIFEST, false);
    expect(discoverExtensions(root)[0]!.migrationsDir).toBeNull();
  });

  it('ignores directories without a manifest (e.g. README.md, node_modules)', () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'README.md'), 'seam docs');
    scaffold('workspace', MANIFEST);
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['workspace']);
  });

  it('ignores dangling symlinks alongside valid extensions', () => {
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));
    scaffold('workspace', MANIFEST);
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['workspace']);
  });

  it('throws with the extension dir named when a manifest is invalid', () => {
    scaffold('broken', { ...MANIFEST, name: 'NOT VALID' });
    expect(() => discoverExtensions(root)).toThrow(/broken/);
  });

  it('throws when manifest.name does not match its directory name', () => {
    scaffold('wrongdir', MANIFEST); // manifest says "workspace"
    expect(() => discoverExtensions(root)).toThrow(/directory/i);
  });

  it('sorts by name', () => {
    scaffold('zeta', { ...MANIFEST, name: 'zeta', routeNamespace: 'zeta', tenancy: {} });
    scaffold('alpha', { ...MANIFEST, name: 'alpha', routeNamespace: 'alpha', tenancy: {} });
    expect(discoverExtensions(root).map((e) => e.name)).toEqual(['alpha', 'zeta']);
  });
});
