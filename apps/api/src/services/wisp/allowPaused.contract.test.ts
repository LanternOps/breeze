/**
 * Wisp companion W02a (#10212) — `resolveGrantCeiling(…, { allowPaused: true })`
 * returns a ceiling for a PAUSED grant. `assertWithinCeiling` refuses it
 * (status 'paused' → inactive), but any code that reads `orgIds` /
 * `permissionKeys` without asserting would act on a paused grant. So the
 * option is reserved for read-only history: the thread timeline and activity
 * routes, and the concern list / detail reads (#10104 — a paused grant's
 * thread keeps showing what is still open). Every caller must be a GET
 * handler; adding another is a deliberate change to these lists.
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

/** The route path of the handler that encloses `index` in `src` (the nearest preceding `<router>.<verb>(`). */
function enclosingHandler(src: string, router: string, index: number): { verb: string; path: string } {
  const re = new RegExp(`${router}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
  let found: { verb: string; path: string } | null = null;
  for (const m of src.matchAll(re)) {
    if (m.index! > index) break;
    found = { verb: m[1]!, path: m[2]! };
  }
  if (!found) throw new Error(`no ${router} handler before offset ${index}`);
  return found;
}

describe('allowPaused ceiling reads (W02a, #10104)', () => {
  it('only the two Wisp route files pass allowPaused: true', () => {
    const callers = walk(SRC)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .filter((p) => /\ballowPaused:\s*true\b/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      .sort();
    // Each forwards it from its own helper (ceilingOf / grantCeilingFor) to resolveGrantCeiling.
    expect(callers).toEqual(['routes/wispConcerns.ts', 'routes/wispThreads.ts']);
  });

  it('wispThreads.ts: only GET /:id/timeline and GET /:id/activity read a paused grant', () => {
    const routes = readFileSync(join(SRC, 'routes/wispThreads.ts'), 'utf8');
    const calls = [...routes.matchAll(/ceilingOf\(own,\s*\{\s*allowPaused:\s*true\s*\}\)/g)];
    const handlers = calls.map((m) => enclosingHandler(routes, 'wispThreadRoutes', m.index!));
    expect(handlers.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { verb: 'get', path: '/:id/activity' },
      { verb: 'get', path: '/:id/timeline' },
    ]);
  });

  it('wispConcerns.ts: only GET / and GET /:id read a paused grant; no mutation does', () => {
    const routes = readFileSync(join(SRC, 'routes/wispConcerns.ts'), 'utf8');
    const calls = [...routes.matchAll(/grantCeilingFor\([^;]*?\{\s*allowPaused:\s*true\s*\}\)/g)];
    const handlers = calls.map((m) => enclosingHandler(routes, 'wispConcernsRoutes', m.index!));
    expect(handlers.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { verb: 'get', path: '/' },
      { verb: 'get', path: '/:id' },
    ]);
  });

  it('assertReadWithinCeiling (no status gate) is used only by the activity read belt', () => {
    const users = walk(SRC)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .filter((p) => /\bassertReadWithinCeiling\b/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      .sort();
    // Defined in grantAuthority; any new user is a read path by definition and must be added here deliberately.
    expect(users).toEqual(['services/wisp/activity.ts', 'services/wisp/grantAuthority.ts']);
  });
});
