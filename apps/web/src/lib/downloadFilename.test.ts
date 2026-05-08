import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackInstallerFilename, filenameFromContentDisposition } from './downloadFilename';

describe('filenameFromContentDisposition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads quoted filenames', () => {
    expect(filenameFromContentDisposition('attachment; filename="breeze-agent-windows.zip"')).toBe(
      'breeze-agent-windows.zip',
    );
  });

  it('prefers RFC 5987 filename star values', () => {
    expect(
      filenameFromContentDisposition(
        'attachment; filename="fallback.zip"; filename*=UTF-8\'\'breeze-agent%20windows.zip',
      ),
    ).toBe('breeze-agent windows.zip');
  });

  it('strips path separators from hostile filenames', () => {
    expect(filenameFromContentDisposition('attachment; filename="C:\\temp\\breeze-agent.msi"')).toBe(
      'breeze-agent.msi',
    );
  });

  it('handles RFC 5987 values with a language tag', () => {
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8'en'breeze-agent.zip"),
    ).toBe('breeze-agent.zip');
  });

  it('strips path separators from filename* values', () => {
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''..%2Fevil.exe"),
    ).toBe('evil.exe');
  });

  it('falls back to the un-decoded value when percent-decoding fails', () => {
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''breeze%ZZ.zip"),
    ).toBe('breeze%ZZ.zip');
  });

  it('returns null for a null header without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when the header has no filename param', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns null when sanitization yields an empty filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="/"')).toBeNull();
  });
});

describe('fallbackInstallerFilename', () => {
  it('uses zip fallback for unsigned Windows bundles', () => {
    expect(fallbackInstallerFilename('windows')).toBe('breeze-agent-windows.zip');
  });

  it('uses macOS zip fallback', () => {
    expect(fallbackInstallerFilename('macos')).toBe('breeze-agent-macos.zip');
  });
});
