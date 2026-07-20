import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import StreamZip from 'node-stream-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../cli';
import { packExtension } from './pack';

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
let workDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'breeze-ext-pack-src-'));
  workDir = await mkdtemp(join(tmpdir(), 'breeze-ext-pack-out-'));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
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

async function readZipEntries(archivePath: string): Promise<Record<string, Buffer>> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    const entries = await zip.entries();
    const out: Record<string, Buffer> = {};
    for (const name of Object.keys(entries)) {
      out[name] = await zip.entryData(name);
    }
    return out;
  } finally {
    await zip.close();
  }
}

describe('packExtension', () => {
  it('packs a fixture source tree to an archive containing manifest.json, integrity.json, the server entry, and migrations', async () => {
    await writeValidFixtureTree();
    const destination = join(workDir, 'out.breeze-ext');

    const result = await packExtension({ path: sourceDir, out: destination });

    expect(result.artifactPath).toBe(destination);
    const entries = await readZipEntries(destination);
    expect(Object.keys(entries).sort()).toEqual([
      'integrity.json',
      'manifest.json',
      'migrations/0001_init.sql',
      'server/index.js',
    ]);
    expect(entries['signature']).toBeUndefined();
  });

  it('inventories every non-reserved member and nothing else in integrity.json, including manifest.json', async () => {
    await writeValidFixtureTree();
    const destination = join(workDir, 'out.breeze-ext');

    await packExtension({ path: sourceDir, out: destination });

    const entries = await readZipEntries(destination);
    const integrity = JSON.parse(entries['integrity.json'].toString('utf8'));
    expect(Object.keys(integrity.members).sort()).toEqual([
      'manifest.json',
      'migrations/0001_init.sql',
      'server/index.js',
    ]);
  });

  it('rejects an invalid manifest', async () => {
    await writeFixture('manifest.json', { ...VALID_MANIFEST, apiVersion: 'breeze.extensions/v2' });
    await writeFixture('server/index.js', 'module.exports = () => {};');
    const destination = join(workDir, 'out.breeze-ext');

    await expect(packExtension({ path: sourceDir, out: destination })).rejects.toThrow();
  });

  it('refuses a source tree containing a reserved "integrity.json" member', async () => {
    await writeValidFixtureTree();
    await writeFixture('integrity.json', '{}');
    const destination = join(workDir, 'out.breeze-ext');

    await expect(packExtension({ path: sourceDir, out: destination })).rejects.toThrow(/reserved member/);
  });

  it('refuses a source tree containing a reserved "signature" member', async () => {
    await writeValidFixtureTree();
    await writeFixture('signature', 'sig-bytes');
    const destination = join(workDir, 'out.breeze-ext');

    await expect(packExtension({ path: sourceDir, out: destination })).rejects.toThrow(/reserved member/);
  });

  it('refuses to follow a symlink in the source tree', async () => {
    await writeValidFixtureTree();
    await symlink(join(sourceDir, 'server/index.js'), join(sourceDir, 'server/linked.js'));
    const destination = join(workDir, 'out.breeze-ext');

    await expect(packExtension({ path: sourceDir, out: destination })).rejects.toThrow(/symlink/);
  });

  it('writes <name>-<version>.breeze-ext when --out is a directory', async () => {
    await writeValidFixtureTree();

    const result = await packExtension({ path: sourceDir, out: workDir });

    expect(result.artifactPath).toBe(join(workDir, 'acme-widgets-1.0.0.breeze-ext'));
    const entries = await readZipEntries(result.artifactPath);
    expect(Object.keys(entries)).toContain('manifest.json');
  });

  it('returns a digest in the sha256:<hex> artifact-digest form', async () => {
    await writeValidFixtureTree();
    const destination = join(workDir, 'out.breeze-ext');

    const result = await packExtension({ path: sourceDir, out: destination });

    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('packs identical source trees to identical artifact bytes', async () => {
    await writeValidFixtureTree();
    const destinationA = join(workDir, 'a.breeze-ext');
    const destinationB = join(workDir, 'b.breeze-ext');

    const resultA = await packExtension({ path: sourceDir, out: destinationA });
    const resultB = await packExtension({ path: sourceDir, out: destinationB });

    expect(resultA.digest).toBe(resultB.digest);
  });

  it('reads SOURCE_DATE_EPOCH from the environment so a caller can pin build time', async () => {
    await writeValidFixtureTree();
    const original = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = '0';
      const zero = await packExtension({ path: sourceDir, out: join(workDir, 'epoch-0.breeze-ext') });
      process.env.SOURCE_DATE_EPOCH = '1700000000';
      const later = await packExtension({ path: sourceDir, out: join(workDir, 'epoch-1.breeze-ext') });
      // A different epoch must change the archive bytes — proof the env value is
      // actually threaded to the timestamp, not silently ignored.
      expect(zero.digest).not.toBe(later.digest);
    } finally {
      if (original === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = original;
    }
  });

  it('rejects a non-integer SOURCE_DATE_EPOCH rather than silently defaulting', async () => {
    await writeValidFixtureTree();
    const original = process.env.SOURCE_DATE_EPOCH;
    try {
      process.env.SOURCE_DATE_EPOCH = 'not-a-number';
      await expect(
        packExtension({ path: sourceDir, out: join(workDir, 'bad-epoch.breeze-ext') }),
      ).rejects.toThrow(/SOURCE_DATE_EPOCH/);
    } finally {
      if (original === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = original;
    }
  });
});

describe('breeze-ext pack CLI', () => {
  it('packs via the CLI command form: pack <sourceDir> --out <path>', async () => {
    await writeValidFixtureTree();
    const destination = join(workDir, 'cli-out.breeze-ext');
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'breeze-ext', 'pack', sourceDir, '--out', destination]);

    const entries = await readZipEntries(destination);
    expect(Object.keys(entries)).toContain('integrity.json');
  });
});
