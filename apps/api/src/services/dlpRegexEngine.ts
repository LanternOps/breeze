/**
 * RE2-backed compile/match helpers for tenant-authored DLP custom-rule
 * regexes (spec §6). RE2 (google/re2, here via the pure-WASM `re2-wasm`
 * binding — no native addon) matches in time linear in input length: it
 * simulates an NFA instead of backtracking, so there is no pattern shape
 * that can make a single `.exec()` call run in exponential time. This
 * replaces catastrophic-backtracking DETECTION (a heuristic that can always
 * miss a shape) with an engine that
 * makes the failure mode structurally impossible on the paths that use it.
 *
 * The tradeoff: RE2's language is a strict subset of JS regex — no
 * backreferences (`\1`) and no lookaround assertions (`(?=`, `(?!`, `(?<=`,
 * `(?<!`). Those compile-time rejections are mapped to stable reason
 * strings below rather than left as raw RE2 error text.
 *
 * This module is server-only (apps/api). `re2-wasm` is not a dependency of
 * `packages/shared`, deliberately — that package's DLP validators
 * (`validateRegexSafety`/`validateDlpPattern`) are also called from the
 * browser-side policy editor for instant feedback (see that module's
 * header), and must stay WASM-free.
 */

import { RE2, type RE2ExecArray } from 're2-wasm';

export type Re2CompileResult = { ok: true; re: RE2 } | { ok: false; reason: string };

/**
 * Compile `pattern` with RE2 in global, unicode mode (the flags the engine
 * matches with). Never throws — a compile failure is reported as `{ ok:
 * false }` with a stable, non-sensitive reason string.
 */
export function compileRe2(pattern: string): Re2CompileResult {
  try {
    const re = new RE2(pattern, 'gu');
    return { ok: true, re };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/escape sequence/i.test(message)) {
      return { ok: false, reason: 'backreference_not_allowed' };
    }
    if (/perl operator/i.test(message)) {
      return { ok: false, reason: 'lookaround_not_allowed' };
    }
    return { ok: false, reason: 'unsupported_by_re2' };
  }
}

export interface Re2MatchSpan {
  start: number;
  end: number;
}

/**
 * Every non-zero-width match of `re` (must be compiled with the global
 * flag) against `text`, as `{ start, end }` spans — the RE2 analogue of
 * `[...text.matchAll(re)]`. Zero-width matches are skipped rather than
 * emitted (nothing to redact) but still advance the scan position by one
 * code unit, mirroring how `String.prototype.matchAll` avoids stalling on
 * an all-optional pattern.
 */
export function execAllRe2(re: RE2, text: string): Re2MatchSpan[] {
  re.lastIndex = 0;
  const out: Re2MatchSpan[] = [];
  let match: RE2ExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const length = (match[0] ?? '').length;
    if (length === 0) {
      re.lastIndex = start + 1;
      if (re.lastIndex > text.length) break;
      continue;
    }
    out.push({ start, end: start + length });
  }
  return out;
}
