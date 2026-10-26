import { describe, it, expect } from 'vitest';
import { SECURITY_AGENT_VENDOR_KEYS } from '@breeze/shared/validators';
import { getVendor, listVendors, vendorForCatalogPackage } from './securityAgentVendors';
import {
  BUILTIN_TENANT_VAR_PACKAGES,
  builtinPackageKeysForVendor,
  serviceRunningNamesFor,
  type BuiltinPackageKey,
} from '../builtinDeploymentPackages';

describe('security agent vendor registry (#6960)', () => {
  it('has exactly the four vendor keys the inline-settings schema accepts', () => {
    expect(listVendors().map((v) => v.key).sort()).toEqual([...SECURITY_AGENT_VENDOR_KEYS].sort());
  });

  it('Huntress (W02) and SentinelOne (W04) are enableable; the DNS vendors stay off until lab gates L1–L5 (#6958) are recorded', () => {
    // W05 shipped code-only (orchestrator mode (c), 2026-10-25): every DNS
    // seam is wired, and flipping these two lines is the follow-up PR.
    expect(listVendors().filter((vendor) => vendor.enableable).map((vendor) => vendor.key)).toEqual(['huntress', 'sentinelone']);
    expect(getVendor('controld').enableable).toBe(false);
    expect(getVendor('nextdns').enableable).toBe(false);
  });

  it('SentinelOne: Windows only, keys from the EDR mapping, built-in package provider', () => {
    const s1 = getVendor('sentinelone');
    expect(s1.platforms).toEqual({ windows: 'supported', macos: 'unsupported', linux: 'unsupported' });
    expect(s1.orgSource).toBe('edr_mapping');
    expect(s1.integrationProvider).toBe('sentinelone');
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

const PRESENCE_FIELD_FOR_OS = { windows: 'windowsService', macos: 'macLaunchdLabel' } as const;

describe('DNS vendor presence — the #6958 D5 contract (#6960 W05)', () => {
  it('every OS a DNS vendor supports has a built-in package whose service_running names equal the registry presence', () => {
    for (const vendorKey of ['controld', 'nextdns'] as const) {
      const vendor = getVendor(vendorKey);
      const keys = builtinPackageKeysForVendor(vendorKey);
      for (const [os, support] of Object.entries(vendor.platforms)) {
        if (support !== 'supported') continue;
        const key = keys[os as 'windows' | 'macos'];
        expect(key, `${vendorKey} ${os}`).toBeDefined();
        const field = PRESENCE_FIELD_FOR_OS[os as 'windows' | 'macos'];
        expect([vendor.presence[field]], `${key}`).toEqual(serviceRunningNamesFor(key!));
      }
    }
  });

  it('pins the D5 table: controld_windows ↔ ctrld, nextdns_windows ↔ nextdns, controld_macos ↔ ctrld (launchd label)', () => {
    expect(getVendor('controld').presence.windowsService).toBe('ctrld');
    expect(serviceRunningNamesFor('controld_windows')).toEqual(['ctrld']);
    expect(getVendor('nextdns').presence.windowsService).toBe('nextdns');
    expect(serviceRunningNamesFor('nextdns_windows')).toEqual(['nextdns']);
    // The macOS label is D's to ship; the registry does not describe it while
    // macOS is unsupported (Gate B decision 1: hidden until lab gate L2).
    expect(serviceRunningNamesFor('controld_macos')).toEqual(['ctrld']);
  });

  it('Control D macOS stays unsupported while its built-in package is hidden (they flip together after lab gate L2)', () => {
    expect(BUILTIN_TENANT_VAR_PACKAGES.controld_macos.hidden).toBe(true);
    expect(getVendor('controld').platforms.macos).toBe('unsupported');
    expect(getVendor('controld').presence.macLaunchdLabel).toBeUndefined();
  });

  it('DNS vendors are Windows only in v1 (NextDNS macOS needs tar.gz + arch selection; no Linux clients)', () => {
    for (const key of ['controld', 'nextdns'] as const) {
      expect(getVendor(key).platforms).toEqual({ windows: 'supported', macos: 'unsupported', linux: 'unsupported' });
    }
  });

  it('required variables equal the pinned packages\' requiredVars, per OS', () => {
    for (const vendorKey of ['controld', 'nextdns'] as const) {
      for (const key of Object.values(builtinPackageKeysForVendor(vendorKey))) {
        expect([...(getVendor(vendorKey).requiredVars ?? [])]).toEqual([...BUILTIN_TENANT_VAR_PACKAGES[key!].requiredVars]);
      }
    }
  });

  it('DNS vendors name no inventory glob: each per-OS rule is named after its pinned package (no ARP entry matches it)', () => {
    expect(getVendor('controld').detectionRuleName).toBeNull();
    expect(getVendor('nextdns').detectionRuleName).toBeNull();
    expect(getVendor('huntress').detectionRuleName).toBe('Huntress Agent*');
    expect(getVendor('sentinelone').detectionRuleName).toBe('Sentinel Agent*');
  });

  it('EDR vendors carry no presence descriptor yet (needs #10038 backfill, verified service names and an agent lab)', () => {
    expect(getVendor('huntress').presence).toEqual({});
    expect(getVendor('sentinelone').presence).toEqual({});
  });
});

describe('vendorForCatalogPackage (#6960 W05)', () => {
  it('maps an EDR integration package to its vendor with no platform pin', () => {
    expect(vendorForCatalogPackage({ integrationProvider: 'huntress', builtinPackageKey: null })).toEqual({ vendor: 'huntress', platform: null });
    expect(vendorForCatalogPackage({ integrationProvider: 'sentinelone', builtinPackageKey: null })).toEqual({ vendor: 'sentinelone', platform: null });
  });

  it('maps every pinned built-in key to its vendor and OS, matching BUILTIN_TENANT_VAR_PACKAGES', () => {
    for (const key of Object.keys(BUILTIN_TENANT_VAR_PACKAGES) as BuiltinPackageKey[]) {
      const def = BUILTIN_TENANT_VAR_PACKAGES[key];
      expect(vendorForCatalogPackage({ integrationProvider: null, builtinPackageKey: key })).toEqual({ vendor: def.vendorKey, platform: def.os });
    }
  });

  it('a row that is neither is not a vendor package (fail closed)', () => {
    expect(vendorForCatalogPackage({ integrationProvider: null, builtinPackageKey: null })).toBeNull();
    expect(vendorForCatalogPackage({ integrationProvider: null, builtinPackageKey: 'acme_windows' })).toBeNull();
    expect(vendorForCatalogPackage({ integrationProvider: 'acme', builtinPackageKey: null })).toBeNull();
  });
});
