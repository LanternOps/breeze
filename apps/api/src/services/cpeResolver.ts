/*
 * DisplayName -> CPE resolver (#2290).
 * Layer B token index/lookup ported from CIRCL cpe-guesser (BSD-2-Clause):
 * https://github.com/vulnerability-lookup/cpe-guesser
 */

import curatedJson from './__fixtures__/cpe-translations.json';
import cpedictJson from './__fixtures__/cpe-dictionary.json';

export const RESOLVER_VERSION = 1;

// Tokens stripped from a raw registry DisplayName. Architecture, then version-ish
// trailers. Order matters: strip arch/locale before trailing-number cleanup.
const ARCH_TOKENS = /\b(64-?bit|32-?bit|x64|x86|amd64|arm64|win64|win32)\b/gi;
const LOCALE_TOKEN = /\b[a-z]{2}-[a-z]{2}\b/gi;
const PAREN_GROUP = /\([^)]*\)/g;
const TRAILING_VERSION = /\s+\d[\d.]*\s*$/g;
const MULTISPACE = /\s+/g;

export function normalizeDisplayName(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(PAREN_GROUP, ' ');
  s = s.replace(ARCH_TOKENS, ' ');
  s = s.replace(LOCALE_TOKEN, ' ');
  s = s.replace(/\s-\s.*$/, ' ');
  s = s.replace(TRAILING_VERSION, ' ');
  s = s.replace(MULTISPACE, ' ').trim();
  return s;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

export interface CuratedEntry { vendor: string; product: string; }

export function parseCpe(cpe: string): { vendor: string; product: string } | null {
  const parts = cpe.split(':');
  // cpe:2.3:part:vendor:product:...  → parts[3]=vendor parts[4]=product
  if (parts.length < 5 || parts[0] !== 'cpe' || parts[1] !== '2.3') return null;
  const vendor = parts[3];
  const product = parts[4];
  if (!vendor || !product) return null;
  return { vendor, product };
}

export function isWellFormedCpe(cpe: string): boolean {
  return parseCpe(cpe) !== null;
}

export function loadCuratedDictionary(): Map<string, CuratedEntry> {
  const rows = curatedJson as Array<{ name: string; vendor: string; product: string }>;
  const map = new Map<string, CuratedEntry>();
  for (const r of rows) {
    map.set(normalizeDisplayName(r.name), { vendor: r.vendor, product: r.product });
  }
  return map;
}

export function loadCpeDictionary(): Set<string> {
  return new Set(cpedictJson as string[]);
}

export interface CatalogProduct {
  id: string;
  normalizedName: string;
  normalizedVendor: string | null;
  cpe: string | null;
}

export interface CatalogIndex {
  byExactName: Map<string, string | null>;
  byVendorProduct: Map<string, string>;
  wordIndex: Map<string, Set<string>>;
  meta: Map<
    string,
    {
      cpe: string | null;
      cpeVendor: string | null;
      cpeProduct: string | null;
      productTokens: Set<string>;
    }
  >;
}

export function buildCatalogIndex(products: CatalogProduct[]): CatalogIndex {
  const byExactName = new Map<string, string | null>();
  const byVendorProduct = new Map<string, string>();
  const wordIndex = new Map<string, Set<string>>();
  const meta: CatalogIndex['meta'] = new Map();

  for (const product of products) {
    if (byExactName.has(product.normalizedName)) {
      byExactName.set(product.normalizedName, null);
    } else {
      byExactName.set(product.normalizedName, product.id);
    }

    const cpeParts = product.cpe ? parseCpe(product.cpe) : null;
    if (cpeParts) {
      byVendorProduct.set(`${cpeParts.vendor}:${cpeParts.product}`, product.id);
    }

    const productTokens = new Set(
      cpeParts ? tokenize(cpeParts.product) : tokenize(product.normalizedName),
    );
    const recallWords = new Set([
      ...tokenize(product.normalizedName),
      ...(product.normalizedVendor ? tokenize(product.normalizedVendor) : []),
      ...(cpeParts ? [...tokenize(cpeParts.vendor), ...tokenize(cpeParts.product)] : []),
    ]);

    for (const word of recallWords) {
      const productIds = wordIndex.get(word) ?? new Set<string>();
      productIds.add(product.id);
      wordIndex.set(word, productIds);
    }

    meta.set(product.id, {
      cpe: product.cpe,
      cpeVendor: cpeParts?.vendor ?? null,
      cpeProduct: cpeParts?.product ?? null,
      productTokens,
    });
  }

  return { byExactName, byVendorProduct, wordIndex, meta };
}

export type ResolutionConfidence = 'curated' | 'exact' | 'fuzzy' | 'none';
export type ResolutionVia = 'dictionary' | 'catalog_exact' | 'token' | 'unmatched';

export interface Resolution {
  productId: string | null;
  cpe: string | null;
  confidence: ResolutionConfidence;
  matchedVia: ResolutionVia;
  tokensMatched: number;
}

export const NONE: Resolution = {
  productId: null,
  cpe: null,
  confidence: 'none',
  matchedVia: 'unmatched',
  tokensMatched: 0,
};

export function resolve(
  displayName: string,
  _vendor: string | null,
  index: CatalogIndex,
  curated: Map<string, CuratedEntry>,
): Resolution {
  const normName = normalizeDisplayName(displayName);

  // Layer A.1 - curated translation dictionary.
  const curatedHit = curated.get(normName);
  if (curatedHit) {
    const key = `${curatedHit.vendor}:${curatedHit.product}`;
    const productId = index.byVendorProduct.get(key) ?? null;
    const cpe = productId
      ? index.meta.get(productId)?.cpe ?? null
      : `cpe:2.3:a:${curatedHit.vendor}:${curatedHit.product}`;
    return {
      productId,
      cpe,
      confidence: productId ? 'curated' : 'none',
      matchedVia: 'dictionary',
      tokensMatched: 0,
    };
  }

  // Layer A.2 - exact catalog normalized-name match.
  const exact = index.byExactName.get(normName);
  if (exact) {
    return {
      productId: exact,
      cpe: index.meta.get(exact)?.cpe ?? null,
      confidence: 'exact',
      matchedVia: 'catalog_exact',
      tokensMatched: 0,
    };
  }

  // Layer B added in Task 5.
  return NONE;
}
