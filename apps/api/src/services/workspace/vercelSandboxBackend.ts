/**
 * Vercel Sandbox implementation of SandboxBackend (spec §5.1, v1).
 *
 * PINNED SDK SURFACE — @vercel/sandbox 3.3.0, read from the shipped dist/*.d.ts
 * on 2026-09-13 and cross-checked against
 *   https://vercel.com/docs/sandbox/sdk-reference
 *   https://vercel.com/docs/sandbox/concepts/firewall
 * Re-checked 2026-09-16 against 3.3.0 — still current, no SDK bump since.
 * The plan doc (docs/superpowers/plans/ai-mcp/2026-09-13-execution-plane-w02-
 * sandbox-adapter.md) carries the full table; the load-bearing names are:
 *
 *   create   Sandbox.create({ name, region, networkPolicy: 'deny-all',
 *                             persistent: false, timeout: <ms>,
 *                             resources: { vcpus }, image,
 *                             token, teamId, projectId })
 *   run      sandbox.runCommand({ cmd, args, cwd, timeoutMs, stdout, stderr })
 *            -> CommandFinished { exitCode: number; durationMs?: number }
 *            NO stdin field exists — see execWithStdin below.
 *   files    sandbox.writeFiles([{ path, content, mode? }])   (no mkdir -p)
 *            sandbox.fs.mkdir(path, { recursive: true })
 *            sandbox.readFile({ path }, { signal }) -> Promise<Readable | null>
 *              (Node's Readable, not a web ReadableStream — see the `AnySandbox`
 *              type below, which is what's actually declared and used)
 *            sandbox.fs.readdir(path, { withFileTypes: true }) / fs.lstat
 *              (fs.lstat is the PRE-TRANSFER size gate: this backend's
 *              `readFile()` stats a file before calling sandbox.readFile on
 *              it, so a file exceeding the caller's byte cap is rejected
 *              without ever pulling its bytes into the API process)
 *   stop     sandbox.stop() -> { activeCpuDurationMs?, duration?, memory?, vcpus? }
 *            getters (populated only after stop): sandbox.activeCpuUsageMs,
 *            sandbox.totalActiveCpuDurationMs, sandbox.totalDurationMs
 *   destroy  sandbox.delete({ deleteOrphanSnapshots: true })
 *   reacquire Sandbox.get({ name, resume: false, ...credentials })
 *   errors   APIError { response: Response }  (402/429 -> quota, 404 -> not_found)
 *
 * SECURITY INVARIANTS, each of which a test asserts:
 *  - networkPolicy 'deny-all' blocks ALL egress INCLUDING DNS (firewall docs).
 *    v1 never uses an allowlist policy; the nightly suite proves egress is dead.
 *  - persistent: false is passed EXPLICITLY (the .d.ts states no default), and
 *    destroy passes deleteOrphanSnapshots so no filesystem image outlives a run.
 *  - `cmd` is always an interpreter and `args` always file paths. The ONE shell
 *    invocation in this file is a compile-time-constant program string used to
 *    redirect stdin, with every model-derived value passed positionally.
 *  - The sandbox `name` and `tags` are vendor-side metadata whose retention we
 *    do not control, so neither may carry an org id, a run id, or any other
 *    tenant identifier — the same rule as the artifact blob keys. `name` is
 *    `breeze-<region>-<uuid>`; `tags` is not sent at all.
 *  - No env is passed to create or to any command: the sandbox holds no
 *    credentials (spec §8).
 */
import { randomUUID } from 'node:crypto';
import { Writable, type Readable } from 'node:stream';

import * as vercelSdk from '@vercel/sandbox';

import {
  SANDBOX_ROOT,
  SandboxError,
  assertSandboxPath,
  createCappedCollector,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type SandboxBackend,
  type SandboxCreateSpec,
  type SandboxHandle,
  type SandboxRegion,
  type SandboxUsage,
  type WriteFilesOptions,
} from './sandboxBackend';

export const VERCEL_SANDBOX_IMAGE = 'vercel/sandbox/universal';
export const VERCEL_DEFAULT_REGION_EU = 'fra1';
export const VERCEL_DEFAULT_REGION_US = 'iad1';

/** Deployment-owned image; never accept a model-supplied image reference. */
export function resolveVercelImage(env: NodeJS.ProcessEnv = process.env): string {
  const image = env.VERCEL_SANDBOX_IMAGE || VERCEL_SANDBOX_IMAGE;
  if (!image || /\s/.test(image)) {
    throw new SandboxError('create_failed', 'VERCEL_SANDBOX_IMAGE must be a nonempty image reference without whitespace', {
      backend: 'vercel',
    });
  }
  return image;
}

/**
 * Regions that must NEVER serve a Breeze "eu" workspace. `lhr1` is London:
 * post-Brexit the UK is a third country for GDPR transfer purposes, so a
 * customer told "your analysis runs in the EU" would be told something false
 * (spike §H.1). Refuse loudly at config-read time rather than silently.
 */
const NON_EU_REGIONS = new Set(['lhr1', 'iad1', 'sfo1', 'cle1', 'pdx1', 'yul1', 'gru1',
  'sin1', 'hkg1', 'syd1', 'hnd1', 'kix1', 'icn1', 'bom1', 'cpt1']);

type SdkShape = { Sandbox: unknown; APIError: unknown };
let sdkOverride: SdkShape | null = null;

/** Test seam: the real SDK opens sockets; unit tests inject a double. */
export function __setVercelSdkForTests(sdk: SdkShape | null): void {
  sdkOverride = sdk;
}

function sdk(): SdkShape {
  return sdkOverride ?? (vercelSdk as unknown as SdkShape);
}

export function resolveVercelRegion(
  region: SandboxRegion,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (
    region === 'eu' ? env.VERCEL_SANDBOX_REGION_EU : env.VERCEL_SANDBOX_REGION_US
  )?.trim();
  const resolved = configured || (region === 'eu' ? VERCEL_DEFAULT_REGION_EU : VERCEL_DEFAULT_REGION_US);
  if (region === 'eu' && NON_EU_REGIONS.has(resolved)) {
    throw new SandboxError(
      'create_failed',
      `VERCEL_SANDBOX_REGION_EU="${resolved}" is not an EU region — an "eu" workspace must run in the EU (fra1, arn1, cdg1, dub1). lhr1 is the UK.`,
      { backend: 'vercel' },
    );
  }
  return resolved;
}

export function readVercelCredentials(env: NodeJS.ProcessEnv = process.env): {
  token: string;
  teamId: string;
  projectId: string;
} {
  const token = env.VERCEL_SANDBOX_TOKEN?.trim() ?? '';
  const teamId = env.VERCEL_TEAM_ID?.trim() ?? '';
  const projectId = env.VERCEL_PROJECT_ID?.trim() ?? '';
  const missing = [
    token ? null : 'VERCEL_SANDBOX_TOKEN',
    teamId ? null : 'VERCEL_TEAM_ID',
    projectId ? null : 'VERCEL_PROJECT_ID',
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    // Never fall through to the SDK's ambient-env credential discovery: a
    // half-configured deploy would then silently use whatever token the host
    // happened to carry, against whatever project that token can reach.
    throw new SandboxError('create_failed', `Missing Vercel sandbox config: ${missing.join(', ')}`, {
      backend: 'vercel',
    });
  }
  return { token, teamId, projectId };
}

function statusOf(err: unknown): number | null {
  const APIErrorCtor = sdk().APIError as (new (...args: never[]) => Error) | undefined;
  if (APIErrorCtor && err instanceof APIErrorCtor) {
    const status = (err as unknown as { response?: { status?: number } }).response?.status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function mapError(
  err: unknown,
  fallback: 'create_failed' | 'destroy_failed' | 'not_found' | 'backend_error',
): SandboxError {
  if (err instanceof SandboxError) return err;
  const status = statusOf(err);
  if (status === 402 || status === 429) {
    return new SandboxError('quota', 'Vercel sandbox quota exhausted', { backend: 'vercel', cause: err });
  }
  if (status === 404) {
    return new SandboxError('not_found', 'Vercel sandbox not found', { backend: 'vercel', cause: err });
  }
  return new SandboxError(fallback, `Vercel sandbox ${fallback}: ${String(err)}`, {
    backend: 'vercel',
    cause: err,
  });
}

function cappedSink(cap: number) {
  const collector = createCappedCollector(cap);
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      collector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  return { collector, stream };
}

interface LiveBox {
  sandbox: Record<string, unknown>;
  memAllocatedMb: number;
  usage: SandboxUsage | null;
  usageUnavailable: boolean;
  destroyed: boolean;
}

/** Carries a created provider resource when bootstrap cleanup needs the reaper. */
export class VercelSandboxCreateError extends Error {
  readonly code = 'create_failed' as const;
  readonly backend = 'vercel' as const;

  constructor(readonly handle: SandboxHandle, cause: unknown) {
    super('Sandbox bootstrap failed and cleanup must be retried', { cause });
    this.name = 'VercelSandboxCreateError';
  }
}

export function createVercelSandboxBackend(): SandboxBackend {
  const boxes = new Map<string, LiveBox>();

  type AnySandbox = {
    name: string;
    region: string;
    memory?: number;
    activeCpuUsageMs?: number;
    totalActiveCpuDurationMs?: number;
    totalDurationMs?: number;
    runCommand(params: Record<string, unknown>): Promise<{ exitCode: number | null; durationMs?: number }>;
    writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
    readFile(file: { path: string }, opts: { signal: AbortSignal }): Promise<Readable | null>;
    fs: {
      mkdir(p: string, o: { recursive: boolean }): Promise<unknown>;
      readdir(p: string, o: { withFileTypes: true }): Promise<Array<{ name: string }>>;
      lstat(p: string): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    };
    stop(): Promise<Record<string, unknown>>;
    delete(opts: { deleteOrphanSnapshots: boolean }): Promise<void>;
  };

  /**
   * Get the SDK object for a handle. A handle created in THIS process is in
   * `boxes`; a handle the reaper loaded from `ai_run_workspaces` (written by a
   * worker that has since died) is not, so it is reacquired by name with
   * `resume: false` — the reaper wants to delete the sandbox, never to wake it.
   */
  async function acquire(h: SandboxHandle): Promise<AnySandbox> {
    const known = boxes.get(h.providerRef);
    if (known) return known.sandbox as unknown as AnySandbox;
    const SandboxCtor = sdk().Sandbox as {
      get(p: Record<string, unknown>): Promise<AnySandbox>;
    };
    try {
      return await SandboxCtor.get({ name: h.providerRef, resume: false, ...readVercelCredentials() });
    } catch (err) {
      // mapError still turns a real 404 into not_found. The FALLBACK is
      // backend_error so a network blip or a 5xx is not reported as "this
      // sandbox does not exist" — destroy() branches on not_found to decide the
      // sandbox is already gone, and a transient error read that way would
      // abandon a sandbox that is still running and still billing.
      throw mapError(err, 'backend_error');
    }
  }

  /**
   * Server-side half of the path fence. `assertSandboxPath` is purely lexical:
   * it proves the STRING is under /work, which a symlink planted by the model's
   * own script trivially satisfies while pointing somewhere else entirely. The
   * fake backend closes this with realpath and its own comment calls that
   * load-bearing; the pinned SDK surface exposes no realpath, so this refuses a
   * symlinked component outright instead.
   *
   * Refusing rather than resolving is the right trade here: an analysis
   * workspace has no legitimate use for a symlink, so "no symlinks under /work"
   * is both simpler than "symlinks that resolve inside /work" and immune to a
   * TOCTOU swap between the resolve and the read.
   *
   * A component that does not exist yet is fine (writeFiles creates it); only a
   * component that EXISTS and IS a symlink is refused.
   */
  async function assertNoSymlinkComponents(sandbox: AnySandbox, normalized: string): Promise<void> {
    const parts = normalized.slice(SANDBOX_ROOT.length).split('/').filter(Boolean);
    let probe = SANDBOX_ROOT;
    for (const part of parts) {
      probe = `${probe}/${part}`;
      let stat: { isSymbolicLink(): boolean };
      try {
        stat = await sandbox.fs.lstat(probe);
      } catch {
        // Does not exist yet, so nothing here can point anywhere — and every
        // deeper component is necessarily absent too. Stop walking.
        return;
      }
      if (stat.isSymbolicLink()) {
        throw new SandboxError(
          'invalid_path',
          `path "${normalized}" traverses a symlink at ${probe}; symlinks are refused inside /work`,
          { backend: 'vercel' },
        );
      }
    }
  }

  return {
    name: 'vercel',

    async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
      const region = resolveVercelRegion(spec.region);
      const credentials = readVercelCredentials();
      const image = resolveVercelImage();
      const SandboxCtor = sdk().Sandbox as { create(p: Record<string, unknown>): Promise<AnySandbox> };
      let sandbox: AnySandbox;
      try {
        sandbox = await SandboxCtor.create({
          // Opaque: no org id, no run id. See the header's naming invariant.
          name: `breeze-${spec.region}-${randomUUID()}`,
          region,
          networkPolicy: 'deny-all',
          persistent: false,
          timeout: spec.deadlineSeconds * 1000,
          resources: { vcpus: spec.cpu },
          image,
          ...credentials,
        });
      } catch (err) {
        throw mapError(err, 'create_failed');
      }

      const handle: SandboxHandle = {
        backend: 'vercel', providerRef: sandbox.name, region: spec.region, createdAt: new Date(), runtimeImage: image,
      };
      try {
        if (sandbox.region !== region) {
          throw new SandboxError('create_failed',
            `Vercel placed the sandbox in "${sandbox.region}" but "${region}" was requested`,
            { backend: 'vercel' });
        }
        await sandbox.fs.mkdir(`${SANDBOX_ROOT}/in`, { recursive: true });
        await sandbox.fs.mkdir(`${SANDBOX_ROOT}/out`, { recursive: true });
        await sandbox.fs.mkdir(`${SANDBOX_ROOT}/tmp`, { recursive: true });
      } catch (error) {
        try {
          await sandbox.delete({ deleteOrphanSnapshots: true });
        } catch (cleanupError) {
          // Preserve the resource identity so the service can persist it for cleanup.
          throw new VercelSandboxCreateError(handle, new AggregateError([error, cleanupError]));
        }
        throw mapError(error, 'create_failed');
      }

      boxes.set(sandbox.name, {
        sandbox: sandbox as unknown as Record<string, unknown>,
        memAllocatedMb: sandbox.memory ?? spec.memoryMb,
        usage: null,
        usageUnavailable: false,
        destroyed: false,
      });

      return handle;
    },

    async exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
      if (cmd.length === 0) {
        throw new SandboxError('create_failed', 'exec requires a non-empty argv', { backend: 'vercel' });
      }
      const sandbox = await acquire(h);
      const cwd = opts.cwd ? assertSandboxPath(opts.cwd) : SANDBOX_ROOT;
      if (opts.cwd) await assertNoSymlinkComponents(sandbox, cwd);
      const stdout = cappedSink(opts.maxStdoutBytes);
      const stderr = cappedSink(opts.maxStdoutBytes);

      // RunCommandParams has no stdin field (pinned surface). Stage the bytes as
      // a file and redirect. The shell PROGRAM is a compile-time constant; every
      // model-derived value (interpreter, script path, stdin path) is a
      // positional argument, so nothing the model wrote is ever parsed as shell
      // syntax. `exec` replaces the shell so no extra process lingers.
      let params: Record<string, unknown>;
      if (opts.stdinBytes) {
        const stdinPath = `${SANDBOX_ROOT}/tmp/stdin-${randomUUID()}`;
        try {
          await sandbox.writeFiles([{ path: stdinPath, content: opts.stdinBytes }]);
        } catch (err) {
          throw mapError(err, 'create_failed');
        }
        if (cmd.length !== 2) {
          throw new SandboxError(
            'create_failed',
            'stdin redirection supports exactly [interpreter, scriptPath]',
            { backend: 'vercel' },
          );
        }
        params = {
          cmd: 'sh',
          args: ['-c', 'exec "$1" "$2" < "$3"', 'sh', cmd[0], cmd[1], stdinPath],
          cwd,
          timeoutMs: opts.timeoutMs,
          stdout: stdout.stream,
          stderr: stderr.stream,
        };
      } else {
        params = {
          cmd: cmd[0],
          args: cmd.slice(1),
          cwd,
          timeoutMs: opts.timeoutMs,
          stdout: stdout.stream,
          stderr: stderr.stream,
        };
      }

      const startedAt = Date.now();
      let finished: { exitCode: number | null; durationMs?: number };
      try {
        finished = await sandbox.runCommand(params);
      } catch (err) {
        throw mapError(err, 'create_failed');
      }
      const durationMs = finished.durationMs ?? Date.now() - startedAt;
      // The sandbox enforces timeoutMs with SIGKILL, which surfaces as 137
      // (128 + SIGKILL). Corroborate with elapsed time so an ordinary `exit 137`
      // is not mislabelled as a timeout.
      const timedOut = finished.exitCode === 137 && durationMs >= opts.timeoutMs;

      return {
        exitCode: timedOut ? null : finished.exitCode,
        timedOut,
        stdout: stdout.collector.buffer(),
        stderr: stderr.collector.buffer(),
        durationMs,
        stdoutTruncated: stdout.collector.truncated,
        stderrTruncated: stderr.collector.truncated,
      };
    },

    async writeFiles(
      h: SandboxHandle,
      files: Array<{ path: string; bytes: Buffer }>,
      opts?: WriteFilesOptions,
    ): Promise<void> {
      const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
      if (opts?.maxTotalBytes !== undefined && total > opts.maxTotalBytes) {
        throw new SandboxError(
          'file_too_large',
          `writeFiles batch is ${total} bytes, over the ${opts.maxTotalBytes}-byte cap`,
          { backend: 'vercel' },
        );
      }
      const normalized = files.map((f) => ({ path: assertSandboxPath(f.path), content: f.bytes }));
      const sandbox = await acquire(h);
      // Checked before ANY write: a symlinked parent would otherwise let a
      // write land outside /work entirely.
      for (const f of normalized) await assertNoSymlinkComponents(sandbox, f.path);
      // writeFiles does not create parents (pinned surface).
      const dirs = new Set(normalized.map((f) => f.path.slice(0, f.path.lastIndexOf('/')) || SANDBOX_ROOT));
      try {
        for (const dir of dirs) await sandbox.fs.mkdir(dir, { recursive: true });
        await sandbox.writeFiles(normalized);
      } catch (err) {
        throw mapError(err, 'create_failed');
      }
    },

    async readFile(h: SandboxHandle, filePath: string, maxBytes: number): Promise<Buffer> {
      const normalized = assertSandboxPath(filePath);
      const sandbox = await acquire(h);
      await assertNoSymlinkComponents(sandbox, normalized);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new SandboxError('file_too_large', 'Invalid file byte cap', { backend: 'vercel' });
      }
      const abort = new AbortController();
      let stream: Readable | null = null;
      try {
        const stat = await sandbox.fs.lstat(normalized);
        if (stat.size > maxBytes) {
          throw new SandboxError('file_too_large', `${filePath} exceeds the ${maxBytes}-byte cap`, { backend: 'vercel' });
        }
        stream = await sandbox.readFile({ path: normalized }, { signal: abort.signal });
        if (!stream) throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'vercel' });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBytes) {
            abort.abort();
            throw new SandboxError('file_too_large', `${filePath} exceeds the ${maxBytes}-byte cap`, { backend: 'vercel' });
          }
          chunks.push(bytes);
        }
        return Buffer.concat(chunks, size);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'vercel', cause: err });
        }
        throw mapError(err, 'backend_error');
      } finally {
        stream?.destroy();
      }
    },

    async listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]> {
      const normalized = assertSandboxPath(dir);
      const sandbox = await acquire(h);
      try {
        const entries = await sandbox.fs.readdir(normalized, { withFileTypes: true });
        const out: FileStat[] = [];
        for (const entry of entries) {
          const childPath = `${normalized === SANDBOX_ROOT ? '' : normalized}/${entry.name}`.replace('//', '/');
          const stat = await sandbox.fs.lstat(childPath);
          out.push({
            path: childPath,
            bytes: stat.size,
            isDir: stat.isDirectory(),
            isSymlink: stat.isSymbolicLink(),
          });
        }
        return out;
      } catch (err) {
        throw mapError(err, 'backend_error');
      }
    },

    async destroy(h: SandboxHandle): Promise<SandboxUsage | null> {
      const known = boxes.get(h.providerRef);
      if (known?.destroyed) return known.usage; // idempotent
      let sandbox: AnySandbox;
      try {
        sandbox = await acquire(h);
      } catch (err) {
        // The sandbox is already gone vendor-side: a previous destroy succeeded
        // but died before it could record that, or the provider expired and
        // collected it. That is SUCCESS, exactly as the delete() 404 below is.
        // Reporting it as a failure would make the reaper re-mark the row
        // destroy_failed, re-page, and retry every 60 seconds forever for a
        // sandbox nobody is paying for — which is how an alert that matters
        // gets trained into noise.
        if (err instanceof SandboxError && err.code === 'not_found') {
          if (known) known.destroyed = true;
          return known?.usage ?? null;
        }
        throw err;
      }

      // stop() is where usage comes from; it must run BEFORE delete(), after
      // which "the instance becomes inert — all further API calls will throw".
      let stopped: Record<string, unknown> = {};
      try {
        stopped = (await sandbox.stop()) ?? {};
      } catch (err) {
        // A sandbox already stopped by its own deadline throws here. That is
        // the "provider deadline fires" row of spec §9: not an error, but the
        // usage is gone, so mark it and fall through to the delete.
        if (statusOf(err) !== 404) {
          if (known) known.usageUnavailable = true;
        }
      }

      const cpuMs = numberOr(stopped.activeCpuDurationMs, sandbox.activeCpuUsageMs, sandbox.totalActiveCpuDurationMs);
      const wallMs = numberOr(stopped.duration, sandbox.totalDurationMs);
      const memAllocatedMb = numberOr(stopped.memory, sandbox.memory) ?? known?.memAllocatedMb ?? 2048;

      // Computed BEFORE delete(), which makes the instance inert and the numbers
      // unrecoverable. Returned as well as cached: the reaper has no cached box
      // to read (different process), and this is its only chance to bill.
      const captured: SandboxUsage | null =
        cpuMs === null || wallMs === null ? null : { cpuMs, wallMs, memAllocatedMb };
      if (known) {
        if (captured === null) known.usageUnavailable = true;
        else known.usage = captured;
      }

      try {
        await sandbox.delete({ deleteOrphanSnapshots: true });
      } catch (err) {
        // Already gone is success — destroy is idempotent by contract, and the
        // reaper calls it on rows whose sandbox may have expired hours ago.
        if (statusOf(err) !== 404) {
          throw mapError(err, 'destroy_failed');
        }
      }
      if (known) known.destroyed = true;
      return captured;
    },

    async usage(h: SandboxHandle): Promise<SandboxUsage> {
      const known = boxes.get(h.providerRef);
      if (known?.usage) return known.usage;
      // Never invent a number and never return zeros: spec §9 settles an
      // unavailable-usage run at the RESERVATION, which requires the caller to
      // learn that usage is missing rather than be handed a free run.
      throw new SandboxError(
        'usage_unavailable',
        `no usage recorded for ${h.providerRef} (was destroy() called?)`,
        { backend: 'vercel' },
      );
    },
  };
}

function numberOr(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}
