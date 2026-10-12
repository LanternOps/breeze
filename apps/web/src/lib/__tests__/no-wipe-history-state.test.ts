/**
 * Guard (#8331): `history.replaceState(null|{}, …)` wipes the state object
 * Astro's view-transition router keeps ({ index, scrollX, scrollY }); the next
 * soft navigation (e.g. an org switch) then throws
 * "Cannot read properties of null (reading 'index')". Use `replaceUrl()`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// `\s*` spans newlines, so the multi-line `replaceState(\n  null,` form is caught too.
const BAD = /\.replaceState\(\s*(?:null|undefined|\{\s*\})\s*,/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx|astro)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('no history.replaceState(null|{}) in production code', () => {
  it('has no offenders', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(BAD)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${relative(SRC_ROOT, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
