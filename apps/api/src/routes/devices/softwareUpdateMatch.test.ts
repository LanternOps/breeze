import { describe, expect, it } from 'vitest';
import {
  normalizeSoftwareName,
  buildUpdateIndex,
  annotateSoftwareRow,
} from './softwareUpdateMatch';

describe('normalizeSoftwareName', () => {
  it('lowercases, strips parenthetical qualifiers and bitness, collapses spaces', () => {
    expect(normalizeSoftwareName('Adobe Acrobat (64-bit)')).toBe('adobe acrobat');
    expect(normalizeSoftwareName('Mozilla Firefox (x64 en-US)')).toBe('mozilla firefox');
    expect(normalizeSoftwareName('7-Zip 24.07 (x64)')).toBe('7 zip 24 07');
    expect(normalizeSoftwareName('Google Chrome™')).toBe('google chrome');
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeSoftwareName(undefined)).toBe('');
    expect(normalizeSoftwareName(null)).toBe('');
    expect(normalizeSoftwareName('')).toBe('');
  });

  it('matches the same package reported with different qualifiers', () => {
    expect(normalizeSoftwareName('Mozilla Firefox (x64 en-US)')).toBe(
      normalizeSoftwareName('Mozilla Firefox')
    );
  });
});

const patch = (title: string, version: string | null, packageId: string | null = null) => ({
  title,
  version,
  packageId,
  source: 'third_party' as const,
});

describe('buildUpdateIndex', () => {
  it('keys updates by normalized name', () => {
    const index = buildUpdateIndex([patch('Mozilla Firefox', '130.0', 'Mozilla.Firefox')]);
    expect(index.get('mozilla firefox')).toMatchObject({
      availableVersion: '130.0',
      packageId: 'Mozilla.Firefox',
      source: 'third_party',
    });
  });

  it('keeps the first entry when the same package is reported twice', () => {
    const index = buildUpdateIndex([
      patch('Mozilla Firefox', '130.0', 'Mozilla.Firefox'),
      patch('Mozilla Firefox (x64 en-US)', '131.0', 'Mozilla.Firefox'),
    ]);
    expect(index.size).toBe(1);
    expect(index.get('mozilla firefox')?.availableVersion).toBe('130.0');
  });

  it('drops an ambiguous name shared by two different packages (x64 + x86)', () => {
    const index = buildUpdateIndex([
      patch('Microsoft Visual C++ 2015-2022 Redistributable (x64)', '14.40', 'Microsoft.VCRedist.2015+.x64'),
      patch('Microsoft Visual C++ 2015-2022 Redistributable (x86)', '14.40', 'Microsoft.VCRedist.2015+.x86'),
    ]);
    // Both normalize to the same key but point at different packages — neither
    // wins, so no inventory row gets a wrong-architecture update.
    expect(index.size).toBe(0);
  });

  it('skips entries with unnormalizable titles', () => {
    const index = buildUpdateIndex([patch('', '1.0')]);
    expect(index.size).toBe(0);
  });
});

describe('annotateSoftwareRow', () => {
  const index = buildUpdateIndex([
    patch('Mozilla Firefox', '130.0', 'Mozilla.Firefox'),
    patch('Adobe Acrobat', '25.002', 'Adobe.Acrobat'),
  ]);

  it('flags a row that matches an available update by normalized name', () => {
    const result = annotateSoftwareRow(
      { name: 'Mozilla Firefox (x64 en-US)', version: '128.0' },
      index
    );
    expect(result).toEqual({
      updateAvailable: true,
      availableVersion: '130.0',
      updatePackageId: 'Mozilla.Firefox',
      updateSource: 'third_party',
    });
  });

  it('returns no-update for a row with no matching update', () => {
    const result = annotateSoftwareRow({ name: 'Some Random App', version: '1.0' }, index);
    expect(result.updateAvailable).toBe(false);
    expect(result.updatePackageId).toBeNull();
  });

  it('does not flag an update when the available version equals the installed version', () => {
    const result = annotateSoftwareRow(
      { name: 'Adobe Acrobat (64-bit)', version: '25.002' },
      index
    );
    expect(result.updateAvailable).toBe(false);
  });

  it('flags an update when versions differ even after whitespace', () => {
    const result = annotateSoftwareRow({ name: 'Adobe Acrobat', version: ' 24.001 ' }, index);
    expect(result.updateAvailable).toBe(true);
    expect(result.availableVersion).toBe('25.002');
  });
});
