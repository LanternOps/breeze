import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal registration W10 (#11387, plan D5), spec §6 invariants 9 and 10:
 * `portal_users.browser_access` has no column default, and W10 PR-B drops the
 * W2 BEFORE INSERT fill trigger (`portal_users_browser_access_fill`) that
 * derived it for writers that omitted it. After the drop an omitted value is a
 * NOT NULL error. That is the intended loud failure: browser access is never
 * granted by default.
 *
 * Drizzle inserts are covered by tsc: the schema field has no `.default`, so
 * an insert that omits it does not compile. This census covers raw SQL. Every
 * `INSERT INTO portal_users (…)` in API source and tests, the seeds and the
 * E2E fixtures must name `browser_access` in its column list. The exceptions
 * are migration-replay fixtures that exercise the trigger itself, listed here
 * with a reason.
 */
const TRIGGER_FIXTURES: Record<string, string> = {
  // Seeds pre-W2 rows (no browser_access column yet) inside the rolled-back
  // replay of the W2 migration, which then backfills and installs the trigger.
  'apps/api/src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts':
    'W2 replay: rows written before browser_access exists / the fill trigger under test',
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ROOTS = [
  join(REPO_ROOT, 'apps', 'api', 'src'),
  join(REPO_ROOT, 'apps', 'api', 'scripts'),
  join(REPO_ROOT, 'e2e-tests'),
  join(REPO_ROOT, 'ee'),
];
const INSERT = /INSERT\s+INTO\s+(?:public\.)?"?portal_users"?\s*\(([^)]*)\)/gi;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ee/ may be absent in a stripped checkout
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.tsbuild') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|sql)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
}

/** `file:line` of every raw portal_users insert whose column list omits browser_access. */
function insertsWithoutBrowserAccess(file: string, code: string): string[] {
  const hits: string[] = [];
  INSERT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INSERT.exec(code)) !== null) {
    if (!/\bbrowser_access\b/.test(m[1]!)) hits.push(`${file}:${code.slice(0, m.index).split('\n').length}`);
  }
  return hits;
}

describe('every raw portal_users insert names browser_access (W10 D5)', () => {
  const files: string[] = [];
  for (const root of ROOTS) walk(root, files);
  const self = relative(REPO_ROOT, import.meta.filename).split('\\').join('/');

  it('scans a non-trivial tree (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('no unclassified insert omits browser_access', () => {
    const offenders = files
      .map((f) => relative(REPO_ROOT, f).split('\\').join('/'))
      .filter((rel) => rel !== self && !(rel in TRIGGER_FIXTURES))
      .flatMap((rel) => insertsWithoutBrowserAccess(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')));
    expect(offenders, 'name browser_access (password → granted, otherwise none)').toEqual([]);
  });

  it('every trigger-fixture exception still exists and still needs it', () => {
    for (const [rel, reason] of Object.entries(TRIGGER_FIXTURES)) {
      expect(reason.length, rel).toBeGreaterThan(10);
      expect(insertsWithoutBrowserAccess(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')).length, rel).toBeGreaterThan(0);
    }
  });

  it('the matcher sees multi-line, quoted and schema-qualified inserts (not vacuous)', () => {
    expect(insertsWithoutBrowserAccess('x', 'INSERT INTO portal_users (\n  org_id,\n  email\n) VALUES ($1, $2)')).toEqual(['x:1']);
    expect(insertsWithoutBrowserAccess('x', 'insert into public."portal_users" (org_id, email) values (1, 2)')).toEqual(['x:1']);
    expect(insertsWithoutBrowserAccess('x', 'INSERT INTO portal_users (org_id, email, browser_access) VALUES (1, 2, 3)')).toEqual([]);
    expect(insertsWithoutBrowserAccess('x', 'INSERT INTO portal_user_identities (org_id) VALUES (1)')).toEqual([]);
  });
});
