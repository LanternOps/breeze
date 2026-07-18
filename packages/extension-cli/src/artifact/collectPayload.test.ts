import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectPayload } from './collectPayload';

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
  sourceDir = await mkdtemp(join(tmpdir(), 'breeze-ext-collect-'));
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

async function writeValidFixtureTree(): Promise<void> {
  await writeFixture('manifest.json', VALID_MANIFEST);
  await writeFixture('server/index.js', 'module.exports = () => {};');
  await writeFixture('migrations/0001_init.sql', 'select 1;');
}

describe('collectPayload', () => {
  it('collects every file as a forward-slash relative path, sorted bytewise', async () => {
    await writeValidFixtureTree();

    const members = await collectPayload(sourceDir);

    expect(members.map((m) => m.path)).toEqual([
      'manifest.json',
      'migrations/0001_init.sql',
      'server/index.js',
    ]);
  });

  it('includes manifest.json in the returned members', async () => {
    await writeValidFixtureTree();

    const members = await collectPayload(sourceDir);
    const manifestMember = members.find((m) => m.path === 'manifest.json');

    expect(manifestMember).toBeDefined();
    expect(manifestMember?.bytes.toString('utf8')).toBe(JSON.stringify(VALID_MANIFEST));
  });

  it('rejects a manifest.json that fails schema validation', async () => {
    await writeFixture('manifest.json', { ...VALID_MANIFEST, apiVersion: 'breeze.extensions/v2' });
    await writeFixture('server/index.js', 'module.exports = () => {};');

    await expect(collectPayload(sourceDir)).rejects.toThrow();
  });

  it('refuses a source tree containing a reserved member "integrity.json"', async () => {
    await writeValidFixtureTree();
    await writeFixture('integrity.json', '{}');

    await expect(collectPayload(sourceDir)).rejects.toThrow(/reserved member "integrity\.json"/);
  });

  it('refuses a source tree containing a reserved member "signature"', async () => {
    await writeValidFixtureTree();
    await writeFixture('signature', 'sig-bytes');

    await expect(collectPayload(sourceDir)).rejects.toThrow(/reserved member "signature"/);
  });

  it('refuses a symlink instead of following it', async () => {
    await writeValidFixtureTree();
    await symlink(join(sourceDir, 'server/index.js'), join(sourceDir, 'server/linked.js'));

    await expect(collectPayload(sourceDir)).rejects.toThrow(/symlink/);
  });

  it('rejects a source tree missing manifest.json', async () => {
    await writeFixture('server/index.js', 'module.exports = () => {};');

    await expect(collectPayload(sourceDir)).rejects.toThrow(/manifest\.json/);
  });
});
