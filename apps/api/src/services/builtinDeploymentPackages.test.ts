import { describe, it, expect } from 'vitest';
import { BUILTIN_PACKAGES, getBuiltinPackage } from './builtinDeploymentPackages';

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

  it('exposes both providers', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual(['huntress', 'sentinelone']);
  });
});
