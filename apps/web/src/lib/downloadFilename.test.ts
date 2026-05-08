import { describe, expect, it } from 'vitest';
import { fallbackInstallerFilename, filenameFromContentDisposition } from './downloadFilename';

describe('filenameFromContentDisposition', () => {
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
});

describe('fallbackInstallerFilename', () => {
  it('uses zip fallback for unsigned Windows bundles', () => {
    expect(fallbackInstallerFilename('windows')).toBe('breeze-agent-windows.zip');
  });

  it('uses macOS zip fallback', () => {
    expect(fallbackInstallerFilename('macos')).toBe('breeze-agent-macos.zip');
  });
});
