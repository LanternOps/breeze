import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * An .astro file has no unit-testable render here, so this reads the source
 * (same approach as PortalLayout.test.ts).
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('./AuthLayout.astro', import.meta.url)),
  'utf8',
);

describe('AuthLayout custom CSS (#5940)', () => {
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
});
