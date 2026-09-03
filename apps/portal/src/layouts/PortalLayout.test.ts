import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the shell's two navs. The rail and the phone menu are the
 * same navigation rendered twice, so the active entry has to be marked the same
 * way in both: the register mark plus `aria-current="page"` — never the filled
 * wash the world refuses (apps/portal/DESIGN.md, "Navigation").
 *
 * An .astro file has no unit-testable render here, so this reads the source.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('./PortalLayout.astro', import.meta.url)),
  'utf8',
);

function block(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('PortalLayout navigation', () => {
  const mobileNav = () => block('<nav class="absolute', '</nav>');

  it('marks the active phone-menu entry the way the rail marks its own', () => {
    const nav = mobileNav();
    expect(nav).toContain('aria-current=');
    // The register mark: a short green rule, not a filled pill.
    expect(nav).toContain('bg-primary');
    expect(nav).toContain('font-semibold text-foreground');
  });

  it('never fills the active phone-menu entry with an accent wash', () => {
    expect(mobileNav()).not.toContain('bg-accent font-semibold');
  });
});
