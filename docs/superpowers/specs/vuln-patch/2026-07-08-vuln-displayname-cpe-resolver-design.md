# DisplayName → CPE Resolver for Vulnerability Correlation (#2290)

**Status:** Design approved, pre-implementation
**Date:** 2026-07-08
**Issue:** #2290 (this spec). Related: #2292 (merged/open — case-insensitive join, the prerequisite), #2291 (Windows OS correlation — separate Spec B), #2261 (MSRC sync health — blocks Spec B).

## Problem

The Vulnerabilities dashboard surfaces only Google Chrome for a 24-device Windows
fleet despite ~1,841 distinct installed apps and a catalog of ~3,449 CPE-bearing
`software_products`. Root cause is the device→catalog correlation, not the catalog.

`correlateOrg` (`apps/api/src/services/vulnerabilityCorrelation.ts`) joins:

```sql
software_inventory JOIN software_products
  ON lower(software_products.normalized_name) = lower(trim(software_inventory.name))
```

`software_inventory.name` is a raw Windows-registry DisplayName carrying
locale/edition/arch/version noise — `"Adobe Acrobat (64-bit)"`,
`"Microsoft 365 Apps for business - en-us"`, `"Mozilla Firefox ESR 115 (x64 en-US)"`.
A catalog `normalized_name` is a clean product token (CPE-derived, e.g. `acrobat_reader`,
`365_apps`, `firefox`). The two are never string-equal even case-insensitively, so the
join misses nearly everything. #2292 fixed casing; this spec fixes the structural
mismatch. Vendor is currently ignored by the join, discarding a strong disambiguator.

Note: NVD sync only creates match facts (`software_vulnerabilities`) for CPEs **already
present** in the catalog (`buildCuratedCpeProductMap` maps existing CPE → productId).
Therefore the resolver's job is to **link an inventory DisplayName to an existing
catalog `software_products` row**, not to mint new CPEs. Minting a CPE with no match
facts surfaces nothing.

## Non-goals

- Fuzzy/similarity *scoring* as the match decision (loose matching produces false
  positives like Edge→Chrome). Layer B uses deterministic token-set logic with hard
  guardrails, not a similarity score that "wins" by being closest.
- Rewriting existing `software_products.normalized_name` rows. The `(normalized_name,
  normalized_vendor)` unique index makes bulk-lowercasing collision-prone; we keep the
  read-side `lower()` as the normalization invariant instead (decision below).
- Windows OS-level CVEs (#2291 — separate Spec B, gated on #2261).

## Decisions (locked in brainstorming)

1. **Global resolution-cache table** between inventory and catalog. Not per-inventory-row
   FK, not inline-in-memory. DisplayNames repeat fleet-wide, so a global cache is compact,
   cross-org, auditable, and cheap to re-run. Rows with `software_product_id IS NULL` **are**
   the unmatched-name log.
2. **Keep read-side `lower()` invariant** — no normalize-on-write backfill migration
   (avoids unique-index collisions). New writes continue through the same normalizer.
3. **Two specs.** Ship #2290 (this) first. #2291 is Spec B, gated on #2261.
4. **Vendor bounded fixtures + port algorithm** — no runtime network. FleetDM
   `cpe_translations` (MIT), CIRCL cpe-guesser algorithm (BSD-2, ported to TS), tiiuae
   cpedict slice (validation set), each with attribution.
5. **Token-matched links feed findings, stamped `fuzzy`** so the UI can badge
   lower-confidence matches. Guardrails keep FPs near zero; below-threshold names are
   withheld (no finding) and logged for Layer-A growth. Nothing silently hidden.
6. **Cache populated by a global pass per correlation cycle** (`refreshResolutionCache()`
   in `correlateEnabledOrgs`, before the per-org loop), versioned + self-healing.

## Architecture

```
software_inventory.name / vendor
        │  normalizeDisplayName() + normalizeVendor()
        ▼
┌─────────────────────────────────────────────┐
│  cpeResolver.ts  (pure, no DB)               │
│  Layer A: curated dict + exact catalog name  │
│  Layer B: token inverted-index + guardrails  │
└─────────────────────────────────────────────┘
        │  writes (via refreshResolutionCache)
        ▼
software_product_resolutions   (NEW, global, system-only RLS)
  (lookup_name, lookup_vendor) → software_product_id | NULL
        │  join
        ▼
correlateOrg / correlateOsVulns
  software_inventory ⋈ software_product_resolutions ⋈ software_products
                     ⋈ software_vulnerabilities ⋈ vulnerabilities
```

### Components

- **`apps/api/src/services/cpeResolver.ts`** — pure resolver. No DB access.
  - `normalizeDisplayName(name: string): string` — deterministic token strip.
  - `buildCatalogIndex(products): CatalogIndex` — inverted word→productId index built once.
  - `resolve(name, vendor, index): Resolution` where
    `Resolution = { productId: string | null; cpe: string | null;
    confidence: 'curated' | 'exact' | 'fuzzy' | 'none';
    matchedVia: 'dictionary' | 'catalog_exact' | 'token' | 'unmatched';
    tokensMatched: number }`.
  - Deterministic and unit-testable with only the vendored fixtures.

- **`software_product_resolutions`** (NEW table) — the cache and the unmatched log.

- **`refreshResolutionCache(): Promise<{ resolved: Record<confidence, number> }>`**
  (new export, likely in `vulnerabilityCorrelation.ts` or a sibling `cpeResolution.ts`) —
  global pass under `withSystemDbAccessContext`:
  1. `SELECT DISTINCT lower(trim(name)) AS lookup_name, lower(trim(vendor)) AS lookup_vendor
     FROM software_inventory` — the **SQL-reproducible** join key.
  2. For each not present at the current `resolver_version` (or present but `NULL`/`fuzzy`
     from an older version): apply full `normalizeDisplayName()` + `resolve()` in TS, then
     upsert into `software_product_resolutions` keyed by `(lookup_name, lookup_vendor)`.
  3. Return per-confidence counts; emit a structured log line.

- **`correlateOrg` / `correlateOsVulns`** — the `lower()=lower()` product joins are
  **replaced** by a join through `software_product_resolutions` on the SQL-reproducible key:
  `software_inventory ⋈ software_product_resolutions
    ON (resolutions.lookup_name = lower(trim(software_inventory.name))
        AND resolutions.lookup_vendor IS NOT DISTINCT FROM lower(trim(software_inventory.vendor)))
   ⋈ software_products ON software_products.id = resolutions.software_product_id`.
  **Key design point:** the join key is `lower(trim(name))` (expressible in SQL), NOT the
  heavily-normalized name — full token-strip normalization is a multi-step TS operation that
  cannot run in the join. The resolver applies that normalization *during refresh* to decide
  which `software_product_id` a raw key maps to; the SQL join is then a plain equality on the
  stored lowercased key. Resolution `confidence` is carried onto the created
  `device_vulnerabilities.match_confidence`.

## Resolver algorithm

### Normalization (`normalizeDisplayName`)
Deterministic, order-preserving:
- lowercase, trim, collapse internal whitespace.
- strip architecture tokens: `64-bit`, `32-bit`, `x64`, `x86`, `amd64`, `arm64`, and their
  parenthetical forms `(64-bit)` etc.
- strip locale tokens: `ll-CC` pattern (`en-us`, `de-de`, …) and a bounded spelled-out
  language list.
- strip trailing version numbers, 4-digit years, `- <locale>` suffixes, and
  publisher-year parentheticals.
- **never** strip the distinctive product word(s).

Unit tests pin the exact behavior with a table of real DisplayName → normalized cases.

### Layer A — exact, high-confidence
1. **Curated translation dictionary**: FleetDM `cpe_translations` merged with the existing
   8-entry `cpe-map.json`, keyed on normalized name → CPE (+ vendor). Match ⇒
   `confidence='curated'`, `matchedVia='dictionary'`.
2. **Exact catalog match**: normalized name equals a catalog `normalized_name`. Match ⇒
   `confidence='exact'`, `matchedVia='catalog_exact'`.

### Layer B — token inverted-index (cpe-guesser port), long tail
- Build once: for each catalog product, index the word-set of its `normalized_name` +
  `normalized_vendor` (+ CPE vendor/product tokens) → productId.
- Query word-set = normalized DisplayName words + vendor words. Rank candidates by count
  of matching **distinctive** words (vendor-only stopwords excluded from the count).
- **Guardrails — ALL must hold, else withhold** (`confidence='none'`, `productId=null`,
  logged):
  - **Vendor agreement** — normalized inventory vendor consistent with the candidate CPE
    vendor token: equality, or via a small vendor-alias map (`adobe inc.`→`adobe`,
    `mozilla`→`mozilla`, `microsoft corporation`→`microsoft`, …). *This kills Edge→Chrome*
    (Microsoft ≠ google) before product tokens are even considered. If inventory vendor is
    absent, vendor agreement cannot be established ⇒ Layer B withholds (curated/exact still
    apply).
  - **Distinctive-product-token agreement** — at least one non-vendor, non-stopword product
    token must match, so a shared vendor word alone ("microsoft") never matches.
  - **Unique winner** — the top candidate must beat the runner-up by a margin; ties withhold.
  - **Score threshold** — minimum matched-distinctive-token count.
- Pass all ⇒ `confidence='fuzzy'`, `matchedVia='token'`.

### cpedict validation guard
The vendored real-CPE dictionary (`cpe-dictionary.json`) is used to (1) assert at test time
that every curated-dictionary CPE is a real CPE (guards against typo/rot), and (2) reject at
resolve time any resolved CPE absent from cpedict. Because Layer A/B resolve to *existing*
catalog products (already real NVD CPEs), this primarily protects the curated layer.

### `resolver_version`
A module constant bumped whenever normalization rules, the dictionary, or guardrail
thresholds change. `refreshResolutionCache()` re-resolves rows whose `resolver_version` is
older, and always re-attempts `NULL`/`fuzzy` rows on a bump (self-healing as data grows).

## Schema

New global table — **system-only RLS**, same shape as the four existing global vuln tables
(`vulnerabilities`, `software_products`, `software_vulnerabilities`, `os_vulnerabilities`).
It is NOT tenant-scoped; correlation reads/writes it under `withSystemDbAccessContext`.

```
software_product_resolutions
  id                    uuid pk default gen_random_uuid()
  lookup_name           varchar(500) not null   -- lower(trim(software_inventory.name)) — the SQL join key
  lookup_vendor         varchar(200)            -- lower(trim(software_inventory.vendor)) — nullable
  normalized_name       varchar(500) not null   -- post-token-strip form (debug/observability only)
  software_product_id   uuid null references software_products(id)  -- NULL = unmatched (log)
  confidence            varchar(16) not null     -- curated | exact | fuzzy | none
  matched_via           varchar(32) not null     -- dictionary | catalog_exact | token | unmatched
  resolver_version      integer not null
  resolved_at           timestamp not null
  created_at            timestamp not null default now()
  UNIQUE NULLS NOT DISTINCT (lookup_name, lookup_vendor)   -- null-vendor keys collapse to one row (PG16)
  index on (software_product_id)
```

The join/upsert key is `(lookup_name, lookup_vendor)` — the lowercased-trimmed raw values,
reproducible in the correlation SQL. `normalized_name` is stored only for debugging and to
show what the resolver reduced the DisplayName to; it is never a join key.

Additive column on the existing org-scoped findings table:

```
device_vulnerabilities.match_confidence  varchar(16)  -- nullable; curated|exact|fuzzy
```

### Migration
- `apps/api/migrations/2026-07-08-vuln-product-resolutions.sql` (date-prefixed).
- Idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`, `pg_policies` existence check before
  `CREATE POLICY` (copy an existing system-only policy verbatim — likely from the
  `vulnerabilities` table migration).
- No inner `BEGIN;/COMMIT;`. Re-application is a no-op.
- `UNIQUE NULLS NOT DISTINCT (lookup_name, lookup_vendor)` so null-vendor rows collapse to one
  key on upsert (Postgres 15+; prod + test are PG16).

### RLS contract test
Register `software_product_resolutions` in the **system-scoped** allowlist in
`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` in the same PR.
Verify as `breeze_app` that a cross-tenant read/insert is denied.

## External data vendoring

`apps/api/src/services/__fixtures__/`:
- `cpe-translations.json` — converted from FleetDM `server/vulnerabilities/nvd/
  cpe_translations.json` (MIT). Add `cpe-translations.NOTICE` with source URL + license.
- `cpe-dictionary.json` — bounded slice of `tiiuae/cpedict` used as the validation set.
  Attribution in a `NOTICE`.
- `scripts/regen-cpe-data.ts` — documents provenance and regenerates both fixtures; run
  manually, not at build/runtime. **No runtime network.**
- cpe-guesser algorithm ported to TS inside `cpeResolver.ts` with a BSD-2 attribution
  header. Anonymized — no customer names/IPs anywhere (repo is PUBLIC).

Fixture size is bounded to keep the API bundle reasonable; the API `dts:false` build
constraint (memory: `api_dts_build_oom`) is unaffected since these are JSON data, not types.

## Observability & Layer-A growth loop

`software_product_resolutions` rows with `software_product_id IS NULL` (unmatched) or
`confidence='fuzzy'` are the log — queryable directly, ordered by fleet frequency
(join back to `software_inventory` count), to prioritize new curated dictionary entries.
`refreshResolutionCache()` emits a structured summary line: counts by confidence per run.

## Testing (TDD — real Postgres on :5433, redis :6380)

Bring up: `docker compose -f docker-compose.test.yml up -d` (setup.ts auto-migrates +
provisions `breeze_app`). Pattern: `vulnerabilityCorrelation.integration.test.ts`.

- **Unit — `cpeResolver.test.ts`**:
  - `normalizeDisplayName` table-driven cases (arch/locale/edition/version strip; keep
    distinctive words).
  - Layer A curated + exact hits.
  - Layer B token match on a realistic long-tail DisplayName.
  - **Edge≠Chrome** and other cross-vendor FP guards return `confidence='none'`.
  - Vendor-alias equivalence; missing-vendor ⇒ Layer B withholds.
  - Unique-winner margin + score-threshold withholding.
  - Invariant: every curated-dictionary CPE exists in `cpe-dictionary.json`.
- **Integration — `cpeResolution.integration.test.ts`** (new) + additions to
  `vulnerabilityCorrelation.integration.test.ts`:
  - Seed `"Adobe Acrobat (64-bit)"` (vendor `"Adobe Inc."`) + catalog `acrobat_reader`
    product + match fact ⇒ finding created with `match_confidence='curated'|'exact'`.
  - Seed `"Mozilla Firefox ESR 115 (x64 en-US)"` ⇒ resolves to `firefox`, finding created.
  - Seed a Microsoft Edge DisplayName against a Chrome-only catalog ⇒ **no finding**;
    resolution row logged with `confidence='none'`.
  - Unmatched DisplayName ⇒ `software_product_id IS NULL` row present.
  - `refreshResolutionCache()` is idempotent and self-heals on `resolver_version` bump.
  - RLS: `software_product_resolutions` denies cross-tenant access as `breeze_app`
    (contract test).
- **Live read-only sanity** (post-merge, NO prod mutation): re-query US prod read-only
  (Tailscale SSH to the US prod droplet — address in gitignored `internal/` notes —
  then `docker run postgres:16-alpine psql "$DATABASE_URL"`)
  to confirm surfaced-product variety jumps well beyond Chrome. Secret stays on the droplet.

## Rollout / relationship to #2292

Branch `fix/vuln-cpe-resolver` is cut off `origin/main` (pre-#2292). This spec **replaces**
the product join wholesale, so it subsumes #2292's `lower()` change; if #2292 merges first,
the join lines it touched are rewritten here (resolve by taking this version). The read-side
`lower()` normalization invariant is preserved inside the resolver/refresh path.

## Spec B preview (#2291 — separate)

Generalize `correlateOsVulns` to a Windows path: compare `devices.os_version`/`os_build`
against MSRC `FixedBuild` OS data via `versionCompare.isVulnerable`, producing
`software_inventory_id IS NULL` findings. Gated on #2261 (MSRC sync healthy + populating
Windows `os_vulnerabilities` rows). Code path built but inert until data exists. Full spec
authored after Spec A lands.
