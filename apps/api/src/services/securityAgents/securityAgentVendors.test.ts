import { describe, it, expect } from 'vitest';
import { SECURITY_AGENT_VENDOR_KEYS } from '@breeze/shared/validators';
import { getVendor, listVendors } from './securityAgentVendors';

describe('security agent vendor registry (#6960)', () => {
  it('has exactly the four vendor keys the inline-settings schema accepts', () => {
    expect(listVendors().map((v) => v.key).sort()).toEqual([...SECURITY_AGENT_VENDOR_KEYS].sort());
  });

  it('only Huntress is enableable (W02); SentinelOne and the DNS vendors wait for their waves', () => {
    expect(listVendors().filter((vendor) => vendor.enableable).map((vendor) => vendor.key)).toEqual(['huntress']);
  });

  it('Huntress: Windows supported, macOS needs MDM approval, Linux unsupported, keys from the EDR mapping', () => {
    const huntress = getVendor('huntress');
    expect(huntress.platforms).toEqual({ windows: 'supported', macos: 'requires_mdm', linux: 'unsupported' });
    expect(huntress.orgSource).toBe('edr_mapping');
  });

  it('DNS vendors take their enrollment value from a tenant variable', () => {
    for (const key of ['controld', 'nextdns'] as const) {
      const v = getVendor(key);
      expect(v.orgSource).toBe('tenant_var');
      expect(v.requiredVars?.length).toBeGreaterThan(0);
    }
  });

  it('every vendor names a catalog reference and a label', () => {
    for (const v of listVendors()) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.catalogRef.length).toBeGreaterThan(0);
    }
  });

  it('each record carries the key it is registered under', () => {
    for (const key of SECURITY_AGENT_VENDOR_KEYS) expect(getVendor(key).key).toBe(key);
  });

  it('getVendor throws on an unknown key rather than returning undefined', () => {
    expect(() => getVendor('acme' as never)).toThrow();
  });

  it('the registry is frozen', () => {
    expect(Object.isFrozen(listVendors())).toBe(true);
    expect(Object.isFrozen(getVendor('huntress'))).toBe(true);
  });
});

describe('vendorForIntegrationProvider (#6960 W02)', () => {
  it('maps built-in catalog providers back to their vendor', async () => {
    const { vendorForIntegrationProvider } = await import('./securityAgentVendors');
    expect(vendorForIntegrationProvider('huntress')).toBe('huntress');
    expect(vendorForIntegrationProvider('sentinelone')).toBe('sentinelone');
    expect(vendorForIntegrationProvider('controld')).toBeNull();
    expect(vendorForIntegrationProvider(null)).toBeNull();
  });
});
