import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORTAL_CHROME_ACCENTS, PORTAL_CHROME_ACCENT_DEFAULT } from '@breeze/shared';

/**
 * Contract test for the portal's curated chrome accents.
 *
 * globals.css's `[data-accent="…"]` blocks are GENERATED from
 * packages/shared/src/types/portalChromeAccent.ts (`PORTAL_CHROME_ACCENTS`)
 * verbatim — the API validates writes against the same spec, so a hand-edited
 * CSS value that drifts from it is a silent lie: the settings UI swatch and
 * the actual chrome would disagree. This parses the generated blocks back out
 * and asserts every non-default key's four tokens (`--primary`,
 * `--primary-foreground`, `--primary-on-tint`, `--ring`) still equal the
 * spec's `light` values (the `[data-accent]`-only block) and `dark` values
 * (both the `.dark[data-accent]` block and the `prefers-color-scheme` media
 * block) — so an edit to either side without the other fails here, not in a
 * partner's browser.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

const TOKENS = ['primary', 'primary-foreground', 'primary-on-tint', 'ring'] as const;
const SPEC_KEY: Record<(typeof TOKENS)[number], 'primary' | 'primaryForeground' | 'primaryOnTint' | 'ring'> = {
  primary: 'primary',
  'primary-foreground': 'primaryForeground',
  'primary-on-tint': 'primaryOnTint',
  ring: 'ring'
};

/**
 * Every `--token: value;` declaration inside the FIRST block matching
 * `selectorPattern { ... }`. `selectorPattern` is a regex source string
 * (callers pass their own escaping), not a literal CSS selector.
 */
function declarationsFor(selectorPattern: string, label: string): Map<string, string> {
  // `[^}]*` (not `[\s\S]*?\n\}`) so this works regardless of the block's
  // indentation — the media-query accent rules are nested one level deeper
  // than the top-level `:root[data-accent]` / `.dark[data-accent]` rules,
  // and none of these declaration blocks nest braces of their own.
  const m = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`${label} block not found in globals.css`);
  const out = new Map<string, string>();
  for (const decl of m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    out.set(decl[1], decl[2].trim());
  }
  return out;
}

const nonDefaultKeys = (Object.keys(PORTAL_CHROME_ACCENTS) as (keyof typeof PORTAL_CHROME_ACCENTS)[]).filter(
  (key) => key !== PORTAL_CHROME_ACCENT_DEFAULT
);

describe('chrome accent CSS matches PORTAL_CHROME_ACCENTS', () => {
  it('covers every non-default accent key', () => {
    expect(nonDefaultKeys.length).toBe(7);
  });

  it('never generates an override block for the default key', () => {
    // Sanity: the default key should never get a [data-accent="spruce"] block —
    // the base :root/.dark/media tokens already ARE spruce.
    expect(CSS).not.toContain(`data-accent='${PORTAL_CHROME_ACCENT_DEFAULT}'`);
  });

  for (const key of nonDefaultKeys) {
    const spec = PORTAL_CHROME_ACCENTS[key];

    describe(key, () => {
      it('light block matches the spec light values', () => {
        const decls = declarationsFor(`:root\\[data-accent='${key}'\\]`, `:root[data-accent='${key}']`);
        for (const token of TOKENS) {
          expect(decls.get(token), `--${token} in :root[data-accent='${key}']`).toBe(spec.light[SPEC_KEY[token]]);
        }
      });

      it('.dark override matches the spec dark values', () => {
        const decls = declarationsFor(`\\.dark\\[data-accent='${key}'\\]`, `.dark[data-accent='${key}']`);
        for (const token of TOKENS) {
          expect(decls.get(token), `--${token} in .dark[data-accent='${key}']`).toBe(spec.dark[SPEC_KEY[token]]);
        }
      });

      it('prefers-color-scheme override matches the spec dark values', () => {
        const decls = declarationsFor(
          `:root\\[data-accent='${key}'\\]:not\\(\\.light\\)`,
          `:root[data-accent='${key}']:not(.light)`
        );
        for (const token of TOKENS) {
          expect(decls.get(token), `--${token} in media :root[data-accent='${key}']:not(.light)`).toBe(
            spec.dark[SPEC_KEY[token]]
          );
        }
      });
    });
  }
});
