/**
 * Server-side YARA pre-check (#6263 W03a, Open Decisions 1, 2, 9).
 *
 * Runs `breeze-yarac validate` — the agent's own compiler and compile policy
 * (W02 §C5), built into the API image from `agent/cmd/breeze-yarac` — over a
 * bundle the server just built. The server never compiles to or ships
 * bytecode; this is a gate so a bundle that would fail on every agent is never
 * published.
 *
 * Fails CLOSED: anything other than a clean, well-formed `{"ok":true}` on exit
 * 0 or a parseable per-rule error list on exit 1 is reported as `unavailable`
 * — a missing binary, a timeout, an engine failure (exit 2), oversized or
 * malformed output. The publisher refuses to publish on `unavailable` in
 * production; it never reads `unavailable` as "the rules are fine".
 *
 * Runs inside the caller's request transaction (rule edits are rare admin
 * actions). Concurrency is capped so a burst of edits cannot fork-bomb the API.
 */
import { spawn } from 'node:child_process';

export const YARAC_DEFAULT_PATH = '/usr/local/bin/breeze-yarac';
export const YARAC_TIMEOUT_MS = 30_000;
export const YARAC_MAX_STDOUT_BYTES = 1024 * 1024;
const YARAC_MAX_STDERR_BYTES = 8 * 1024;
const YARAC_MAX_CONCURRENCY = 2;
const MAX_MESSAGE_CHARS = 2000;

export interface YaraPrecheckError {
  /** Empty for a bundle-level error (caps, decode) that no single rule owns. */
  ruleId: string;
  name: string;
  code: string;
  message: string;
  line?: number;
}

export type YaraPrecheckResult =
  | { ok: true }
  | { ok: false; errors: YaraPrecheckError[] }
  | { ok: false; unavailable: string };

/**
 * Open Decision 9's dev escape hatch, shared by every publisher (custom sets
 * and the boot upsert of the built-in pack): lint-only publishing when the
 * pre-check is unavailable is allowed ONLY with NODE_ENV development/test AND
 * BREEZE_YARA_LINT_ONLY=1. An unset NODE_ENV is NOT a dev environment.
 */
export function yaraLintOnlyAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return (env === 'development' || env === 'test') && process.env.BREEZE_YARA_LINT_ONLY === '1';
}

export function yaracPath(): string {
  const configured = process.env.BREEZE_YARAC_PATH?.trim();
  return configured ? configured : YARAC_DEFAULT_PATH;
}

// ---- concurrency gate ------------------------------------------------------

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < YARAC_MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter; `active` is unchanged.
    next();
  } else {
    active--;
  }
}

/**
 * Non-queueing admission to the same gate (#6263 W04-2): the rule test
 * upload must answer "busy" at once instead of buffering a 10 MiB body to
 * wait. Returns an idempotent release, or null when both slots are taken.
 */
export function tryAcquireYaracSlot(): (() => void) | null {
  if (active >= YARAC_MAX_CONCURRENCY) return null;
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

// ---- process runner --------------------------------------------------------

export type RunResult =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'unavailable'; reason: string };

export interface RunYaracOptions {
  timeoutMs?: number;
  /** Kills the child (SIGKILL) and resolves `unavailable: 'aborted'`. */
  signal?: AbortSignal;
  /** The child's whole environment. Default: PATH only. */
  env?: Record<string, string>;
  maxStdoutBytes?: number;
  /**
   * Called once, when the child is GONE ('close', or a spawn that never
   * produced a process). The result can resolve earlier — a timeout or an
   * abort resolves at once — so a caller holding a resource for the child's
   * lifetime releases it here, not when the promise settles.
   */
  onExit?: () => void;
}

export function runYarac(args: string[], stdin: Buffer | string | null, opts: RunYaracOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? YARAC_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? YARAC_MAX_STDOUT_BYTES;
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    opts.onExit?.();
  };
  return new Promise<RunResult>((resolve) => {
    if (opts.signal?.aborted) {
      exitOnce();
      resolve({ kind: 'unavailable', reason: 'aborted' });
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(yaracPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? { PATH: process.env.PATH ?? '' } });
    } catch (err) {
      exitOnce();
      resolve({ kind: 'unavailable', reason: errorCode(err) });
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'unavailable', reason: 'timeout' });
    }, timeoutMs);
    if (opts.signal) {
      onAbort = () => {
        child.kill('SIGKILL');
        finish({ kind: 'unavailable', reason: 'aborted' });
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const out: Buffer[] = [];
    let outBytes = 0;
    const errChunks: Buffer[] = [];
    let errBytes = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        child.kill('SIGKILL');
        finish({ kind: 'unavailable', reason: 'stdout_too_large' });
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < YARAC_MAX_STDERR_BYTES) {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on('error', (err) => {
      // A spawn failure (ENOENT, EACCES) has no process and may never 'close'.
      if (child.pid === undefined) exitOnce();
      finish({ kind: 'unavailable', reason: errorCode(err) });
    });
    child.on('close', (code) => {
      exitOnce();
      finish({
        kind: 'exit',
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').slice(0, YARAC_MAX_STDERR_BYTES),
      });
    });

    if (child.stdin) {
      // EPIPE when the child dies before reading is reported by 'close'/'error'.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin ?? '');
    }
  });
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.message.slice(0, 200) : 'spawn_failed';
}

// ---- validate --------------------------------------------------------------

export function parseRuleErrors(raw: unknown): YaraPrecheckError[] | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { errors?: unknown }).errors)) return null;
  const errors: YaraPrecheckError[] = [];
  for (const e of (raw as { errors: unknown[] }).errors) {
    if (typeof e !== 'object' || e === null) return null;
    const { ruleId, name, code, message, line } = e as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return null;
    const out: YaraPrecheckError = {
      ruleId: typeof ruleId === 'string' ? ruleId : '',
      name: typeof name === 'string' ? name : '',
      code: code.slice(0, 64),
      message: message.slice(0, MAX_MESSAGE_CHARS),
    };
    if (typeof line === 'number' && Number.isInteger(line) && line > 0) out.line = line;
    errors.push(out);
  }
  return errors;
}

/** First 120 printable chars of tool output, for server logs (never sent to clients). */
function snippet(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 120) || 'empty';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface YaraPrecheckOptions {
  /**
   * Overrides YARAC_TIMEOUT_MS. The boot upsert of the 500-rule built-in pack
   * runs outside any request and compiles far more rules than an edit does.
   */
  timeoutMs?: number;
}

export async function precheckYaraBundle(json: string, opts: YaraPrecheckOptions = {}): Promise<YaraPrecheckResult> {
  await acquire();
  let run: RunResult;
  try {
    run = await runYarac(['validate'], json, { timeoutMs: opts.timeoutMs ?? YARAC_TIMEOUT_MS });
  } finally {
    release();
  }
  if (run.kind === 'unavailable') return { ok: false, unavailable: run.reason };

  const parsed = parseJson(run.stdout.trim());
  if (run.code === 0) {
    if ((parsed as { ok?: unknown } | undefined)?.ok === true) return { ok: true };
    return { ok: false, unavailable: `bad_output: exit 0 without ok:true (${snippet(run.stdout)})` };
  }
  if (run.code === 1) {
    const errors = parseRuleErrors(parsed);
    if (errors && errors.length > 0) return { ok: false, errors };
    return { ok: false, unavailable: `bad_output: exit 1 without a rule error list (${snippet(run.stdout)})` };
  }
  const stderr = run.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
  return { ok: false, unavailable: `exit_${run.code ?? 'signal'}${stderr ? `: ${stderr}` : ''}` };
}

// ---- version ---------------------------------------------------------------

export interface YaracVersion {
  engine: string;
  policy: number;
}

let versionMemo: YaracVersion | null = null;

/** `breeze-yarac version`; memoized on success only. null when it cannot run. */
export async function yaracVersion(): Promise<YaracVersion | null> {
  if (versionMemo) return versionMemo;
  await acquire();
  let run: RunResult;
  try {
    run = await runYarac(['version'], null);
  } finally {
    release();
  }
  if (run.kind !== 'exit' || run.code !== 0) return null;
  const parsed = parseJson(run.stdout.trim()) as { engine?: unknown; policy?: unknown } | undefined;
  if (typeof parsed?.engine !== 'string' || typeof parsed.policy !== 'number' || !Number.isInteger(parsed.policy)) {
    return null;
  }
  versionMemo = { engine: parsed.engine.slice(0, 64), policy: parsed.policy };
  return versionMemo;
}

// ---- availability ----------------------------------------------------------

/** How long a failed availability probe is trusted before probing again. */
export const YARAC_UNAVAILABLE_RECHECK_MS = 60_000;
let unavailableUntil = 0;

/**
 * Can this server run the pre-check at all (#10306)? Read paths use it to
 * tell a set that is unpublished because the compiler is missing apart from
 * one whose rules have errors. A success is memoized by `yaracVersion`; a
 * failure is cached for YARAC_UNAVAILABLE_RECHECK_MS so a list of stale sets
 * does not spawn a child per request, yet an installed binary is noticed.
 */
export async function yaracAvailable(): Promise<boolean> {
  if (versionMemo) return true;
  if (Date.now() < unavailableUntil) return false;
  if (await yaracVersion()) return true;
  unavailableUntil = Date.now() + YARAC_UNAVAILABLE_RECHECK_MS;
  return false;
}

export function __resetYaracForTests(): void {
  versionMemo = null;
  unavailableUntil = 0;
  active = 0;
  waiters.length = 0;
}
