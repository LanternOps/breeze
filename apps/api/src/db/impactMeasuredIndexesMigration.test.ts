/**
 * AI Scorecard W04 (#5761, refs #4182) — guards the measured-impact cohort
 * index migration. Kept in its own file rather than appended to
 * `autoMigrate.test.ts` so the two in-flight sibling waves editing that file do
 * not collide on it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION = '2026-10-16-183500-impact-measured-indexes.sql';

function listMigrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));
}

describe('measured-impact cohort indexes migration (#5761 W04)', () => {
  it('is present and sorts after the newest migration it was authored on top of', () => {
    const files = listMigrationFilenames();

    expect(files).toContain(MIGRATION);
    // Relative order against the newest migration on `main` when this file was
    // authored — NOT absolute-last, so a later migration landing anywhere else
    // does not redden this test (same pattern the W01 sibling test uses).
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf('2026-10-16-182600-ticket-comment-proposal-note-uq.sql'),
    );
  });

  it('contains indexes only — no DML, so it needs no breeze.scope elevation', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
    // Strip `--` comments before looking for DML: the file's own prose explains
    // why there is none, and "org-merge-registry" would otherwise read as MERGE.
    const statements = sql
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n');

    // A DML statement here would have to elect system scope first (most tables
    // are FORCE ROW LEVEL SECURITY, which binds the owner too) and would need a
    // baseline entry in migrationRlsScope.test.ts. Keeping the file index-only
    // is what makes both unnecessary — assert it stays that way.
    expect(statements).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(statements).not.toMatch(/\bset_config\s*\(/i);
    // autoMigrate wraps each transactional file in client.begin(...); a
    // @no-transaction file's statements are sent separately. Either way an
    // inner BEGIN/COMMIT is wrong.
    expect(statements).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('creates all four cohort indexes idempotently and without holding a build lock', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');

    for (const index of [
      'alerts_org_rule_triggered_idx',
      'tickets_org_created_at_idx',
      'ai_agent_runs_org_alert_started_idx',
      'ai_agent_runs_org_ticket_started_idx',
    ]) {
      expect(sql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}`);
    }
    // CONCURRENTLY cannot run inside a transaction block — the directive is
    // load-bearing, not decorative.
    expect(sql).toMatch(/^\s*--\s*@no-transaction\b/m);
  });
});
