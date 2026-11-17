/**
 * #5534 — static guard: every terminal writer uses the contract.
 *
 * The real-row proof lives in
 * `src/__tests__/integration/remoteDesktopTerminalIntent.integration.test.ts`,
 * but that only runs under Integration Tests. This scan runs in the unit job,
 * so a NEW `update(remoteSessions).set({ status: '<terminal>' … })` that
 * bypasses `terminalIntentSet` / `commitDesktopTerminalIntent` fails the PR
 * before it can reach a real database — the seventh-writer case the wave
 * exists to prevent.
 *
 * Heuristic on purpose: it reads the `.set(` argument that follows every
 * `update(remoteSessions)` in `apps/api/src` and requires any terminal status
 * literal (or a `status:` bound to a variable) to be wrapped by the contract.
 * Live-status writes (`'connecting'`, `'active'`) are the start side and are
 * left alone. If you have a legitimate reason to write a terminal status
 * outside the contract, there isn't one — route it through the contract.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..');
const CONTRACT_FILE = 'services/remoteDesktopTerminalIntent.ts';
const TERMINAL_STATUS_RE = /status:\s*(?:'(?:disconnected|failed|denied)'|[A-Za-z_$][\w.$]*(?!\s*\())/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      walk(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Return the text of the balanced `.set(...)` call that follows `from`. */
function setArgumentAfter(source: string, from: number): string | null {
  const setAt = source.indexOf('.set(', from);
  if (setAt === -1) return null;
  let depth = 0;
  for (let i = setAt + 4; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(setAt + 5, i);
    }
  }
  return null;
}

interface Violation { file: string; line: number; set: string }

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file);
    if (rel === CONTRACT_FILE) continue;
    const source = readFileSync(file, 'utf8');
    let cursor = 0;
    for (;;) {
      const at = source.indexOf('update(remoteSessions)', cursor);
      if (at === -1) break;
      cursor = at + 1;
      const set = setArgumentAfter(source, at);
      if (set === null) continue;
      if (!TERMINAL_STATUS_RE.test(set)) continue;
      if (set.includes('terminalIntentSet(')) continue;
      const line = source.slice(0, at).split('\n').length;
      violations.push({ file: rel, line, set: set.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return violations;
}

/** End index (exclusive) of the balanced `(...)` that opens at `openAt`, or -1. */
function balancedCallEnd(source: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * #11839: every `terminalIntentSet(` call must sit inside the argument span of
 * a `runTerminalWrite(` call, so a database without the widened end-reason
 * CHECK still lets the session end (the retry rebuilds the set clause without
 * the reason). Returns the `terminalIntentSet(` calls that do not.
 */
function unwrappedTerminalIntentSets(source: string): number[] {
  const spans: Array<[number, number]> = [];
  for (let at = source.indexOf('runTerminalWrite('); at !== -1; at = source.indexOf('runTerminalWrite(', at + 1)) {
    const open = at + 'runTerminalWrite'.length;
    const end = balancedCallEnd(source, open);
    if (end !== -1) spans.push([open, end]);
  }
  const unwrapped: number[] = [];
  for (let at = source.indexOf('terminalIntentSet('); at !== -1; at = source.indexOf('terminalIntentSet(', at + 1)) {
    if (!spans.some(([open, end]) => at > open && at < end)) unwrapped.push(at);
  }
  return unwrapped;
}

describe('every remote_sessions terminal writer goes through the contract', () => {
  it('finds no update(remoteSessions).set({status: <terminal>}) outside terminalIntentSet', () => {
    const violations = scan();
    expect(
      violations,
      'A terminal write on remote_sessions bypasses the terminal-intent contract. '
        + 'Wrap the set clause in terminalIntentSet(...) (bulk) or call commitDesktopTerminalIntent(...) '
        + '(single row), and add the writer to the WRITERS table in '
        + 'src/__tests__/integration/remoteDesktopTerminalIntent.integration.test.ts:\n'
        + violations.map((v) => `  ${v.file}:${v.line}  .set(${v.set})`).join('\n'),
    ).toEqual([]);
  });

  it('#11839: every terminalIntentSet(...) call runs inside runTerminalWrite(...)', () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel === CONTRACT_FILE) continue;
      const source = readFileSync(file, 'utf8');
      for (const at of unwrappedTerminalIntentSets(source)) {
        violations.push(`${rel}:${source.slice(0, at).split('\n').length}`);
      }
    }
    expect(
      violations,
      'A terminal write builds terminalIntentSet(...) outside runTerminalWrite(...). On a database '
        + 'without the widened remote_sessions_end_reason_check it would fail with 23514 and the session '
        + 'would stay live. Wrap the whole UPDATE: runTerminalWrite(() => db.update(remoteSessions).set(terminalIntentSet(...))...):\n'
        + violations.map((v) => `  ${v}`).join('\n'),
    ).toEqual([]);
  });

  it('the runTerminalWrite scan discriminates: a bare set clause is reported, a wrapped one is not', () => {
    const bare = "await db.update(remoteSessions).set(terminalIntentSet({ status: 'disconnected' }, 'pending')).returning();";
    const wrapped = "await runTerminalWrite(() => db.update(remoteSessions).set(terminalIntentSet({ status: 'disconnected' }, 'pending')).returning());";
    const after = "await runTerminalWrite(() => other()); await db.update(remoteSessions).set(terminalIntentSet({}, 'pending'));";
    expect(unwrappedTerminalIntentSets(bare)).toHaveLength(1);
    expect(unwrappedTerminalIntentSets(wrapped)).toHaveLength(0);
    expect(unwrappedTerminalIntentSets(after)).toHaveLength(1);
  });

  it('the scan itself discriminates: a bare terminal write is reported', () => {
    // Positive control for the heuristic — if this stops matching, the guard
    // above is silently vacuous.
    const set = "{ status: 'disconnected', endedAt: new Date() }";
    expect(TERMINAL_STATUS_RE.test(set)).toBe(true);
    expect(TERMINAL_STATUS_RE.test("{ status: options.terminalStatus }")).toBe(true);
    expect(TERMINAL_STATUS_RE.test("{ status: 'active', startedAt: new Date() }")).toBe(false);
    expect(TERMINAL_STATUS_RE.test("{ status: 'connecting' }")).toBe(false);
  });
});
