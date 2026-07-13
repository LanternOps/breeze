/**
 * Backup file-mode exclusion-glob dialect — the TS side of a two-sided contract.
 *
 * The Go agent decides what a backup exclusion pattern means
 * (`agent/internal/backup/exclude.go`). This module mirrors that decision so the
 * API can reject a pattern the agent would silently drop, BEFORE it is persisted
 * and shipped to the fleet.
 *
 * ## The dialect is NOT `doublestar`
 *
 * Despite the `**` support, the agent does not use the `bmatcuk/doublestar`
 * library. It hand-rolls a segment walker over Go's **stdlib `path.Match`**, so
 * the real grammar is `path.Match`'s — which differs from `doublestar`,
 * `minimatch`, and bash in ways that matter (see BACKUP_EXCLUSION_CONTRACT
 * fixtures). Validating with `minimatch` would be wrong in both directions.
 *
 * Two rules follow from the agent's normalization order, and a naive port gets
 * both wrong:
 *
 *  1. **Backslash is never an escape.** `path.Match` treats `\` as an escape
 *     character, but the agent rewrites every `\` to `/` *before* matching
 *     (so Windows-style `AppData\Local` works). By the time `path.Match` sees a
 *     pattern there are no backslashes left. `foo\*bar` is a two-segment path
 *     pattern, not an escaped star.
 *  2. **Slash patterns are validated per segment, not as a whole string.** The
 *     agent splits on `/` and calls `path.Match` on each segment, so `a[x/y]b`
 *     — a legal glob as one string — splits into the malformed segments `a[x`
 *     and `y]b` and is rejected.
 *
 * ## Conservative by construction
 *
 * `describeExclusionPattern` reports a pattern invalid **only** when the agent's
 * own matcher would refuse to compile it. Reversed ranges (`[z-a]`), `[!...]`
 * (literal `!` in `path.Match`, not a negation), and other merely-unusual
 * patterns are reported valid, because the agent accepts them. Over-strict
 * validation would break a working policy save; that is the worse failure.
 *
 * Anything exported here is pinned by `backup-exclusion-contract.json`, which is
 * replayed against the REAL agent matcher in
 * `agent/internal/backup/exclude_contract_test.go`. If the two dialects ever
 * drift apart, that Go test and `backupExclusionGlob.test.ts` both go red.
 */

/** Longest pattern we accept. Guards the O(segments) matcher from silly input. */
export const MAX_EXCLUSION_PATTERN_LENGTH = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Faithful port of Go's stdlib `path.Match` (go/src/path/match.go).
//
// Ported literally, including the Go 1.16 fix that makes ErrBadPattern
// independent of the name being matched (the trailing "validate the remainder of
// the pattern" loop). That independence is what lets the agent — and us — probe
// validity with a fixed dummy name.
//
// Operates on code points (Array.from) because Go's getEsc decodes runes: the
// range `[α-ω]` must compare whole runes, not UTF-16 code units.
// ─────────────────────────────────────────────────────────────────────────────

/** ErrBadPattern sentinel. `bad` means "syntax error", not "did not match". */
interface MatchResult {
  matched: boolean;
  bad: boolean;
}

interface ChunkResult {
  rest: string[];
  ok: boolean;
  bad: boolean;
}

interface EscResult {
  r: string;
  nchunk: string[];
  bad: boolean;
}

const BAD_ESC: EscResult = { r: '', nchunk: [], bad: true };
const BAD_CHUNK: ChunkResult = { rest: [], ok: false, bad: true };

function codePoints(s: string): string[] {
  return Array.from(s);
}

function ord(c: string): number {
  return c.codePointAt(0) ?? -1;
}

/** Go: getEsc — reads one (possibly escaped) rune of a character class. */
function getEsc(chunk: string[]): EscResult {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') {
    return BAD_ESC;
  }
  let rest = chunk;
  if (rest[0] === '\\') {
    rest = rest.slice(1);
    if (rest.length === 0) return BAD_ESC;
  }
  const r = rest[0]!; // guarded: rest is non-empty here
  const nchunk = rest.slice(1);
  // Go errors when the class has no room left for its closing ']'.
  if (nchunk.length === 0) return BAD_ESC;
  return { r, nchunk, bad: false };
}

/** Go: scanChunk — splits off the leading '*'s and the next literal chunk. */
function scanChunk(pattern: string[]): { star: boolean; chunk: string[]; rest: string[] } {
  let p = pattern;
  let star = false;
  while (p.length > 0 && p[0] === '*') {
    p = p.slice(1);
    star = true;
  }
  let inrange = false;
  let i = 0;
  for (i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      if (i + 1 < p.length) i++;
    } else if (ch === '[') {
      inrange = true;
    } else if (ch === ']') {
      inrange = false;
    } else if (ch === '*') {
      if (!inrange) break;
    }
  }
  return { star, chunk: p.slice(0, i), rest: p.slice(i) };
}

/** Go: matchChunk — matches a star-free chunk, still parsing after a mismatch. */
function matchChunk(chunkIn: string[], sIn: string[]): ChunkResult {
  let chunk = chunkIn;
  let s = sIn;
  // Go: "After the match fails, the loop continues on processing chunk,
  // checking that the pattern is well-formed but no longer reading s."
  let failed = false;

  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;

    if (chunk[0] === '[') {
      let r = '';
      if (!failed) {
        // !failed implies s is non-empty (the guard at the top of the loop).
        r = s[0]!;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === '^') {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === ']' && nrange > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const lo = getEsc(chunk);
        if (lo.bad) return BAD_CHUNK;
        chunk = lo.nchunk;
        let hi = lo.r;
        // getEsc guarantees a non-empty remainder, so chunk[0] is safe here.
        if (chunk[0] === '-') {
          const h = getEsc(chunk.slice(1));
          if (h.bad) return BAD_CHUNK;
          hi = h.r;
          chunk = h.nchunk;
        }
        // NOTE: Go does NOT reject an inverted range (`[z-a]`); it simply never
        // matches. We must not reject it either.
        if (!failed && ord(lo.r) <= ord(r) && ord(r) <= ord(hi)) match = true;
        nrange++;
      }
      if (match === negated) failed = true;
      continue;
    }

    if (chunk[0] === '?') {
      if (!failed) {
        if (s[0] === '/') failed = true;
        else s = s.slice(1);
      }
      chunk = chunk.slice(1);
      continue;
    }

    if (chunk[0] === '\\') {
      chunk = chunk.slice(1);
      if (chunk.length === 0) return BAD_CHUNK;
      // Go falls through to the literal case.
    }

    if (!failed) {
      if (chunk[0] !== s[0]) failed = true;
      else s = s.slice(1);
    }
    chunk = chunk.slice(1);
  }

  if (failed) return { rest: [], ok: false, bad: false };
  return { rest: s, ok: true, bad: false };
}

/**
 * Go `path.Match`. `bad: true` is Go's ErrBadPattern.
 *
 * Exported for the contract test — application code should use
 * `describeExclusionPattern` / `compileExcludeMatcher`.
 */
export function goPathMatch(pattern: string, name: string): MatchResult {
  let pat = codePoints(pattern);
  let nm = codePoints(name);

  while (pat.length > 0) {
    const { star, chunk, rest } = scanChunk(pat);
    pat = rest;

    if (star && chunk.length === 0) {
      // Trailing '*' matches the rest of the name unless it contains a '/'.
      return { matched: !nm.includes('/'), bad: false };
    }

    const mc = matchChunk(chunk, nm);
    if (mc.bad) return { matched: false, bad: true };
    if (mc.ok && (mc.rest.length === 0 || pat.length > 0)) {
      nm = mc.rest;
      continue;
    }

    if (star) {
      let advanced = false;
      for (let i = 0; i < nm.length && nm[i] !== '/'; i++) {
        const m2 = matchChunk(chunk, nm.slice(i + 1));
        if (m2.bad) return { matched: false, bad: true };
        if (m2.ok) {
          if (pat.length === 0 && m2.rest.length > 0) continue;
          nm = m2.rest;
          advanced = true;
          break;
        }
      }
      if (advanced) continue;
    }

    // Go 1.16+: before returning "no match", still prove the remainder parses.
    // This is what makes ErrBadPattern name-independent.
    while (pat.length > 0) {
      const sc = scanChunk(pat);
      pat = sc.rest;
      const m3 = matchChunk(sc.chunk, []);
      if (m3.bad) return { matched: false, bad: true };
    }
    return { matched: false, bad: false };
  }

  return { matched: nm.length === 0, bad: false };
}

/** Is `segment` a syntactically legal single-segment `path.Match` glob? */
function isValidGlobSegment(segment: string): boolean {
  // ErrBadPattern is name-independent (Go 1.16+), so a fixed probe is
  // exhaustive — the same trick the agent uses.
  return !goPathMatch(segment, 'probe').bad;
}

// ─────────────────────────────────────────────────────────────────────────────
// Port of the agent's excludeMatcher (agent/internal/backup/exclude.go)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The agent's pattern normalization, exactly: trim whitespace, fold Windows
 * separators to '/', then strip leading/trailing '/'.
 *
 * Order matters. Folding before trimming '/' is why a trailing backslash
 * (`temp\`) is a harmless trailing separator rather than Go's "trailing escape"
 * syntax error.
 */
export function normalizeExclusionPattern(raw: string): string {
  const folded = raw.trim().replaceAll('\\', '/');
  // Strip leading and trailing '/' (Go: strings.Trim(p, "/")).
  return folded.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Why the agent would not use a pattern. */
export type ExclusionPatternProblem =
  | 'empty' // normalizes away to nothing — agent skips it silently
  | 'too_long' // API-only guard; the agent has no length limit
  | 'syntax'; // agent logs "ignoring invalid exclusion pattern" and drops it

export interface ExclusionPatternVerdict {
  /** Normalized form the agent would actually compile. */
  normalized: string;
  /** True when the agent would compile and use this pattern. */
  usable: boolean;
  problem?: ExclusionPatternProblem;
  /** Human-facing explanation. Only set when `usable` is false. */
  message?: string;
}

/**
 * Decide whether the agent would compile this pattern, or silently drop it.
 *
 * This is the single source of truth for API-boundary validation. It is
 * deliberately permissive: it only reports `syntax` for patterns the agent's own
 * `path.Match` call rejects.
 */
export function describeExclusionPattern(raw: string): ExclusionPatternVerdict {
  const normalized = normalizeExclusionPattern(raw);

  if (normalized === '') {
    return {
      normalized,
      usable: false,
      problem: 'empty',
      message: 'Pattern is empty.',
    };
  }

  if (normalized.length > MAX_EXCLUSION_PATTERN_LENGTH) {
    return {
      normalized,
      usable: false,
      problem: 'too_long',
      message: `Pattern is longer than ${MAX_EXCLUSION_PATTERN_LENGTH} characters.`,
    };
  }

  // Slash patterns are validated per segment — mirroring the agent, which
  // matches them per segment. `a[x/y]b` is a legal one-string glob but splits
  // into the malformed segments `a[x` and `y]b`.
  const segments = normalized.includes('/') ? normalized.split('/') : [normalized];

  for (const segment of segments) {
    if (segment === '**') continue; // doublestar spans segments; not a glob itself
    if (segment === '') {
      // Interior empty segment from `a//b`. Cannot ever match a real path
      // segment, so the agent rejects the whole pattern.
      return {
        normalized,
        usable: false,
        problem: 'syntax',
        message: 'Pattern contains an empty path segment (e.g. "a//b").',
      };
    }
    if (!isValidGlobSegment(segment)) {
      return {
        normalized,
        usable: false,
        problem: 'syntax',
        message: describeSegmentSyntaxError(segment),
      };
    }
  }

  return { normalized, usable: true };
}

/**
 * Best-effort explanation of WHY a segment failed to parse.
 *
 * Purely cosmetic — the accept/reject decision above is made by the ported
 * matcher, never by these heuristics. The goal is that a tech pasting
 * `[a-z0-9_-].log` gets told about the trailing dash instead of "syntax error".
 */
function describeSegmentSyntaxError(segment: string): string {
  const quoted = `"${segment}"`;

  // Unclosed '[' is by far the most common mistake.
  if (segment.includes('[') && !segment.includes(']')) {
    return `Unclosed character class in ${quoted} — add a closing "]" or escape the "[".`;
  }
  if (/\[\^?\]/.test(segment)) {
    return `Empty character class in ${quoted} — a "[...]" class must list at least one character.`;
  }
  // The classic: bash/minimatch allow a leading or trailing '-' to mean a
  // literal dash. Go's path.Match does not.
  if (/\[\^?-/.test(segment) || /-\]/.test(segment)) {
    return `Character class in ${quoted} has a leading or trailing "-". This backup matcher does not allow a literal dash there — move it into the middle of the class or drop it (e.g. "[a-z0-9_]").`;
  }
  return `Invalid glob syntax in ${quoted}.`;
}

/** Convenience predicate used by the zod refinements. */
export function isUsableExclusionPattern(raw: string): boolean {
  return describeExclusionPattern(raw).usable;
}

/**
 * Drop the patterns the agent would drop anyway (blank lines from a textarea).
 *
 * The API strips these instead of rejecting them: a blank pattern excludes
 * nothing, so rejecting it would fail a save over an artifact of how the UI
 * splits input — the exact over-strict failure this feature must avoid.
 */
export function stripEmptyExclusionPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => normalizeExclusionPattern(p) !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
// The matcher itself. Not used for validation — this exists so the contract
// fixtures can assert MATCH SEMANTICS (not just validity) against real Go, and
// so the UI can eventually preview "what would this exclude?".
// ─────────────────────────────────────────────────────────────────────────────

export interface ExcludeMatcher {
  matches(relPath: string): boolean;
}

/**
 * Go: path.Base. Differs from "last element of split" on a trailing slash —
 * path.Base("a/") is "a", not "". Mirrored so the two matchers cannot drift.
 */
function goPathBase(p: string): string {
  if (p === '') return '.';
  let s = p.replace(/\/+$/, '');
  if (s === '') return '/';
  const i = s.lastIndexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  return s === '' ? '/' : s;
}

/** Go: matchSegments — '**' spans zero or more path segments. */
function matchSegments(pattern: string[], segs: string[]): boolean {
  let pat = pattern;
  let rest = segs;
  while (pat.length > 0) {
    if (pat[0] === '**') {
      while (pat.length > 0 && pat[0] === '**') pat = pat.slice(1);
      if (pat.length === 0) return true; // trailing '**' matches everything
      for (let i = 0; i <= rest.length; i++) {
        if (matchSegments(pat, rest.slice(i))) return true;
      }
      return false;
    }
    if (rest.length === 0) return false;
    const m = goPathMatch(pat[0]!, rest[0]!); // both guarded non-empty above
    if (m.bad || !m.matched) return false;
    pat = pat.slice(1);
    rest = rest.slice(1);
  }
  return rest.length === 0;
}

/**
 * Compile exclusion patterns the way the agent does.
 *
 * Returns `null` when no usable pattern remains — the agent's nil matcher,
 * meaning "exclude nothing". Invalid patterns are DROPPED here, not thrown, to
 * mirror the agent (which logs and continues rather than failing the backup).
 *
 * @param caseInsensitive Agent passes `runtime.GOOS == "windows"`.
 */
export function compileExcludeMatcher(
  patterns: string[],
  caseInsensitive: boolean,
): ExcludeMatcher | null {
  const baseName: string[] = [];
  const relPath: string[][] = [];

  for (const raw of patterns) {
    let p = normalizeExclusionPattern(raw);
    if (p === '') continue;
    if (caseInsensitive) p = p.toLowerCase();

    if (p.includes('/')) {
      const segs = p.split('/');
      if (!segs.every((s) => s === '**' || (s !== '' && isValidGlobSegment(s)))) {
        continue; // agent logs + skips
      }
      // Implicit leading '**/' — patterns match at any depth (gitignore-style).
      relPath.push(['**', ...segs]);
    } else {
      if (!isValidGlobSegment(p)) continue;
      baseName.push(p);
    }
  }

  if (baseName.length === 0 && relPath.length === 0) return null;

  return {
    matches(relPathIn: string): boolean {
      if (relPathIn === '' || relPathIn === '.') return false;
      let rel = relPathIn.replaceAll('\\', '/');
      if (caseInsensitive) rel = rel.toLowerCase();

      const segs = rel.split('/');
      const base = goPathBase(rel);
      for (const p of baseName) {
        if (goPathMatch(p, base).matched) return true;
      }

      if (relPath.length === 0) return false;
      for (const patSegs of relPath) {
        if (matchSegments(patSegs, segs)) return true;
      }
      return false;
    },
  };
}
