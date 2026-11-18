/**
 * #8972 W0 (spec §3.5): every writer of a ticket child row locks the ticket
 * row FIRST. This contract keeps the writer registry
 * (./ticketChildWriters.ts) complete and checks the CALL ORDER of every
 * `ticket-first` writer. It cannot prove that two transactions lock in a
 * compatible order — the concurrency suite
 * src/__tests__/integration/ticketChildLockOrder.integration.test.ts does that.
 *
 * Scope (quorum P9): EVERY enclosing function in apps/api/src/**\/*.ts
 * (non-test), exported or not, route handlers included. A write is a Drizzle
 * `.insert|update|delete(<childTable>)` or a raw SQL `INSERT INTO | UPDATE |
 * DELETE FROM <child_table>` (also through `sql.identifier('<child_table>')`).
 * Comments are blanked first, so prose that names a table is not a write.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  TICKET_CHILD_TABLES,
  TICKET_CHILD_WRITERS,
  TICKET_GUARDING_LOCK_WRAPPERS,
  TICKET_LOCK_HELD_FUNCTIONS,
  TICKET_LOCK_PRIMITIVES,
  TICKET_LOCK_WRAPPERS,
  TICKET_ROW_GUARDED_WRITERS,
  TICKET_TOMBSTONE_GUARDS,
  type TicketChildTable,
} from './ticketChildWriters';

const SRC = path.resolve(__dirname, '..');

const DRIZZLE_TABLE_VARS: Record<string, TicketChildTable> = {
  ticketComments: 'ticket_comments',
  ticketAttachments: 'ticket_attachments',
  timeEntries: 'time_entries',
  ticketParts: 'ticket_parts',
  ticketChecklistItems: 'ticket_checklist_items',
  ticketAlertLinks: 'ticket_alert_links',
  ticketEmailLinks: 'ticket_email_links',
  ticketExternalRefs: 'ticket_external_refs',
  ticketLinks: 'ticket_links',
  ticketDrafts: 'ticket_drafts',
};

const TABLE_ALT = TICKET_CHILD_TABLES.join('|');
const WRITE_PATTERNS: Array<{ re: RegExp; table: (m: RegExpExecArray) => TicketChildTable }> = [
  {
    re: new RegExp(`\\.(?:insert|update|delete)\\(\\s*(${Object.keys(DRIZZLE_TABLE_VARS).join('|')})\\s*\\)`, 'g'),
    table: (m) => DRIZZLE_TABLE_VARS[m[1]!]!,
  },
  {
    re: new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?"?(${TABLE_ALT})"?\\b`, 'gi'),
    table: (m) => m[1]!.toLowerCase() as TicketChildTable,
  },
  {
    re: new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+\\$\\{\\s*sql\\.identifier\\(\\s*['"](${TABLE_ALT})['"]\\s*\\)\\s*\\}`, 'gi'),
    table: (m) => m[1]!.toLowerCase() as TicketChildTable,
  },
];

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

interface FnInfo {
  key: string;
  node: ts.Node;
  /** Body text with comments blanked (offsets relative to `start`). */
  text: string;
  start: number;
}

interface WriteHit {
  key: string;
  table: TicketChildTable;
  /** Offset of the write inside its enclosing named function's text. */
  offset: number;
  fn: FnInfo;
  line: number;
}

interface ScannedFile {
  rel: string;
  sf: ts.SourceFile;
  text: string;
  /** Every named function-like in the file, by key. A key may repeat (two nested helpers with one name). */
  functions: Map<string, FnInfo[]>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Blank every comment (keeping offsets and newlines) using the parser, so template literals are never touched. */
function blankComments(text: string, sf: ts.SourceFile): string {
  const out = text.split('');
  const seen = new Set<number>();
  const blank = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      for (let i = r.pos; i < r.end; i++) if (out[i] !== '\n') out[i] = ' ';
    }
  };
  const visit = (n: ts.Node) => {
    blank(ts.getLeadingCommentRanges(text, n.pos));
    blank(ts.getTrailingCommentRanges(text, n.end));
    for (const child of n.getChildren(sf)) visit(child);
  };
  visit(sf);
  return out.join('');
}

/** The registry name of a function-like node, or null for an anonymous callback. */
function functionName(n: ts.Node, sf: ts.SourceFile): string | null {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText(sf);
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
    if (ts.isFunctionExpression(n) && n.name) return n.name.text;
    // A route handler: `xRoutes.post('/path', ..., async (c) => { ... })`.
    if (p && ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
      const method = p.expression.name.text;
      const first = p.arguments[0];
      if (ROUTE_METHODS.has(method) && first && ts.isStringLiteralLike(first)) {
        return `${method.toUpperCase()} ${first.text}`;
      }
    }
  }
  return null;
}

function scanFile(full: string, raw = readFileSync(full, 'utf8')): ScannedFile {
  const sf = ts.createSourceFile(full, raw, ts.ScriptTarget.Latest, true);
  const text = blankComments(raw, sf);
  const rel = path.relative(SRC, full).split(path.sep).join('/');
  const functions = new Map<string, FnInfo[]>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) {
      const name = functionName(n, sf);
      if (name) {
        const key = `${rel}::${name}`;
        const start = n.getStart(sf);
        const info: FnInfo = { key, node: n, text: text.slice(start, n.getEnd()), start };
        functions.set(key, [...(functions.get(key) ?? []), info]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { rel, sf, text, functions };
}

/** The innermost NAMED function enclosing `pos`. */
function enclosingFunction(file: ScannedFile, pos: number): FnInfo | null {
  let best: FnInfo | null = null;
  for (const infos of file.functions.values()) {
    for (const info of infos) {
      const end = info.start + info.text.length;
      if (pos >= info.start && pos < end && (!best || info.start >= best.start)) best = info;
    }
  }
  return best;
}

function findWrites(file: ScannedFile): Array<WriteHit | { orphan: string }> {
  const out: Array<WriteHit | { orphan: string }> = [];
  for (const { re, table } of WRITE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.text))) {
      const line = file.sf.getLineAndCharacterOfPosition(m.index).line + 1;
      const fn = enclosingFunction(file, m.index);
      if (!fn) {
        out.push({ orphan: `${file.rel}:${line} writes ${table(m)} outside any named function` });
        continue;
      }
      out.push({ key: fn.key, table: table(m), offset: m.index - fn.start, fn, line });
    }
  }
  return out;
}

function callIndex(body: string, names: readonly string[], before = Infinity): number {
  let first = -1;
  for (const name of names) {
    const re = new RegExp(`(?<![\\w.$])${name}\\s*\\(|\\.${name}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      if (m.index >= before) break;
      if (first === -1 || m.index < first) first = m.index;
      break;
    }
  }
  return first;
}

const bareName = (key: string) => key.split('::')[1]!;

/** Every call offset of any of `names` in `body`, ascending. */
function callIndexes(body: string, names: readonly string[]): number[] {
  const out: number[] = [];
  for (const name of names) {
    const re = new RegExp(`(?<![\\w.$])${name}\\s*\\(|\\.${name}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) out.push(m.index);
  }
  return out.sort((a, b) => a - b);
}

/**
 * #8972 W1: is the tombstone guard checked in `body` before offset `before`?
 * Either a guarding lock wrapper is called first, or a guard
 * (`assertTicketNotMerged` / `isMergedTombstone`) runs on a lock taken first:
 * after a lock call, or wrapping one (`assertTicketNotMerged(await lockTicketForWrite(…))`).
 */
function guardedBefore(body: string, before: number, lockNames: readonly string[]): boolean {
  const guardingWrappers = Object.keys(TICKET_GUARDING_LOCK_WRAPPERS).map(bareName);
  if (callIndexes(body, guardingWrappers).some((i) => i < before)) return true;
  const locks = callIndexes(body, lockNames);
  const wraps = new RegExp(`^\\.?(?:${TICKET_TOMBSTONE_GUARDS.join('|')})\\s*\\(\\s*(?:await\\s+)?\\(?\\s*(?:await\\s+)?(?:${lockNames.join('|')})\\s*\\(`);
  return callIndexes(body, TICKET_TOMBSTONE_GUARDS).some((g) => g < before
    && (locks.some((l) => l <= g) || wraps.test(body.slice(g))));
}

describe('ticket-child writer registry (#8972 W0, spec §3.5)', () => {
  let files: ScannedFile[] = [];
  let writes: WriteHit[] = [];
  let orphans: string[] = [];
  /** Every non-test source file's text, read ONCE (the host may be loaded). */
  const rawByRel = new Map<string, string>();
  const parsed = new Map<string, ScannedFile>();
  const scanned = (rel: string): ScannedFile => {
    let file = parsed.get(rel);
    if (!file) {
      file = scanFile(path.join(SRC, rel), rawByRel.get(rel));
      parsed.set(rel, file);
    }
    return file;
  };
  const relOfKey = (key: string) => key.split('::')[0]!;
  const lockNames = () => [...TICKET_LOCK_PRIMITIVES, ...Object.keys(TICKET_LOCK_WRAPPERS).map(bareName)];

  // One read + parse of apps/api/src shared by every assertion.
  beforeAll(() => {
    for (const full of walk(SRC)) rawByRel.set(path.relative(SRC, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
    const registryFiles = new Set(Object.keys(TICKET_CHILD_WRITERS).map(relOfKey));
    files = [...rawByRel.entries()].filter(([rel, raw]) =>
      // Cheap pre-filter: only parse files that can hold a write or a registry key.
      TICKET_CHILD_TABLES.some((t) => raw.includes(t))
        || Object.keys(DRIZZLE_TABLE_VARS).some((v) => raw.includes(v))
        || registryFiles.has(rel),
    ).map(([rel]) => scanned(rel));
    for (const file of files) {
      for (const hit of findWrites(file)) {
        if ('orphan' in hit) orphans.push(hit.orphan);
        else writes.push(hit);
      }
    }
  }, 180_000);

  it('finds the writers it is meant to find (scanner self-check)', () => {
    const keys = new Set(writes.map((w) => w.key));
    expect(keys).toContain('services/ticketService.ts::editTicketComment');
    expect(keys).toContain('routes/portal/tickets.ts::POST /tickets/:id/comments');
    expect(keys).toContain('services/inboundEmail/emailComments.ts::insertEmailAuthoredComment');
    expect(orphans).toEqual([]);
  });

  it('every ticket-child writer is registered', () => {
    const missing = [...new Set(writes.map((w) => w.key))].filter((k) => !(k in TICKET_CHILD_WRITERS)).sort();
    expect(missing, 'classify each in services/ticketChildWriters.ts').toEqual([]);
  });

  it('every registered writer names every table it writes', () => {
    const gaps: string[] = [];
    for (const w of writes) {
      const entry = TICKET_CHILD_WRITERS[w.key];
      if (entry && !entry.tables.includes(w.table)) gaps.push(`${w.key} writes ${w.table} (line ${w.line})`);
    }
    expect([...new Set(gaps)].sort()).toEqual([]);
  });

  it('no registered writer is stale', () => {
    const found = new Set(writes.map((w) => w.key));
    const stale: string[] = [];
    for (const [key, entry] of Object.entries(TICKET_CHILD_WRITERS)) {
      if (!rawByRel.has(relOfKey(key)) || !scanned(relOfKey(key)).functions.has(key)) { stale.push(`${key}: function not found`); continue; }
      // A writer that addresses its tables dynamically (a table-list walk) is
      // invisible to the literal scan; its function must still exist.
      if (!entry.dynamicTables && !found.has(key)) stale.push(`${key}: no ticket-child write found`);
    }
    expect(stale).toEqual([]);
  });

  it('every non-ticket-first writer states why', () => {
    const bad = Object.entries(TICKET_CHILD_WRITERS)
      .filter(([, e]) => e.lock !== 'ticket-first' && e.lock !== 'pre-ticket-child' && !(e.reason && e.reason.trim().length > 20))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('every lock-held function exists', () => {
    const missing = Object.keys(TICKET_LOCK_HELD_FUNCTIONS).filter((key) => {
      return !rawByRel.has(relOfKey(key)) || !scanned(relOfKey(key)).functions.has(key);
    });
    expect(missing).toEqual([]);
  });

  it('every lock wrapper reaches a lock primitive', () => {
    const problems: string[] = [];
    const reaches = (key: string, seen: Set<string>): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      const infos = rawByRel.has(relOfKey(key)) ? scanned(relOfKey(key)).functions.get(key) : undefined;
      if (!infos) { problems.push(`${key}: wrapper not found`); return false; }
      return infos.every((info) => callIndex(info.text, TICKET_LOCK_PRIMITIVES) >= 0
        || Object.keys(TICKET_LOCK_WRAPPERS).some((w) => w !== key && callIndex(info.text, [bareName(w)]) >= 0 && reaches(w, new Set(seen))));
    };
    for (const key of Object.keys(TICKET_LOCK_WRAPPERS)) {
      if (!reaches(key, new Set())) problems.push(`${key}: does not call a ticket lock primitive`);
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('ticket-first writers call lockTicketForWrite before the child write', () => {
    const violators = new Set<string>();
    for (const w of writes) {
      const entry = TICKET_CHILD_WRITERS[w.key];
      if (!entry || entry.lock !== 'ticket-first' || entry.lockHeldByCaller) continue;
      if (callIndex(w.fn.text, lockNames(), w.offset) === -1) violators.add(w.key);
    }
    expect([...violators].sort()).toEqual([]);
  });

  it('lock-held helpers are only called after the caller took the ticket lock', () => {
    const problems: string[] = [];
    // Writers that rely on their caller's lock, plus the non-writing functions
    // between them and the lock (TICKET_LOCK_HELD_FUNCTIONS). Each one's call
    // sites must take the lock first or be another member of this set, which
    // is then checked at ITS call sites in turn.
    const held = new Set([
      ...Object.entries(TICKET_CHILD_WRITERS).filter(([, e]) => e.lock === 'ticket-first' && e.lockHeldByCaller).map(([k]) => k),
      ...Object.keys(TICKET_LOCK_HELD_FUNCTIONS),
    ]);
    for (const key of held) {
      const name = bareName(key);
      const homeRel = key.split('::')[0]!;
      const moduleBase = path.basename(homeRel, '.ts');
      // A call site is in the helper's own file, or in a file that imports it
      // by name from that module (a common local name like `attempt` in an
      // unrelated file is not a call of this helper).
      const importRe = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*\\b${moduleBase}(?:\\.js)?['"]`);
      const callRe = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
      let calls = 0;
      for (const [rel, raw] of rawByRel) {
        if (!raw.includes(name)) continue;
        if (rel !== homeRel && !importRe.test(raw)) continue;
        const file = scanned(rel);
        callRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(file.text))) {
          const fn = enclosingFunction(file, m.index);
          if (fn?.key === key) continue; // the definition itself / recursion
          // `function name(` and `const name = ` are definitions, not calls.
          const before = file.text.slice(Math.max(0, m.index - 20), m.index);
          if (/(function\s*\*?\s*|async\s+)$/.test(before) && fn && fn.key.endsWith(`::${name}`)) continue;
          calls++;
          if (!fn) { problems.push(`${key}: called outside a named function in ${file.rel}`); continue; }
          if (held.has(fn.key)) continue; // verified at its own call sites
          if (callIndex(fn.text, lockNames(), m.index - fn.start) === -1) {
            problems.push(`${key}: ${fn.key} calls it without taking the ticket lock first`);
          }
        }
      }
      if (calls === 0) problems.push(`${key}: lock-held helper but never called`);
    }
    expect(problems.sort()).toEqual([]);
  }, 60_000);

  // ── #8972 W1 Task 1.2: tombstones are read-only (spec §3.2, Gate B10) ──

  it('every ticket-first / pre-ticket-child writer guards tombstones or states why not', () => {
    const bad: string[] = [];
    for (const [key, e] of Object.entries(TICKET_CHILD_WRITERS)) {
      const lockFirst = e.lock === 'ticket-first' || e.lock === 'pre-ticket-child';
      const exempt = !!(e.tombstoneExempt && e.tombstoneExempt.trim().length > 20);
      if (lockFirst && e.tombstoneGuard === exempt) bad.push(`${key}: tombstoneGuard XOR tombstoneExempt`);
      if (!lockFirst && (e.tombstoneGuard || e.tombstoneExempt)) bad.push(`${key}: ${e.lock} writers are handled by the movers (T1.9), not the guard`);
      if (e.guardHeldByCaller && !e.tombstoneGuard) bad.push(`${key}: guardHeldByCaller without tombstoneGuard`);
    }
    expect(bad.sort()).toEqual([]);
  });

  it('every guarding lock wrapper is a lock wrapper and checks the guard after its lock', () => {
    const problems: string[] = [];
    for (const key of Object.keys(TICKET_GUARDING_LOCK_WRAPPERS)) {
      if (!(key in TICKET_LOCK_WRAPPERS)) { problems.push(`${key}: not in TICKET_LOCK_WRAPPERS`); continue; }
      const infos = rawByRel.has(relOfKey(key)) ? scanned(relOfKey(key)).functions.get(key) : undefined;
      if (!infos) { problems.push(`${key}: wrapper not found`); continue; }
      // Its own name is not a lock call inside its own body.
      const locks = lockNames().filter((n) => n !== bareName(key));
      for (const info of infos) {
        // A wrapper that delegates to ANOTHER guarding wrapper is guarded too.
        const others = Object.keys(TICKET_GUARDING_LOCK_WRAPPERS).filter((k) => k !== key).map(bareName);
        if (callIndexes(info.text, others).length > 0) continue;
        if (!guardedBefore(info.text, Infinity, locks)) problems.push(`${key}: no guard after its lock`);
      }
    }
    expect(problems.sort()).toEqual([]);
  });

  it('guarded writers check assertTicketNotMerged after lockTicketForWrite, before the child write', () => {
    const violators = new Set<string>();
    for (const w of writes) {
      const entry = TICKET_CHILD_WRITERS[w.key];
      if (!entry || !entry.tombstoneGuard || entry.lockHeldByCaller || entry.guardHeldByCaller) continue;
      if (!guardedBefore(w.fn.text, w.offset, lockNames())) violators.add(`${w.key} (line ${w.line})`);
    }
    expect([...violators].sort()).toEqual([]);
  });

  it('caller-guarded writers are only called after their caller checked the guard', () => {
    const problems: string[] = [];
    const targets = Object.entries(TICKET_CHILD_WRITERS)
      .filter(([, e]) => e.tombstoneGuard && (e.lockHeldByCaller || e.guardHeldByCaller)).map(([k]) => k);
    // A call from inside another caller-guarded writer or a lock-held function
    // is checked at THAT function's call sites in turn.
    const transparent = new Set([...targets, ...Object.keys(TICKET_LOCK_HELD_FUNCTIONS)]);
    const exempt = new Set(Object.entries(TICKET_CHILD_WRITERS).filter(([, e]) => e.tombstoneExempt).map(([k]) => k));
    const queue = [...targets];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const name = bareName(key);
      const homeRel = relOfKey(key);
      const moduleBase = path.basename(homeRel, '.ts');
      const importRe = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*\\b${moduleBase}(?:\\.js)?['"]`);
      const callRe = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
      for (const [rel, raw] of rawByRel) {
        if (!raw.includes(name)) continue;
        if (rel !== homeRel && !importRe.test(raw)) continue;
        const file = scanned(rel);
        callRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(file.text))) {
          const fn = enclosingFunction(file, m.index);
          if (fn?.key === key) continue;
          const before = file.text.slice(Math.max(0, m.index - 20), m.index);
          if (/(function\s*\*?\s*|async\s+)$/.test(before) && fn && fn.key.endsWith(`::${name}`)) continue;
          if (!fn) { problems.push(`${key}: called outside a named function in ${file.rel}`); continue; }
          // A caller that is itself exempt (the billing stampers) answers for
          // its own path; its exemption reason is checked above.
          if (exempt.has(fn.key)) continue;
          if (transparent.has(fn.key)) { queue.push(fn.key); continue; }
          if (!guardedBefore(fn.text, m.index - fn.start, lockNames())) {
            problems.push(`${key}: ${fn.key} calls it without checking the tombstone guard first`);
          }
        }
      }
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  }, 60_000);

  it('ticket-row writers outside the child registry check the guard under their lock', () => {
    const problems: string[] = [];
    for (const key of Object.keys(TICKET_ROW_GUARDED_WRITERS)) {
      const infos = rawByRel.has(relOfKey(key)) ? scanned(relOfKey(key)).functions.get(key) : undefined;
      if (!infos) { problems.push(`${key}: function not found`); continue; }
      for (const info of infos) {
        if (!guardedBefore(info.text, Infinity, lockNames())) problems.push(`${key}: no tombstone guard after its ticket lock`);
      }
    }
    expect(problems.sort()).toEqual([]);
  });
});
