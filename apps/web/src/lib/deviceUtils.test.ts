import { describe, it, expect } from 'vitest';
import { formatOsVersionForDisplay } from './deviceUtils';

describe('formatOsVersionForDisplay', () => {
  it('returns the fallback for empty / nullish input', () => {
    expect(formatOsVersionForDisplay(undefined)).toBe('—');
    expect(formatOsVersionForDisplay(null)).toBe('—');
    expect(formatOsVersionForDisplay('')).toBe('—');
    expect(formatOsVersionForDisplay('   ')).toBe('—');
  });

  it('honours a custom fallback', () => {
    expect(formatOsVersionForDisplay(null, 'Unknown')).toBe('Unknown');
  });

  it('strips the embedded build from Windows 11 version strings (issue #1302)', () => {
    expect(
      formatOsVersionForDisplay('Microsoft Windows 11 Pro 10.0.22631 Build 22631'),
    ).toBe('Microsoft Windows 11 Pro');
  });

  it('strips the embedded build from Windows 10 version strings', () => {
    expect(
      formatOsVersionForDisplay('Microsoft Windows 10 Pro 10.0.19045 Build 19045'),
    ).toBe('Microsoft Windows 10 Pro');
  });

  it('strips a four-segment build version with Build suffix', () => {
    expect(
      formatOsVersionForDisplay('Microsoft Windows 11 Enterprise 10.0.26200.7623 Build 26200.7623'),
    ).toBe('Microsoft Windows 11 Enterprise');
  });

  it('strips the embedded build when there is no redundant Build suffix', () => {
    expect(
      formatOsVersionForDisplay('Microsoft Windows Server 2022 Datacenter 10.0.20348'),
    ).toBe('Microsoft Windows Server 2022 Datacenter');
  });

  it('leaves an already-clean Windows name untouched', () => {
    expect(formatOsVersionForDisplay('Microsoft Windows 11 Pro')).toBe('Microsoft Windows 11 Pro');
  });

  it('falls back to the raw value when osVersion is just a bare build', () => {
    expect(formatOsVersionForDisplay('10.0.20348')).toBe('10.0.20348');
  });

  it('preserves macOS marketing versions (no kernel prefix)', () => {
    expect(formatOsVersionForDisplay('26.3.1')).toBe('26.3.1');
    expect(formatOsVersionForDisplay('15.2')).toBe('15.2');
  });

  it('strips a darwin kernel prefix but keeps the version', () => {
    expect(formatOsVersionForDisplay('darwin 26.3.1')).toBe('26.3.1');
  });

  it('strips a linux kernel prefix but keeps the distro version', () => {
    expect(formatOsVersionForDisplay('linux 6.8.0')).toBe('6.8.0');
  });

  it('preserves a plain distro name + short version', () => {
    expect(formatOsVersionForDisplay('Ubuntu 24.04')).toBe('Ubuntu 24.04');
  });
});
