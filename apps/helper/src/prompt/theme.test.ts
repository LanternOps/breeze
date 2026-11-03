// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeCardTheme, brandAccentFor, CARD_SURFACE_DARK, CARD_SURFACE_LIGHT, type CardTheme } from './theme';


/*
 * #10190 W04 (Todd's W03 decision 4): the brand colour is used only when it
 * is readable in the ACTIVE theme. Forced colours and "more contrast" always
 * get the neutral palette (system colours under forced-colors).
 */

// [colour, light, dark] -> brand or neutral. The ratio must reach AA (4.5)
// on BOTH backgrounds of the theme: the canvas and the card surface the card
// actually paints (--bg-secondary = --ws-surface): light #FBFAF9 / #FFFFFF,
// dark #191A1F / #202128. Ratios below are the lower of the two.
const TABLE: Array<[string, 'brand' | 'neutral', 'brand' | 'neutral']> = [
  ['#1F5FAD', 'brand', 'neutral'], // dark blue: 6.1 light, 2.5 dark
  ['#336699', 'brand', 'neutral'],
  ['#000000', 'brand', 'neutral'],
  ['#FFFFFF', 'neutral', 'brand'],
  ['#FFD166', 'neutral', 'brand'], // light yellow: readable on dark only
  ['#7FB7FF', 'neutral', 'brand'],
  ['#777777', 'neutral', 'neutral'], // mid grey: 4.3 / 3.6, readable on neither
  ['#E0533D', 'neutral', 'neutral'], // 4.53 on the dark canvas, but 4.18 on the dark card surface
  ['#F06A55', 'neutral', 'brand'], // 2.9 light, 5.3 dark
];

const THEMES: CardTheme[] = ['light', 'dark', 'forced', 'more'];

describe('brandAccentFor (per-theme contrast fallback)', () => {
  it.each(TABLE)('%s: light=%s dark=%s, forced/more always neutral', (colour, light, dark) => {
    const expected: Record<CardTheme, 'brand' | 'neutral'> = { light, dark, forced: 'neutral', more: 'neutral' };
    for (const theme of THEMES) {
      const got = brandAccentFor(colour, theme);
      expect(got === null ? 'neutral' : 'brand', `${colour} in ${theme}`).toBe(expected[theme]);
      if (got !== null) expect(got).toBe(colour);
    }
  });

  it('never passes anything but strict #RRGGBB', () => {
    for (const bad of [null, undefined, '', 'red', '#FFF', '#1F5FAD;x', 'url(x)', '#1F5FAG']) {
      for (const theme of THEMES) expect(brandAccentFor(bad, theme)).toBeNull();
    }
  });

  it('the old either-canvas rule would have used colours this one refuses', () => {
    // #1F5FAD is readable on the light canvas only: it must not be used in dark.
    expect(brandAccentFor('#1F5FAD', 'light')).toBe('#1F5FAD');
    expect(brandAccentFor('#1F5FAD', 'dark')).toBeNull();
  });

  it('measures on the card surface, not only the canvas: #E0533D in dark is neutral', () => {
    // 4.53:1 on the dark canvas, 4.18:1 on the dark card surface the card paints.
    expect(brandAccentFor('#E0533D', 'dark')).toBeNull();
  });

  it('the card surfaces are the backgrounds measured against', () => {
    // lib.rs `card_surface_constants_match_tokens_css` pins these to tokens.css.
    expect(CARD_SURFACE_LIGHT).toBe('#FFFFFF');
    expect(CARD_SURFACE_DARK).toBe('#202128');
  });
});

describe('activeCardTheme', () => {
  const media = (matches: Record<string, boolean>) =>
    vi.fn((q: string) => ({ matches: matches[q] ?? false }) as MediaQueryList);

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
  });

  it('reads forced colours first, then more contrast, then the Assist theme', () => {
    vi.stubGlobal('matchMedia', media({ '(forced-colors: active)': true, '(prefers-contrast: more)': true }));
    expect(activeCardTheme()).toBe('forced');
    vi.stubGlobal('matchMedia', media({ '(prefers-contrast: more)': true }));
    expect(activeCardTheme()).toBe('more');
    vi.stubGlobal('matchMedia', media({}));
    expect(activeCardTheme()).toBe('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(activeCardTheme()).toBe('dark');
  });

  it('falls back to the Assist theme where matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(activeCardTheme()).toBe('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(activeCardTheme()).toBe('dark');
  });
});
