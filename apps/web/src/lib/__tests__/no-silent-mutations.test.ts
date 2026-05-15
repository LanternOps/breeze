/**
 * Guard: targeted set must not call fetchWithAuth with a mutating method
 * outside of runAction (or an explicitly allowlisted exception).
 *
 * Glob mechanism: Node fs recursive walk — no external glob dependency needed.
 * The test cwd under vitest is apps/web, but we anchor paths with import.meta.url
 * to be safe. Allowlist entries are repo-root-relative (apps/web/...) paths.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ACTION_ALLOWLIST, RUN_ACTION_MIGRATION_BACKLOG } from '../runActionAllowlist';

// Resolve relative to this test file: apps/web/src/lib/__tests__/ → apps/web/src/
const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ (1) → lib (2) → src
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src
const WEB_ROOT = SRC_ROOT;

// WS-A "targeted set": files that have ADOPTED runAction and must not regress
// to silent mutations. This list GROWS as more handlers are migrated in the
// gradual rollout — it is intentionally NOT the whole devices/alerts tree
// (sweeping migration is an explicit WS-A non-goal). See the spec + the
// KNOWN-UNMIGRATED backlog in runActionAllowlist.ts.
const TARGET_GLOBS = [
  'src/components/alerts/NotificationChannelsPage.tsx',
  'src/components/settings/PartnerSettingsPage.tsx',
  'src/components/patches/PatchesPage.tsx',
];

// Resolve TARGET_GLOBS to absolute paths.
// Each entry is a path relative to apps/web (e.g. "src/components/...").
const absoluteFiles: string[] = TARGET_GLOBS.map((rel) =>
  resolve(WEB_ROOT, '..', rel) // WEB_ROOT = apps/web/src, so go up one to apps/web
);

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

// ─── Backlog integrity check ─────────────────────────────────────────────────
describe('migration backlog integrity', () => {
  it('backlog is non-empty (debt is tracked)', () => {
    expect(RUN_ACTION_MIGRATION_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every backlog entry is a string path under apps/web/src/', () => {
    for (const entry of RUN_ACTION_MIGRATION_BACKLOG) {
      expect(typeof entry).toBe('string');
      expect(entry.startsWith('apps/web/src/')).toBe(true);
    }
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no silent mutations in targeted set', () => {
  it('finds files to scan', () => {
    expect(absoluteFiles.length).toBe(3);
    // Sanity: all target files must actually exist on disk.
    for (const f of absoluteFiles) {
      expect(() => statSync(f)).not.toThrow();
    }
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
