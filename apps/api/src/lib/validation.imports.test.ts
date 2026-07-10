import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard for issue #2201: application code must import `zValidator` from
 * `src/lib/validation` (which installs the readable string-first 400 hook),
 * never from `@hono/zod-validator` directly — the package default returns a
 * raw serialized ZodError that is unreadable for every non-web client.
 *
 * Scope: all of `src/` (not just routes/) so a future validator-using
 * middleware or shared helper can't reintroduce raw ZodError 400s. Only the
 * wrapper itself and test files are exempt. `vi.mock('@hono/zod-validator',
 * ...)` calls are fine regardless (they intercept the wrapper's own base
 * import), and the regex also catches `export ... from` re-exports so the
 * import can't be laundered through a helper.
 */

const SRC_DIR = join(__dirname, '..');
const WRAPPER = join(__dirname, 'validation.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('zValidator import guard (#2201)', () => {
  it('no app file imports @hono/zod-validator directly', () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => file !== WRAPPER && !file.endsWith('.test.ts'))
      .filter((file) =>
        /(?:import|export)\s[^;]*from\s+['"]@hono\/zod-validator['"]/.test(
          readFileSync(file, 'utf8')
        )
      )
      .map((file) => relative(SRC_DIR, file));
    expect(
      offenders,
      `Import zValidator from src/lib/validation instead of @hono/zod-validator:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
