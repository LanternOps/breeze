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
 * SCOPE, stated precisely so the "zero violations" claim is not over-read:
 * this scans `apps/api/src` only. That is where the bug class lives — the API
 * container is what compose threads these variables into. `apps/api/scripts`
 * is clean, and the web/portal apps read `import.meta.env` (Vite substitutes
 * at build time, different semantics). Verified zero instances elsewhere in
 * the repo at the time of writing.
 *
 * KNOWN BLIND SPOTS (accepted, not oversights). All of these are silent
 * against the rules above, and each needs real dataflow analysis to catch —
 * which would trade a precise, zero-exemption guard for a fuzzy one:
 *
 *   - Aliasing: `const env = process.env; Number(env.FOO ?? 5)`. Two files
 *     already bind such an alias (`config/validate.ts`, `routes/system.ts`),
 *     neither for a numeric read.
 *   - Indirection: `const raw = process.env.X ?? '5000'; Number(raw)`.
 *   - Other coercions: `+process.env.X`, `process.env.X * 1`,
 *     `Number(\`${process.env.X ?? 5000}\`)`.
 *   - The STRING form of the same trap (`process.env.X ?? 'default'`, which
 *     yields `''`) is NOT guarded — `envStr` exists for it, but the shape is
 *     too common and usually fail-safe to ban outright. Judge those by hand.
 *
 * The residual risk is that a future author has to go out of their way to
 * reintroduce the bug, rather than fall into it by writing the obvious thing.
 *
 * The self-check block at the bottom is load-bearing. A grep guard whose
 * pattern silently matches nothing is the classic failure mode here, so the
 * detector is exercised against synthetic violating AND non-violating sources,
 * and the file walk asserts it actually saw the tree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
 * Neutralise everything that is not executable code: comment bodies and
 * string/template literal bodies.
 *
 * Both matter, for opposite reasons. Comments must be blanked because the
 * helper docs (and this file) quote the forbidden pattern verbatim as the
 * thing NOT to write — a naive grep flags its own documentation. Literal
 * bodies must be blanked because a string may legitimately CONTAIN the
 * pattern (an error message, a usage line) without being a violation.
 *
 * Literals cannot simply be deleted or space-filled, though: rule 2 has to
 * distinguish the safe `?? ''` from the broken `?? '15'`, so delimiters are
 * preserved and bodies are filled with `x`. Tracking literals is also what
 * keeps a `//` inside a string (`'http://host/v1'`) from being read as a
 * comment and swallowing the rest of the line.
 *
 * Regex literals are tracked too, so the `//` inside `/^https?:\/\//` is not
 * mistaken for a line comment.
 *
 * Two constructs in this repo make a naive tokenizer desync, and BOTH have
 * live instances, so both are handled explicitly:
 *
 *   - A `/` inside a regex character class does NOT end the regex.
 *     `routes/devices/softwareActions.ts` has `/[\\/\x00\r\n']/`; reading that
 *     inner `/` as the terminator drops us into code at `']`, which opens a
 *     phantom string and mispairs every quote for the rest of the file.
 *   - `${...}` re-enters code inside a template literal, and templates nest.
 *     `services/email.ts` and `services/invoicePdf.ts` are full of
 *     `${cond ? \`x\` : ''}`; without a stack the inner backtick is read as
 *     closing the outer template and parity never recovers.
 *
 * Desync is not merely untidy: a mispaired quote means a `/*` sitting in a
 * string can open block-comment state and blank hundreds of lines of real
 * code, or an innocent comment can be read as code and reported as a
 * violation — reddening a required CI job on a file nobody touched.
 *
 * Newlines are preserved so reported line numbers stay accurate, and the
 * function is length-preserving (it substitutes spaces, never deletes).
 */
export function blankComments(source: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let state: State = 'code';

  // Brace depth per open `${` in a template literal. Empty => not inside a
  // template expression. Nesting is why this is a stack and not a boolean.
  const templateExprDepth: number[] = [];
  // Whether the regex cursor is inside a `[...]` character class.
  let inCharClass = false;

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
        inCharClass = false;
        out += c;
        pushTail(c);
        i += 1;
      } else {
        if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        else if (templateExprDepth.length > 0) {
          // Track braces so the `}` that closes `${` returns us to the
          // template, and an inner object/block literal does not steal it.
          if (c === '{') {
            templateExprDepth[templateExprDepth.length - 1]! += 1;
          } else if (c === '}') {
            if (templateExprDepth[templateExprDepth.length - 1]! === 0) {
              templateExprDepth.pop();
              state = 'template';
            } else {
              templateExprDepth[templateExprDepth.length - 1]! -= 1;
            }
          }
        }
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

    if (c === '\\') {
      out += state === 'regex' ? source.slice(i, i + 2) : 'xx';
      pushTail(' ');
      i += 2;
      continue;
    }

    if (state === 'template' && c === '$' && next === '{') {
      templateExprDepth.push(0);
      state = 'code';
      out += '${';
      pushTail('{');
      i += 2;
      continue;
    }

    if (state === 'regex') {
      if (c === '[') inCharClass = true;
      else if (c === ']') inCharClass = false;
      // `/` only terminates outside a character class; a regex cannot span
      // lines, so a newline bails out (a misclassified division operator can
      // then never swallow the rest of the file).
      else if ((c === '/' && !inCharClass) || c === '\n') state = 'code';
      out += c;
      pushTail(c === '\n' ? ' ' : c);
      i += 1;
      continue;
    }

    // Closing delimiter of a string / template literal — kept, see below.
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
      out += c;
      pushTail(c);
      i += 1;
      continue;
    }

    // String/template BODY. Replaced with a filler rather than copied: a
    // string that happens to contain the banned pattern verbatim (an error
    // message, a usage line, a doc string) is not a violation and must not
    // red CI. The delimiters are kept and the filler is `x` rather than a
    // space, so rule 2 can still tell the safe `?? ''` from `?? '15'` — it
    // tests for a literally EMPTY fallback, and spaces would erase that
    // distinction.
    out += c === '\n' ? '\n' : 'x';
    pushTail('x');
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

/**
 * Read the balanced argument list of a call whose `(` sits at `openIndex`.
 *
 * String literals are skipped rather than scanned: `blankComments` deliberately
 * preserves their contents, so a lone paren inside one (`s.split('(')`) would
 * otherwise inflate the depth, run past the real closing paren, and swallow
 * following lines into these args — reporting a violation on innocent code.
 */
function readCallArgs(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const c = source[i];

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }

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

  // Matching happens on `code`, but line numbers and snippets are reported
  // from the ORIGINAL `source` — the offsets are interchangeable because
  // blanking substitutes characters rather than deleting them, so a reported
  // snippet shows the developer their real text, not the `x` filler.
  for (const match of code.matchAll(NUMBER_CALL)) {
    violations.push({
      line: lineOf(source, match.index),
      rule: 'number-coercion',
      snippet: snippetAt(source, match.index),
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
      line: lineOf(source, match.index),
      rule: 'nullish-fallback',
      snippet: snippetAt(source, match.index),
    });
  }

  return violations.sort((a, b) => a.line - b.line);
}

describe('no raw numeric coercion of process.env (#2823)', () => {
  const files = listSourceFiles(SRC_ROOT);

  // Vacuity guard #1: if the walk breaks the scan below passes trivially.
  //
  // A single total-count floor is not enough. `services/` alone is 43% of the
  // tree (and holds several of the readers this PR fixed), so a walk that
  // silently stopped descending into it would still clear a "> 500" floor
  // having scanned barely half the source. Census each major directory.
  it('walks the whole apps/api source tree, not just part of it', () => {
    expect(files.length).toBeGreaterThan(1000); // real count ~1225

    const countIn = (dir: string) =>
      files.filter((f) => f.includes(`${sep}${dir}${sep}`)).length;

    for (const [dir, floor] of [
      ['services', 400],
      ['routes', 300],
      ['db', 80],
      ['jobs', 60],
      ['middleware', 10],
      ['utils', 5],
    ] as const) {
      expect(countIn(dir), `the walk lost ${dir}/`).toBeGreaterThan(floor);
    }
  });

  // Vacuity guard #2: the dangerous direction of a comment-stripper bug.
  //
  // Blanking too LITTLE is harmless — the violation stays visible. Blanking
  // too MUCH is silent: if the tokenizer wrongly believes it is in code while
  // inside a literal, a `/*` in that literal opens block-comment state and
  // erases everything up to the next `*/`, hiding every violation in between.
  // Nothing else in this file couples the stripper to the real corpus, so
  // assert against it directly: `process.env` reads must survive blanking,
  // and blanking must be length-preserving (it substitutes, never deletes).
  it('blanks comments without eating real code', () => {
    let rawReads = 0;
    let survivingReads = 0;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const blanked = blankComments(source);
      expect(blanked, relative(SRC_ROOT, file)).toHaveLength(source.length);
      rawReads += (source.match(/process\.env/g) ?? []).length;
      survivingReads += (blanked.match(/process\.env/g) ?? []).length;
    }

    // Measured: 550 raw, 533 surviving (the 17 lost are genuine doc comments).
    expect(rawReads).toBeGreaterThan(400);
    expect(survivingReads).toBeGreaterThan(rawReads * 0.9);
  });

  // Vacuity guard #3: the self-checks below all feed the detector short
  // synthetic strings. This proves the same detector still fires on a real
  // file — with its real comments, imports, templates and regex literals —
  // which is what the scan actually does.
  it('flags a violation injected into a real source file', () => {
    const real = readFileSync(join(SRC_ROOT, 'jobs', 'offlineDetector.ts'), 'utf8');
    const found = findRawEnvCoercions(
      `${real}\nconst __canary = Number(process.env.__CANARY ?? '5');\n`
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('number-coercion');
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

    // Live shape: routes/devices/softwareActions.ts has /[\\/\x00\r\n']/.
    // Reading the `/` inside the character class as the terminator drops the
    // tokenizer into code at `']`, opening a phantom string that mispairs
    // every quote in the rest of the file.
    it('does not end a regex literal at a / inside a character class', () => {
      const found = findRawEnvCoercions(
        `const RE = /[\\\\/']/;\n// bad: Number(process.env.X ?? 5)\nconst ok = 1;`
      );
      expect(found).toEqual([]);
    });

    // Live shape: services/email.ts and services/invoicePdf.ts are full of
    // `${cond ? \`x\` : ''}`. Without a stack the inner backtick reads as
    // closing the outer template and parity never recovers.
    it('handles a nested template literal inside ${} without desyncing', () => {
      const found = findRawEnvCoercions(
        'const s = `a ${cond ? `b` : \'\'} c`;\n// bad: Number(process.env.X ?? 5)\nconst ok = 1;'
      );
      expect(found).toEqual([]);
    });

    it('still flags real code after a nested template literal', () => {
      const found = findRawEnvCoercions(
        'const s = `a ${cond ? `b` : \'\'} c`;\nconst n = Number(process.env.X ?? 5);'
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.line).toBe(2);
    });

    it('returns to the template after a ${} expression containing an object', () => {
      const found = findRawEnvCoercions(
        'const s = `${fn({ a: 1 })} // Number(process.env.A ?? 1)`;\nconst ok = 1;'
      );
      expect(found).toEqual([]);
    });

    // A string may legitimately CONTAIN the banned pattern — an error
    // message, a migration note, a usage line — without being a violation.
    it('ignores the pattern inside a string literal', () => {
      expect(
        findRawEnvCoercions(`const msg = 'do not write Number(process.env.X ?? 5)';`)
      ).toEqual([]);
    });

    it('ignores the pattern inside a template literal body', () => {
      expect(
        findRawEnvCoercions('const msg = `avoid Number(process.env.X ?? 5) here`;')
      ).toEqual([]);
    });

    // Blanking literal bodies must not erase the ''-vs-'15' distinction that
    // rule 2 depends on, which is why the filler is `x` and not a space.
    it("still distinguishes ?? '' from ?? '15' after blanking", () => {
      expect(findRawEnvCoercions(`parseInt(process.env.A ?? '', 10);`)).toEqual([]);
      expect(findRawEnvCoercions(`parseInt(process.env.A ?? '15', 10);`)).toHaveLength(1);
      expect(findRawEnvCoercions(`parseInt(process.env.A ?? "", 10);`)).toEqual([]);
    });

    // readCallArgs must skip string contents; a lone paren inside one would
    // otherwise run the scan past the real closing paren and pull the NEXT
    // statement's `process.env` + `??` into these args.
    it('does not over-read call args past a paren inside a string literal', () => {
      const found = findRawEnvCoercions(
        `const n = parseInt(s.split('(')[0], 10);\n` +
          `const t = Number.parseInt(process.env.TTL ?? '15', 10);`
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.line).toBe(2);
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
