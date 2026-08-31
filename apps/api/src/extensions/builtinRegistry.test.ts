import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineBuiltin, loadBuiltinManifest, resolveBuiltinRoot } from './builtinRegistry';

/**
 * Exercises `resolveBuiltinRoot` / `loadBuiltinManifest`'s candidate order
 * against real fixture trees, faking `process.cwd()` the way a bundled API
 * process would see it in each of the runtime contexts the resolver targets
 * (dev tsx/vitest, both Docker images, and a bundle run from a plain repo
 * checkout). No neighboring test in this directory fakes cwd yet, so this
 * uses `vi.spyOn(process, 'cwd')` directly — the standard vitest seam.
 *
 * A fresh, never-real packageDir name is used throughout (`ee/fixture-builtin`
 * rather than `ee/workspace`) so the resolver's REAL source-file walk-up
 * (which points at this actual repo checkout) can never accidentally match a
 * fixture-tree candidate or mask a miss.
 */

const MANIFEST = {
  apiVersion: 'breeze.extensions/v1',
  name: 'fixture-builtin',
  version: '1.0.0',
  routeNamespace: 'fixture-builtin',
  requires: { breeze: '>=1.0.0', serverSdk: '^1.0.0', capabilities: [] },
  server: { entry: 'server/index.cjs' },
  migrationsDir: 'migrations',
  schemaCompatibilityFloor: '1.0.0',
  jobs: [],
  aiTools: [],
  tenancy: {
    orgCascadeDeleteTables: [],
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
  },
};

const PACKAGE_DIR = 'ee/fixture-builtin';

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

function scaffold(base: string, manifest: typeof MANIFEST = MANIFEST): void {
  const dir = join(base, PACKAGE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('resolveBuiltinRoot', () => {
  it('resolves from process.cwd() itself when the manifest sits there', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-'));
    scaffold(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(resolveBuiltinRoot(PACKAGE_DIR)).toBe(join(root, PACKAGE_DIR));
  });

  it('resolves from a cwd-ancestor level (bundle run from apps/api in a checkout)', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-'));
    scaffold(root);
    // Mirrors the failing CI shape: cwd = <repo>/apps/api, manifest lives at
    // <repo>/ee/fixture-builtin, i.e. cwd/../../ee/fixture-builtin.
    const cwd = join(root, 'apps', 'api');
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    expect(resolveBuiltinRoot(PACKAGE_DIR)).toBe(join(cwd, '..', '..', PACKAGE_DIR));
  });

  it('does not resolve past the bounded 3-ancestor search', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-'));
    scaffold(root);
    // 4 levels up from cwd is one hop beyond the bounded search — must miss.
    const cwd = join(root, 'a', 'b', 'c', 'd');
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    expect(resolveBuiltinRoot(PACKAGE_DIR)).toBe(join(cwd, PACKAGE_DIR));
  });

  it('falls back to cwd/<packageDir> when no candidate has a manifest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'breeze-builtin-empty-'));
    root = cwd;
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    expect(resolveBuiltinRoot(PACKAGE_DIR)).toBe(join(cwd, PACKAGE_DIR));
  });

  it('ignores an empty mount-point directory that has no manifest.json', () => {
    // A dir can exist (e.g. a mounted-but-unpopulated BREEZE_EXTENSIONS_DIR)
    // without a manifest; the resolver must not treat dir-existence as a hit.
    const cwd = mkdtempSync(join(tmpdir(), 'breeze-builtin-mount-'));
    root = cwd;
    mkdirSync(join(cwd, PACKAGE_DIR), { recursive: true }); // dir, no manifest.json
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    expect(resolveBuiltinRoot(PACKAGE_DIR)).toBe(join(cwd, PACKAGE_DIR));
  });
});

describe('loadBuiltinManifest', () => {
  it('parses the manifest found at a cwd-ancestor level', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-'));
    scaffold(root);
    const cwd = join(root, 'apps', 'api');
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const manifest = loadBuiltinManifest(PACKAGE_DIR);
    expect(manifest.name).toBe('fixture-builtin');
    expect(manifest.version).toBe('1.0.0');
  });

  it('throws a contextual error naming the package and every candidate tried when missing everywhere', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'breeze-builtin-miss-'));
    root = cwd;
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    let thrown: unknown;
    try {
      loadBuiltinManifest(PACKAGE_DIR);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Names the package.
    expect(message).toContain(PACKAGE_DIR);
    // Names the cwd-rooted candidates actually tried (the source walk-up
    // candidate points into the real repo, so it isn't asserted here).
    expect(message).toContain(join(cwd, PACKAGE_DIR, 'manifest.json'));
    expect(message).toContain(join(cwd, '..', PACKAGE_DIR, 'manifest.json'));
    expect(message).toContain(join(cwd, '..', '..', PACKAGE_DIR, 'manifest.json'));
    expect(message).toContain(join(cwd, '..', '..', '..', PACKAGE_DIR, 'manifest.json'));
    // Names the runtime contract so the failure is diagnosable from the
    // message alone, not a bare ENOENT.
    expect(message).toMatch(/Dockerfile|COPY/i);
    expect(message).toMatch(/process\.cwd\(\)/);
  });

  it('propagates a non-ENOENT read failure unwrapped (e.g. permission denied)', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-'));
    const dir = join(root, PACKAGE_DIR);
    mkdirSync(dir, { recursive: true });
    // A directory named manifest.json triggers EISDIR on read, not ENOENT —
    // must NOT be downgraded to the "missing everywhere" message.
    mkdirSync(join(dir, 'manifest.json'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(() => loadBuiltinManifest(PACKAGE_DIR)).toThrow(
      /EISDIR|illegal operation/i,
    );
  });
});

describe('BUILTINS manifest resolution is lazy (#3470)', () => {
  it('reads no built-in manifest at module import time', { timeout: 60_000 }, async () => {
    vi.resetModules();
    const manifestReads: string[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const readFileSync = (p: unknown, ...rest: unknown[]) => {
        if (typeof p === 'string' && p.endsWith('manifest.json')) manifestReads.push(p);
        return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      };
      return { ...actual, default: { ...actual, readFileSync }, readFileSync };
    });

    const mod = await import('./builtinRegistry');
    expect(manifestReads, `read during import: ${manifestReads.join(', ')}`).toEqual([]);
    expect(mod.BUILTINS.length).toBeGreaterThan(0);
    // The name set is derived from the STATIC name field, so it stays free of I/O too.
    expect([...mod.BUILTIN_EXTENSION_NAMES]).toEqual(['workspace']);
    expect(manifestReads, `read for names: ${manifestReads.join(', ')}`).toEqual([]);

    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('resolves the manifest on first access rather than at definition', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-lazy-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const builtin = defineBuiltin({
      module: { register() {} },
      name: MANIFEST.name,
      packageDir: PACKAGE_DIR,
      packageName: '@breeze/ext-fixture-builtin',
      helperRoutes: false,
      enableEnvVar: 'BREEZE_FIXTURE_BUILTIN_ENABLED',
    });

    scaffold(root);
    expect(builtin.manifest.name).toBe(MANIFEST.name);
  });

  it('memoises a successful manifest resolution', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-lazy-'));
    scaffold(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const builtin = defineBuiltin({
      module: { register() {} },
      name: MANIFEST.name,
      packageDir: PACKAGE_DIR,
      packageName: '@breeze/ext-fixture-builtin',
      helperRoutes: false,
      enableEnvVar: 'BREEZE_FIXTURE_BUILTIN_ENABLED',
    });

    const first = builtin.manifest;
    rmSync(root, { recursive: true, force: true });
    const second = builtin.manifest;

    expect(second).toBe(first);
  });

  it('memoises a failed manifest resolution and rethrows the identical error', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-lazy-miss-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const builtin = defineBuiltin({
      module: { register() {} },
      name: MANIFEST.name,
      packageDir: PACKAGE_DIR,
      packageName: '@breeze/ext-fixture-builtin',
      helperRoutes: false,
      enableEnvVar: 'BREEZE_FIXTURE_BUILTIN_ENABLED',
    });

    let first: unknown;
    let second: unknown;
    try {
      void builtin.manifest;
    } catch (error) {
      first = error;
    }
    try {
      void builtin.manifest;
    } catch (error) {
      second = error;
    }

    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
  });

  it('rejects a static name that disagrees with the shipped manifest name', () => {
    root = mkdtempSync(join(tmpdir(), 'breeze-builtin-lazy-mismatch-'));
    scaffold(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const builtin = defineBuiltin({
      module: { register() {} },
      name: 'something-else',
      packageDir: PACKAGE_DIR,
      packageName: '@breeze/ext-fixture-builtin',
      helperRoutes: false,
      enableEnvVar: 'BREEZE_FIXTURE_BUILTIN_ENABLED',
    });

    expect(() => builtin.manifest).toThrow(/something-else.*fixture-builtin|fixture-builtin.*something-else/);
  });
});
