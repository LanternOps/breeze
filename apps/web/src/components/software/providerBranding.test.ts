import { describe, expect, it } from 'vitest';
import { getProviderBranding, isIntegrationProvider } from './providerBranding';

describe('providerBranding', () => {
  it('returns label, blurb and the Integrations deep link for huntress', () => {
    const b = getProviderBranding('huntress');
    expect(b.label).toBe('Huntress');
    expect(b.blurb.length).toBeGreaterThan(0);
    expect(b.setupHref).toBe('/integrations#huntress');
  });

  it('carries no per-vendor colour or icon: every built-in shares one presentation', () => {
    expect(getProviderBranding('huntress')).not.toHaveProperty('accent');
    expect(getProviderBranding('sentinelone')).not.toHaveProperty('icon');
  });

  it('returns branding for sentinelone', () => {
    expect(getProviderBranding('sentinelone').label).toBe('SentinelOne');
  });

  it('type-guards provider strings', () => {
    expect(isIntegrationProvider('huntress')).toBe(true);
    expect(isIntegrationProvider('nope')).toBe(false);
    expect(isIntegrationProvider(undefined)).toBe(false);
  });
});
