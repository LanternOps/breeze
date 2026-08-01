import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Issue #2894 — two contracts:
 *
 *  1. EVERY 409 the agent token rotation routes emit carries a machine-readable
 *     `code`, drawn from a known vocabulary.
 *  2. The set of codes the GO AGENT treats as terminal stays exactly in sync
 *     with what those routes actually emit.
 *
 * The behavioural tests in `token.test.ts` pin the conflicts that exist today.
 * This suite is the part that survives the next change: it reads the route
 * source and fails on ANY `c.json(..., 409)` whose body has no code, so a future
 * bare 409 cannot ship. Two of the four shipped without one, and the agent
 * retried them until the pending TTL expired.
 *
 * Source-level rather than behavioural on purpose: a behavioural test can only
 * assert the branches someone remembered to write a test for, which is exactly
 * the gap that let this ship.
 */

const ROUTE_DIR = __dirname;
const GO_CLIENT_PATH = join(ROUTE_DIR, '../../../../../agent/pkg/api/client.go');

/** Codes the route may emit. A 409 carrying anything else is as useless as none. */
const KNOWN_CODES = [
  'rotation_unresolvable',
  'rotation_conflict',
  'rotation_stale_current',
  'pending_token_required',
  'pending_rotation_expired',
  'pending_rotation_unconfirmed',
];

/** Codes on which the agent may DISCARD its staged credentials. */
const TERMINAL_CODES = ['pending_rotation_expired', 'rotation_unresolvable'];

/** Rotation route sources: `token.ts` today, plus whatever a future split adds. */
function routeSourceFiles(): string[] {
  return readdirSync(ROUTE_DIR)
    .filter((f) => /^token.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => join(ROUTE_DIR, f));
}

/**
 * Strip comments, string-aware, so route prose can never be parsed as code.
 *
 * Load-bearing, not tidiness. An apostrophe in a comment *inside* a `c.json(`
 * argument list — "the agent's staged set" — would otherwise open a quote that
 * swallows the rest of the scan and silently drop conflicts from the guard.
 * `token.ts` already carries inline comments inside argument lists, and this
 * codebase writes dense prose, so that is a matter of time rather than luck.
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++; // land on the closing '/'
      out += ' ';
      continue;
    }

    out += ch;
  }

  return out;
}

/** Extract every `c.json(...)` call, balanced-paren and string-aware. */
function extractJsonCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'c.json(';

  for (let start = source.indexOf(marker); start !== -1; start = source.indexOf(marker, start + 1)) {
    let depth = 0;
    let quote: string | null = null;

    for (let i = start + marker.length - 1; i < source.length; i++) {
      const ch = source[i]!;

      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }

  return calls;
}

/**
 * Pull the declared vocabulary out of the route source: MEMBER -> 'code_value'.
 * Comments must already be stripped, or the prose in the jsdoc blocks between
 * members would be scanned as code.
 */
function declaredCodes(strippedSource: string): Record<string, string> {
  const start = strippedSource.indexOf('const ROTATION_CONFLICT_CODES = {');
  if (start === -1) return {};
  const block = strippedSource.slice(start, strippedSource.indexOf('} as const;', start));
  return Object.fromEntries([...block.matchAll(/([A-Z_]+):\s*'([a-z_]+)'/g)].map((m) => [m[1]!, m[2]!]));
}

/** Codes the Go client maps to a terminal sentinel — i.e. "discard the staged set". */
function goTerminalCodes(goSource: string): string[] {
  const start = goSource.indexOf('switch result.Code {');
  expect(start, 'ConfirmTokenRotation no longer has a `switch result.Code` block').toBeGreaterThan(-1);
  const body = goSource.slice(start, goSource.indexOf('\n\t}', start));
  return [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!).sort();
}

describe('agent token rotation conflict codes', () => {
  const sources = routeSourceFiles().map((file) => ({ file, source: readFileSync(file, 'utf8') }));

  const conflicts = sources.flatMap(({ file, source }) =>
    extractJsonCalls(stripComments(source))
      .filter((call) => /,\s*409\s*,?\s*\)$/.test(call))
      .map((call) => ({ file, call }))
  );

  it('scans every rotation route source without losing a call', () => {
    expect(sources.length).toBeGreaterThanOrEqual(1);

    for (const { file, source } of sources) {
      const stripped = stripComments(source);
      // Cross-check against the RAW source, never the stripped copy. Comparing
      // stripped-to-stripped is vacuous: anything stripComments swallows
      // disappears from both sides of the equality, so the check cannot detect
      // the one failure it exists for. A regex literal containing `//`, say,
      // strips as a line comment and takes the rest of the line — including a
      // whole `c.json({...}, 409)` — with it, and stripped-vs-stripped compares
      // 0 to 0 and passes green while a conflict silently leaves the guard.
      //
      // If this ever fails because a COMMENT legitimately mentions `c.json(`,
      // reword the comment. Failing loudly on the ambiguity is the point.
      const rawCount = (source.match(/c\.json\(/g) ?? []).length;
      expect(
        (stripped.match(/c\.json\(/g) ?? []).length,
        `stripComments swallowed a c.json( call in ${file} (or a comment mentions "c.json(" — reword it)`
      ).toBe(rawCount);
      expect(
        extractJsonCalls(stripped).length,
        `the balanced-paren scan lost c.json( calls in ${file}`
      ).toBe(rawCount);
    }
  });

  it('gives every 409 response a code from the known vocabulary', () => {
    // Four confirm-route conflicts + the rotate-route CAS conflict + the
    // unconfirmed-rotation guard. Adding one is fine — it just has to carry a
    // known code, which is what this asserts.
    expect(conflicts.length).toBeGreaterThanOrEqual(6);

    const bare = conflicts.filter(({ call }) => !/\bcode:\s*[A-Za-z_]/.test(call));
    expect(
      bare.map(({ file, call }) => `${file}: ${call.slice(0, 90)}`),
      'Every 409 from the agent token rotation routes must carry a `code` so the ' +
        'agent can tell a terminal conflict from a retryable one (#2894). Add one ' +
        'to ROTATION_CONFLICT_CODES and decide explicitly whether the agent may ' +
        'discard its staged credentials on it.'
    ).toEqual([]);

    // `code:` satisfied by a string literal in an error message, or by a typo'd
    // value outside the vocabulary, is no better than a bare 409 — the agent
    // falls through to the retryable default either way.
    for (const { file, call } of conflicts) {
      for (const [, literal] of call.matchAll(/code:\s*'([a-z_]+)'/g)) {
        expect(KNOWN_CODES, `${file} emits an unknown 409 code '${literal}'`).toContain(literal);
      }
      expect(
        /code:\s*(ROTATION_CONFLICT_CODES\.[A-Z_]+|'[a-z_]+')/.test(call),
        `409 in ${file} must set code to a ROTATION_CONFLICT_CODES member: ${call.slice(0, 90)}`
      ).toBe(true);
    }
  });

  // Every 409 in this file uses the `ROTATION_CONFLICT_CODES.X` member form, so
  // the literal spot-check above never actually fires. Without this, a brand-new
  // member could ship without ever being registered in KNOWN_CODES — and the
  // header's "drawn from a known vocabulary" claim would be decorative for the
  // only form the codebase writes. Assert the vocabulary itself instead.
  it('keeps the declared vocabulary and the known-code list in lockstep', () => {
    for (const { file, source } of sources) {
      const declared = declaredCodes(stripComments(source));
      if (Object.keys(declared).length === 0) continue; // file declares none

      expect(
        Object.values(declared).sort(),
        `${file} declares a rotation conflict code that is not registered in this test's ` +
          'KNOWN_CODES. Add it, and classify it as terminal or retryable on BOTH sides ' +
          '(ROTATION_CONFLICT_CODES here, the switch in agent/pkg/api/client.go there).'
      ).toEqual([...KNOWN_CODES].sort());

      // Members referenced by a 409 must actually exist in the declaration.
      for (const { call } of conflicts) {
        for (const [, member] of call.matchAll(/code:\s*ROTATION_CONFLICT_CODES\.([A-Z_]+)/g)) {
          expect(declared, `409 references undeclared member ${member}`).toHaveProperty(member!);
        }
      }
    }
  });

  it('gives both arms of a conditional 409 body a code', () => {
    // The `pending_token_required` / `rotation_unresolvable` branch picks its
    // body with a ternary. A guard that only looked for one `code:` per call
    // would pass with one arm left bare.
    for (const { file, call } of conflicts) {
      // Count body objects structurally (`{ someKey:`) rather than keying off a
      // message field — a future body using `message:`/`detail:` instead of
      // `error:` would otherwise report a confusing "0 arms but 1 code".
      const arms = (call.match(/\{\s*[A-Za-z_]+\s*:/g) ?? []).length;
      const codes = (call.match(/\bcode:/g) ?? []).length;
      expect(codes, `a 409 in ${file} has ${arms} body arm(s) but ${codes} code(s)`).toBe(arms);
    }
  });

  /**
   * The highest-value guard here. The TS vocabulary and the Go terminal switch
   * are two independent hardcoded copies of one contract; renaming or adding on
   * either side alone compiles and passes every other test in this PR. The
   * failure modes are asymmetric — dropping a code from the Go switch means an
   * agent retries forever (benign), but landing a RETRYABLE code in that switch
   * makes agents discard live credentials (permanent strand, #2772/#2773).
   */
  it('keeps the Go agent terminal set exactly in sync with the codes this route emits', () => {
    const routeSource = sources.map(({ source }) => source).join('\n');
    const goTerminal = goTerminalCodes(readFileSync(GO_CLIENT_PATH, 'utf8'));

    expect(goTerminal).toEqual([...TERMINAL_CODES].sort());

    for (const code of goTerminal) {
      expect(
        routeSource,
        `the Go client treats '${code}' as terminal but no route emits it — the agent is ` +
          'waiting for a signal that can never arrive'
      ).toContain(`'${code}'`);
    }

    for (const retryable of KNOWN_CODES.filter((c) => !TERMINAL_CODES.includes(c))) {
      expect(
        goTerminal,
        `'${retryable}' is retryable server-side; treating it as terminal in the Go client ` +
          'would make agents discard credentials the server may still be authenticating them with'
      ).not.toContain(retryable);
    }
  });
});
