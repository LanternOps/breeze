/**
 * Static analysis behind the "migration DML needs system scope" guard
 * (`migrationRlsScope.test.ts`). See that file's header for the failure class,
 * the measured evidence, and why the rule is phrased over EVERY table rather
 * than over a derived FORCE-RLS table set.
 *
 * The job here is narrow: given one migration's SQL, report every data-
 * modifying statement in it and whether `breeze.scope` was already set to
 * 'system' at that point in the file. No database, no schema import — this
 * runs in the plain `Test API` unit job.
 */

/** A data-modifying statement found in a migration file. */
export interface MigrationDmlStatement {
  /** `UPDATE` | `DELETE` | `INSERT` | `MERGE`. */
  kind: 'UPDATE' | 'DELETE' | 'INSERT' | 'MERGE';
  /** Target table, schema prefix and quotes stripped, lower-cased. `%i`/`%s` for a `format()` placeholder. */
  table: string;
  /** 1-based line number in the original file, for diagnostics. */
  line: number;
  /** True when the statement was built as a string and run via `EXECUTE`. */
  dynamic: boolean;
  /** True when `set_config('breeze.scope','system', …)` is already in effect here. */
  scoped: boolean;
}

// A table reference: optional schema qualifier, quoted or bare identifier, or a
// `format()` placeholder (`%I`/`%s`) for EXECUTE-built dynamic DML.
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*|%[IsL])`;
const TARGET = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;

// Deliberately grammatical rather than keyword-based, so the non-DML uses of
// these words do not match: `GRANT SELECT, INSERT, UPDATE, DELETE ON t`,
// `CREATE POLICY … FOR UPDATE`, `CREATE TRIGGER … AFTER UPDATE ON t`,
// `FOREIGN KEY … ON UPDATE CASCADE`, and `SELECT … FOR UPDATE` all lack the
// `SET` / `FROM` / `INTO` that actually makes the statement write rows.
// `WITH … UPDATE t SET` (a CTE-fronted write) matches, because the pattern is
// unanchored and looks for the writing clause wherever it appears.
const DML_PATTERNS: ReadonlyArray<readonly [MigrationDmlStatement['kind'], string]> = [
  [
    'UPDATE',
    String.raw`\bUPDATE\s+(?:ONLY\s+)?${TARGET}(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_$]*)?\s+SET\b`,
  ],
  ['DELETE', String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${TARGET}`],
  ['INSERT', String.raw`\bINSERT\s+INTO\s+(?:ONLY\s+)?${TARGET}`],
  ['MERGE', String.raw`\bMERGE\s+INTO\s+(?:ONLY\s+)?${TARGET}`],
];

/**
 * `SELECT set_config('breeze.scope','system', true)` or the `PERFORM` form
 * inside a DO block. Both elevate for the rest of autoMigrate's per-file
 * transaction; the third argument (`is_local`) is not inspected here because
 * `false` would leak the setting onto the pooled connection, which is a
 * different (and louder) problem than the one this guard is about.
 */
const SCOPE_ELEVATION = /set_config\s*\(\s*'breeze\.scope'\s*,\s*'system'/i;

/**
 * A statement that DEFINES executable SQL rather than running it now. The body
 * of a function/procedure/trigger/policy/view runs later, under whatever scope
 * its eventual caller has, so DML inside one is not a migration-time write and
 * must not be flagged.
 */
const ROUTINE_DEFINITION =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|POLICY|RULE|VIEW|MATERIALIZED\s+VIEW)\b/i;

/** autoMigrate sends each statement of such a file separately — see `hasNoTransactionDirective`. */
const NO_TRANSACTION_DIRECTIVE = /^\s*--\s*@no-transaction\b/m;

function normalizeTable(raw: string): string {
  return raw.replace(/"/g, '').split('.').pop()!.toLowerCase();
}

interface ScanResult {
  /** Comments, string literals and routine bodies blanked out; offsets preserved. */
  code: string;
  /** Comments and routine bodies blanked out, string literals preserved; offsets preserved. */
  codeWithLiterals: string;
  /** Single-quoted literals outside routine bodies — the raw material for `EXECUTE`-built DML. */
  literals: Array<{ start: number; text: string }>;
  /** Offset at which each top-level (semicolon-separated) statement begins. */
  statementStarts: number[];
}

/**
 * Single pass over the file that classifies every character as code, comment,
 * string literal, or routine body. Blanked regions are replaced space-for-space
 * (newlines kept) so every offset still maps back to the original line.
 *
 * Dollar-quoted blocks are walked INTO rather than skipped: a `DO $$ … $$`
 * body is migration-time code and its DML must be seen. Only the body of a
 * routine DEFINITION is blanked.
 */
function scan(sql: string): ScanResult {
  const code = sql.split('');
  const codeWithLiterals = sql.split('');
  const literals: Array<{ start: number; text: string }> = [];
  const statementStarts: number[] = [0];

  const blank = (from: number, to: number, target: string[]): void => {
    for (let k = from; k < to; k++) if (target[k] !== '\n') target[k] = ' ';
  };

  let i = 0;
  let statementStart = 0;
  // Open dollar-quote tags we have walked into. A `;` only ends a statement at
  // depth 0 — the ones inside a `DO $$ … $$` body belong to the block.
  const dollarTags: string[] = [];
  while (i < sql.length) {
    const pair = sql.slice(i, i + 2);

    if (pair === '--') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end, code);
      blank(i, end, codeWithLiterals);
      i = end;
      continue;
    }

    if (pair === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') {
          depth++;
          j += 2;
          continue;
        }
        if (sql.slice(j, j + 2) === '*/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      blank(i, j, code);
      blank(i, j, codeWithLiterals);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      literals.push({ start: i, text: sql.slice(i, j) });
      blank(i, j, code);
      i = j;
      continue;
    }

    if (sql[i] === '"') {
      // Quoted identifier — part of the grammar, so it is left intact.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    if (sql[i] === '$') {
      const opener = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (opener) {
        const tag = opener[0];
        if (dollarTags[dollarTags.length - 1] === tag) {
          dollarTags.pop();
          i += tag.length;
          continue;
        }
        // A routine DEFINITION's body is dead text for this analysis; skip it
        // whole. A `DO` block's body is live migration code, so walk into it.
        if (dollarTags.length === 0 && ROUTINE_DEFINITION.test(sql.slice(statementStart, i))) {
          const end = sql.indexOf(tag, i + tag.length);
          const bodyEnd = end === -1 ? sql.length : end + tag.length;
          blank(i, bodyEnd, code);
          blank(i, bodyEnd, codeWithLiterals);
          i = bodyEnd;
          continue;
        }
        dollarTags.push(tag);
        i += tag.length;
        continue;
      }
    }

    if (sql[i] === ';' && dollarTags.length === 0) {
      statementStart = i + 1;
      statementStarts.push(statementStart);
    }
    i++;
  }

  return {
    code: code.join(''),
    codeWithLiterals: codeWithLiterals.join(''),
    literals: literals.filter((literal) => codeWithLiterals[literal.start] === "'"),
    statementStarts,
  };
}

/**
 * True when the string literal starting at `offset` is the argument of an
 * `EXECUTE` — i.e. SQL about to be run, not a message about SQL. `[^;]*$`
 * confines the search to the current inner statement, so the `EXECUTE` on a
 * previous line of the same `DO` block does not vouch for a later `RAISE`.
 */
function isExecuted(code: string, offset: number): boolean {
  const window = code.slice(Math.max(0, offset - 400), offset);
  return /\bEXECUTE\b[^;]*$/is.test(window);
}

function lineNumberAt(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) if (sql[i] === '\n') line++;
  return line;
}

/**
 * Report every data-modifying statement in one migration file, in file order,
 * each marked with whether `breeze.scope` was already 'system' at that point.
 *
 * Scope coverage is offset-based rather than statement-based because
 * autoMigrate wraps the whole file in one transaction, so a
 * `SELECT set_config(…, true)` at the top covers everything after it —
 * including DML inside later `DO $$ … $$` blocks. The exception is a file
 * carrying the `-- @no-transaction` directive: autoMigrate then sends each
 * statement as its own command, a transaction-local setting expires
 * immediately, and only an elevation inside the SAME statement counts.
 */
export function analyzeMigrationDml(sql: string): MigrationDmlStatement[] {
  const { code, codeWithLiterals, literals, statementStarts } = scan(sql);
  const perStatementScope = NO_TRANSACTION_DIRECTIVE.test(sql);

  const fileScopeMatch = SCOPE_ELEVATION.exec(codeWithLiterals);
  const fileScopeAt = fileScopeMatch ? fileScopeMatch.index : Number.POSITIVE_INFINITY;

  const found: Array<Omit<MigrationDmlStatement, 'line' | 'scoped'> & { offset: number }> = [];
  for (const [kind, source] of DML_PATTERNS) {
    for (const match of code.matchAll(new RegExp(source, 'gi'))) {
      found.push({ kind, table: normalizeTable(match[1]!), offset: match.index, dynamic: false });
    }
    // `EXECUTE format('UPDATE %I SET …', tbl)` — the write lives inside a string
    // literal, so the masked `code` view cannot see it. Only literals actually
    // being EXECUTEd count: without that gate a diagnostic string such as
    // `RAISE NOTICE 'skipping UPDATE devices SET …'` would read as a write.
    // Skip literals that define a routine rather than run a write.
    for (const literal of literals) {
      if (ROUTINE_DEFINITION.test(literal.text)) continue;
      if (!isExecuted(code, literal.start)) continue;
      for (const match of literal.text.matchAll(new RegExp(source, 'gi'))) {
        found.push({
          kind,
          table: normalizeTable(match[1]!),
          offset: literal.start + match.index,
          dynamic: true,
        });
      }
    }
  }

  const statementStartAt = (offset: number): number => {
    let start = 0;
    for (const candidate of statementStarts) {
      if (candidate <= offset) start = candidate;
      else break;
    }
    return start;
  };

  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, ...rest }) => ({
      ...rest,
      line: lineNumberAt(sql, offset),
      scoped: perStatementScope
        ? SCOPE_ELEVATION.test(codeWithLiterals.slice(statementStartAt(offset), offset))
        : fileScopeAt < offset,
    }));
}

/** The DML in one migration that runs without system scope — the guard's unit of failure. */
export function findUnscopedMigrationDml(sql: string): MigrationDmlStatement[] {
  return analyzeMigrationDml(sql).filter((statement) => !statement.scoped);
}
