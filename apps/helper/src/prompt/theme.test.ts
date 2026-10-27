// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeCardTheme, brandAccentFor, type CardTheme } from './theme';

/*
 * #10190 W04 (Todd's W03 decision 4): the brand colour is used only when it
 * is readable in the ACTIVE theme. Forced colours and "more contrast" always
 * get the neutral palette (system colours under forced-colors).
 */

// [colour, light, dark] -> brand or neutral. Ratios against the Assist
// canvases (#FBFAF9 light, #191A1F dark); AA = 4.5.
const TABLE: Array<[string, 'brand' | 'neutral', 'brand' | 'neutral']> = [
  ['#1F5FAD', 'brand', 'neutral'], // dark blue: ~6.1 on light, ~2.7 on dark
  ['#336699', 'brand', 'neutral'],
  ['#000000', 'brand', 'neutral'],
  ['#FFFFFF', 'neutral', 'brand'],
  ['#FFD166', 'neutral', 'brand'], // light yellow: readable on dark only
  ['#7FB7FF', 'neutral', 'brand'],
  ['#777777', 'neutral', 'neutral'], // mid grey: 4.3 / 3.9, readable on neither
  ['#E0533D', 'neutral', 'brand'], // 3.7 on light, 4.53 on dark
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
