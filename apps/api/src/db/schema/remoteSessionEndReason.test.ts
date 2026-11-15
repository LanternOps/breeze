/**
 * #11839 — `remote_sessions.end_reason` is a closed set held in three places:
 * the shared constant every writer is typed against, the Drizzle CHECK
 * declaration, and the migration that actually creates the CHECK. The writer
 * contract (`terminalIntentSet`) only accepts values from the constant, so if
 * the migration's list ever lagged behind it a terminal write would fail its
 * CHECK at runtime and the session would stay live. Pin all three together.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_SESSION_END_REASONS } from '@breeze/shared';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { remoteSessions } from './remote';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');
const CHECK_NAME = 'remote_sessions_end_reason_check';

function quotedValues(text: string): string[] {
  return [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The IN-list of the last migration (in apply order) that (re)creates the CHECK. */
function newestMigrationCheckValues(): { file: string; values: string[] } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}-.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b));
  let found: { file: string; values: string[] } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const re = new RegExp(`ADD CONSTRAINT ${CHECK_NAME}\\s+CHECK \\(end_reason IS NULL OR end_reason IN \\(([^)]*)\\)\\)`, 'g');
    for (const match of sql.matchAll(re)) {
      found = { file, values: quotedValues(match[1]!) };
    }
  }
  if (!found) throw new Error(`no migration creates ${CHECK_NAME}`);
  return found;
}

describe('remote_sessions.end_reason closed set (#11839)', () => {
  it('the newest migration that creates the CHECK allows exactly REMOTE_SESSION_END_REASONS', () => {
    const { file, values } = newestMigrationCheckValues();
    expect(file, 'the CHECK must be widened by a migration newer than the #10190 one').not.toBe(
      '2027-01-09-120100-remote-sessions-end-reason.sql',
    );
    expect([...values].sort()).toEqual([...REMOTE_SESSION_END_REASONS].sort());
  });

  it('the Drizzle CHECK declaration allows exactly REMOTE_SESSION_END_REASONS', () => {
    const check = getTableConfig(remoteSessions).checks.find((c) => c.name === CHECK_NAME);
    expect(check).toBeDefined();
    // Literal text only (StringChunks, including the nested sql.raw list);
    // column references contribute nothing.
    const literalText = (node: unknown): string => {
      if (!node || typeof node !== 'object') return '';
      if ('queryChunks' in node) return (node as { queryChunks: unknown[] }).queryChunks.map(literalText).join('');
      if ('value' in node) return ([] as unknown[]).concat((node as { value: unknown }).value).join('');
      return '';
    };
    const text = literalText(check!.value);
    expect([...quotedValues(text)].sort()).toEqual([...REMOTE_SESSION_END_REASONS].sort());
  });
});
