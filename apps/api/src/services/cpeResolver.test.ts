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

import {
  buildCatalogIndex,
  loadCuratedDictionary,
  loadCpeDictionary,
  parseCpe,
  isWellFormedCpe,
  resolve,
  type CatalogProduct,
} from './cpeResolver';

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

const CATALOG: CatalogProduct[] = [
  {
    id: 'p-chrome',
    normalizedName: 'chrome',
    normalizedVendor: 'google',
    cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*',
  },
  {
    id: 'p-firefox',
    normalizedName: 'firefox',
    normalizedVendor: 'mozilla',
    cpe: 'cpe:2.3:a:mozilla:firefox:*:*:*:*:*:*:*:*',
  },
  {
    id: 'p-acrobat',
    normalizedName: 'acrobat_reader',
    normalizedVendor: 'adobe',
    cpe: 'cpe:2.3:a:adobe:acrobat_reader:*:*:*:*:*:*:*:*',
  },
];

describe('buildCatalogIndex', () => {
  it('indexes exact name, vendor:product, and recall words', () => {
    const idx = buildCatalogIndex(CATALOG);

    expect(idx.byExactName.get('chrome')).toBe('p-chrome');
    expect(idx.byVendorProduct.get('google:chrome')).toBe('p-chrome');
    expect(idx.wordIndex.get('acrobat')).toEqual(new Set(['p-acrobat']));
    expect(idx.wordIndex.get('adobe')).toEqual(new Set(['p-acrobat']));
    expect(idx.meta.get('p-firefox')?.cpeVendor).toBe('mozilla');
    expect(idx.meta.get('p-acrobat')?.productTokens).toEqual(new Set(['acrobat', 'reader']));
  });

  it('marks ambiguous exact names null (two products, same normalized_name)', () => {
    const idx = buildCatalogIndex([
      ...CATALOG,
      {
        id: 'p-chrome2',
        normalizedName: 'chrome',
        normalizedVendor: 'other',
        cpe: 'cpe:2.3:a:other:chrome:*:*:*:*:*:*:*:*',
      },
    ]);

    expect(idx.byExactName.get('chrome')).toBeNull();
  });

  it('uses normalized name for productTokens when no cpe while vendor still feeds recall', () => {
    const idx = buildCatalogIndex([
      {
        id: 'p-internal',
        normalizedName: 'internal_tool',
        normalizedVendor: 'acme software',
        cpe: null,
      },
    ]);

    expect(idx.meta.get('p-internal')).toEqual({
      cpe: null,
      cpeVendor: null,
      cpeProduct: null,
      productTokens: new Set(['internal', 'tool']),
    });
    expect(idx.wordIndex.get('acme')).toEqual(new Set(['p-internal']));
  });
});

describe('resolve - Layer A', () => {
  const idx = buildCatalogIndex(CATALOG);
  const curated = loadCuratedDictionary();

  it('curated dict hit -> confidence curated, resolves to catalog product', () => {
    const r = resolve('Adobe Acrobat Reader DC (64-bit)', 'Adobe Inc.', idx, curated);
    expect(r).toMatchObject({
      productId: 'p-acrobat',
      confidence: 'curated',
      matchedVia: 'dictionary',
    });
  });

  it('exact normalized-name catalog hit -> confidence exact', () => {
    const r = resolve('Firefox', 'Mozilla', idx, curated);
    expect(r).toMatchObject({
      productId: 'p-firefox',
      confidence: 'exact',
      matchedVia: 'catalog_exact',
    });
  });

  it('curated hit whose CPE is absent from catalog -> productId null, matchedVia dictionary', () => {
    const r = resolve('Microsoft Teams', 'Microsoft', idx, curated);
    expect(r).toMatchObject({ productId: null, matchedVia: 'dictionary' });
  });
});
