/**
 * RE2-backed compile/match helpers for tenant-authored DLP custom-pattern
 * regexes, scanned on the workspace content pipeline's hot path
 * (`../content/dlp.ts`). See the identical apps/api module
 * (`apps/api/src/services/dlpRegexEngine.ts`) for the full rationale —
 * cross-repo import isn't possible (open-core boundary), so this is a
 * deliberate local reimplementation, not duplication to flag, mirroring how
 * `../content/dlp.ts` already reimplements the client-ai DLP engine.
 *
 * RE2 (google/re2, via the pure-WASM `re2-wasm` binding — no native addon)
 * matches in time linear in input length: it simulates an NFA instead of
 * backtracking, so no pattern shape can make a single `.exec()` call run in
 * exponential time. It does not support backreferences or lookaround
 * assertions; those compile failures are mapped to stable reason strings.
 */

import { RE2, type RE2ExecArray } from 're2-wasm';

export type Re2CompileResult = { ok: true; re: RE2 } | { ok: false; reason: string };

/**
 * Compile `pattern` with RE2 in global, unicode mode. Never throws — a
 * compile failure is reported as `{ ok: false }` with a stable reason.
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
 * Every non-zero-width match of `re` (compiled with the global flag)
 * against `text`, as `{ start, end }` spans — the RE2 analogue of
 * `[...text.matchAll(re)]`.
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
