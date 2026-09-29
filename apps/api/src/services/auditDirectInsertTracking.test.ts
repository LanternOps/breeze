import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The generic audit fallback in index.ts writes a row for a mutating request
 * only when the request recorded no audit event of its own. The
 * createAuditLog* writers report that automatically; code that inserts into
 * audit_logs directly (usually to keep the row in the mutation's own
 * transaction) must call `markRequestAuditWritten()` itself, or the request
 * gets a second, generic row next to its real one.
 *
 * This is a source scan: every insert into audit_logs outside the audit
 * service must be matched by at least as many `markRequestAuditWritten(`
 * calls in the same file.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(API_SRC, '..', '..', '..');
const SCAN_ROOTS = [API_SRC, join(REPO_ROOT, 'ee')];

// Not request code: the audit writer itself, and dev/e2e seed fixtures.
const EXEMPT = new Set(['apps/api/src/services/auditService.ts', 'apps/api/src/db/seedE2eFixtures.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function countDirectAuditInserts(source: string): number {
  const aliases = [...source.matchAll(/\bauditLogs\s+as\s+(\w+)/g)].map((m) => m[1]);
  const tables = ['auditLogs', 'schema\\.auditLogs', ...aliases].join('|');
  const drizzleInserts = source.match(new RegExp(`\\.insert\\(\\s*(?:${tables})\\b`, 'g')) ?? [];
  const rawInserts = source.match(/INSERT\s+INTO\s+(?:public\.)?"?audit_logs\b/gi) ?? [];
  return drizzleInserts.length + rawInserts.length;
}

describe('direct audit_logs inserts mark the request as audited', () => {
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(root));

  it('scans a plausible number of source files', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('every file that inserts into audit_logs directly calls markRequestAuditWritten() per insert', () => {
    const offenders: string[] = [];
    let scannedInserts = 0;
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      if (EXEMPT.has(rel)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      const inserts = countDirectAuditInserts(source);
      if (inserts === 0) continue;
      scannedInserts += inserts;
      const marks = (source.match(/\bmarkRequestAuditWritten\(/g) ?? []).length;
      if (marks < inserts) offenders.push(`${rel}: ${inserts} insert(s), ${marks} markRequestAuditWritten() call(s)`);
    }
    // Guards the scan itself: 28 direct inserts existed when this test was
    // written. If the patterns stop matching them, this goes red instead of
    // the check passing vacuously. Raise the floor when adding sites; lower it
    // only when a direct insert is deliberately removed.
    expect(scannedInserts).toBeGreaterThanOrEqual(28);
    expect(offenders).toEqual([]);
  });
});
