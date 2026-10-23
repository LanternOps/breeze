/**
 * Rule test upload runner (#6263 W04-2): `breeze-yarac match` scans one
 * customer-supplied sample IN MEMORY inside the API container, under the
 * Landlock + seccomp sandbox the binary applies to itself
 * (agent/cmd/breeze-yarac/sandbox_linux.go). The sample is never written to
 * disk: it goes to the child's stdin, framed as a 4-byte big-endian bundle
 * length, the bundle JSON, then the sample bytes.
 *
 * Admission is non-queueing and happens BEFORE the route reads the body:
 * one match at a time per API instance, which also holds one slot of W03's
 * shared yarac gate (so at most two engines — validate or match — ever run
 * at once). The reservation is released when the child has EXITED, never
 * when the timeout fires or the client disconnects (both kill it first).
 *
 * Fails closed: exit 3 (any sandbox step failed, incl. no Landlock) is
 * `sandboxUnavailable`; a missing binary, timeout, crash, engine failure or
 * malformed output is `unavailable`. Neither is ever read as "no matches".
 */
import { parseRuleErrors, runYarac, tryAcquireYaracSlot, type YaraPrecheckError } from './yaraPrecheck';

/**
 * Child timeout. The plan's 20 s was raised to W03 validate's 30 s: engine
 * start-up alone measured ~9.5 s in the API image (arm64); the engine's own
 * per-scan timeout inside `match` is 15 s.
 */
export const YARA_MATCH_TIMEOUT_MS = 30_000;
/** 500 matching rules × 10 strings × ≤ 512 escaped chars fits. */
const YARA_MATCH_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_TAGS = 32;
const MAX_MATCHED_STRINGS = 10;
/** The agent caps matched data at 128 bytes before `\xNN` escaping (≤ 512 chars). */
const MAX_MATCHED_DATA_CHARS = 512;
const MAX_IDENT_CHARS = 128;

export interface YaraSampleMatch {
  ruleSetId: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  tags: string[];
  matchedStrings: Array<{ id: string; offset: number; data: string }>;
}

export type YaraSampleMatchResult =
  | { ok: true; matches: YaraSampleMatch[]; durationMs: number }
  | { ok: false; errors: YaraPrecheckError[] }
  | { ok: false; unavailable: string }
  | { ok: false; sandboxUnavailable: true; detail: string };

export interface YaraMatchReservation {
  /** Idempotent. matchSample calls it when the child exits. */
  release(): void;
}

let matchBusy = false;

/** The process-wide match slot plus a shared yarac slot — both, or neither (null = busy). */
export function reserveSampleMatch(): YaraMatchReservation | null {
  if (matchBusy) return null;
  const releaseSlot = tryAcquireYaracSlot();
  if (!releaseSlot) return null;
  matchBusy = true;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      matchBusy = false;
      releaseSlot();
    },
  };
}

/**
 * The dev escape hatch (macOS has no Landlock): passed to the child only when
 * NODE_ENV is development/test AND the API itself has
 * BREEZE_YARA_TEST_UNSANDBOXED=1 — the rule `yaraLintOnlyAllowed()` uses. An
 * unset NODE_ENV is not a dev environment.
 */
export function yaraTestUnsandboxedAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return (env === 'development' || env === 'test') && process.env.BREEZE_YARA_TEST_UNSANDBOXED === '1';
}

export interface MatchSampleInput {
  bundleJson: string;
  filename: string;
  /** Virtual device path for the `filepath` global (defaults to the filename in the binary). */
  filepath?: string;
  sample: Buffer;
  /** The request's abort signal: a client disconnect kills the child. */
  signal?: AbortSignal;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function parseMatches(raw: unknown): YaraSampleMatch[] | null {
  if (!Array.isArray(raw)) return null;
  const out: YaraSampleMatch[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    const ruleSetId = str(r.ruleSetId, MAX_IDENT_CHARS);
    const ruleId = str(r.ruleId, MAX_IDENT_CHARS);
    const ruleName = str(r.ruleName, MAX_IDENT_CHARS);
    const severity = str(r.severity, 32);
    if (ruleSetId === null || ruleId === null || ruleName === null || severity === null) continue;
    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === 'string').slice(0, MAX_TAGS).map((t) => t.slice(0, MAX_IDENT_CHARS))
      : [];
    const matchedStrings: YaraSampleMatch['matchedStrings'] = [];
    if (Array.isArray(r.matchedStrings)) {
      for (const s of r.matchedStrings) {
        if (matchedStrings.length >= MAX_MATCHED_STRINGS) break;
        if (typeof s !== 'object' || s === null) continue;
        const { id, offset, data } = s as Record<string, unknown>;
        if (typeof id !== 'string' || typeof data !== 'string') continue;
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) continue;
        matchedStrings.push({ id: id.slice(0, MAX_IDENT_CHARS), offset, data: data.slice(0, MAX_MATCHED_DATA_CHARS) });
      }
    }
    out.push({ ruleSetId, ruleId, ruleName, severity, tags, matchedStrings });
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 200) ?? '';
}

/**
 * Runs `breeze-yarac match` on one sample. `reservation` (from
 * reserveSampleMatch) is consumed: it is released when the child exits, on
 * every path.
 */
export async function matchSample(reservation: YaraMatchReservation, input: MatchSampleInput): Promise<YaraSampleMatchResult> {
  const bundle = Buffer.from(input.bundleJson, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bundle.length, 0);
  // `--flag=value`: a filename starting with "-" can never be read as a flag.
  const args = ['match', `--filename=${input.filename}`];
  if (input.filepath) args.push(`--filepath=${input.filepath}`);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (yaraTestUnsandboxedAllowed()) env.BREEZE_YARA_TEST_UNSANDBOXED = '1';

  const run = await runYarac(args, Buffer.concat([header, bundle, input.sample]), {
    timeoutMs: YARA_MATCH_TIMEOUT_MS,
    maxStdoutBytes: YARA_MATCH_MAX_STDOUT_BYTES,
    signal: input.signal,
    env,
    onExit: () => reservation.release(),
  });
  if (run.kind === 'unavailable') return { ok: false, unavailable: run.reason };

  // Exit 3 is reserved for "a sandbox step failed; nothing was scanned".
  if (run.code === 3) return { ok: false, sandboxUnavailable: true, detail: firstLine(run.stderr) || 'sandbox unavailable' };

  const parsed = parseJson(run.stdout.trim()) as Record<string, unknown> | undefined;
  if (run.code === 0) {
    const matches = parsed?.ok === true ? parseMatches(parsed.matches) : null;
    if (!matches) return { ok: false, unavailable: 'bad_output: exit 0 without ok:true and a match list' };
    const durationMs = typeof parsed?.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0
      ? Math.round(parsed.durationMs)
      : 0;
    return { ok: true, matches, durationMs };
  }
  if (run.code === 1) {
    const errors = parseRuleErrors(parsed);
    if (errors && errors.length > 0) return { ok: false, errors };
    return { ok: false, unavailable: 'bad_output: exit 1 without a rule error list' };
  }
  const stderr = firstLine(run.stderr);
  return { ok: false, unavailable: `exit_${run.code ?? 'signal'}${stderr ? `: ${stderr}` : ''}` };
}

export function __resetSampleMatchForTests(): void {
  matchBusy = false;
}
