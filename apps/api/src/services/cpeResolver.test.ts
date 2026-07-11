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
  it('drops ++ / - punctuation via alnum-run split', () => {
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

  it('keys exact names via normalizeDisplayName so capitalized catalog rows are reachable (#2290)', () => {
    // The MSRC sync stores software_products.normalized_name verbatim from the CVRF
    // product name — capitalized. resolve() looks up normalizeDisplayName(displayName)
    // (lowercased). If the index keyed on the raw value, every capitalized catalog row
    // would be unreachable by exact match — the #2290/#2292 regression.
    const idx = buildCatalogIndex([
      {
        id: 'p-office',
        normalizedName: 'Microsoft 365 Apps for Enterprise',
        normalizedVendor: 'microsoft',
        cpe: 'cpe:2.3:a:microsoft:365_apps:*:*:*:*:enterprise:*:*:*',
      },
    ]);

    expect(idx.byExactName.get('microsoft 365 apps for enterprise')).toBe('p-office');
    expect(idx.byExactName.get('Microsoft 365 Apps for Enterprise')).toBeUndefined();
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
      catalogVendor: 'acme software',
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
    expect(r).toMatchObject({
      productId: null,
      cpe: null,
      confidence: 'none',
      matchedVia: 'dictionary',
    });
  });

  it('does not trust curated entries when the supplied vendor disagrees', () => {
    const zoomCatalog: CatalogProduct[] = [
      {
        id: 'p-zoom',
        normalizedName: 'zoom_workplace',
        normalizedVendor: 'zoom',
        cpe: 'cpe:2.3:a:zoom:zoom:*:*:*:*:*:*:*:*',
      },
    ];
    const zoomCurated = new Map([['zoom', { vendor: 'zoom', product: 'zoom' }]]);

    const disagreement = resolve('Zoom', 'Acme Corp', buildCatalogIndex(zoomCatalog), zoomCurated);
    expect(disagreement.confidence).not.toBe('curated');

    const absentVendor = resolve('Zoom', null, buildCatalogIndex(zoomCatalog), zoomCurated);
    expect(absentVendor).toMatchObject({
      productId: 'p-zoom',
      confidence: 'curated',
      matchedVia: 'dictionary',
    });
  });
});

describe('resolve - Layer B (token) + guardrails', () => {
  const catalog: CatalogProduct[] = [
    ...CATALOG,
    {
      id: 'p-7zip',
      normalizedName: '7-zip_file_archiver',
      normalizedVendor: '7-zip',
      cpe: 'cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*',
    },
    {
      id: 'p-wireshark',
      normalizedName: 'wireshark_network_protocol_analyzer',
      normalizedVendor: 'wireshark',
      cpe: 'cpe:2.3:a:wireshark:wireshark:*:*:*:*:*:*:*:*',
    },
  ];
  const idx = buildCatalogIndex(catalog);
  const curated = loadCuratedDictionary();

  it('token match on long-tail name with vendor agreement -> fuzzy', () => {
    const r = resolve('Wireshark 4.2.0 (64-bit)', 'Wireshark Foundation', idx, curated);
    expect(r).toMatchObject({
      productId: 'p-wireshark',
      confidence: 'fuzzy',
      matchedVia: 'token',
    });
    expect(r.tokensMatched).toBeGreaterThanOrEqual(1);
  });

  it('GUARDRAIL: short vendor substring does not create agreement', () => {
    const caCatalog = buildCatalogIndex([
      {
        id: 'p-ca',
        normalizedName: 'agent',
        normalizedVendor: 'ca',
        cpe: 'cpe:2.3:a:ca:agent:*:*:*:*:*:*:*:*',
      },
    ]);

    const r = resolve('Canon Print Agent', 'Canon', caCatalog, new Map());
    expect(r.confidence).toBe('none');
    expect(r.productId).toBeNull();
  });

  it('GUARDRAIL: a shared 2-char vendor token does not create agreement (length>=3 floor)', () => {
    // cpe vendor "bq" (2 chars). Query vendor "Anon BQ Systems" tokenizes to {anon,bq,systems};
    // the ONLY overlap with "bq" is the 2-char token, and the query name matches the product
    // token "reader" (score 1). Only the length>=3 floor withholds this — remove it and the
    // 2-char "bq" collision would agree and return 'fuzzy'. This isolates that guard (the
    // Canon case above passes regardless of the floor, since 'canon' is never in {ca}).
    const bqCatalog = buildCatalogIndex([
      { id: 'p-bq', normalizedName: 'reader', normalizedVendor: 'bq', cpe: 'cpe:2.3:a:bq:reader:*:*:*:*:*:*:*:*' },
    ]);
    const r = resolve('Anon BQ Reader', 'Anon BQ Systems', bqCatalog, new Map());
    expect(r.confidence).toBe('none');
    expect(r.productId).toBeNull();
  });

  it('still allows legitimate vendor token agreement', () => {
    const r = resolve('Wireshark Protocol Analyzer', 'Wireshark Foundation', idx, new Map());
    expect(r).toMatchObject({
      productId: 'p-wireshark',
      confidence: 'fuzzy',
      matchedVia: 'token',
    });
  });

  it('GUARDRAIL: Microsoft Edge against a Chrome-only catalog -> withheld (no Edge->Chrome)', () => {
    const chromeOnly = buildCatalogIndex([CATALOG[0]!]);
    const r = resolve('Microsoft Edge', 'Microsoft Corporation', chromeOnly, new Map());
    expect(r.confidence).toBe('none');
    expect(r.productId).toBeNull();
  });

  it('GUARDRAIL: vendor disagreement withholds even if product word overlaps', () => {
    const r = resolve('Chrome Remover', 'Acme Software', buildCatalogIndex([CATALOG[0]!]), new Map());
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: missing vendor -> Layer B withholds', () => {
    const noExactIdx = buildCatalogIndex([
      {
        id: 'p-wireshark',
        normalizedName: 'wireshark_network_protocol_analyzer',
        normalizedVendor: 'wireshark',
        cpe: 'cpe:2.3:a:wireshark:wireshark:*:*:*:*:*:*:*:*',
      },
    ]);
    const r = resolve('Wireshark', null, noExactIdx, new Map());
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: vendor-only word match (no distinctive product token) withholds', () => {
    const withMs: CatalogProduct[] = [
      {
        id: 'p-ms365',
        normalizedName: '365_apps',
        normalizedVendor: 'microsoft',
        cpe: 'cpe:2.3:a:microsoft:365_apps:*:*:*:*:*:*:*:*',
      },
    ];
    const r = resolve('Microsoft Random Tool', 'Microsoft', buildCatalogIndex(withMs), new Map());
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: generic stopwords do not create token confidence', () => {
    const acmeAgent = buildCatalogIndex([
      {
        id: 'p-acme-agent',
        normalizedName: 'remote_agent',
        normalizedVendor: 'acme',
        cpe: 'cpe:2.3:a:acme:agent:*:*:*:*:*:*:*:*',
      },
    ]);

    const r = resolve('Acme Agent', 'Acme', acmeAgent, new Map());
    expect(r.confidence).toBe('none');
  });

  it('uses catalog vendor for token guardrails when a catalog product has no CPE', () => {
    const internalTool = buildCatalogIndex([
      {
        id: 'p-int',
        normalizedName: 'internal_tool',
        normalizedVendor: 'acme',
        cpe: null,
      },
    ]);

    const r = resolve('Acme Internal Tool', 'Acme', internalTool, new Map());
    expect(r).toMatchObject({
      productId: 'p-int',
      confidence: 'fuzzy',
      matchedVia: 'token',
    });
  });

  it('vendor alias equivalence (Adobe Inc. == adobe) - via token when not curated', () => {
    const adobeCat = buildCatalogIndex([CATALOG[2]!]);
    const r = resolve('Adobe Acrobat Reader', 'Adobe Inc.', adobeCat, new Map());
    expect(r).toMatchObject({ productId: 'p-acrobat', confidence: 'fuzzy', matchedVia: 'token' });
  });

  it('GUARDRAIL: tied token winners withhold', () => {
    const idxWithTie = buildCatalogIndex([
      {
        id: 'p-acme-admin',
        normalizedName: 'admin_console',
        normalizedVendor: 'acme',
        cpe: 'cpe:2.3:a:acme:console:*:*:*:*:*:*:*:*',
      },
      {
        id: 'p-acme-user',
        normalizedName: 'user_console',
        normalizedVendor: 'acme',
        cpe: 'cpe:2.3:a:acme:console:*:*:*:*:*:*:*:*',
      },
    ]);
    const r = resolve('Console Tool', 'Acme', idxWithTie, new Map());
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: malformed winning CPE withholds', () => {
    const malformed = buildCatalogIndex([
      {
        id: 'p-acme-console',
        normalizedName: 'acme_console_manager',
        normalizedVendor: 'acme',
        cpe: 'cpe:2.3:a:acme:console:*:*:*:*:*:*:*:*',
      },
    ]);
    malformed.meta.set('p-acme-console', {
      ...malformed.meta.get('p-acme-console')!,
      cpe: 'not-a-cpe',
    });
    const r = resolve('Acme Console', 'Acme', malformed, new Map());
    expect(r.confidence).toBe('none');
  });
});
