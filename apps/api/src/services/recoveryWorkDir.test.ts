import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D7: recovery bundle/ISO builds write a 45-65MB helper binary plus a tarball
// or ISO into a scratch directory. The shipped compose files mount /tmp as a
// 64MB tmpfs, so `mkdtemp(join(tmpdir(), ...))` reliably fails with ENOSPC in
// any deployment using them. resolveRecoveryWorkDir() picks a scratch base
// directory that actually has room. Each scenario below re-imports the module
// fresh (vi.resetModules) so the "stale sweep runs once" module-level guard
// doesn't leak state across cases.

describe('resolveRecoveryWorkDir', () => {
  const originalEnv = process.env;
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RECOVERY_MEDIA_WORK_DIR;
    delete process.env.PATCH_REPORT_STORAGE_PATH;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const dir of cleanupDirs.splice(0)) {
      await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
    }
  });

  async function scratchDir(prefix = 'recovery-work-test-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  it('uses RECOVERY_MEDIA_WORK_DIR when set and writable', async () => {
    const explicitDir = join(await scratchDir(), 'explicit-work');
    process.env.RECOVERY_MEDIA_WORK_DIR = explicitDir;

    const { resolveRecoveryWorkDir } = await import('./recoveryWorkDir');
    const resolved = await resolveRecoveryWorkDir();

    expect(resolved).toBe(explicitDir);
    const stats = await stat(explicitDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('falls back to a recovery-work dir under the durable data directory when env is unset', async () => {
    const dataRoot = await scratchDir();
    process.env.PATCH_REPORT_STORAGE_PATH = join(dataRoot, 'patch-reports');

    const { resolveRecoveryWorkDir } = await import('./recoveryWorkDir');
    const resolved = await resolveRecoveryWorkDir();

    expect(resolved).toBe(join(dataRoot, 'recovery-work'));
    const stats = await stat(resolved);
    expect(stats.isDirectory()).toBe(true);
  });

  it('falls back to os.tmpdir() and logs a warning when no persistent candidate is writable', async () => {
    const blockerFile = join(await scratchDir(), 'not-a-directory');
    await writeFile(blockerFile, 'x');
    // Nesting a path under a file forces ENOTDIR on mkdir(recursive:true) —
    // a portable way to make a candidate "unwritable" without needing root.
    process.env.PATCH_REPORT_STORAGE_PATH = join(blockerFile, 'nested', 'patch-reports');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveRecoveryWorkDir } = await import('./recoveryWorkDir');
    const resolved = await resolveRecoveryWorkDir();

    expect(resolved).toBe(tmpdir());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tmpfs'));
  });

  it('falls through to the next candidate when RECOVERY_MEDIA_WORK_DIR is unwritable', async () => {
    const blockerFile = join(await scratchDir(), 'not-a-directory');
    await writeFile(blockerFile, 'x');
    process.env.RECOVERY_MEDIA_WORK_DIR = join(blockerFile, 'nested', 'work');

    const dataRoot = await scratchDir();
    process.env.PATCH_REPORT_STORAGE_PATH = join(dataRoot, 'patch-reports');

    const { resolveRecoveryWorkDir } = await import('./recoveryWorkDir');
    const resolved = await resolveRecoveryWorkDir();

    expect(resolved).toBe(join(dataRoot, 'recovery-work'));
  });

  it('removes stale bmr-bundle-*/recovery-boot-media-* subdirectories older than 24h on first use', async () => {
    const baseDir = await scratchDir();
    process.env.RECOVERY_MEDIA_WORK_DIR = baseDir;

    const staleBundleDir = join(baseDir, `bmr-bundle-${randomUUID()}`);
    const staleIsoDir = join(baseDir, `recovery-boot-media-${randomUUID()}`);
    const freshBundleDir = join(baseDir, `bmr-bundle-${randomUUID()}`);
    await mkdir(staleBundleDir, { recursive: true });
    await mkdir(staleIsoDir, { recursive: true });
    await mkdir(freshBundleDir, { recursive: true });

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(staleBundleDir, old, old);
    await utimes(staleIsoDir, old, old);

    const { resolveRecoveryWorkDir } = await import('./recoveryWorkDir');
    await resolveRecoveryWorkDir();

    const remaining = await readdir(baseDir);
    expect(remaining).not.toContain(basename(staleBundleDir));
    expect(remaining).not.toContain(basename(staleIsoDir));
    expect(remaining).toContain(basename(freshBundleDir));
  });
});
