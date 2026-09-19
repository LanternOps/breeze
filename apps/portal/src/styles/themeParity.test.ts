import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORTAL_CHROME_ACCENTS, PORTAL_CHROME_ACCENT_DEFAULT } from '@breeze/shared';

/**
 * Contract test for the portal's two theme blocks.
 *
 * The dark palette shipped as dead code: 21 tokens were defined under `.dark`,
 * but nothing in the portal ever added that class, there was no toggle and no
 * media query, so a customer whose OS is in dark mode simply got a white page.
 * Wiring it meant duplicating the block under `prefers-color-scheme`, and a
 * duplicated palette is exactly the kind of thing that drifts one token at a
 * time until the two themes disagree.
 *
 * These assertions make drift a test failure instead of a visual bug nobody
 * notices, and they hold the light and dark blocks to the same token set so a
 * token added to one can never be missing from the other.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

/** Every `--token: value;` declaration in a block, as a map. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

function block(pattern: RegExp, label: string): string {
  const m = pattern.exec(CSS);
  if (!m) throw new Error(`${label} block not found in globals.css`);
  return m[1];
}

const lightBlock = block(/\n  :root\s*\{([\s\S]*?)\n  \}/, ':root');
const darkBlock = block(/\n  \.dark\s*\{([\s\S]*?)\n  \}/, '.dark');
const mediaBlock = block(
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\.light\)\s*\{([\s\S]*?)\n    \}/,
  'prefers-color-scheme'
);

describe('theme token parity', () => {
  const light = declarations(lightBlock);
  const dark = declarations(darkBlock);
  const media = declarations(mediaBlock);

  it('defines a non-trivial palette in each block', () => {
    expect(light.size).toBeGreaterThan(15);
    expect(dark.size).toBeGreaterThan(15);
  });

  // The whole point: the OS-preference copy must stay byte-identical to the
  // explicit `.dark` opt-in, or the two paths render differently.
  it('the prefers-color-scheme copy matches .dark exactly', () => {
    expect(Object.fromEntries(media)).toEqual(Object.fromEntries(dark));
  });

  it('light and dark define the same token names', () => {
    // --radius is layout, not colour, and is intentionally light-only.
    const lightNames = [...light.keys()].filter((n) => n !== 'radius').sort();
    const darkNames = [...dark.keys()].sort();
    expect(darkNames).toEqual(lightNames);
  });

  it('every colour token actually differs between themes', () => {
    // A token copied verbatim into the dark block is usually an oversight (a
    // white --card left white on a dark surface). The exceptions are real and
    // deliberate: a near-white foreground sits on a dark-red fill in BOTH
    // themes and clears AA on each (6.3:1 light, 5.5:1 dark), so forcing a
    // difference would be change for its own sake.
    const SHARED_BY_DESIGN = new Set(['destructive-foreground']);
    const identical = [...dark.entries()]
      .filter(([name, value]) => light.get(name) === value && !SHARED_BY_DESIGN.has(name))
      .map(([name]) => name);
    expect(identical, `tokens identical in both themes: ${identical.join(', ')}`).toEqual([]);
  });

  it('dark mode is actually reachable', () => {
    // The bug this whole block exists to fix: a palette with no way to trigger it.
    expect(CSS).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(CSS).toMatch(/color-scheme: dark/);
  });

  it('documents are pinned to paper regardless of theme', () => {
    // Proposals and invoices carry partner brand colours chosen against white,
    // and are what a customer prints or forwards to their accountant.
    expect(CSS).toMatch(/\[data-doc-theme\]\s*\{[\s\S]*?color-scheme: light/);
  });
});

/**
 * The curated chrome accents (packages/shared/src/types/portalChromeAccent.ts)
 * duplicate the same dark-mode palette a second time, once more: a
 * `.dark[data-accent="…"]` block for the explicit opt-in and a
 * `:root[data-accent="…"]:not(.light)` block inside the `prefers-color-scheme`
 * media query for the OS-preference path. Same drift risk as the base
 * palette, so the same identity check applies to each accent's pair.
 * chromeAccents.test.ts separately checks both against the shared spec
 * values; this only checks the two CSS blocks agree with EACH OTHER.
 */
describe('chrome accent dark-mode parity', () => {
  const nonDefaultKeys = (Object.keys(PORTAL_CHROME_ACCENTS) as (keyof typeof PORTAL_CHROME_ACCENTS)[]).filter(
    (key) => key !== PORTAL_CHROME_ACCENT_DEFAULT
  );

  function accentBlock(selectorPattern: string, label: string): string {
    // `[^}]*` (not `[\s\S]*?\n\}`) so this works regardless of the block's
    // indentation — the media-query accent rules are nested one level deeper
    // than the top-level `:root[data-accent]` / `.dark[data-accent]` rules,
    // and none of these declaration blocks nest braces of their own.
    const m = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`).exec(CSS);
    if (!m) throw new Error(`${label} block not found in globals.css`);
    return m[1];
  }

  it('covers every non-default accent key', () => {
    expect(nonDefaultKeys.length).toBe(7);
  });

  it.each(nonDefaultKeys)('%s: .dark override matches its prefers-color-scheme override exactly', (key) => {
    const darkClassBlock = accentBlock(`\\.dark\\[data-accent='${key}'\\]`, `.dark[data-accent='${key}']`);
    const mediaAccentBlock = accentBlock(
      `:root\\[data-accent='${key}'\\]:not\\(\\.light\\)`,
      `:root[data-accent='${key}']:not(.light)`
    );
    expect(Object.fromEntries(declarations(mediaAccentBlock))).toEqual(
      Object.fromEntries(declarations(darkClassBlock))
    );
  });
});
