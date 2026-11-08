import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal registration W2 (#11379), spec §6 invariant 10: every writer of
 * `portal_users.status` / `browser_access` follows the transition table in
 * services/portalAccountState.ts.
 *
 * This census finds every non-test source file under apps/api/src and ee/
 * that INSERTs or UPDATEs `portal_users` (Drizzle or raw SQL, comments
 * stripped) and requires it to be classified:
 *   - 'state-module' — it writes state, so it must import portalAccountState;
 *   - 'no-state'     — it never writes `status` or `browserAccess` (checked).
 *
 * A new writer fails here until it is classified. A writer that stops writing
 * fails as stale. Generic SQL that never names the table (org merge repoint,
 * tenant cascade) is not a state writer and is not matched.
 */
type Classification =
  | { kind: 'state-module' }
  | { kind: 'no-state'; reason: string };

const PORTAL_USER_WRITERS: Record<string, Classification> = {
  'apps/api/src/routes/orgPortalUsers.ts': { kind: 'state-module' },
  'apps/api/src/routes/portal/auth.ts': { kind: 'state-module' },
  'apps/api/src/services/clientAiExchange.ts': { kind: 'state-module' },
  'apps/api/src/routes/portal/profile.ts': { kind: 'no-state', reason: 'name / receiveNotifications / passwordHash only' },
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'apps', 'api', 'src'), join(REPO_ROOT, 'ee')];
const WRITE_PATTERNS = [
  /\.insert\(\s*portalUsers\s*\)/,
  /\.update\(\s*portalUsers\s*\)/,
  /INSERT\s+INTO\s+(?:public\.)?portal_users\b/i,
  /UPDATE\s+(?:public\.)?portal_users\b/i,
];
const STATE_IMPORT = /from\s+['"][./]*(?:services\/)?portalAccountState['"]/;
const STATE_FIELD_WRITE = /\b(status|browserAccess)\s*:\s*['"`]/;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ee/ may be absent in a stripped checkout
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
}

/** Strips block and line comments (good enough for a census; strings are left alone). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function writerFiles(): Map<string, string> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const writers = new Map<string, string>();
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (WRITE_PATTERNS.some((p) => p.test(code))) {
      writers.set(relative(REPO_ROOT, file).split('\\').join('/'), code);
    }
  }
  return writers;
}

describe('portal_users writers are classified against the account state machine (W2 inv. 10)', () => {
  const writers = writerFiles();

  it('finds the known writers (the walk is not vacuous)', () => {
    expect([...writers.keys()]).toContain('apps/api/src/routes/orgPortalUsers.ts');
    expect([...writers.keys()]).toContain('apps/api/src/services/clientAiExchange.ts');
  });

  it('every portal_users writer is classified and state writers use portalAccountState', () => {
    const unclassified = [...writers.keys()].filter((file) => !(file in PORTAL_USER_WRITERS)).sort();
    expect(
      unclassified,
      `classify each in src/__tests__/portalAccountWriters.contract.test.ts:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const missingImport = Object.entries(PORTAL_USER_WRITERS)
      .filter(([file, c]) => c.kind === 'state-module' && writers.has(file) && !STATE_IMPORT.test(writers.get(file)!))
      .map(([file]) => file);
    expect(missingImport, 'these write portal_users state but do not import services/portalAccountState').toEqual([]);

    const noStateViolations = Object.entries(PORTAL_USER_WRITERS)
      .filter(([file, c]) => c.kind === 'no-state' && writers.has(file) && STATE_FIELD_WRITE.test(writers.get(file)!))
      .map(([file]) => file);
    expect(noStateViolations, 'these are classified no-state but write a status/browserAccess literal').toEqual([]);
  });

  it('the classification map has no stale entries', () => {
    const stale = Object.keys(PORTAL_USER_WRITERS).filter((file) => !writers.has(file));
    expect(stale, 'these no longer write portal_users; remove them from PORTAL_USER_WRITERS').toEqual([]);
  });
});
