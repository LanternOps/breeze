import { describe, it, expect } from 'vitest';

// No mocks needed: osLabel lives in lib/ and imports nothing, so it loads in the
// Vitest environment directly. (It previously lived in DeviceDetailScreen.tsx,
// where reaching it meant stubbing every native import that screen pulls in.)
import { osLabel } from './osLabel';

describe('osLabel', () => {
  it('maps every known OS_TYPES value (packages/shared/src/constants) to its product name', () => {
    expect(osLabel('windows')).toBe('Windows');
    expect(osLabel('macos')).toBe('macOS');
    expect(osLabel('linux')).toBe('Linux');
  });

  it('is case-insensitive on the raw enum value', () => {
    expect(osLabel('WINDOWS')).toBe('Windows');
    expect(osLabel('MacOS')).toBe('macOS');
  });

  it('falls back to a capitalized form of an unrecognized value, rather than hiding it', () => {
    expect(osLabel('freebsd')).toBe('Freebsd');
    expect(osLabel('')).toBe('');
  });
});
