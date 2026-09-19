import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PORTAL_CHROME_ACCENTS, PORTAL_CHROME_ACCENT_DEFAULT } from '@breeze/shared';

/**
 * Contract test for the portal's colour tokens.
 *
 * A mechanical sweep found EIGHT of thirteen measured foreground/background
 * pairs failing WCAG AA, the worst at 1.92:1 (the "high" priority badge on the
 * support-ticket list, amber-on-amber). None of it was visible to code review:
 * the classes read fine, and the failure only exists once the tokens resolve.
 * So the ratios are asserted here rather than trusted.
 *
 * Every badge and banner in the portal is 12px text (`text-xs`), so the 4.5:1
 * threshold applies throughout — the 3:1 large-text exemption never does.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

/** Pull an HSL triplet token (e.g. `--warning: 38 92% 50%`) out of a block. */
function token(block: string, name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*([0-9.]+)\\s+([0-9.]+)%\\s+([0-9.]+)%`).exec(block);
  if (!m) throw new Error(`token --${name} not found`);
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

/** The `:root {...}` light block. */
function lightBlock(): string {
  const m = /:root\s*\{([\s\S]*?)\n  \}/.exec(CSS);
  if (!m) throw new Error(':root block not found');
  return m[1];
}

/** The `.dark {...}` block. */
function darkBlock(): string {
  const m = /\n  \.dark\s*\{([\s\S]*?)\n  \}/.exec(CSS);
  if (!m) throw new Error('.dark block not found');
  return m[1];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Composite `color` at `alpha` over `bg` — how Tailwind's `bg-x/10` resolves. */
function over(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number]
): [number, number, number] {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

const AA = 4.5;

describe('portal colour tokens meet WCAG AA', () => {
  const light = lightBlock();
  const rgb = (name: string) => hslToRgb(token(light, name));
  const surface = rgb('background');

  // Text on a 10%-alpha tint of itself: every status badge and error banner.
  it.each([
    ['success-on-tint', 'success'],
    ['warning-on-tint', 'warning'],
    ['destructive-on-tint', 'destructive'],
    ['primary-on-tint', 'primary'],
  ])('%s on bg-%s/10 clears AA', (fg, tint) => {
    const ratio = contrast(rgb(fg), over(rgb(tint), 0.1, surface));
    expect(ratio, `${fg} on ${tint}/10 measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });

  // Solid badges: foreground on the full-strength fill.
  it.each([
    ['warning-foreground', 'warning'],
    ['destructive-foreground', 'destructive'],
    ['success-foreground', 'success'],
    ['primary-foreground', 'primary'],
    ['muted-foreground', 'muted'],
  ])('%s on solid %s clears AA', (fg, bg) => {
    const ratio = contrast(rgb(fg), rgb(bg));
    expect(ratio, `${fg} on ${bg} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });

  // The `-on-tint` foregrounds double as text directly on the page surface
  // (DeviceList paints status labels on a white card).
  it.each(['success-on-tint', 'warning-on-tint', 'destructive-on-tint', 'primary-on-tint'])(
    '%s clears AA directly on the page background',
    (fg) => {
      const ratio = contrast(rgb(fg), surface);
      expect(ratio, `${fg} on background measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  );

  it('body text is comfortably above AA', () => {
    expect(contrast(rgb('foreground'), surface)).toBeGreaterThanOrEqual(7);
  });

  // Not a WCAG text rule, but the reason SignaturePanel carries a comment about
  // customers being unable to find the agreement checkbox: the hairline was
  // 1.23:1. 1.4.11 wants 3:1 for meaningful UI boundaries; this is a floor that
  // keeps it from silently drifting back toward invisible.
  it('the border hairline is visible against the page', () => {
    const ratio = contrast(rgb('border'), surface);
    expect(ratio, `border measured ${ratio.toFixed(2)}:1`).toBeGreaterThan(1.4);
  });
});

/**
 * Contract test for the curated chrome accents
 * (packages/shared/src/types/portalChromeAccent.ts). Read directly from the
 * shared spec, not from the generated CSS — chromeAccents.test.ts is what
 * proves the CSS matches the spec; this proves the spec itself is safe to
 * ship. A preset that fails AA here is not this file's to fix (the spec
 * belongs to @breeze/shared): leave the assertion red and report the failing
 * preset and its measured ratio.
 */
describe('portal chrome accent presets meet WCAG AA', () => {
  const lightSurface = hslToRgb(token(lightBlock(), 'background'));
  const darkSurface = hslToRgb(token(darkBlock(), 'background'));
  const parseTriplet = (triplet: string): [number, number, number] => {
    const [h, s, l] = triplet.split(/\s+/);
    return [parseFloat(h), parseFloat(s), parseFloat(l)];
  };

  const presetKeys = (Object.keys(PORTAL_CHROME_ACCENTS) as (keyof typeof PORTAL_CHROME_ACCENTS)[]).filter(
    (key) => key !== PORTAL_CHROME_ACCENT_DEFAULT
  );

  it('covers every non-default accent preset', () => {
    expect(presetKeys.length).toBe(7);
  });

  it.each(presetKeys)('%s: light primary-foreground on light primary clears AA', (key) => {
    const spec = PORTAL_CHROME_ACCENTS[key].light;
    const ratio = contrast(hslToRgb(parseTriplet(spec.primaryForeground)), hslToRgb(parseTriplet(spec.primary)));
    expect(ratio, `${key} light primaryForeground on primary measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA
    );
  });

  it.each(presetKeys)('%s: light primary-on-tint on the light background clears AA', (key) => {
    const spec = PORTAL_CHROME_ACCENTS[key].light;
    const ratio = contrast(hslToRgb(parseTriplet(spec.primaryOnTint)), lightSurface);
    expect(
      ratio,
      `${key} light primaryOnTint on background measured ${ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA);
  });

  it.each(presetKeys)('%s: dark primary-foreground on dark primary clears AA', (key) => {
    const spec = PORTAL_CHROME_ACCENTS[key].dark;
    const ratio = contrast(hslToRgb(parseTriplet(spec.primaryForeground)), hslToRgb(parseTriplet(spec.primary)));
    expect(ratio, `${key} dark primaryForeground on primary measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA
    );
  });

  it.each(presetKeys)('%s: dark primary-on-tint on the dark background clears AA', (key) => {
    const spec = PORTAL_CHROME_ACCENTS[key].dark;
    const ratio = contrast(hslToRgb(parseTriplet(spec.primaryOnTint)), darkSurface);
    expect(ratio, `${key} dark primaryOnTint on background measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA
    );
  });
});
