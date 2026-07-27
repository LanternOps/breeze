/**
 * Guard: no raw numeric coercion of `process.env` in apps/api source (#2823).
 *
 * The class of bug this exists to prevent:
 *
 * ```ts
 * const drainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? '5000'); // WRONG -> 0
 * ```
 *
 * That reader is only safe while the variable is genuinely ABSENT. Our compose
 * files thread every variable in explicitly, and an unset one is written as
 * `VAR: ${VAR:-}` — which `docker compose config` renders as `VAR: ""`. The
 * container therefore sees the variable SET to an empty string. `??` does not
 * fire on `''`, and `Number('') === 0`, so the reader silently yields **0**
 * instead of its default: a 0ms drain, a 0-minute TTL, a 0-row cap.
 *
 * This nearly shipped in #2819, where two enrollment TTL readers of exactly
 * this shape would have minted every installer bootstrap token and every
 * redeemed child enrollment key already-expired on any self-host that pulled
 * the release without adding the new keys to its `.env`.
 *
 * Two rules, both mechanical:
 *
 *   1. `Number(process.env...)` is banned outright. Use `envInt` / `envFloat`
 *      (`./envInt.ts`, `./envFloat.ts`), which treat `''` as absent.
 *   2. `parseInt(...)` / `parseFloat(...)` over a `process.env` read may only
 *      use `?? ''` as its nullish fallback. `?? '15'` is dead code — `??`
 *      never fires on the empty string, so you get `parseInt('')` = `NaN`.
 *      (`|| '15'` IS safe, because `||` does fire on `''`, and is allowed.)
 *
 * There is deliberately NO allowlist: after the #2823 sweep there are zero
 * violations, and no genuinely-correct exception is known. If one ever
 * appears, adding an allowlist is a reviewed change to this file.
 *
 * The self-check block at the bottom is load-bearing. A grep guard whose
 * pattern silently matches nothing is the classic failure mode here, so the
 * detector is exercised against synthetic violating AND non-violating sources,
 * and the file walk asserts it actually saw the tree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', '__mocks__']);

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listSourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Blank out comment bodies while leaving string literals intact.
 *
 * Both matter. Comments must be blanked because the helper docs (and this
 * file) quote the forbidden pattern verbatim as the thing NOT to write —
 * a naive grep flags its own documentation. String literals must be kept
 * because rule 2 needs to see whether a `??` fallback is `''`, and because
 * a `//` inside a string (`'http://host/v1'`) must not swallow the rest of
 * the line and hide a real violation after it.
 *
 * Regex literals are tracked too, so the `//` inside `/^https?:\/\//` is not
 * mistaken for a line comment (which would blank the rest of that line and
 * could hide a real violation after it).
 *
 * Newlines are preserved so reported line numbers stay accurate.
 */
export function blankComments(source: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let state: State = 'code';

  // Rolling tail of the last few emitted code characters, so the regex-literal
  // heuristic below is O(1) per character rather than re-scanning `out`.
  let tail = '';
  const pushTail = (c: string) => {
    tail = (tail + c).slice(-8);
  };

  // A `/` starts a regex literal (rather than division) only where a value is
  // not already on the stack — i.e. at the start of an expression, after an
  // operator/punctuator, or after `return` / `case` / `typeof`.
  const regexAllowedAfter = /(?:[([{,;:=!&|?+\-*%~^<>]|\breturn|\bcase|\btypeof)$|^$/;

  while (i < source.length) {
    const c = source[i]!; // loop condition guarantees this index exists
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
      } else if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
      } else if (c === '/' && regexAllowedAfter.test(tail.trimEnd())) {
        state = 'regex';
        out += c;
        pushTail(c);
        i += 1;
      } else {
        if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        out += c;
        pushTail(c);
        i += 1;
      }
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    // Inside a string / template / regex literal: copy through verbatim.
    if (c === '\\') {
      out += source.slice(i, i + 2);
      pushTail(' ');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`') ||
      (state === 'regex' && c === '/') ||
      // A regex literal cannot span lines; bail out so a misclassified
      // division operator can never swallow the rest of the file.
      (state === 'regex' && c === '\n')
    ) {
      state = 'code';
    }
    out += c;
    pushTail(c === '\n' ? ' ' : c);
    i += 1;
  }

  return out;
}

export interface EnvCoercionViolation {
  line: number;
  rule: 'number-coercion' | 'nullish-fallback';
  snippet: string;
}

// `(?<![A-Za-z0-9_$.])` keeps `parseEnvBoundedNumber(process.env.X, 85, …)`
// — a safe helper that already handles `''` — from matching on its `Number(`
// suffix.
const NUMBER_CALL = /(?<![A-Za-z0-9_$.])Number\s*\(\s*process\.env\b/g;
const PARSE_CALL = /(?<![A-Za-z0-9_$])(?:parseInt|parseFloat)\s*\(/g;
const EMPTY_STRING_FALLBACK = /^\s*(?:''|"")/;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// Collapse whitespace rather than truncating at the first newline: the
// offending call is often written across several lines, and `parseInt(` on
// its own tells a reader nothing.
function snippetAt(source: string, index: number): string {
  return source.slice(index, index + 110).replace(/\s+/g, ' ').trim();
}

/** Read the balanced argument list of a call whose `(` sits at `openIndex`. */
function readCallArgs(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

export function findRawEnvCoercions(source: string): EnvCoercionViolation[] {
  const code = blankComments(source);
  const violations: EnvCoercionViolation[] = [];

  for (const match of code.matchAll(NUMBER_CALL)) {
    violations.push({
      line: lineOf(code, match.index),
      rule: 'number-coercion',
      snippet: snippetAt(code, match.index),
    });
  }

  for (const match of code.matchAll(PARSE_CALL)) {
    const openIndex = match.index + match[0].length - 1;
    const args = readCallArgs(code, openIndex);
    if (args === null || !args.includes('process.env')) continue;

    const nullishIndex = args.indexOf('??');
    if (nullishIndex === -1) continue;
    if (EMPTY_STRING_FALLBACK.test(args.slice(nullishIndex + 2))) continue;

    violations.push({
      line: lineOf(code, match.index),
      rule: 'nullish-fallback',
      snippet: snippetAt(code, match.index),
    });
  }

  return violations.sort((a, b) => a.line - b.line);
}

describe('no raw numeric coercion of process.env (#2823)', () => {
  const files = listSourceFiles(SRC_ROOT);

  // Vacuity guard: if the walk breaks (wrong root, over-eager skip list) the
  // scan below passes trivially. Pin a floor well under the real count (~1225)
  // but far above anything a broken walk would return.
  it('walks the apps/api source tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith(join('utils', 'envInt.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('jobs', 'offlineDetector.ts')))).toBe(true);
  });

  it('has no violations in apps/api/src', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const violation of findRawEnvCoercions(readFileSync(file, 'utf8'))) {
        offenders.push(
          `${relative(SRC_ROOT, file)}:${violation.line} [${violation.rule}] ${violation.snippet}`
        );
      }
    }

    expect(
      offenders,
      'Raw numeric coercion of process.env yields 0/NaN when compose maps the ' +
        'variable as an empty string. Use envInt/envFloat from src/utils, or ' +
        '`|| \'default\'` (which does fire on \'\'). See the header of this file.'
    ).toEqual([]);
  });

  // ---- detector self-checks: prove the guard discriminates, not just passes ----

  describe('detector self-check', () => {
    it('flags the exact shape from #2819/#2823', () => {
      const found = findRawEnvCoercions(
        `const drainMs = Number(process.env.SHUTDOWN_DRAIN_MS ?? '5000');`
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.rule).toBe('number-coercion');
    });

    it('flags Number(process.env.X) even without a fallback', () => {
      expect(findRawEnvCoercions(`const n = Number(process.env.FOO) || 168;`)).toHaveLength(1);
    });

    it('flags Number(process.env[name])', () => {
      expect(findRawEnvCoercions(`const n = Number(process.env[name] ?? 5);`)).toHaveLength(1);
    });

    it('flags a multi-line Number(process.env...) call', () => {
      expect(findRawEnvCoercions(`const n = Number(\n  process.env.FOO ?? 5\n);`)).toHaveLength(1);
    });

    it('flags parseInt with a non-empty nullish fallback', () => {
      const found = findRawEnvCoercions(
        `const ttl = Number.parseInt(process.env.PAM_TTL ?? '15', 10);`
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.rule).toBe('nullish-fallback');
    });

    it('flags parseFloat with a non-empty nullish fallback', () => {
      expect(findRawEnvCoercions(`parseFloat(process.env.RATE ?? '1.5');`)).toHaveLength(1);
    });

    it('flags a nullish fallback built from a call expression', () => {
      expect(
        findRawEnvCoercions(`parseInt(process.env.MS ?? String(DEFAULT_MS), 10);`)
      ).toHaveLength(1);
    });

    it('allows the envInt / envFloat / envStr helpers', () => {
      expect(
        findRawEnvCoercions(
          `const a = envInt('SHUTDOWN_DRAIN_MS', 5000);\n` +
            `const b = envFloat('PRICE', 0);\n` +
            `const c = envStr('SCHEMES', 's3,https');`
        )
      ).toEqual([]);
    });

    it("allows parseInt with the safe `?? ''` idiom", () => {
      expect(
        findRawEnvCoercions(
          `const raw = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);\n` +
            `if (!Number.isFinite(raw) || raw <= 0) return 30;`
        )
      ).toEqual([]);
    });

    it("allows parseInt with a `|| 'default'` fallback (|| fires on '')", () => {
      expect(findRawEnvCoercions(`parseInt(process.env.API_PORT || '3001', 10);`)).toEqual([]);
    });

    it('does not match an identifier merely ending in "Number"', () => {
      expect(
        findRawEnvCoercions(`parseEnvBoundedNumber(process.env.THRESHOLD, 85, 50, 100);`)
      ).toEqual([]);
    });

    it('ignores the pattern inside a line comment', () => {
      expect(
        findRawEnvCoercions(`// never write Number(process.env.X ?? 5000)\nconst a = 1;`)
      ).toEqual([]);
    });

    it('ignores the pattern inside a block comment', () => {
      expect(
        findRawEnvCoercions(`/**\n * const t = Number(process.env.X ?? 1440); // WRONG\n */\nconst a = 1;`)
      ).toEqual([]);
    });

    it('still flags real code that follows a comment quoting the pattern', () => {
      const found = findRawEnvCoercions(
        `// bad: Number(process.env.A ?? 1)\nconst n = Number(process.env.B ?? 2);`
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.line).toBe(2);
    });

    it('does not let a URL inside a string hide a later violation on the same line', () => {
      const found = findRawEnvCoercions(
        `const u = 'http://host/v1'; const n = Number(process.env.X ?? 5);`
      );
      expect(found).toHaveLength(1);
    });

    it('does not let a regex literal containing // hide a later violation', () => {
      const found = findRawEnvCoercions(
        `const re = /^https?:\\/\\//; const n = Number(process.env.X ?? 5);`
      );
      expect(found).toHaveLength(1);
    });

    it('does not treat division as a regex literal', () => {
      const found = findRawEnvCoercions(
        `const half = total / 2; const n = Number(process.env.X ?? 5);`
      );
      expect(found).toHaveLength(1);
    });

    it('reports one violation per offending call site', () => {
      const found = findRawEnvCoercions(
        `const a = Number(process.env.A ?? 1);\nconst b = Number(process.env.B ?? 2);`
      );
      expect(found.map((v) => v.line)).toEqual([1, 2]);
    });
  });
});
