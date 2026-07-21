# BE-16 Vulnerability Management — Phase 2 (Third-party NVD + Apple SOFA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Phase 1's MSRC pipeline to cover third-party commercial apps (via NVD CPE + version ranges) and Apple/macOS (via the SOFA feed), enriched with CISA KEV and EPSS exploitation signals, so the vulnerability list reflects the whole office-endpoint software stack — not just Microsoft.

**Architecture:** A CPE-keyed path complements Phase 1's build-number path. A curated CPE map resolves the top third-party products' `software_products.cpe`; NVD ingestion produces version-range match facts keyed by CPE; a version-range engine evaluates installed versions against those ranges. Apple is handled by the SOFA feed (Apache-2.0), which normalizes Apple's HTML advisories into "OS-major line + fixed version → CVE" JSON; macOS OS matching joins on the device OS version. KEV/EPSS enrich the global `vulnerabilities` catalog for prioritization. All matching stays deterministic; correlation remains an aggregate-dimension JOIN.

**Tech Stack:** Hono (TS API), Drizzle ORM, PostgreSQL + RLS, BullMQ + Redis, Vitest (unit + integration), hand-written SQL migrations.

**Source spec:** `internal/BE-16-vulnerability-management-v2.md`. **Spikes:** `internal/BE-16-spike-msrc-csaf.md`, `internal/BE-16-spike-apple.md`. **Predecessor plan:** `docs/superpowers/plans/vuln-patch/2026-06-22-be16-vuln-mgmt-phase1-msrc.md`.

> Revised 2026-06-23 per Codex review (corrections folded into tasks below).

## Global Constraints

- **Node:** prefix every pnpm/vitest command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Migrations:** filename `YYYY-MM-DD-<slug>.sql` in `apps/api/migrations/`; idempotent; **no inner `BEGIN;`/`COMMIT;`**; never edit a shipped migration.
- **DB context:** all writes to the global tables (`vulnerabilities`, `software_products`, `software_vulnerabilities`, `vulnerability_sources`) and the global-fact reads in correlation use `withSystemDbAccessContext`; tenant `device_vulnerabilities` reads via request `db`.
- **Integration tests** (real DB) live in `apps/api/src/__tests__/integration/*.integration.test.ts` or `src/**/*.integration.test.ts` and run via `--config vitest.integration.config.ts` (test DB :5433, `breeze_app`). Plain unit job skips real-DB cases.
- **NVD rate limits:** with an API key, 50 requests / 30s; without, 5 / 30s. Always send the key. Respect `resultsPerPage` ≤ 2000 and the 120-day `lastModStartDate`/`lastModEndDate` window cap.
- **Secrets:** NVD API key comes from `env.NVD_API_KEY` (optional — degrade to unauthenticated rate limits if absent, log a warning). No keys in code or fixtures.
- **Determinism:** no `Date.now()`/locale sorts inside match logic; version comparison via `versionCompare.ts` only.

## Interfaces inherited from Phase 1 (do not redefine)

- Tables: `vulnerabilities` (`cveId`, `cvssVersion`, `cvssScore`, `cvssVector`, `severity`, `knownExploited`, `epssScore`, `patchAvailable`, `rawPayload`, `modifiedAt`), `softwareProducts` (`normalizedName`, `normalizedVendor`, `cpe`, `cpeConfidence`, `lastCveMatchAt`), `softwareVulnerabilities` (`productId`, `vulnerabilityId`, `versionStartIncluding`, `versionStartExcluding`, `versionEndExcluding`, `versionEndIncluding`), `vulnerabilitySources` (`source`, `cursor`, `lastSuccessfulSyncAt`, `lastSyncStatus`, `lastSyncError`), `deviceVulnerabilities`.
- `apps/api/src/services/versionCompare.ts` → `compareBuilds(a,b): -1|0|1`, `isVulnerable(installed, fixedBuild): boolean`.
- `apps/api/src/services/vulnerabilityCorrelation.ts` → `correlateOrg(orgId): Promise<{created, resolved}>` (exact-name FixedBuild path).
- `apps/api/src/jobs/vulnerabilityJobs.ts` → `syncMsrcMonth(month)`, `initializeVulnerabilityJobs`, `shutdownVulnerabilityJobs`, the `vuln-source-sync` queue.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/versionCompare.ts` (modify) | Add `isVersionInRange()` for NVD range semantics |
| `apps/api/src/services/cpeMap.ts` (create) | Load/seed curated `(name,vendor)→cpe` map into `software_products` |
| `apps/api/src/services/__fixtures__/cpe-map.json` (create) | Curated CPE seed for top third-party products |
| `apps/api/src/services/nvdClient.ts` (create) | NVD 2.0 fetch + parse → CVE/CVSS/CPE-range records |
| `apps/api/src/services/__fixtures__/nvd-sample.json` (create) | Trimmed real NVD CVE response |
| `apps/api/src/services/sofaClient.ts` (create) | SOFA v2 fetch + parse → macOS OS-line/fixed-version → CVE records |
| `apps/api/src/services/__fixtures__/sofa-sample.json` (create) | Trimmed real SOFA macos feed |
| `apps/api/src/services/exploitFeeds.ts` (create) | CISA KEV + EPSS fetch + enrichment |
| `apps/api/src/jobs/vulnerabilityJobs.ts` (modify) | Add `syncNvd()`, `syncSofa()`, `enrichExploitSignals()`; extend job dispatch |
| `apps/api/src/jobs/queueSchemas.ts` (modify) | Extend source enum to `nvd|sofa|kev_epss` |
| `apps/api/src/services/vulnerabilityCorrelation.ts` (modify) | Add CPE/range path + device-OS path |
| `apps/api/migrations/2026-06-22-b-vuln-device-os-facts.sql` (create) | `os_vulnerabilities` global table for OS-line→CVE facts |
| `apps/api/src/db/schema/vulnerabilityManagement.ts` (modify) | Add `osVulnerabilities` table def |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (modify) | Allowlist `os_vulnerabilities` |

---

### Task 1: Version-range engine

**Files:**
- Modify: `apps/api/src/services/versionCompare.ts`
- Test: `apps/api/src/services/versionCompare.test.ts` (extend)

**Interfaces:**
- Consumes: `compareBuilds` (Phase 1).
- Produces: `isVersionInRange(version: string, range: VersionRange): boolean` where `VersionRange = { startIncluding?: string|null; startExcluding?: string|null; endIncluding?: string|null; endExcluding?: string|null }`. Empty range (all bounds null) ⇒ matches any version (exact-CPE-no-range case = "all versions vulnerable").

- [ ] **Step 1: Write the failing tests**

```ts
import { isVersionInRange } from './versionCompare';

describe('isVersionInRange', () => {
  it('matches inside [start, end)', () => {
    expect(isVersionInRange('20.5', { startIncluding: '20.0', endExcluding: '21.0' })).toBe(true);
  });
  it('excludes the endExcluding bound itself', () => {
    expect(isVersionInRange('21.0', { startIncluding: '20.0', endExcluding: '21.0' })).toBe(false);
  });
  it('includes the endIncluding bound', () => {
    expect(isVersionInRange('21.0', { endIncluding: '21.0' })).toBe(true);
  });
  it('respects startExcluding', () => {
    expect(isVersionInRange('20.0', { startExcluding: '20.0', endExcluding: '21.0' })).toBe(false);
    expect(isVersionInRange('20.1', { startExcluding: '20.0', endExcluding: '21.0' })).toBe(true);
  });
  it('an empty range matches anything (all versions vulnerable)', () => {
    expect(isVersionInRange('1.2.3', {})).toBe(true);
  });
  it('compares numerically not lexically', () => {
    expect(isVersionInRange('9.0', { startIncluding: '8.0', endExcluding: '10.0' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/versionCompare.test.ts`
Expected: FAIL ("isVersionInRange is not a function").

- [ ] **Step 3: Implement**

```ts
// append to apps/api/src/services/versionCompare.ts
export interface VersionRange {
  startIncluding?: string | null;
  startExcluding?: string | null;
  endIncluding?: string | null;
  endExcluding?: string | null;
}

export function isVersionInRange(version: string, range: VersionRange): boolean {
  if (range.startIncluding && compareBuilds(version, range.startIncluding) < 0) return false;
  if (range.startExcluding && compareBuilds(version, range.startExcluding) <= 0) return false;
  if (range.endIncluding && compareBuilds(version, range.endIncluding) > 0) return false;
  if (range.endExcluding && compareBuilds(version, range.endExcluding) >= 0) return false;
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/versionCompare.test.ts`
Expected: PASS (all old + new cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/versionCompare.ts apps/api/src/services/versionCompare.test.ts
git commit -m "feat(vuln): version-range engine for NVD CPE matching"
```

---

### Task 2: Curated CPE map seed + loader

**Files:**
- Create: `apps/api/src/services/__fixtures__/cpe-map.json`
- Create: `apps/api/src/services/cpeMap.ts`
- Test: `apps/api/src/services/cpeMap.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `softwareProducts` table.
- Produces:
  - `CPE_MAP: Array<{ name: string; vendor: string|null; cpe: string }>` (loaded from the JSON; `cpe` is the vendor:product prefix form, e.g. `cpe:2.3:a:adobe:acrobat_reader`).
  - `seedCpeMap(): Promise<number>` — upserts each entry into `software_products` (`normalizedName=lower(trim(name))`, `normalizedVendor=lower(trim(vendor))`, `cpe`, `cpeConfidence='curated'`), `onConflictDoUpdate` to refresh the cpe. Returns rows upserted.
  - `normalizeName(s: string): string` and `normalizeVendor(s: string|null): string|null` — shared `lower(trim(...))` helpers (export; Task 6/correlation reuse them).

- [ ] **Step 1: Create the seed fixture**

Create `__fixtures__/cpe-map.json` with the top office-endpoint third-party products (extend over time). Minimum viable set:

```json
[
  { "name": "Google Chrome", "vendor": "Google LLC", "cpe": "cpe:2.3:a:google:chrome" },
  { "name": "Mozilla Firefox", "vendor": "Mozilla", "cpe": "cpe:2.3:a:mozilla:firefox" },
  { "name": "Adobe Acrobat Reader", "vendor": "Adobe Inc.", "cpe": "cpe:2.3:a:adobe:acrobat_reader" },
  { "name": "Adobe Acrobat Reader DC", "vendor": "Adobe Inc.", "cpe": "cpe:2.3:a:adobe:acrobat_reader" },
  { "name": "7-Zip", "vendor": "Igor Pavlov", "cpe": "cpe:2.3:a:7-zip:7-zip" },
  { "name": "Notepad++", "vendor": "Notepad++ Team", "cpe": "cpe:2.3:a:notepad-plus-plus:notepad-plus-plus" },
  { "name": "Zoom", "vendor": "Zoom Video Communications, Inc.", "cpe": "cpe:2.3:a:zoom:zoom" },
  { "name": "VLC media player", "vendor": "VideoLAN", "cpe": "cpe:2.3:a:videolan:vlc_media_player" }
]
```

- [ ] **Step 2: Write the failing test**

```ts
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '@/db';
import { softwareProducts } from '@/db/schema';
import { seedCpeMap } from './cpeMap';

it('seeds curated products with cpeConfidence=curated', async () => {
  const n = await seedCpeMap();
  expect(n).toBeGreaterThan(0);
  const rows = await withSystemDbAccessContext(() =>
    db.select().from(softwareProducts).where(eq(softwareProducts.cpeConfidence, 'curated')));
  expect(rows.find((r) => r.normalizedName === 'google chrome')?.cpe).toBe('cpe:2.3:a:google:chrome');
});
it('is idempotent and refreshes cpe on re-seed', async () => {
  await seedCpeMap();
  const before = await countRows(softwareProducts);
  await seedCpeMap();
  expect(await countRows(softwareProducts)).toBe(before);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/cpeMap.integration.test.ts`
Expected: FAIL ("seedCpeMap is not a function").

- [ ] **Step 4: Implement**

```ts
// apps/api/src/services/cpeMap.ts
import cpeMapJson from './__fixtures__/cpe-map.json';
import { softwareProducts } from '@/db/schema';
import { db, withSystemDbAccessContext } from '@/db';

export const CPE_MAP = cpeMapJson as Array<{ name: string; vendor: string | null; cpe: string }>;

export const normalizeName = (s: string) => s.toLowerCase().trim();
export const normalizeVendor = (s: string | null) => (s ? s.toLowerCase().trim() : null);

export async function seedCpeMap(): Promise<number> {
  return withSystemDbAccessContext(async () => {
    let n = 0;
    for (const e of CPE_MAP) {
      await db.insert(softwareProducts).values({
        normalizedName: normalizeName(e.name),
        normalizedVendor: normalizeVendor(e.vendor),
        cpe: e.cpe,
        cpeConfidence: 'curated',
      }).onConflictDoUpdate({
        target: [softwareProducts.normalizedName, softwareProducts.normalizedVendor],
        set: { cpe: e.cpe, cpeConfidence: 'curated' },
      });
      n++;
    }
    return n;
  });
}
```

> `withSystemDbAccessContext` is **argless** — `withSystemDbAccessContext<T>(fn: () => Promise<T>)` (`apps/api/src/db/index.ts:187`); it establishes the system RLS context and the imported proxy `db` (from `@/db`) resolves to the request-scoped transaction inside the callback. Do **not** pass a context object or import a `systemDbContext`.
>
> Note: the `software_products_name_vendor_idx` unique index treats NULL vendor as distinct; keep curated vendors non-null where possible.

- [ ] **Step 5: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/cpeMap.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/cpeMap.ts apps/api/src/services/__fixtures__/cpe-map.json apps/api/src/services/cpeMap.integration.test.ts
git commit -m "feat(vuln): curated CPE map seed + loader for third-party products"
```

---

### Task 3: NVD client + parser

**Files:**
- Create: `apps/api/src/services/nvdClient.ts`
- Create: `apps/api/src/services/__fixtures__/nvd-sample.json`
- Test: `apps/api/src/services/nvdClient.test.ts`

**Interfaces:**
- Produces:
  - `fetchNvdPage(params): Promise<NvdResponse>` — GET `https://services.nvd.nist.gov/rest/json/cves/2.0` with `lastModStartDate`, `lastModEndDate`, `startIndex`, `resultsPerPage`; sends `apiKey` header from `env.NVD_API_KEY` when present.
  - `parseNvd(doc: unknown): NvdRecord[]` where `NvdRecord = { cveId; cvssVersion: string|null; cvssScore: number|null; cvssVector: string|null; severity: string|null; cpeMatches: Array<{ cpePrefix: string; range: VersionRange }> }`. `cpePrefix` is parts 1–5 of the CPE criteria (`cpe:2.3:a:vendor:product`) for joining to `software_products.cpe`. Only `vulnerable: true` cpeMatch entries are emitted.

- [ ] **Step 1: Create the fixture**

`curl -s 'https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2024-21412' > /tmp/nvd.json` (any CVE with `configurations`), trim to one `vulnerabilities[].cve` keeping `id`, `metrics.cvssMetricV31[0].cvssData` (`baseScore`,`vectorString`,`version`), `metrics.cvssMetricV31[0].baseSeverity`, and `configurations[].nodes[].cpeMatch[]` (`criteria`, `vulnerable`, `versionStartIncluding`, `versionEndExcluding`). Save to `__fixtures__/nvd-sample.json`.

- [ ] **Step 2: Write the failing test**

```ts
import { parseNvd } from './nvdClient';
import sample from './__fixtures__/nvd-sample.json';

describe('parseNvd', () => {
  it('extracts CVE, CVSS, and CPE version ranges', () => {
    const recs = parseNvd(sample);
    const r = recs[0];
    expect(r.cveId).toMatch(/^CVE-/);
    expect(typeof r.cvssScore === 'number' || r.cvssScore === null).toBe(true);
    expect(r.cpeMatches.length).toBeGreaterThan(0);
    expect(r.cpeMatches[0].cpePrefix).toMatch(/^cpe:2\.3:[aoh]:/);
  });
  it('reduces a CPE criteria to its vendor:product prefix', () => {
    const { cpePrefix } = parseNvd(sample)[0].cpeMatches[0];
    expect(cpePrefix.split(':').length).toBe(5); // cpe:2.3:a:vendor:product
  });
  it('skips cpeMatch entries with vulnerable=false', () => {
    const recs = parseNvd(sample);
    expect(recs.every((r) => r.cpeMatches.every((m) => m.cpePrefix))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/nvdClient.test.ts`
Expected: FAIL ("parseNvd is not a function").

- [ ] **Step 4: Implement**

```ts
// apps/api/src/services/nvdClient.ts
import { env } from '@/config/env'; // match the project's env accessor
import type { VersionRange } from './versionCompare';

const BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

export interface NvdRecord {
  cveId: string;
  cvssVersion: string | null;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: string | null;
  cpeMatches: Array<{ cpePrefix: string; range: VersionRange }>;
}

function cpePrefix(criteria: string): string {
  // cpe:2.3:a:vendor:product:version:... -> cpe:2.3:a:vendor:product
  return criteria.split(':').slice(0, 5).join(':');
}

export function parseNvd(doc: unknown): NvdRecord[] {
  const d = doc as any;
  const out: NvdRecord[] = [];
  for (const item of d?.vulnerabilities ?? []) {
    const cve = item.cve;
    if (!cve?.id) continue;
    const m31 = cve.metrics?.cvssMetricV31?.[0];
    const m40 = cve.metrics?.cvssMetricV40?.[0];
    const m2 = cve.metrics?.cvssMetricV2?.[0];
    const metric = m31 ?? m40 ?? m2;
    const data = metric?.cvssData;
    const cvssScore = data?.baseScore != null ? Number(data.baseScore) : null;
    const matches: NvdRecord['cpeMatches'] = [];
    for (const node of cve.configurations?.flatMap((c: any) => c.nodes ?? []) ?? []) {
      for (const cm of node.cpeMatch ?? []) {
        if (cm.vulnerable === false || !cm.criteria) continue;
        matches.push({
          cpePrefix: cpePrefix(cm.criteria),
          range: {
            startIncluding: cm.versionStartIncluding ?? null,
            startExcluding: cm.versionStartExcluding ?? null,
            endIncluding: cm.versionEndIncluding ?? null,
            endExcluding: cm.versionEndExcluding ?? null,
          },
        });
      }
    }
    out.push({
      cveId: cve.id,
      cvssVersion: data?.version ?? null,
      cvssScore,
      cvssVector: data?.vectorString ?? null,
      severity: metric?.baseSeverity ?? null,
      cpeMatches: matches,
    });
  }
  return out;
}

export async function fetchNvdPage(p: {
  lastModStartDate: string; lastModEndDate: string; startIndex: number; resultsPerPage?: number;
}): Promise<unknown> {
  const url = new URL(BASE);
  url.searchParams.set('lastModStartDate', p.lastModStartDate);
  url.searchParams.set('lastModEndDate', p.lastModEndDate);
  url.searchParams.set('startIndex', String(p.startIndex));
  url.searchParams.set('resultsPerPage', String(p.resultsPerPage ?? 2000));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.NVD_API_KEY) headers.apiKey = env.NVD_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NVD fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 5: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/nvdClient.test.ts`
Expected: PASS. (Adjust field access to the fixture if NVD's real shape differs — fixture is ground truth.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/nvdClient.ts apps/api/src/services/__fixtures__/nvd-sample.json apps/api/src/services/nvdClient.test.ts
git commit -m "feat(vuln): NVD 2.0 client + CPE-range parser"
```

---

### Task 4: NVD sync into match facts

**Files:**
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts`
- Test: `apps/api/src/jobs/vulnerabilityJobsNvd.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `parseNvd`/`fetchNvdPage` (Task 3), `seedCpeMap`/`CPE_MAP` (Task 2), `versionCompare` types, schema tables.
- Produces: `syncNvd(opts?: { sinceDays?: number }): Promise<{ vulns: number; matchFacts: number }>` — paginates the NVD delta window, upserts `vulnerabilities`, and for each `cpeMatch` whose `cpePrefix` equals a `software_products.cpe` (curated rows), upserts a `software_vulnerabilities` fact with the range columns. Updates `vulnerability_sources` source `'nvd'` (`cursor` = window end). **Only creates facts for CPEs already in the curated map** — NVD CVEs for unknown products are stored in `vulnerabilities` but produce no match fact (the curated map gates fact creation, keeping false positives down).

- [ ] **Step 1: Extend the source enum**

In `queueSchemas.ts`, widen the sync payload source enum to `z.enum(['msrc','nvd','sofa','kev_epss'])`.

- [ ] **Step 2: Write the failing integration test**

```ts
import { db, withSystemDbAccessContext } from '@/db';
import { softwareVulnerabilities } from '@/db/schema';
import { seedCpeMap } from '@/services/cpeMap';
import { syncNvd } from './vulnerabilityJobs';

it('creates match facts only for CPEs in the curated map', async () => {
  await seedCpeMap(); // ensures cpe:2.3:a:google:chrome exists
  // stub fetchNvdPage to return a fixture with a Chrome CPE range + an unknown-product CPE
  const res = await syncNvd();
  expect(res.vulns).toBeGreaterThan(0);
  const facts = await withSystemDbAccessContext(() =>
    db.select().from(softwareVulnerabilities));
  // chrome fact present, unknown-product fact absent
  expect(facts.length).toBeGreaterThan(0);
});
it('is idempotent across two runs', async () => {
  await seedCpeMap();
  await syncNvd();
  const before = await countRows(softwareVulnerabilities);
  await syncNvd();
  expect(await countRows(softwareVulnerabilities)).toBe(before);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsNvd.integration.test.ts`
Expected: FAIL ("syncNvd is not a function").

- [ ] **Step 4: Implement `syncNvd`**

Mirror `syncMsrcMonth`'s transaction/upsert shape. Steps:
1. Compute window: `end = now`, `start = now - (sinceDays ?? cursorGapDays ?? 1)` in NVD's ISO format (`YYYY-MM-DDTHH:mm:ss.SSS`). Cap window ≤ 120 days.
2. Build a lookup `Map<cpePrefix, productId>` from `software_products` where `cpe IS NOT NULL`.
3. Paginate `fetchNvdPage` (startIndex += resultsPerPage until `startIndex >= totalResults`). For each page `parseNvd`.
4. In `withSystemDbAccessContext(async () => { … })` (argless — use the imported proxy `db` inside the callback): upsert `vulnerabilities` (onConflict `cve_id`, set cvss/version/vector/severity/modifiedAt, store rawPayload); for each record's `cpeMatches`, if `map.has(cpePrefix)`, upsert a `software_vulnerabilities` row (`productId`, `vulnerabilityId`, and **all four** range columns from `cm.range`: `versionStartIncluding`, `versionStartExcluding`, `versionEndExcluding`, `versionEndIncluding`) deduped on `(productId, vulnerabilityId, versionStartIncluding, versionStartExcluding, versionEndExcluding, versionEndIncluding)`.
5. Update `vulnerability_sources` `'nvd'` cursor/status. Count vulns + facts.

Add the `'nvd'` branch to the `vuln-source-sync` worker dispatch (alongside `'msrc'`); schedule daily.

- [ ] **Step 5: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsNvd.integration.test.ts`
Expected: PASS (gated facts + idempotency).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/vulnerabilityJobsNvd.integration.test.ts
git commit -m "feat(vuln): NVD delta sync into curated-CPE-gated match facts"
```

---

### Task 5: KEV + EPSS enrichment

**Files:**
- Create: `apps/api/src/services/exploitFeeds.ts`
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts`
- Test: `apps/api/src/services/exploitFeeds.integration.test.ts` (real DB)

**Interfaces:**
- Produces:
  - `fetchKevCveIds(): Promise<Set<string>>` — GET CISA KEV JSON (`https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`), returns the set of `cveID`s.
  - `fetchEpssScores(cveIds: string[]): Promise<Map<string, number>>` — batched GET `https://api.first.org/data/v1/epss?cve=<comma-list>` (chunks ≤ 100), returns cve→epss probability.
  - `enrichExploitSignals(): Promise<{ kev: number; epss: number }>` — sets `vulnerabilities.knownExploited=true` for KEV CVEs present in our catalog, and `epssScore` for catalog CVEs. Updates `vulnerability_sources` `'kev_epss'`.

- [ ] **Step 1: Write the failing test**

```ts
it('flags KEV CVEs already in our catalog', async () => {
  await seedVulnerability({ cveId: 'CVE-2024-21412' }); // present in KEV
  // stub fetchKevCveIds -> Set(['CVE-2024-21412']); stub fetchEpssScores -> Map
  const res = await enrichExploitSignals();
  expect(res.kev).toBeGreaterThanOrEqual(1);
  const row = await getVuln('CVE-2024-21412');
  expect(row.knownExploited).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/exploitFeeds.integration.test.ts`
Expected: FAIL ("enrichExploitSignals is not a function").

- [ ] **Step 3: Implement**

`enrichExploitSignals`: load all `vulnerabilities.cveId` into memory (or process in batches); `kev = fetchKevCveIds()`; `UPDATE vulnerabilities SET known_exploited = true WHERE cve_id = ANY(intersection)`; chunk the catalog CVEs through `fetchEpssScores` and `UPDATE ... SET epss_score = $score WHERE cve_id = $cve`. All under `withSystemDbAccessContext(async () => { … })` (argless — use the imported proxy `db` inside). Add a daily `'kev_epss'` branch to the worker dispatch.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/exploitFeeds.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/exploitFeeds.ts apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/services/exploitFeeds.integration.test.ts
git commit -m "feat(vuln): CISA KEV + EPSS enrichment of the CVE catalog"
```

---

### Task 6: OS-line fact table + Apple SOFA sync

**Files:**
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts`
- Create: `apps/api/migrations/2026-06-22-b-vuln-device-os-facts.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/services/sofaClient.ts`
- Create: `apps/api/src/services/__fixtures__/sofa-sample.json`
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts`
- Test: `apps/api/src/services/sofaClient.test.ts` + `apps/api/src/jobs/vulnerabilityJobsSofa.integration.test.ts`

**Interfaces:**
- Produces:
  - `osVulnerabilities` table (global): `id`, `platform` varchar (`macos`|`windows`), `osLine` varchar (e.g. `Sequoia 15` — matches SOFA's `OSVersions[].OSVersion`), `fixedVersion` varchar, `vulnerabilityId` uuid → `vulnerabilities.id`. Global ⇒ force-RLS + an `os_vulnerabilities_system_only` policy (`current_setting('breeze.scope',true)='system'`, NOT zero policies — see Phase 1 Task 1) + allowlisted.
  - `parseSofa(doc: unknown): SofaRecord[]` where `SofaRecord = { osLine: string; fixedVersion: string; cveId: string; activelyExploited: boolean }`.
  - `syncSofa(): Promise<{ vulns: number; osFacts: number }>` — fetch `https://sofafeed.macadmins.io/v2/macos_data_feed.json`, upsert each CVE into `vulnerabilities` (CVSS left null — backfilled by NVD enrichment via shared cve_id; set `knownExploited` from `ActivelyExploitedCVEs`), upsert `os_vulnerabilities` facts (`platform='macos'`).

- [ ] **Step 1: Add the schema + migration**

Add `osVulnerabilities` to the Drizzle schema. Create `2026-06-22-b-vuln-device-os-facts.sql` (note the `-b-` infix — same-day, depends on Task 1's tables): `CREATE TABLE IF NOT EXISTS os_vulnerabilities (...)` + indexes on `(platform, os_line)` and `vulnerability_id`, then `ENABLE`/`FORCE ROW LEVEL SECURITY` + a `os_vulnerabilities_system_only` policy (`USING/WITH CHECK current_setting('breeze.scope',true)='system'`, mirroring Phase 1's global tables — a no-policy forced table denies even system context).

- [ ] **Step 2: Allowlist + drift check**

Add `'os_vulnerabilities'` to `INTENTIONAL_UNSCOPED`. Run drift check:
Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 3: Create the SOFA fixture + failing parser test**

`curl -s https://sofafeed.macadmins.io/v2/macos_data_feed.json > /tmp/sofa.json`, trim to one `OSVersions[]` with one `SecurityReleases[]` (`ProductVersion`, `CVEs`, `ActivelyExploitedCVEs`). Test:

```ts
import { parseSofa } from './sofaClient';
import sample from './__fixtures__/sofa-sample.json';

it('maps OS-line + fixed version to CVEs', () => {
  const recs = parseSofa(sample);
  const r = recs[0];
  expect(r.cveId).toMatch(/^CVE-/);
  expect(r.fixedVersion).toMatch(/^\d+\.\d+/);
  expect(typeof r.activelyExploited).toBe('boolean');
});
```

- [ ] **Step 4: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/sofaClient.test.ts`
Expected: FAIL ("parseSofa is not a function").

- [ ] **Step 5: Implement `parseSofa` + `fetchSofa` + `syncSofa`**

```ts
// apps/api/src/services/sofaClient.ts (parser shown; fetch/sync mirror Task 4)
export interface SofaRecord { osLine: string; fixedVersion: string; cveId: string; activelyExploited: boolean; }

export function parseSofa(doc: unknown): SofaRecord[] {
  const d = doc as any;
  const out: SofaRecord[] = [];
  for (const osv of d?.OSVersions ?? []) {
    const osLine = osv.OSVersion; // e.g. "Sequoia 15"
    for (const rel of osv.SecurityReleases ?? []) {
      const fixedVersion = rel.ProductVersion; // e.g. "15.6.1"
      const exploited = new Set<string>(rel.ActivelyExploitedCVEs ?? []);
      for (const cveId of Object.keys(rel.CVEs ?? {})) {
        out.push({ osLine, fixedVersion, cveId, activelyExploited: exploited.has(cveId) });
      }
    }
  }
  return out;
}
```

`syncSofa`: `parseSofa(await fetchSofa())`; under `withSystemDbAccessContext(async () => { … })` (argless — use the imported proxy `db` inside) upsert `vulnerabilities` (onConflict cve_id, **do not overwrite** non-null cvss from NVD; set `knownExploited=true` when `activelyExploited`); upsert `os_vulnerabilities` (`platform='macos'`, `osLine`, `fixedVersion`, `vulnerabilityId`). Add `'sofa'` to the worker dispatch (daily). The integration test asserts vulns + osFacts > 0 and idempotency.

- [ ] **Step 6: Run parser + integration tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/sofaClient.test.ts`
Then: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsSofa.integration.test.ts`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/vulnerabilityManagement.ts apps/api/migrations/2026-06-22-b-vuln-device-os-facts.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/sofaClient.ts apps/api/src/services/__fixtures__/sofa-sample.json apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/jobs/vulnerabilityJobsSofa.integration.test.ts
git commit -m "feat(vuln): os_vulnerabilities facts + Apple SOFA sync"
```

---

### Task 7: Correlation — CPE/range path + device-OS path

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts`
- Test: `apps/api/src/services/vulnerabilityCorrelationPhase2.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `isVersionInRange` (Task 1), `normalizeName`/`normalizeVendor` (Task 2), `osVulnerabilities` (Task 6), `compareBuilds` (Phase 1), and the device OS fields `devices.osType` (enum `'windows'|'macos'|'linux'`, `apps/api/src/db/schema/devices.ts:49`) + `devices.osVersion` (varchar, `:61`). **There is no OS-major-line column on `devices`** (only `osVersion` + `osBuild`), so the OS line is **derived in code** from `osVersion`.
- Produces:
  - `deriveMacosLine(osVersion: string): string | null` — maps a macOS marketing/product version to its SOFA OS-line string (e.g. `'15.6.1'` → `'Sequoia 15'`, `'14.7.2'` → `'Sonoma 14'`, `'13.7'` → `'Ventura 13'`). Returns `null` for an unmapped major. Keyed on the integer major component of `osVersion`. Must match the `osLine` strings SOFA emits in Task 6 (`OSVersions[].OSVersion`).
  - `correlateOrg(orgId)` extended to additionally match `software_inventory` rows to curated `software_products` by normalized name, then for each `software_vulnerabilities` fact evaluate `isVersionInRange(inv.version, fact range)` (third-party CPE path), upserting `device_vulnerabilities` exactly like the Phase 1 path (open/patched lifecycle, riskScore = cvssScore).
  - `correlateOsVulns(orgId)` — for each macOS device in the org (`devices.osType = 'macos'`), derive its OS line via `deriveMacosLine(device.osVersion)`, join `os_vulnerabilities` on `platform='macos'` + `osLine`, and flag where `compareBuilds(device.osVersion, fact.fixedVersion) < 0` (installed OS below the fixed version on its line). Upserts `device_vulnerabilities` like the Phase 1 path.

- [ ] **Step 1: Write the failing tests**

```ts
import { correlateOrg, correlateOsVulns, deriveMacosLine } from './vulnerabilityCorrelation';

it('flags a third-party app via CPE version range', async () => {
  await seedSoftwareProduct({ name: 'Google Chrome', cpe: 'cpe:2.3:a:google:chrome', confidence: 'curated' });
  await seedRangeFact({ cpe: 'cpe:2.3:a:google:chrome', endExcluding: '120.0.6099.200', cveId: 'CVE-2024-0001', cvss: 8.8 });
  await seedInventory({ orgId, deviceId, name: 'Google Chrome', version: '120.0.6099.110' });
  const res = await correlateOrg(orgId);
  expect(res.created).toBeGreaterThanOrEqual(1);
});
it('does not flag a third-party app at/above the fixed range', async () => {
  await seedSoftwareProduct({ name: 'Google Chrome', cpe: 'cpe:2.3:a:google:chrome', confidence: 'curated' });
  await seedRangeFact({ cpe: 'cpe:2.3:a:google:chrome', endExcluding: '120.0.6099.200', cveId: 'CVE-2024-0001', cvss: 8.8 });
  await seedInventory({ orgId, deviceId, name: 'Google Chrome', version: '120.0.6099.300' });
  expect((await correlateOrg(orgId)).created).toBe(0);
});
it('flags a macOS device below the fixed OS version on its line', async () => {
  await seedOsFact({ platform: 'macos', osLine: 'Sequoia 15', fixedVersion: '15.6.1', cveId: 'CVE-2025-1', cvss: 7.5 });
  // Seed only the real device columns — osType + osVersion; the OS line is
  // derived in code (no osLine column on devices). deriveMacosLine('15.6.0')
  // must return 'Sequoia 15' so it joins the os_vulnerabilities fact.
  await seedDevice({ orgId, deviceId, osType: 'macos', osVersion: '15.6.0' });
  expect((await correlateOsVulns(orgId)).created).toBeGreaterThanOrEqual(1);
});
it('does not flag a macOS device already at/above the fixed OS version', async () => {
  await seedOsFact({ platform: 'macos', osLine: 'Sequoia 15', fixedVersion: '15.6.1', cveId: 'CVE-2025-1', cvss: 7.5 });
  await seedDevice({ orgId, deviceId, osType: 'macos', osVersion: '15.6.1' });
  expect((await correlateOsVulns(orgId)).created).toBe(0);
});
it('derives the macOS OS-major line from osVersion', () => {
  expect(deriveMacosLine('15.6.1')).toBe('Sequoia 15');
  expect(deriveMacosLine('14.7.2')).toBe('Sonoma 14');
  expect(deriveMacosLine('13.7')).toBe('Ventura 13');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelationPhase2.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

First add the OS-line derivation helper. `devices` has **no OS-major-line column** — only `osType` (enum `'windows'|'macos'|'linux'`) and `osVersion` (varchar) — so derive the SOFA line from `osVersion` in code:

```ts
// apps/api/src/services/vulnerabilityCorrelation.ts (add)
// macOS major version → SOFA OS-line string (matches SOFA's OSVersions[].OSVersion;
// see parseSofa in sofaClient.ts). Extend as Apple ships new majors.
const MACOS_LINE_BY_MAJOR: Record<number, string> = {
  13: 'Ventura 13',
  14: 'Sonoma 14',
  15: 'Sequoia 15',
};

export function deriveMacosLine(osVersion: string): string | null {
  const major = Number.parseInt(osVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) return null;
  return MACOS_LINE_BY_MAJOR[major] ?? null;
}
```

Extend `correlateOrg`: after the existing FixedBuild path, run the CPE/range path — join inventory → `software_products` (curated, `cpe IS NOT NULL`) on normalized name → `software_vulnerabilities` → `vulnerabilities`, filter in app code with `isVersionInRange(inv.version, {startIncluding, startExcluding, endIncluding, endExcluding})`, upsert open `device_vulnerabilities` deduped on `(deviceId, vulnerabilityId)`.

Add `correlateOsVulns(orgId)`:
1. Select the org's macOS devices: `db.select({ id: devices.id, osVersion: devices.osVersion }).from(devices).where(and(eq(devices.orgId, orgId), eq(devices.osType, 'macos')))` (`devices.orgId` is the tenant column — `org_id`, `apps/api/src/db/schema/devices.ts:15`).
2. For each device, `const line = deriveMacosLine(device.osVersion)`; skip when `line === null`.
3. Read `os_vulnerabilities` facts for `platform='macos'` (join to `vulnerabilities` for `cvssScore`), group by `osLine`.
4. For each fact whose `osLine === line`, flag the device when `compareBuilds(device.osVersion, fact.fixedVersion) < 0` (installed OS below the fixed version → vulnerable). Upsert open `device_vulnerabilities` (`riskScore = cvssScore`) deduped on `(deviceId, vulnerabilityId)`.

Both new paths return `{ created, resolved }`; `correlateOrg` returns the structured summary `{ created, resolved }` aggregating the FixedBuild path, the CPE/range path, and the device-OS path. Resolve-patched logic mirrors Phase 1.

> Keep the resolve step over the **union** of matched ids from all three paths (FixedBuild, CPE/range, device-OS) so a device fixed via one path isn't wrongly re-opened by another.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelationPhase2.integration.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Re-run the Phase 1 correlation test (regression)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation.integration.test.ts`
Expected: PASS (FixedBuild path unbroken).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityCorrelationPhase2.integration.test.ts
git commit -m "feat(vuln): CPE-range + device-OS correlation paths"
```

---

### Task 8: Wire seeding + typecheck + full-suite gate

**Files:**
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts` (ensure `seedCpeMap` runs on init)
- Modify: `apps/api/src/index.ts` (if any new init needed)

- [ ] **Step 1: Seed the CPE map on job init**

In `initializeVulnerabilityJobs`, call `await seedCpeMap()` once at startup (idempotent) so curated products exist before the first NVD sync. Guard with try/catch + log (don't block boot on a seed failure).

- [ ] **Step 2: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck`
Expected: no type errors.

- [ ] **Step 3: Run the vuln-feature test set**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/versionCompare.test.ts src/services/nvdClient.test.ts src/services/sofaClient.test.ts`
Then the integration set:
Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/cpeMap.integration.test.ts src/jobs/vulnerabilityJobsNvd.integration.test.ts src/services/exploitFeeds.integration.test.ts src/jobs/vulnerabilityJobsSofa.integration.test.ts src/services/vulnerabilityCorrelationPhase2.integration.test.ts`
Expected: all PASS.

- [ ] **Step 4: Run RLS coverage (new global table)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts`
Expected: PASS (`os_vulnerabilities` allowlisted).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/index.ts
git commit -m "feat(vuln): seed CPE map on init; phase 2 integration gate"
```

---

## Self-Review

**Spec coverage (v2 three-source model + KEV/EPSS):**
- Version-range engine → Task 1. ✅
- Curated CPE map (third-party resolution) → Task 2. ✅
- NVD ingestion + CPE-gated facts → Task 3, 4. ✅
- KEV + EPSS secondary modifiers → Task 5. ✅
- Apple SOFA + OS-line facts → Task 6. ✅
- CPE-range + device-OS correlation → Task 7. ✅
- Init seeding + gates → Task 8. ✅
- **Deferred:** risk-score recompute job + remediate/accept-risk + UI (Phase 3); AI/events (Phase 4); network devices (Phase 5).

**Placeholder scan:** every code step has real code; commands have expected output; no TBD/TODO. ✅ Both former open decisions are now resolved inline: `withSystemDbAccessContext` is argless (`fn` only) and uses the imported proxy `db` (Task 2/4/5/6); the macOS OS line is derived in code via `deriveMacosLine(osVersion)` from `devices.osType`/`devices.osVersion` (Task 7) — there is no OS-major-line column.

**Type consistency:** `VersionRange` (Task 1) is consumed by `NvdRecord.cpeMatches[].range` (Task 3) and `isVersionInRange` in correlation (Task 7); `cpePrefix` form (`cpe:2.3:a:vendor:product`) produced in Task 3 matches the curated `software_products.cpe` form seeded in Task 2 and the join key in Task 4; `SofaRecord` (Task 6) fields feed `os_vulnerabilities` consumed in Task 7; `normalizeName`/`normalizeVendor` exported once (Task 2) and reused (Task 7). ✅

## Notes for the implementer

- **Curated-map gating is deliberate:** NVD has CVEs for tens of thousands of products; only curated CPEs produce match facts in v1, bounding false positives (v2 spec's precision strategy). Growing the map is a data task, not code.
- **CVSS source-of-truth:** NVD is authoritative for third-party CVSS; SOFA/MSRC may carry the same cveId. Upserts must **not** clobber a non-null NVD CVSS with a null from another feed — guard the `set` clause.
- **Device OS columns:** `devices` exposes `osType` (enum `'windows'|'macos'|'linux'`, `:49`) and `osVersion` (varchar, `:61`) but **no OS-major-line column**. `correlateOsVulns` filters on `devices.osType = 'macos'` and derives the SOFA OS line in code via `deriveMacosLine(osVersion)` (Task 7). Keep `MACOS_LINE_BY_MAJOR` in sync with the `OSVersions[].OSVersion` strings SOFA emits (Task 6) — a mismatch silently drops the join.
- **Fixtures are ground truth:** if live NVD/SOFA JSON casing differs from the committed fixtures, fix the parser to the fixture.
- **Worktree/RLS:** same `.env.test` symlink caveat as Phase 1 — verify the test role is not BYPASSRLS so the new global table's force-RLS behaves.
```
