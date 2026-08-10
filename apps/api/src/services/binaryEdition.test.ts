import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBinaryEdition } from './binaryEdition';

describe('getBinaryEdition', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('defaults to self-host when unset', () => {
    delete process.env.BINARY_EDITION;
    expect(getBinaryEdition()).toBe('self-host');
  });

  it('defaults to self-host when set to an empty string', () => {
    process.env.BINARY_EDITION = '';
    expect(getBinaryEdition()).toBe('self-host');
  });

  it('returns hosted when explicitly set', () => {
    process.env.BINARY_EDITION = 'hosted';
    expect(getBinaryEdition()).toBe('hosted');
  });

  it('is case-insensitive and trims whitespace', () => {
    process.env.BINARY_EDITION = '  HOSTED  ';
    expect(getBinaryEdition()).toBe('hosted');
  });

  it('returns self-host explicitly', () => {
    process.env.BINARY_EDITION = 'self-host';
    expect(getBinaryEdition()).toBe('self-host');
  });

  it('warns once and defaults to self-host for an unrecognized value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BINARY_EDITION = 'enterprise';
    expect(getBinaryEdition()).toBe('self-host');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unrecognized BINARY_EDITION="enterprise"'),
    );
  });
});
