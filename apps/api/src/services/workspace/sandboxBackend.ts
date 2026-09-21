/**
 * Private sandbox adapter for the AI execution plane (spec §5.1).
 *
 * The loop never sees this: WorkspaceService (W03) is the only caller, the model only
 * ever sees workspace_* tool results. Every method is bounded by a caller-supplied cap,
 * every path is confined to /work, and `exec` takes an argv — the model's script is a
 * FILE executed by interpreter path, never a shell string (spec §5.1 rules; the
 * Codex/Docker Sandboxes lesson in the spike §D).
 *
 * Implementations: ./fakeSandboxBackend.ts (tests, in-process) and
 * ./vercelSandboxBackend.ts (v1 production). Later: gvisorPoolBackend, agentCoreBackend.
 */
import path from 'node:path';
import type { AiWorkspaceBackend } from '../../db/schema/aiWorkspace';
import { createFakeSandboxBackend } from './fakeSandboxBackend';
import { createVercelSandboxBackend } from './vercelSandboxBackend';

export type SandboxRegion = 'eu' | 'us';

export type SandboxErrorCode =
  | 'create_failed'
  | 'quota'
  | 'exec_timeout'
  | 'not_found'
  | 'destroy_failed'
  | 'usage_unavailable'
  // Caller-cap and path-confinement refusals. Kept separate from `quota` (a VENDOR
  // limit) so W03 can map them to distinct typed tool errors (spec §8 "each cap
  // failure is a typed tool error the model can read, and a counter").
  | 'file_too_large'
  | 'invalid_path'
  // An unclassified vendor-side failure: a network blip, a 5xx, an expired
  // token. Deliberately NOT `not_found`, which callers read as "the path or
  // sandbox genuinely does not exist" — a transient outage reported as
  // not_found tells W03's tool layer (and the model, and anyone reading the
  // run transcript) that a directory is missing when it is merely unreachable.
  | 'backend_error';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly backend: AiWorkspaceBackend | null;

  constructor(
    code: SandboxErrorCode,
    message: string,
    opts: { backend?: AiWorkspaceBackend | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SandboxError';
    this.code = code;
    this.backend = opts.backend ?? null;
  }
}

export function isSandboxError(err: unknown, code?: SandboxErrorCode): err is SandboxError {
  return err instanceof SandboxError && (code === undefined || err.code === code);
}

export interface SandboxCreateSpec {
  runId: string;
  orgId: string;
  region: SandboxRegion;
  /** v1 fixed shape (spec §5.1). */
  cpu: 1;
  memoryMb: 2048;
  /** Provider-side hard stop, seconds. */
  deadlineSeconds: number;
  /** Legacy bootstrap request; deployment configuration selects the Vercel image. */
  image: string;
}

export interface SandboxHandle {
  backend: AiWorkspaceBackend;
  /** Vendor id of the sandbox — what the reaper needs to destroy it without this process. */
  providerRef: string;
  region: SandboxRegion;
  createdAt: Date;
  /** Exact deployment-selected image reference; a tag is not a resolved digest. */
  runtimeImage?: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  stdinBytes?: Buffer;
  maxStdoutBytes: number;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface FileStat {
  path: string;
  bytes: number;
  isDir: boolean;
  isSymlink?: boolean;
}

export interface SandboxUsage {
  cpuMs: number;
  wallMs: number;
  memAllocatedMb: number;
  peakMemMb?: number;
}

export interface WriteFilesOptions {
  maxTotalBytes?: number;
}

export interface SandboxBackend {
  readonly name: AiWorkspaceBackend;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  writeFiles(h: SandboxHandle, files: Array<{ path: string; bytes: Buffer }>, opts?: WriteFilesOptions): Promise<void>;
  readFile(h: SandboxHandle, path: string, maxBytes: number): Promise<Buffer>;
  listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]>;
  /** Idempotent; must also purge any snapshot. Called from a `finally` and from the reaper. */
  /**
   * Destroys the sandbox and RETURNS the usage captured on the way down, or
   * null when the provider reported none.
   *
   * The return value is load-bearing for billing, not a convenience. The reaper
   * runs in a DIFFERENT PROCESS from the worker that created the sandbox, so it
   * has no in-memory box to read `usage()` from — and `destroy()` ends with a
   * vendor `delete()`, after which the usage is unrecoverable for good. A
   * `destroy()` that returned void would therefore make every reaper-recovered
   * run bill as free, silently and permanently (a worker OOM-killed at minute
   * 55 of an hour-long sandbox would cost the org nothing).
   */
  destroy(h: SandboxHandle): Promise<SandboxUsage | null>;
  /** Read after destroy. Throws `usage_unavailable` when the provider reported nothing. */
  usage(h: SandboxHandle): Promise<SandboxUsage>;
}

export const SANDBOX_ROOT = '/work';
export const SANDBOX_WORK_DIRS = ['/work/in', '/work/out', '/work/tmp'] as const;

/**
 * Normalise a sandbox path and refuse anything that escapes /work. Relative paths
 * resolve against `cwd` (default /work). Symlink escapes are checked by the backends
 * with lstat at access time — this is the static half of the fence.
 */
export function assertSandboxPath(p: string, cwd: string = SANDBOX_ROOT): string {
  const abs = path.posix.isAbsolute(p) ? p : path.posix.join(cwd, p);
  const normalized = path.posix.normalize(abs);
  if (normalized !== SANDBOX_ROOT && !normalized.startsWith(`${SANDBOX_ROOT}/`)) {
    throw new SandboxError('invalid_path', `path "${p}" is outside ${SANDBOX_ROOT}`);
  }
  return normalized;
}

/** Byte-capped accumulator shared by the fake and Vercel exec paths. */
export function createCappedCollector(cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    get size() {
      return size;
    },
    push(chunk: Buffer): void {
      if (size >= cap) {
        truncated = true;
        return;
      }
      const room = cap - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = cap;
        truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    },
    buffer(): Buffer {
      return Buffer.concat(chunks);
    },
  };
}

const SHIPPED_BACKENDS = new Set<string>(['vercel', 'fake']);

export function resolveSandboxBackendName(env: NodeJS.ProcessEnv = process.env): 'vercel' | 'fake' {
  const raw = (env.AI_WORKSPACE_BACKEND ?? '').trim().toLowerCase();
  if (raw === '') {
    // Outside production the fake is the sensible default (unit tests, local dev).
    // In production an unset backend must refuse rather than pick one (spec §5.6:
    // "Unknown backend → refuse to create, never $0"); validate.ts also enforces this at boot.
    if (env.NODE_ENV === 'production') {
      throw new SandboxError('create_failed', 'AI_WORKSPACE_BACKEND is not set');
    }
    return 'fake';
  }
  if (!SHIPPED_BACKENDS.has(raw)) {
    throw new SandboxError('create_failed', `Unsupported AI_WORKSPACE_BACKEND "${raw}" (expected vercel|fake)`);
  }
  return raw as 'vercel' | 'fake';
}

// One instance per backend per process: the fake keeps its sandboxes in memory, so the
// reaper and WorkspaceService must share it; the Vercel adapter caches live SDK handles
// and the stop() usage it read, which usage() relies on.
const singletons = new Map<AiWorkspaceBackend, SandboxBackend>();

export function getSandboxBackendByName(name: AiWorkspaceBackend): SandboxBackend {
  const existing = singletons.get(name);
  if (existing) return existing;
  let backend: SandboxBackend;
  switch (name) {
    case 'fake':
      backend = createFakeSandboxBackend();
      break;
    case 'vercel':
      backend = createVercelSandboxBackend();
      break;
    default:
      throw new SandboxError('create_failed', `No SandboxBackend implementation for "${name}"`, { backend: name });
  }
  singletons.set(name, backend);
  return backend;
}

export function getSandboxBackend(): SandboxBackend {
  return getSandboxBackendByName(resolveSandboxBackendName());
}

export function __resetSandboxBackendsForTests(): void {
  singletons.clear();
}
