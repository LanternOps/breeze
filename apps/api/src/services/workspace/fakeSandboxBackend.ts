/**
 * In-process SandboxBackend used by every unit test and by local development
 * (`AI_WORKSPACE_BACKEND=fake`, the default outside production).
 *
 * It is a REAL implementation of the contract, not a mock: one OS temp
 * directory per handle, a real `child_process.spawn` per step, and the same
 * caps and path fence the Vercel adapter enforces. `sandboxBackend.contract.
 * test.ts` runs the identical suite against this and against Vercel, so a cap
 * that is only honoured by one of them is a test failure, not a surprise in
 * production.
 *
 * What it is NOT: an isolation boundary. It runs as the API process, with the
 * API process's filesystem and network. Nothing may point `AI_WORKSPACE_BACKEND`
 * at `fake` in production — `resolveSandboxBackendName` refuses an unset value
 * there and `config/validate.ts` (Task 10) refuses `fake` with the workspace
 * flag on.
 *
 * `usage()` is a whole-PROCESS measurement (`process.resourceUsage()` deltas),
 * so under a parallel suite it over-reports CPU. That is deliberate: for a
 * billing input, over-reporting in a test backend is the safe direction, and
 * nothing bills a `fake` run (COMPUTE_PRICING.fake is all zeros, Task 9).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  type SandboxUsage,
  type WriteFilesOptions,
} from './sandboxBackend';

export interface FakeSandboxCall {
  method: 'create' | 'exec' | 'writeFiles' | 'readFile' | 'listFiles' | 'destroy' | 'usage';
  providerRef: string;
  detail: string[];
  at: Date;
}

export interface FakeSandboxBackend extends SandboxBackend {
  readonly name: 'fake';
  readonly calls: readonly FakeSandboxCall[];
  hostRootFor(h: SandboxHandle): string;
  liveCount(): number;
  reset(): Promise<void>;
}

interface FakeBox {
  root: string;
  region: 'eu' | 'us';
  memAllocatedMb: number;
  startedHrNs: bigint;
  startedCpuUs: number;
  destroyed: boolean;
  frozenUsage: SandboxUsage | null;
}

/** Fixed child environment. NEVER `process.env` — see the file header. */
function childEnv(tmpDir: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: SANDBOX_ROOT,
    LANG: 'C.UTF-8',
    TMPDIR: tmpDir,
  };
}

function processCpuMicros(): number {
  const usage = process.resourceUsage();
  return usage.userCPUTime + usage.systemCPUTime;
}

export function createFakeSandboxBackend(): FakeSandboxBackend {
  const boxes = new Map<string, FakeBox>();
  const calls: FakeSandboxCall[] = [];

  function record(method: FakeSandboxCall['method'], providerRef: string, detail: string[]): void {
    calls.push({ method, providerRef, detail, at: new Date() });
  }

  function boxOf(h: SandboxHandle): FakeBox {
    const box = boxes.get(h.providerRef);
    if (!box) {
      throw new SandboxError('not_found', `no fake sandbox ${h.providerRef}`, { backend: 'fake' });
    }
    return box;
  }

  function liveBoxOf(h: SandboxHandle): FakeBox {
    const box = boxOf(h);
    if (box.destroyed) {
      throw new SandboxError('not_found', `fake sandbox ${h.providerRef} is destroyed`, {
        backend: 'fake',
      });
    }
    return box;
  }

  /**
   * Map a sandbox path to a host path, refusing anything outside the box.
   *
   * Two fences, because either alone is bypassable: `assertSandboxPath` is
   * lexical (catches `..` and absolute escapes), and the realpath check below
   * catches a SYMLINK planted inside /work that points elsewhere. W03's
   * `workspace_collect` reads model-chosen paths, so this is load-bearing.
   */
  async function hostPath(box: FakeBox, sandboxPath: string, cwd?: string): Promise<string> {
    const normalized = assertSandboxPath(sandboxPath, cwd);
    const relative = normalized === SANDBOX_ROOT ? '' : normalized.slice(SANDBOX_ROOT.length + 1);
    const candidate = path.join(box.root, relative);
    const realRoot = await fs.realpath(box.root);
    // Resolve the deepest EXISTING ancestor: the target itself may not exist yet
    // (a write), but every directory on the way to it must stay inside the box.
    let probe = candidate;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
          throw new SandboxError('invalid_path', `path "${sandboxPath}" escapes the sandbox`, {
            backend: 'fake',
          });
        }
        break;
      } catch (err) {
        if (err instanceof SandboxError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return candidate;
  }

  const backend: FakeSandboxBackend = {
    name: 'fake',
    calls,

    async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-sbx-'));
      await Promise.all([
        fs.mkdir(path.join(root, 'in'), { recursive: true }),
        fs.mkdir(path.join(root, 'out'), { recursive: true }),
        fs.mkdir(path.join(root, 'tmp'), { recursive: true }),
      ]);
      // Opaque ref, no tenant identifier — the same rule the Vercel `name` and
      // the artifact blob keys follow.
      const providerRef = `fake-${randomUUID()}`;
      boxes.set(providerRef, {
        root,
        region: spec.region,
        memAllocatedMb: spec.memoryMb,
        startedHrNs: process.hrtime.bigint(),
        startedCpuUs: processCpuMicros(),
        destroyed: false,
        frozenUsage: null,
      });
      record('create', providerRef, []);
      return { backend: 'fake', providerRef, region: spec.region, createdAt: new Date() };
    },

    async exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
      const box = liveBoxOf(h);
      record('exec', h.providerRef, [...cmd]);
      if (cmd.length === 0) {
        throw new SandboxError('exec_timeout', 'exec requires a non-empty argv', { backend: 'fake' });
      }
      const cwd = opts.cwd ? await hostPath(box, opts.cwd) : box.root;
      // Argv entries that name a sandbox path are rewritten onto this box's
      // temp root. The Vercel backend needs no such step — /work IS a real
      // directory there — so without this the two backends would disagree on
      // the interface's central case (`exec(h, ['python3', '/work/step-1.py'])`)
      // and sandboxBackend.contract.test.ts would fail against the fake with a
      // 127 while passing against vercel. Only tokens under /work are touched;
      // the interpreter path and ordinary flags are passed through untouched.
      const argv: string[] = [];
      for (const token of cmd) {
        argv.push(
          token === SANDBOX_ROOT || token.startsWith(`${SANDBOX_ROOT}/`)
            ? await hostPath(box, token, opts.cwd)
            : token,
        );
      }
      const stdout = createCappedCollector(opts.maxStdoutBytes);
      const stderr = createCappedCollector(opts.maxStdoutBytes);
      const startedAt = Date.now();

      return await new Promise<ExecResult>((resolve, reject) => {
        // shell: false is the whole point of this adapter. Never change it.
        const child = spawn(argv[0] as string, argv.slice(1), {
          cwd,
          env: childEnv(path.join(box.root, 'tmp')),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group, so the timeout can kill the WHOLE tree. An
          // interpreter that spawned children (`sh -c 'sleep 120'`) survives a
          // kill aimed at the direct child only, and its grandchildren keep the
          // stdout/stderr pipes open — 'close' never fires and exec() hangs past
          // its own deadline. The real sandbox tears down the entire VM, so the
          // fake has to match that or the timeout contract is fiction here.
          detached: true,
        });
        let timedOut = false;
        const killTree = (): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The group is already gone (it exited between the timer firing and
            // this call). Fall through to the direct kill, which is a no-op too.
          }
          child.kill('SIGKILL');
        };
        const killTimer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, opts.timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        if (opts.stdinBytes) child.stdin?.write(opts.stdinBytes);
        child.stdin?.end();

        child.on('error', (err) => {
          clearTimeout(killTimer);
          reject(new SandboxError('create_failed', `spawn failed: ${err.message}`, {
            backend: 'fake',
            cause: err,
          }));
        });
        child.on('close', (code) => {
          clearTimeout(killTimer);
          resolve({
            exitCode: timedOut ? null : code,
            timedOut,
            stdout: stdout.buffer(),
            stderr: stderr.buffer(),
            durationMs: Date.now() - startedAt,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          });
        });
      });
    },

    async writeFiles(
      h: SandboxHandle,
      files: Array<{ path: string; bytes: Buffer }>,
      opts?: WriteFilesOptions,
    ): Promise<void> {
      const box = liveBoxOf(h);
      record('writeFiles', h.providerRef, files.map((f) => f.path));
      const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
      // Cap FIRST: an over-cap batch must write nothing at all, so the caller
      // never has to reason about a half-staged input set.
      if (opts?.maxTotalBytes !== undefined && total > opts.maxTotalBytes) {
        throw new SandboxError(
          'file_too_large',
          `writeFiles batch is ${total} bytes, over the ${opts.maxTotalBytes}-byte cap`,
          { backend: 'fake' },
        );
      }
      const resolved = await Promise.all(files.map(async (f) => ({
        host: await hostPath(box, f.path),
        bytes: f.bytes,
      })));
      for (const file of resolved) {
        await fs.mkdir(path.dirname(file.host), { recursive: true });
        await fs.writeFile(file.host, file.bytes);
      }
    },

    async readFile(h: SandboxHandle, filePath: string, maxBytes: number): Promise<Buffer> {
      const box = liveBoxOf(h);
      record('readFile', h.providerRef, [filePath]);
      const host = await hostPath(box, filePath);
      let stat;
      try {
        stat = await fs.stat(host);
      } catch {
        throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'fake' });
      }
      if (stat.size > maxBytes) {
        throw new SandboxError(
          'file_too_large',
          `${filePath} is ${stat.size} bytes, over the ${maxBytes}-byte cap`,
          { backend: 'fake' },
        );
      }
      return await fs.readFile(host);
    },

    async listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]> {
      const box = liveBoxOf(h);
      record('listFiles', h.providerRef, [dir]);
      const normalized = assertSandboxPath(dir);
      const host = await hostPath(box, dir);
      let entries;
      try {
        entries = await fs.readdir(host, { withFileTypes: true });
      } catch {
        throw new SandboxError('not_found', `no such directory ${dir}`, { backend: 'fake' });
      }
      const out: FileStat[] = [];
      for (const entry of entries) {
        const stat = await fs.lstat(path.join(host, entry.name));
        out.push({
          path: `${normalized === SANDBOX_ROOT ? '' : normalized}/${entry.name}`.replace('//', '/'),
          bytes: stat.size,
          isDir: stat.isDirectory(),
          isSymlink: stat.isSymbolicLink(),
        });
      }
      return out;
    },

    async destroy(h: SandboxHandle): Promise<SandboxUsage | null> {
      const box = boxes.get(h.providerRef);
      record('destroy', h.providerRef, []);
      // Idempotent, and it still hands back what it froze the first time — an
      // unknown box (this process never created it) has nothing to report, which
      // is `null`, never a zeroed usage that would bill the run as free.
      if (!box) return null;
      if (box.destroyed) return box.frozenUsage ?? null;
      box.frozenUsage = {
        cpuMs: Math.max(0, (processCpuMicros() - box.startedCpuUs) / 1000),
        wallMs: Number((process.hrtime.bigint() - box.startedHrNs) / 1_000_000n),
        memAllocatedMb: box.memAllocatedMb,
      };
      box.destroyed = true;
      await fs.rm(box.root, { recursive: true, force: true });
      return box.frozenUsage;
    },

    async usage(h: SandboxHandle): Promise<SandboxUsage> {
      const box = boxOf(h);
      record('usage', h.providerRef, []);
      if (box.frozenUsage) return box.frozenUsage;
      return {
        cpuMs: Math.max(0, (processCpuMicros() - box.startedCpuUs) / 1000),
        wallMs: Number((process.hrtime.bigint() - box.startedHrNs) / 1_000_000n),
        memAllocatedMb: box.memAllocatedMb,
      };
    },

    hostRootFor(h: SandboxHandle): string {
      return boxOf(h).root;
    },

    liveCount(): number {
      let live = 0;
      for (const box of boxes.values()) if (!box.destroyed) live += 1;
      return live;
    },

    async reset(): Promise<void> {
      for (const box of boxes.values()) {
        if (!box.destroyed) await fs.rm(box.root, { recursive: true, force: true });
      }
      boxes.clear();
      calls.length = 0;
    },
  };

  return backend;
}
