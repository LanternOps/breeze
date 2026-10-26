/**
 * Wisp companion W02a (#10212) — `resolveGrantCeiling(…, { allowPaused: true })`
 * returns a ceiling for a PAUSED grant. `assertWithinCeiling` refuses it
 * (status 'paused' → inactive), but any code that reads `orgIds` /
 * `permissionKeys` without asserting would act on a paused grant. So the
 * option is reserved for read-only history: the thread timeline route is its
 * only caller. Adding another caller is a deliberate change to this list.
 * Reads the source tree only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../..');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

describe('allowPaused ceiling reads (W02a)', () => {
  it('only routes/wispThreads.ts passes allowPaused: true (and only for GET /:id/timeline)', () => {
    const callers = walk(SRC)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .filter((p) => /\ballowPaused:\s*true\b/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      .sort();
    // wispThreads.ts forwards it from ceilingOf, and the timeline route is ceilingOf's only allowPaused caller.
    expect(callers).toEqual(['routes/wispThreads.ts']);

    const routes = readFileSync(join(SRC, 'routes/wispThreads.ts'), 'utf8');
    const routeCalls = [...routes.matchAll(/ceilingOf\(own,\s*\{\s*allowPaused:\s*true\s*\}\)/g)];
    expect(routeCalls).toHaveLength(1);
    const handler = routes.slice(routes.lastIndexOf('wispThreadRoutes.get(', routeCalls[0]!.index), routeCalls[0]!.index);
    expect(handler).toContain("'/:id/timeline'");
  });
});
