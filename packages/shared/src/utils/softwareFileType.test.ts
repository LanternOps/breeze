import { describe, it, expect } from 'vitest';
import {
  SOFTWARE_FILE_TYPES,
  isSoftwareFileType,
  deriveSoftwareFileTypeFromUrl,
  defaultSilentArgsForFileType,
} from './softwareFileType';

describe('deriveSoftwareFileTypeFromUrl', () => {
  it('derives every supported type from a plain URL', () => {
    for (const type of SOFTWARE_FILE_TYPES) {
      expect(deriveSoftwareFileTypeFromUrl(`https://vendor.example/pkg.${type}`)).toBe(type);
    }
  });

  it('ignores the query string and fragment', () => {
    // The regression: a presigned vendor URL puts a signature after the
    // extension, and naive `endsWith('.msi')` misses it.
    expect(
      deriveSoftwareFileTypeFromUrl('https://cdn.example/agent.msi?X-Amz-Signature=abc123&e=1'),
    ).toBe('msi');
    expect(deriveSoftwareFileTypeFromUrl('https://cdn.example/agent.msi#sha256')).toBe('msi');
  });

  it('is case-insensitive on the extension', () => {
    expect(deriveSoftwareFileTypeFromUrl('https://cdn.example/Agent.MSI')).toBe('msi');
  });

  it('survives unresolved deploy-time tokens that make the URL unparseable', () => {
    // `new URL()` would percent-encode or reject these; the extension must still
    // be recoverable because token substitution happens later, on dispatch.
    expect(
      deriveSoftwareFileTypeFromUrl('https://cdn.example/{{org.name}}/agent.msi'),
    ).toBe('msi');
    expect(
      deriveSoftwareFileTypeFromUrl('https://cdn.example/agent.msi?key={{var.site_key}}'),
    ).toBe('msi');
  });

  it('returns null rather than guessing when there is no usable extension', () => {
    // Guessing 'exe' here is exactly the bug this module exists to fix.
    expect(deriveSoftwareFileTypeFromUrl('https://vendor.example/download.php?product=foo')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl('https://vendor.example/latest')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl('https://vendor.example/pkg.zip')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl('https://vendor.example/')).toBeNull();
  });

  it('does not mistake a dotted host or path segment for an extension', () => {
    expect(deriveSoftwareFileTypeFromUrl('https://downloads.vendor.example')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl('https://vendor.example/v1.2.3/installer')).toBeNull();
  });

  it('handles empty and non-string input', () => {
    expect(deriveSoftwareFileTypeFromUrl('')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl('   ')).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl(null)).toBeNull();
    expect(deriveSoftwareFileTypeFromUrl(undefined)).toBeNull();
  });
});

describe('isSoftwareFileType', () => {
  it('accepts supported types and rejects everything else', () => {
    expect(isSoftwareFileType('msi')).toBe(true);
    expect(isSoftwareFileType('zip')).toBe(false);
    expect(isSoftwareFileType('MSI')).toBe(false); // callers lowercase first
    expect(isSoftwareFileType(null)).toBe(false);
  });
});

describe('defaultSilentArgsForFileType', () => {
  it('returns the msiexec pair for msi', () => {
    expect(defaultSilentArgsForFileType('msi')).toEqual({
      install: 'msiexec /i "{file}" /qn /norestart',
      uninstall: 'msiexec /x "{file}" /qn /norestart',
    });
  });

  it('quotes {file} so a temp path containing spaces stays one argument', () => {
    // The agent substitutes {file} BEFORE tokenizing on spaces, so an unquoted
    // token would split a spaced path across several argv entries.
    expect(defaultSilentArgsForFileType('msi')!.install).toContain('"{file}"');
  });

  it('has no default for types whose silent switch is vendor-specific', () => {
    expect(defaultSilentArgsForFileType('exe')).toBeNull();
    expect(defaultSilentArgsForFileType('deb')).toBeNull();
    expect(defaultSilentArgsForFileType(null)).toBeNull();
    expect(defaultSilentArgsForFileType(undefined)).toBeNull();
  });
});
