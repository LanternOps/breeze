import { describe, it, expect } from 'vitest';
import {
  INSTALL_SCRIPT_MAX_BYTES,
  validateSoftwareVersionInstallSpec,
} from './softwareVersionInstallSpec';

const base = {
  fileType: 'msi',
  supportedOs: ['windows'],
  silentInstallArgs: null,
  preInstallScript: null,
  postInstallScript: null,
};
const v = (o: Partial<Parameters<typeof validateSoftwareVersionInstallSpec>[0]>) =>
  validateSoftwareVersionInstallSpec({ ...base, ...o });

describe('validateSoftwareVersionInstallSpec', () => {
  it('exposes the 64 KiB script cap', () => {
    expect(INSTALL_SCRIPT_MAX_BYTES).toBe(65536);
  });

  it('accepts msi with args, one OS and no scripts', () => {
    expect(v({ silentInstallArgs: '/qn' })).toEqual([]);
  });

  it('zip without a post-install script', () => {
    expect(v({ fileType: 'zip' })).toEqual(['zip_requires_post_install_script']);
  });

  it('zip with a post-install script is fine', () => {
    expect(v({ fileType: 'zip', postInstallScript: 'echo hi' })).toEqual([]);
  });

  it('whitespace-only post script does not satisfy zip requirement', () => {
    expect(v({ fileType: 'zip', postInstallScript: '  \n\t ' })).toEqual([
      'zip_requires_post_install_script',
    ]);
  });

  it.each([[[]], [null], [['windows', 'macos']]])(
    'script with supportedOs=%j requires a single OS',
    (supportedOs) => {
      expect(v({ supportedOs, preInstallScript: 'echo hi' })).toEqual(['scripts_require_single_os']);
    },
  );

  it('whitespace-only script counts as absent for the single-OS rule', () => {
    expect(v({ supportedOs: null, preInstallScript: '   ', postInstallScript: '\n' })).toEqual([]);
  });

  it('accepts a script at exactly the byte cap', () => {
    expect(v({ preInstallScript: 'a'.repeat(65536) })).toEqual([]);
  });

  it('rejects a 65,537-byte script', () => {
    expect(v({ postInstallScript: 'a'.repeat(65537) })).toEqual(['script_too_large']);
  });

  it('measures bytes, not characters', () => {
    // 30,000 × 3-byte chars = 90,000 bytes, but only 30,000 characters.
    const s = '€'.repeat(30000);
    expect(s.length).toBeLessThan(65536);
    expect(v({ preInstallScript: s })).toEqual(['script_too_large']);
  });

  it.each(['pkg', 'dmg', 'deb', 'zip'])('args unsupported for %s', (fileType) => {
    const issues = v({ fileType, silentInstallArgs: '/S', postInstallScript: 'x' });
    expect(issues).toEqual(['args_unsupported_for_file_type']);
  });

  it('whitespace-only silentInstallArgs counts as absent', () => {
    expect(v({ fileType: 'pkg', silentInstallArgs: '   ' })).toEqual([]);
  });

  it('returns multiple issues in declaration order', () => {
    expect(
      v({ fileType: 'zip', silentInstallArgs: '/S', supportedOs: null, preInstallScript: 'x' }),
    ).toEqual([
      'zip_requires_post_install_script',
      'scripts_require_single_os',
      'args_unsupported_for_file_type',
    ]);
  });

  it('script_too_large sits between single-OS and args in order', () => {
    expect(
      v({
        fileType: 'pkg',
        silentInstallArgs: '/S',
        supportedOs: [],
        preInstallScript: 'a'.repeat(65537),
      }),
    ).toEqual(['scripts_require_single_os', 'script_too_large', 'args_unsupported_for_file_type']);
  });

  it('handles null/undefined fileType', () => {
    expect(v({ fileType: null, silentInstallArgs: '/S' })).toEqual([]);
    expect(v({ fileType: undefined })).toEqual([]);
  });
});
