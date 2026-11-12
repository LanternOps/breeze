import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiLocalBackupWalkModeForTests,
  copyApiLocalBackupObjectTo,
  listApiLocalBackupObjects,
  openApiLocalBackupObject,
  probeApiLocalBackupDestination,
  removeApiLocalBackupObject,
  removeApiLocalBackupTree,
  writeApiLocalBackupObject,
} from './apiLocalBackupStorage';

async function readObject(key: string, orgId?: string, configId?: string): Promise<string> {
  const object = await openApiLocalBackupObject(key, orgId, configId);
  try {
    return await object.handle.readFile('utf8');
  } finally {
    await object.handle.close();
  }
}

async function listKeys(prefix: string, orgId = 'org-a', configId = 'destination'): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of listApiLocalBackupObjects(prefix, orgId, configId, 2)) keys.push(...page.map((item) => item.key));
  return keys.sort();
}

describe('operator managed API local backup storage', () => {
  let base: string;
  let destination: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'breeze-api-local-'));
    destination = join(base, 'org-a', 'destination');
    outside = join(base, 'outside');
    await mkdir(destination, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'kept'), 'unchanged');
    vi.stubEnv('BACKUP_LOCAL_ROOT', base);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });

  it('tests an existing destination directory without creating anything', async () => {
    await probeApiLocalBackupDestination('org-a', 'destination');
    expect(await readdir(destination)).toEqual([]);
    expect(['handle', 'path']).toContain(apiLocalBackupWalkModeForTests());
    if (process.platform === 'linux') expect(apiLocalBackupWalkModeForTests()).toBe('handle');
  });

  it('reads only from the owning organization and configuration directory', async () => {
    await mkdir(join(base, 'org-b', 'destination'), { recursive: true });
    await writeFile(join(base, 'org-b', 'destination', 'kept'), 'org-b bytes');
    await writeFile(join(destination, 'kept'), 'org-a bytes');
    expect(await readObject('kept', 'org-a', 'destination')).toBe('org-a bytes');
    expect(await readObject('kept', 'org-b', 'destination')).toBe('org-b bytes');
  });

  it('reports a missing object as not found', async () => {
    await expect(openApiLocalBackupObject('snapshots/none/manifest.json', 'org-a', 'destination'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([[undefined, 'destination'], ['org-a', undefined], ['', 'destination'], ['../org-b', 'destination'], ['org-a', '../other']])(
    'requires the owning organization and configuration ids (%s,%s)',
    async (orgId, configId) => {
      await expect(openApiLocalBackupObject('kept', orgId, configId)).rejects.toThrow('unavailable');
      await expect(probeApiLocalBackupDestination(orgId as string, configId as string)).rejects.toThrow('unavailable');
    },
  );

  it.each(['/', 'relative', ''])('refuses unsuitable operator roots (%s)', async (root) => {
    vi.stubEnv('BACKUP_LOCAL_ROOT', root);
    await expect(probeApiLocalBackupDestination('org-a', 'destination')).rejects.toThrow('unavailable');
  });

  it('refuses a missing mount, keys outside the destination and oversized keys without creating anything', async () => {
    await expect(probeApiLocalBackupDestination('org-a', 'absent')).rejects.toThrow('unavailable');
    await expect(writeApiLocalBackupObject('x', 'org-a', 'absent', join(outside, 'kept'))).rejects.toThrow('unavailable');
    await expect(openApiLocalBackupObject('../../outside/kept', 'org-a', 'destination')).rejects.toThrow('unavailable');
    await expect(writeApiLocalBackupObject('a/../../x', 'org-a', 'destination', join(outside, 'kept'))).rejects.toThrow('unavailable');
    await expect(openApiLocalBackupObject('x'.repeat(4097), 'org-a', 'destination')).rejects.toThrow('unavailable');
    expect((await readdir(base)).sort()).toEqual(['org-a', 'outside']);
    expect(await readdir(destination)).toEqual([]);
  });

  it('refuses links for directories, objects and the destination itself', async () => {
    await symlink(outside, join(destination, 'link'));
    await symlink(join(outside, 'kept'), join(destination, 'leaf'));
    await symlink(destination, join(base, 'org-a', 'alias'));
    await expect(openApiLocalBackupObject('link/kept', 'org-a', 'destination')).rejects.toThrow('unavailable');
    await expect(openApiLocalBackupObject('leaf', 'org-a', 'destination')).rejects.toThrow('unavailable');
    await expect(probeApiLocalBackupDestination('org-a', 'alias')).rejects.toThrow('unavailable');
    await expect(writeApiLocalBackupObject('link/new', 'org-a', 'destination', join(outside, 'kept'))).rejects.toThrow('unavailable');
    expect((await readdir(outside)).sort()).toEqual(['kept']);
    expect(await readFile(join(outside, 'kept'), 'utf8')).toBe('unchanged');
  });

  it('refuses an object that is not a regular file', async () => {
    await mkdir(join(destination, 'snapshots'));
    execFileSync('mkfifo', [join(destination, 'snapshots', 'pipe')]);
    await expect(openApiLocalBackupObject('snapshots/pipe', 'org-a', 'destination')).rejects.toThrow('unavailable');
    await expect(openApiLocalBackupObject('snapshots', 'org-a', 'destination')).rejects.toThrow('unavailable');
  });

  it('publishes an object through a new file, creating directories level by level', async () => {
    const source = join(base, 'source');
    await writeFile(source, 'artifact bytes');
    await writeApiLocalBackupObject('recovery-media/a1/artifact.tar.gz', 'org-a', 'destination', source);
    expect(await readFile(join(destination, 'recovery-media', 'a1', 'artifact.tar.gz'), 'utf8')).toBe('artifact bytes');
    expect(await readdir(join(destination, 'recovery-media', 'a1'))).toEqual(['artifact.tar.gz']);

    await writeFile(source, 'replacement');
    await writeApiLocalBackupObject('recovery-media/a1/artifact.tar.gz', 'org-a', 'destination', source);
    expect(await readObject('recovery-media/a1/artifact.tar.gz', 'org-a', 'destination')).toBe('replacement');

    const copy = join(base, 'work', 'copy');
    await copyApiLocalBackupObjectTo('recovery-media/a1/artifact.tar.gz', 'org-a', 'destination', copy);
    expect(await readFile(copy, 'utf8')).toBe('replacement');
  });

  it('replaces a link at the object name instead of writing through it', async () => {
    const source = join(base, 'source');
    await writeFile(source, 'artifact bytes');
    await symlink(join(outside, 'kept'), join(destination, 'artifact'));
    await writeApiLocalBackupObject('artifact', 'org-a', 'destination', source);
    expect(await readFile(join(outside, 'kept'), 'utf8')).toBe('unchanged');
    expect((await lstat(join(destination, 'artifact'))).isFile()).toBe(true);
  });

  it('lists regular files under a prefix and skips links', async () => {
    await mkdir(join(destination, 'snapshots', 's1', 'files'), { recursive: true });
    await writeFile(join(destination, 'snapshots', 's1', 'manifest.json'), '{}');
    await writeFile(join(destination, 'snapshots', 's1', 'files', 'a.gz'), 'a');
    await writeFile(join(destination, 'snapshots', 's1', 'files', 'b.gz'), 'b');
    await symlink(outside, join(destination, 'snapshots', 'linked'));
    await symlink(join(outside, 'kept'), join(destination, 'snapshots', 's1', 'files', 'c.gz'));
    expect(await listKeys('snapshots')).toEqual([
      'snapshots/s1/files/a.gz', 'snapshots/s1/files/b.gz', 'snapshots/s1/manifest.json',
    ]);
    expect(await listKeys('snapshots/absent')).toEqual([]);
  });

  it('removes objects and trees without following links', async () => {
    await mkdir(join(destination, 'snapshots', 's1', 'files'), { recursive: true });
    await writeFile(join(destination, 'snapshots', 's1', 'files', 'a.gz'), 'a');
    await symlink(outside, join(destination, 'snapshots', 's1', 'linked-dir'));
    await symlink(join(outside, 'kept'), join(destination, 'leaf'));

    await removeApiLocalBackupObject('leaf', 'org-a', 'destination');
    await removeApiLocalBackupObject('snapshots/none/x', 'org-a', 'destination');
    await removeApiLocalBackupTree('snapshots/s1', 'org-a', 'destination');
    await removeApiLocalBackupTree('snapshots/none', 'org-a', 'destination');

    expect(await readdir(destination)).toEqual(['snapshots']);
    expect(await readdir(join(destination, 'snapshots'))).toEqual([]);
    expect((await readdir(outside)).sort()).toEqual(['kept']);
    expect(await readFile(join(outside, 'kept'), 'utf8')).toBe('unchanged');
    await expect(removeApiLocalBackupTree('', 'org-a', 'destination')).rejects.toThrow('unavailable');
  });
});
