/**
 * Execution plane W04 (spec §5.3, §5.8, §6.2, §8, §9) — the per-run sandbox
 * workspace.
 *
 * ONE instance per `analysis` run, created lazily on the first `workspace_*`
 * call and destroyed from the run loop's `finally`. It is the only thing in
 * the codebase that holds a `SandboxHandle`: the model never sees a provider
 * id, a blob key or a path outside `/work`, and it never supplies an argv —
 * `runStep` writes its script to `/work/step-<n>.<ext>` and executes it BY
 * PATH (the Codex/Docker-Sandboxes lesson, spec §5.1 "Rules").
 *
 * Everything is capped by the run's own `AnalysisLimits`, and every cap
 * failure is a `WorkspaceToolError` with a stable code the model reads. The
 * caps are enforced HERE, not in the tool handlers, so a second caller (the
 * chat-launched path, W05) cannot route around them.
 *
 * DB context: this runs inside the BullMQ run loop, which holds no ambient
 * context, so every write self-contexts through `inSystemDbContext` — a
 * contextless write under forced RLS matches zero rows (#2190/#1375). The
 * writes are short and never wrap a provider call: a pooled connection must
 * never be held across a network round trip (#1105).
 */
import path from 'node:path';
import { VercelSandboxCreateError } from './vercelSandboxBackend';
import { eq } from 'drizzle-orm';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { aiRunWorkspaces, type AiWorkspaceBackend, type AiWorkspaceStep } from '../../db/schema/aiWorkspace';
import type { BlobRegion } from '../artifacts/blobStorage';
import {
  ARTIFACT_PREVIEW_BYTES, createArtifact, openArtifactStream, resolveArtifact,
} from '../artifacts/artifactService';
import { MAX_TOOL_RESULT_CHARS } from '../aiToolOutput';
import { emitRunProgress } from '../aiAgents/runProgress';
import { calculateComputeCents } from '../aiCostTracker';
import { captureException } from '../sentry';
import { WorkspaceToolError } from './workspaceErrors';
import {
  isWorkspaceBreakerOpen, recordWorkspaceCreateFailure, recordWorkspaceCreateSuccess,
} from './workspaceBreaker';
import type { SandboxBackend, SandboxHandle, SandboxUsage } from './sandboxBackend';
import {
  deploymentRegion, WORKSPACE_BOOTSTRAP_HASH, WORKSPACE_BOOTSTRAP_IMAGE, WORKSPACE_CPU,
  WORKSPACE_DEADLINE_GRACE_SECONDS, WORKSPACE_IN_DIR, WORKSPACE_MAX_COLLECT_FILES,
  WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_STAGED_FILES, WORKSPACE_MEMORY_GB, WORKSPACE_MEMORY_MB,
  WORKSPACE_OUT_DIR, WORKSPACE_STDOUT_MAX_BYTES, WORKSPACE_TMP_DIR,
} from './workspacePaths';

/** The `analysis*` subset of `AiAgentLimits` this service actually enforces. */
export interface AnalysisLimits {
  analysisMaxComputeSeconds: number;
  analysisMaxComputeCentsPerRun: number;
  analysisMaxStagedBytesPerRun: number;
  analysisMaxArtifactBytesPerRun: number;
  /** Default 300 (spec §5.4). */
  analysisMaxStepTimeoutSeconds: number;
  /** Default 40 (spec §5.4). */
  analysisMaxStepsPerRun: number;
}

export interface WorkspaceRunContext {
  orgId: string;
  runId: string;
  sessionId: string | null;
  region: BlobRegion;
  limits: AnalysisLimits;
  /** The run's wall-clock ceiling; the provider deadline is this + 60s. */
  deadlineAt: Date;
  /**
   * The run's FROZEN input allowlist (`ai_agent_runs.staged_inputs.handles`).
   * `stage` accepts a handle only when it is in here or was produced by this
   * run — spec §8 "Data minimisation". An ADDITION to the cross-wave
   * `WorkspaceRunContext` contract; see the W04 plan's Task 4 header.
   */
  allowedInputHandles: readonly string[];
}

// The sandbox's fixed shape, its paths and the region assertion live in the
// LEAF module `workspacePaths.ts` (see its header for why) and are re-exported
// here so every existing importer of this file is unaffected.
export {
  WORKSPACE_CPU, WORKSPACE_MEMORY_MB, WORKSPACE_MEMORY_GB, WORKSPACE_BOOTSTRAP_IMAGE,
  WORKSPACE_BOOTSTRAP_HASH, WORKSPACE_IN_DIR, WORKSPACE_OUT_DIR, WORKSPACE_TMP_DIR,
  WORKSPACE_DEADLINE_GRACE_SECONDS, WORKSPACE_MAX_STAGED_FILES, WORKSPACE_MAX_COLLECT_FILES,
  WORKSPACE_MAX_FILE_BYTES, WORKSPACE_STDOUT_MAX_BYTES, deploymentRegion,
} from './workspacePaths';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * A staged file's name is MODEL- AND TOOL-SUPPLIED (it comes off the artifact
 * row, which a capture wrote from a device path or a dataset name). Reduce it
 * to one safe path segment: no separators, no leading dots, no control
 * characters, bounded length. The caller then joins it under `/work/in`, so a
 * `../../etc/passwd` name can only ever become `etc_passwd`.
 */
function safeFileName(raw: string, fallbackOrdinal: number): string {
  const base = path.posix.basename(raw.replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 200);
  return cleaned.length > 0 ? cleaned : `input-${fallbackOrdinal}.bin`;
}

/** Read a stream into one Buffer, refusing at `maxBytes` rather than growing. */
async function readStreamCapped(
  stream: NodeJS.ReadableStream, maxBytes: number, onOver: () => WorkspaceToolError,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) throw onOver();
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

const STEP_EXTENSION = { bash: 'sh', python: 'py', node: 'js' } as const;
/**
 * Argv per language — the interpreter and the SCRIPT PATH, nothing else.
 * There is deliberately no `-c` form anywhere in this file: the model's text
 * reaches the sandbox as a FILE, never as an argument, so no quoting bug in
 * any layer can turn a script into a different command (spec §5.1 "Rules").
 */
const STEP_ARGV = {
  bash: (scriptPath: string) => ['/bin/bash', scriptPath],
  python: (scriptPath: string) => ['python3', scriptPath],
  node: (scriptPath: string) => ['node', scriptPath],
} as const;

export interface WorkspaceStepResult {
  ordinal: number;
  exitCode: number | null;
  timedOut: boolean;
  stdoutHead: string;
  stderrHead: string;
  stdoutHandle: string | null;
  scriptHandle: string;
  durationMs: number;
}

export class WorkspaceService {
  private handle: SandboxHandle | null = null;
  private rowId: string | null = null;
  private readyAt: Date | null = null;
  private terminal: 'workspace_cancelled' | 'compute_cap_reached' | 'workspace_expired' | 'workspace_unavailable' | null = null;
  private finalized = false;
  private finalUsage: SandboxUsage | null = null;
  private estimated = false;
  /**
   * True from the moment a sandbox has existed, and never reset. It is what
   * separates "there is nothing to bill" (`finalize()` → null) from "the
   * sandbox is already gone" (`finalize()` → the usage captured before the
   * destroy). `this.handle === null` cannot make that distinction: it is also
   * null after `cancel()` and after `stopFor()`.
   */
  private everCreated = false;
  /**
   * Usage read from the provider immediately BEFORE a destroy, by whichever
   * path destroyed the sandbox. `cancel()` and `stopFor()` (the compute cap
   * and the deadline) both destroy long before the run loop's `finally`, and
   * a destroyed sandbox reports no usage — so the read has to happen while
   * the handle is still live or the number is gone for good. `finalize()`
   * settles from this whenever it has it.
   */
  private lastUsage: SandboxUsage | null = null;
  private computeMsUsed = 0;
  private stagedBytes = 0;
  private stagedFiles = 0;
  private artifactBytes = 0;
  private steps = 0;
  private readonly stepTranscript: AiWorkspaceStep[] = [];
  private readonly produced = new Set<string>();
  private readonly backendName: AiWorkspaceBackend;

  constructor(
    private readonly ctx: WorkspaceRunContext,
    private readonly backend: SandboxBackend,
  ) {
    // The backend names itself (W02's `SandboxBackend.name`) — re-deriving it
    // from env here would let a test-injected fake be PRICED as `vercel`.
    this.backendName = backend.name;
  }

  /** True when `finalize` could not read real usage and had to estimate. */
  get usageEstimated(): boolean { return this.estimated; }
  get stepCount(): number { return this.steps; }
  /** Artifact handles this run produced — the run loop surfaces them. */
  get producedHandles(): string[] { return [...this.produced]; }

  /** Creates the sandbox and the `ai_run_workspaces` row on first use. */
  async ensure(): Promise<void> {
    if (this.terminal) {
      throw new WorkspaceToolError(this.terminal, `This run's workspace is no longer available (${this.terminal}).`);
    }
    if (this.handle) return;

    // R5 / spec §9 — fast path. Admission checks this too, but a run admitted
    // just before the breaker opened would otherwise still make a doomed
    // create call, and the reaper would then have a row to clean up.
    if (await isWorkspaceBreakerOpen(this.backendName)) {
      throw new WorkspaceToolError(
        'workspace_unavailable',
        'Compute workspaces are temporarily unavailable. Conclude with what you have.',
      );
    }

    const region = deploymentRegion();
    if (region !== this.ctx.region) {
      throw new WorkspaceToolError(
        'region_mismatch',
        `This run is scoped to ${this.ctx.region} but the workspace service serves ${region}.`,
      );
    }

    const remainingMs = this.ctx.deadlineAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      this.terminal = 'workspace_expired';
      throw new WorkspaceToolError('workspace_expired', 'This run has no wall clock left for a workspace.');
    }
    const deadlineSeconds = Math.ceil(remainingMs / 1000) + WORKSPACE_DEADLINE_GRACE_SECONDS;
    const deadlineAt = new Date(Date.now() + deadlineSeconds * 1000);

    // The row goes in BEFORE the provider call so the reaper can find a
    // sandbox whose create response never came back. `provider_ref` is
    // back-filled the moment it is known.
    const [row] = await inSystemDbContext(() => db
      .insert(aiRunWorkspaces)
      .values({
        orgId: this.ctx.orgId,
        runId: this.ctx.runId,
        backend: this.backendName,
        providerRef: '(creating)',
        region,
        bootstrapHash: WORKSPACE_BOOTSTRAP_HASH,
        runtimeImage: null,
        status: 'creating',
        deadlineAt,
      })
      .returning({ id: aiRunWorkspaces.id }));
    this.rowId = row?.id ?? null;

    let handle: SandboxHandle;
    try {
      handle = await this.backend.create({
        runId: this.ctx.runId,
        orgId: this.ctx.orgId,
        region,
        cpu: WORKSPACE_CPU,
        memoryMb: WORKSPACE_MEMORY_MB,
        deadlineSeconds,
        image: WORKSPACE_BOOTSTRAP_IMAGE,
      });
    } catch (error) {
      this.terminal = 'workspace_unavailable';
      if (error instanceof VercelSandboxCreateError) {
        this.handle = error.handle;
        this.everCreated = true;
        await this.patchRow({ providerRef: error.handle.providerRef, runtimeImage: error.handle.runtimeImage ?? null, status: 'destroy_failed' }, { important: true });
      } else {
        await this.patchRow({ status: 'destroyed', destroyedAt: new Date() });
      }
      await recordWorkspaceCreateFailure(this.backendName);
      captureException(error instanceof Error ? error : new Error(String(error)));
      throw new WorkspaceToolError(
        'workspace_unavailable',
        'A compute workspace could not be started for this run.',
      );
    }

    this.handle = handle;
    this.everCreated = true;
    this.readyAt = new Date();
    // `important`: this patch is the ONLY thing that replaces the
    // `(creating)` placeholder with the real provider ref. If it is lost, the
    // reaper — the sole path that can destroy this sandbox after a worker
    // crash — calls `destroy()` with the placeholder, never finds the box, and
    // the vendor bills it indefinitely. Every other patch here self-heals.
    await this.patchRow({
      providerRef: handle.providerRef, runtimeImage: handle.runtimeImage ?? null, status: 'ready', readyAt: this.readyAt,
    }, { important: true });
    try {
      // Exec by argv, never a shell string — even for the directory bootstrap.
      const result = await this.backend.exec(handle, ['mkdir', '-p', WORKSPACE_IN_DIR, WORKSPACE_OUT_DIR, WORKSPACE_TMP_DIR], {
        timeoutMs: 10_000, maxStdoutBytes: 4096,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`Workspace directory bootstrap failed (exit ${result.exitCode}, timedOut=${result.timedOut}): ${result.stderr.subarray(0, 512).toString('utf8')}`);
      }
    } catch (error) {
      this.terminal = 'workspace_unavailable';
      await this.destroyHandle();
      await recordWorkspaceCreateFailure(this.backendName);
      captureException(error instanceof Error ? error : new Error(String(error)));
      throw new WorkspaceToolError('workspace_unavailable', 'The compute workspace could not be initialized.');
    }
    await recordWorkspaceCreateSuccess(this.backendName);
  }

  /**
   * Copy artifacts into `/work/in`. The allowlist rule (spec §8 "Data
   * minimisation") is the whole point of this method: a handle is accepted
   * ONLY when the run's frozen `staged_inputs` listed it or this run produced
   * it. "The org's data" is never mountable, and a handle the model invents
   * or reads out of a staged log resolves to nothing.
   */
  async stage(
    handles: string[],
    into?: string,
  ): Promise<{ staged: Array<{ handle: string; path: string; bytes: number }> }> {
    await this.ensure();

    const dir = into ? path.posix.normalize(into) : WORKSPACE_IN_DIR;
    if (
      dir !== WORKSPACE_IN_DIR && !dir.startsWith(`${WORKSPACE_IN_DIR}/`)
      && dir !== WORKSPACE_TMP_DIR && !dir.startsWith(`${WORKSPACE_TMP_DIR}/`)
    ) {
      throw new WorkspaceToolError('collect_path_rejected', `Staging target must be under ${WORKSPACE_IN_DIR}.`);
    }
    if (this.stagedFiles + handles.length > WORKSPACE_MAX_STAGED_FILES) {
      throw new WorkspaceToolError(
        'staged_file_cap',
        `At most ${WORKSPACE_MAX_STAGED_FILES} files may be staged in one run.`,
      );
    }

    const staged: Array<{ handle: string; path: string; bytes: number }> = [];
    for (const handle of handles) {
      // Other run tools (notably export_dataset) create artifacts outside this
      // service. Check persisted ownership, not only the in-memory output set.
      const record = await resolveArtifact(handle, { orgId: this.ctx.orgId });
      if (!this.ctx.allowedInputHandles.includes(handle) && !this.produced.has(handle)
        && record?.runId !== this.ctx.runId) {
        throw new WorkspaceToolError(
          'staged_handle_not_allowed',
          "That handle is not one of this run's inputs and was not produced by this run.",
        );
      }
      if (!record) throw new WorkspaceToolError('artifact_forbidden', 'That artifact is not available to this run.');
      if (record.bytes > WORKSPACE_MAX_FILE_BYTES) {
        throw new WorkspaceToolError(
          'staged_bytes_cap',
          `A single staged file may not exceed ${WORKSPACE_MAX_FILE_BYTES} bytes.`,
        );
      }
      if (this.stagedBytes + record.bytes > this.ctx.limits.analysisMaxStagedBytesPerRun) {
        throw new WorkspaceToolError('staged_bytes_cap', 'This run has reached its total staged-bytes cap.');
      }

      let bytes: Buffer;
      try {
        const stream = await openArtifactStream(record);
        bytes = await readStreamCapped(
          stream,
          Math.min(WORKSPACE_MAX_FILE_BYTES, this.ctx.limits.analysisMaxStagedBytesPerRun - this.stagedBytes),
          () => new WorkspaceToolError('staged_bytes_cap', 'This run has reached its total staged-bytes cap.'),
        );
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error;
        throw new WorkspaceToolError('artifact_store_unavailable', 'The artifact store could not be read.');
      }

      const target = path.posix.join(dir, safeFileName(record.name, this.stagedFiles + 1));
      await this.backend.writeFiles(this.handle!, [{ path: target, bytes }]);
      this.stagedBytes += bytes.length;
      this.stagedFiles += 1;
      staged.push({ handle, path: target, bytes: bytes.length });
    }

    await this.progress('stage', `staged ${staged.length} file(s)`);
    return { staged };
  }

  /**
   * One sandbox step (spec §5.3 table row 2, §5.8). The script is WRITTEN and
   * then executed BY PATH; `timeoutSeconds` is clamped to the smallest of the
   * profile cap, the remaining compute budget and the remaining wall clock,
   * so a busy loop is killed mid-step rather than between model turns (spec
   * §5.6 last bullet). Both the script and any oversize stdout become
   * artifacts, which is what makes the run page show exactly what ran.
   */
  async runStep(input: {
    script: string; language: 'bash' | 'python' | 'node'; timeoutSeconds?: number; stdinHandle?: string;
  }): Promise<WorkspaceStepResult> {
    await this.ensure();
    if (this.steps >= this.ctx.limits.analysisMaxStepsPerRun) {
      throw new WorkspaceToolError(
        'step_cap_reached',
        `This run may execute at most ${this.ctx.limits.analysisMaxStepsPerRun} steps.`,
      );
    }

    const remainingComputeSec = this.ctx.limits.analysisMaxComputeSeconds - this.computeMsUsed / 1000;
    if (remainingComputeSec <= 0) {
      await this.stopFor('compute_cap_reached');
      throw new WorkspaceToolError(
        'compute_cap_reached',
        'This run has used its compute budget; conclude with what you have.',
      );
    }
    const remainingWallSec = (this.ctx.deadlineAt.getTime() - Date.now()) / 1000;
    if (remainingWallSec <= 0) {
      await this.stopFor('workspace_expired');
      throw new WorkspaceToolError('workspace_expired', 'This run is out of wall-clock time.');
    }

    const requested = input.timeoutSeconds ?? this.ctx.limits.analysisMaxStepTimeoutSeconds;
    const timeoutSec = Math.max(1, Math.floor(Math.min(
      requested, this.ctx.limits.analysisMaxStepTimeoutSeconds, remainingComputeSec, remainingWallSec,
    )));

    const ordinal = this.steps + 1;
    const scriptPath = `/work/step-${ordinal}.${STEP_EXTENSION[input.language]}`;
    const scriptBytes = Buffer.from(input.script, 'utf8');
    await this.backend.writeFiles(this.handle!, [{ path: scriptPath, bytes: scriptBytes }]);

    let stdinBytes: Buffer | undefined;
    if (input.stdinHandle) {
      const [only] = (await this.stage([input.stdinHandle], WORKSPACE_TMP_DIR)).staged;
      stdinBytes = only
        ? await this.backend.readFile(this.handle!, only.path, WORKSPACE_MAX_FILE_BYTES)
        : undefined;
    }

    const result = await this.backend.exec(this.handle!, STEP_ARGV[input.language](scriptPath), {
      cwd: '/work',
      timeoutMs: timeoutSec * 1000,
      maxStdoutBytes: WORKSPACE_STDOUT_MAX_BYTES,
      ...(stdinBytes ? { stdinBytes } : {}),
    });

    this.steps = ordinal;
    this.computeMsUsed += result.durationMs;

    let scriptArtifact: { id: string };
    try {
      scriptArtifact = await this.persistArtifact(
        'step_script', `step-${ordinal}.${STEP_EXTENSION[input.language]}`, 'text/plain', scriptBytes,
        'workspace_run',
      );
    } catch (error) {
      // The step ALREADY RAN and already spent step-cap and compute-cap
      // budget. An artifact-store outage must not also erase it from the
      // transcript — an engineer reading "what did this sandbox execute"
      // would see a hole at this ordinal with nothing saying why.
      await this.appendStep({
        ordinal,
        language: input.language,
        scriptArtifactHandle: '',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      throw error;
    }
    let stdoutHandle: string | null = null;
    if (result.stdout.length > MAX_TOOL_RESULT_CHARS) {
      stdoutHandle = (await this.persistArtifact(
        'step_stdout', `step-${ordinal}-stdout.txt`, 'text/plain', result.stdout, 'workspace_run',
      )).id;
    }

    await this.appendStep({
      ordinal,
      language: input.language,
      scriptArtifactHandle: scriptArtifact.id,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      ...(stdoutHandle ? { stdoutHandle } : {}),
    });
    await this.progress('run', `step ${ordinal} exit ${result.exitCode ?? 'timeout'}`);

    if (this.computeMsUsed / 1000 >= this.ctx.limits.analysisMaxComputeSeconds) {
      await this.stopFor('compute_cap_reached');
    }

    return {
      ordinal,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutHead: result.stdout.subarray(0, ARTIFACT_PREVIEW_BYTES).toString('utf8'),
      stderrHead: result.stderr.subarray(0, ARTIFACT_PREVIEW_BYTES).toString('utf8'),
      stdoutHandle,
      scriptHandle: scriptArtifact.id,
      durationMs: result.durationMs,
    };
  }

  /**
   * Read files out of `/work/out` into `output` artifacts. TWO independent
   * containment checks, because either alone is bypassable: a textual
   * normalise (kills `..`, absolute paths elsewhere, anything outside
   * `/work/out`) AND a `realpath` in the sandbox (kills a SYMLINK inside
   * `/work/out` pointing at `/etc/shadow`, which survives every textual
   * check there is). `realpath` is invoked as an argv with `--`, so a path
   * beginning with `-` cannot become a flag.
   */
  async collect(
    paths: string[],
    labels?: Record<string, string>,
  ): Promise<{ artifacts: Array<{ handle: string; name: string; bytes: number }> }> {
    if (paths.length > WORKSPACE_MAX_COLLECT_FILES) {
      throw new WorkspaceToolError(
        'collect_file_cap',
        `At most ${WORKSPACE_MAX_COLLECT_FILES} files may be collected per call.`,
      );
    }
    await this.ensure();

    const out: Array<{ handle: string; name: string; bytes: number }> = [];
    for (const raw of paths) {
      const candidate = raw.startsWith('/')
        ? path.posix.normalize(raw)
        : path.posix.normalize(path.posix.join(WORKSPACE_OUT_DIR, raw));
      if (!candidate.startsWith(`${WORKSPACE_OUT_DIR}/`) || candidate.includes('..')) {
        throw new WorkspaceToolError('collect_path_rejected', `Only files under ${WORKSPACE_OUT_DIR} can be collected.`);
      }
      const probe = await this.backend.exec(this.handle!, ['realpath', '-m', '--', candidate], {
        timeoutMs: 5_000, maxStdoutBytes: 4096,
      });
      const resolved = probe.stdout.toString('utf8').trim();
      if (!resolved.startsWith(`${WORKSPACE_OUT_DIR}/`)) {
        throw new WorkspaceToolError('collect_path_rejected', `Only files under ${WORKSPACE_OUT_DIR} can be collected.`);
      }

      const budget = this.ctx.limits.analysisMaxArtifactBytesPerRun - this.artifactBytes;
      if (budget <= 0) throw new WorkspaceToolError('artifact_bytes_cap', 'This run has reached its artifact-bytes cap.');
      const bytes = await this.backend.readFile(this.handle!, resolved, Math.min(WORKSPACE_MAX_FILE_BYTES, budget));
      if (bytes.length > budget) {
        throw new WorkspaceToolError('artifact_bytes_cap', 'This run has reached its artifact-bytes cap.');
      }

      const basename = path.posix.basename(resolved);
      const extension = path.posix.extname(basename);
      const label = labels?.[raw]?.trim();
      // Labels become download filenames, so preserve the collected file's type.
      let name = label || basename;
      if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) {
        name += extension;
      }
      const record = await this.persistArtifact('output', name, 'application/octet-stream', bytes, 'workspace_collect');
      this.artifactBytes += bytes.length;
      out.push({ handle: record.id, name, bytes: bytes.length });
    }

    await this.progress('collect', `collected ${out.length} file(s)`);
    return { artifacts: out };
  }

  /**
   * Destroys the sandbox early; every later workspace call is refused.
   *
   * Reads usage BEFORE the destroy. A cancelled run is still a BILLED run —
   * the microVM ran, we were charged for it — and once the provider has
   * destroyed it there is nothing left to ask. Capturing here is what lets
   * `finalize()` settle a cancelled run at its real cost instead of $0.
   */
  async cancel(): Promise<void> {
    if (this.terminal === 'workspace_cancelled') return;
    this.terminal = 'workspace_cancelled';
    await this.captureUsageBeforeDestroy();
    await this.destroyHandle();
  }

  /**
   * Destroy + usage, from the run loop's `finally`. Idempotent: a second call
   * returns the first call's result without touching the provider.
   *
   * Returns the usage the row was settled with. `usageEstimated` says whether
   * that was READ or estimated — the run loop settles compute at the
   * RESERVATION whenever it was estimated (spec §9 "Usage unavailable after
   * stop: settle at the reservation, never $0").
   *
   * NULL MEANS "NO SANDBOX EVER EXISTED", and nothing else. This is the
   * distinction that decides whether the run is billed at all, so it is
   * keyed on `everCreated` rather than on `this.handle` — which is also null
   * after `cancel()` and after `stopFor()` (the compute cap, the deadline).
   * Keying it on the handle made a cancelled or capped run — the two most
   * ordinary endings an analysis run has — settle at $0 while the provider
   * had already billed us for the microVM.
   */
  async finalize(): Promise<SandboxUsage | null> {
    if (this.finalized) return this.finalUsage;
    this.finalized = true;
    if (!this.handle && !this.everCreated) {
      // Lazy creation never happened: the model concluded from datasets alone.
      if (this.rowId) await this.patchRow({ status: 'destroyed', destroyedAt: new Date() });
      return null;
    }

    let usage: SandboxUsage | null = this.lastUsage;
    if (!usage && this.handle) {
      try {
        usage = await this.backend.usage(this.handle);
        this.estimated = false;
      } catch (error) {
        console.warn('[workspaceService] usage() failed; estimating', { runId: this.ctx.runId, error });
      }
    }

    // `destroyHandle()` is a no-op when the sandbox is already gone (it
    // returns true on a null handle), so a cancelled/capped run destroys
    // exactly once across both paths. W02's `destroy()` returns the usage it
    // captured on the way down — the last chance to get a real number.
    const { destroyed, usage: destroyUsage } = await this.destroyHandle();
    if (!usage && destroyUsage) {
      usage = destroyUsage;
      this.estimated = false;
    }

    if (!usage) {
      // Either a destroy-time read failed, or the sandbox was already gone
      // (cancel/cap/deadline) and nothing was captured. Estimate from the
      // exec durations we measured ourselves, and flag it — `usageEstimated`
      // is what makes `finalizeWorkspaceForRun` settle at the RESERVATION.
      this.estimated = true;
      const wallMs = this.readyAt ? Math.max(0, Date.now() - this.readyAt.getTime()) : 0;
      usage = { cpuMs: this.computeMsUsed, wallMs, memAllocatedMb: WORKSPACE_MEMORY_MB };
    }
    this.finalUsage = usage;

    const computeCents = calculateComputeCents(this.backendName, usage, WORKSPACE_MEMORY_GB);
    await this.patchRow({
      status: destroyed ? 'destroyed' : 'destroy_failed',
      destroyedAt: destroyed ? new Date() : null,
      cpuMs: usage.cpuMs,
      wallMs: usage.wallMs,
      memAllocatedMb: usage.memAllocatedMb,
      computeCents,
      stagedBytes: this.stagedBytes,
      artifactBytes: this.artifactBytes,
      stepCount: this.steps,
    });
    return usage;
  }

  /**
   * Read and stash provider usage while the handle is still live. Called by
   * EVERY path that destroys early (`cancel`, `stopFor`). On failure it does
   * not throw — it latches `estimated`, so `finalize()` falls back to the
   * `computeMsUsed` estimate and the run loop settles at the RESERVATION
   * (spec §9: "never $0") rather than at a number we cannot defend.
   */
  private async captureUsageBeforeDestroy(): Promise<void> {
    if (!this.handle) return;
    try {
      this.lastUsage = await this.backend.usage(this.handle);
      this.estimated = false;
    } catch (error) {
      console.warn('[workspaceService] usage() before destroy failed; will estimate', {
        runId: this.ctx.runId, error,
      });
      this.estimated = true;
    }
  }

  /** Destroy once, tolerate failure (the reaper retries). */
  private async destroyHandle(): Promise<{ destroyed: boolean; usage: SandboxUsage | null }> {
    const handle = this.handle;
    if (!handle) return { destroyed: true, usage: null };
    try {
      const usage = await this.backend.destroy(handle);
      this.handle = null;
      if (usage && !this.lastUsage) this.lastUsage = usage;
      return { destroyed: true, usage: usage ?? null };
    } catch (error) {
      console.error('[workspaceService] destroy failed; row left destroy_failed', {
        runId: this.ctx.runId, error,
      });
      captureException(error instanceof Error ? error : new Error(String(error)));
      await this.patchRow({ status: 'destroy_failed' });
      return { destroyed: false, usage: null };
    }
  }

  /** Persist bytes as an artifact of this run and mark the handle stageable. */
  private async persistArtifact(
    kind: 'step_script' | 'step_stdout' | 'output', name: string, contentType: string,
    body: Buffer, createdByTool: string,
  ): Promise<{ id: string }> {
    try {
      const record = await createArtifact({
        orgId: this.ctx.orgId,
        runId: this.ctx.runId,
        sessionId: this.ctx.sessionId,
        kind,
        name,
        contentType,
        body,
        maxBytes: WORKSPACE_MAX_FILE_BYTES,
        createdByTool,
        region: this.ctx.region,
      });
      this.produced.add(record.id);
      return record;
    } catch (error) {
      console.error('[workspaceService] artifact write failed', { runId: this.ctx.runId, kind, error });
      throw new WorkspaceToolError('artifact_store_unavailable', 'The artifact store is unavailable; nothing was stored.');
    }
  }

  /** Append one step transcript entry to `ai_run_workspaces.steps` (spec §5.8). */
  private async appendStep(entry: AiWorkspaceStep): Promise<void> {
    this.stepTranscript.push(entry);
    if (!this.rowId) return;
    await this.patchRow({ steps: [...this.stepTranscript], stepCount: this.steps });
  }

  /**
   * Destroy the sandbox for a cap/deadline reason and latch the refusal.
   *
   * Usage is read BEFORE the destroy, for the same reason `cancel()` does it:
   * hitting the compute cap is the single most likely way an analysis run
   * ends, and it is by definition the run that cost the MOST. A destroy
   * without this capture leaves `finalize()` nothing to settle from and the
   * most expensive run in the system bills at $0 (see the B1 cases in
   * `workspaceService.test.ts`).
   */
  private async stopFor(reason: 'compute_cap_reached' | 'workspace_expired'): Promise<void> {
    if (this.terminal) return;
    this.terminal = reason;
    await this.captureUsageBeforeDestroy();
    const { destroyed } = await this.destroyHandle();
    await this.patchRow({ status: destroyed ? 'destroyed' : 'destroy_failed', destroyedAt: destroyed ? new Date() : null });
  }

  /** Progress is observability: it must never fail a step. */
  private async progress(step: string, label: string): Promise<void> {
    try {
      // W03's signature: (ctx, step, label). W03 assigns the ordinal and
      // mirrors the entry into the Redis ring the run page polls — nothing
      // here may assume the entry was delivered live.
      await emitRunProgress({ orgId: this.ctx.orgId, runId: this.ctx.runId }, step, label);
    } catch (error) {
      console.warn('[workspaceService] progress publish failed (non-fatal)', { runId: this.ctx.runId, error });
    }
  }

  /** Best-effort row patch: bookkeeping must never fail a run. */
  private async patchRow(
    values: Record<string, unknown>,
    opts: { important?: boolean } = {},
  ): Promise<void> {
    if (!this.rowId) return;
    const rowId = this.rowId;
    try {
      await inSystemDbContext(() => db
        .update(aiRunWorkspaces)
        .set(values)
        .where(eq(aiRunWorkspaces.id, rowId)));
    } catch (error) {
      console.error('[workspaceService] failed to update ai_run_workspaces (non-fatal)', {
        runId: this.ctx.runId, error,
      });
      // Most patches here are bookkeeping the next one overwrites. The ones
      // marked `important` are not: losing them costs money with no second
      // chance, so they page rather than only log (same posture as
      // `destroyHandle`).
      if (opts.important) {
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
