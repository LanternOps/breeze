import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');

/**
 * Every interactive element that carries no focus utility of its own (most
 * buttons on the app) fell back to the browser default outline, which several
 * engines suppress on click and which never matched the palette. A single
 * base-layer `:focus-visible` rule is the cheapest keyboard-visibility fix in
 * the app; this guards it from being lost in a stylesheet rewrite.
 */
describe('globals.css keyboard focus', () => {
  it('declares a palette-driven :focus-visible outline in the base layer', () => {
    const rule = css.match(/:focus-visible\s*\{[^}]*\}/);
    expect(rule, 'expected a :focus-visible rule').not.toBeNull();
    expect(rule![0]).toMatch(/outline:\s*2px solid hsl\(var\(--ring\)\)/);
    expect(rule![0]).toMatch(/outline-offset/);
  });
});
