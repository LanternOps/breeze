/**
 * Partner brand-accent delivery for customer-facing documents.
 *
 * The accent is a RUNTIME, per-partner value, so it cannot be an Astro
 * build-time style hash. It used to ride on a React `style` attribute in
 * documentShell, which the portal's own production CSP kills: `csp.ts` appends
 * `style-src-attr 'none'` to every prod response. Local dev deletes the CSP
 * header entirely, so the accent looked perfect on every developer's machine
 * and rendered as an unstyled grey rule in production, along with the document
 * eyebrow and the hero currency figures.
 *
 * The fix keeps `style-src-attr 'none'` (inline style attributes stay banned)
 * and instead delivers the accent through ONE nonced `<style>` ELEMENT emitted
 * by the layout, which is where `Astro.locals.cspNonce` lives. Documents then
 * consume `var(--doc-accent)` through the `.doc-accent-*` classes in
 * globals.css, which are ordinary stylesheet rules and never blocked.
 */

/**
 * Colours we are willing to interpolate into a stylesheet.
 *
 * `primaryColor` is partner-supplied data reaching a `<style>` element, so it is
 * an injection sink: a value like `red}body{display:none` would otherwise escape
 * the declaration and restyle the page. Allow only literal colour syntax, and
 * notably no `(` beyond the known functional forms, no `;`, no `}`, no `/*`.
 */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%\s/+-]*\)$/i;
const KEYWORD = /^[a-z]{3,20}$/i;

/**
 * Narrow a partner-supplied colour to something safe to place in a declaration.
 * Returns null when the value is absent or not recognisably a colour, in which
 * case callers omit the property entirely and `var(--doc-accent, …)`'s fallback
 * to the app primary takes over.
 */
export function sanitizeAccentColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (HEX.test(trimmed) || FUNCTIONAL.test(trimmed) || KEYWORD.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * The stylesheet text setting `--doc-accent`, or null when there is no usable
 * accent (callers then render no `<style>` element at all).
 */
export function buildDocAccentCss(value: string | null | undefined): string | null {
  const safe = sanitizeAccentColor(value);
  return safe ? `:root{--doc-accent:${safe}}` : null;
}
