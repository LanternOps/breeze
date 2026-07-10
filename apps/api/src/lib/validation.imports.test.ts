import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for issue #2201: route files must import `zValidator` from
 * `src/lib/validation` (which installs the readable string-first 400 hook),
 * never from `@hono/zod-validator` directly — the package default returns a
 * raw serialized ZodError that is unreadable for every non-web client.
 *
 * `vi.mock('@hono/zod-validator', ...)` calls in tests are fine (they
 * intercept the wrapper's own base import), so only import statements count.
 */

const ROUTES_DIR = join(__dirname, '..', 'routes');

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
  it('no route file imports @hono/zod-validator directly', () => {
    const offenders = walk(ROUTES_DIR).filter((file) =>
      /import\s[^;]*from\s+['"]@hono\/zod-validator['"]/.test(readFileSync(file, 'utf8'))
    );
    expect(
      offenders,
      `Import zValidator from src/lib/validation instead of @hono/zod-validator:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
