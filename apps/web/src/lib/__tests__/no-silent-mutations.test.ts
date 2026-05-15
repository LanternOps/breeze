/**
 * Guard: targeted set must not call fetchWithAuth with a mutating method
 * outside of runAction (or an explicitly allowlisted exception).
 *
 * Glob mechanism: Node fs recursive walk — no external glob dependency needed.
 * The test cwd under vitest is apps/web, but we anchor paths with import.meta.url
 * to be safe. Allowlist entries are repo-root-relative (apps/web/...) paths.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ACTION_ALLOWLIST } from '../runActionAllowlist';

// Resolve relative to this test file: apps/web/src/lib/__tests__/ → apps/web/src/
const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ (1) → lib (2) → src
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src
const WEB_ROOT = SRC_ROOT;

// Walk a directory recursively, returning files with a given suffix.
// Skips *.test.tsx / *.test.ts — mocks in test files can use any method.
function walk(dir: string, suffix: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full, suffix));
    } else if (name.endsWith(suffix) && !name.endsWith(`.test${suffix}`)) {
      results.push(full);
    }
  }
  return results;
}

// TARGET_GLOBS expressed as absolute dirs + single files.
const TARGET_DIRS = [
  join(WEB_ROOT, 'components/devices'),
  join(WEB_ROOT, 'components/alerts'),
];
const TARGET_FILES_SINGLE = [
  join(WEB_ROOT, 'components/settings/PartnerSettingsPage.tsx'),
  join(WEB_ROOT, 'components/patches/PatchesPage.tsx'),
];

// Collect all targeted .tsx files.
const absoluteFiles: string[] = [
  ...TARGET_DIRS.flatMap((d) => walk(d, '.tsx')),
  ...TARGET_FILES_SINGLE,
];

// Build the allowlist as a Set of absolute paths for fast lookup.
// Allowlist entries are repo-root-relative (apps/web/...).
// Repo root = three levels above WEB_ROOT (apps/web/src → apps/web → apps → repo root).
const REPO_ROOT = resolve(WEB_ROOT, '../../..');
const allowAbsolute = new Set(
  RUN_ACTION_ALLOWLIST.map((a) => resolve(REPO_ROOT, a.file))
);

// The heuristic regex: fetchWithAuth( ... { ... method: 'POST'|'PUT'|'PATCH'|'DELETE'
// The `s` flag allows `.` to match newlines (multi-line call bodies).
const MUT = /fetchWithAuth\s*\([^)]*\{[^}]*method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/s;

// ─── Self-check: verify the regex itself ────────────────────────────────────
describe('guard self-checks', () => {
  it('MUT regex matches a known-bad inline sample', () => {
    const bad = `fetchWithAuth('/api/foo', { method: 'POST', body: '{}' })`;
    expect(MUT.test(bad)).toBe(true);
  });

  it('MUT regex does not match a GET call', () => {
    const get = `fetchWithAuth('/api/foo', { method: 'GET' })`;
    expect(MUT.test(get)).toBe(false);
  });

  it('MUT regex does not match a plain fetchWithAuth with no options object', () => {
    const plain = `fetchWithAuth('/api/foo')`;
    expect(MUT.test(plain)).toBe(false);
  });

  it('allowlisted path is present in the allowlist Set', () => {
    const entry = RUN_ACTION_ALLOWLIST[0];
    expect(entry).toBeDefined();
    expect(allowAbsolute.has(resolve(REPO_ROOT, entry.file))).toBe(true);
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no silent mutations in targeted set', () => {
  it('finds files to scan', () => {
    expect(absoluteFiles.length).toBeGreaterThan(0);
  });

  for (const absPath of absoluteFiles) {
    // Make a readable label relative to apps/web for the test name.
    const webRelLabel = absPath.startsWith(WEB_ROOT)
      ? 'src' + absPath.slice(WEB_ROOT.length)
      : absPath;

    if (allowAbsolute.has(absPath)) {
      // Allowlisted — skip silently (no test generated to avoid noise).
      continue;
    }

    it(`${webRelLabel}: every mutating fetchWithAuth is inside runAction`, () => {
      const src = readFileSync(absPath, 'utf8');
      if (!MUT.test(src)) {
        // No mutating fetchWithAuth in this file — passes automatically.
        return;
      }
      // The file has a mutating fetchWithAuth. It must also contain runAction
      // (in any call form: runAction(, runAction<T>(, etc.).
      expect(src.includes('runAction')).toBe(true);
    });
  }
});
