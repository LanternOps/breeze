import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFallbackCspDirectives, resolvePortalCspHeader } from './csp';

/**
 * Regression coverage for the dead public-quote island (Accept/Decline fired zero
 * network calls). Root cause: `astro dev` emits no `security.csp` hash header, so
 * the strict `script-src 'self'` fallback blocked Astro's inline hydration script.
 */
describe('resolvePortalCspHeader', () => {
  const STRICT_FALLBACK = buildFallbackCspDirectives({ isDev: false });

  it('drops the CSP header in local dev so Vite/Astro inline hydration runs', () => {
    const decision = resolvePortalCspHeader({
      existingCsp: STRICT_FALLBACK,
      isDev: true,
      strictDev: false,
      fallback: STRICT_FALLBACK
    });
    expect(decision).toEqual({ action: 'delete' });
  });

  it('keeps CSP enforcement in dev when CSP_STRICT_DEV is set', () => {
    const decision = resolvePortalCspHeader({
      existingCsp: null,
      isDev: true,
      strictDev: true,
      fallback: STRICT_FALLBACK
    });
    expect(decision.action).toBe('set');
  });

  it('preserves Astro hash-based script-src in production (no widening to unsafe-inline)', () => {
    const astroCsp =
      "default-src 'self'; script-src 'self' 'sha256-abc123='; style-src 'self' 'sha256-def='";
    const decision = resolvePortalCspHeader({
      existingCsp: astroCsp,
      isDev: false,
      strictDev: false,
      fallback: STRICT_FALLBACK
    });
    expect(decision.action).toBe('set');
    if (decision.action !== 'set') throw new Error('expected set');
    // The inline-hydration hash survives → the island hydrates in prod.
    expect(decision.value).toContain("script-src 'self' 'sha256-abc123='");
    // Never loosened.
    expect(decision.value).not.toContain("'unsafe-inline'");
    // Granular attr lockdowns appended.
    expect(decision.value).toMatch(/script-src-attr 'none'/);
    expect(decision.value).toMatch(/style-src-attr 'none'/);
  });

  it('does not duplicate *-src-attr directives Astro already emitted', () => {
    const astroCsp =
      "default-src 'self'; script-src 'self' 'sha256-x='; script-src-attr 'none'; style-src-attr 'none'";
    const decision = resolvePortalCspHeader({
      existingCsp: astroCsp,
      isDev: false,
      strictDev: false,
      fallback: STRICT_FALLBACK
    });
    if (decision.action !== 'set') throw new Error('expected set');
    expect(decision.value.match(/script-src-attr 'none'/g)).toHaveLength(1);
    expect(decision.value.match(/style-src-attr 'none'/g)).toHaveLength(1);
  });

  it('applies the strict self-only fallback in prod when Astro emitted no CSP', () => {
    const decision = resolvePortalCspHeader({
      existingCsp: null,
      isDev: false,
      strictDev: false,
      fallback: STRICT_FALLBACK
    });
    expect(decision).toEqual({ action: 'set', value: STRICT_FALLBACK });
  });
});

describe('buildFallbackCspDirectives', () => {
  const saved = process.env.PUBLIC_API_URL;
  beforeEach(() => {
    delete process.env.PUBLIC_API_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = saved;
  });

  it('is strict self-only with no inline allowances', () => {
    const csp = buildFallbackCspDirectives({ isDev: false });
    expect(csp).toMatch(/script-src 'self'(?!.*'unsafe-inline')/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('widens connect-src to the configured API origin', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    const csp = buildFallbackCspDirectives({ isDev: false });
    expect(csp).toContain('https://api.example.com');
    expect(csp).toContain('wss://api.example.com');
  });
});
