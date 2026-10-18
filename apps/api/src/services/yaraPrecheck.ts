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

// ---- process runner --------------------------------------------------------

type RunResult =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'unavailable'; reason: string };

function runYarac(args: string[], stdin: string | null): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(yaracPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    } catch (err) {
      resolve({ kind: 'unavailable', reason: errorCode(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'unavailable', reason: 'timeout' });
    }, YARAC_TIMEOUT_MS);

    const out: Buffer[] = [];
    let outBytes = 0;
    const errChunks: Buffer[] = [];
    let errBytes = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > YARAC_MAX_STDOUT_BYTES) {
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
    child.on('error', (err) => finish({ kind: 'unavailable', reason: errorCode(err) }));
    child.on('close', (code) => {
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

function parseRuleErrors(raw: unknown): YaraPrecheckError[] | null {
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function precheckYaraBundle(json: string): Promise<YaraPrecheckResult> {
  await acquire();
  let run: RunResult;
  try {
    run = await runYarac(['validate'], json);
  } finally {
    release();
  }
  if (run.kind === 'unavailable') return { ok: false, unavailable: run.reason };

  const parsed = parseJson(run.stdout.trim());
  if (run.code === 0) {
    if ((parsed as { ok?: unknown } | undefined)?.ok === true) return { ok: true };
    return { ok: false, unavailable: 'bad_output: exit 0 without ok:true' };
  }
  if (run.code === 1) {
    const errors = parseRuleErrors(parsed);
    if (errors && errors.length > 0) return { ok: false, errors };
    return { ok: false, unavailable: 'bad_output: exit 1 without a rule error list' };
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

export function __resetYaracForTests(): void {
  versionMemo = null;
  active = 0;
  waiters.length = 0;
}
