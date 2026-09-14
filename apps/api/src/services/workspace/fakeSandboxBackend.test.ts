import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeSandboxBackend, type FakeSandboxBackend } from './fakeSandboxBackend';
import type { SandboxCreateSpec, SandboxHandle } from './sandboxBackend';

const SPEC: SandboxCreateSpec = {
  runId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  region: 'eu',
  cpu: 1,
  memoryMb: 2048,
  deadlineSeconds: 60,
  image: 'breeze-analysis@test',
};

describe('fakeSandboxBackend', () => {
  let backend: FakeSandboxBackend;
  let handle: SandboxHandle;

  beforeEach(async () => {
    backend = createFakeSandboxBackend();
    handle = await backend.create(SPEC);
  });

  afterEach(async () => {
    await backend.reset();
  });

  it('creates a private temp dir with the three work dirs and no tenant id in providerRef', async () => {
    const root = backend.hostRootFor(handle);
    expect(root.startsWith(os.tmpdir())).toBe(true);
    expect(handle.backend).toBe('fake');
    expect(handle.region).toBe('eu');
    expect(handle.providerRef).not.toContain(SPEC.orgId);
    expect(handle.providerRef).not.toContain(SPEC.runId);
    for (const dir of ['in', 'out', 'tmp']) {
      const stat = await fs.stat(path.join(root, dir));
      expect(stat.isDirectory()).toBe(true);
    }
    expect(backend.liveCount()).toBe(1);
  });

  it('executes an argv by path — shell metacharacters in the script are inert data', async () => {
    // The script LINE contains `; curl example.com`. If anything anywhere in the
    // stack passed this through a shell, curl would run. It must not.
    await backend.writeFiles(handle, [
      { path: '/work/step-1.sh', bytes: Buffer.from('echo hello ; curl example.com\n') },
    ]);
    const res = await backend.exec(handle, ['/bin/sh', '/work/step-1.sh'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    });
    // sh RUNS the file, so `curl` is attempted by the script itself — that is the
    // script's own content and is fine. What must never happen is the FILENAME or
    // argv being parsed by a shell. Assert with an argv-only command instead:
    const echoed = await backend.exec(handle, ['/bin/echo', 'a; curl example.com'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    });
    expect(echoed.exitCode).toBe(0);
    expect(echoed.stdout.toString()).toBe('a; curl example.com\n');
    // The script-by-path call must also have actually RUN (a mis-resolved
    // /work path would exit 127 and this case would otherwise not notice).
    expect(res.timedOut).toBe(false);
    expect(res.stdout.toString()).toContain('hello');
  });

  it('does not leak the parent process environment into the child', async () => {
    process.env.BREEZE_FAKE_SANDBOX_LEAK_CANARY = 'leaked';
    try {
      const res = await backend.exec(
        handle,
        ['/usr/bin/env'],
        { timeoutMs: 10_000, maxStdoutBytes: 65_536 },
      );
      expect(res.stdout.toString()).not.toContain('leaked');
      expect(res.stdout.toString()).not.toContain('BREEZE_FAKE_SANDBOX_LEAK_CANARY');
    } finally {
      delete process.env.BREEZE_FAKE_SANDBOX_LEAK_CANARY;
    }
  });

  it('truncates stdout at maxStdoutBytes and flags it', async () => {
    const res = await backend.exec(
      handle,
      ['/bin/sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 0; do printf "0123456789"; done'],
      { timeoutMs: 10_000, maxStdoutBytes: 16 },
    );
    expect(res.stdout.length).toBe(16);
    expect(res.stdoutTruncated).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it('kills a runaway step at timeoutMs and reports timedOut', async () => {
    const res = await backend.exec(handle, ['/bin/sh', '-c', 'sleep 30'], {
      timeoutMs: 300,
      maxStdoutBytes: 1024,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(10_000);
  });

  // The plain `sh -c 'sleep 30'` case above does NOT discriminate: a POSIX
  // shell execve-optimises a single trailing command, so `sleep` usually
  // BECOMES the direct child and a kill aimed at that child alone would still
  // pass. This case forces a real grandchild (`&` + `wait`), which only the
  // process-group kill can reap. Without `detached: true` + `process.kill(-pid)`
  // the surviving grandchild holds stdout/stderr open, 'close' never fires, and
  // exec() hangs until vitest's own timeout instead of resolving as timedOut.
  it('kills a GRANDCHILD too, not just the direct child', async () => {
    const res = await backend.exec(
      handle,
      ['/bin/sh', '-c', 'sleep 30 & wait'],
      { timeoutMs: 300, maxStdoutBytes: 1024 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(10_000);
  }, 15_000);

  it('roundtrips writeFiles/readFile and refuses a read over maxBytes', async () => {
    await backend.writeFiles(handle, [{ path: '/work/in/a.txt', bytes: Buffer.from('hello') }]);
    expect((await backend.readFile(handle, '/work/in/a.txt', 100)).toString()).toBe('hello');
    await expect(backend.readFile(handle, '/work/in/a.txt', 2)).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('refuses a writeFiles batch over maxTotalBytes without writing anything', async () => {
    await expect(
      backend.writeFiles(
        handle,
        [
          { path: '/work/in/b.txt', bytes: Buffer.alloc(10, 0x61) },
          { path: '/work/in/c.txt', bytes: Buffer.alloc(10, 0x62) },
        ],
        { maxTotalBytes: 15 },
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(backend.readFile(handle, '/work/in/b.txt', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses every path outside /work, including via a planted symlink', async () => {
    await expect(backend.readFile(handle, '/etc/passwd', 100)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    const root = backend.hostRootFor(handle);
    await fs.symlink('/etc', path.join(root, 'out', 'escape'));
    await expect(backend.readFile(handle, '/work/out/escape/passwd', 100)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      backend.writeFiles(handle, [{ path: '/work/out/escape/x', bytes: Buffer.from('x') }]),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('lists files with sizes, dir and symlink flags', async () => {
    await backend.writeFiles(handle, [{ path: '/work/out/r.csv', bytes: Buffer.from('a,b\n') }]);
    await fs.mkdir(path.join(backend.hostRootFor(handle), 'out', 'sub'));
    const listed = await backend.listFiles(handle, '/work/out');
    expect(listed).toEqual(
      expect.arrayContaining([
        { path: '/work/out/r.csv', bytes: 4, isDir: false, isSymlink: false },
        { path: '/work/out/sub', bytes: expect.any(Number), isDir: true, isSymlink: false },
      ]),
    );
  });

  it('destroys idempotently, removes the temp dir, and keeps usage readable', async () => {
    await backend.exec(handle, ['/bin/sh', '-c', 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
    });
    const root = backend.hostRootFor(handle);
    await backend.destroy(handle);
    await backend.destroy(handle);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(backend.liveCount()).toBe(0);

    const usage = await backend.usage(handle);
    expect(usage.memAllocatedMb).toBe(2048);
    expect(usage.wallMs).toBeGreaterThan(0);
    expect(usage.cpuMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(usage.cpuMs)).toBe(true);
  });

  it('records every call in order for W03 assertions', async () => {
    await backend.writeFiles(handle, [{ path: '/work/in/x', bytes: Buffer.from('x') }]);
    await backend.exec(handle, ['/usr/bin/true'], { timeoutMs: 1000, maxStdoutBytes: 16 });
    await backend.destroy(handle);
    expect(backend.calls.map((c) => c.method)).toEqual([
      'create',
      'writeFiles',
      'exec',
      'destroy',
    ]);
    expect(backend.calls[2]?.detail).toEqual(['/usr/bin/true']);
  });
});
