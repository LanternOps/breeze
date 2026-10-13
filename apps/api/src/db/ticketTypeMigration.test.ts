/**
 * #7900 (feature #8592 W01) — static guards on the tickets.ticket_type column
 * and its concurrent index migrations. The column add must stay metadata-only
 * (constant default, no row writes) and the index must never be built inside
 * the column migration's transaction.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const COLUMN_MIGRATION = '2026-12-25-150000-tickets-ticket-type.sql';
const INDEX_MIGRATION = '2026-12-25-150100-tickets-ticket-type-index.sql';
const ANCHOR = '2026-12-25-110000-caller-verification-link-tier.sql';

function listMigrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));
}

function readStatements(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

describe('tickets.ticket_type migrations (#7900)', () => {
  it('sort after the newest migration they were authored on top of, column before index', () => {
    const files = listMigrationFilenames();
    expect(files).toContain(ANCHOR);
    expect(files).toContain(COLUMN_MIGRATION);
    expect(files).toContain(INDEX_MIGRATION);
    expect(files.indexOf(COLUMN_MIGRATION)).toBeGreaterThan(files.indexOf(ANCHOR));
    expect(files.indexOf(INDEX_MIGRATION)).toBeGreaterThan(files.indexOf(COLUMN_MIGRATION));
  });

  it('column migration: guarded enum, constant-default column, no DML, no index, no inner BEGIN/COMMIT', () => {
    const sql = readStatements(COLUMN_MIGRATION);
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_type')");
    expect(flat).toContain("CREATE TYPE ticket_type AS ENUM ('incident', 'service_request', 'problem', 'change')");
    expect(flat).toContain("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type ticket_type NOT NULL DEFAULT 'incident'");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('index migration is @no-transaction and builds the index concurrently and idempotently', () => {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, INDEX_MIGRATION), 'utf8');
    expect(raw.split('\n')[0]).toMatch(/^\s*--\s*@no-transaction\b/);
    const flat = readStatements(INDEX_MIGRATION).replace(/\s+/g, ' ');
    expect(flat).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_org_type_status_idx ON public.tickets (org_id, ticket_type, status) WHERE deleted_at IS NULL',
    );
    expect(flat).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(flat).not.toMatch(/\bset_config\s*\(/i);
  });

  it('index migration fails loudly on an INVALID index left by an interrupted build', () => {
    const sql = readStatements(INDEX_MIGRATION);
    expect(sql).toMatch(/indisvalid/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/'public\.tickets'::regclass,\s*'tickets_org_type_status_idx'/);
  });
});
