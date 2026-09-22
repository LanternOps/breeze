/**
 * Recipe Library spec §6.5, the sentence this whole wave hangs on:
 *
 *   "`patchChecklistItem` stays human-only: the Operator creates items and
 *    never completes them."
 *
 * A checklist tick is a human attestation on a compliance artifact. The route
 * already refuses a non-interactive session for the `done` branch
 * (routes/tickets/checklist.ts) — but that gate protects the HTTP path, and
 * this wave gives the Operator direct, in-process database access to the very
 * table that gate protects. Nothing in a diff review reliably catches a
 * `doneAt:` added to a service file six months from now (CLAUDE.md's
 * registration-list history: review 0/5, contract tests 5/5).
 *
 * So the rule is mechanical: NO file under `services/aiOperator/` may name
 * `doneAt`, `done_at`, `doneByUserId` or `done_by_user_id` on the left of an
 * assignment or inside a `.set({...})` / `.values({...})`. Reading the columns
 * is fine and necessary — `advanceHumanWork` settles on exactly that evidence.
 *
 * The extractor throws when it finds no files, so a directory move cannot make
 * this suite vacuously green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OPERATOR_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Every `.ts` under a directory, recursively, excluding test files. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out = walk(dir);
  if (out.length === 0) throw new Error(`humanWorkPurity: no source files under ${dir}`);
  return out;
}

/**
 * A WRITE of one of the completion columns. Matches an object-literal property
 * assignment (`doneAt: x`, `done_at: x`), a bare assignment (`row.doneAt = x`)
 * and a SQL assignment (`done_at = now()`). Deliberately does NOT match a read
 * (`row.doneAt`, `eq(items.doneAt, …)`, `isNull(items.doneAt)`), a type
 * annotation (`doneAt: Date | null`), an equality test (`done_at == x`) or a
 * SQL predicate (`done_at IS NULL`), which are what the coordinator
 * legitimately does.
 *
 * Built fresh per use (see `completionWrites`) so the `g` flag's `lastIndex`
 * can never make a stateful regex skip every other file — a silently vacuous
 * guard is exactly what this suite exists to prevent.
 */
const COMPLETION_WRITE_SOURCE =
  String.raw`\b(doneAt|done_at|doneByUserId|done_by_user_id)\s*(:(?!\s*(string|Date|number|boolean|null|\|))|=(?!=))`;

/**
 * Comments cannot write a column, and prose like "no doneByUserId: the sweep…"
 * reads as an assignment to the regex. Block comments are blanked (newlines
 * kept, so line numbers stay true); a `//` comment is stripped only when it
 * is preceded by whitespace or starts the line, so a `://` inside a string
 * literal on a line that ALSO carries a write cannot hide that write.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function completionWrites(source: string): Array<{ line: number; text: string }> {
  const re = new RegExp(COMPLETION_WRITE_SOURCE, 'g');
  const out: Array<{ line: number; text: string }> = [];
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(re)) {
    // Line numbers come from the STRIPPED text: newlines are preserved by the
    // stripper, but character offsets are not (line comments shrink it).
    const line = stripped.slice(0, match.index ?? 0).split('\n').length;
    out.push({ line, text: match[0].trim() });
  }
  return out;
}

describe('the AI Operator never completes a checklist item (spec §6.5)', () => {
  const files = sourceFiles(OPERATOR_DIR);

  it('finds the files it is supposed to be guarding', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('humanWorkService.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('taskCoordinator.ts'))).toBe(true);
  });

  it('no Operator source file writes done_at or done_by_user_id', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of completionWrites(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${hit.line} — ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the regex actually discriminates — it flags a write and ignores a read', () => {
    // A guard whose pattern matches nothing would pass the case above forever.
    expect(completionWrites('  .set({ doneAt: now })')).toHaveLength(1);
    expect(completionWrites("  sql`UPDATE t SET done_at = now()`")).toHaveLength(1);
    expect(completionWrites('  row.doneByUserId = actor.userId;')).toHaveLength(1);
    expect(completionWrites('  .where(isNull(ticketChecklistItems.doneAt))')).toHaveLength(0);
    expect(completionWrites('  itemDoneAt: ticketChecklistItems.doneAt,')).toHaveLength(0);
    expect(completionWrites('  doneAt: Date | null;')).toHaveLength(0);
    expect(completionWrites('  if (existing.doneAt === null)')).toHaveLength(0);
    expect(completionWrites('  AND done_at IS NULL')).toHaveLength(0);
    // Comments are prose, not writes.
    expect(completionWrites('  // no doneByUserId: the sweep is not a user')).toHaveLength(0);
    expect(completionWrites('  /* doneAt: now */')).toHaveLength(0);
    // …but a write sharing a line with a URL string is still a write.
    expect(completionWrites("  x({ url: 'https://a', doneAt: now })")).toHaveLength(1);
  });

  it('ticketChecklistService is the ONLY module under services/ that writes those columns', () => {
    // The scope check: the rule above is worth nothing if a fifth service
    // outside services/aiOperator/ starts ticking items on the Operator's
    // behalf. Verified as a repo fact at planning time:
    //   grep -rln 'doneAt:' apps/api/src/services | grep -v '\.test\.'
    //   -> services/ticketChecklistService.ts
    // If this list grows, the new writer needs the same scrutiny the route's
    // isInteractiveUserSession gate gets.
    const writers = sourceFiles(join(OPERATOR_DIR, '..'))
      .filter((f) => completionWrites(readFileSync(f, 'utf8')).length > 0)
      .map((f) => f.split('/').pop());
    expect(writers).toEqual(['ticketChecklistService.ts']);
  });
});
