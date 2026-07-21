# DisplayName → CPE Resolver Implementation Plan (#2290)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make device→catalog vulnerability correlation resolve real Windows registry DisplayNames to catalog CPE products via a deterministic two-layer resolver, so the Vulnerabilities dashboard surfaces the whole installed-software surface instead of only Chrome.

**Architecture:** A pure `cpeResolver.ts` normalizes a DisplayName and resolves it against (Layer A) a curated translation dictionary + exact catalog-name match, then (Layer B) a ported cpe-guesser token inverted-index over the catalog gated by hard guardrails (vendor agreement, distinctive-product-token, unique winner, score threshold) — withholding rather than guessing. A global `software_product_resolutions` cache table (system-only RLS) stores `(lookup_name, lookup_vendor) → software_product_id | NULL` keyed on the SQL-reproducible `lower(trim(...))` form; `refreshResolutionCache()` fills it once per correlation cycle; correlation joins through it and stamps `device_vulnerabilities.match_confidence`.

**Tech Stack:** TypeScript, Hono API, PostgreSQL 16 + Drizzle ORM, Vitest (unit + real-DB integration on :5433), BullMQ. Vendored data: FleetDM `cpe_translations` (MIT), CIRCL cpe-guesser algorithm (BSD-2, ported), tiiuae cpedict slice.

## Global Constraints

- **Resolver purity:** `cpeResolver.ts` performs NO database or network access. All DB work lives in `cpeResolution.ts` / `vulnerabilityCorrelation.ts`.
- **Deterministic only:** no similarity scoring as the match decision; Layer B is token-set logic + guardrails. A match is withheld (never guessed) when any guardrail fails.
- **Join key is `lower(trim(name))`**, NOT the token-normalized name — full normalization runs in TS during refresh; the SQL join is a plain equality on stored lowercased keys.
- **`software_product_resolutions` is a global system-only table** (RLS enabled + forced + `_system_only` policy: `current_setting('breeze.scope', true) = 'system'`). Accessed only under `withSystemDbAccessContext`. Registered in `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts`.
- **Read-side `lower()` invariant preserved** — do NOT rewrite/backfill `software_products.normalized_name`.
- **cpedict guard (refinement from spec):** runtime validation = `cpe:2.3` well-formedness only; presence-in-cpedict is a TEST-TIME invariant on the curated dictionary only (a bounded slice would false-negative real catalog CPEs).
- **Migrations:** date-prefixed `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS`, `pg_policies` check, `ADD COLUMN IF NOT EXISTS`), no inner `BEGIN;/COMMIT;`, never edit a shipped migration.
- **New `*.integration.test.ts` files MUST be added to the explicit `include` array in `apps/api/vitest.integration.config.ts`** or they will not run.
- **Public repo:** no customer names/IPs in any committed artifact. Vendored data ships with `NOTICE` attribution.
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Working directory:** worktree `/Users/toddhebebrand/orca/workspaces/breeze/vuln-cpe-resolver`, branch `fix/vuln-cpe-resolver`. All `pnpm` commands run from `apps/api` unless noted.

## File Structure

- Create `apps/api/src/services/cpeResolver.ts` — pure resolver (normalize, tokenize, catalog index, resolve, curated dict + cpedict loaders).
- Create `apps/api/src/services/cpeResolver.test.ts` — unit tests (Tasks 1,3,4,5) + curated/cpedict invariant (Task 2).
- Create `apps/api/src/services/__fixtures__/cpe-translations.json` + `cpe-translations.NOTICE` — curated dictionary source (Task 2).
- Create `apps/api/src/services/__fixtures__/cpe-dictionary.json` + `cpe-dictionary.NOTICE` — validation set (Task 2).
- Create `apps/api/scripts/regen-cpe-data.ts` — provenance-documented regeneration (Task 2).
- Create `apps/api/src/services/cpeResolution.ts` — `refreshResolutionCache()` (DB, system context) (Task 7).
- Create `apps/api/src/services/cpeResolution.integration.test.ts` — refresh integration tests (Task 7).
- Create `apps/api/migrations/2026-07-08-vuln-product-resolutions.sql` (Task 6).
- Modify `apps/api/src/db/schema/vulnerabilityManagement.ts` — add `softwareProductResolutions` table + `deviceVulnerabilities.matchConfidence` (Task 6).
- Modify `apps/api/src/services/vulnerabilityCorrelation.ts` — rewrite product joins through resolutions + stamp confidence (Task 8).
- Modify `apps/api/src/services/vulnerabilityCorrelation.integration.test.ts` — resolver-backed correlation cases (Task 8).
- Modify `apps/api/src/jobs/vulnerabilityJobs.ts` `correlateEnabledOrgs` — call `refreshResolutionCache()` once (Task 8).
- Modify `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — register table (Task 6).
- Modify `apps/api/vitest.integration.config.ts` — register new integration test (Task 7).

## Interfaces (defined once, referenced throughout)

```ts
// cpeResolver.ts — public surface
export const RESOLVER_VERSION = 1;
export type ResolutionConfidence = 'curated' | 'exact' | 'fuzzy' | 'none';
export type ResolutionVia = 'dictionary' | 'catalog_exact' | 'token' | 'unmatched';

export interface Resolution {
  productId: string | null;
  cpe: string | null;
  confidence: ResolutionConfidence;
  matchedVia: ResolutionVia;
  tokensMatched: number;
}

export interface CatalogProduct {
  id: string;
  normalizedName: string;         // catalog normalized_name (already lowercased on write)
  normalizedVendor: string | null;
  cpe: string | null;             // cpe:2.3:a:vendor:product:...
}

export interface CatalogIndex {
  byExactName: Map<string, string | null>;   // normalizedName -> productId (null = ambiguous, drop)
  byVendorProduct: Map<string, string>;       // `${cpeVendor}:${cpeProduct}` -> productId
  wordIndex: Map<string, Set<string>>;        // word -> productIds (recall: name+vendor+cpe words)
  meta: Map<string, { cpe: string | null; cpeVendor: string | null; cpeProduct: string | null; productTokens: Set<string> }>;
}

export interface CuratedEntry { vendor: string; product: string; }   // CPE tokens

export function normalizeDisplayName(name: string): string;
export function tokenize(s: string): string[];
export function parseCpe(cpe: string): { vendor: string; product: string } | null;
export function isWellFormedCpe(cpe: string): boolean;
export function loadCuratedDictionary(): Map<string, CuratedEntry>;   // key = normalizeDisplayName(sourceName)
export function loadCpeDictionary(): Set<string>;                     // set of `${vendor}:${product}`
export function buildCatalogIndex(products: CatalogProduct[]): CatalogIndex;
export function resolve(
  displayName: string,
  vendor: string | null,
  index: CatalogIndex,
  curated: Map<string, CuratedEntry>,
): Resolution;
```

```ts
// cpeResolution.ts — public surface
export function refreshResolutionCache(): Promise<Record<ResolutionConfidence, number>>;
```

---

### Task 1: `normalizeDisplayName` + `tokenize`

**Files:**
- Create: `apps/api/src/services/cpeResolver.ts`
- Test: `apps/api/src/services/cpeResolver.test.ts`

**Interfaces:**
- Produces: `normalizeDisplayName(name: string): string`, `tokenize(s: string): string[]`, `RESOLVER_VERSION`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/cpeResolver.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/api`): `pnpm test:run src/services/cpeResolver.test.ts`
Expected: FAIL — `normalizeDisplayName is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/services/cpeResolver.ts
/*
 * DisplayName → CPE resolver (#2290).
 * Layer B token index/lookup ported from CIRCL cpe-guesser (BSD-2-Clause):
 * https://github.com/vulnerability-lookup/cpe-guesser
 */

export const RESOLVER_VERSION = 1;

// Tokens stripped from a raw registry DisplayName. Architecture, then version-ish
// trailers. Order matters: strip arch/locale before trailing-number cleanup.
const ARCH_TOKENS = /\b(64-?bit|32-?bit|x64|x86|amd64|arm64|win64|win32)\b/gi;
const LOCALE_TOKEN = /\b[a-z]{2}-[a-z]{2}\b/gi;               // en-us, de-de
const PAREN_GROUP = /\([^)]*\)/g;                              // (64-bit), (x64 en-US)
const TRAILING_VERSION = /\b\d[\d.]*\b/g;                      // 22.01, 115, 351, 8, 2019
const MULTISPACE = /\s+/g;

export function normalizeDisplayName(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(PAREN_GROUP, ' ');       // drop parenthetical noise wholesale
  s = s.replace(ARCH_TOKENS, ' ');
  s = s.replace(LOCALE_TOKEN, ' ');
  s = s.replace(/\s-\s.*$/, ' ');         // drop "- <locale/edition>" suffix
  s = s.replace(TRAILING_VERSION, ' ');   // drop standalone version/year numbers
  s = s.replace(MULTISPACE, ' ').trim();
  return s;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: PASS (8 normalize cases + 2 tokenize cases).

Note: the `7-Zip 22.01` case expects `7-zip` — `TRAILING_VERSION` drops `22.01`, `PAREN_GROUP` drops `(x64)`; the hyphen in `7-zip` is preserved because `\d[\d.]*` requires a leading digit-run and `7-zip` is `7`,`-`,`zip` — verify `7` is NOT stripped by confirming the expected value in the test tolerates a leading kept token. If `normalizeDisplayName('7-Zip 22.01 (x64)')` yields `7-zip`, PASS. If it yields `-zip`, adjust `TRAILING_VERSION` to `/(?<![a-z-])\b\d[\d.]*\b/gi`. Run the test; make it green before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/cpeResolver.ts apps/api/src/services/cpeResolver.test.ts
git commit -m "feat(vuln): DisplayName normalization + tokenizer for CPE resolver (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Vendored data fixtures + regen script + loaders

**Files:**
- Create: `apps/api/src/services/__fixtures__/cpe-translations.json`, `cpe-translations.NOTICE`
- Create: `apps/api/src/services/__fixtures__/cpe-dictionary.json`, `cpe-dictionary.NOTICE`
- Create: `apps/api/scripts/regen-cpe-data.ts`
- Modify: `apps/api/src/services/cpeResolver.ts` (add loaders)
- Test: `apps/api/src/services/cpeResolver.test.ts` (add loader + invariant tests)

**Interfaces:**
- Consumes: `normalizeDisplayName` (Task 1).
- Produces: `parseCpe`, `isWellFormedCpe`, `loadCuratedDictionary`, `loadCpeDictionary`, `CuratedEntry`.

- [ ] **Step 1: Create the committed starter fixtures (guaranteed offline baseline)**

`apps/api/src/services/__fixtures__/cpe-translations.json` — converted to OUR shape (`{ name, vendor, product }`, CPE tokens). This starter is hand-verified; the regen script expands it from FleetDM.

```json
[
  { "name": "Google Chrome", "vendor": "google", "product": "chrome" },
  { "name": "Mozilla Firefox", "vendor": "mozilla", "product": "firefox" },
  { "name": "Mozilla Firefox ESR", "vendor": "mozilla", "product": "firefox_esr" },
  { "name": "Adobe Acrobat Reader", "vendor": "adobe", "product": "acrobat_reader" },
  { "name": "Adobe Acrobat Reader DC", "vendor": "adobe", "product": "acrobat_reader" },
  { "name": "Adobe Acrobat", "vendor": "adobe", "product": "acrobat" },
  { "name": "7-Zip", "vendor": "7-zip", "product": "7-zip" },
  { "name": "Notepad++", "vendor": "notepad-plus-plus", "product": "notepad-plus-plus" },
  { "name": "Zoom", "vendor": "zoom", "product": "zoom" },
  { "name": "VLC media player", "vendor": "videolan", "product": "vlc_media_player" },
  { "name": "Microsoft Edge", "vendor": "microsoft", "product": "edge" },
  { "name": "Microsoft OneDrive", "vendor": "microsoft", "product": "onedrive" },
  { "name": "Microsoft Teams", "vendor": "microsoft", "product": "teams" },
  { "name": "Git", "vendor": "git-scm", "product": "git" },
  { "name": "Node.js", "vendor": "nodejs", "product": "node.js" }
]
```

`apps/api/src/services/__fixtures__/cpe-dictionary.json` — bounded validation set (`vendor:product` pairs) covering the starter + integration-test products:

```json
[
  "google:chrome", "mozilla:firefox", "mozilla:firefox_esr",
  "adobe:acrobat_reader", "adobe:acrobat", "7-zip:7-zip",
  "notepad-plus-plus:notepad-plus-plus", "zoom:zoom",
  "videolan:vlc_media_player", "microsoft:edge", "microsoft:onedrive",
  "microsoft:teams", "git-scm:git", "nodejs:node.js", "microsoft:365_apps"
]
```

`cpe-translations.NOTICE`:
```
Derived from FleetDM cpe_translations.json
Source: https://github.com/fleetdm/fleet/blob/main/server/vulnerabilities/nvd/cpe_translations.json
License: MIT. Converted to {name,vendor,product} via apps/api/scripts/regen-cpe-data.ts.
```
`cpe-dictionary.NOTICE`:
```
Bounded slice derived from tiiuae/cpedict (official CPE dictionary mirror).
Source: https://github.com/tiiuae/cpedict — used as a validation set only.
```

- [ ] **Step 2: Write the regen script (documents provenance; run manually, no runtime use)**

```ts
// apps/api/scripts/regen-cpe-data.ts
/*
 * Regenerates cpe-translations.json from FleetDM's cpe_translations.json.
 * Manual tool — NOT imported at runtime. Run: pnpm tsx scripts/regen-cpe-data.ts
 * Requires network. Preserves the committed starter entries (union, dedup by name).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FLEET_URL =
  'https://raw.githubusercontent.com/fleetdm/fleet/main/server/vulnerabilities/nvd/cpe_translations.json';
const OUT = join(__dirname, '../src/services/__fixtures__/cpe-translations.json');

interface FleetEntry {
  software?: { name?: string[]; source?: string[] };
  filter?: { product?: string[]; vendor?: string[]; skip?: boolean };
}

async function main(): Promise<void> {
  const upstream = (await (await fetch(FLEET_URL)).json()) as FleetEntry[];
  const existing = JSON.parse(readFileSync(OUT, 'utf8')) as Array<{ name: string; vendor: string; product: string }>;
  const byName = new Map(existing.map((e) => [e.name, e]));

  for (const entry of upstream) {
    const names = entry.software?.name ?? [];
    const product = entry.filter?.product?.[0];
    const vendor = entry.filter?.vendor?.[0];
    if (!product || !vendor || entry.filter?.skip) continue;
    for (const name of names) {
      if (name.startsWith('/')) continue;                 // skip regex-pattern entries
      if (!byName.has(name)) byName.set(name, { name, vendor, product });
    }
  }
  const merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');
  console.log(`wrote ${merged.length} translation entries`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Write the failing loader/invariant tests**

```ts
// append to apps/api/src/services/cpeResolver.test.ts
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
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: FAIL — `loadCuratedDictionary is not a function`.

- [ ] **Step 5: Implement loaders in `cpeResolver.ts`**

```ts
// add to apps/api/src/services/cpeResolver.ts
import curatedJson from './__fixtures__/cpe-translations.json';
import cpedictJson from './__fixtures__/cpe-dictionary.json';

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
```

Ensure `apps/api/tsconfig.json` has `resolveJsonModule: true` (the existing `cpeMap.ts` imports JSON, so it already does — verify, no change expected).

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: PASS. The invariant test proves every curated CPE is in the cpedict slice.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/cpeResolver.ts apps/api/src/services/cpeResolver.test.ts \
  apps/api/src/services/__fixtures__/cpe-translations.json apps/api/src/services/__fixtures__/cpe-translations.NOTICE \
  apps/api/src/services/__fixtures__/cpe-dictionary.json apps/api/src/services/__fixtures__/cpe-dictionary.NOTICE \
  apps/api/scripts/regen-cpe-data.ts
git commit -m "feat(vuln): vendored CPE translation + dictionary fixtures and loaders (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `buildCatalogIndex`

**Files:**
- Modify: `apps/api/src/services/cpeResolver.ts`
- Test: `apps/api/src/services/cpeResolver.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `parseCpe` (Tasks 1-2), `CatalogProduct`.
- Produces: `buildCatalogIndex(products: CatalogProduct[]): CatalogIndex`, `CatalogIndex`, `CatalogProduct`.

- [ ] **Step 1: Write the failing test**

```ts
// append to cpeResolver.test.ts
import { buildCatalogIndex, type CatalogProduct } from './cpeResolver';

const CATALOG: CatalogProduct[] = [
  { id: 'p-chrome', normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*' },
  { id: 'p-firefox', normalizedName: 'firefox', normalizedVendor: 'mozilla', cpe: 'cpe:2.3:a:mozilla:firefox:*:*:*:*:*:*:*:*' },
  { id: 'p-acrobat', normalizedName: 'acrobat_reader', normalizedVendor: 'adobe', cpe: 'cpe:2.3:a:adobe:acrobat_reader:*:*:*:*:*:*:*:*' },
];

describe('buildCatalogIndex', () => {
  it('indexes exact name, vendor:product, and words', () => {
    const idx = buildCatalogIndex(CATALOG);
    expect(idx.byExactName.get('chrome')).toBe('p-chrome');
    expect(idx.byVendorProduct.get('google:chrome')).toBe('p-chrome');
    expect(idx.wordIndex.get('acrobat')).toEqual(new Set(['p-acrobat']));
    expect(idx.wordIndex.get('adobe')).toEqual(new Set(['p-acrobat']));
    expect(idx.meta.get('p-firefox')?.cpeVendor).toBe('mozilla');
  });
  it('marks ambiguous exact names null (two products, same normalized_name)', () => {
    const idx = buildCatalogIndex([
      ...CATALOG,
      { id: 'p-chrome2', normalizedName: 'chrome', normalizedVendor: 'other', cpe: 'cpe:2.3:a:other:chrome:*:*:*:*:*:*:*:*' },
    ]);
    expect(idx.byExactName.get('chrome')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: FAIL — `buildCatalogIndex is not a function`.

- [ ] **Step 3: Implement**

```ts
// add to cpeResolver.ts
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
  meta: Map<string, { cpe: string | null; cpeVendor: string | null; cpeProduct: string | null; words: Set<string> }>;
}

export function buildCatalogIndex(products: CatalogProduct[]): CatalogIndex {
  const byExactName = new Map<string, string | null>();
  const byVendorProduct = new Map<string, string>();
  const wordIndex = new Map<string, Set<string>>();
  const meta: CatalogIndex['meta'] = new Map();

  for (const p of products) {
    // exact name: first wins; a second distinct product with same name marks it ambiguous (null)
    if (byExactName.has(p.normalizedName)) {
      byExactName.set(p.normalizedName, null);
    } else {
      byExactName.set(p.normalizedName, p.id);
    }

    const cpeParts = p.cpe ? parseCpe(p.cpe) : null;
    if (cpeParts) byVendorProduct.set(`${cpeParts.vendor}:${cpeParts.product}`, p.id);

    // Product-identity tokens used for scoring (must-hit-a-distinctive-product-word).
    // Prefer the CPE product token; fall back to the catalog normalized_name.
    const productTokens = new Set<string>(
      cpeParts ? tokenize(cpeParts.product) : tokenize(p.normalizedName),
    );

    // Recall index: ANY word (name + vendor + cpe tokens) so candidates are discoverable.
    const recallWords = new Set<string>([
      ...tokenize(p.normalizedName),
      ...(p.normalizedVendor ? tokenize(p.normalizedVendor) : []),
      ...(cpeParts ? [...tokenize(cpeParts.vendor), ...tokenize(cpeParts.product)] : []),
    ]);
    for (const w of recallWords) {
      const set = wordIndex.get(w) ?? new Set<string>();
      set.add(p.id);
      wordIndex.set(w, set);
    }
    meta.set(p.id, { cpe: p.cpe, cpeVendor: cpeParts?.vendor ?? null, cpeProduct: cpeParts?.product ?? null, productTokens });
  }
  return { byExactName, byVendorProduct, wordIndex, meta };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/cpeResolver.ts apps/api/src/services/cpeResolver.test.ts
git commit -m "feat(vuln): catalog inverted index for CPE resolver (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `resolve` — Layer A (curated + exact)

**Files:**
- Modify: `apps/api/src/services/cpeResolver.ts`
- Test: `apps/api/src/services/cpeResolver.test.ts`

**Interfaces:**
- Consumes: `normalizeDisplayName`, `loadCuratedDictionary`, `buildCatalogIndex`, `CatalogIndex`, `CuratedEntry`.
- Produces: `resolve(displayName, vendor, index, curated): Resolution`, `Resolution`, `ResolutionConfidence`, `ResolutionVia`. (Layer B added in Task 5.)

- [ ] **Step 1: Write the failing test**

```ts
// append to cpeResolver.test.ts
import { resolve, loadCuratedDictionary } from './cpeResolver';

describe('resolve — Layer A', () => {
  const idx = buildCatalogIndex(CATALOG);
  const curated = loadCuratedDictionary();

  it('curated dict hit → confidence curated, resolves to catalog product', () => {
    // "Adobe Acrobat Reader DC" → curated {adobe, acrobat_reader} → catalog p-acrobat
    const r = resolve('Adobe Acrobat Reader DC (64-bit)', 'Adobe Inc.', idx, curated);
    expect(r).toMatchObject({ productId: 'p-acrobat', confidence: 'curated', matchedVia: 'dictionary' });
  });

  it('exact normalized-name catalog hit → confidence exact', () => {
    // "Firefox" normalizes to "firefox" which is a catalog normalized_name
    const r = resolve('Firefox', 'Mozilla', idx, curated);
    expect(r).toMatchObject({ productId: 'p-firefox', confidence: 'exact', matchedVia: 'catalog_exact' });
  });

  it('curated hit whose CPE is absent from catalog → productId null, matchedVia dictionary', () => {
    // "Microsoft Teams" is curated but not in this CATALOG
    const r = resolve('Microsoft Teams', 'Microsoft', idx, curated);
    expect(r).toMatchObject({ productId: null, matchedVia: 'dictionary' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: FAIL — `resolve is not a function`.

- [ ] **Step 3: Implement Layer A (Layer B stub withholds for now)**

```ts
// add to cpeResolver.ts
export type ResolutionConfidence = 'curated' | 'exact' | 'fuzzy' | 'none';
export type ResolutionVia = 'dictionary' | 'catalog_exact' | 'token' | 'unmatched';

export interface Resolution {
  productId: string | null;
  cpe: string | null;
  confidence: ResolutionConfidence;
  matchedVia: ResolutionVia;
  tokensMatched: number;
}

const NONE: Resolution = { productId: null, cpe: null, confidence: 'none', matchedVia: 'unmatched', tokensMatched: 0 };

export function resolve(
  displayName: string,
  vendor: string | null,
  index: CatalogIndex,
  curated: Map<string, CuratedEntry>,
): Resolution {
  const normName = normalizeDisplayName(displayName);

  // Layer A.1 — curated translation dictionary
  const curatedHit = curated.get(normName);
  if (curatedHit) {
    const key = `${curatedHit.vendor}:${curatedHit.product}`;
    const productId = index.byVendorProduct.get(key) ?? null;
    const cpe = productId ? index.meta.get(productId)?.cpe ?? null : `cpe:2.3:a:${curatedHit.vendor}:${curatedHit.product}`;
    return { productId, cpe, confidence: productId ? 'curated' : 'none', matchedVia: 'dictionary', tokensMatched: 0 };
  }

  // Layer A.2 — exact catalog normalized-name match
  const exact = index.byExactName.get(normName);
  if (exact) {
    return { productId: exact, cpe: index.meta.get(exact)?.cpe ?? null, confidence: 'exact', matchedVia: 'catalog_exact', tokensMatched: 0 };
  }

  // Layer B added in Task 5.
  return NONE;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: PASS. (The curated-no-catalog case returns `confidence:'none'`, `matchedVia:'dictionary'`, `productId:null`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/cpeResolver.ts apps/api/src/services/cpeResolver.test.ts
git commit -m "feat(vuln): resolver Layer A (curated dict + exact catalog match) (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `resolve` — Layer B (token index + guardrails)

**Files:**
- Modify: `apps/api/src/services/cpeResolver.ts`
- Test: `apps/api/src/services/cpeResolver.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: Layer B behavior inside `resolve` + internal `vendorAgrees`, `VENDOR_ALIASES`, `STOPWORDS`, threshold constants.

- [ ] **Step 1: Write the failing test**

```ts
// append to cpeResolver.test.ts
describe('resolve — Layer B (token) + guardrails', () => {
  // catalog with a long-tail product not covered by curated/exact
  const catalog: CatalogProduct[] = [
    ...CATALOG,
    { id: 'p-7zip', normalizedName: '7-zip', normalizedVendor: '7-zip', cpe: 'cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*' },
    { id: 'p-wireshark', normalizedName: 'wireshark', normalizedVendor: 'wireshark', cpe: 'cpe:2.3:a:wireshark:wireshark:*:*:*:*:*:*:*:*' },
  ];
  const idx = buildCatalogIndex(catalog);
  const curated = loadCuratedDictionary();

  it('token match on long-tail name with vendor agreement → fuzzy', () => {
    // "Wireshark 4.2.0 (64-bit)" normalizes to "wireshark", vendor "Wireshark Foundation"
    const r = resolve('Wireshark 4.2.0 (64-bit)', 'Wireshark Foundation', idx, curated);
    expect(r).toMatchObject({ productId: 'p-wireshark', confidence: 'fuzzy', matchedVia: 'token' });
    expect(r.tokensMatched).toBeGreaterThanOrEqual(1);
  });

  it('GUARDRAIL: Microsoft Edge against a Chrome-only catalog → withheld (no Edge→Chrome)', () => {
    const chromeOnly = buildCatalogIndex([CATALOG[0]!]); // only p-chrome
    const r = resolve('Microsoft Edge', 'Microsoft Corporation', chromeOnly, new Map());
    expect(r.confidence).toBe('none');
    expect(r.productId).toBeNull();
  });

  it('GUARDRAIL: vendor disagreement withholds even if product word overlaps', () => {
    // fake "Chrome Cleanup by Acme" vendor Acme vs catalog google:chrome
    const r = resolve('Chrome Remover', 'Acme Software', buildCatalogIndex([CATALOG[0]!]), new Map());
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: missing vendor → Layer B withholds', () => {
    const r = resolve('Wireshark', null, idx, curated);
    expect(r.confidence).toBe('none');
  });

  it('GUARDRAIL: vendor-only word match (no distinctive product token) withholds', () => {
    // "Microsoft Random Tool" vendor Microsoft, catalog has no such product word
    const withMs: CatalogProduct[] = [{ id: 'p-ms365', normalizedName: '365_apps', normalizedVendor: 'microsoft', cpe: 'cpe:2.3:a:microsoft:365_apps:*:*:*:*:*:*:*:*' }];
    const r = resolve('Microsoft Random Tool', 'Microsoft', buildCatalogIndex(withMs), new Map());
    expect(r.confidence).toBe('none');
  });

  it('vendor alias equivalence (Adobe Inc. ≡ adobe) — via token when not curated', () => {
    const adobeCat = buildCatalogIndex([CATALOG[2]!]); // p-acrobat adobe:acrobat_reader
    const r = resolve('Adobe Acrobat Reader', 'Adobe Inc.', adobeCat, new Map());
    // no curated map passed → must resolve via token with vendor alias agreement
    expect(r).toMatchObject({ productId: 'p-acrobat', confidence: 'fuzzy' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: FAIL — Layer B cases return `none` (stub) where `fuzzy` is expected.

- [ ] **Step 3: Implement Layer B**

Replace the `// Layer B added in Task 5.` line + `return NONE;` with the token logic, and add the helpers:

```ts
// add near top of cpeResolver.ts
const VENDOR_ALIASES: Record<string, string> = {
  'adobe inc.': 'adobe', 'adobe systems': 'adobe', adobe: 'adobe',
  'mozilla': 'mozilla', 'mozilla corporation': 'mozilla', 'mozilla foundation': 'mozilla',
  'google': 'google', 'google llc': 'google', 'google inc.': 'google',
  'microsoft': 'microsoft', 'microsoft corporation': 'microsoft',
  'videolan': 'videolan', 'the videolan project': 'videolan',
  'igor pavlov': '7-zip', '7-zip': '7-zip',
  'wireshark': 'wireshark', 'wireshark foundation': 'wireshark', 'the wireshark developers': 'wireshark',
};
// generic corporate suffixes stripped before alias lookup
const VENDOR_SUFFIX = /\b(inc|inc\.|llc|ltd|corp|corporation|gmbh|co|company|foundation|project|team|the)\b/gi;
const STOPWORDS = new Set(['the', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'gmbh', 'co', 'company', 'software', 'app', 'application', 'tool', 'client', 'edition']);
const MIN_DISTINCTIVE_TOKENS = 1;

function canonicalVendor(vendor: string): string {
  const v = vendor.toLowerCase().trim();
  if (VENDOR_ALIASES[v]) return VENDOR_ALIASES[v];
  const stripped = v.replace(VENDOR_SUFFIX, '').replace(/\s+/g, ' ').trim();
  return VENDOR_ALIASES[stripped] ?? stripped;
}

function vendorAgrees(invVendor: string | null, cpeVendor: string | null): boolean {
  if (!invVendor || !cpeVendor) return false;
  const a = canonicalVendor(invVendor);
  const b = cpeVendor.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}
```

```ts
// replace the Layer B stub in resolve():
  // Layer B — token inverted-index over catalog + hard guardrails.
  const queryWords = new Set(tokenize(normName));
  if (queryWords.size === 0) return NONE;

  // Recall: candidate productIds = union of products containing any query word.
  const candidates = new Set<string>();
  for (const w of queryWords) for (const id of index.wordIndex.get(w) ?? []) candidates.add(id);

  // Score = number of query words that match a candidate's PRODUCT tokens (not vendor-only).
  // Using product tokens directly encodes "must hit a distinctive product word" AND still
  // matches products whose name equals their vendor (wireshark:wireshark, 7-zip:7-zip).
  let best: { id: string; score: number } | null = null;
  let runnerUp = 0;
  for (const id of candidates) {
    const m = index.meta.get(id)!;
    if (!vendorAgrees(vendor, m.cpeVendor)) continue;                       // vendor agreement (kills Edge→Chrome)
    let score = 0;
    for (const w of queryWords) {
      if (STOPWORDS.has(w)) continue;
      if (m.productTokens.has(w)) score += 1;                               // distinctive product-token hit
    }
    if (score < MIN_DISTINCTIVE_TOKENS) continue;
    if (!best || score > best.score) {
      runnerUp = best ? best.score : 0;
      best = { id, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best) return NONE;
  if (best.score <= runnerUp) return NONE;                                   // unique-winner margin (ties withhold)

  const m = index.meta.get(best.id)!;
  if (m.cpe && !isWellFormedCpe(m.cpe)) return NONE;                         // well-formedness guard
  return { productId: best.id, cpe: m.cpe, confidence: 'fuzzy', matchedVia: 'token', tokensMatched: best.score };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run src/services/cpeResolver.test.ts`
Expected: PASS — all Layer B + guardrail cases. Edge→Chrome and vendor-disagreement return `none`; the vendor-alias Adobe case resolves via token.

- [ ] **Step 5: Run the whole resolver suite + typecheck**

Run: `pnpm test:run src/services/cpeResolver.test.ts && pnpm --filter @breeze/api typecheck` (or the repo's `pnpm typecheck`).
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/cpeResolver.ts apps/api/src/services/cpeResolver.test.ts
git commit -m "feat(vuln): resolver Layer B token match with vendor/uniqueness guardrails (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Schema + migration + RLS registration

**Files:**
- Create: `apps/api/migrations/2026-07-08-vuln-product-resolutions.sql`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Produces: `softwareProductResolutions` Drizzle table; `deviceVulnerabilities.matchConfidence` column.

- [ ] **Step 1: Write the migration**

```sql
-- apps/api/migrations/2026-07-08-vuln-product-resolutions.sql
-- Global DisplayName→product resolution cache + unmatched-name log (#2290).
-- System-only RLS, same shape as vulnerabilities/software_products.

CREATE TABLE IF NOT EXISTS software_product_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_name VARCHAR(500) NOT NULL,          -- lower(trim(software_inventory.name)) — SQL join key
  lookup_vendor VARCHAR(200),                 -- lower(trim(software_inventory.vendor))
  normalized_name VARCHAR(500) NOT NULL,      -- post-token-strip form (observability only)
  software_product_id UUID REFERENCES software_products(id),  -- NULL = unmatched (the log)
  confidence VARCHAR(16) NOT NULL,            -- curated | exact | fuzzy | none
  matched_via VARCHAR(32) NOT NULL,           -- dictionary | catalog_exact | token | unmatched
  resolver_version INTEGER NOT NULL,
  resolved_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS software_product_resolutions_key_idx
  ON software_product_resolutions (lookup_name, lookup_vendor) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS software_product_resolutions_product_idx
  ON software_product_resolutions (software_product_id);

ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(16);

-- System-only RLS (mirror 2026-06-22-vulnerability-management.sql). Forced RLS with a
-- single system-scope policy; breeze_app (non-BYPASSRLS) is denied unless scope=system.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE software_product_resolutions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE software_product_resolutions FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'software_product_resolutions'
      AND policyname = 'software_product_resolutions_system_only'
  ) THEN
    EXECUTE $f$CREATE POLICY software_product_resolutions_system_only ON software_product_resolutions
      USING (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system')$f$;
  END IF;
END $$;
```

- [ ] **Step 2: Add the Drizzle schema**

```ts
// add to apps/api/src/db/schema/vulnerabilityManagement.ts
export const softwareProductResolutions = pgTable('software_product_resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  lookupName: varchar('lookup_name', { length: 500 }).notNull(),
  lookupVendor: varchar('lookup_vendor', { length: 200 }),
  normalizedName: varchar('normalized_name', { length: 500 }).notNull(),
  softwareProductId: uuid('software_product_id').references(() => softwareProducts.id),
  confidence: varchar('confidence', { length: 16 }).notNull(),
  matchedVia: varchar('matched_via', { length: 32 }).notNull(),
  resolverVersion: integer('resolver_version').notNull(),
  resolvedAt: timestamp('resolved_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  keyIdx: uniqueIndex('software_product_resolutions_key_idx').on(table.lookupName, table.lookupVendor),
  productIdx: index('software_product_resolutions_product_idx').on(table.softwareProductId),
}));
```

Add `integer` to the `drizzle-orm/pg-core` import at the top of the file (it currently imports `numeric` etc. but confirm `integer` is present; add if missing). Add `matchConfidence: varchar('match_confidence', { length: 16 })` to the `deviceVulnerabilities` table definition (nullable — no `.notNull()`).

- [ ] **Step 3: Register in the RLS contract test**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, add to the `INTENTIONAL_UNSCOPED` set (after the `os_vulnerabilities` line, ~line 66):

```ts
  'software_product_resolutions', // Global DisplayName→product resolution cache/log (#2290). Forced RLS, system-only policy → only system context.
```

- [ ] **Step 4: Verify migration + drift + RLS coverage against the test DB**

```bash
# from repo root
docker compose -f docker-compose.test.yml up -d --wait
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"   # test DB (:5433)
pnpm db:check-drift        # schema must match migrations — no drift
pnpm test:rls-coverage     # software_product_resolutions must be recognized system-only
```
Expected: drift check clean; RLS coverage passes (no "table has RLS but is not registered" failure).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-08-vuln-product-resolutions.sql \
  apps/api/src/db/schema/vulnerabilityManagement.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(vuln): software_product_resolutions table + match_confidence column, system-only RLS (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `refreshResolutionCache()` (DB, system context)

**Files:**
- Create: `apps/api/src/services/cpeResolution.ts`
- Create: `apps/api/src/services/cpeResolution.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts`

**Interfaces:**
- Consumes: `resolve`, `buildCatalogIndex`, `loadCuratedDictionary`, `RESOLVER_VERSION`, `CatalogProduct` (Tasks 1-5); `softwareProductResolutions`, `softwareProducts`, `softwareInventory` schema; `db`, `withSystemDbAccessContext`.
- Produces: `refreshResolutionCache(): Promise<Record<ResolutionConfidence, number>>`.

- [ ] **Step 1: Register the new integration test file**

In `apps/api/vitest.integration.config.ts`, add to the `include` array (alongside the other vuln integration tests):

```ts
      // Co-located real-DB integration test for the DisplayName→CPE resolution cache (#2290).
      'src/services/cpeResolution.integration.test.ts',
```

- [ ] **Step 2: Write the failing integration test**

```ts
// apps/api/src/services/cpeResolution.integration.test.ts
import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import {
  devices, organizations, partners, sites,
  softwareInventory, softwareProducts, softwareProductResolutions,
} from '../db/schema';
import { refreshResolutionCache } from './cpeResolution';
import { RESOLVER_VERSION } from './cpeResolver';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDeviceAndInventory(name: string, vendor: string | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const u = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [p] = await db.insert(partners).values({ name: `P ${u}`, slug: `p-${u}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: `O ${u}`, slug: `o-${u}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `S ${u}` }).returning({ id: sites.id });
    const [d] = await db.insert(devices).values({ orgId: o!.id, siteId: s!.id, agentId: `a-${u}`, hostname: `h-${u}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline' }).returning({ id: devices.id });
    await db.insert(softwareInventory).values({ orgId: o!.id, deviceId: d!.id, name, vendor, version: '1.0' });
  });
}

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(softwareProductResolutions);
    await db.delete(softwareInventory);
    await db.delete(softwareProducts);
  });
});

describe('refreshResolutionCache', () => {
  runDb('resolves a curated DisplayName to a catalog product', async () => {
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' });
    });
    await seedDeviceAndInventory('Google Chrome (64-bit)', 'Google LLC');

    const counts = await refreshResolutionCache();
    expect(counts.curated + counts.exact + counts.fuzzy).toBeGreaterThanOrEqual(1);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'google chrome (64-bit)')));
    expect(rows[0]?.softwareProductId).not.toBeNull();
    expect(rows[0]?.resolverVersion).toBe(RESOLVER_VERSION);
  });

  runDb('logs an unmatched DisplayName with NULL product', async () => {
    await seedDeviceAndInventory('Totally Bespoke Internal Tool XYZ', 'Some Vendor');
    await refreshResolutionCache();
    const unmatched = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(isNull(softwareProductResolutions.softwareProductId)));
    expect(unmatched.length).toBeGreaterThanOrEqual(1);
    expect(unmatched[0]?.confidence).toBe('none');
  });

  runDb('is idempotent — re-run does not duplicate rows', async () => {
    await seedDeviceAndInventory('Google Chrome', 'Google LLC');
    await refreshResolutionCache();
    await refreshResolutionCache();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ n: sql<number>`count(*)::int` }).from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'google chrome')));
    expect(rows[0]?.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"
pnpm test:integration src/services/cpeResolution.integration.test.ts
```
Expected: FAIL — `refreshResolutionCache` not found / module missing.

- [ ] **Step 4: Implement `refreshResolutionCache`**

```ts
// apps/api/src/services/cpeResolution.ts
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { softwareInventory, softwareProducts, softwareProductResolutions } from '../db/schema';
import {
  RESOLVER_VERSION, buildCatalogIndex, loadCuratedDictionary, resolve,
  type CatalogProduct, type ResolutionConfidence,
} from './cpeResolver';

/**
 * Global pass: resolve every distinct (lower(trim(name)), lower(trim(vendor))) in
 * software_inventory against the catalog and upsert into software_product_resolutions.
 * Skips keys already resolved at the current RESOLVER_VERSION; re-resolves rows from an
 * older version (self-healing as the dictionary/catalog grows). System context only —
 * software_product_resolutions and the catalog are global system-only tables.
 */
export async function refreshResolutionCache(): Promise<Record<ResolutionConfidence, number>> {
  const counts: Record<ResolutionConfidence, number> = { curated: 0, exact: 0, fuzzy: 0, none: 0 };

  await withSystemDbAccessContext(async () => {
    const products = await db
      .select({ id: softwareProducts.id, normalizedName: softwareProducts.normalizedName, normalizedVendor: softwareProducts.normalizedVendor, cpe: softwareProducts.cpe })
      .from(softwareProducts);
    const index = buildCatalogIndex(products as CatalogProduct[]);
    const curated = loadCuratedDictionary();

    // distinct SQL-reproducible keys, plus a representative original name for normalization
    const keys = await db
      .select({
        lookupName: sql<string>`lower(trim(${softwareInventory.name}))`,
        lookupVendor: sql<string | null>`lower(trim(${softwareInventory.vendor}))`,
        sampleName: sql<string>`min(${softwareInventory.name})`,
      })
      .from(softwareInventory)
      .groupBy(sql`lower(trim(${softwareInventory.name}))`, sql`lower(trim(${softwareInventory.vendor}))`);

    // keys already resolved at the current version → skip
    const existing = await db
      .select({ lookupName: softwareProductResolutions.lookupName, lookupVendor: softwareProductResolutions.lookupVendor, resolverVersion: softwareProductResolutions.resolverVersion })
      .from(softwareProductResolutions);
    const currentByKey = new Map<string, number>();
    for (const e of existing) currentByKey.set(`${e.lookupName} ${e.lookupVendor ?? ''}`, e.resolverVersion);

    for (const k of keys) {
      const dedupeKey = `${k.lookupName} ${k.lookupVendor ?? ''}`;
      if (currentByKey.get(dedupeKey) === RESOLVER_VERSION) continue;

      const r = resolve(k.sampleName, k.lookupVendor, index, curated);
      counts[r.confidence] += 1;

      await db
        .insert(softwareProductResolutions)
        .values({
          lookupName: k.lookupName,
          lookupVendor: k.lookupVendor,
          normalizedName: r.matchedVia === 'unmatched' ? k.lookupName : k.sampleName,
          softwareProductId: r.productId,
          confidence: r.confidence,
          matchedVia: r.matchedVia,
          resolverVersion: RESOLVER_VERSION,
          resolvedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [softwareProductResolutions.lookupName, softwareProductResolutions.lookupVendor],
          set: {
            softwareProductId: r.productId,
            confidence: r.confidence,
            matchedVia: r.matchedVia,
            resolverVersion: RESOLVER_VERSION,
            resolvedAt: new Date(),
          },
        });
    }
  });

  console.log('[cpeResolution] refresh complete', counts);
  return counts;
}
```

Note on the unique index + `onConflictDoUpdate`: the index is `NULLS NOT DISTINCT`, so a null-vendor key has a single conflict target row. Drizzle emits `ON CONFLICT (lookup_name, lookup_vendor) DO UPDATE`; Postgres 16 matches the `NULLS NOT DISTINCT` unique index. If Drizzle cannot target it, fall back to `.onConflictDoUpdate({ target: sql\`(lookup_name, lookup_vendor)\`, ... })`.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm test:integration src/services/cpeResolution.integration.test.ts
```
Expected: PASS (curated resolve, unmatched-null log, idempotent re-run).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/cpeResolution.ts apps/api/src/services/cpeResolution.integration.test.ts apps/api/vitest.integration.config.ts
git commit -m "feat(vuln): refreshResolutionCache — global DisplayName resolution pass (#2290)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Rewrite correlation joins + stamp confidence + wire into cycle

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts:188-275` (the two candidate queries) + `upsertDeviceVulnerability`
- Modify: `apps/api/src/services/vulnerabilityCorrelation.integration.test.ts`
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts` (`correlateEnabledOrgs`, ~line 829-847)

**Interfaces:**
- Consumes: `softwareProductResolutions` schema; `refreshResolutionCache` (Task 7).
- Produces: correlation findings carrying `match_confidence`; refresh wired ahead of per-org correlation.

- [ ] **Step 1: Write the failing integration test**

```ts
// add to apps/api/src/services/vulnerabilityCorrelation.integration.test.ts
// (imports: add softwareProductResolutions to the schema import; import refreshResolutionCache)
import { refreshResolutionCache } from './cpeResolution';
import { softwareProductResolutions } from '../db/schema';

// add to the beforeEach delete list: await db.delete(softwareProductResolutions);

async function seedInventory(orgId: string, deviceId: string, name: string, vendor: string | null, version: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.insert(softwareInventory).values({ orgId, deviceId, name, vendor, version });
  });
}

describe('correlation via resolver', () => {
  runDb('a noisy Windows DisplayName correlates to a catalog CVE with match_confidence', async () => {
    const { orgId, deviceId } = await seedOrgWithDevice();
    await withSystemDbAccessContext(async () => {
      const [prod] = await db.insert(softwareProducts).values({ normalizedName: 'acrobat_reader', normalizedVendor: 'adobe', cpe: 'cpe:2.3:a:adobe:acrobat_reader:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' }).returning({ id: softwareProducts.id });
      const [vuln] = await db.insert(vulnerabilities).values({ cveId: 'CVE-2025-0001', source: 'nvd', description: 'x', severity: 'critical', cvssVersion: '3.1', cvssScore: '9.8', patchAvailable: true, rawPayload: { t: true } }).returning({ id: vulnerabilities.id });
      await db.insert(softwareVulnerabilities).values({ productId: prod!.id, vulnerabilityId: vuln!.id, versionEndExcluding: '99.0' });
    });
    // curated dict maps "Adobe Acrobat Reader DC" → adobe:acrobat_reader
    await seedInventory(orgId, deviceId, 'Adobe Acrobat Reader DC (64-bit)', 'Adobe Inc.', '23.0');

    await refreshResolutionCache();
    const res = await correlateOrg(orgId, { deviceIds: [deviceId] });
    expect(res.created).toBe(1);

    const findings = await withSystemDbAccessContext(() =>
      db.select().from(deviceVulnerabilities).where(eq(deviceVulnerabilities.orgId, orgId)));
    expect(findings[0]?.matchConfidence).toBe('curated');
  });

  runDb('Microsoft Edge against a Chrome-only catalog produces NO finding', async () => {
    const { orgId, deviceId } = await seedOrgWithDevice();
    await withSystemDbAccessContext(async () => {
      const [prod] = await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' }).returning({ id: softwareProducts.id });
      const [vuln] = await db.insert(vulnerabilities).values({ cveId: 'CVE-2025-0002', source: 'nvd', description: 'x', severity: 'high', cvssVersion: '3.1', cvssScore: '7.5', patchAvailable: true, rawPayload: { t: true } }).returning({ id: vulnerabilities.id });
      await db.insert(softwareVulnerabilities).values({ productId: prod!.id, vulnerabilityId: vuln!.id, versionEndExcluding: '999.0' });
    });
    await seedInventory(orgId, deviceId, 'Microsoft Edge', 'Microsoft Corporation', '120.0');

    await refreshResolutionCache();
    const res = await correlateOrg(orgId, { deviceIds: [deviceId] });
    expect(res.created).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test:integration src/services/vulnerabilityCorrelation.integration.test.ts
```
Expected: FAIL — the Adobe DisplayName does not join under the current `lower(name)=lower(name)` query (created=0, expected 1); `matchConfidence` undefined.

- [ ] **Step 3: Rewrite the two candidate joins through resolutions**

In `vulnerabilityCorrelation.ts`, replace BOTH product-join blocks (the `fixedBuildCandidates` query at ~200-218 and the `cpeRangeCandidates` query at ~257-275). For each, replace:

```ts
      .from(softwareInventory)
      .innerJoin(
        softwareProducts,
        sql`lower(${softwareProducts.normalizedName}) = lower(trim(${softwareInventory.name}))`
      )
```

with a join through the resolution cache on the SQL-reproducible key, and select the confidence:

```ts
      .from(softwareInventory)
      .innerJoin(
        softwareProductResolutions,
        sql`${softwareProductResolutions.lookupName} = lower(trim(${softwareInventory.name}))
            AND ${softwareProductResolutions.lookupVendor} IS NOT DISTINCT FROM lower(trim(${softwareInventory.vendor}))`
      )
      .innerJoin(
        softwareProducts,
        eq(softwareProducts.id, softwareProductResolutions.softwareProductId)
      )
```

Add `matchConfidence: softwareProductResolutions.confidence` to BOTH `.select({...})` projections, and add `softwareProductResolutions` to the schema import. (The `innerJoin` on `softwareProducts.id = resolutions.software_product_id` naturally excludes unmatched `NULL` rows.)

- [ ] **Step 4: Thread `matchConfidence` into `upsertDeviceVulnerability`**

Add `matchConfidence: string | null` to the `upsertDeviceVulnerability` args, set it on both insert and update:

```ts
// in the .insert(...).values({...}) add:
      matchConfidence: args.matchConfidence,
// in the .update(...).set({...}) add:
      matchConfidence: args.matchConfidence,
```

and pass `matchConfidence: candidate.matchConfidence` from both correlation loops. For `correlateOsVulns` (OS findings), pass `matchConfidence: null` (OS path has no product resolution).

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm test:integration src/services/vulnerabilityCorrelation.integration.test.ts
```
Expected: PASS — Adobe DisplayName now creates 1 finding with `matchConfidence='curated'`; Edge produces 0 findings.

- [ ] **Step 6: Wire `refreshResolutionCache` into the correlation cycle**

In `vulnerabilityJobs.ts` `correlateEnabledOrgs` (~line 829), call `refreshResolutionCache()` ONCE before the per-org loop (it opens its own system context; call it before/outside any per-org context, consistent with the existing "each opens its own system context" comment):

```ts
// near the top of correlateEnabledOrgs, before iterating orgs:
import { refreshResolutionCache } from '../services/cpeResolution';
// ...
  await refreshResolutionCache();
```

Add the import at the top of the file next to the existing `correlateOrg`/`correlateOsVulns` import.

- [ ] **Step 7: Full regression — resolver unit + all vuln integration + drift**

```bash
cd apps/api
pnpm test:run src/services/cpeResolver.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"
pnpm test:integration src/services/cpeResolution.integration.test.ts src/services/vulnerabilityCorrelation.integration.test.ts
pnpm db:check-drift
pnpm typecheck
```
Expected: all PASS; no drift; no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/vulnerabilityCorrelation.ts \
  apps/api/src/services/vulnerabilityCorrelation.integration.test.ts \
  apps/api/src/jobs/vulnerabilityJobs.ts
git commit -m "feat(vuln): correlate through resolution cache + stamp match_confidence (#2290)

Correlation joins software_inventory→software_product_resolutions→software_products
on lower(trim(name)); refreshResolutionCache runs once per correlation cycle.
Fixes the DisplayName mismatch that surfaced only Chrome for Windows fleets.

Closes #2290

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation verification (not a code task)

1. **Full API suite** (single-fork to avoid the known parallel flakiness — memory `api_test_suite_parallel_flakiness`): `cd apps/api && pnpm test:run` and `pnpm test:docker` for integration.
2. **Live read-only sanity (NO prod mutation):** after merge + a correlation cycle, re-query US prod read-only (Tailscale SSH to the US prod droplet — address in gitignored `internal/` notes — then `docker run --rm postgres:16-alpine psql "$DATABASE_URL" -c "..."`, secret stays on the droplet) to confirm the count of DISTINCT surfaced products in `device_vulnerabilities` (joined to `software_inventory.name`) jumps well beyond Chrome. Report before/after counts.
3. **PR:** open against `main`; run `/code-review` and the pr-review-toolkit before requesting merge. Do NOT merge/close — hand back for review (per repo workflow).

## Spec B (#2291) — deferred

Windows OS correlation is a SEPARATE spec/plan authored after this lands, gated on #2261 (MSRC sync health). Not in scope here.
