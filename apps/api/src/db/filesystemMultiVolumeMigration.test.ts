import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/2026-10-20-170000-filesystem-multi-volume.sql', import.meta.url), 'utf8');

describe('filesystem multi-volume migration safety contracts', () => {
  it('normalises bare drives, drive-relative paths and UNC prefixes explicitly', () => {
    expect(migration).toContain("WHEN w ~ '^[A-Za-z]:'");
    expect(migration).toContain("upper(left(w, 1)) || ':\\' || ltrim(substr(w, 3), '\\')");
    expect(migration).toContain("WHEN left(slashed, 2) = '\\\\'");
  });

  it('requires the newest snapshot original path as verification, without falling back to an older snapshot', () => {
    expect(migration).toContain("SELECT s.scan_path, NULLIF(btrim(s.raw_payload->>'path'), '') AS original_path");
    expect(migration).toContain('AND n.original_path IS NOT NULL');
  });

  it('reports zero backfills and missing-device skips for both tables', () => {
    expect(migration).not.toMatch(/IF (?:n > 0|matched_rows > 0 OR reset_rows > 0) THEN/);
    for (const table of ['device_filesystem_snapshots', 'device_filesystem_scan_state']) {
      expect(migration).toContain(`skipped % ${table} rows because the device row is missing`);
    }
  });

  it('adds the durable command receipt idempotently', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS last_applied_command_id uuid');
  });
});


describe('filesystem migration replay assertions', () => {
  const replay = readFileSync(new URL('../__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts', import.meta.url), 'utf8');

  it('checks structured Postgres CHECK errors instead of the wrapper message', () => {
    expect(replay).toContain("code: '23514'");
    expect(replay).toContain("constraint_name: 'device_filesystem_cleanup_runs_kind_chk'");
    expect(replay).not.toContain('rejects.toThrow(/device_filesystem_cleanup_runs_kind_chk/)');
  });

  it('has no dead clearScanPaths helper', () => {
    expect(replay).not.toContain('async function clearScanPaths');
  });
});
