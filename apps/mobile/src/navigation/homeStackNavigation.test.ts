import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wisp W06 made the Home tab a stack (Home + WispThread). A bare
 * `navigate('HomeTab')` now lands on whatever is on top of that stack — a Wisp
 * thread the technician opened earlier — instead of the chat. Every jump to
 * the chat must name the screen: `navigate('HomeTab', { screen: 'Home' })`.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe('HomeTab is a stack (Wisp W06)', () => {
  it('no source navigates to HomeTab without naming a screen', () => {
    const offenders = sources(join(__dirname, '..')).filter((p) =>
      /navigate\(\s*['"]HomeTab['"]\s*\)/.test(readFileSync(p, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
