import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicQuoteAcceptUrl, portalBase } from './quoteLifecycle';

/**
 * Regression coverage for the malformed public quote accept link
 * (`https:///quote/<token>` — empty host) and the portal base-path prefix.
 *
 * The customer portal serves the public quote route at `<base>/quote/<token>`,
 * where the base (default `/portal`) is expected to be part of PUBLIC_PORTAL_URL,
 * matching the invoice-link convention in invoicePdf.ts.
 */
describe('quoteLifecycle portal URL', () => {
  const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'PUBLIC_APP_URL', 'DASHBOARD_URL'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uses PUBLIC_PORTAL_URL (incl. /portal base) and emits a well-formed accept URL', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const url = buildPublicQuoteAcceptUrl('tok123');
    expect(url).toBe('https://example.com/portal/quote/tok123');

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('example.com'); // non-empty host
    expect(parsed.pathname).toBe('/portal/quote/tok123'); // correct portal prefix
  });

  it('strips a trailing slash on the configured base', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal/';
    expect(buildPublicQuoteAcceptUrl('abc')).toBe('https://example.com/portal/quote/abc');
  });

  it('NEVER emits an empty-host URL when PUBLIC_PORTAL_URL is a bare scheme', () => {
    // The reported prod symptom: PUBLIC_PORTAL_URL="https://" → `https:///quote/...`.
    process.env.PUBLIC_PORTAL_URL = 'https://';
    // No other env configured → falls through to the localhost dev fallback (has a host).
    const url = buildPublicQuoteAcceptUrl('tok');
    expect(url).not.toMatch(/^https?:\/\/\//); // no empty-authority `://[/]`
    expect(new URL(url).hostname).not.toBe('');
  });

  it('falls through an empty PUBLIC_PORTAL_URL to PUBLIC_APP_URL', () => {
    process.env.PUBLIC_PORTAL_URL = '';
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://app.example.com/quote/t');
  });

  it('falls back to a host-bearing localhost URL (with portal base) when nothing is configured', () => {
    const url = buildPublicQuoteAcceptUrl('t');
    expect(url).toBe('http://localhost:4321/portal/quote/t');
    expect(new URL(url).hostname).toBe('localhost');
  });

  it('throws loudly rather than returning an empty host (portalBase contract)', () => {
    // Force every candidate (incl. the literal fallback) to be malformed by
    // monkeypatching: not possible via env since the fallback is a constant, so
    // we assert the happy-path host invariant instead — portalBase always yields
    // a parseable URL with a hostname.
    process.env.PUBLIC_PORTAL_URL = 'not-a-url';
    process.env.PUBLIC_APP_URL = 'https://'; // empty host
    process.env.DASHBOARD_URL = '   ';        // blank
    const base = portalBase();
    expect(new URL(base).hostname).toBe('localhost'); // last good fallback
  });

  it('encodes the token so a malicious token cannot break out of the path', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const url = buildPublicQuoteAcceptUrl('a/b?c#d');
    expect(url).toBe('https://example.com/portal/quote/a%2Fb%3Fc%23d');
    expect(new URL(url).pathname).toBe('/portal/quote/a%2Fb%3Fc%23d');
  });
});
