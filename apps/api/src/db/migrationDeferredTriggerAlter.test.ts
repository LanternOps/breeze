import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A row write that fires a DEFERRABLE INITIALLY DEFERRED trigger queues a
 * trigger event until commit. Later DDL on the table that owns the event, in
 * the same transaction, then fails with
 *   cannot ALTER TABLE "<table>" because it has pending trigger events
 * Every migration file runs in one transaction (autoMigrate), so a file that
 * queues such an event and then runs DDL on that table must fire the events
 * first (`SET CONSTRAINTS ALL IMMEDIATE`). The failure only shows when the
 * write matched rows, so CI's empty databases never catch it; v0.122.0
 * crash-looped the hosted EU API on 2026-12-12-120100.
 *
 * Event sources (#8397):
 *  - a deferred constraint trigger on T: any INSERT/UPDATE/DELETE on T;
 *  - a deferred FK from child C to parent P: INSERT into C, an UPDATE of C that
 *    sets an FK column (an UPDATE leaving the key alone queues nothing), and a
 *    DELETE from P when the FK has no ON DELETE action (CASCADE, SET NULL and
 *    RESTRICT actions are never deferred). The event belongs to C or P
 *    respectively, and only DDL on that table fails.
 * DDL that fails: ALTER TABLE, non-concurrent CREATE [UNIQUE] INDEX ... ON, and
 * TRUNCATE.
 *
 * Each file is scanned in order with the sources inherited from earlier files:
 * a source counts from its CREATE/ADD onward and stops at DROP TRIGGER, DROP
 * CONSTRAINT, ALTER CONSTRAINT ... NOT DEFERRABLE / INITIALLY IMMEDIATE, or
 * DROP TABLE. Writes inside function bodies are ignored (defined, not run);
 * writes and DDL inside DO blocks count, including EXECUTE format(...) whose
 * arguments are literals or columns of a `FOR v IN SELECT * FROM (VALUES ...)`
 * loop. Not modelled: DROP TABLE as failing DDL, UPDATEs of a parent's key, and
 * events queued on a child by an ON UPDATE CASCADE from its parent.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// [schema.]table, each part optionally double-quoted. The lookahead stops a
// `public.%I` format placeholder being read as a table named `public`.
const TABLE = String.raw`((?:"?\w+"?\s*\.\s*)?"?\w+"?)(?![\w".%])`;
const IDENT = String.raw`"?(\w+)"?`;
const SQL_STRING = String.raw`'(?:[^']|'')*'`;
const UNRESOLVED = '__unresolved__';

function normTable(raw: string): string {
  const parts = raw.split('.').map((p) => p.trim().replace(/"/g, '').toLowerCase());
  return parts.length === 2 && parts[0] !== 'public' ? parts.join('.') : parts[parts.length - 1]!;
}

/** Blank out text while keeping offsets stable. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
}

/**
 * Blank dollar-quoted bodies that follow `AS` (function/procedure bodies):
 * they are definitions, not statements the migration runs. DO bodies stay.
 */
function stripFunctionBodies(sql: string): string {
  const open = /\$(\w*)\$/g;
  const stack: string[] = [];
  let out = sql;
  let m: RegExpExecArray | null;
  while ((m = open.exec(out))) {
    const tag = m[0];
    if (stack[stack.length - 1] === tag) {
      stack.pop();
      continue;
    }
    if (/\bAS\s*$/i.test(out.slice(Math.max(0, m.index - 16), m.index))) {
      const close = out.indexOf(tag, m.index + tag.length);
      const stop = close === -1 ? out.length : close + tag.length;
      out = out.slice(0, m.index) + blank(out.slice(m.index, stop)) + out.slice(stop);
      open.lastIndex = stop;
    } else {
      stack.push(tag);
    }
  }
  return out;
}

function unquote(lit: string): string {
  return lit.slice(1, -1).replace(/''/g, "'");
}

function applyFormat(fmt: string, args: string[]): string {
  let next = 0;
  return fmt.replace(/%(?:(\d+)\$)?([IsL%])/g, (_, pos: string | undefined, spec: string) => {
    if (spec === '%') return '%';
    const value = args[pos ? Number(pos) - 1 : next++] ?? UNRESOLVED;
    return spec === 'L' ? `'${value.replace(/'/g, "''")}'` : value;
  });
}

/**
 * Expand each `EXECUTE format('<sql>', args...)` whose arguments are string
 * literals or `<loopvar>.<col>` of an enclosing VALUES loop (one expansion per
 * row). Unresolvable arguments become UNRESOLVED, which matches no real table.
 */
function expandExecuteFormats(sql: string): { at: number; sql: string }[] {
  const loops: { at: number; v: string; rows: Record<string, string>[] }[] = [];
  const loopRe = new RegExp(
    String.raw`FOR\s+(\w+)\s+IN\s+SELECT\s+\*\s+FROM\s+\(\s*VALUES([\s\S]*?)\)\s+AS\s+\w+\s*\(([^)]*)\)\s+LOOP`,
    'gi',
  );
  const rowRe = new RegExp(String.raw`\(\s*(${SQL_STRING}(?:\s*,\s*${SQL_STRING})*)\s*\)`, 'g');
  for (const m of sql.matchAll(loopRe)) {
    const cols = m[3]!.split(',').map((c) => c.trim().toLowerCase());
    const rows = [...m[2]!.matchAll(rowRe)].map((row) => {
      const values = [...row[1]!.matchAll(new RegExp(SQL_STRING, 'g'))].map((v) => unquote(v[0]));
      return Object.fromEntries(cols.map((c, i) => [c, values[i] ?? UNRESOLVED]));
    });
    loops.push({ at: m.index ?? 0, v: m[1]!.toLowerCase(), rows });
  }

  const out: { at: number; sql: string }[] = [];
  const execRe = new RegExp(
    String.raw`EXECUTE\s+format\s*\(\s*(${SQL_STRING})((?:\s*,\s*(?:${SQL_STRING}|[\w.]+))*)\s*\)`,
    'gi',
  );
  for (const m of sql.matchAll(execRe)) {
    const at = m.index ?? 0;
    const fmt = unquote(m[1]!);
    const rawArgs = [...(m[2] ?? '').matchAll(new RegExp(String.raw`${SQL_STRING}|[\w.]+`, 'g'))].map((a) => a[0]);
    const loopVars = new Set(rawArgs.filter((a) => a.includes('.')).map((a) => a.split('.')[0]!.toLowerCase()));
    const loop = [...loops].reverse().find((l) => l.at < at && loopVars.has(l.v));
    for (const row of loop ? loop.rows : [{} as Record<string, string>]) {
      const args = rawArgs.map((a) => {
        if (a.startsWith("'")) return unquote(a);
        const [v, col] = a.toLowerCase().split('.');
        return loop && v === loop.v && col ? (row[col] ?? UNRESOLVED) : UNRESOLVED;
      });
      out.push({ at, sql: applyFormat(fmt, args) });
    }
  }
  return out;
}

type Source =
  | { kind: 'trigger'; key: string; name: string; table: string }
  | { kind: 'fk'; key: string; name: string; child: string; parent: string; cols: string[]; parentDelete: boolean };

type WriteEvent = { at: number; type: 'write'; verb: 'insert' | 'update' | 'delete'; table: string; setClause: string };

type Event =
  | { at: number; type: 'source'; source: Source; deferred: boolean }
  | { at: number; type: 'dropTrigger'; name: string; table: string }
  | { at: number; type: 'dropConstraint'; name: string }
  | { at: number; type: 'alterConstraint'; name: string; deferred: boolean }
  | { at: number; type: 'dropTable'; tables: string[] }
  | WriteEvent
  | { at: number; type: 'ddl'; table: string }
  | { at: number; type: 'flush'; names: string[] | 'all' };

const FK_TAIL = String.raw`((?:\s+(?:ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)(?:\s*\([^)]*\))?|MATCH\s+\w+|NOT\s+DEFERRABLE|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|NOT\s+VALID))*)`;

function isDeferred(clause: string): boolean {
  return /INITIALLY\s+DEFERRED/i.test(clause) && !/NOT\s+DEFERRABLE/i.test(clause);
}

/** The table of the nearest CREATE TABLE / ALTER TABLE before `at`. */
function owningTable(sql: string, at: number): string | undefined {
  const re = new RegExp(
    String.raw`(?:CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?)${TABLE}`,
    'gi',
  );
  let owner: string | undefined;
  for (const m of sql.matchAll(re)) {
    if ((m.index ?? 0) > at) break;
    owner = normTable(m[1]!);
  }
  return owner;
}

function foreignKeys(sql: string): Event[] {
  const events: Event[] = [];
  const re = new RegExp(String.raw`\bREFERENCES\s+${TABLE}\s*(?:\([^)]*\))?${FK_TAIL}`, 'gi');
  const tableFkRe = new RegExp(String.raw`(?:CONSTRAINT\s+${IDENT}\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*$`, 'i');
  const inlineNameRe = new RegExp(String.raw`CONSTRAINT\s+${IDENT}\s+$`, 'i');
  for (const m of sql.matchAll(re)) {
    const at = m.index ?? 0;
    const before = sql.slice(Math.max(0, at - 400), at);
    const tableFk = tableFkRe.exec(before);
    let name: string | undefined;
    let cols: string[];
    if (tableFk) {
      name = tableFk[1]?.toLowerCase();
      cols = tableFk[2]!.split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase());
    } else {
      // Inline column FK: `<col> <type> [...] [CONSTRAINT n] REFERENCES ...`.
      const colDef = /[(,]\s*"?(\w+)"?\s[^(),]*$/.exec(before);
      if (!colDef) continue;
      cols = [colDef[1]!.toLowerCase()];
      name = inlineNameRe.exec(before)?.[1]?.toLowerCase();
    }
    const child = owningTable(sql, at);
    if (!child) continue;
    const tail = m[2] ?? '';
    const onDelete = /ON\s+DELETE\s+(NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.exec(tail)?.[1];
    name ??= `${child}_${cols.join('_')}_fkey`;
    events.push({
      at,
      type: 'source',
      deferred: isDeferred(tail),
      source: {
        kind: 'fk',
        key: `fk:${child}:${name}`,
        name,
        child,
        parent: normTable(m[1]!),
        cols,
        parentDelete: !onDelete || /NO\s+ACTION/i.test(onDelete),
      },
    });
  }
  return events;
}

function extractEvents(sql: string): Event[] {
  const events: Event[] = [];
  const all = (re: string) => sql.matchAll(new RegExp(re, 'gi'));
  const at = (m: RegExpMatchArray) => m.index ?? 0;

  for (const m of all(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?CONSTRAINT\s+TRIGGER\s+${IDENT}([\s\S]*?);`)) {
    const on = new RegExp(String.raw`\bON\s+${TABLE}`, 'i').exec(m[2]!);
    if (!on) continue;
    const name = m[1]!.toLowerCase();
    const table = normTable(on[1]!);
    events.push({
      at: at(m),
      type: 'source',
      deferred: isDeferred(m[2]!),
      source: { kind: 'trigger', key: `trigger:${table}:${name}`, name, table },
    });
  }
  events.push(...foreignKeys(sql));
  for (const m of all(String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+${TABLE}`)) {
    events.push({ at: at(m), type: 'dropTrigger', name: m[1]!.toLowerCase(), table: normTable(m[2]!) });
  }
  for (const m of all(String.raw`DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${IDENT}`)) {
    events.push({ at: at(m), type: 'dropConstraint', name: m[1]!.toLowerCase() });
  }
  for (const m of all(
    String.raw`ALTER\s+CONSTRAINT\s+${IDENT}((?:\s+(?:NOT\s+DEFERRABLE|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)))+)`,
  )) {
    events.push({ at: at(m), type: 'alterConstraint', name: m[1]!.toLowerCase(), deferred: isDeferred(m[2]!) });
  }
  for (const m of all(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)`)) {
    const tables = m[1]!
      .replace(/\b(?:CASCADE|RESTRICT)\b/gi, '')
      .split(',')
      .map((t) => normTable(t.trim()));
    events.push({ at: at(m), type: 'dropTable', tables });
  }
  for (const m of all(String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?${TABLE}`)) {
    const verb = /^INSERT/i.test(m[1]!) ? 'insert' : /^UPDATE/i.test(m[1]!) ? 'update' : 'delete';
    const rest = sql.slice(at(m) + m[0].length);
    const setClause = verb === 'update' ? (/^[\s\S]*?(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$)/i.exec(rest)?.[0] ?? '') : '';
    events.push({ at: at(m), type: 'write', verb, table: normTable(m[2]!), setClause });
  }
  for (const m of all(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}`)) {
    events.push({ at: at(m), type: 'ddl', table: normTable(m[1]!) });
  }
  for (const m of all(
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)"?\w+"?\s+)?ON\s+(?:ONLY\s+)?${TABLE}`,
  )) {
    events.push({ at: at(m), type: 'ddl', table: normTable(m[1]!) });
  }
  const truncTarget = new RegExp(String.raw`^\s*(?:ONLY\s+)?${TABLE}`, 'i');
  for (const m of all(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?([^;]+)`)) {
    for (const t of m[1]!.split(',')) {
      const name = truncTarget.exec(t)?.[1];
      if (name) events.push({ at: at(m), type: 'ddl', table: normTable(name) });
    }
  }
  for (const m of all(String.raw`SET\s+CONSTRAINTS\s+([\w\s,."]+?)\s+IMMEDIATE`)) {
    const names = m[1]!.trim();
    events.push({
      at: at(m),
      type: 'flush',
      names: /^ALL$/i.test(names) ? 'all' : names.split(',').map((n) => normTable(n.trim())),
    });
  }
  return events;
}

/** The table a write queues a deferred event on for one source, if any. */
function queuedOn(source: Source, write: WriteEvent): string | undefined {
  if (source.kind === 'trigger') return write.table === source.table ? source.table : undefined;
  if (write.table === source.child) {
    if (write.verb === 'insert') return source.child;
    if (write.verb === 'update') {
      const setsKey = source.cols.some((c) =>
        new RegExp(String.raw`(?:^|[\s,(])"?${c}"?\s*(?:\)\s*)?=(?!=)`, 'i').test(write.setClause),
      );
      if (setsKey) return source.child;
    }
  }
  if (write.verb === 'delete' && write.table === source.parent && source.parentDelete) return source.parent;
  return undefined;
}

function fileEvents(sql: string): Event[] {
  const clean = stripFunctionBodies(stripComments(sql));
  const events = extractEvents(clean);
  for (const exp of expandExecuteFormats(clean)) {
    // Expanded statements run where their EXECUTE sits, in their own order.
    events.push(...extractEvents(exp.sql).map((e) => ({ ...e, at: exp.at + e.at / 1e7 })));
  }
  return events.sort((a, b) => a.at - b.at);
}

type Registry = Map<string, Source>;

function scanFile(registry: Registry, file: { name: string; sql: string }, violations: string[]): void {
  const pending = new Map<string, Set<string>>(); // table -> keys of the sources that queued on it
  const flagged = new Set<string>();
  const unregister = (match: (s: Source) => boolean) => {
    for (const [k, s] of registry) if (match(s)) registry.delete(k);
  };
  for (const e of fileEvents(file.sql)) {
    switch (e.type) {
      case 'source':
        if (e.deferred) registry.set(e.source.key, e.source);
        else registry.delete(e.source.key);
        break;
      case 'dropTrigger':
        registry.delete(`trigger:${e.table}:${e.name}`);
        break;
      case 'dropConstraint':
        unregister((s) => s.name === e.name);
        break;
      case 'alterConstraint':
        if (!e.deferred) unregister((s) => s.name === e.name);
        break;
      case 'dropTable':
        unregister((s) => (s.kind === 'trigger' ? [s.table] : [s.child, s.parent]).some((t) => e.tables.includes(t)));
        break;
      case 'write':
        for (const s of registry.values()) {
          const table = queuedOn(s, e);
          if (!table) continue;
          if (!pending.has(table)) pending.set(table, new Set());
          pending.get(table)!.add(s.key);
        }
        break;
      case 'flush':
        if (e.names === 'all') pending.clear();
        else {
          const names = e.names;
          for (const keys of pending.values()) for (const k of [...keys]) if (names.some((n) => k.endsWith(`:${n}`))) keys.delete(k);
        }
        break;
      case 'ddl':
        if (pending.get(e.table)?.size && !flagged.has(e.table)) {
          flagged.add(e.table);
          violations.push(`${file.name}: ${e.table}`);
        }
        break;
    }
  }
}

function findPendingTriggerAlters(files: { name: string; sql: string }[]): string[] {
  const registry: Registry = new Map();
  const violations: string[] = [];
  for (const file of files) scanFile(registry, file, violations);
  return violations;
}

/** The deferred event sources still live after every file has run. */
function deferredSources(files: { name: string; sql: string }[]): Source[] {
  const registry: Registry = new Map();
  for (const file of files) scanFile(registry, file, []);
  return [...registry.values()];
}

function loadMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/**
 * Shipped migrations the widened guard (#8397) flags. Shipped files are
 * immutable, so each is listed here instead of being edited. Never add a new
 * file: fire the events in the new migration instead.
 *
 * 2026-09-22-ai-alert-verdicts-live-unique.sql: the DO-block UPDATEs set
 * superseded_by (a deferred self-FK) and the file then runs CREATE UNIQUE
 * INDEX on ai_alert_verdicts. Reproduced on Postgres 16: on a database with
 * duplicate live verdicts it fails with `cannot CREATE INDEX
 * "ai_alert_verdicts" because it has pending trigger events`.
 */
const KNOWN_SHIPPED_VIOLATIONS = ['2026-09-22-ai-alert-verdicts-live-unique.sql: ai_alert_verdicts'];

describe('migrations that queue deferred trigger events and then run DDL on the table', () => {
  it('fire the pending trigger events before the DDL', () => {
    // Exact match, so a listed file that stops being flagged fails too.
    expect(findPendingTriggerAlters(loadMigrations())).toEqual(KNOWN_SHIPPED_VIOLATIONS);
  });

  it('detects the v0.122.0 shape and accepts the fix', () => {
    const trigger = {
      name: '0001-trigger.sql',
      sql: `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON public.links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();`,
    };
    const broken = {
      name: '0002-broken.sql',
      sql: `DO $$ BEGIN UPDATE links SET x = 1; END $$;\nALTER TABLE links ADD CONSTRAINT c CHECK (true);`,
    };
    const fixed = {
      name: '0002-fixed.sql',
      sql: `DO $$ BEGIN UPDATE links SET x = 1; END $$;\nSET CONSTRAINTS ALL IMMEDIATE;\nALTER TABLE links ADD CONSTRAINT c CHECK (true);`,
    };
    const beforeTrigger = { name: '0000-early.sql', sql: broken.sql };
    expect(findPendingTriggerAlters([trigger, broken])).toEqual(['0002-broken.sql: links']);
    expect(findPendingTriggerAlters([trigger, fixed])).toEqual([]);
    expect(findPendingTriggerAlters([beforeTrigger, trigger])).toEqual([]);
  });
});

const run = (...sqls: string[]): string[] =>
  findPendingTriggerAlters(sqls.map((sql, i) => ({ name: `${String(i).padStart(4, '0')}.sql`, sql })));

const TRIGGER = `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON public.links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();`;
const KIDS = `CREATE TABLE parents (id uuid PRIMARY KEY);
CREATE TABLE kids (
  id uuid PRIMARY KEY,
  parent_id uuid NOT NULL,
  name text,
  CONSTRAINT kids_parent_fk FOREIGN KEY (parent_id) REFERENCES parents (id)
    DEFERRABLE
    INITIALLY DEFERRED
);`;
const INSERT_KIDS = `INSERT INTO kids (id, parent_id) SELECT gen_random_uuid(), id FROM parents;`;
const ALTER_KIDS = `ALTER TABLE kids ADD COLUMN x int;`;

describe('deferred foreign keys', () => {
  it('flags an INSERT into the child followed by DDL on the child', () => {
    expect(run(KIDS, `${INSERT_KIDS}\n${ALTER_KIDS}`)).toEqual(['0001.sql: kids']);
  });

  it('accepts the INSERT when the events are fired first (ALL or by name)', () => {
    expect(run(KIDS, `${INSERT_KIDS}\nSET CONSTRAINTS ALL IMMEDIATE;\n${ALTER_KIDS}`)).toEqual([]);
    expect(run(KIDS, `${INSERT_KIDS}\nSET CONSTRAINTS kids_parent_fk IMMEDIATE;\n${ALTER_KIDS}`)).toEqual([]);
  });

  it('ignores a DEFERRABLE (initially immediate) FK', () => {
    const immediate = KIDS.replace(/\s+INITIALLY DEFERRED/, '');
    expect(run(immediate, `${INSERT_KIDS}\n${ALTER_KIDS}`)).toEqual([]);
  });

  it('flags the FK declared inline on a column, and in the same file', () => {
    const inline = `CREATE TABLE kids2 (
  id uuid PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO kids2 (id, parent_id) SELECT gen_random_uuid(), id FROM parents;
CREATE INDEX kids2_parent_idx ON kids2 (parent_id);`;
    expect(run(inline)).toEqual(['0000.sql: kids2']);
  });

  it('flags the FK added by ALTER TABLE ... ADD CONSTRAINT', () => {
    const added = `ALTER TABLE public.kids3 ADD CONSTRAINT kids3_parent_fk
  FOREIGN KEY (parent_id) REFERENCES public.parents(id) DEFERRABLE INITIALLY DEFERRED;`;
    expect(run(added, `INSERT INTO kids3 SELECT * FROM x;\nALTER TABLE kids3 ADD COLUMN y int;`)).toEqual([
      '0001.sql: kids3',
    ]);
  });

  it('flags an UPDATE that changes the FK column, not one that leaves it alone', () => {
    expect(run(KIDS, `UPDATE kids SET parent_id = gen_random_uuid() WHERE name = 'x';\n${ALTER_KIDS}`)).toEqual([
      '0001.sql: kids',
    ]);
    expect(run(KIDS, `UPDATE kids SET name = 'x' WHERE parent_id IS NOT NULL;\n${ALTER_KIDS}`)).toEqual([]);
  });

  it('flags a DELETE on the parent when the FK has no ON DELETE action', () => {
    const del = `DELETE FROM parents WHERE id IS NULL;\nALTER TABLE parents ADD COLUMN y int;`;
    expect(run(KIDS, del)).toEqual(['0001.sql: parents']);
    expect(run(KIDS.replace('REFERENCES parents (id)', 'REFERENCES parents (id) ON DELETE CASCADE'), del)).toEqual([]);
  });

  it('ignores writes that queue no FK event (INSERT on parent, DELETE on child)', () => {
    expect(run(KIDS, `INSERT INTO parents SELECT gen_random_uuid();\nALTER TABLE parents ADD COLUMN y int;`)).toEqual([]);
    expect(run(KIDS, `DELETE FROM kids;\n${ALTER_KIDS}`)).toEqual([]);
  });

  it('stops tracking an FK made NOT DEFERRABLE or dropped', () => {
    expect(run(KIDS, `ALTER TABLE kids ALTER CONSTRAINT kids_parent_fk NOT DEFERRABLE;`, `${INSERT_KIDS}\n${ALTER_KIDS}`)).toEqual([]);
    expect(run(KIDS, `ALTER TABLE kids DROP CONSTRAINT IF EXISTS kids_parent_fk;`, `${INSERT_KIDS}\n${ALTER_KIDS}`)).toEqual([]);
  });

  it('resolves FKs created by EXECUTE format over a VALUES loop', () => {
    const loop = (action: string) => `DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('kids4', 'kids4_parent_fk', 'parent_id', 'parents', '${action}')
  ) AS ownership(child_table, constraint_name, child_key, parent_table, delete_action)
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I, org_id) REFERENCES public.%I(id, org_id) ON UPDATE CASCADE ON DELETE %s DEFERRABLE INITIALLY DEFERRED NOT VALID',
      item.child_table, item.constraint_name, item.child_key, item.parent_table, item.delete_action
    );
  END LOOP;
END $$;`;
    const del = `DELETE FROM parents WHERE id IS NULL;\nALTER TABLE parents ADD COLUMN y int;`;
    expect(run(loop('NO ACTION'), del)).toEqual(['0001.sql: parents']);
    expect(run(loop('CASCADE'), del)).toEqual([]);
    expect(run(loop('CASCADE'), `INSERT INTO kids4 SELECT * FROM x;\nALTER TABLE kids4 ADD COLUMN y int;`)).toEqual([
      '0001.sql: kids4',
    ]);
  });
});

describe('DDL forms that fail on pending trigger events', () => {
  it('flags CREATE [UNIQUE] INDEX on the written table, not on another table', () => {
    expect(run(KIDS, `${INSERT_KIDS}\nCREATE UNIQUE INDEX IF NOT EXISTS kids_name_uq ON public.kids (name);`)).toEqual([
      '0001.sql: kids',
    ]);
    expect(run(KIDS, `${INSERT_KIDS}\nCREATE INDEX ON parents (id);`)).toEqual([]);
  });

  it('flags TRUNCATE of the written table', () => {
    expect(run(KIDS, `${INSERT_KIDS}\nTRUNCATE TABLE kids;`)).toEqual(['0001.sql: kids']);
    expect(run(TRIGGER, `UPDATE links SET x = 1;\nTRUNCATE links, other;`)).toEqual(['0001.sql: links']);
  });
});

describe('identifier and statement shapes', () => {
  it('matches quoted and schema-qualified identifiers', () => {
    expect(run(TRIGGER, `UPDATE public."links" SET x = 1;\nALTER TABLE "links" ADD COLUMN y int;`)).toEqual([
      '0001.sql: links',
    ]);
  });

  it('does not confuse a table with one whose name it prefixes', () => {
    expect(run(TRIGGER, `UPDATE links_archive SET x = 1;\nALTER TABLE links ADD COLUMN y int;`)).toEqual([]);
    expect(run(TRIGGER, `UPDATE links SET x = 1;\nALTER TABLE links_archive ADD COLUMN y int;`)).toEqual([]);
  });

  it('resolves writes inside EXECUTE format(...) with literal or VALUES-loop arguments', () => {
    const alter = `ALTER TABLE links ADD COLUMN y int;`;
    expect(run(TRIGGER, `DO $$ BEGIN EXECUTE format('UPDATE public.%I SET x = 1', 'links'); END $$;\n${alter}`)).toEqual([
      '0001.sql: links',
    ]);
    expect(run(TRIGGER, `DO $$ BEGIN EXECUTE format('UPDATE public.%I SET x = 1', 'other'); END $$;\n${alter}`)).toEqual([]);
    const loop = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('other'), ('links')) AS v(tbl) LOOP
    EXECUTE format('UPDATE public.%I SET x = 1', r.tbl);
  END LOOP;
END $$;`;
    expect(run(TRIGGER, `${loop}\n${alter}`)).toEqual(['0001.sql: links']);
  });

  it('ignores writes inside a function body (defined, not executed)', () => {
    const fn = `CREATE OR REPLACE FUNCTION g() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE links SET x = 1;
  RETURN NEW;
END $fn$;
ALTER TABLE links ADD COLUMN y int;`;
    expect(run(TRIGGER, fn)).toEqual([]);
  });

  it('ignores writes inside block comments', () => {
    expect(run(TRIGGER, `/* UPDATE links SET x = 1; */\nALTER TABLE links ADD COLUMN y int;`)).toEqual([]);
  });

  it('flags a write that comes after SET CONSTRAINTS ALL IMMEDIATE', () => {
    expect(
      run(TRIGGER, `UPDATE links SET x = 1;\nSET CONSTRAINTS ALL IMMEDIATE;\nUPDATE links SET x = 2;\nALTER TABLE links ADD COLUMN y int;`),
    ).toEqual(['0001.sql: links']);
  });
});

describe('constraint trigger lifetime', () => {
  const recreate = `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();`;

  it('flags a write made before the trigger is dropped and re-created in the same file', () => {
    expect(
      run(TRIGGER, `UPDATE links SET x = 1;\nDROP TRIGGER t ON links;\n${recreate}\nALTER TABLE links ADD COLUMN y int;`),
    ).toEqual(['0001.sql: links']);
  });

  it('accepts a write made while the trigger is dropped', () => {
    expect(
      run(TRIGGER, `DROP TRIGGER IF EXISTS t ON links;\nUPDATE links SET x = 1;\nALTER TABLE links ADD COLUMN y int;\n${recreate}`),
    ).toEqual([]);
    expect(run(TRIGGER, `DROP TRIGGER IF EXISTS t ON public.links;`, `UPDATE links SET x = 1;\nALTER TABLE links ADD COLUMN y int;`)).toEqual([]);
  });
});

// Guards the guard: if parsing silently found no sources, the all-migrations
// assertion above would pass vacuously.
describe('deferred event sources found in the real migrations', () => {
  const sources = deferredSources(loadMigrations());
  const fk = (child: string, parent: string) =>
    sources.find((s) => s.kind === 'fk' && s.child === child && s.parent === parent);

  it('include FKs from CREATE TABLE, ALTER TABLE ADD CONSTRAINT and the VALUES-loop EXECUTE', () => {
    expect(fk('device_group_memberships', 'devices')).toMatchObject({ parentDelete: true });
    expect(fk('device_group_memberships', 'device_groups')).toMatchObject({ parentDelete: true });
    expect(fk('users', 'organizations')).toMatchObject({ cols: ['org_id', 'partner_id'], parentDelete: true });
    expect(fk('agent_rollback_directives', 'devices')).toMatchObject({ parentDelete: false });
    expect(fk('device_hardware', 'devices')).toMatchObject({ parentDelete: true });
    expect(fk('device_warranty', 'devices')).toMatchObject({ parentDelete: false });
  });

  it('include deferred constraint triggers', () => {
    expect(sources).toContainEqual(expect.objectContaining({ kind: 'trigger', table: 'audit_logs' }));
  });

  it('drop an FK later made NOT DEFERRABLE', () => {
    expect(fk('devices', 'sites')).toBeUndefined();
  });
});

