import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const FILE = '2026-12-23-140000-portal-branding-enable-hour-block.sql';
// W01 ships its migrations as 2026-12-14-10NNNN-*.sql. W04 depends on W01
// being merged, so at least one must exist and every one must sort before ours.
const W01_PREFIX = '2026-12-14-10';

describe('portal_branding.enable_hour_block migration (block hours W04)', () => {
  it('adds exactly one fail-closed, idempotent column and writes no rows', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
    const code = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    expect(code).toMatch(
      /ALTER TABLE portal_branding\s+ADD COLUMN IF NOT EXISTS enable_hour_block boolean NOT NULL DEFAULT false;/,
    );
    // autoMigrate wraps each file in a transaction already.
    expect(code).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
    // No row writes => no breeze.scope preamble is needed. If this ever
    // fails, the preamble and a GET DIAGNOSTICS row count become mandatory.
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|MERGE)\b/i);
  });

  it('sorts after every W01 migration (the wave it depends on)', () => {
    const w01 = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(W01_PREFIX) && f.endsWith('.sql'));
    expect(w01.length).toBeGreaterThan(0);
    for (const file of w01) {
      expect(FILE.localeCompare(file), `${FILE} must sort after ${file}`).toBeGreaterThan(0);
    }
  });
});
