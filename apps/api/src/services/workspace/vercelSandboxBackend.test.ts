import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setVercelSdkForTests,
  createVercelSandboxBackend,
  readVercelCredentials,
  resolveVercelImage,
  resolveVercelRegion,
} from './vercelSandboxBackend';
import type { SandboxCreateSpec } from './sandboxBackend';

const SPEC: SandboxCreateSpec = {
  runId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  region: 'eu',
  cpu: 1,
  memoryMb: 2048,
  deadlineSeconds: 90,
  image: 'breeze-analysis@test',
};

class FakeAPIError extends Error {
  constructor(public response: { status: number }) {
    super(`api error ${response.status}`);
  }
}

function makeFakeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    name: 'breeze-eu-abc',
    region: 'fra1',
    persistent: false,
    memory: 2048,
    vcpus: 1,
    activeCpuUsageMs: undefined as number | undefined,
    totalActiveCpuDurationMs: undefined as number | undefined,
    totalDurationMs: undefined as number | undefined,
    runCommand: vi.fn(async (_params?: Record<string, unknown>) => ({ exitCode: 0 as number | null, durationMs: 12 as number | undefined })),
    writeFiles: vi.fn(async (_files?: Array<{ path: string; content: Buffer }>) => undefined),
    readFile: vi.fn(async (_file?: { path: string }, _opts?: { signal: AbortSignal }): Promise<Readable | null> => Readable.from([Buffer.from('hi')])),
    mkDir: vi.fn(async (_path?: string) => undefined),
    fs: {
      mkdir: vi.fn(async (_p?: string, _o?: { recursive: boolean }) => undefined),
      readdir: vi.fn(async (_p?: string, _o?: { withFileTypes: true }): Promise<Array<{ name: string }>> => []),
      lstat: vi.fn(
        async (
          _p?: string,
        ): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean }> => ({
          size: 0,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }),
      ),
    },
    stop: vi.fn(
      async (): Promise<{
        activeCpuDurationMs?: number;
        duration?: number;
        memory?: number;
        vcpus?: number;
      }> => ({ activeCpuDurationMs: 400, duration: 5_000, memory: 2048, vcpus: 1 }),
    ),
    delete: vi.fn(async (_opts?: { deleteOrphanSnapshots: boolean }) => undefined),
    ...overrides,
  };
}

describe('resolveVercelRegion', () => {
  it.each([
    [{}, 'eu', 'fra1'],
    [{}, 'us', 'iad1'],
    [{ VERCEL_SANDBOX_REGION_EU: 'arn1' }, 'eu', 'arn1'],
    [{ VERCEL_SANDBOX_REGION_US: 'sfo1' }, 'us', 'sfo1'],
  ])('%o + %s → %s', (env, region, expected) => {
    expect(resolveVercelRegion(region as 'eu' | 'us', env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('refuses lhr1 for the EU region — the UK is not the EU (spike H.1)', () => {
    expect(() =>
      resolveVercelRegion('eu', { VERCEL_SANDBOX_REGION_EU: 'lhr1' } as NodeJS.ProcessEnv),
    ).toThrowError(/lhr1/);
  });
});

describe('resolveVercelImage', () => {
  it('keeps the universal image for deployments without an override', () => {
    expect(resolveVercelImage({})).toBe('vercel/sandbox/universal');
    expect(resolveVercelImage({ VERCEL_SANDBOX_IMAGE: '' })).toBe('vercel/sandbox/universal');
  });

  it.each(['breeze/analysis:2026-09-16', '@breeze/analysis', `registry.example.com/breeze/analysis@sha256:${'a'.repeat(64)}`])(
    'accepts the configured reference %s unchanged', (image) => {
      expect(resolveVercelImage({ VERCEL_SANDBOX_IMAGE: image })).toBe(image);
    },
  );

  it.each([' ', ' image', 'image ', 'image\nother', 'image\tother'])(
    'rejects malformed explicit configuration %j', (image) => {
      expect(() => resolveVercelImage({ VERCEL_SANDBOX_IMAGE: image }))
        .toThrowError(expect.objectContaining({ code: 'create_failed' }));
    },
  );
});

describe('readVercelCredentials', () => {
  it('requires all three and never falls back to ambient SDK env', () => {
    expect(() =>
      readVercelCredentials({ VERCEL_SANDBOX_TOKEN: 't' } as NodeJS.ProcessEnv),
    ).toThrowError(/VERCEL_TEAM_ID/);
    expect(
      readVercelCredentials({
        VERCEL_SANDBOX_TOKEN: 't',
        VERCEL_TEAM_ID: 'team_x',
        VERCEL_PROJECT_ID: 'prj_x',
      } as NodeJS.ProcessEnv),
    ).toEqual({ token: 't', teamId: 'team_x', projectId: 'prj_x' });
  });
});

describe('vercelSandboxBackend', () => {
  let Sandbox: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let sandbox: ReturnType<typeof makeFakeSandbox>;

  beforeEach(() => {
    vi.stubEnv('VERCEL_SANDBOX_IMAGE', undefined);
    process.env.VERCEL_SANDBOX_TOKEN = 'tok';
    process.env.VERCEL_TEAM_ID = 'team_x';
    process.env.VERCEL_PROJECT_ID = 'prj_x';
    sandbox = makeFakeSandbox();
    Sandbox = { create: vi.fn(async () => sandbox), get: vi.fn(async () => sandbox) };
    __setVercelSdkForTests({ Sandbox, APIError: FakeAPIError });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __setVercelSdkForTests(null);
    delete process.env.VERCEL_SANDBOX_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it('creates deny-all, non-persistent, region-pinned, deadline-bounded, untagged', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);

    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    const params = Sandbox.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.networkPolicy).toBe('deny-all');
    expect(params.persistent).toBe(false);
    expect(params.region).toBe('fra1');
    expect(params.timeout).toBe(90_000);
    expect(params.resources).toEqual({ vcpus: 1 });
    expect(params.image).toBe('vercel/sandbox/universal');
    expect(params.token).toBe('tok');
    expect(params.teamId).toBe('team_x');
    expect(params.projectId).toBe('prj_x');
    // No tenant identifier may reach vendor-side metadata.
    expect(params.tags).toBeUndefined();
    expect(String(params.name)).not.toContain(SPEC.orgId);
    expect(String(params.name)).not.toContain(SPEC.runId);

    expect(handle).toMatchObject({ backend: 'vercel', providerRef: 'breeze-eu-abc', region: 'eu', runtimeImage: 'vercel/sandbox/universal' });
  });

  it('uses the deployment image while preserving the network and persistence restrictions', async () => {
    vi.stubEnv('VERCEL_SANDBOX_IMAGE', 'breeze/analysis:qa');
    const handle = await createVercelSandboxBackend().create(SPEC);
    expect(handle.runtimeImage).toBe('breeze/analysis:qa');
    expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({
      image: 'breeze/analysis:qa', networkPolicy: 'deny-all', persistent: false,
    }));
  });

  it('rejects a malformed image before creating a sandbox', async () => {
    vi.stubEnv('VERCEL_SANDBOX_IMAGE', 'bad image');
    await expect(createVercelSandboxBackend().create(SPEC)).rejects.toMatchObject({ code: 'create_failed' });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it('destroys and fails create when the vendor landed in the wrong region', async () => {
    sandbox = makeFakeSandbox({ region: 'iad1' });
    Sandbox.create.mockResolvedValue(sandbox);
    const backend = createVercelSandboxBackend();
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'create_failed' });
    expect(sandbox.delete).toHaveBeenCalled();
  });

  it('maps 402/429 to quota and 404 to not_found', async () => {
    const backend = createVercelSandboxBackend();
    Sandbox.create.mockRejectedValueOnce(new FakeAPIError({ status: 429 }));
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'quota' });
    Sandbox.create.mockRejectedValueOnce(new FakeAPIError({ status: 404 }));
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('execs an argv with timeoutMs and capped stream sinks — never a shell string', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.exec(handle, ['python3', '/work/step-1.py'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      cwd: '/work',
    });
    const params = sandbox.runCommand.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.cmd).toBe('python3');
    expect(params.args).toEqual(['/work/step-1.py']);
    expect(params.cwd).toBe('/work');
    expect(params.timeoutMs).toBe(5_000);
    expect(params.stdout).toBeDefined();
    expect(params.stderr).toBeDefined();
  });

  it('routes stdinBytes through a constant sh -c redirector with model data only in argv', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.exec(handle, ['python3', '/work/step-1.py'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      stdinBytes: Buffer.from('row1\nrow2\n'),
    });
    // The bytes are staged as a file first…
    const written = sandbox.writeFiles.mock.calls[0]?.[0] as Array<{ path: string }>;
    expect(written[0]?.path).toMatch(/^\/work\/tmp\/stdin-[0-9a-f-]+$/);
    // …then the command runs under ONE compile-time-constant shell program,
    // with every model-derived value as a positional argument.
    const params = sandbox.runCommand.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(params.cmd).toBe('sh');
    expect(params.args[0]).toBe('-c');
    expect(params.args[1]).toBe('exec "$1" "$2" < "$3"');
    expect(params.args.slice(2, 4)).toEqual(['sh', 'python3']);
    expect(params.args[4]).toBe('/work/step-1.py');
    expect(params.args[5]).toMatch(/^\/work\/tmp\/stdin-/);
  });

  it('reports timedOut when the sandbox SIGKILLs the step', async () => {
    sandbox.runCommand.mockResolvedValue({ exitCode: 137, durationMs: 5_010 });
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    const res = await backend.exec(handle, ['sleep', '30'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  it('refuses a path outside /work before any SDK call', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await expect(backend.readFile(handle, '/etc/passwd', 10)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it('accepts an exact-cap stream and reports missing preflight files as not_found', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    sandbox.readFile.mockResolvedValueOnce(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    await expect(backend.readFile(handle, '/work/out/x', 4)).resolves.toEqual(Buffer.from('abcd'));
    sandbox.fs.lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(backend.readFile(handle, '/work/out/missing', 4)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects oversized files before opening a stream', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    sandbox.fs.lstat.mockResolvedValue({ size: 100, isDirectory: () => false, isSymbolicLink: () => false });
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({ code: 'file_too_large' });
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it('aborts a file that grows past its preflight size without buffering the remainder', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    const stream = Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(100)]);
    sandbox.readFile.mockResolvedValueOnce(stream);
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({ code: 'file_too_large' });
    expect(sandbox.readFile.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it('cleans up a provider sandbox when directory bootstrap fails', async () => {
    sandbox.fs.mkdir.mockRejectedValueOnce(new Error('mkdir failed'));
    await expect(createVercelSandboxBackend().create(SPEC)).rejects.toMatchObject({ code: 'create_failed' });
    expect(sandbox.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
  });

  it('preserves the provider handle for the reaper when bootstrap cleanup fails', async () => {
    sandbox.fs.mkdir.mockRejectedValueOnce(new Error('mkdir failed'));
    sandbox.delete.mockRejectedValueOnce(new Error('delete unavailable'));
    await expect(createVercelSandboxBackend().create(SPEC)).rejects.toMatchObject({
      code: 'create_failed', handle: { providerRef: sandbox.name, backend: 'vercel' },
    });
  });

  it('treats a null readFile as not_found and an over-cap read as file_too_large', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    sandbox.readFile.mockResolvedValueOnce(null);
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({
      code: 'not_found',
    });
    sandbox.readFile.mockResolvedValueOnce(Readable.from([Buffer.alloc(100)]));
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('destroys with deleteOrphanSnapshots, is idempotent, and freezes usage from stop()', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await backend.destroy(handle);
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    expect(sandbox.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
    await expect(backend.usage(handle)).resolves.toEqual({
      cpuMs: 400,
      wallMs: 5_000,
      memAllocatedMb: 2048,
    });
  });

  it('falls back to the instance getters when stop() reports no usage', async () => {
    sandbox.stop.mockResolvedValue({});
    sandbox.activeCpuUsageMs = 250;
    sandbox.totalDurationMs = 9_000;
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await expect(backend.usage(handle)).resolves.toEqual({
      cpuMs: 250,
      wallMs: 9_000,
      memAllocatedMb: 2048,
    });
  });

  it('throws usage_unavailable rather than reporting a free run', async () => {
    sandbox.stop.mockResolvedValue({});
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await expect(backend.usage(handle)).rejects.toMatchObject({ code: 'usage_unavailable' });
  });

  it('swallows a 404 during destroy — the sandbox is already gone', async () => {
    sandbox.delete.mockRejectedValue(new FakeAPIError({ status: 404 }));
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    // Still returns the usage captured by stop(): the delete 404 means the row
    // is already gone vendor-side, not that the run was free.
    await expect(backend.destroy(handle)).resolves.toEqual({
      cpuMs: 400,
      wallMs: 5_000,
      memAllocatedMb: 2048,
    });
  });

  // The reaper's whole reason to exist is a worker that DIED, so it always runs
  // in a process with no in-memory box for this sandbox. destroy() ends in a
  // vendor delete() after which the usage is unrecoverable, so if it did not
  // hand the numbers back here, every reaper-recovered run would bill as free
  // and no later job could ever reconstruct it.
  // The lexical fence passes here: "/work/out/escape/hostname" IS under /work.
  // Only the server-side lstat walk can refuse it, and without that walk the
  // production backend would happily follow a link the model's own script
  // planted — which is exactly the state this file was in before review.
  it('refuses a path traversing a symlinked component', async () => {
    sandbox.fs.lstat.mockImplementation(async (p?: string) => ({
      size: 0,
      isDirectory: () => false,
      isSymbolicLink: () => p === '/work/out/escape',
    }));
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);

    await expect(backend.readFile(handle, '/work/out/escape/hostname', 1024)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      backend.writeFiles(handle, [{ path: '/work/out/escape/planted', bytes: Buffer.from('x') }]),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it('returns the usage it captured even with no in-process box (the reaper path)', async () => {
    const backend = createVercelSandboxBackend();
    await expect(
      backend.destroy({
        backend: 'vercel',
        providerRef: 'breeze-eu-orphan',
        region: 'eu',
        createdAt: new Date(),
      }),
    ).resolves.toEqual({ cpuMs: 400, wallMs: 5_000, memAllocatedMb: 2048 });
  });

  it('treats an already-gone sandbox as destroyed instead of paging forever', async () => {
    (Sandbox.get as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new FakeAPIError({ status: 404 }));
    const backend = createVercelSandboxBackend();
    // A previous destroy succeeded but died before recording it. Reporting this
    // as a failure would re-page and retry every 60s forever for a sandbox
    // nobody is paying for.
    await expect(
      backend.destroy({
        backend: 'vercel',
        providerRef: 'breeze-eu-already-gone',
        region: 'eu',
        createdAt: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it('does not report a transient vendor failure as not_found', async () => {
    (Sandbox.get as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new FakeAPIError({ status: 503 }));
    const backend = createVercelSandboxBackend();
    // not_found is what destroy() reads as "already gone". A 503 read that way
    // would abandon a sandbox that is still running and still billing.
    await expect(
      backend.destroy({
        backend: 'vercel',
        providerRef: 'breeze-eu-blip',
        region: 'eu',
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'backend_error' });
  });

  it('surfaces a non-404 destroy failure as destroy_failed so the reaper can page', async () => {
    sandbox.delete.mockRejectedValue(new FakeAPIError({ status: 500 }));
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await expect(backend.destroy(handle)).rejects.toMatchObject({ code: 'destroy_failed' });
  });

  it('reacquires a sandbox by name (resume:false) when the handle is from another process', async () => {
    const backend = createVercelSandboxBackend();
    await backend.destroy({
      backend: 'vercel',
      providerRef: 'breeze-eu-orphan',
      region: 'eu',
      createdAt: new Date(),
    });
    expect(Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'breeze-eu-orphan', resume: false }),
    );
  });
});
