import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../cli';
import { runValidate, validateExtension, type ValidateResult } from './validate';

const VALID_MANIFEST = {
  apiVersion: 'breeze.extensions/v1',
  name: 'acme-widgets',
  version: '1.0.0',
  routeNamespace: 'acme-widgets',
  requires: { breeze: '>=0.1.0 <0.2.0', serverSdk: '^1.0.0', capabilities: [] },
  server: { entry: 'server/index.js' },
  schemaCompatibilityFloor: '1.0.0',
  jobs: [],
  aiTools: [],
};

let sourceDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'breeze-ext-validate-'));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
});

async function writeFixture(relPath: string, contents: string | object): Promise<void> {
  const fullPath = join(sourceDir, ...relPath.split('/'));
  await mkdir(join(fullPath, '..'), { recursive: true });
  const body = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await writeFile(fullPath, body);
}

async function writeValidTree(): Promise<void> {
  await writeFixture('manifest.json', VALID_MANIFEST);
  await writeFixture('server/index.js', 'module.exports = () => {};');
}

describe('validateExtension', () => {
  it('accepts a well-formed source tree', async () => {
    await writeValidTree();
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.manifest).toEqual({
      name: 'acme-widgets',
      version: '1.0.0',
      apiVersion: 'breeze.extensions/v1',
    });
  });

  it('reports manifest_missing when there is no manifest.json', async () => {
    await writeFixture('server/index.js', 'module.exports = () => {};');
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'manifest_missing' }),
    ]);
  });

  it('reports manifest_invalid_json for a manifest that is not valid JSON', async () => {
    await writeFixture('manifest.json', '{ not json');
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'manifest_invalid_json' }),
    ]);
  });

  it('enumerates manifest_schema findings with structured field paths', async () => {
    // `devices` is a reserved core route namespace; `version` is not semver.
    await writeFixture('manifest.json', { ...VALID_MANIFEST, routeNamespace: 'devices', version: 'not-a-version' });
    await writeFixture('server/index.js', 'module.exports = () => {};');
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.findings.every((f) => f.code === 'manifest_schema')).toBe(true);
    const paths = result.findings.map((f) => f.path);
    expect(paths).toContain('routeNamespace');
    expect(paths).toContain('version');
  });

  it('reports entry_missing when server.entry is not present in the tree', async () => {
    await writeFixture('manifest.json', VALID_MANIFEST);
    // No server/index.js written.
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'entry_missing', path: 'server/index.js' }),
    ]);
  });

  it('reports entry_missing for a declared but absent web.entry', async () => {
    await writeFixture('manifest.json', {
      ...VALID_MANIFEST,
      requires: { breeze: '>=0.1.0 <0.2.0', serverSdk: '^1.0.0', webSdk: '^1.0.0', capabilities: [] },
      web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
    });
    await writeFixture('server/index.js', 'module.exports = () => {};');
    // No web/index.js written.
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'entry_missing', path: 'web/index.js' }),
    ]);
  });

  it('reports a layout finding when the source tree contains a symlink', async () => {
    await writeValidTree();
    await symlink(join(sourceDir, 'server', 'index.js'), join(sourceDir, 'server', 'alias.js'));
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'layout' }),
    ]);
    expect(result.findings[0]?.message).toMatch(/symlink/i);
  });

  it('reports a layout finding when a reserved generated member is carried in from source', async () => {
    await writeValidTree();
    await writeFixture('integrity.json', '{}');
    const result = await validateExtension({ path: sourceDir });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'layout' }),
    ]);
    expect(result.findings[0]?.message).toMatch(/reserved/i);
  });
});

describe('runValidate exit codes and output', () => {
  it('leaves process.exitCode unset (zero) on a valid tree and prints ok', async () => {
    await writeValidTree();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runValidate({ path: sourceDir });
      expect(process.exitCode).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('valid: ok'));
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('sets process.exitCode = 1 on a failing tree', async () => {
    await writeFixture('server/index.js', 'module.exports = () => {};');
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runValidate({ path: sourceDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('emits a machine-readable result under --json', async () => {
    await writeValidTree();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    let captured = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured = String(msg);
    });
    try {
      await runValidate({ path: sourceDir, json: true });
      const parsed = JSON.parse(captured) as ValidateResult;
      expect(parsed.ok).toBe(true);
      expect(parsed.manifest?.name).toBe('acme-widgets');
      expect(parsed.findings).toEqual([]);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});

describe('validate command wiring (no longer a stub)', () => {
  it('runs the validate action end-to-end via createProgram instead of throwing', async () => {
    await writeValidTree();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    let captured = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured += String(msg);
    });
    const program = createProgram();
    program.exitOverride();
    for (const command of program.commands) command.exitOverride();
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'breeze-ext', 'validate', sourceDir, '--json']);
    } catch (error) {
      caught = error;
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
    // The old stub threw "not implemented yet"; the action must now run cleanly.
    expect(caught).toBeUndefined();
    expect(captured).toContain('"ok": true');
  });
});
