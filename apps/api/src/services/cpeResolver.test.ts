import { describe, expect, it } from 'vitest';
import { normalizeDisplayName, tokenize } from './cpeResolver';

describe('normalizeDisplayName', () => {
  const cases: Array<[string, string]> = [
    ['Google Chrome', 'google chrome'],
    ['Adobe Acrobat (64-bit)', 'adobe acrobat'],
    ['Mozilla Firefox ESR 115 (x64 en-US)', 'mozilla firefox esr'],
    ['Microsoft 365 Apps for business - en-us', 'microsoft 365 apps for business'],
    ['7-Zip 22.01 (x64)', '7-zip'],
    ['Notepad++ (32-bit x86)', 'notepad++'],
    ['  VLC   media  player  ', 'vlc media player'],
    ['Java 8 Update 351 (64-bit)', 'java 8 update'],
  ];
  it.each(cases)('normalizes %s', (input, expected) => {
    expect(normalizeDisplayName(input)).toBe(expected);
  });
});

describe('tokenize', () => {
  it('splits on non-alphanumeric, lowercases, drops empties', () => {
    expect(tokenize('Adobe Acrobat_Reader-DC')).toEqual(['adobe', 'acrobat', 'reader', 'dc']);
  });
  it('keeps ++ / - inside known product words via alnum-run split', () => {
    expect(tokenize('notepad++')).toEqual(['notepad']);
  });
});

import { loadCuratedDictionary, loadCpeDictionary, parseCpe, isWellFormedCpe } from './cpeResolver';

describe('parseCpe', () => {
  it('extracts vendor/product from cpe:2.3', () => {
    expect(parseCpe('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*')).toEqual({ vendor: 'google', product: 'chrome' });
  });
  it('returns null for garbage', () => {
    expect(parseCpe('not-a-cpe')).toBeNull();
  });
});

describe('curated dictionary', () => {
  it('is keyed by normalized display name and maps to CPE tokens', () => {
    const dict = loadCuratedDictionary();
    expect(dict.get('google chrome')).toEqual({ vendor: 'google', product: 'chrome' });
    expect(dict.get('adobe acrobat')).toEqual({ vendor: 'adobe', product: 'acrobat' });
  });
  it('INVARIANT: every curated CPE token pair exists in the cpedict validation set', () => {
    const dict = loadCuratedDictionary();
    const cpedict = loadCpeDictionary();
    for (const [, { vendor, product }] of dict) {
      expect(cpedict.has(`${vendor}:${product}`), `${vendor}:${product} missing from cpedict`).toBe(true);
    }
  });
});
