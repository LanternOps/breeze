import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeSandboxBackend } from './fakeSandboxBackend';
import { createVercelSandboxBackend } from './vercelSandboxBackend';
import type { SandboxBackend, SandboxCreateSpec, SandboxHandle } from './sandboxBackend';

const VERCEL_CONFIGURED = Boolean(
  process.env.VERCEL_SANDBOX_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID,
);

interface Candidate {
  label: string;
  make: () => SandboxBackend;
  /** The interpreter guaranteed to exist in that backend's image. */
  sh: string;
  timeoutMs: number;
}

const CANDIDATES: Candidate[] = [
  { label: 'fake', make: createFakeSandboxBackend, sh: '/bin/sh', timeoutMs: 15_000 },
  ...(VERCEL_CONFIGURED
    ? [{ label: 'vercel', make: createVercelSandboxBackend, sh: 'sh', timeoutMs: 60_000 } as Candidate]
    : []),
];

// A suite that quietly registers nothing is a suite that can never go red.
it('registers at least the fake backend', () => {
  expect(CANDIDATES.map((c) => c.label)).toContain('fake');
});

describe.each(CANDIDATES)('SandboxBackend contract [$label]', (candidate) => {
  const spec: SandboxCreateSpec = {
    runId: '33333333-3333-4333-8333-333333333333',
    orgId: '44444444-4444-4444-8444-444444444444',
    region: 'eu',
    cpu: 1,
    memoryMb: 2048,
    deadlineSeconds: 300,
    image: 'breeze-analysis@contract',
  };

  let backend: SandboxBackend;
  let handle: SandboxHandle;

  beforeAll(async () => {
    backend = candidate.make();
    handle = await backend.create(spec);
  }, candidate.timeoutMs);

  afterAll(async () => {
    // Never leave a real sandbox behind, even if a case threw.
    try {
      await backend.destroy(handle);
    } catch {
      /* asserted separately */
    }
  }, candidate.timeoutMs);

  it('reports the backend name and region on the handle', () => {
    expect(backend.name).toBe(candidate.label);
    expect(handle.backend).toBe(candidate.label);
    expect(handle.region).toBe('eu');
    expect(handle.providerRef).toEqual(expect.any(String));
    expect(handle.providerRef).not.toContain(spec.orgId);
    expect(handle.providerRef).not.toContain(spec.runId);
  });

  it(
    'executes BY PATH only — a shell metacharacter in the argv is data, not syntax',
    async () => {
      // The literal `; curl example.com` is passed as ONE argv element. If any
      // layer handed it to a shell, `curl` would run (and, with deny-all, hang
      // or fail) and the echoed text would be truncated at the `;`. Getting the
      // whole string back is the proof that no shell parsed it.
      const res = await backend.exec(handle, ['echo', 'hello; curl example.com'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString().trim()).toBe('hello; curl example.com');
      expect(res.timedOut).toBe(false);
    },
    candidate.timeoutMs,
  );

  it(
    'runs a written script file by interpreter path',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-1.sh', bytes: Buffer.from('printf contract-ok\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-1.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toContain('contract-ok');
    },
    candidate.timeoutMs,
  );

  it(
    'truncates stdout at maxStdoutBytes and flags stdoutTruncated',
    async () => {
      await backend.writeFiles(handle, [
        {
          path: '/work/step-loud.sh',
          bytes: Buffer.from('i=0; while [ $i -lt 200 ]; do printf 0123456789; i=$((i+1)); done\n'),
        },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-loud.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 64,
      });
      expect(res.stdout.length).toBe(64);
      expect(res.stdoutTruncated).toBe(true);
    },
    candidate.timeoutMs,
  );

  it(
    'kills a step at timeoutMs and reports timedOut with a null exit code',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-slow.sh', bytes: Buffer.from('sleep 120\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-slow.sh'], {
        timeoutMs: 2_000,
        maxStdoutBytes: 1024,
      });
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBeNull();
      expect(res.durationMs).toBeLessThan(60_000);
    },
    candidate.timeoutMs,
  );

  it(
    'pipes stdinBytes into the step',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-stdin.sh', bytes: Buffer.from('cat\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-stdin.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
        stdinBytes: Buffer.from('piped-input'),
      });
      expect(res.stdout.toString()).toContain('piped-input');
    },
    candidate.timeoutMs,
  );

  it(
    'roundtrips writeFiles/readFile and refuses a read over maxBytes',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/in/roundtrip.txt', bytes: Buffer.from('contract-bytes') },
      ]);
      const read = await backend.readFile(handle, '/work/in/roundtrip.txt', 1024);
      expect(read.toString()).toBe('contract-bytes');
      await expect(backend.readFile(handle, '/work/in/roundtrip.txt', 4)).rejects.toMatchObject({
        code: 'file_too_large',
      });
    },
    candidate.timeoutMs,
  );

  it(
    'refuses a writeFiles batch over maxTotalBytes',
    async () => {
      await expect(
        backend.writeFiles(
          handle,
          [{ path: '/work/in/big.bin', bytes: Buffer.alloc(4096, 0x41) }],
          { maxTotalBytes: 1024 },
        ),
      ).rejects.toMatchObject({ code: 'file_too_large' });
    },
    candidate.timeoutMs,
  );

  it(
    'refuses every path outside /work',
    async () => {
      for (const bad of ['/etc/passwd', '/work/../etc/passwd', '../../etc/passwd']) {
        await expect(backend.readFile(handle, bad, 16)).rejects.toMatchObject({
          code: 'invalid_path',
        });
      }
    },
    candidate.timeoutMs,
  );

  it(
    'refuses to read THROUGH a symlink the sandbox itself planted',
    async () => {
      // The lexical fence only proves the STRING is under /work. The model's own
      // script can plant a link there that points anywhere, and every backend
      // must refuse to follow it — otherwise "every path is confined to /work"
      // is only true of paths nobody tried to escape with. This case exists
      // because the fake enforced it and the production backend did not.
      const made = await backend.exec(handle, ['ln', '-s', '/etc', '/work/out/escape'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 1024,
      });
      expect(made.exitCode).toBe(0);

      await expect(backend.readFile(handle, '/work/out/escape/hostname', 1024)).rejects.toMatchObject(
        { code: 'invalid_path' },
      );
      await expect(
        backend.writeFiles(handle, [{ path: '/work/out/escape/planted', bytes: Buffer.from('x') }]),
      ).rejects.toMatchObject({ code: 'invalid_path' });
    },
    candidate.timeoutMs,
  );

  it(
    'lists files with bytes, isDir and isSymlink',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/out/listed.txt', bytes: Buffer.from('abcd') },
      ]);
      const listed = await backend.listFiles(handle, '/work/out');
      const entry = listed.find((f) => f.path === '/work/out/listed.txt');
      expect(entry).toBeDefined();
      expect(entry?.bytes).toBe(4);
      expect(entry?.isDir).toBe(false);
    },
    candidate.timeoutMs,
  );

  it(
    'destroys idempotently and then exposes a well-formed usage record',
    async () => {
      // destroy() returns the usage it captured: the reaper runs in a process
      // that never created this sandbox, and the vendor data is gone the moment
      // destroy() completes, so this return value is the only chance to bill a
      // crash-recovered run. Both backends must honour it, and the repeat call
      // must stay idempotent without losing the numbers.
      const fromDestroy = await backend.destroy(handle);
      expect(fromDestroy).not.toBeNull();
      expect(fromDestroy?.wallMs).toBeGreaterThan(0);
      await expect(backend.destroy(handle)).resolves.toEqual(fromDestroy);

      const usage = await backend.usage(handle);
      expect(usage.cpuMs).toEqual(expect.any(Number));
      expect(usage.wallMs).toEqual(expect.any(Number));
      expect(usage.memAllocatedMb).toEqual(expect.any(Number));
      expect(Number.isFinite(usage.cpuMs)).toBe(true);
      expect(Number.isFinite(usage.wallMs)).toBe(true);
      expect(usage.cpuMs).toBeGreaterThanOrEqual(0);
      expect(usage.wallMs).toBeGreaterThan(0);
      expect(usage.memAllocatedMb).toBeGreaterThan(0);
      if (usage.peakMemMb !== undefined) expect(usage.peakMemMb).toBeGreaterThan(0);
    },
    candidate.timeoutMs,
  );

  it(
    'refuses further work after destroy',
    async () => {
      await expect(
        backend.exec(handle, ['echo', 'after'], { timeoutMs: 5_000, maxStdoutBytes: 64 }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/not_found|destroy_failed/) });
    },
    candidate.timeoutMs,
  );
});
