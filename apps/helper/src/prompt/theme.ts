import { useEffect, useState } from 'react';

import { contrastRatio, HELPER_CANVAS_DARK, HELPER_CANVAS_LIGHT, MIN_CONTRAST_RATIO } from '@breeze-brand-contrast';

/*
 * The theme a card is drawn in, for the brand accent (#10190 W04, Todd's W03
 * decision 4). The brand colour is used only when it is readable in the
 * ACTIVE theme; the shared rule (`isReadableBrandColor`) accepts a colour
 * readable on either canvas, which can be low contrast in the theme in use.
 *
 *   forced  `forced-colors: active` (Windows high contrast): system colours
 *           only, never the brand (prompt.css maps the accent to CanvasText).
 *   more    `prefers-contrast: more`: the neutral palette, never the brand.
 *   dark    Assist's dark theme (`<html data-theme="dark">`, lib/theme.ts).
 *   light   Assist's default theme.
 */
export type CardTheme = 'light' | 'dark' | 'forced' | 'more';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * The card surface a prompt card paints (`.prompt-card` background is
 * `--bg-secondary` = `--ws-surface`, styles/tokens.css): white in light,
 * hsl(230 11% 14%) in dark. A test pins these against tokens.css.
 */
export const CARD_SURFACE_LIGHT = '#FFFFFF';
export const CARD_SURFACE_DARK = '#202128';

/**
 * The backgrounds the accent must be readable on, per theme: the Assist
 * canvas (the shared constants) AND the card surface it is actually drawn on.
 */
const BACKGROUNDS: Record<'light' | 'dark', readonly string[]> = {
  light: [HELPER_CANVAS_LIGHT, CARD_SURFACE_LIGHT],
  dark: [HELPER_CANVAS_DARK, CARD_SURFACE_DARK],
};

/** The brand colour to use in `theme`, or null for the neutral palette. */
export function brandAccentFor(color: string | null | undefined, theme: CardTheme): string | null {
  if (!color || !HEX_COLOR.test(color)) return null;
  if (theme === 'forced' || theme === 'more') return null;
  return BACKGROUNDS[theme].every((bg) => contrastRatio(color, bg) >= MIN_CONTRAST_RATIO) ? color : null;
}

const FORCED = '(forced-colors: active)';
const MORE = '(prefers-contrast: more)';

function mediaMatches(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** The theme in force right now. */
export function activeCardTheme(): CardTheme {
  if (mediaMatches(FORCED)) return 'forced';
  if (mediaMatches(MORE)) return 'more';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * The active theme, kept current: the OS contrast settings change at run
 * time, and Assist's own theme switch rewrites `data-theme`.
 */
export function useCardTheme(): CardTheme {
  const [theme, setTheme] = useState<CardTheme>(activeCardTheme);
  useEffect(() => {
    const update = () => setTheme(activeCardTheme());
    const queries =
      typeof window.matchMedia === 'function' ? [FORCED, MORE].map((q) => window.matchMedia(q)) : [];
    for (const q of queries) q.addEventListener?.('change', update);
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    update();
    return () => {
      for (const q of queries) q.removeEventListener?.('change', update);
      observer?.disconnect();
    };
  }, []);
  return theme;
}
