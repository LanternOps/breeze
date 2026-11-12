import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeApiLocalBackupDestination, resolveApiLocalBackupPath } from './apiLocalBackupStorage';

describe('operator managed API local backup storage', () => {
  let base: string;
  let destination: string;
  const resolveOwn = (key = '') => resolveApiLocalBackupPath('/endpoint/path', key, 'org-a', 'destination');
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'breeze-api-local-'));
    destination = join(base, 'org-a', 'destination');
    await mkdir(destination, { recursive: true });
    vi.stubEnv('BACKUP_LOCAL_ROOT', base);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });

  it('derives host storage from authoritative owner/config while preserving endpoint settings', async () => {
    await probeApiLocalBackupDestination('C:\\Endpoint\\Backups', 'org-a', 'destination');
    expect(await resolveOwn('snapshots/new/file')).toBe(join(destination, 'snapshots/new/file'));
    expect(await readdir(destination)).toEqual([]);
  });

  it('uses the owning organization directory, not one named in destination settings', async () => {
    const otherOrgDir = join(base, 'org-b', 'destination');
    await mkdir(otherOrgDir, { recursive: true });
    await writeFile(join(otherOrgDir, 'kept'), 'org-b bytes');
    expect(await resolveApiLocalBackupPath(otherOrgDir, 'kept', 'org-a', 'destination')).toBe(join(destination, 'kept'));
    expect(await resolveApiLocalBackupPath(otherOrgDir, 'kept', 'org-b', 'destination')).toBe(join(otherOrgDir, 'kept'));
    expect(await readFile(join(otherOrgDir, 'kept'), 'utf8')).toBe('org-b bytes');
  });

  it.each([[undefined, 'destination'], ['org-a', undefined], ['', 'destination'], ['../org-b', 'destination'], ['org-a', '../other']])('requires authoritative owner/config (%s,%s)', async (orgId, configId) => {
    await expect(resolveApiLocalBackupPath('/endpoint', '', orgId, configId)).rejects.toThrow('unavailable');
  });

  it.each(['/', 'relative', ''])('refuses unsuitable operator roots (%s)', async (root) => {
    vi.stubEnv('BACKUP_LOCAL_ROOT', root);
    await expect(resolveOwn()).rejects.toThrow('unavailable');
  });

  it('refuses a missing mount, keys outside the destination and oversized keys without creating anything', async () => {
    await expect(resolveApiLocalBackupPath('/endpoint', '', 'org-a', 'absent')).rejects.toThrow('unavailable');
    await expect(resolveOwn('../../outside')).rejects.toThrow('unavailable');
    await expect(resolveOwn('x'.repeat(4097))).rejects.toThrow('unavailable');
    expect(await readdir(base)).toEqual(['org-a']);
  });

  it('refuses symlink mounts, intermediate directories and leaf objects', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    const file = join(outside, 'kept');
    await writeFile(file, 'unchanged');
    await symlink(outside, join(destination, 'link'));
    await symlink(file, join(destination, 'leaf'));
    await symlink(destination, join(base, 'org-a', 'alias'));
    await expect(resolveOwn('link/kept')).rejects.toThrow('unavailable');
    await expect(resolveOwn('leaf')).rejects.toThrow('unavailable');
    await expect(resolveApiLocalBackupPath('/endpoint', '', 'org-a', 'alias')).rejects.toThrow('unavailable');
    expect(await readFile(file, 'utf8')).toBe('unchanged');
  });
});
