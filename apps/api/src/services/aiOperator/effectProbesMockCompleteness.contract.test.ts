/**
 * #10174 — a `vi.mock('./effectProbes', factory)` that omits a value
 * `effectDispatch.ts` imports throws `No "<name>" export is defined on the
 * mock` the moment a test reaches that code path. The planEffectStep suite
 * ejected merge-queue runs that way. This scan fails at authoring time instead:
 * every aiOperator test that replaces effectProbes with a hand-written factory
 * must either spread the original module or define every runtime name
 * effectDispatch imports from it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;

function dispatchImportsFromEffectProbes(): string[] {
  const src = readFileSync(join(DIR, 'effectDispatch.ts'), 'utf8');
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/effectProbes'/);
  if (!m) throw new Error('effectDispatch.ts no longer imports from ./effectProbes — update this guard');
  return m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0]!.trim());
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : testFiles(p);
    return e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Each `vi.mock('<…>/effectProbes', …)` call's text, up to its balanced close paren. */
function effectProbesMockCalls(src: string): string[] {
  const out: string[] = [];
  const re = /vi\.mock\(\s*'(?:\.\.?\/)+effectProbes(?:\/index)?'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + 'vi.mock'.length;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

describe('effectProbes mocks are complete for effectDispatch (#10174)', () => {
  const required = dispatchImportsFromEffectProbes();

  it('finds the names effectDispatch imports', () => {
    expect(required).toEqual(expect.arrayContaining(['probeEffect', 'isStructurallyUnobservable']));
  });

  it('every hand-written effectProbes mock factory defines all of them', () => {
    const gaps: string[] = [];
    let scanned = 0;
    for (const file of testFiles(DIR)) {
      if (file === __filename) continue;
      for (const call of effectProbesMockCalls(readFileSync(file, 'utf8'))) {
        scanned++;
        // A factory that spreads the original module inherits every export.
        if (/\.\.\.\s*\(\s*await\s+\w+/.test(call)) continue;
        const missing = required.filter((name) => !new RegExp(`\\b${name}\\b`).test(call));
        if (missing.length > 0) gaps.push(`${relative(DIR, file)}: missing ${missing.join(', ')}`);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(gaps).toEqual([]);
  });
});
