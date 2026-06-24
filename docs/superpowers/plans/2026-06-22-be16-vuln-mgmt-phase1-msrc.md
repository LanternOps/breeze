# BE-16 Vulnerability Management — Phase 1 (MSRC Vertical Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect vulnerable Microsoft software on managed endpoints by ingesting MSRC CVRF data and correlating installed builds against `FixedBuild`, exposing a CVSS-sorted vulnerability list per device and fleet-wide.

**Architecture:** A daily BullMQ job ingests Microsoft's public CVRF API (one doc per Patch Tuesday) into a global `vulnerabilities` catalog and a global `software_vulnerabilities` match-fact table keyed by a product-build threshold. A correlation pass joins `software_inventory` (and the device OS build) against those facts to materialize org-scoped `device_vulnerabilities` rows. Read APIs sort by CVSS. Matching Microsoft products is a deterministic build-number comparison — no fuzzy CPE — per the `internal/BE-16-spike-msrc-csaf.md` spike.

**Tech Stack:** Hono (TS API), Drizzle ORM, PostgreSQL + RLS, BullMQ + Redis, Vitest (unit + integration), hand-written SQL migrations.

**Source spec:** `internal/BE-16-vulnerability-management-v2.md`. **Spikes:** `internal/BE-16-spike-msrc-csaf.md`, `internal/BE-16-spike-apple.md`.

> Revised 2026-06-23 per Codex review (corrections folded into tasks below).

## Global Constraints

- **Node:** prefix every pnpm/vitest command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- **Migrations:** filename `YYYY-MM-DD-<slug>.sql` in `apps/api/migrations/`; idempotent (`IF NOT EXISTS`, `pg_policies` checks, `DO $$ ... EXCEPTION`); **no inner `BEGIN;`/`COMMIT;`** (autoMigrate wraps each file); never edit a shipped migration.
- **RLS is mandatory.** Tenant-scoped tables (`org_id`) get ENABLE+FORCE+policies in the creating migration. Global tables get ENABLE+FORCE with **no policies** (system-context access only) and must be allowlisted in the rls-coverage contract test.
- **DB context:** global-table reads/writes use `withSystemDbAccessContext`; tenant reads use the request `db`. Bare pool is forbidden in request code.
- **Integration tests** (real DB) live in `apps/api/src/__tests__/integration/*.integration.test.ts` and run via `--config vitest.integration.config.ts` (test DB on :5433, `breeze_app` role). The plain unit job has no DATABASE_URL — real-DB cases skip there.
- **API prefix:** routes mount under `/api/v1` (see `apps/api/src/index.ts`).
- **Money/version comparisons must be deterministic** — no `Date.now()`/locale-dependent sorts in match logic.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema/vulnerabilityManagement.ts` (create) | Drizzle defs: `vulnerabilitySources`, `vulnerabilities`, `softwareProducts`, `softwareVulnerabilities`, `deviceVulnerabilities` |
| `apps/api/src/db/schema/index.ts` (modify) | `export * from './vulnerabilityManagement'` |
| `apps/api/migrations/2026-06-22-vulnerability-management.sql` (create) | Tables + indexes + RLS (global: force-no-policy; device: org-axis policies) |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (modify) | Add 4 global tables to `INTENTIONAL_UNSCOPED` |
| `apps/api/src/services/tenantCascade.ts` (modify) | Add `device_vulnerabilities` to `ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/routes/devices/core.ts` (modify) | Add `device_vulnerabilities` to `DEVICE_ORG_DENORMALIZED_TABLES` |
| `apps/api/src/services/versionCompare.ts` (create) | Pure build/version comparators (Office, Windows) |
| `apps/api/src/services/msrcClient.ts` (create) | Fetch + parse CVRF doc → normalized records |
| `apps/api/src/jobs/vulnerabilityJobs.ts` (create) | BullMQ `vuln-source-sync` (MSRC) + init/shutdown |
| `apps/api/src/jobs/queueSchemas.ts` (modify) | Zod payload for the sync job |
| `apps/api/src/index.ts` (modify) | Wire job init/shutdown + mount route |
| `apps/api/src/services/vulnerabilityCorrelation.ts` (create) | Materialize `device_vulnerabilities` from match facts |
| `apps/api/src/routes/vulnerabilities.ts` (create) | `GET /vulnerabilities`, `GET /vulnerabilities/devices/:deviceId` |
| test fixtures: `apps/api/src/services/__fixtures__/msrc-sample.json` (create) | Trimmed real CVRF doc for parser tests |

---

### Task 1: Schema + migration with RLS

**Files:**
- Create: `apps/api/src/db/schema/vulnerabilityManagement.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-06-22-vulnerability-management.sql`

**Interfaces:**
- Produces: Drizzle tables `vulnerabilitySources`, `vulnerabilities`, `softwareProducts`, `softwareVulnerabilities`, `deviceVulnerabilities` (column shapes per the v2 spec's schema section). Later tasks import these from `@/db/schema`.

- [ ] **Step 1: Create the Drizzle schema file**

Copy the five `pgTable` definitions verbatim from `internal/BE-16-vulnerability-management-v2.md` → "Database schema" section (`vulnerabilityManagement.ts`). Import `organizations` from `./orgs`, `devices` from `./devices`, `users` from `./users`, `softwareInventory` from `./software`.

> Note: `softwareVulnerabilities` carries **all four** NVD range bounds — `versionStartIncluding`, `versionStartExcluding` (`version_start_excluding`), `versionEndExcluding`, `versionEndIncluding`. Phase 2's NVD parser + range engine map a `startExcluding` bound, so the column must exist from Phase 1 (the spec schema includes it).

- [ ] **Step 2: Export from the schema barrel**

In `apps/api/src/db/schema/index.ts` add: `export * from './vulnerabilityManagement';`

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-06-22-vulnerability-management.sql`. `CREATE TABLE IF NOT EXISTS` for all five tables (columns/types matching the Drizzle defs — the `software_vulnerabilities` CREATE must include all four range columns `version_start_including`, `version_start_excluding`, `version_end_excluding`, `version_end_including` so Phase 2's NVD `startExcluding` bound has a column), `CREATE INDEX IF NOT EXISTS` for every index in the defs, then RLS:

```sql
-- Global tables: force RLS, no policies (system-context only)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vulnerability_sources','vulnerabilities','software_products','software_vulnerabilities']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- device_vulnerabilities: org-axis (shape 1)
-- Drop/recreate per policy (canonical idempotent style; mirrors 0008-tenant-rls.sql).
ALTER TABLE device_vulnerabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_vulnerabilities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_vulnerabilities_select ON device_vulnerabilities;
CREATE POLICY device_vulnerabilities_select ON device_vulnerabilities FOR SELECT USING (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS device_vulnerabilities_insert ON device_vulnerabilities;
CREATE POLICY device_vulnerabilities_insert ON device_vulnerabilities FOR INSERT WITH CHECK (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS device_vulnerabilities_update ON device_vulnerabilities;
CREATE POLICY device_vulnerabilities_update ON device_vulnerabilities FOR UPDATE USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));

DROP POLICY IF EXISTS device_vulnerabilities_delete ON device_vulnerabilities;
CREATE POLICY device_vulnerabilities_delete ON device_vulnerabilities FOR DELETE USING (breeze_has_org_access(org_id));
```

- [ ] **Step 4: Verify no schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift between schema files and migrations.

- [ ] **Step 5: Verify migration ordering regression test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`
Expected: PASS (filename sorts correctly in localeCompare order).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/vulnerabilityManagement.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-22-vulnerability-management.sql
git commit -m "feat(vuln): add vulnerability management schema + RLS migration"
```

---

### Task 2: RLS contract coverage + cross-tenant forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/deviceVulnerabilities-rls.integration.test.ts`

**Interfaces:**
- Consumes: `deviceVulnerabilities` from `@/db/schema`.

- [ ] **Step 1: Add global tables to the allowlist**

In `rls-coverage.integration.test.ts`, add `'vulnerability_sources'`, `'vulnerabilities'`, `'software_products'`, `'software_vulnerabilities'` to the `INTENTIONAL_UNSCOPED` set (keep the set's existing ordering style). `device_vulnerabilities` is auto-discovered via its `org_id` column — do not add it.

- [ ] **Step 2: Write the failing forge test**

Create `deviceVulnerabilities-rls.integration.test.ts`. Re-seed two orgs per test (no module-scope fixtures — `beforeEach` TRUNCATE wipes them). Insert a `device_vulnerabilities` row for org A as system context, then attempt a cross-tenant insert as an org-B `breeze_app` context:

```ts
it('rejects cross-tenant insert into device_vulnerabilities', async () => {
  const { orgA, deviceA } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgBCtx, (db) =>
      db.insert(deviceVulnerabilities).values({
        orgId: orgA.id, deviceId: deviceA.id, vulnerabilityId: someVulnId,
        status: 'open', detectedAt: new Date(),
      })
    )
  ).rejects.toThrow(/row-level security/i);
});
```

- [ ] **Step 3: Run it (expect fail before migration applied to test DB, pass after)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceVulnerabilities-rls.integration.test.ts`
Expected: PASS (insert rejected). If it *passes vacuously* (no throw), confirm the test DB role has `rolbypassrls=false` — see `[[worktree_env_test_rls_vacuous]]` lesson.

- [ ] **Step 4: Run the rls-coverage contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.config.rls-coverage.ts`
Expected: PASS (no uncovered tables).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/deviceVulnerabilities-rls.integration.test.ts
git commit -m "test(vuln): RLS coverage allowlist + device_vulnerabilities forge test"
```

---

### Task 3: Cascade list registration

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts`

**Interfaces:**
- Consumes: the `device_vulnerabilities` table name (string literal).

- [ ] **Step 1: Add to org cascade order**

In `tenantCascade.ts`, insert `'device_vulnerabilities'` into `ORG_CASCADE_DELETE_ORDER` at its **localeCompare-sorted** position (compare char-by-char against neighbors — mind the `[[cascade_list_alpha_order_localecompare]]` trap where prefix-extension siblings sort non-adjacently).

- [ ] **Step 2: Add to device org-id denormalized rewrite list**

In `apps/api/src/routes/devices/core.ts`, add `'device_vulnerabilities'` to `DEVICE_ORG_DENORMALIZED_TABLES` (it carries both `org_id` and `device_id`).

- [ ] **Step 3: Run the cascade + move-org coverage tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts`
Then: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/devices/moveOrg.coverage.test.ts`
Expected: both PASS (new table present in both lists).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts
git commit -m "feat(vuln): register device_vulnerabilities in cascade + org-move lists"
```

---

### Task 4: Version/build comparator (pure, TDD)

**Files:**
- Create: `apps/api/src/services/versionCompare.ts`
- Test: `apps/api/src/services/versionCompare.test.ts`

**Interfaces:**
- Produces: `compareBuilds(a: string, b: string): -1 | 0 | 1` (numeric dot-segment compare, shorter is padded with zeros) and `isVulnerable(installed: string, fixedBuild: string): boolean` (`compareBuilds(installed, fixedBuild) < 0`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { compareBuilds, isVulnerable } from './versionCompare';

describe('compareBuilds', () => {
  it('orders Office builds numerically, not lexically', () => {
    expect(compareBuilds('16.0.14332.20481', '16.0.14332.20500')).toBe(-1);
    expect(compareBuilds('16.0.9.100', '16.0.14.0')).toBe(-1); // 9 < 14 numerically
  });
  it('orders Windows builds numerically', () => {
    expect(compareBuilds('10.0.22631.4317', '10.0.22631.4391')).toBe(-1);
  });
  it('pads shorter versions with zeros', () => {
    expect(compareBuilds('16.0', '16.0.0.0')).toBe(0);
    expect(compareBuilds('16.0.1', '16.0')).toBe(1);
  });
  it('treats equal builds as 0', () => {
    expect(compareBuilds('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('isVulnerable', () => {
  it('is vulnerable when installed build is below FixedBuild', () => {
    expect(isVulnerable('16.0.14332.20481', '16.0.14332.20500')).toBe(true);
  });
  it('is not vulnerable when installed >= FixedBuild', () => {
    expect(isVulnerable('16.0.14332.20500', '16.0.14332.20500')).toBe(false);
    expect(isVulnerable('16.0.14332.20600', '16.0.14332.20500')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/versionCompare.test.ts`
Expected: FAIL ("compareBuilds is not a function").

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/versionCompare.ts
function segments(v: string): number[] {
  return v.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

export function compareBuilds(a: string, b: string): -1 | 0 | 1 {
  const sa = segments(a);
  const sb = segments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function isVulnerable(installed: string, fixedBuild: string): boolean {
  return compareBuilds(installed, fixedBuild) < 0;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/versionCompare.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/versionCompare.ts apps/api/src/services/versionCompare.test.ts
git commit -m "feat(vuln): numeric build comparator for MSRC FixedBuild matching"
```

---

### Task 5: MSRC CVRF client + parser

**Files:**
- Create: `apps/api/src/services/msrcClient.ts`
- Test: `apps/api/src/services/msrcClient.test.ts`
- Create: `apps/api/src/services/__fixtures__/msrc-sample.json`

**Interfaces:**
- Consumes: nothing from prior tasks (network + pure parse).
- Produces:
  - `listUpdateMonths(): Promise<string[]>` — GETs `https://api.msrc.microsoft.com/cvrf/v3.0/updates`, returns IDs like `['2025-Aug', ...]`.
  - `fetchCvrf(month: string): Promise<unknown>` — GETs `https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/${month}` (JSON via `Accept: application/json`).
  - `parseCvrf(doc: unknown): MsrcRecord[]` where `MsrcRecord = { cveId: string; productName: string; cpe: string | null; cvssScore: number | null; cvssVector: string | null; severity: string | null; fixedBuild: string | null; kbArticle: string | null }`. One record per (CVE × affected ProductID) that has a `FixedBuild`.

- [ ] **Step 1: Create the fixture**

Fetch a real doc and trim to 1 product tree + 1 vulnerability with a FixedBuild remediation:
`curl -s -H 'Accept: application/json' https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/2025-Aug > /tmp/msrc.json` then hand-trim into `__fixtures__/msrc-sample.json` keeping the `ProductTree.FullProductName` array, one `Vulnerability` with `CVE`, `CVSSScoreSets`, `Threats`, and `Remediations` (Type 2 with `FixedBuild`, `ProductID`, `Description`). Preserve the real field casing.

- [ ] **Step 2: Write the failing parser test**

```ts
import { describe, it, expect } from 'vitest';
import { parseCvrf } from './msrcClient';
import sample from './__fixtures__/msrc-sample.json';

describe('parseCvrf', () => {
  it('emits one record per affected product with a FixedBuild', () => {
    const recs = parseCvrf(sample);
    expect(recs.length).toBeGreaterThan(0);
    const r = recs[0];
    expect(r.cveId).toMatch(/^CVE-\d{4}-\d+$/);
    expect(r.fixedBuild).toBeTruthy();
    expect(r.productName).toBeTruthy();
    expect(typeof r.cvssScore === 'number' || r.cvssScore === null).toBe(true);
  });
  it('derives a CVSS-bucket severity when score present', () => {
    const r = parseCvrf(sample).find((x) => x.cvssScore != null);
    if (r) expect(['Critical','High','Medium','Low']).toContain(r.severity);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/msrcClient.test.ts`
Expected: FAIL ("parseCvrf is not a function").

- [ ] **Step 4: Implement client + parser**

```ts
// apps/api/src/services/msrcClient.ts
const BASE = 'https://api.msrc.microsoft.com/cvrf/v3.0';

export interface MsrcRecord {
  cveId: string; productName: string; cpe: string | null;
  cvssScore: number | null; cvssVector: string | null; severity: string | null;
  fixedBuild: string | null; kbArticle: string | null;
}

export function severityFromCvss(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 9.0) return 'Critical';
  if (score >= 7.0) return 'High';
  if (score >= 4.0) return 'Medium';
  if (score > 0) return 'Low';
  return null;
}

export async function listUpdateMonths(): Promise<string[]> {
  const res = await fetch(`${BASE}/updates`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MSRC updates list failed: ${res.status}`);
  const body = (await res.json()) as { value?: Array<{ ID: string }> };
  return (body.value ?? []).map((u) => u.ID);
}

export async function fetchCvrf(month: string): Promise<unknown> {
  const res = await fetch(`${BASE}/cvrf/${month}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MSRC cvrf ${month} failed: ${res.status}`);
  return res.json();
}

export function parseCvrf(doc: unknown): MsrcRecord[] {
  const d = doc as any;
  const productNames = new Map<string, string>();
  const productCpe = new Map<string, string>();
  // ProductTree.FullProductName: [{ ProductID, Value, CPE? }]
  for (const p of d?.ProductTree?.FullProductName ?? []) {
    productNames.set(String(p.ProductID), p.Value);
    if (p.CPE) productCpe.set(String(p.ProductID), p.CPE);
  }
  const out: MsrcRecord[] = [];
  for (const v of d?.Vulnerability ?? []) {
    const cveId = v.CVE;
    if (!cveId) continue;
    const scoreSet = (v.CVSSScoreSets ?? [])[0];
    const cvssScore = scoreSet?.BaseScore != null ? Number(scoreSet.BaseScore) : null;
    const cvssVector = scoreSet?.Vector ?? null;
    const severity = severityFromCvss(cvssScore);
    // Remediations Type 2 = KB/build; carries FixedBuild + ProductID + Description (KB id)
    for (const rem of v.Remediations ?? []) {
      if (rem.Type !== 2 || !rem.FixedBuild) continue;
      for (const pid of rem.ProductID ?? []) {
        const id = String(pid);
        out.push({
          cveId,
          productName: productNames.get(id) ?? `ProductID ${id}`,
          cpe: productCpe.get(id) ?? null,
          cvssScore, cvssVector, severity,
          fixedBuild: rem.FixedBuild,
          kbArticle: rem.Description?.Value ?? rem.Description ?? null,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/msrcClient.test.ts`
Expected: PASS. (If the real fixture uses different casing/shape, adjust `parseCvrf` field access to match the fixture — the fixture is ground truth.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/msrcClient.ts apps/api/src/services/msrcClient.test.ts apps/api/src/services/__fixtures__/msrc-sample.json
git commit -m "feat(vuln): MSRC CVRF client + parser (FixedBuild flatten)"
```

---

### Task 6: `vuln-source-sync` job (MSRC ingestion)

**Files:**
- Create: `apps/api/src/jobs/vulnerabilityJobs.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/jobs/vulnerabilityJobs.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `parseCvrf`, `fetchCvrf`, `listUpdateMonths`, `MsrcRecord` (Task 5); schema tables (Task 1).
- Produces: `initializeVulnerabilityJobs()`, `shutdownVulnerabilityJobs()`, and an exported `syncMsrcMonth(month: string): Promise<{ vulns: number; matchFacts: number }>` that upserts into `vulnerabilities`, `software_products` (normalizedName = MSRC productName, cpe, cpeConfidence='authoritative'), and `software_vulnerabilities` (versionEndExcluding = FixedBuild), updating `vulnerability_sources` for source `'msrc'`. **All writes use `withSystemDbAccessContext`.**

- [ ] **Step 1: Add the Zod payload**

In `queueSchemas.ts`, add `export const vulnSourceSyncSchema = z.object({ source: z.enum(['msrc']), month: z.string().optional() });` and its inferred type, following the file's existing pattern.

- [ ] **Step 2: Write the failing integration test**

```ts
// runs against the test DB; seeds nothing tenant-scoped (global tables)
// `db` here is the imported proxy from '@/db' (or '../../db'); inside
// withSystemDbAccessContext it auto-resolves to the system context.
import { db, withSystemDbAccessContext } from '@/db';
import { vulnerabilities } from '@/db/schema';

it('upserts vulnerabilities and match facts from a CVRF month', async () => {
  // stub fetchCvrf to return the fixture (vi.mock the module)
  const res = await syncMsrcMonth('2025-Aug');
  expect(res.vulns).toBeGreaterThan(0);
  expect(res.matchFacts).toBeGreaterThan(0);
  const rows = await withSystemDbAccessContext(() =>
    db.select().from(vulnerabilities));
  expect(rows.some((r) => /^CVE-/.test(r.cveId))).toBe(true);
});
it('is idempotent — re-running the same month does not duplicate', async () => {
  await syncMsrcMonth('2025-Aug');
  const before = await countRows(vulnerabilities);
  await syncMsrcMonth('2025-Aug');
  const after = await countRows(vulnerabilities);
  expect(after).toBe(before);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobs.integration.test.ts`
Expected: FAIL ("syncMsrcMonth is not a function").

- [ ] **Step 4: Implement the job + sync**

Model the BullMQ wiring on `apps/api/src/jobs/offlineDetector.ts` (queue getter, `new Worker`, `initialize*`/`shutdown*`, `repeat: { pattern: '0 9 * * *' }` daily). `syncMsrcMonth`:
1. `const recs = await parseCvrf(await fetchCvrf(month))`.
2. In one `withSystemDbAccessContext` transaction: upsert each distinct `cveId` into `vulnerabilities` (`onConflictDoUpdate` on the `cve_id` unique index, set cvss/severity/modifiedAt, store `rawPayload`); upsert each distinct `productName` into `software_products` (`onConflictDoNothing` on the name/vendor unique index) and read back ids; upsert `software_vulnerabilities` rows (`productId`, `vulnerabilityId`, `versionEndExcluding = fixedBuild`) with a unique guard to dedupe.
3. Update `vulnerability_sources` row for `'msrc'`: `lastSuccessfulSyncAt = new Date()`, `lastSyncStatus='ok'`, `cursor = month`. On throw, set `lastSyncStatus='error'`, `lastSyncError`.
4. Return counts.

The repeatable worker handler resolves months to sync via `listUpdateMonths()` minus already-ingested (`cursor`), newest first.

- [ ] **Step 5: Wire into the server**

In `apps/api/src/index.ts`, import and call `initializeVulnerabilityJobs()` alongside the other `initialize*` calls, and `shutdownVulnerabilityJobs()` in the shutdown block.

- [ ] **Step 6: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobs.integration.test.ts`
Expected: PASS (both upsert + idempotency cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/vulnerabilityJobs.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/index.ts apps/api/src/jobs/vulnerabilityJobs.integration.test.ts
git commit -m "feat(vuln): MSRC vuln-source-sync job with idempotent upserts"
```

---

### Task 7: Correlation — materialize `device_vulnerabilities`

**Files:**
- Create: `apps/api/src/services/vulnerabilityCorrelation.ts`
- Test: `apps/api/src/services/vulnerabilityCorrelation.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: `compareBuilds`/`isVulnerable` (Task 4); schema tables (Task 1); `software_vulnerabilities` + `software_products` populated by Task 6.
- Produces: `correlateOrg(orgId: string): Promise<{ created: number; resolved: number }>` — for the org's `software_inventory` rows whose normalized `(name)` matches a `software_products` row, evaluate `isVulnerable(inventory.version, fact.versionEndExcluding)`; upsert open `device_vulnerabilities` (org_id, device_id, vulnerabilityId, softwareInventoryId, status='open', riskScore = cvssScore, detectedAt) and mark previously-open rows now patched as `status='patched', resolvedAt`.

- [ ] **Step 1: Write the failing integration test**

```ts
it('flags a device with a below-FixedBuild Office build, by CVSS', async () => {
  const { orgId, deviceId } = await seedOrgWithDevice();
  await seedSoftwareProductAndFact({ name: 'Microsoft 365 Apps for Enterprise', fixedBuild: '16.0.14332.20500', cvss: 9.8, cveId: 'CVE-2025-50165' });
  await seedInventory({ orgId, deviceId, name: 'Microsoft 365 Apps for Enterprise', version: '16.0.14332.20481' });
  const res = await correlateOrg(orgId);
  expect(res.created).toBe(1);
  const rows = await withDbAccessContext(orgCtx, (db) =>
    db.select().from(deviceVulnerabilities).where(eq(deviceVulnerabilities.deviceId, deviceId)));
  expect(rows[0].status).toBe('open');
  expect(Number(rows[0].riskScore)).toBe(9.8);
});

it('does not flag a device that is already at/above FixedBuild', async () => {
  const { orgId, deviceId } = await seedOrgWithDevice();
  await seedSoftwareProductAndFact({ name: 'Microsoft 365 Apps for Enterprise', fixedBuild: '16.0.14332.20500', cvss: 9.8, cveId: 'CVE-2025-50165' });
  await seedInventory({ orgId, deviceId, name: 'Microsoft 365 Apps for Enterprise', version: '16.0.14332.20600' });
  const res = await correlateOrg(orgId);
  expect(res.created).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation.integration.test.ts`
Expected: FAIL ("correlateOrg is not a function").

- [ ] **Step 3: Implement correlation**

`correlateOrg(orgId)` (writes via `withSystemDbAccessContext` for the global join read + the device_vulnerabilities writes, since match facts are global): join `software_inventory` (filtered by orgId, non-null version) → `software_products` on normalized name → `software_vulnerabilities` → `vulnerabilities`. For each candidate where `isVulnerable(inv.version, fact.versionEndExcluding)`, `onConflictDoNothing`-insert an open `device_vulnerabilities` row keyed on `(deviceId, vulnerabilityId)`; collect matched ids. Then `UPDATE device_vulnerabilities SET status='patched', resolvedAt=now() WHERE org_id=$1 AND status='open' AND id NOT IN (matched)`. Return `{created, resolved}`.

> Normalization for v1: case-insensitive exact match on `software_products.normalizedName = lower(trim(inventory.name))`. Trigram/fuzzy matching is a Phase 2 concern — keep v1 deterministic.

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation.integration.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityCorrelation.integration.test.ts
git commit -m "feat(vuln): device correlation via build-threshold match"
```

---

### Task 8: Read API endpoints

**Files:**
- Create: `apps/api/src/routes/vulnerabilities.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/vulnerabilities.test.ts`

**Interfaces:**
- Consumes: schema tables; the request `db` (tenant context) for `device_vulnerabilities`; `withSystemDbAccessContext` for joined global `vulnerabilities` fields.
- Produces: routes mounted at `/api/v1/vulnerabilities`.

- [ ] **Step 1: Write the failing route test**

Follow the Drizzle-mock pattern in a sibling route test (e.g. `apps/api/src/routes/devices/*.test.ts`). Assert:

```ts
it('GET /vulnerabilities returns fleet rows sorted by CVSS desc', async () => {
  const res = await app.request('/api/v1/vulnerabilities', { headers: authHeaders });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.items[0].cvssScore).toBeGreaterThanOrEqual(body.items[1].cvssScore);
});
it('GET /vulnerabilities/devices/:deviceId returns that device\'s open vulns', async () => {
  const res = await app.request(`/api/v1/vulnerabilities/devices/${deviceId}`, { headers: authHeaders });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilities.test.ts`
Expected: FAIL (404 / route not mounted).

- [ ] **Step 3: Implement the routes**

Export `vulnerabilityRoutes` (Hono). `GET /` — join `device_vulnerabilities` (request `db`, RLS scopes to caller's orgs) to `vulnerabilities` for cve/cvss/severity, filterable by `?severity=&status=&cve=`, `ORDER BY cvss_score DESC NULLS LAST`. `GET /devices/:deviceId` — same join filtered to the device, status default `open`. Use the existing auth middleware + `runAction` is not needed for reads. Mount in `index.ts`: `api.route('/vulnerabilities', vulnerabilityRoutes);`

- [ ] **Step 4: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/vulnerabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/vulnerabilities.ts apps/api/src/index.ts apps/api/src/routes/vulnerabilities.test.ts
git commit -m "feat(vuln): fleet + per-device vulnerability read APIs"
```

---

## Self-Review

**Spec coverage (v2 Phase 1 + the MSRC slice of Phase 2/3):**
- Schema (5 tables) + RLS → Task 1, 2. ✅
- Cascade/org-move wiring → Task 3. ✅
- MSRC ingestion (FixedBuild, CVSS, immutable rawPayload, source health) → Task 5, 6. ✅
- Build comparator → Task 4. ✅
- Device correlation (the join, CVSS as riskScore) → Task 7. ✅
- Read API, CVSS-sorted → Task 8. ✅
- **Deferred to later plans (intentionally out of scope here):** NVD third-party path, Apple SOFA, curated CPE map, remediate/accept-risk mutations, AI tools, events, network devices (Phase 5). Noted so the gap is explicit.

**Placeholder scan:** no TBD/TODO; every code step has real code; commands have expected output. ✅

**Type consistency:** `MsrcRecord` (Task 5) fields (`fixedBuild`, `cvssScore`, `productName`, `cpe`) are consumed unchanged in Task 6's upserts and Task 7's facts; `compareBuilds`/`isVulnerable` (Task 4) signatures match Task 7 usage; `correlateOrg`/`syncMsrcMonth` return shapes match their tests. ✅

## Notes for the implementer

- **Worktree:** create an isolated worktree first (`superpowers:using-git-worktrees`) and symlink the gitignored `.env.test` so RLS forge tests don't run vacuously on a BYPASSRLS connection (`[[worktree_env_test_rls_vacuous]]`).
- **Integration vs unit:** real-DB tasks (2, 3, 6, 7) must use `--config vitest.integration.config.ts`; running them under the plain config skips them vacuously.
- **MSRC fixture is ground truth:** if the live CVRF field casing differs from the parser, fix `parseCvrf` to the fixture, not the reverse.
