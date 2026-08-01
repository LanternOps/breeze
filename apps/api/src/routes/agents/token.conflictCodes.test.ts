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
      // Exact cross-check, not a floor. If the balanced-paren walk ever desyncs
      // — an unbalanced quote swallowing calls — the counts diverge and this
      // fails loudly, instead of the guard silently checking fewer responses
      // than the file contains.
      expect(
        extractJsonCalls(stripped).length,
        `scanner lost c.json( calls in ${file}`
      ).toBe((stripped.match(/c\.json\(/g) ?? []).length);
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

  it('gives both arms of a conditional 409 body a code', () => {
    // The `pending_token_required` / `rotation_unresolvable` branch picks its
    // body with a ternary. A guard that only looked for one `code:` per call
    // would pass with one arm left bare.
    for (const { file, call } of conflicts) {
      const arms = (call.match(/error:/g) ?? []).length;
      const codes = (call.match(/\bcode:/g) ?? []).length;
      expect(codes, `a 409 in ${file} has ${arms} body arms but only ${codes} code(s)`).toBe(arms);
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
