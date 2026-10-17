import { describe, expect, it } from 'vitest';
import { formatOsLabel } from './formatOsLabel';

describe('formatOsLabel (#9026)', () => {
  it('turns a bare Windows dotted version into "Windows 11 (build N)"', () => {
    expect(formatOsLabel('windows', '11.0.22631')).toBe('Windows 11 (build 22631)');
    expect(formatOsLabel('windows', '10.0.22631.4317')).toBe('Windows 11 (build 22631)');
    expect(formatOsLabel('windows', '10.0.19045')).toBe('Windows 10 (build 19045)');
  });

  it('keeps the edition the agent reports and appends the build from osBuild', () => {
    expect(formatOsLabel('windows', 'Microsoft Windows 11 Pro', '22631.4317')).toBe(
      'Windows 11 Pro (build 22631)',
    );
    expect(formatOsLabel('windows', 'Microsoft Windows Server 2022 Datacenter', '20348.2966')).toBe(
      'Windows Server 2022 Datacenter (build 20348)',
    );
    expect(formatOsLabel('windows', 'Microsoft Windows 11 Pro')).toBe('Windows 11 Pro');
  });

  it('labels macOS versions, including the darwin-prefixed agent form', () => {
    expect(formatOsLabel('macos', '15.1')).toBe('macOS 15.1');
    expect(formatOsLabel('macos', 'darwin 15.7.7')).toBe('macOS 15.7.7');
  });

  it('labels Linux as distro + version', () => {
    expect(formatOsLabel('linux', 'debian 12.12')).toBe('Debian 12.12');
    expect(formatOsLabel('linux', 'ubuntu 24.04')).toBe('Ubuntu 24.04');
    expect(formatOsLabel('linux', '')).toBe('Linux');
  });

  it('falls back to the raw string for an unknown OS type', () => {
    expect(formatOsLabel('freebsd', '14.1-RELEASE')).toBe('14.1-RELEASE');
    expect(formatOsLabel('', '')).toBe('Unknown OS');
  });
});
