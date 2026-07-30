import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `@breeze/shared`'s root barrel is bundled into the browser by `apps/web`. Nothing
 * reachable from it may import a Node builtin.
 *
 * This exists because the mistake is one line: adding `export * from './commsDigests'` to
 * `m365/index.ts` looks harmless in review and would pull `node:crypto` into the web
 * bundle. The failure would surface as a build or runtime error far from the edit that
 * caused it, so it is worth catching here instead.
 *
 * Modules that legitimately need Node builtins stay out of the barrel and are reached via
 * an explicit subpath export (`@breeze/shared/canonicalize`,
 * `@breeze/shared/m365/commsDigests`). That is a deliberate placement, not an oversight.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const NODE_BUILTIN_IMPORT = /from\s+['"](?:node:)?(crypto|fs|path|os|child_process|net|tls|http|https|worker_threads|dns|cluster|zlib|stream|url|v8|vm|perf_hooks)['"]/;
const RELATIVE_IMPORT = /(?:from|import)\s+['"](\.[^'"]*)['"]/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/** Every `.ts` module transitively reachable from the root barrel, excluding tests. */
function reachableFromBarrel(): string[] {
  const seen = new Set<string>();
  const queue = [resolve(HERE, 'index.ts')];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const resolved = resolveModule(file, match[1]!);
      if (resolved && !resolved.endsWith('.test.ts')) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('root barrel stays browser-safe', () => {
  const modules = reachableFromBarrel();

  it('reaches a non-trivial set of modules', () => {
    // Guards the guard: a broken resolver would silently inspect almost nothing and pass.
    expect(modules.length).toBeGreaterThan(20);
  });

  it('reaches the comms modules that are supposed to be in the barrel', () => {
    for (const name of ['m365/commsActions.ts', 'm365/commsEffect.ts', 'm365/commsPlan.ts']) {
      expect(modules.some((m) => m.endsWith(name))).toBe(true);
    }
  });

  it('does NOT reach the Node-only modules', () => {
    for (const name of ['canonicalize/index.ts', 'm365/commsDigests.ts']) {
      expect(modules.some((m) => m.endsWith(name))).toBe(false);
    }
  });

  it('imports no Node builtin anywhere in that set', () => {
    const offenders = modules.filter((m) => NODE_BUILTIN_IMPORT.test(readFileSync(m, 'utf8')));
    expect(offenders.map((m) => m.slice(HERE.length + 1))).toEqual([]);
  });
});
