import { describe, it, expect } from 'vitest';
import { BUILTIN_PACKAGES, getBuiltinPackage } from './builtinDeploymentPackages';

// Note: the DB-backed ensureBuiltinPackage tests live in
// src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
// (real partner fixture, runs as breeze_app). This file stays pure-unit.

describe('builtin deployment packages', () => {
  it('defines a Windows-only Huntress package with derivable URL + keys', () => {
    const pkg = getBuiltinPackage('huntress');
    expect(pkg.vendor).toBe('Huntress');
    expect(pkg.fileType).toBe('exe');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(false);
    expect(pkg.downloadUrlTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_org_key}');
  });

  it('defines a SentinelOne package that needs a binary upload and a site token', () => {
    const pkg = getBuiltinPackage('sentinelone');
    expect(pkg.vendor).toBe('SentinelOne');
    expect(pkg.fileType).toBe('msi');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(true);
    expect(pkg.silentInstallArgsTemplate).toContain('{s1_site_token}');
  });

  it('SentinelOne install args must carry the single-brace site-token placeholder', async () => {
    const { installArgPlaceholders, installArgsCarryPlaceholders } = await import('./builtinDeploymentPackages');
    expect(installArgPlaceholders('sentinelone')).toEqual(['{s1_site_token}']);
    expect(installArgPlaceholders('huntress')).toEqual(['{huntress_acct_key}', '{huntress_org_key}']);
    expect(installArgsCarryPlaceholders('sentinelone', 'SITE_TOKEN={s1_site_token} /q /NORESTART')).toBe(true);
    expect(installArgsCarryPlaceholders('sentinelone', 'msiexec /i "{file}" /qn /norestart')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', 'SITE_TOKEN={{s1_site_token}}')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', '')).toBe(false);
    expect(installArgsCarryPlaceholders('sentinelone', null)).toBe(false);
  });

  it('exposes both providers', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual(['huntress', 'sentinelone']);
  });
});
