/**
 * Execution plane W04 — WorkspaceService lifecycle (spec §5.3, §6.2, §9).
 *
 * The backend under test is a RECORDING fake implementing W02's
 * `SandboxBackend` contract — that is what lets these cases assert the exact
 * argv, the create spec and the destroy count. Nothing here talks to a real
 * sandbox or a real DB: `../../db` is mocked with the same insert/update
 * chain shape `runService.test.ts` uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecResult, FileStat, SandboxBackend, SandboxHandle, SandboxUsage,
} from './sandboxBackend';

const dbCalls: { inserted: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
  inserted: [], updated: [],
};

vi.mock('../../db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        dbCalls.inserted.push(v);
        return { returning: async () => [{ id: 'ws-row-1' }] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        dbCalls.updated.push(v);
        return { where: async () => [] };
      },
    }),
  },
  runOutsideDbContext: (fn: () => Promise<unknown>) => fn(),
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  getCurrentDbAccessContext: () => null,
}));

vi.mock('../aiCostTracker', () => ({
  calculateComputeCents: (_b: string, usage: SandboxUsage) => Math.ceil(usage.cpuMs / 1000),
}));

vi.mock('../aiAgents/runProgress', () => ({ emitRunProgress: vi.fn(async () => {}) }));

const artifacts = new Map<string, {
  id: string; orgId: string; runId: string | null; name: string; bytes: number; body: Buffer;
}>();
const created: Array<Record<string, unknown>> = [];

vi.mock('../artifacts/artifactService', () => ({
  ARTIFACT_PREVIEW_BYTES: 2048,
  resolveArtifact: async (handle: string, scope: { orgId: string }) => {
    const row = artifacts.get(handle);
    return row && row.orgId === scope.orgId ? row : null;
  },
  openArtifactStream: async (record: { body: Buffer }) => {
    const { Readable } = await import('node:stream');
    return Readable.from([record.body]);
  },
  createArtifact: async (input: Record<string, unknown>) => {
    created.push(input);
    const id = `art-${created.length}`;
    const body = Buffer.isBuffer(input.body) ? (input.body as Buffer) : Buffer.from('');
    artifacts.set(id, {
      id, orgId: String(input.orgId), runId: String(input.runId),
      name: String(input.name), bytes: body.length, body,
    });
    return { id, bytes: body.length, name: String(input.name) };
  },
}));

vi.mock('../aiToolOutput', () => ({ MAX_TOOL_RESULT_CHARS: 8000 }));

import { emitRunProgress } from '../aiAgents/runProgress';
import { WorkspaceToolError } from './workspaceErrors';
import {
  WORKSPACE_DEADLINE_GRACE_SECONDS, WORKSPACE_MAX_COLLECT_FILES, WORKSPACE_MAX_STAGED_FILES,
  WORKSPACE_MEMORY_MB, WorkspaceService,
  type WorkspaceRunContext,
} from './workspaceService';

class RecordingBackend implements SandboxBackend {
  readonly name = 'fake' as const;
  readonly creates: Array<Record<string, unknown>> = [];
  readonly execs: Array<{ cmd: string[]; timeoutMs: number }> = [];
  readonly writes: Array<{ path: string; bytes: Buffer }> = [];
  destroyCount = 0;
  usageError: Error | null = null;
  createError: Error | null = null;
  files = new Map<string, Buffer>();
  nextExec: Partial<ExecResult> = {};

  async create(spec: Record<string, unknown>): Promise<SandboxHandle> {
    this.creates.push(spec);
    if (this.createError) throw this.createError;
    return { backend: 'fake', providerRef: 'sbx-1', region: 'eu', createdAt: new Date() };
  }

  async exec(_h: SandboxHandle, cmd: string[], opts: { timeoutMs: number }): Promise<ExecResult> {
    this.execs.push({ cmd, timeoutMs: opts.timeoutMs });
    return {
      exitCode: 0,
      timedOut: false,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      durationMs: 10,
      stdoutTruncated: false,
      stderrTruncated: false,
      ...this.nextExec,
    };
  }

  async writeFiles(_h: SandboxHandle, files: Array<{ path: string; bytes: Buffer }>): Promise<void> {
    for (const f of files) { this.writes.push(f); this.files.set(f.path, f.bytes); }
  }

  async readFile(_h: SandboxHandle, p: string): Promise<Buffer> {
    return this.files.get(p) ?? Buffer.from('');
  }

  async listFiles(): Promise<FileStat[]> { return []; }

  async destroy(): Promise<SandboxUsage | null> {
    this.destroyCount += 1;
    return null;
  }

  async usage(): Promise<SandboxUsage> {
    if (this.usageError) throw this.usageError;
    return { cpuMs: 4000, wallMs: 9000, memAllocatedMb: WORKSPACE_MEMORY_MB };
  }
}

function ctxFor(over: Partial<WorkspaceRunContext> = {}): WorkspaceRunContext {
  return {
    orgId: 'org-1',
    runId: 'run-1',
    sessionId: null,
    region: 'eu',
    deadlineAt: new Date(Date.now() + 600_000),
    allowedInputHandles: [],
    limits: {
      analysisMaxComputeSeconds: 600,
      analysisMaxComputeCentsPerRun: 25,
      analysisMaxStagedBytesPerRun: 256 * 1024 * 1024,
      analysisMaxArtifactBytesPerRun: 128 * 1024 * 1024,
      analysisMaxStepTimeoutSeconds: 300,
      analysisMaxStepsPerRun: 40,
    },
    ...over,
  };
}

function seedArtifact(id: string, orgId: string, runId: string | null, name: string, body: Buffer) {
  artifacts.set(id, { id, orgId, runId, name, bytes: body.length, body });
}

beforeEach(() => {
  dbCalls.inserted.length = 0;
  dbCalls.updated.length = 0;
  artifacts.clear();
  created.length = 0;
  vi.mocked(emitRunProgress).mockClear();
  process.env.BREEZE_REGION = 'eu';
  process.env.AI_WORKSPACE_BACKEND = 'fake';
});

describe('WorkspaceService lifecycle', () => {
  it('creates one sandbox with the fixed shape, deny-all and deadline = remaining wall + 60s', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    await svc.ensure(); // idempotent

    expect(backend.creates).toHaveLength(1);
    const spec = backend.creates[0]!;
    expect(spec.cpu).toBe(1);
    expect(spec.memoryMb).toBe(WORKSPACE_MEMORY_MB);
    expect(spec.region).toBe('eu');
    expect(Number(spec.deadlineSeconds)).toBeGreaterThan(590);
    expect(Number(spec.deadlineSeconds)).toBeLessThanOrEqual(600 + WORKSPACE_DEADLINE_GRACE_SECONDS);
    expect(dbCalls.inserted).toHaveLength(1);
    expect(dbCalls.inserted[0]!.status).toBe('creating');
    expect(dbCalls.updated.some((u) => u.status === 'ready')).toBe(true);
  });

  it('refuses when the run region is not this deployment region', async () => {
    process.env.BREEZE_REGION = 'us';
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor({ region: 'eu' }), backend);
    await expect(svc.ensure()).rejects.toMatchObject({ code: 'region_mismatch' });
    expect(backend.creates).toHaveLength(0);
  });

  it('maps a create failure to workspace_unavailable and marks the row destroyed', async () => {
    const backend = new RecordingBackend();
    backend.createError = new Error('quota');
    const svc = new WorkspaceService(ctxFor(), backend);
    await expect(svc.ensure()).rejects.toBeInstanceOf(WorkspaceToolError);
    await expect(svc.ensure()).rejects.toMatchObject({ code: 'workspace_unavailable' });
    expect(dbCalls.updated.some((u) => u.status === 'destroy_failed' || u.status === 'destroyed')).toBe(true);
  });

  it('cancel destroys once and every later call is workspace_cancelled', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    await svc.cancel();
    expect(backend.destroyCount).toBe(1);
    await expect(svc.ensure()).rejects.toMatchObject({ code: 'workspace_cancelled' });
  });

  it('finalize is idempotent, destroys once and records usage + cents', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    const first = await svc.finalize();
    const second = await svc.finalize();
    expect(first).toEqual(second);
    expect(first?.cpuMs).toBe(4000);
    expect(svc.usageEstimated).toBe(false);
    expect(backend.destroyCount).toBe(1);
    const settled = dbCalls.updated.at(-1)!;
    expect(settled.status).toBe('destroyed');
    expect(settled.computeCents).toBe(4);
  });

  it('flags usageEstimated and still returns a non-null estimate when usage() throws', async () => {
    const backend = new RecordingBackend();
    backend.usageError = new Error('sandbox gone');
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    const usage = await svc.finalize();
    expect(usage).not.toBeNull();
    expect(svc.usageEstimated).toBe(true);
  });

  it('finalize on a service that never created a sandbox returns null and destroys nothing', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    expect(await svc.finalize()).toBeNull();
    expect(backend.destroyCount).toBe(0);
  });

  // --- B1: a destroyed-early sandbox must still settle NON-ZERO ------------
  // These are the whole reason `lastUsage`/`everCreated` exist. Before them,
  // `cancel()` and `stopFor()` nulled `this.handle`, `finalize()` took the
  // `!this.handle` branch and returned null, and the run loop settled the run
  // at $0 — a free sandbox for any model that called `workspace_cancel`, or
  // that ran until the compute cap stopped it. Both are the COMMON endings of
  // an analysis run, not edge cases.

  it('cancel then finalize still reports the usage read before the destroy', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    await svc.cancel();
    expect(backend.destroyCount).toBe(1);

    const usage = await svc.finalize();
    expect(usage).not.toBeNull();
    expect(usage!.cpuMs).toBe(4000);
    expect(svc.usageEstimated).toBe(false);
    // No SECOND destroy, and the row carries real cents rather than zero.
    expect(backend.destroyCount).toBe(1);
    expect(dbCalls.updated.at(-1)!.computeCents).toBe(4);
  });

  it('cancel whose usage() throws still finalizes non-null and flags the estimate', async () => {
    const backend = new RecordingBackend();
    backend.usageError = new Error('sandbox gone');
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.ensure();
    await svc.cancel();

    const usage = await svc.finalize();
    expect(usage).not.toBeNull();
    expect(svc.usageEstimated).toBe(true);
  });

  it('the compute cap destroys the sandbox and finalize still settles non-zero', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { durationMs: 40_000 };
    const svc = new WorkspaceService(
      ctxFor({ limits: { ...ctxFor().limits, analysisMaxComputeSeconds: 30 } }),
      backend,
    );
    await svc.runStep({ script: 'x', language: 'bash' }); // trips stopFor()
    expect(backend.destroyCount).toBe(1);

    const usage = await svc.finalize();
    expect(usage).not.toBeNull();
    expect(usage!.cpuMs).toBeGreaterThan(0);
    expect(Number(dbCalls.updated.at(-1)!.computeCents)).toBeGreaterThan(0);
  });
});

describe('WorkspaceService.stage', () => {
  it('stages only handles in staged_inputs or produced by this run', async () => {
    seedArtifact('h-allowed', 'org-1', 'run-1', 'app.log', Buffer.from('hello'));
    seedArtifact('h-other', 'org-1', 'run-1', 'secret.log', Buffer.from('nope'));
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor({ allowedInputHandles: ['h-allowed'] }), backend);

    const ok = await svc.stage(['h-allowed']);
    expect(ok.staged[0]!.path).toBe('/work/in/app.log');
    expect(backend.writes.at(-1)!.bytes.toString()).toBe('hello');

    await expect(svc.stage(['h-other'])).rejects.toMatchObject({ code: 'staged_handle_not_allowed' });
  });

  it('reports a foreign-org handle as artifact_forbidden, never "not found"', async () => {
    seedArtifact('h-foreign', 'org-2', 'run-1', 'x.log', Buffer.from('x'));
    const svc = new WorkspaceService(ctxFor({ allowedInputHandles: ['h-foreign'] }), new RecordingBackend());
    await expect(svc.stage(['h-foreign'])).rejects.toMatchObject({ code: 'artifact_forbidden' });
  });

  it('sanitises the staged filename and cannot escape /work/in', async () => {
    seedArtifact('h1', 'org-1', 'run-1', '../../etc/passwd', Buffer.from('x'));
    const svc = new WorkspaceService(ctxFor({ allowedInputHandles: ['h1'] }), new RecordingBackend());
    const res = await svc.stage(['h1']);
    expect(res.staged[0]!.path.startsWith('/work/in/')).toBe(true);
    expect(res.staged[0]!.path).not.toContain('..');
  });

  it('rejects a staging target outside /work/in', async () => {
    seedArtifact('h1', 'org-1', 'run-1', 'a.log', Buffer.from('x'));
    const svc = new WorkspaceService(ctxFor({ allowedInputHandles: ['h1'] }), new RecordingBackend());
    await expect(svc.stage(['h1'], '/etc')).rejects.toMatchObject({ code: 'collect_path_rejected' });
  });

  it('enforces the total staged-bytes cap', async () => {
    seedArtifact('big', 'org-1', 'run-1', 'big.bin', Buffer.alloc(64));
    const svc = new WorkspaceService(
      ctxFor({ allowedInputHandles: ['big'], limits: { ...ctxFor().limits, analysisMaxStagedBytesPerRun: 32 } }),
      new RecordingBackend(),
    );
    await expect(svc.stage(['big'])).rejects.toMatchObject({ code: 'staged_bytes_cap' });
  });

  it('enforces the staged file-count cap', async () => {
    const handles: string[] = [];
    for (let i = 0; i < WORKSPACE_MAX_STAGED_FILES + 1; i += 1) {
      const h = `h${i}`; handles.push(h);
      seedArtifact(h, 'org-1', 'run-1', `f${i}.txt`, Buffer.from('x'));
    }
    const svc = new WorkspaceService(ctxFor({ allowedInputHandles: handles }), new RecordingBackend());
    await expect(svc.stage(handles)).rejects.toMatchObject({ code: 'staged_file_cap' });
  });
});

describe('WorkspaceService.runStep', () => {
  it('writes the script to /work/step-<n>.<ext> and execs it BY PATH', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    const step = await svc.runStep({ script: 'print(1)', language: 'python' });

    expect(step.ordinal).toBe(1);
    expect(backend.writes.some((w) => w.path === '/work/step-1.py')).toBe(true);
    const exec = backend.execs.at(-1)!;
    expect(exec.cmd).toEqual(['python3', '/work/step-1.py']);
    expect(exec.cmd.join(' ')).not.toContain('print(1)');
    expect(step.scriptHandle).toMatch(/^art-/);
    expect(created.some((c) => c.kind === 'step_script')).toBe(true);
  });

  it('never lets timeoutSeconds exceed analysisMaxStepTimeoutSeconds', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await svc.runStep({ script: 'x', language: 'bash', timeoutSeconds: 100_000 });
    expect(backend.execs.at(-1)!.timeoutMs).toBe(300_000);
  });

  it('stops at the compute cap and destroys the sandbox', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { durationMs: 40_000 };
    const svc = new WorkspaceService(
      ctxFor({ limits: { ...ctxFor().limits, analysisMaxComputeSeconds: 30 } }),
      backend,
    );
    await svc.runStep({ script: 'x', language: 'bash' });
    await expect(svc.runStep({ script: 'y', language: 'bash' }))
      .rejects.toMatchObject({ code: 'compute_cap_reached' });
    expect(backend.destroyCount).toBe(1);
  });

  it('refuses past analysisMaxStepsPerRun', async () => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor({ limits: { ...ctxFor().limits, analysisMaxStepsPerRun: 1 } }), backend);
    await svc.runStep({ script: 'x', language: 'bash' });
    await expect(svc.runStep({ script: 'y', language: 'bash' }))
      .rejects.toMatchObject({ code: 'step_cap_reached' });
  });

  it('persists oversize stdout as a step_stdout artifact and emits progress', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { stdout: Buffer.from('z'.repeat(9000)) };
    const svc = new WorkspaceService(ctxFor(), backend);
    const step = await svc.runStep({ script: 'x', language: 'node' });
    expect(step.stdoutHandle).toMatch(/^art-/);
    expect(created.some((c) => c.kind === 'step_stdout')).toBe(true);
    expect(step.stdoutHead.length).toBeLessThanOrEqual(2048);
    expect(emitRunProgress).toHaveBeenCalled();
  });

  it('reports a timed-out step without failing the run', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { exitCode: null, timedOut: true };
    const svc = new WorkspaceService(ctxFor(), backend);
    const step = await svc.runStep({ script: 'while true; do :; done', language: 'bash' });
    expect(step.timedOut).toBe(true);
    expect(step.exitCode).toBeNull();
  });
});

describe('WorkspaceService.collect', () => {
  it.each([
    '../etc/passwd',
    '/etc/passwd',
    '/work/in/staged.log',
    'out/../../tmp/x',
  ])('rejects %s before touching the sandbox', async (p) => {
    const backend = new RecordingBackend();
    const svc = new WorkspaceService(ctxFor(), backend);
    await expect(svc.collect([p])).rejects.toMatchObject({ code: 'collect_path_rejected' });
  });

  it('rejects a symlink that realpath resolves outside /work/out', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { stdout: Buffer.from('/etc/shadow\n') };
    const svc = new WorkspaceService(ctxFor(), backend);
    await expect(svc.collect(['/work/out/link'])).rejects.toMatchObject({ code: 'collect_path_rejected' });
    expect(backend.execs.at(-1)!.cmd).toEqual(['realpath', '-m', '--', '/work/out/link']);
  });

  it('collects a contained path into an output artifact', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { stdout: Buffer.from('/work/out/report.csv\n') };
    backend.files.set('/work/out/report.csv', Buffer.from('a,b\n1,2\n'));
    const svc = new WorkspaceService(ctxFor(), backend);
    const res = await svc.collect(['report.csv'], { 'report.csv': 'Fleet report' });
    expect(res.artifacts[0]!.name).toBe('Fleet report');
    expect(created.at(-1)!.kind).toBe('output');
  });

  it('enforces the collect file-count cap', async () => {
    const svc = new WorkspaceService(ctxFor(), new RecordingBackend());
    const paths = Array.from({ length: WORKSPACE_MAX_COLLECT_FILES + 1 }, (_, i) => `f${i}.txt`);
    await expect(svc.collect(paths)).rejects.toMatchObject({ code: 'collect_file_cap' });
  });

  it('enforces the artifact-bytes cap', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { stdout: Buffer.from('/work/out/big.bin\n') };
    backend.files.set('/work/out/big.bin', Buffer.alloc(64));
    const svc = new WorkspaceService(
      ctxFor({ limits: { ...ctxFor().limits, analysisMaxArtifactBytesPerRun: 32 } }),
      backend,
    );
    await expect(svc.collect(['big.bin'])).rejects.toMatchObject({ code: 'artifact_bytes_cap' });
  });

  it('a collected artifact becomes stageable back into the sandbox', async () => {
    const backend = new RecordingBackend();
    backend.nextExec = { stdout: Buffer.from('/work/out/report.csv\n') };
    backend.files.set('/work/out/report.csv', Buffer.from('a,b\n'));
    const svc = new WorkspaceService(ctxFor(), backend);
    const res = await svc.collect(['report.csv']);
    // Produced by this run ⇒ allowed even though staged_inputs is empty.
    await expect(svc.stage([res.artifacts[0]!.handle])).resolves.toBeTruthy();
  });
});
