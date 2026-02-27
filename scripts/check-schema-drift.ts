#!/usr/bin/env tsx
/**
 * Schema Drift Check
 *
 * Compares every column defined in the Drizzle pgTable() schema against
 * what exists in full-schema.sql and manual migration files.
 *
 * Catches the recurring bug where a column is added to a Drizzle schema
 * file but never migrated (no ALTER TABLE ADD COLUMN, not in full-schema.sql).
 *
 * Usage:
 *   pnpm check:schema-drift
 *   # or directly:
 *   tsx scripts/check-schema-drift.ts
 *
 * Exit code 0 = all columns covered, 1 = drift detected.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'apps/api/src/db/schema');
const FULL_SCHEMA = path.join(REPO_ROOT, 'apps/api/src/db/full-schema.sql');
const DRIZZLE_DIR = path.join(REPO_ROOT, 'apps/api/drizzle');
const MANUAL_DIR = path.join(REPO_ROOT, 'apps/api/src/db/migrations');

// ── Load all SQL content for searching ──────────────────────────────

function loadSqlContent(): string {
  const parts: string[] = [];

  // full-schema.sql
  try {
    parts.push(readFileSync(FULL_SCHEMA, 'utf8'));
  } catch {
    console.warn('⚠  full-schema.sql not found — checking migrations only');
  }

  // Drizzle-generated migrations
  try {
    for (const f of readdirSync(DRIZZLE_DIR)) {
      if (f.endsWith('.sql')) {
        parts.push(readFileSync(path.join(DRIZZLE_DIR, f), 'utf8'));
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('⚠  Error reading drizzle dir:', err.message);
  }

  // Manual SQL migrations
  try {
    for (const f of readdirSync(MANUAL_DIR)) {
      if (f.endsWith('.sql')) {
        parts.push(readFileSync(path.join(MANUAL_DIR, f), 'utf8'));
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('⚠  Error reading manual dir:', err.message);
  }

  return parts.join('\n');
}

// ── Import all Drizzle schema tables ────────────────────────────────

async function getDrizzleTables() {
  // Dynamic import so this script works from the repo root
  const schema = await import(path.join(SCHEMA_DIR, 'index.ts'));
  const tables: Array<{ tableName: string; columns: string[]; schemaFile: string }> = [];

  for (const [exportName, value] of Object.entries(schema)) {
    if (
      value &&
      typeof value === 'object' &&
      Symbol.for('drizzle:IsDrizzleTable') in (value as Record<symbol, unknown>)
    ) {
      try {
        const config = getTableConfig(value as any);
        const columns = config.columns.map((c) => c.name);
        // Find which file defines this table
        const schemaFile = findSchemaFile(config.name) ?? 'unknown';
        tables.push({ tableName: config.name, columns, schemaFile });
      } catch {
        // Not a table (might be an enum or relation)
      }
    }
  }

  return tables;
}

function findSchemaFile(tableName: string): string | null {
  try {
    for (const f of readdirSync(SCHEMA_DIR)) {
      if (!f.endsWith('.ts')) continue;
      const content = readFileSync(path.join(SCHEMA_DIR, f), 'utf8');
      if (content.includes(`pgTable('${tableName}'`)) {
        return `apps/api/src/db/schema/${f}`;
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('⚠  Error scanning schema dir:', err.message);
  }
  return null;
}

// ── Check column coverage ───────────────────────────────────────────

/**
 * For a given table, check that each column appears in the SQL corpus.
 *
 * We look for the column name in context of the table name to avoid
 * false positives from common column names (id, name, status, etc.).
 *
 * Patterns matched:
 *   CREATE TABLE ... table_name ( ... column_name ...
 *   ALTER TABLE table_name ADD COLUMN column_name
 *   "column_name" (within a CREATE TABLE block for the table)
 */
function checkColumnInSql(
  allSql: string,
  tableName: string,
  columnName: string,
): boolean {
  // Strategy 1: Check for column_name near table_name (within ~2000 chars)
  // This catches both CREATE TABLE blocks and ALTER TABLE statements.
  const tablePatterns = [
    // CREATE TABLE ... table_name ... column_name (pg_dump format)
    new RegExp(
      `CREATE TABLE[^;]*?${escapeRegex(tableName)}[^;]*?\\b${escapeRegex(columnName)}\\b`,
      's',
    ),
    // ALTER TABLE ... table_name ... ADD COLUMN ... column_name
    new RegExp(
      `ALTER TABLE[^;]*?${escapeRegex(tableName)}[^;]*?ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${escapeRegex(columnName)}\\b`,
      'si',
    ),
    // Quoted variants: "table_name" ... "column_name"
    new RegExp(
      `CREATE TABLE[^;]*?"${escapeRegex(tableName)}"[^;]*?"${escapeRegex(columnName)}"`,
      's',
    ),
    new RegExp(
      `ALTER TABLE[^;]*?"${escapeRegex(tableName)}"[^;]*?"${escapeRegex(columnName)}"`,
      'si',
    ),
  ];

  return tablePatterns.some((p) => p.test(allSql));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Main ────────────────────────────────────────────────────────────

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

async function main() {
  const allSql = loadSqlContent();
  const tables = await getDrizzleTables();

  let totalColumns = 0;
  let missingColumns = 0;
  const missing: Array<{ table: string; column: string; file: string }> = [];

  for (const { tableName, columns, schemaFile } of tables) {
    for (const col of columns) {
      totalColumns++;
      if (!checkColumnInSql(allSql, tableName, col)) {
        missingColumns++;
        missing.push({ table: tableName, column: col, file: schemaFile });
      }
    }
  }

  console.log(
    `Checked ${totalColumns} columns across ${tables.length} tables.\n`,
  );

  if (missing.length > 0) {
    console.log(`${RED}SCHEMA DRIFT DETECTED — ${missing.length} column(s) missing from SQL:${NC}\n`);
    for (const { table, column, file } of missing) {
      console.log(`  ${RED}✗${NC} ${table}.${column}  ${DIM}(defined in ${file})${NC}`);
    }
    console.log(
      `\n${YELLOW}Fix: Add a migration in apps/api/src/db/migrations/ with:${NC}`,
    );
    console.log(
      `${YELLOW}  ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <type>;${NC}`,
    );
    console.log(
      `${YELLOW}Then regenerate full-schema.sql:${NC}`,
    );
    console.log(
      `${YELLOW}  docker exec breeze-postgres pg_dump -U breeze -d breeze --schema-only --no-owner --no-privileges > apps/api/src/db/full-schema.sql${NC}`,
    );
    process.exit(1);
  }

  console.log(
    `${GREEN}✓ All ${totalColumns} columns across ${tables.length} tables have SQL coverage.${NC}`,
  );
}

main().catch((err) => {
  console.error('Schema drift check failed:', err);
  process.exit(1);
});
