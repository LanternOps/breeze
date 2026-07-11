import { describe, expect, it } from 'vitest';
import { getProviderBranding, isIntegrationProvider } from './providerBranding';

describe('providerBranding', () => {
  it('returns label, icon, accent, and blurb for huntress', () => {
    const b = getProviderBranding('huntress');
    expect(b.label).toBe('Huntress');
    // lucide icons are forwardRef components (objects in this version), not plain functions
    expect(b.icon).toBeDefined();
    expect(['function', 'object']).toContain(typeof b.icon);
    expect(b.accent).toMatch(/\S/);
    expect(b.blurb.length).toBeGreaterThan(0);
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
