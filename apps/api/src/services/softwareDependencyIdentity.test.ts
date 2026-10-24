import { describe, expect, it } from 'vitest';
import {
  dependencyFingerprintError,
  fingerprintSoftwareInstallMethodDependency,
  fingerprintSoftwareVersionDependency,
  SOFTWARE_DEPENDENCY_CHANGED,
  SOFTWARE_DEPENDENCY_UNPINNED,
} from './softwareDependencyIdentity';

const catalog = { integrationProvider: null };
const version = {
  id: 'version-1',
  catalogId: 'catalog-1',
  downloadUrl: 'https://downloads.example.test/app.exe',
  s3Key: null,
  checksum: null,
  originalFileName: 'app.exe',
  fileType: 'exe',
  silentInstallArgs: '/S',
  version: '1.0.0',
  detectionRules: { all: [{ path: 'C:\\App', kind: 'file' }] },
};

describe('software dependency identity', () => {
  it.each([
    ['downloadUrl', 'https://other.example.test/app.exe'],
    ['s3Key', 'software/other.exe'],
    ['checksum', 'a'.repeat(64)],
    ['originalFileName', 'other.exe'],
    ['fileType', 'msi'],
    ['silentInstallArgs', '/quiet'],
    ['version', '2.0.0'],
    ['detectionRules', { all: [{ path: 'C:\\Other', kind: 'file' }] }],
  ] as const)('changes the version fingerprint when %s changes', (field, changed) => {
    expect(fingerprintSoftwareVersionDependency({ ...version, [field]: changed }, catalog))
      .not.toBe(fingerprintSoftwareVersionDependency(version, catalog));
  });

  // #7038: declared success exit codes decide whether an install counts as a
  // success, so editing them after approval must invalidate the pin…
  it('changes the version fingerprint when successExitCodes change', () => {
    const withCodes = { ...version, successExitCodes: [1000, 1101] };
    expect(fingerprintSoftwareVersionDependency(withCodes, catalog))
      .not.toBe(fingerprintSoftwareVersionDependency(version, catalog));
    expect(fingerprintSoftwareVersionDependency({ ...version, successExitCodes: [1000] }, catalog))
      .not.toBe(fingerprintSoftwareVersionDependency(withCodes, catalog));
  });

  // …but a version with none declared must keep the fingerprint it was pinned
  // with before the column existed, or every approved deployment in flight at
  // upgrade time would be refused as "dependency changed".
  it('keeps the pre-#7038 fingerprint when no success codes are declared', () => {
    const legacy = fingerprintSoftwareVersionDependency(version, catalog);
    expect(fingerprintSoftwareVersionDependency({ ...version, successExitCodes: [] }, catalog)).toBe(legacy);
    expect(fingerprintSoftwareVersionDependency({ ...version, successExitCodes: null }, catalog)).toBe(legacy);
  });

  it('canonicalizes detection-rule object key order', () => {
    const reordered = {
      ...version,
      detectionRules: { all: [{ kind: 'file', path: 'C:\\App' }] },
    };
    expect(fingerprintSoftwareVersionDependency(reordered, catalog))
      .toBe(fingerprintSoftwareVersionDependency(version, catalog));
  });

  it.each([
    ['platform', 'macos'],
    ['kind', 'homebrew_cask'],
    ['packageId', 'other.package'],
  ] as const)('changes the manager fingerprint when %s changes', (field, changed) => {
    const method = {
      id: 'method-1',
      catalogId: 'catalog-1',
      platform: 'windows',
      kind: 'winget',
      packageId: 'Approved.Package',
    };
    expect(fingerprintSoftwareInstallMethodDependency({ ...method, [field]: changed }, catalog))
      .not.toBe(fingerprintSoftwareInstallMethodDependency(method, catalog));
  });

  // #6958 (o): a deployment approved before install scripts existed must keep
  // dispatching, so a version with no ENABLED scripts fingerprints exactly as
  // it did before — pinned to the literal pre-#6958 value.
  it('keeps the pre-#6958 fingerprint when scripts are absent or not enabled', () => {
    const PRE_6958 = '1a27cbf00118d8abae243cbe998712889bed2b15975bb527620d4b28f307eca1';
    expect(fingerprintSoftwareVersionDependency(version, catalog)).toBe(PRE_6958);
    expect(fingerprintSoftwareVersionDependency({ ...version, installScriptsEnabled: false }, catalog)).toBe(PRE_6958);
    // Dormant stored scripts are never dispatched, so they do not enter the pin.
    expect(fingerprintSoftwareVersionDependency(
      { ...version, installScriptsEnabled: false, preInstallScript: 'a', postInstallScript: 'b' },
      catalog,
    )).toBe(PRE_6958);
  });

  it('changes the fingerprint when scripts are enabled, and when an enabled script changes', () => {
    const enabled = { ...version, installScriptsEnabled: true, preInstallScript: null, postInstallScript: 'Write-Output 1' };
    const base = fingerprintSoftwareVersionDependency(version, catalog);
    const withScript = fingerprintSoftwareVersionDependency(enabled, catalog);
    expect(withScript).not.toBe(base);
    expect(fingerprintSoftwareVersionDependency({ ...enabled, postInstallScript: 'Write-Output 2' }, catalog))
      .not.toBe(withScript);
    expect(fingerprintSoftwareVersionDependency({ ...enabled, preInstallScript: 'Write-Output 0' }, catalog))
      .not.toBe(withScript);
    // The one OS picks the script's interpreter, so it is pinned too.
    expect(fingerprintSoftwareVersionDependency({ ...enabled, supportedOs: ['windows'] }, catalog))
      .not.toBe(fingerprintSoftwareVersionDependency({ ...enabled, supportedOs: ['macos'] }, catalog));
  });

  it('fails legacy and changed dependencies closed while allowing an exact match', () => {
    const current = fingerprintSoftwareVersionDependency(version, catalog);
    expect(dependencyFingerprintError(null, current)).toBe(SOFTWARE_DEPENDENCY_UNPINNED);
    expect(dependencyFingerprintError('0'.repeat(64), current)).toBe(SOFTWARE_DEPENDENCY_CHANGED);
    expect(dependencyFingerprintError(current, current)).toBeNull();
  });
});
