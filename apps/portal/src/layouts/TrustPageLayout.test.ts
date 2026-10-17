import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = readFileSync(fileURLToPath(new URL('./TrustPageLayout.astro', import.meta.url)), 'utf8');
describe('TrustPageLayout', () => {
  it('parameterizes robots, canonical and Open Graph; never hardcodes noindex', () => {
    expect(src).toMatch(/name="robots" content=\{robots\}/);
    expect(src).toMatch(/rel="canonical"/);
    expect(src).toMatch(/property="og:title"/);
    expect(src).toMatch(/property="og:description"/);
    expect(src).not.toMatch(/content="noindex"/);
  });
  it('emits the accent only through the nonced style element and uses withBase for local hrefs', () => {
    expect(src).toMatch(/<style nonce=\{cspNonce\} set:html=\{accentCss\}>/);
    expect(src).not.toMatch(/style="/);
    expect(src).toMatch(/withBase\('\/favicon\.svg'\)/);
  });
  it('renders <link rel="alternate" type="application/jwt"> only when alternateJwtHref is set', () => {
    expect(src).toMatch(/alternateJwtHref\?: string \| null;/);
    expect(src).toMatch(/\{alternateJwtHref && <link rel="alternate" type="application\/jwt" href=\{alternateJwtHref\} \/>\}/);
    // Exactly one alternate link, and only inside that guard.
    expect(src.match(/rel="alternate"/g)).toHaveLength(1);
  });
  it('derives the canonical origin from the forwarded headers, never Astro.url.origin', () => {
    expect(src).toMatch(/publicOriginFor\(Astro\.request, Astro\.url\)/);
    expect(src).not.toMatch(/Astro\.url\.origin/);
  });
});
