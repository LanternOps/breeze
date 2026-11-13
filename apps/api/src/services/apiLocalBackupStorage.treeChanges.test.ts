import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Filesystem calls are wrapped so a test can change the destination tree at
 * an exact point: right after the storage code has looked at (stat) or opened
 * an object, or right after it created a directory.
 */
const hooks = vi.hoisted(() => ({
  afterLookup: null as null | { suffix: string; run: () => Promise<void> },
  afterMkdir: null as null | ((path: string) => Promise<void>),
  fired: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  async function lookupHook(path: unknown) {
    const hook = hooks.afterLookup;
    if (hook && String(path).endsWith(hook.suffix)) {
      hooks.afterLookup = null;
      hooks.fired.push(`lookup:${hook.suffix}`);
      await hook.run();
    }
  }
  const wrapped = {
    ...actual,
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      const result = await (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      await lookupHook(path);
      return result;
    }) as typeof actual.stat,
    open: (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      const result = await (actual.open as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      await lookupHook(path);
      return result;
    }) as typeof actual.open,
    mkdir: (async (path: Parameters<typeof actual.mkdir>[0], ...rest: unknown[]) => {
      const result = await (actual.mkdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
      const hook = hooks.afterMkdir;
      if (hook) {
        hooks.afterMkdir = null;
        hooks.fired.push('mkdir');
        await hook(String(path));
      }
      return result;
    }) as typeof actual.mkdir,
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('../db', () => ({ db: {}, assertOutsideHeldDbContext: vi.fn() }));
vi.mock('./recoveryBootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recoveryBootstrap')>();
  return { ...actual, resolveSnapshotProviderConfig: vi.fn() };
});
vi.mock('./recoverySigning', () => ({
  getRecoverySigningConfig: vi.fn(() => null),
  signRecoveryArtifact: vi.fn(),
}));

import { mkdir, mkdtemp, open, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { fetchBackupObjectText, openBackupObjectStream } from './backupSnapshotStorage';
import { uploadRecoveryArtifactFile } from './recoveryMediaService';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('API-side local storage when the destination tree changes during an operation', () => {
  let root: string;
  let destination: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-local-race-'));
    destination = join(root, 'org-1', 'cfg-1');
    outside = join(root, 'outside');
    await mkdir(join(destination, 'snapshots', 's1'), { recursive: true });
    await mkdir(join(outside, 's1'), { recursive: true });
    await writeFile(join(destination, 'snapshots', 's1', 'manifest.json'), 'inside');
    await writeFile(join(outside, 's1', 'manifest.json'), 'outside');
    vi.stubEnv('BACKUP_LOCAL_ROOT', root);
    hooks.afterLookup = null;
    hooks.afterMkdir = null;
    hooks.fired = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('an object stream never reads through a directory replaced by a link after the object was looked up', async () => {
    hooks.afterLookup = {
      suffix: '/manifest.json',
      run: async () => {
        await rename(join(destination, 'snapshots', 's1'), join(destination, 's1-moved'));
        await symlink(join(outside, 's1'), join(destination, 'snapshots', 's1'));
      },
    };

    const content = await openBackupObjectStream({
      provider: 'local',
      providerConfig: { path: '/stored/endpoint/path' },
      orgId: 'org-1',
      configId: 'cfg-1',
      key: 'snapshots/s1/manifest.json',
      maxBytes: 1024,
    }).then(readAll, (error: Error) => `refused: ${error.message}`);

    expect(hooks.fired).toEqual(['lookup:/manifest.json']);
    expect(content).not.toBe('outside');
    expect(['inside', expect.stringContaining('unavailable')]).toContainEqual(content);
  });

  it('publishing an artifact never writes through a directory replaced by a link right after it was created', async () => {
    const source = join(root, 'artifact-source');
    await writeFile(source, 'artifact bytes');
    await mkdir(join(outside, 'drop'), { recursive: true });
    hooks.afterMkdir = async (created) => {
      await rename(created, `${created}-moved`);
      await symlink(join(outside, 'drop'), created);
    };

    const result = await uploadRecoveryArtifactFile({
      provider: 'local',
      orgId: 'org-1',
      configId: 'cfg-1',
      rootPath: '/stored/endpoint/path',
      storageKey: 'recovery-media/a1/artifact.tar.gz',
      downloadFilename: 'artifact.tar.gz',
    }, source).then(() => 'written', (error: Error) => `refused: ${error.message}`);

    expect(hooks.fired).toEqual(['mkdir']);
    expect(await readdir(join(outside, 'drop'))).toEqual([]);
    expect(result).toContain('unavailable');
  });

  it('reading an object that is not a regular file is refused instead of waiting on it', async () => {
    const fifo = join(destination, 'snapshots', 's1', 'state.json');
    execFileSync('mkfifo', [fifo]);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        fetchBackupObjectText({
          provider: 'local',
          providerConfig: { path: '/stored/endpoint/path' },
          orgId: 'org-1',
          configId: 'cfg-1',
          key: 'snapshots/s1/state.json',
        }).then(() => 'read', (error: Error) => `refused: ${error.message}`),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still waiting'), 2000); }),
      ]);
      expect(outcome).toContain('unavailable');
    } finally {
      clearTimeout(timer);
      // Release any reader still blocked on the pipe.
      const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null);
      await writer?.close();
    }
  });
});
