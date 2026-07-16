import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Regression test for issue #506. A `localeCompare` sort places
// `2026-04-19-installer-bootstrap-tokens-constraints.sql` before
// `...-tokens.sql` (because '-' < '.'), so the constraints migration ran
// before the table that owns those constraints existed. This scans every
// migration in the same order autoMigrate uses and asserts that each
// referenced table was created in this file or an earlier one.
describe('migration ordering', () => {
  const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;
  const migrationsDir = path.resolve(__dirname, '../../migrations');

  const SYSTEM_TABLES = new Set([
    'pg_policies',
    'pg_indexes',
    'pg_class',
    'pg_namespace',
    'pg_trigger',
    'pg_proc',
    'pg_constraint',
    'pg_attribute',
    'pg_type',
    'pg_tables',
    'information_schema',
  ]);

  function collectMatches(sql: string, pattern: RegExp): string[] {
    const out: string[] = [];
    for (const match of sql.matchAll(pattern)) {
      if (match[1]) out.push(match[1].toLowerCase());
    }
    return out;
  }

  function extractCreatedTables(sql: string): string[] {
    return collectMatches(
      sql,
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
    );
  }

  function extractReferencedTables(sql: string): string[] {
    const stripped = sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Only patterns that hard-fail when the table is missing. Tolerant
    // forms like `DROP TABLE IF EXISTS` or `ALTER TABLE IF EXISTS` are
    // intentionally excluded — they're a no-op against an absent table.
    const patterns = [
      /\bREFERENCES\s+(?!"?public"?\s*\.\s*%)(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      /\bALTER\s+TABLE\s+(?!IF\s+EXISTS\b)(?:ONLY\s+)?(?!"?public"?\s*\.\s*%)(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      /\bCREATE\s+POLICY\s+[^;]*?\bON\s+(?!"?public"?\s*\.\s*%)(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[^;]*?\bON\s+(?!"?public"?\s*\.\s*%)(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      /\bCREATE\s+TRIGGER\s+[^;]*?\bON\s+(?!"?public"?\s*\.\s*%)(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
    ];
    const refs: string[] = [];
    for (const pattern of patterns) refs.push(...collectMatches(stripped, pattern));
    return refs;
  }

  it('ignores format placeholders while retaining static trigger targets', () => {
    expect(extractReferencedTables(`
      EXECUTE format('CREATE TRIGGER t AFTER UPDATE ON public.%I EXECUTE FUNCTION f()', name);
    `)).toEqual([]);
    expect(extractReferencedTables(`
      CREATE TRIGGER t AFTER UPDATE ON public.real_table EXECUTE FUNCTION f();
    `)).toContain('real_table');
  });

  it('every referenced table is created in the same file or an earlier one', async () => {
    const files = (await readdir(migrationsDir))
      .filter((name) => MIGRATION_FILE_PATTERN.test(name))
      .sort((a, b) => a.localeCompare(b));

    expect(files.length).toBeGreaterThan(0);

    const migrations = await Promise.all(files.map(async (file) => ({
      file,
      sql: await readFile(path.join(migrationsDir, file), 'utf8'),
    })));

    const created = new Set<string>();
    const violations: string[] = [];

    for (const { file, sql } of migrations) {
      // Add tables created in this file BEFORE checking references so a
      // file that creates a table and immediately alters or self-references
      // it passes.
      for (const t of extractCreatedTables(sql)) created.add(t);
      for (const ref of extractReferencedTables(sql)) {
        if (SYSTEM_TABLES.has(ref)) continue;
        if (created.has(ref)) continue;
        violations.push(`${file} references "${ref}" before it is created`);
      }
    }

    expect(violations).toEqual([]);
  });
});
