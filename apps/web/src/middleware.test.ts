import { describe, expect, it } from 'vitest';

import { buildFallbackCspDirectives, relaxExistingCsp } from './middleware';

// #1023: Monaco is now self-hosted from /monaco/vs, so cdn.jsdelivr.net — a
// broad package-CDN gadget host — must no longer appear in any CSP directive.
// The directives Monaco/xterm actually need (style-src-elem 'unsafe-inline',
// worker-src blob:) must survive, just without the CDN token.
describe('CSP directives drop the jsdelivr CDN (#1023)', () => {
  const buildOptions = [
    { allowInlineScript: false, allowInlineStyle: false, isDev: false },
    { allowInlineScript: true, allowInlineStyle: true, isDev: false },
  ] as const;

  it.each(buildOptions)(
    'buildFallbackCspDirectives never emits cdn.jsdelivr.net (%o)',
    (options) => {
      const csp = buildFallbackCspDirectives(options);

      expect(csp).not.toContain('jsdelivr');
      // The Monaco/xterm runtime requirements still have to be present.
      expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toMatch(/script-src 'self'/);
    }
  );

  it('relaxExistingCsp does not reintroduce the CDN when patching an Astro CSP', () => {
    const astroCsp =
      "default-src 'self'; script-src 'self' 'sha256-abc'; style-src 'self' 'sha256-def'";

    const patched = relaxExistingCsp(astroCsp, {
      allowInlineScript: false,
      allowInlineStyle: false,
    });

    expect(patched).not.toContain('jsdelivr');
    expect(patched).toContain("style-src-elem 'self' 'unsafe-inline'");
  });
});
