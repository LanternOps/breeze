/**
 * Helper branding colour readability (Phase 2, OD5). Pure WCAG 2.x math.
 *
 * One module owns the contrast maths and the threshold; the device side reuses
 * the same fixture vectors. A branded colour is accepted when it reaches the
 * threshold on at least one Helper theme canvas, so it is never unreadable in
 * every theme. Foreground colours are derived locally, never sent by the server.
 */

/** WCAG AA for body text. */
export const MIN_CONTRAST_RATIO = 4.5;

/** Helper canvases from apps/helper/src/styles/tokens.css (light and dark theme). */
export const HELPER_CANVAS_LIGHT = '#FBFAF9'; // hsl(40 20% 98%)
export const HELPER_CANVAS_DARK = '#191A1F'; // hsl(230 12% 11%)

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a strict #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isReadableBrandColor(hex: string): boolean {
  return (
    contrastRatio(hex, HELPER_CANVAS_LIGHT) >= MIN_CONTRAST_RATIO ||
    contrastRatio(hex, HELPER_CANVAS_DARK) >= MIN_CONTRAST_RATIO
  );
}
