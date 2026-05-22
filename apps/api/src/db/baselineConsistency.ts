/**
 * Baseline-consistency guard (issue #817).
 *
 * On a fresh install, `autoMigrate` applies `0001-baseline.sql` and then marks
 * every migration in the legacy range (2 .. LEGACY_CUTOFF) as applied WITHOUT
 * running its SQL — on the assumption that the consolidated baseline already
 * reflects them. If a legacy migration mutates the schema (drops a NOT NULL,
 * changes a type, drops/renames a column) and that change was never folded into
 * `0001-baseline.sql`, the effect is silently lost on every fresh install.
 *
 * This module parses the schema-shape mutations out of each legacy migration
 * and the column definitions out of the baseline so a test can assert the two
 * agree. ADD COLUMN is intentionally out of scope: a column missing from the
 * baseline is caught by `db:check-drift` (Drizzle declares the column, the DB
 * does not). The mutations below are the ones drift detection cannot catch,
 * because Drizzle and the migration agree while the baseline silently differs.
 */
import { LEGACY_CUTOFF } from './autoMigrate';

export type TrackedAlterKind = 'drop-not-null' | 'set-not-null' | 'type' | 'drop-column' | 'rename-column';

export interface TrackedAlter {
  kind: TrackedAlterKind;
  table: string;
  column: string;
  /** Present for `type`. */
  newType?: string;
  /** Present for `rename-column`. */
  newColumn?: string;
}

export interface BaselineColumn {
  type: string;
  notNull: boolean;
}

/** table name → (column name → column definition), parsed from `0001-baseline.sql`. */
export type BaselineSchema = Map<string, Map<string, BaselineColumn>>;

export interface BaselineCheckResult {
  satisfied: boolean;
  detail: string;
}

/**
 * Legacy migrations whose effect is genuinely absent from `0001-baseline.sql`
 * but is re-applied by a post-cutoff dated migration (which DOES run on fresh
 * installs). Key = legacy migration filename, value = justification.
 */
export const REMEDIATED_LEGACY_GAPS: Record<string, string> = {
  '0040-software-policy-scope-deprecation.sql':
    '0001-baseline.sql declares software_policies.target_type NOT NULL; the DROP NOT NULL is ' +
    're-applied post-cutoff by 2026-05-21-software-policies-target-type-nullable.sql (PR #812, issue #807/#808).',
};

/** Required regex capture group — throws if the group did not participate in the match. */
function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`missing capture group ${index} in "${match[0] ?? ''}"`);
  }
  return value;
}

/** Leading numeric prefix of a migration filename, or null if it has none. */
export function parseMigrationNumber(filename: string): number | null {
  const match = filename.match(/^(\d+)-/);
  return match ? Number.parseInt(group(match, 1), 10) : null;
}

/** True when the file is a legacy-range migration (2 .. LEGACY_CUTOFF) that fresh installs skip. */
export function isLegacyRangeMigration(filename: string): boolean {
  const num = parseMigrationNumber(filename);
  return num !== null && num >= 2 && num <= LEGACY_CUTOFF;
}

/** Strip `-- line` and block SQL comments so they cannot false-match. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// `ALTER TABLE [ONLY] [public.]<table>` — the shared prefix of every tracked statement.
const TABLE = String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?`;
const COLUMN = String.raw`"?(\w+)"?`;
// A type expression: one or more word tokens (none of them `USING`), plus an optional `(...)`.
const TYPE_EXPR = String.raw`((?:(?!USING\b)[a-zA-Z]\w*)(?:\s+(?!USING\b)[a-zA-Z]\w*)*(?:\s*\([^)]*\))?)`;

interface AlterPattern {
  regex: RegExp;
  build: (m: RegExpMatchArray) => TrackedAlter;
}

const ALTER_PATTERNS: AlterPattern[] = [
  {
    regex: new RegExp(`${TABLE}\\s+ALTER\\s+COLUMN\\s+${COLUMN}\\s+DROP\\s+NOT\\s+NULL`, 'gi'),
    build: (m) => ({ kind: 'drop-not-null', table: group(m, 1), column: group(m, 2) }),
  },
  {
    regex: new RegExp(`${TABLE}\\s+ALTER\\s+COLUMN\\s+${COLUMN}\\s+SET\\s+NOT\\s+NULL`, 'gi'),
    build: (m) => ({ kind: 'set-not-null', table: group(m, 1), column: group(m, 2) }),
  },
  {
    regex: new RegExp(`${TABLE}\\s+ALTER\\s+COLUMN\\s+${COLUMN}\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+${TYPE_EXPR}`, 'gi'),
    build: (m) => ({ kind: 'type', table: group(m, 1), column: group(m, 2), newType: group(m, 3).trim() }),
  },
  {
    regex: new RegExp(`${TABLE}\\s+DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${COLUMN}`, 'gi'),
    build: (m) => ({ kind: 'drop-column', table: group(m, 1), column: group(m, 2) }),
  },
  {
    regex: new RegExp(`${TABLE}\\s+RENAME\\s+COLUMN\\s+${COLUMN}\\s+TO\\s+${COLUMN}`, 'gi'),
    build: (m) => ({ kind: 'rename-column', table: group(m, 1), column: group(m, 2), newColumn: group(m, 3) }),
  },
];

/** Extract every tracked schema-shape mutation from a migration's SQL, in source order. */
export function extractTrackedAlters(sql: string): TrackedAlter[] {
  const clean = stripSqlComments(sql);
  const found: Array<{ index: number; alter: TrackedAlter }> = [];

  for (const { regex, build } of ALTER_PATTERNS) {
    for (const match of clean.matchAll(regex)) {
      found.push({ index: match.index ?? 0, alter: build(match) });
    }
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.alter);
}

/** Type expressions normalized for comparison (lowercased, whitespace collapsed). */
function normalizeType(type: string): string {
  return type.trim().toLowerCase().replace(/\s+/g, ' ');
}

const CONSTRAINT_LINE = /^\s*(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i;

/** Parse every `CREATE TABLE` block of `0001-baseline.sql` into a column map. */
export function parseBaselineTables(baselineSql: string): BaselineSchema {
  const schema: BaselineSchema = new Map();
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi;

  for (const tableMatch of baselineSql.matchAll(tableRegex)) {
    const tableName = group(tableMatch, 1);
    const body = group(tableMatch, 2);
    const columns = new Map<string, BaselineColumn>();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,\s*$/, '');
      if (!line || CONSTRAINT_LINE.test(line)) continue;

      const colMatch = line.match(/^"?(\w+)"?\s+(.+)$/);
      if (!colMatch) continue;
      const columnName = group(colMatch, 1);
      const rest = group(colMatch, 2);

      const notNull = /\bNOT\s+NULL\b/i.test(rest);
      // The type is everything up to the first DEFAULT / NOT NULL / GENERATED / COLLATE clause.
      const cutPoints = [/\bDEFAULT\b/i, /\bNOT\s+NULL\b/i, /\bGENERATED\b/i, /\bCOLLATE\b/i]
        .map((re) => rest.match(re)?.index ?? -1)
        .filter((i) => i >= 0);
      const type = (cutPoints.length ? rest.slice(0, Math.min(...cutPoints)) : rest).trim();

      columns.set(columnName, { type, notNull });
    }

    schema.set(tableName, columns);
  }

  return schema;
}

/** Verify a legacy migration's schema mutation is reflected in the parsed baseline. */
export function checkAlterAgainstBaseline(alter: TrackedAlter, baseline: BaselineSchema): BaselineCheckResult {
  const table = baseline.get(alter.table);
  const column = table?.get(alter.column);

  switch (alter.kind) {
    case 'drop-not-null':
      if (!table) return { satisfied: false, detail: `table "${alter.table}" is absent from the baseline` };
      if (!column) return { satisfied: false, detail: `column "${alter.column}" is absent from the baseline` };
      return column.notNull
        ? { satisfied: false, detail: 'baseline still declares this column NOT NULL' }
        : { satisfied: true, detail: 'baseline column is nullable' };

    case 'set-not-null':
      if (!table) return { satisfied: false, detail: `table "${alter.table}" is absent from the baseline` };
      if (!column) return { satisfied: false, detail: `column "${alter.column}" is absent from the baseline` };
      return column.notNull
        ? { satisfied: true, detail: 'baseline column is NOT NULL' }
        : { satisfied: false, detail: 'baseline declares this column nullable' };

    case 'type': {
      if (!table) return { satisfied: false, detail: `table "${alter.table}" is absent from the baseline` };
      if (!column) return { satisfied: false, detail: `column "${alter.column}" is absent from the baseline` };
      const expected = normalizeType(alter.newType ?? '');
      const actual = normalizeType(column.type);
      return actual === expected
        ? { satisfied: true, detail: `baseline type is "${column.type}"` }
        : { satisfied: false, detail: `baseline type is "${column.type}", migration sets "${alter.newType}"` };
    }

    case 'drop-column':
      // A table entirely absent from the baseline has nothing to mismatch.
      if (!table) return { satisfied: true, detail: `table "${alter.table}" is absent from the baseline` };
      return table.has(alter.column)
        ? { satisfied: false, detail: 'column is still present in the baseline' }
        : { satisfied: true, detail: 'column is absent from the baseline' };

    case 'rename-column': {
      if (!table) return { satisfied: true, detail: `table "${alter.table}" is absent from the baseline` };
      if (table.has(alter.column)) {
        return { satisfied: false, detail: `old column name "${alter.column}" is still present in the baseline` };
      }
      return table.has(alter.newColumn ?? '')
        ? { satisfied: true, detail: `baseline has the renamed column "${alter.newColumn}"` }
        : { satisfied: false, detail: `renamed column "${alter.newColumn}" is absent from the baseline` };
    }
  }
}
