/**
 * The ephemeral alert-clustering path must never emit a placeholder tenant id
 * (#4448, wave P2-1 Task 14 follow-up).
 *
 * `buildCorrelationGroups` is the non-persisted fallback behind `GET
 * /correlations` and the ack/resolve group handlers: it clusters
 * `alert_correlations` links in memory and returns the SAME
 * `CorrelationGroupForUi` shape the persisted path does, `orgId` included.
 * Task 14 added that field and filled it on the ephemeral side with an
 * empty-string fallback — a placeholder for "unknown tenant" in a field that
 * IS serialised to the client and that the ack/resolve fallbacks match groups
 * on.
 *
 * Why this is a source contract and not a route assertion: the placeholder arm
 * was unreachable through the route. Both legs of a correlation row are
 * constrained to `orgAlertIds` by the SELECT, so `alertMap` always resolves
 * them, `groupAlerts` is never empty, and `rootCause` is therefore always
 * defined — the trailing `rootCause !== null` filter dropped the only rows that
 * could have carried it. That unreachability is exactly the hazard: the
 * placeholder was kept out of the response by a filter coupled to a DIFFERENT
 * field, three lines away, with nothing pinning the two together. Any edit that
 * makes `rootCause` optional, reorders the filter, or reuses the builder's
 * output somewhere new silently starts publishing an empty org id.
 *
 * So the invariant is asserted where it actually lives — in the source — and
 * the reachable behaviour (every emitted group carries its own member alerts'
 * org) is asserted in `correlations.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'correlations.ts'),
  'utf8',
);

/**
 * The body of one top-level function, by brace counting rather than by slicing
 * to the next declaration — the latter silently returns the whole rest of the
 * file when a function is moved, which would make every assertion below pass
 * for the wrong reason.
 */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `could not find \`${declaration}\` in correlations.ts`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThan(start);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after \`${declaration}\``);
}

/**
 * Line comments removed, so the scan reads CODE and not the prose documenting
 * this very defect — the fix's own comment quotes the placeholder it removed,
 * and a scan that tripped on that would forbid ever explaining it.
 *
 * Block comments are deliberately NOT stripped: the builder contains none, and
 * a half-correct `/*` stripper that ate a line of real code would be a worse
 * failure mode than the documented limitation (the anti-vacuity guard below is
 * what catches that class of error).
 */
function stripLineComments(source: string): string {
  return source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

const EPHEMERAL_BUILDER = 'async function buildCorrelationGroups(';

describe('ephemeral clustering path — org id (#4448)', () => {
  const body = functionBody(SOURCE, EPHEMERAL_BUILDER);
  const code = stripLineComments(body);

  it('the scan is looking at the real builder, not an empty slice', () => {
    // Guard for the guard: if the builder is renamed or its return shape
    // changes, the assertions below would pass vacuously on a body that no
    // longer constructs a group at all. The last one covers the comment strip.
    expect(body).toContain('rootCause');
    expect(body).toContain('correlationLinks');
    expect(code).toMatch(/orgId\s*:/);
  });

  it('fills orgId from the group, with no empty-string placeholder', () => {
    const placeholder = code.match(/orgId\s*:[^,\n]*''/);
    expect(
      placeholder,
      'buildCorrelationGroups still fills orgId from an empty-string placeholder — '
      + 'a group with no resolvable tenant must be dropped, not published as org-less',
    ).toBeNull();
  });

  it('resolves nothing in the builder through an empty-string fallback', () => {
    expect(code).not.toMatch(/\?\?\s*''/);
  });
});
