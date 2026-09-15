/**
 * Safe injection of an org's saved portal `customCss` (portal_branding.custom_css,
 * apps/api/src/routes/portal/branding.ts) into a `<style>` element.
 *
 * Unlike the accent colour (lib/docAccent.ts), `customCss` is admin-authored,
 * arbitrary CSS — the whole point of the field is free-form rules, so it can't
 * be narrowed to a strict value grammar. The one thing that must never reach
 * the DOM verbatim is a literal `</style` sequence: the HTML tokenizer ends a
 * raw-text `<style>` element on that sequence regardless of what CSS the
 * browser has parsed so far, so an unescaped one would let saved "CSS" break
 * out of the style context and inject arbitrary markup into every visitor's
 * page. `script-src`/`style-src-attr`/`script-src-attr` are locked down
 * (lib/csp.ts), so a break-out can't run script, but it could still inject
 * visible HTML (a phishing overlay, a hidden field) — the escape below closes
 * that off without touching the CSS the admin actually wrote.
 */
export function escapeStyleElementContent(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/**
 * The stylesheet text to inject, or null when there is no saved CSS (callers
 * then render no `<style>` element at all).
 */
export function buildPortalCustomCss(customCss: string | null | undefined): string | null {
  if (!customCss) return null;
  const trimmed = customCss.trim();
  if (!trimmed) return null;
  return escapeStyleElementContent(trimmed);
}
