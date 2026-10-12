/**
 * Guard (#8331): `history.replaceState(<not history.state>, …)` wipes the state
 * object Astro's view-transition router keeps ({ index, scrollX, scrollY }); the
 * next soft navigation (e.g. an org switch) then throws
 * "Cannot read properties of null (reading 'index')". Use `replaceUrl()`.
 *
 * Allow-list: the first argument of every `.replaceState(` must be
 * `history.state` / `window.history.state`. `lib/replaceUrl.ts` owns the one
 * deliberate state write (the router-shape seed).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = 'lib/replaceUrl.ts';
const CALL = /\.replaceState\s*\(\s*([^,)]*?)\s*,/g;
const ALLOWED_FIRST_ARG = /^(?:window\.)?history\.state$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx|astro|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Offending first arguments in `src` (comments stripped). */
export function findWipingCalls(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bad: string[] = [];
  for (const m of code.matchAll(CALL)) {
    if (!ALLOWED_FIRST_ARG.test(m[1])) bad.push(m[1]);
  }
  // `history['replaceState'](…)` / `x.replaceState.call(…)` forms are not allow-listable.
  if (/\[\s*['"]replaceState['"]\s*\]|\.replaceState\s*\.\s*(?:call|apply|bind)\b/.test(code)) bad.push('<indirect>');
  return bad;
}

describe('no history.replaceState that wipes router state in production code', () => {
  it('scans a real source tree (not vacuous)', () => {
    expect(walk(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it('flags the wiping forms', () => {
    for (const src of [
      "history.replaceState(null, '', u)",
      "window.history.replaceState({}, '', u)",
      "history.replaceState(\n  null,\n  '',\n  u)",
      "history.replaceState(null as any, '', u)",
      "history.replaceState(undefined, '', u)",
      "history['replaceState'](null, '', u)",
    ]) {
      expect(findWipingCalls(src), src).not.toEqual([]);
    }
  });

  it('accepts state pass-through', () => {
    expect(findWipingCalls("history.replaceState(history.state, '', u)")).toEqual([]);
    expect(findWipingCalls("window.history.replaceState(\n  window.history.state,\n  '',\n  u)")).toEqual([]);
  });

  it('has no offenders', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel === OWNER) continue;
      const bad = findWipingCalls(readFileSync(file, 'utf8'));
      if (bad.length) offenders.push(`${rel}: ${bad.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
