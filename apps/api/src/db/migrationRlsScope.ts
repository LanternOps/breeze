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
  /** The writing verb. `CTAS` is `CREATE TABLE … AS SELECT`. */
  kind: 'UPDATE' | 'DELETE' | 'INSERT' | 'MERGE' | 'CTAS' | 'COPY';
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
  // `CREATE TABLE x AS SELECT … FROM forced_table` materialises rows through a
  // policy-filtered read, so unscoped it silently creates an EMPTY table.
  [
    'CTAS',
    // `[^;]*?` (not `[\s\S]*?`) confines the gap between the table name and
    // `AS SELECT` to a SINGLE statement — otherwise a plain
    // `CREATE TABLE t (…);` matches an unrelated `AS SELECT` later in the file.
    String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TARGET}[^;]*?\bAS\s+(?:\(\s*)?(?:WITH|SELECT)\b`,
  ],
  ['COPY', String.raw`\bCOPY\s+${TARGET}(?:\s*\([^)]*\))?\s+FROM\b`],
];

/**
 * Deliberately NOT detected, so the omissions are a decision rather than an
 * oversight:
 *  - `TRUNCATE` — requires table ownership and bypasses row-level security
 *    outright, so electing scope changes nothing about its behaviour.
 *  - bare `SELECT … INTO newtable` — syntactically identical to plpgsql's
 *    variable assignment (`SELECT count(*) INTO n FROM t`), which appears in
 *    almost every `DO` block here. Matching it would be false positives all the
 *    way down. Use `CREATE TABLE … AS SELECT` instead, which is detected.
 */

/**
 * `SELECT set_config('breeze.scope','system', true)` or the `PERFORM` form
 * inside a DO block. Both elevate for the rest of autoMigrate's per-file
 * transaction; the third argument (`is_local`) is not inspected here because
 * `false` would leak the setting onto the pooled connection, which is a
 * different (and louder) problem than the one this guard is about.
 *
 * The leading `SELECT`/`PERFORM` is required, not decoration: without it any
 * prose that quotes the snippet would count as having run it.
 */
const SCOPE_ELEVATION =
  /\b(?:SELECT|PERFORM)\s+set_config\s*\(\s*'breeze\.scope'\s*,\s*'system'/i;

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

/** Offset of the first non-whitespace character at or after `from`, relative to `from`. */
function leadingWhitespace(sql: string, from: number): number {
  const rest = /^\s*/.exec(sql.slice(from));
  return rest ? rest[0].length : 0;
}

/** Name from a `CREATE [OR REPLACE] FUNCTION|PROCEDURE <name>(` header. */
function routineName(header: string): string | null {
  const match = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(
    header,
  );
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Escapes every regex metacharacter — backslash included — so `value`
 * matches only itself when spliced into a `RegExp` pattern. Escaping the
 * "special" characters while leaving a literal backslash untouched is the
 * classic incomplete-sanitization trap (CodeQL `js/incomplete-sanitization`):
 * a stray backslash in the input combines with whatever the escaper emits
 * next, instead of being matched literally, and can desynchronise the built
 * pattern. `\\` is listed first in the class for readability only — order
 * inside a character class does not matter.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Routines this file defines AND invokes itself, so their bodies execute at
 * migration time under the migration's own scope. `code` must come from a pass
 * with every routine body blanked, so a call written INSIDE another routine
 * (which runs later, under its caller's scope) does not count as one.
 */
function routinesInvokedAtMigrationTime(sql: string, code: string): Set<string> {
  const live = new Set<string>();
  for (const definition of sql.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/gi,
  )) {
    const name = definition[1]!.toLowerCase();
    const escaped = escapeRegExp(name);
    const called = new RegExp(
      String.raw`\b(?:SELECT|PERFORM|CALL|FROM|JOIN)\s+(?:"?public"?\s*\.\s*)?"?${escaped}"?\s*\(`,
      'i',
    );
    if (called.test(code)) live.add(name);
  }
  return live;
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
function scan(sql: string, liveRoutines: ReadonlySet<string>): ScanResult {
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
    // `CREATE RULE … DO ALSO <dml>` is the one routine definition whose body is
    // plain semicolon-terminated SQL rather than a dollar-quoted block, so the
    // body-blanking below never sees it. Its DML fires on a future write to the
    // ruled table, not at migration time, so blank the whole statement.
    if (dollarTags.length === 0 && i === statementStart + leadingWhitespace(sql, statementStart)) {
      const rule = /^CREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i.exec(sql.slice(i));
      if (rule) {
        const end = sql.indexOf(';', i);
        const stop = end === -1 ? sql.length : end;
        blank(i, stop, code);
        blank(i, stop, codeWithLiterals);
        i = stop;
        continue;
      }
    }

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
      // In an E'' string Postgres always honours C-style backslash escapes, so
      // `E'it\'s'` does NOT end at that inner quote. Missing this desynchronises
      // the whole scan: the rest of the literal is read as code, the next stray
      // quote opens a phantom literal, and every statement after it disappears
      // from the report — a silent false negative, the exact failure this guard
      // exists to prevent. A plain literal has no such escape under
      // standard_conforming_strings, where `'it\'` really does end the string.
      const escapes = /(?:^|[^A-Za-z0-9_])[Ee]$/.test(sql.slice(Math.max(0, i - 2), i));
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
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
        // Walk INTO a dollar-quoted body only when it is executable migration
        // code; blank it otherwise. Default-deny matters here: a body treated
        // as code is scanned for BOTH writes and `set_config` elevation, so a
        // dollar-quoted STRING that merely quotes the elevation snippet — a
        // `COMMENT ON … IS $$… set_config('breeze.scope','system',true) …$$`,
        // or a RAISE payload — would otherwise mark every later write in the
        // file as scoped and silently switch the guard off. This PR's own docs
        // make that text likely to appear near a migration.
        // Read the header from the BLANKED view: a `-- comment` or a string
        // sitting between the statement start and the `$$` would otherwise
        // break the `DO` match and get the whole block blanked as data.
        const header = code.slice(statementStart, i).join('');
        const executable =
          dollarTags.length === 0
            ? // Top level: a DO block runs now. A routine definition does not,
              // unless this same file goes on to CALL it.
              /^\s*DO\s*(?:LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*\s*)?$/i.test(header) ||
              (ROUTINE_DEFINITION.test(header) &&
                (() => {
                  const name = routineName(header);
                  return name !== null && liveRoutines.has(name);
                })())
            : // Nested: only an EXECUTE'd body is SQL about to run.
              isExecuted(code.join(''), i);
        if (!executable) {
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
  // Pass 1 blanks every routine body, which is exactly the view needed to tell
  // a migration-time call site from one inside another routine. Pass 2 then
  // re-scans with the bodies of self-invoked routines left visible.
  const blanked = scan(sql, new Set<string>());
  const liveRoutines = routinesInvokedAtMigrationTime(sql, blanked.code);
  const { code, codeWithLiterals, literals, statementStarts } =
    liveRoutines.size === 0 ? blanked : scan(sql, liveRoutines);
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
