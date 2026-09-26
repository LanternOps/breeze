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

  it('fails legacy and changed dependencies closed while allowing an exact match', () => {
    const current = fingerprintSoftwareVersionDependency(version, catalog);
    expect(dependencyFingerprintError(null, current)).toBe(SOFTWARE_DEPENDENCY_UNPINNED);
    expect(dependencyFingerprintError('0'.repeat(64), current)).toBe(SOFTWARE_DEPENDENCY_CHANGED);
    expect(dependencyFingerprintError(current, current)).toBeNull();
  });
});
