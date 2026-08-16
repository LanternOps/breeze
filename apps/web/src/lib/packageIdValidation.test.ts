import { describe, expect, it } from 'vitest';

import {
  KINDS_BY_PLATFORM,
  MAX_PACKAGE_ID_LENGTH,
  platformForKind,
  validatePackageIdForKind,
} from './packageIdValidation';

describe('validatePackageIdForKind', () => {
  describe('winget', () => {
    it.each(['Google.Chrome', '7zip.7zip', 'Microsoft.VisualStudio.2022.Community', 'a', 'A-b_c.1'])(
      'accepts %s',
      (id) => {
        expect(validatePackageIdForKind('winget', id)).toBeNull();
      },
    );

    it.each([
      ['', 'empty'],
      ['.LeadingDot', 'invalid_winget'],
      ['-Leading', 'invalid_winget'],
      ['has space', 'invalid_winget'],
      ['has/slash', 'invalid_winget'],
      ['semi;colon', 'invalid_winget'],
      ['unicodeé', 'invalid_winget'],
    ])('rejects %s', (id, code) => {
      expect(validatePackageIdForKind('winget', id)).toBe(code);
    });

    it('rejects ids longer than the max length before the regex', () => {
      expect(validatePackageIdForKind('winget', 'a'.repeat(MAX_PACKAGE_ID_LENGTH + 1))).toBe('too_long');
      expect(validatePackageIdForKind('winget', 'a'.repeat(MAX_PACKAGE_ID_LENGTH))).toBeNull();
    });
  });

  describe('homebrew', () => {
    it.each(['firefox', 'gnu-sed', 'node@22', 'homebrew/cask/docker', 'a+b'])('accepts %s', (id) => {
      expect(validatePackageIdForKind('homebrew_cask', id)).toBeNull();
      expect(validatePackageIdForKind('homebrew_formula', id)).toBeNull();
    });

    it.each([
      ['', 'empty'],
      ['-leading', 'invalid_brew'],
      ['/leading', 'invalid_brew'],
      ['a/../b', 'invalid_brew'],
      ['..', 'invalid_brew'],
      ['has space', 'invalid_brew'],
      ['semi;colon', 'invalid_brew'],
    ])('rejects %s', (id, code) => {
      expect(validatePackageIdForKind('homebrew_cask', id)).toBe(code);
    });

    it('rejects over-long names', () => {
      expect(validatePackageIdForKind('homebrew_formula', 'a'.repeat(MAX_PACKAGE_ID_LENGTH + 1))).toBe(
        'too_long',
      );
    });
  });
});

describe('platform helpers', () => {
  it('maps kinds to their platform', () => {
    expect(platformForKind('winget')).toBe('windows');
    expect(platformForKind('homebrew_cask')).toBe('macos');
    expect(platformForKind('homebrew_formula')).toBe('macos');
  });

  it('offers only platform-coherent kinds', () => {
    expect(KINDS_BY_PLATFORM.windows).toEqual(['winget']);
    expect(KINDS_BY_PLATFORM.macos).toEqual(['homebrew_cask', 'homebrew_formula']);
    for (const [platform, kinds] of Object.entries(KINDS_BY_PLATFORM)) {
      for (const kind of kinds) expect(platformForKind(kind)).toBe(platform);
    }
  });
});
