import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Issue #2894 — contract: EVERY 409 the agent token rotation routes emit must
 * carry a machine-readable `code`.
 *
 * The behavioural tests in `token.test.ts` pin the four conflicts that exist
 * today. This suite is the part that survives the next change: it reads the
 * route source and fails on ANY `c.json(..., 409)` whose body has no `code`
 * field, so a fifth bare 409 added later cannot ship. Two of the four shipped
 * without one and the agent retried them until the pending TTL expired; the
 * point of the code is to tell a conflict worth retrying from one that is dead.
 *
 * Source-level rather than behavioural on purpose: a behavioural test can only
 * assert the branches someone remembered to write a test for, which is exactly
 * the gap that let this ship.
 */

const ROUTE_PATH = join(__dirname, 'token.ts');

/**
 * Extract every `c.json(...)` call from the source, string-aware so quoted
 * parens/braces inside error messages do not unbalance the scan.
 */
function extractJsonCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'c.json(';

  for (let start = source.indexOf(marker); start !== -1; start = source.indexOf(marker, start + 1)) {
    let depth = 0;
    let quote: string | null = null;

    for (let i = start + marker.length - 1; i < source.length; i++) {
      const ch = source[i]!;

      if (quote) {
        if (ch === '\\') {
          i++; // skip the escaped character
        } else if (ch === quote) {
          quote = null;
        }
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

describe('agent token rotation conflict codes', () => {
  const source = readFileSync(ROUTE_PATH, 'utf8');
  const jsonCalls = extractJsonCalls(source);

  it('parses the route source (guards the scanner itself against silently matching nothing)', () => {
    // If `c.json(` is ever renamed or the scanner breaks, every assertion below
    // passes vacuously. Pin a floor so the guard fails loudly instead.
    expect(jsonCalls.length).toBeGreaterThanOrEqual(10);
    expect(jsonCalls.some((call) => call.includes('409'))).toBe(true);
  });

  it('gives every 409 response a machine-readable code', () => {
    const conflictCalls = jsonCalls.filter((call) => /,\s*409\s*\)$/.test(call));

    // The four confirm-route conflicts plus the rotate-route CAS conflict and
    // the unconfirmed-rotation guard. A new one is fine — it just has to carry
    // a code, which is what this asserts.
    expect(conflictCalls.length).toBeGreaterThanOrEqual(6);

    const bare = conflictCalls.filter((call) => !/\bcode:/.test(call));
    expect(
      bare,
      'Every 409 from the agent token rotation routes must carry a `code` so the ' +
        'agent can tell a terminal conflict from a retryable one (#2894). Add one ' +
        'to ROTATION_CONFLICT_CODES and decide explicitly whether the agent may ' +
        'discard its staged credentials on it.'
    ).toEqual([]);
  });

  it('only marks a conflict terminal when the staged token is provably dead', () => {
    // The terminal codes are a contract with agent/pkg/api/client.go
    // (IsRotationTerminal). Changing either side alone strands or loops agents,
    // so pin the vocabulary here.
    expect(source).toContain("UNRESOLVABLE: 'rotation_unresolvable'");
    expect(source).toContain("PENDING_ROTATION_EXPIRED: 'pending_rotation_expired'");
    expect(source).toContain("CONFLICT: 'rotation_conflict'");
    expect(source).toContain("PENDING_TOKEN_REQUIRED: 'pending_token_required'");
  });
});
