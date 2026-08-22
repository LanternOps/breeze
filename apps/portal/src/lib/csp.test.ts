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

describe('resolvePortalCspHeader — runtime style nonce', () => {
  const base = { existingCsp: "default-src 'self'; style-src 'self'", isDev: false, strictDev: false, fallback: 'x' };

  it('keeps banning inline style ATTRIBUTES even when a nonce is present', () => {
    // The nonce exists for one <style> ELEMENT (the partner brand accent). It
    // must never be read as licence to reopen style attributes, which is what
    // silently broke the accent in production in the first place.
    const decision = resolvePortalCspHeader({ ...base, styleNonce: 'abc123' });
    expect(decision).toMatchObject({ action: 'set' });
    const value = (decision as { value: string }).value;
    expect(value).toContain("style-src-attr 'none'");
    expect(value).not.toContain("'unsafe-inline'");
  });

  it('allows the nonced style element', () => {
    const decision = resolvePortalCspHeader({ ...base, styleNonce: 'abc123' });
    expect((decision as { value: string }).value).toContain("style-src-elem 'self' 'nonce-abc123'");
  });

  // Regression: style-src-elem REPLACES style-src for <style> elements rather
  // than extending it, so a bare `style-src-elem 'self' 'nonce-…'` silently
  // dropped the per-page sha256 hashes Astro emits for its own inline styles.
  // The browser then refused them and the ClientRouter's styles vanished —
  // invisible in dev, which drops CSP entirely, and invisible to a unit test
  // that only asserted the nonce was present.
  it('carries the existing style-src hashes into style-src-elem', () => {
    const decision = resolvePortalCspHeader({
      ...base,
      existingCsp: "default-src 'self'; style-src 'self' 'sha256-AAA=' 'sha256-BBB='",
      styleNonce: 'abc123',
    });
    const elem = /style-src-elem ([^;]+)/.exec((decision as { value: string }).value)?.[1];
    expect(elem).toContain("'sha256-AAA='");
    expect(elem).toContain("'sha256-BBB='");
    expect(elem).toContain("'nonce-abc123'");
  });

  it('never emits a style-src-elem narrower than the style-src it shadows', () => {
    const styleSrc = "'self' 'sha256-AAA=' https://cdn.example.test";
    const decision = resolvePortalCspHeader({
      ...base,
      existingCsp: `default-src 'self'; style-src ${styleSrc}`,
      styleNonce: 'abc123',
    });
    const elem = /style-src-elem ([^;]+)/.exec((decision as { value: string }).value)?.[1] ?? '';
    for (const source of styleSrc.split(/\s+/)) {
      expect(elem, `style-src-elem dropped ${source}`).toContain(source);
    }
  });

  it('falls back to self when the policy declares no style-src at all', () => {
    const decision = resolvePortalCspHeader({
      ...base,
      existingCsp: "default-src 'self'",
      styleNonce: 'abc123',
    });
    expect((decision as { value: string }).value).toContain("style-src-elem 'self' 'nonce-abc123'");
  });

  it('adds no style-src-elem when no nonce was generated', () => {
    const decision = resolvePortalCspHeader(base);
    expect((decision as { value: string }).value).not.toContain('style-src-elem');
  });

  it('does not clobber a style-src-elem the upstream policy already set', () => {
    const decision = resolvePortalCspHeader({
      ...base,
      existingCsp: "default-src 'self'; style-src-elem 'self' 'sha256-abc'",
      styleNonce: 'abc123',
    });
    const value = (decision as { value: string }).value;
    expect(value.match(/style-src-elem/g)).toHaveLength(1);
    expect(value).toContain("'sha256-abc'");
  });

  it('still drops the header entirely in plain dev', () => {
    expect(resolvePortalCspHeader({ ...base, isDev: true, styleNonce: 'abc123' })).toEqual({ action: 'delete' });
  });
});
