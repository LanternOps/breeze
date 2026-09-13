/**
 * Vercel Sandbox implementation of SandboxBackend (spec §5.1, v1).
 *
 * PINNED SDK SURFACE — @vercel/sandbox 3.3.0, read from the shipped dist/*.d.ts
 * on 2026-09-13 and cross-checked against
 *   https://vercel.com/docs/sandbox/sdk-reference
 *   https://vercel.com/docs/sandbox/concepts/firewall
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
 *            sandbox.readFileToBuffer({ path }) -> Buffer | null  (null = absent)
 *            sandbox.fs.readdir(path, { withFileTypes: true }) / fs.lstat
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
import { Writable } from 'node:stream';

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

function mapError(err: unknown, fallback: 'create_failed' | 'destroy_failed' | 'not_found'): SandboxError {
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
    readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
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
      throw mapError(err, 'not_found');
    }
  }

  return {
    name: 'vercel',

    async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
      const region = resolveVercelRegion(spec.region);
      const credentials = readVercelCredentials();
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
          image: VERCEL_SANDBOX_IMAGE,
          ...credentials,
        });
      } catch (err) {
        throw mapError(err, 'create_failed');
      }

      // Residency assertion (spec §8). A sandbox that landed elsewhere is not
      // usable for a customer we told "your analysis runs in <region>", so it
      // is destroyed rather than used. Best-effort delete: the create already
      // failed, and a failed cleanup must not mask that.
      if (sandbox.region !== region) {
        try {
          await sandbox.delete({ deleteOrphanSnapshots: true });
        } catch {
          /* reported by the region error below; the reaper has no row to find. */
        }
        throw new SandboxError(
          'create_failed',
          `Vercel placed the sandbox in "${sandbox.region}" but "${region}" was requested`,
          { backend: 'vercel' },
        );
      }

      boxes.set(sandbox.name, {
        sandbox: sandbox as unknown as Record<string, unknown>,
        memAllocatedMb: sandbox.memory ?? spec.memoryMb,
        usage: null,
        usageUnavailable: false,
        destroyed: false,
      });

      // /work is not part of the managed image; create it up front so every
      // later path assertion describes something that exists.
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/in`, { recursive: true });
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/out`, { recursive: true });
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/tmp`, { recursive: true });

      return {
        backend: 'vercel',
        providerRef: sandbox.name,
        region: spec.region,
        createdAt: new Date(),
      };
    },

    async exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
      if (cmd.length === 0) {
        throw new SandboxError('create_failed', 'exec requires a non-empty argv', { backend: 'vercel' });
      }
      const sandbox = await acquire(h);
      const cwd = opts.cwd ? assertSandboxPath(opts.cwd) : SANDBOX_ROOT;
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
      let buffer: Buffer | null;
      try {
        buffer = await sandbox.readFileToBuffer({ path: normalized });
      } catch (err) {
        throw mapError(err, 'not_found');
      }
      if (buffer === null) {
        throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'vercel' });
      }
      // The SDK has no server-side byte cap, so this is enforced AFTER transfer.
      // W03 must therefore lstat and refuse before calling readFile for anything
      // it expects to be large — this check is the backstop, not the budget.
      if (buffer.length > maxBytes) {
        throw new SandboxError(
          'file_too_large',
          `${filePath} is ${buffer.length} bytes, over the ${maxBytes}-byte cap`,
          { backend: 'vercel' },
        );
      }
      return buffer;
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
        throw mapError(err, 'not_found');
      }
    },

    async destroy(h: SandboxHandle): Promise<void> {
      const known = boxes.get(h.providerRef);
      if (known?.destroyed) return; // idempotent
      const sandbox = await acquire(h);

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

      if (known) {
        if (cpuMs === null || wallMs === null) {
          known.usageUnavailable = true;
        } else {
          known.usage = { cpuMs, wallMs, memAllocatedMb };
        }
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
