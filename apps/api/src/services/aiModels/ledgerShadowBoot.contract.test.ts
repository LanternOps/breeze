import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('invocation ledger shadow is registered in every process that records AI cost (#7600 W02)', () => {
  it.each(['index.ts', 'worker.ts'])('%s registers the listener', (file) => {
    expect(src(file)).toMatch(/registerInvocationLedgerShadow\(\)/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * Top-level argument count of the call starting at `open` (index of its '(').
 * A trailing comma (`f(a, b,\n)`) does not start a new argument, and commas or
 * brackets inside comments and string literals are not counted (a comment with
 * a comma inside a 10-argument call must not read as the 11th argument).
 */
function argCount(text: string, open: number): number {
  let depth = 0; let commas = 0; let sawToken = false; let tokenSinceComma = false;
  for (let i = open; i < text.length; i++) {
    let ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i === 0) break; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      // Skip the literal; it is one token. (Template `${…}` holes are not
      // parsed — no tracker call site passes a template literal.)
      const quote = ch;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
      ch = 'x';
    }
    if (depth >= 1 && !/\s/.test(ch) && !(depth === 1 && (ch === ',' || ch === ')'))) {
      sawToken = true; tokenSinceComma = true;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth === 0) return sawToken ? commas + (tokenSinceComma ? 1 : 0) : 0;
    } else if (ch === ',' && depth === 1) { commas++; tokenSinceComma = false; }
  }
  throw new Error('unbalanced call');
}

/**
 * Files whose bare `recordUsage(` is NOT the cost tracker, keyed by path
 * relative to `src/`. Each entry is asserted below not to import the tracker,
 * so the allowlist cannot hide a real call.
 */
const NOT_THE_TRACKER: Record<string, string> = {
  // A local `const recordUsage = async () => …` closure that settles the
  // topology token reservation. Topology's model cost is recorded by
  // recordUsageFromSdkResult on the session path.
  'services/topology/aiInvestigation.ts': 'local closure named recordUsage',
};

/** True when the match sits on a `//` line or a block-comment line. */
function isCommentLine(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(text.slice(lineStart, at));
}

describe('every AI cost record carries an invocation-ledger context (#7600 W02)', () => {
  const root = join(__dirname, '../..');
  const rel = (file: string) => file.slice(root.length + 1);
  const files = sourceFiles(root).filter((f) => !f.endsWith('services/aiCostTracker.ts'));

  it('allowlisted namesakes do not import the cost tracker', () => {
    for (const file of Object.keys(NOT_THE_TRACKER)) {
      expect(src(file), file).not.toMatch(/aiCostTracker['"]/);
    }
  });

  // W03 Task 12: agent runs (the last caller) settle through settleInvocation;
  // a reintroduced call would bill a run twice. Task 17 deletes the function.
  it('recordSessionlessSdkUsage has no callers left (agent runs settle through the registry)', () => {
    const callers: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf('recordSessionlessSdkUsage(');
      while (at !== -1) {
        const isDefinition = /function\s+$/.test(text.slice(Math.max(0, at - 20), at));
        if (!isDefinition && !isCommentLine(text, at)) callers.push(`${rel(file)}:${text.slice(0, at).split('\n').length}`);
        at = text.indexOf('recordSessionlessSdkUsage(', at + 1);
      }
    }
    expect(callers).toEqual([]);
  });

  it.each([
    ['recordUsage(', 11],
  ] as const)('every %s call passes the ledger argument', (callee, required) => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files) {
      if (callee === 'recordUsage(' && NOT_THE_TRACKER[rel(file)]) continue;
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf(callee);
      while (at !== -1) {
        const isDefinition = /function\s+$/.test(text.slice(Math.max(0, at - 20), at));
        const isMember = /[.\w]$/.test(text.slice(at - 1, at)) && !/\s$/.test(text.slice(at - 1, at));
        if (!isDefinition && !isMember && !isCommentLine(text, at)) {
          scanned++;
          if (argCount(text, at + callee.length - 1) < required) {
            offenders.push(`${rel(file)}:${text.slice(0, at).split('\n').length}`);
          }
        }
        at = text.indexOf(callee, at + callee.length);
      }
    }
    // Guards against a scanner that silently matches nothing.
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
