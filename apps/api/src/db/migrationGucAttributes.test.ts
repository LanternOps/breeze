import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Guard against the v0.97.0 EU crash-loop class: setting a custom (dotted)
 * GUC like `breeze.scope` via a function ATTRIBUTE (`CREATE FUNCTION ... SET
 * breeze.scope = 'system'`) or via `ALTER FUNCTION/ROLE/DATABASE ... SET`
 * requires a privilege that prod's non-superuser migration role (doadmin on
 * DO managed Postgres) does not have — the API then crash-loops on boot with
 * 42501 "permission denied to set parameter". CI and local dev migrate as
 * the Postgres superuser, so nothing else catches this.
 *
 * The allowed alternative is in-body elevation with save/restore:
 *   _prev := current_setting('breeze.scope', true)  -- in DECLARE
 *   PERFORM set_config('breeze.scope', 'system', true)
 *   PERFORM set_config('breeze.scope', COALESCE(_prev, ''), true)  -- before
 *   each normal RETURN (error paths restore via transaction rollback).
 * See apps/api/migrations/2026-07-29-*.sql for the reference pattern.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** Matches `SET some.dotted_guc =` (optionally quoted). A dotted GUC name is
 * always a custom GUC. Runtime statement-form `SET x.y = ...;` and
 * `set_config(...)` calls are fine for non-superusers and stay allowed —
 * only the attribute form (line not terminated by `;`) and ALTER form are
 * superuser-gated. */
const DOTTED_GUC_SET = /SET\s+"?[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+"?\s*=/;

function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('migration files never set custom GUCs superuser-style', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}-.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  it('discovers migration files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has no custom-GUC function attributes', (file) => {
    const content = stripLineComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    const offending = content
      .split('\n')
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(
        ({ line }) =>
          DOTTED_GUC_SET.test(line) && /^\s*SET\s/.test(line) && !/;\s*$/.test(line.trimEnd()),
      );
    expect(
      offending.map(({ lineNo, line }) => `${file}:${lineNo}: ${line.trim()}`),
      'custom-GUC SET function attribute needs superuser in prod (42501); use in-body set_config save/restore instead',
    ).toEqual([]);
  });

  it.each(files)('%s has no ALTER ... SET custom-GUC statements', (file) => {
    const content = stripLineComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    const alterStatements = content.match(/ALTER\s+(FUNCTION|PROCEDURE|ROLE|DATABASE)[^;]*;/gi) ?? [];
    const offending = alterStatements.filter((statement) => DOTTED_GUC_SET.test(statement));
    expect(
      offending.map((statement) => `${file}: ${statement.replace(/\s+/g, ' ').trim()}`),
      'ALTER FUNCTION/ROLE/DATABASE ... SET on a custom GUC needs superuser in prod (42501); recreate the function with in-body set_config save/restore instead',
    ).toEqual([]);
  });
});
