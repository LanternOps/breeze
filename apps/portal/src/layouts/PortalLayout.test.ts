import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the shell's two navs. The rail and the phone menu are the
 * same navigation rendered twice, so the active entry has to be marked the same
 * way in both: the register mark plus `aria-current="page"` — never the filled
 * wash the world refuses (apps/portal/DESIGN.md, "Navigation").
 *
 * An .astro file has no unit-testable render here, so this reads the source.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('./PortalLayout.astro', import.meta.url)),
  'utf8',
);

function block(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('PortalLayout navigation', () => {
  const mobileNav = () => block('<nav class="absolute', '</nav>');

  it('marks the active phone-menu entry the way the rail marks its own', () => {
    const nav = mobileNav();
    expect(nav).toContain('aria-current=');
    // The register mark: a short green rule, not a filled pill.
    expect(nav).toContain('bg-primary');
    expect(nav).toContain('font-semibold text-foreground');
  });

  it('never fills the active phone-menu entry with an accent wash', () => {
    expect(mobileNav()).not.toContain('bg-accent font-semibold');
  });
});

describe('portal layout column alignment', () => {
  const src = readFileSync(new URL('./PortalLayout.astro', import.meta.url), 'utf8');

  it('caps the header to the same column as main so the actions sit above the content, not the viewport edge', () => {
    // The rule spans the whole content area; the row inside is capped to the column.
    const inner = src.match(/<header class="[^"]+">\s*<div class="([^"]+)"/)?.[1] ?? '';
    expect(inner).toContain('max-w-6xl');
  });

  it('left-aligns the content column against the sidebar instead of centering it in the leftover space', () => {
    const main = src.match(/<main id="portal-main" class="([^"]+)"/)?.[1] ?? '';
    expect(main).toContain('max-w-6xl');
    expect(main).not.toContain('mx-auto');
  });
});

describe('portal layout header account context', () => {
  const src = readFileSync(new URL('./PortalLayout.astro', import.meta.url), 'utf8');

  it('gives the desktop header a left side: who is signed in, for which account', () => {
    // Below lg the brand sits there; at lg+ the rail carries the brand and the
    // header used to be an 80px band with nothing but the actions at far right.
    expect(src).toContain('loadPortalProfile(Astro.request)');
    expect(src).toContain('data-testid="portal-account-context"');
    expect(src).toMatch(/profile\.organizationName/);
  });
});

describe('portal layout figure and ground', () => {
  const src = readFileSync(new URL('./PortalLayout.astro', import.meta.url), 'utf8');

  it('rules the header off from the page', () => {
    const header = src.match(/<header class="([^"]+)"/)?.[1] ?? '';
    expect(header).toMatch(/\bborder-b\b/);
  });

  it('lays the page on a linen sheet unless the page opts out (paper documents)', () => {
    expect(src).toContain('data-testid="portal-sheet"');
    expect(src).toMatch(/sheet\s*=\s*true/);
    const sheet = src.match(/data-testid="portal-sheet"[^>]*class:list=\{\[([^\]]+)\]/s)?.[1] ?? '';
    expect(sheet).toContain('bg-card');
    expect(sheet).toContain('border-border/70');
    expect(sheet).toContain('rounded-lg');
  });

  it('closes the page with a quiet foot: partner footer text, else the firm\'s name', () => {
    expect(src).toContain('data-testid="portal-foot"');
    expect(src).toMatch(/branding\.footerText/);
  });
});

describe('portal layout chrome accent', () => {
  const src = readFileSync(new URL('./PortalLayout.astro', import.meta.url), 'utf8');
  const authSrc = readFileSync(new URL('./AuthLayout.astro', import.meta.url), 'utf8');

  it('gates the data-accent attribute on isPortalChromeAccent, not a raw pass-through', () => {
    // A raw `branding.chromeAccent` on <html> would let an unrecognized or
    // stale stored value reach the DOM as an attribute with no matching CSS
    // block — silently inert, but also a tell that validation was skipped.
    expect(src).toContain("import { isPortalChromeAccent, PORTAL_CHROME_ACCENT_DEFAULT } from '@breeze/shared'");
    expect(src).toMatch(/isPortalChromeAccent\(branding\.chromeAccent\)/);
    expect(src).toContain('<html lang="en" data-accent={chromeAccent}>');
  });

  it('omits the attribute for the default key so the base (spruce) tokens apply', () => {
    expect(src).toMatch(/branding\.chromeAccent\s*!==\s*PORTAL_CHROME_ACCENT_DEFAULT/);
  });

  it('the sign-in page (AuthLayout) wires the same accent — branding loads before login too', () => {
    expect(authSrc).toContain("import { isPortalChromeAccent, PORTAL_CHROME_ACCENT_DEFAULT } from '@breeze/shared'");
    expect(authSrc).toMatch(/isPortalChromeAccent\(branding\.chromeAccent\)/);
    expect(authSrc).toContain('<html lang="en" data-accent={chromeAccent}>');
  });
});

describe('PortalLayout custom CSS (#5940)', () => {
  it('builds the saved customCss via the shared sanitizer', () => {
    expect(SOURCE).toContain("import { buildPortalCustomCss } from '../lib/customCss'");
    expect(SOURCE).toContain('buildPortalCustomCss(branding.customCss)');
  });

  it('renders it as its own nonced <style> element, after the accent style', () => {
    const accentIdx = SOURCE.indexOf('{accentCss && <style nonce={cspNonce} set:html={accentCss}></style>}');
    const customCssIdx = SOURCE.indexOf(
      '{customCssContent && <style nonce={cspNonce} set:html={customCssContent}></style>}'
    );
    expect(accentIdx).toBeGreaterThan(-1);
    expect(customCssIdx).toBeGreaterThan(accentIdx);
  });

  it('gives the header the class the branding docs document as the customCss target', () => {
    expect(SOURCE).toMatch(/<header class="portal-header /);
  });
});
