import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { reportRuns } from '../db/schema';
import { unrestrictedReportRunScopeSqlPredicate } from './siteScope';

/**
 * P2-3 (#4190) — the site-scope projection contract.
 *
 * `decodeSiteScope` reads `executionScopePrincipalKind` to tell a
 * system-authored row (unrestricted, NULL acting user) from a malformed one.
 * A Drizzle projection that selects the other six execution-scope columns but
 * OMITS the principal kind hands the decoder `userId: null` +
 * `principalKind: undefined`, which throws — surfacing as a 404 on an
 * otherwise-authorized report download.
 *
 * That failure is silent at compile time (every call site casts through
 * `as unknown as PersistedSiteScopeColumns`), so it is asserted here instead:
 * every object literal in non-test API source that names
 * `executionScopeCapturedAt:` must also name `executionScopePrincipalKind:`.
 * This covers the projections that exist today AND any added later.
 */

const API_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
// Every layer that can hold a Drizzle projection over `reports`/`report_runs`.
// Narrowed from all of src/ only to keep the scan cheap; the vacuity guard
// below fails if any known projection stops being reachable from these roots.
const SCAN_ROOTS = ['db/schema', 'jobs', 'routes', 'services'] as const;
const ANCHOR = 'executionScopeCapturedAt:';
const REQUIRED = 'executionScopePrincipalKind:';

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
    acc.push(full);
  }
  return acc;
}

/** The `{ ... }` block that immediately encloses `source[index]`. */
function enclosingBlock(source: string, index: number): string {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    const char = source[i];
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return source;

  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

interface Occurrence {
  file: string;
  line: number;
  block: string;
}

function occurrences(): Occurrence[] {
  const found: Occurrence[] = [];
  const files = SCAN_ROOTS.flatMap((root) =>
    sourceFiles(path.join(API_SRC, root)),
  );
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let index = source.indexOf(ANCHOR);
    while (index !== -1) {
      found.push({
        file: path.relative(API_SRC, file),
        line: source.slice(0, index).split('\n').length,
        block: enclosingBlock(source, index),
      });
      index = source.indexOf(ANCHOR, index + ANCHOR.length);
    }
  }
  return found;
}

describe('execution-scope projection contract', () => {
  const all = occurrences();

  it('finds the known execution-scope literals (guards against a vacuous scan)', () => {
    // If the scan silently stopped matching, this suite would pass with zero
    // work done. Every file below owns at least one such literal today.
    const files = new Set(all.map((entry) => entry.file));
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const expected of [
      'db/schema/reports.ts',
      'services/siteScope.ts',
      'services/aiToolsFleet.ts',
      'routes/reports/helpers.ts',
      'routes/reports/core.ts',
      'routes/reports/runs.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('every execution-scope literal also carries the principal kind', () => {
    const offenders = all
      .filter((entry) => !entry.block.includes(REQUIRED))
      .map((entry) => `${entry.file}:${entry.line}`);

    expect(offenders).toEqual([]);
  });
});

it('keeps a complete portal-authored run visible to an unrestricted reader', () => {
  const portalAuthoredRun = {
    executionScopeUserId: null,
    executionScopePrincipalKind: 'portal_user' as const,
  };
  const query = new PgDialect().sqlToQuery(
    unrestrictedReportRunScopeSqlPredicate(reportRuns),
  );

  expect(portalAuthoredRun.executionScopeUserId).toBeNull();
  const portalUserParameter =
    query.params.indexOf(portalAuthoredRun.executionScopePrincipalKind) + 1;
  expect(portalUserParameter).toBeGreaterThan(0);
  expect(query.sql).toMatch(
    new RegExp(
      `"report_runs"\\."execution_scope_user_id" is null\\s+and\\s+`
        + `"report_runs"\\."execution_scope_principal_kind" = \\$${portalUserParameter}`,
    ),
  );
});
