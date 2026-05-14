# Windows Third-Party Patching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Windows third-party application patching (Chrome, Firefox, Zoom, etc.) to feature parity with ManageEngine Desktop Central — using winget as the execution engine, a Breeze-curated catalog metadata layer on top, CVE-driven severity enrichment, and (eventually) an AI-driven release test harness instead of hand-testing.

**Architecture:**
- **Engine:** winget (already integrated as `WingetProvider` in `agent/internal/patching/winget.go`, registered when sessionBroker is present). Chocolatey remains as fallback.
- **Metadata:** new `third_party_package_catalog` table holds Breeze-curated entries (winget package ID → friendly name, vendor, category, severity policy, "Breeze-tested" flag). Catalog data enriches inbound patch scans at ingest time.
- **Severity / CVE:** a daily BullMQ worker queries OSV.dev for known vulns affecting catalog packages and bumps `patches.severity` when matches land in pending versions.
- **Approval:** zero new flow — winget patches flow into the existing `patches` table with `source='third_party'`; existing approval rings, deferrals, and `patchJobExecutor` work unchanged.
- **AI test routine (Phase 9):** when winget detects a new version of a Breeze-tested catalog package, queue an AI-driven smoke test on the Windows test VM (`100.101.150.55` per `windows_test_vm.md`). Test result writes back to `third_party_package_catalog.last_tested_at` and `last_tested_result`.

**Tech Stack:** Go 1.25.9 (agent), TypeScript + Hono (API), Drizzle (Postgres schema), React/Astro (web), BullMQ (jobs), Vitest (unit/integration), Go `testing` + `-race` (agent), Playwright (E2E — for UI work).

**Phasing & exit criteria:**
- **Phase 1** (Tasks 1–3): winget patches start landing in `patches` table tagged `source='third_party'`. Zero UI changes; verifies pipe end-to-end.
- **Phase 2** (Tasks 4–7): patches carry `vendor` + `packageId` so we can display "Firefox by Mozilla" instead of raw `Mozilla.Firefox`.
- **Phase 3** (Tasks 8–13): curated catalog table, seed data, and CRUD API.
- **Phase 4** (Tasks 14–15): catalog metadata enriches inbound scans (friendly title, severity default, category).
- **Phase 5** (Tasks 16–18): admin UI for catalog management.
- **Phase 6** (Tasks 19–20): third-party filter chip + source counter on `PatchesPage`.
- **Phase 7** (Tasks 21–24): OSV.dev CVE enrichment worker.
- **Phase 8** (Task 25): auto-approve third-party criticals via existing ring config.
- **Phase 9** (Tasks 26–29): AI-driven release test harness (scaffold; opt-in flag).

Each phase is independently shippable. Phases 5/6/8/9 can be skipped or deferred without breaking earlier phases.

**Self-imposed constraints:**
- **No editing shipped migrations.** All schema deltas are new dated migration files.
- **RLS:** `third_party_package_catalog` is a system-wide curated table (no `org_id`). It is intentionally unscoped — document in `rls-coverage.integration.test.ts` allowlist as `INTENTIONAL_UNSCOPED` (writes gated by partner-admin role at the route layer, not RLS).
- **File size:** keep new files under 500 lines per CLAUDE.md guidance. Split route/service files by responsibility, not by layer.
- **Tests with every behavior change.** Agent uses table-driven tests; API uses Vitest + Drizzle mocks for unit, real DB for integration. No mocking the DB in integration tests (per `breeze-testing` skill).
- **Frequent commits.** Each task ends in a single focused commit.

---

## File Structure

**New files**
- `apps/api/migrations/2026-05-13-a-patches-vendor-package-id.sql` — adds `patches.vendor` and `patches.package_id`
- `apps/api/migrations/2026-05-13-b-third-party-package-catalog.sql` — creates `third_party_package_catalog`
- `apps/api/migrations/2026-05-13-c-third-party-package-catalog-seed.sql` — seeds initial ~20 entries
- `apps/api/migrations/2026-05-13-d-third-party-cve-tracking.sql` — adds `last_cve_check_at` + `cve_ids` to catalog
- `apps/api/src/db/schema/thirdPartyCatalog.ts` — Drizzle schema for catalog
- `apps/api/src/routes/thirdPartyCatalog/index.ts` — Hono router (mount point)
- `apps/api/src/routes/thirdPartyCatalog/list.ts` — list + filter handler
- `apps/api/src/routes/thirdPartyCatalog/operations.ts` — create / update / delete handlers
- `apps/api/src/routes/thirdPartyCatalog/schemas.ts` — zod
- `apps/api/src/services/thirdPartyEnrichment.ts` — catalog lookup applied at ingest
- `apps/api/src/services/thirdPartyEnrichment.test.ts`
- `apps/api/src/jobs/cveEnrichmentWorker.ts` — BullMQ worker
- `apps/api/src/jobs/cveEnrichmentWorker.test.ts`
- `apps/api/src/services/osvClient.ts` — OSV.dev API wrapper
- `apps/api/src/services/osvClient.test.ts`
- `apps/api/src/jobs/wingetReleaseTestWorker.ts` — Phase 9 AI test orchestrator
- `apps/web/src/pages/admin/third-party-catalog.astro`
- `apps/web/src/components/admin/ThirdPartyCatalogPage.tsx`
- `apps/web/src/components/admin/ThirdPartyCatalogPage.test.tsx`
- `apps/web/src/components/admin/ThirdPartyCatalogEditor.tsx`

**Modified files**
- `agent/internal/heartbeat/heartbeat.go` — add `winget` cases to source/category maps; emit `Provider` + `ID` in availablePatchesToMaps/installedPatchesToMaps; vendor extraction
- `agent/internal/heartbeat/heartbeat_patchmap_test.go` (new) — table-driven tests for source mapping
- `apps/api/src/db/schema/patches.ts` — add `vendor`, `packageId` columns
- `apps/api/src/db/schema/index.ts` — re-export new catalog schema
- `apps/api/src/routes/agents/schemas.ts` (~line 431) — extend `submitPatchesSchema` with `vendor`, `packageId`
- `apps/api/src/routes/agents/patches.ts` — store new fields; call enrichment service
- `apps/api/src/routes/agents/patches.test.ts` (if absent, create) — covers vendor/packageId persistence
- `apps/api/src/routes/index.ts` — mount thirdPartyCatalog router
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add catalog to `INTENTIONAL_UNSCOPED`
- `apps/api/src/jobs/index.ts` — register cve worker + winget release test worker
- `apps/web/src/components/patches/PatchesPage.tsx` — add `third_party` filter chip and source counter
- `apps/web/src/components/patches/PatchList.tsx` — render vendor next to title for third-party rows
- `apps/web/src/components/patches/PatchesPage.test.tsx` — covers third-party filter

---

# Phase 1 — Wire winget into the patch pipeline

`WingetProvider` is already registered (`heartbeat.go:402`) but its scans land with `source='custom'` because `mapPatchProviderSource` has no winget case. Three tiny fixes get winget patches flowing into the existing `patches` table tagged `third_party`.

### Task 1: Map winget provider to `third_party` source and `application` category

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:1654-1683`
- Test: `agent/internal/heartbeat/heartbeat_patchmap_test.go` (new)

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/heartbeat/heartbeat_patchmap_test.go`:

```go
package heartbeat

import "testing"

func TestMapPatchProviderSource(t *testing.T) {
	h := &Heartbeat{}
	cases := []struct {
		provider string
		want     string
	}{
		{"windows-update", "microsoft"},
		{"apple-softwareupdate", "apple"},
		{"homebrew", "third_party"},
		{"chocolatey", "third_party"},
		{"winget", "third_party"},
		{"apt", "linux"},
		{"yum", "linux"},
		{"unknown", "custom"},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			if got := h.mapPatchProviderSource(c.provider); got != c.want {
				t.Errorf("mapPatchProviderSource(%q) = %q, want %q", c.provider, got, c.want)
			}
		})
	}
}

func TestMapPatchProviderCategory(t *testing.T) {
	h := &Heartbeat{}
	cases := []struct {
		provider string
		want     string
	}{
		{"windows-update", "system"},
		{"apple-softwareupdate", "system"},
		{"homebrew", "application"},
		{"chocolatey", "application"},
		{"winget", "application"},
		{"apt", "system"},
		{"yum", "system"},
		{"unknown", "application"},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			if got := h.mapPatchProviderCategory(c.provider); got != c.want {
				t.Errorf("mapPatchProviderCategory(%q) = %q, want %q", c.provider, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && go test -race -run TestMapPatchProvider ./internal/heartbeat/...
```

Expected: FAIL — winget subtests return `"custom"` / `"application"` (category passes by default fallthrough, source fails).

- [ ] **Step 3: Add winget cases**

In `agent/internal/heartbeat/heartbeat.go`, edit the two map functions:

```go
func (h *Heartbeat) mapPatchProviderSource(provider string) string {
	switch provider {
	case "windows-update":
		return "microsoft"
	case "apple-softwareupdate":
		return "apple"
	case "homebrew":
		return "third_party"
	case "chocolatey":
		return "third_party"
	case "winget":
		return "third_party"
	case "apt", "yum":
		return "linux"
	default:
		return "custom"
	}
}

func (h *Heartbeat) mapPatchProviderCategory(provider string) string {
	switch provider {
	case "windows-update", "apple-softwareupdate":
		return "system"
	case "homebrew", "chocolatey", "winget":
		return "application"
	case "apt", "yum":
		return "system"
	default:
		return "application"
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race -run TestMapPatchProvider ./internal/heartbeat/...
```

Expected: PASS for all subtests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_patchmap_test.go
git commit -m "feat(agent): map winget provider to third_party source"
```

---

### Task 2: Emit winget package ID as `externalId` for stable dedup

Without this, two scans of "Firefox 120.1" and "Firefox 121.0" produce different externalIds (`third_party:Firefox:120.1` vs `third_party:Firefox:121.0`) and create two rows. Use winget's stable package ID instead.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:1546-1565` (`availablePatchesToMaps`)
- Test: `agent/internal/heartbeat/heartbeat_patchmap_test.go`

- [ ] **Step 1: Read the current function**

Read lines 1540-1580 of `agent/internal/heartbeat/heartbeat.go` to confirm the current shape of `availablePatchesToMaps`.

- [ ] **Step 2: Add failing test for externalId fallback**

Append to `heartbeat_patchmap_test.go`:

```go
import "github.com/breeze-rmm/agent/internal/patching"

func TestAvailablePatchesToMaps_WingetExternalId(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{
			ID:       "Mozilla.Firefox",
			Provider: "winget",
			Title:    "Mozilla Firefox",
			Version:  "121.0",
			// no KBNumber for winget
		},
	})
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	if items[0]["externalId"] != "Mozilla.Firefox" {
		t.Errorf("externalId = %v, want Mozilla.Firefox", items[0]["externalId"])
	}
	if items[0]["packageId"] != "Mozilla.Firefox" {
		t.Errorf("packageId = %v, want Mozilla.Firefox", items[0]["packageId"])
	}
	if items[0]["source"] != "third_party" {
		t.Errorf("source = %v, want third_party", items[0]["source"])
	}
}

func TestAvailablePatchesToMaps_WindowsUpdateKeepsKB(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{
			ID:       "KB5034441",
			Provider: "windows-update",
			Title:    "Cumulative Update",
			KBNumber: "KB5034441",
		},
	})
	if items[0]["externalId"] != "KB5034441" {
		t.Errorf("externalId = %v, want KB5034441", items[0]["externalId"])
	}
}
```

- [ ] **Step 3: Run to verify failure**

```bash
cd agent && go test -race -run TestAvailablePatchesToMaps ./internal/heartbeat/...
```

Expected: FAIL — `externalId` is empty for winget (KBNumber unset), and `packageId` key doesn't exist.

- [ ] **Step 4: Update `availablePatchesToMaps`**

In `heartbeat.go`, replace the externalId line and add `packageId`:

```go
externalId := p.KBNumber
if externalId == "" {
	externalId = p.ID
}
items[i] = map[string]any{
	"name":            p.Title,
	"version":         p.Version,
	"category":        category,
	"severity":        severity,
	"description":     p.Description,
	"source":          h.mapPatchProviderSource(p.Provider),
	"externalId":      externalId,
	"packageId":       p.ID,
	"kbNumber":        p.KBNumber,
	"size":            p.Size,
	"requiresRestart": p.RebootRequired,
	"releaseDate":     p.ReleaseDate,
}
```

Apply the same `externalId` fallback inside `installedPatchesToMaps` (a few lines below, ~line 1576).

- [ ] **Step 5: Verify pass**

```bash
cd agent && go test -race ./internal/heartbeat/...
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_patchmap_test.go
git commit -m "feat(agent): emit winget package ID as stable externalId for third-party patches"
```

---

### Task 3: Accept `packageId` in the API patch submit schema and store it (interim — column added in Task 4)

Until Task 4 lands the DB column, accept the field in the schema as optional and stash it in `patches.metadata` so we don't lose data while phases roll out.

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` (~line 431)
- Modify: `apps/api/src/routes/agents/patches.ts` (~lines 42 and 106)

- [ ] **Step 1: Add `packageId` to schema (optional, max 256 chars)**

In `schemas.ts`, extend both arrays in `submitPatchesSchema`:

```ts
export const submitPatchesSchema = z.object({
  patches: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    currentVersion: z.string().optional(),
    kbNumber: z.string().optional(),
    externalId: z.string().optional(),
    packageId: z.string().max(256).optional(),
    category: z.string().optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    size: z.number().int().optional(),
    requiresRestart: z.boolean().optional(),
    releaseDate: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom')
  })).max(5000),
  installed: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    kbNumber: z.string().optional(),
    externalId: z.string().optional(),
    packageId: z.string().max(256).optional(),
    category: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom'),
    installedAt: z.string().optional()
  })).max(5000).optional()
});
```

- [ ] **Step 2: Stash `packageId` in metadata on insert**

In `apps/api/src/routes/agents/patches.ts`, in both insert blocks, derive metadata:

```ts
const metadata = patchData.packageId
  ? { packageId: patchData.packageId }
  : null;
// pass to .values({ ..., metadata })
// and to .onConflictDoUpdate({ set: { ..., metadata } })
```

- [ ] **Step 3: Run API tests to confirm no regressions**

```bash
pnpm test --filter=@breeze/api -- patches
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/patches.ts
git commit -m "feat(api): accept packageId on patch submit (interim metadata stash)"
```

**Phase 1 acceptance:** Build the Windows agent, deploy to the Windows test VM (`100.101.150.55`), run a patch scan, and verify rows appear in `patches` with `source='third_party'` and `metadata.packageId='Mozilla.Firefox'` (or whichever app reports an upgrade). One-line smoke check:

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
  "SELECT source, title, external_id, metadata FROM patches WHERE source='third_party' ORDER BY updated_at DESC LIMIT 5"
```

---

# Phase 2 — Promote vendor + packageId to first-class columns

### Task 4: Migration — add `vendor` and `package_id` to `patches`

**Files:**
- Create: `apps/api/migrations/2026-05-13-a-patches-vendor-package-id.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Add vendor + package_id to support third-party patch metadata
ALTER TABLE patches
  ADD COLUMN IF NOT EXISTS vendor varchar(255),
  ADD COLUMN IF NOT EXISTS package_id varchar(256);

CREATE INDEX IF NOT EXISTS patches_package_id_idx
  ON patches (package_id) WHERE package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS patches_source_package_id_idx
  ON patches (source, package_id) WHERE package_id IS NOT NULL;
```

- [ ] **Step 2: Run drift check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```

Expected: drift reported because schema file hasn't been updated yet. Fix in Task 5.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-05-13-a-patches-vendor-package-id.sql
git commit -m "feat(db): add patches.vendor and patches.package_id"
```

---

### Task 5: Update Drizzle schema to match migration

**Files:**
- Modify: `apps/api/src/db/schema/patches.ts:92-118`

- [ ] **Step 1: Add fields to the table definition**

In `patches.ts`, inside the `patches` table:

```ts
export const patches = pgTable('patches', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: patchSourceEnum('source').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  vendor: varchar('vendor', { length: 255 }),
  packageId: varchar('package_id', { length: 256 }),
  title: varchar('title', { length: 500 }).notNull(),
  // ...rest unchanged
});
```

- [ ] **Step 2: Verify drift is clean**

```bash
pnpm db:check-drift
```

Expected: no drift.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/patches.ts
git commit -m "feat(db): expose vendor + packageId in Drizzle patches schema"
```

---

### Task 6: Persist `vendor` + `packageId` columns (replace metadata stash)

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` — add optional `vendor`
- Modify: `apps/api/src/routes/agents/patches.ts` — write to columns
- Test: `apps/api/src/routes/agents/patches.test.ts`

- [ ] **Step 1: Add `vendor` to zod**

In `schemas.ts`, both array shapes:

```ts
vendor: z.string().max(255).optional(),
packageId: z.string().max(256).optional(),
```

- [ ] **Step 2: Write failing integration test**

Create or extend `apps/api/src/routes/agents/patches.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { db } from '../../db';
import { patches } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { setupTestApp, seedAgentDevice } from '../../__tests__/helpers';

describe('PUT /agents/:id/patches — third-party fields', () => {
  it('persists vendor and packageId for winget patches', async () => {
    const { app, agentId, deviceId } = await seedAgentDevice({ osType: 'windows' });

    const res = await app.request(`/agents/${agentId}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [{
          name: 'Mozilla Firefox',
          version: '121.0',
          source: 'third_party',
          packageId: 'Mozilla.Firefox',
          vendor: 'Mozilla',
          externalId: 'Mozilla.Firefox',
        }],
      }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(patches)
      .where(eq(patches.packageId, 'Mozilla.Firefox')).limit(1);
    expect(row).toBeDefined();
    expect(row.vendor).toBe('Mozilla');
    expect(row.source).toBe('third_party');
  });
});
```

(If `seedAgentDevice` doesn't exist, follow whatever helper pattern other `agents/*.test.ts` files use — read `apps/api/src/routes/agents/index.test.ts` first to mirror its setup.)

- [ ] **Step 3: Run, expect failure**

```bash
pnpm test --filter=@breeze/api -- patches.test.ts
```

Expected: FAIL — columns not yet written, query returns undefined.

- [ ] **Step 4: Wire columns into insert/upsert**

In `patches.ts` route handler, replace the metadata stash with direct columns:

```ts
.values({
  source: patchData.source,
  externalId,
  vendor: patchData.vendor ?? null,
  packageId: patchData.packageId ?? null,
  title: patchData.name,
  description: patchData.description || null,
  severity: patchData.severity || 'unknown',
  category: patchData.category || null,
  releaseDate: sanitizeDate(patchData.releaseDate),
  requiresReboot: patchData.requiresRestart || false,
  downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
  ...(inferredOsType ? { osTypes: [inferredOsType] } : {}),
})
.onConflictDoUpdate({
  target: [patches.source, patches.externalId],
  set: {
    title: patchData.name,
    vendor: patchData.vendor ?? sql`${patches.vendor}`,
    packageId: patchData.packageId ?? sql`${patches.packageId}`,
    description: patchData.description || null,
    severity: patchData.severity || 'unknown',
    category: patchData.category || null,
    requiresReboot: patchData.requiresRestart || false,
    updatedAt: new Date(),
  },
})
```

(`sql` is already imported from `drizzle-orm` at the top of the file.)

- [ ] **Step 5: Run, expect pass**

```bash
pnpm test --filter=@breeze/api -- patches.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/patches.ts apps/api/src/routes/agents/patches.test.ts
git commit -m "feat(api): persist vendor and packageId columns for third-party patches"
```

---

### Task 7: Emit `vendor` from agent winget scans

`winget upgrade` output doesn't include vendor as a separate column, but the winget package ID convention is `Vendor.Product` (e.g. `Mozilla.Firefox`, `Google.Chrome`). Extract the vendor heuristically — a stop-gap; richer enrichment comes from the catalog in Phase 4.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` — `availablePatchesToMaps`
- Test: `agent/internal/heartbeat/heartbeat_patchmap_test.go`

- [ ] **Step 1: Add failing test**

```go
func TestAvailablePatchesToMaps_WingetVendorFromId(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{ID: "Mozilla.Firefox", Provider: "winget", Title: "Mozilla Firefox", Version: "121.0"},
		{ID: "Google.Chrome", Provider: "winget", Title: "Google Chrome", Version: "120.0"},
		{ID: "7zip.7zip", Provider: "winget", Title: "7-Zip", Version: "23.01"},
		{ID: "NoDots", Provider: "winget", Title: "NoDots", Version: "1.0"},
	})
	wants := []string{"Mozilla", "Google", "7zip", ""}
	for i, w := range wants {
		if items[i]["vendor"] != w {
			t.Errorf("items[%d].vendor = %v, want %q", i, items[i]["vendor"], w)
		}
	}
}
```

- [ ] **Step 2: Add `extractVendor` helper**

Append in `heartbeat.go` near the patch map functions:

```go
// extractVendor pulls the publisher segment out of a winget-style package ID
// (e.g. "Mozilla.Firefox" → "Mozilla"). Returns "" if no dot is present.
func extractVendor(provider, packageID string) string {
	if provider != "winget" {
		return ""
	}
	if i := strings.Index(packageID, "."); i > 0 {
		return packageID[:i]
	}
	return ""
}
```

Then in `availablePatchesToMaps` and `installedPatchesToMaps`, add:

```go
items[i]["vendor"] = extractVendor(p.Provider, p.ID)
```

- [ ] **Step 3: Run tests**

```bash
cd agent && go test -race ./internal/heartbeat/...
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_patchmap_test.go
git commit -m "feat(agent): extract vendor from winget package IDs"
```

---

# Phase 3 — Curated catalog metadata layer

### Task 8: Migration — `third_party_package_catalog` table

**Files:**
- Create: `apps/api/migrations/2026-05-13-b-third-party-package-catalog.sql`

- [ ] **Step 1: Write migration**

```sql
-- Curated catalog of third-party packages with Breeze metadata.
-- System-wide (no org_id); writes gated to partner-admin role at the route layer.
-- Intentionally unscoped — listed in rls-coverage allowlist.

CREATE TABLE IF NOT EXISTS third_party_package_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source patch_source NOT NULL,
  package_id varchar(256) NOT NULL,
  vendor varchar(255) NOT NULL,
  friendly_name varchar(255) NOT NULL,
  category varchar(64) NOT NULL DEFAULT 'application',
  default_severity patch_severity NOT NULL DEFAULT 'unknown',
  breeze_tested boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_tested_version varchar(64),
  last_tested_result varchar(32),
  notes text,
  homepage_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT third_party_package_catalog_source_package_id_unique
    UNIQUE (source, package_id)
);

CREATE INDEX IF NOT EXISTS third_party_package_catalog_vendor_idx
  ON third_party_package_catalog (vendor);
```

- [ ] **Step 2: Apply and verify schema**

```bash
docker exec breeze-postgres psql -U breeze -d breeze \
  -c "\\d third_party_package_catalog"
```

Restart the API once or run `pnpm db:migrate` (whichever pattern other devs use locally). Expected: column list matches.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-05-13-b-third-party-package-catalog.sql
git commit -m "feat(db): add third_party_package_catalog table"
```

---

### Task 9: Drizzle schema + index export

**Files:**
- Create: `apps/api/src/db/schema/thirdPartyCatalog.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write schema file**

```ts
import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { patchSourceEnum, patchSeverityEnum } from './patches';

export const thirdPartyPackageCatalog = pgTable('third_party_package_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: patchSourceEnum('source').notNull(),
  packageId: varchar('package_id', { length: 256 }).notNull(),
  vendor: varchar('vendor', { length: 255 }).notNull(),
  friendlyName: varchar('friendly_name', { length: 255 }).notNull(),
  category: varchar('category', { length: 64 }).notNull().default('application'),
  defaultSeverity: patchSeverityEnum('default_severity').notNull().default('unknown'),
  breezeTested: boolean('breeze_tested').notNull().default(false),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestedVersion: varchar('last_tested_version', { length: 64 }),
  lastTestedResult: varchar('last_tested_result', { length: 32 }),
  notes: text('notes'),
  homepageUrl: text('homepage_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ThirdPartyPackageCatalog = typeof thirdPartyPackageCatalog.$inferSelect;
```

- [ ] **Step 2: Re-export from index**

Append to `apps/api/src/db/schema/index.ts`:

```ts
export * from './thirdPartyCatalog';
```

- [ ] **Step 3: Verify drift**

```bash
pnpm db:check-drift
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/thirdPartyCatalog.ts apps/api/src/db/schema/index.ts
git commit -m "feat(db): add Drizzle schema for third-party package catalog"
```

---

### Task 10: Seed initial catalog (~20 common apps)

**Files:**
- Create: `apps/api/migrations/2026-05-13-c-third-party-package-catalog-seed.sql`

- [ ] **Step 1: Write idempotent seed migration**

```sql
-- Seed Breeze-curated catalog with common third-party apps via winget.
-- ON CONFLICT DO NOTHING so re-running is a no-op.

INSERT INTO third_party_package_catalog
  (source, package_id, vendor, friendly_name, category, default_severity, breeze_tested, homepage_url)
VALUES
  ('third_party', 'Google.Chrome',        'Google',    'Google Chrome',         'application', 'important', false, 'https://www.google.com/chrome/'),
  ('third_party', 'Mozilla.Firefox',      'Mozilla',   'Mozilla Firefox',       'application', 'important', false, 'https://www.mozilla.org/firefox/'),
  ('third_party', 'Mozilla.Firefox.ESR',  'Mozilla',   'Firefox ESR',           'application', 'important', false, 'https://www.mozilla.org/firefox/enterprise/'),
  ('third_party', 'Microsoft.Edge',       'Microsoft', 'Microsoft Edge',        'application', 'important', false, 'https://www.microsoft.com/edge'),
  ('third_party', 'Zoom.Zoom',            'Zoom',      'Zoom',                  'application', 'important', false, 'https://zoom.us/'),
  ('third_party', 'Microsoft.Teams',      'Microsoft', 'Microsoft Teams',       'application', 'important', false, 'https://teams.microsoft.com'),
  ('third_party', 'SlackTechnologies.Slack','Slack',   'Slack',                 'application', 'moderate',  false, 'https://slack.com'),
  ('third_party', 'OBSProject.OBSStudio', 'OBS Project','OBS Studio',           'application', 'low',       false, 'https://obsproject.com'),
  ('third_party', '7zip.7zip',            '7zip',      '7-Zip',                 'application', 'moderate',  false, 'https://7-zip.org'),
  ('third_party', 'VideoLAN.VLC',         'VideoLAN',  'VLC media player',      'application', 'moderate',  false, 'https://videolan.org'),
  ('third_party', 'Notepad++.Notepad++',  'Notepad++', 'Notepad++',             'application', 'low',       false, 'https://notepad-plus-plus.org'),
  ('third_party', 'Adobe.Acrobat.Reader.64-bit','Adobe','Adobe Acrobat Reader', 'application', 'important', false, 'https://www.adobe.com/acrobat/pdf-reader.html'),
  ('third_party', 'Oracle.JavaRuntimeEnvironment','Oracle','Java Runtime',      'application', 'important', false, 'https://www.java.com'),
  ('third_party', 'OpenJS.NodeJS.LTS',    'OpenJS',    'Node.js LTS',           'application', 'important', false, 'https://nodejs.org'),
  ('third_party', 'Python.Python.3.12',   'Python',    'Python 3.12',           'application', 'important', false, 'https://www.python.org'),
  ('third_party', 'Git.Git',              'Git',       'Git',                   'application', 'moderate',  false, 'https://git-scm.com'),
  ('third_party', 'Microsoft.VisualStudioCode','Microsoft','Visual Studio Code','application', 'moderate',  false, 'https://code.visualstudio.com'),
  ('third_party', 'PuTTY.PuTTY',          'PuTTY',     'PuTTY',                 'application', 'moderate',  false, 'https://www.putty.org'),
  ('third_party', 'WinSCP.WinSCP',        'WinSCP',    'WinSCP',                'application', 'moderate',  false, 'https://winscp.net'),
  ('third_party', 'TeamViewer.TeamViewer','TeamViewer','TeamViewer',            'application', 'important', false, 'https://www.teamviewer.com')
ON CONFLICT (source, package_id) DO NOTHING;
```

- [ ] **Step 2: Apply and verify**

```bash
docker exec breeze-postgres psql -U breeze -d breeze \
  -c "SELECT count(*) FROM third_party_package_catalog"
```

Expected: 20 rows.

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/2026-05-13-c-third-party-package-catalog-seed.sql
git commit -m "feat(db): seed third-party catalog with 20 common apps"
```

---

### Task 11: Mark catalog as intentionally unscoped in RLS coverage test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Locate `INTENTIONAL_UNSCOPED` (or equivalent allowlist) and add `third_party_package_catalog`**

```bash
grep -n "INTENTIONAL_UNSCOPED\|device_commands" apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
```

Append `'third_party_package_catalog'` with a comment:

```ts
// System-wide curated catalog; writes gated by partner-admin role at route layer.
'third_party_package_catalog',
```

- [ ] **Step 2: Run the RLS coverage test (requires real DB)**

```bash
pnpm --filter=@breeze/api test:rls
```

Expected: PASS — catalog table is recognized as intentionally unscoped.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): allowlist third_party_package_catalog as intentionally unscoped"
```

---

### Task 12: Routes — list + filter

**Files:**
- Create: `apps/api/src/routes/thirdPartyCatalog/schemas.ts`
- Create: `apps/api/src/routes/thirdPartyCatalog/list.ts`
- Create: `apps/api/src/routes/thirdPartyCatalog/index.ts`
- Create: `apps/api/src/routes/thirdPartyCatalog/list.test.ts`
- Modify: `apps/api/src/routes/index.ts` — mount under `/third-party-catalog`

- [ ] **Step 1: Write `schemas.ts`**

```ts
import { z } from 'zod';

export const listCatalogQuerySchema = z.object({
  vendor: z.string().optional(),
  breezeTested: z.enum(['true', 'false']).optional(),
  search: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const upsertCatalogSchema = z.object({
  source: z.enum(['third_party', 'custom']).default('third_party'),
  packageId: z.string().min(1).max(256),
  vendor: z.string().min(1).max(255),
  friendlyName: z.string().min(1).max(255),
  category: z.string().max(64).optional(),
  defaultSeverity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  breezeTested: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  homepageUrl: z.string().url().nullable().optional(),
});
```

- [ ] **Step 2: Write `list.ts`**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { thirdPartyPackageCatalog } from '../../db/schema';
import { listCatalogQuerySchema } from './schemas';

export const listRoutes = new Hono();

listRoutes.get('/', zValidator('query', listCatalogQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const filters = [];
  if (q.vendor) filters.push(eq(thirdPartyPackageCatalog.vendor, q.vendor));
  if (q.breezeTested) filters.push(eq(thirdPartyPackageCatalog.breezeTested, q.breezeTested === 'true'));
  if (q.search) {
    filters.push(or(
      ilike(thirdPartyPackageCatalog.friendlyName, `%${q.search}%`),
      ilike(thirdPartyPackageCatalog.packageId, `%${q.search}%`),
      ilike(thirdPartyPackageCatalog.vendor, `%${q.search}%`),
    )!);
  }
  const where = filters.length ? and(...filters) : undefined;

  const [rows, total] = await Promise.all([
    db.select().from(thirdPartyPackageCatalog)
      .where(where).orderBy(thirdPartyPackageCatalog.vendor, thirdPartyPackageCatalog.friendlyName)
      .limit(q.limit).offset(q.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(thirdPartyPackageCatalog).where(where),
  ]);

  return c.json({ items: rows, total: total[0]?.count ?? 0, limit: q.limit, offset: q.offset });
});
```

- [ ] **Step 3: Write `index.ts`**

```ts
import { Hono } from 'hono';
import { listRoutes } from './list';

export const thirdPartyCatalogRoutes = new Hono();
thirdPartyCatalogRoutes.route('/', listRoutes);
```

- [ ] **Step 4: Mount in main routes index**

```bash
grep -n "patchesRoutes\|patches" apps/api/src/routes/index.ts | head -5
```

Then add (matching local convention):

```ts
import { thirdPartyCatalogRoutes } from './thirdPartyCatalog';
// ...
app.route('/third-party-catalog', thirdPartyCatalogRoutes);
```

- [ ] **Step 5: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp, loginTestUser } from '../../__tests__/helpers';

describe('GET /third-party-catalog', () => {
  it('returns seeded entries', async () => {
    const { app } = await createTestApp();
    const { token } = await loginTestUser(app);
    const res = await app.request('/third-party-catalog?limit=5', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThanOrEqual(20);
  });

  it('filters by vendor', async () => {
    const { app } = await createTestApp();
    const { token } = await loginTestUser(app);
    const res = await app.request('/third-party-catalog?vendor=Mozilla', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.items.every((r: any) => r.vendor === 'Mozilla')).toBe(true);
  });

  it('search matches friendly_name', async () => {
    const { app } = await createTestApp();
    const { token } = await loginTestUser(app);
    const res = await app.request('/third-party-catalog?search=firefox', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.items.some((r: any) => /firefox/i.test(r.friendlyName))).toBe(true);
  });
});
```

(Adjust helper imports to match `apps/api/src/routes/patches/index.test.ts`.)

- [ ] **Step 6: Run and pass**

```bash
pnpm test --filter=@breeze/api -- thirdPartyCatalog
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/thirdPartyCatalog/ apps/api/src/routes/index.ts
git commit -m "feat(api): add GET /third-party-catalog list endpoint"
```

---

### Task 13: Routes — create, update, delete (partner-admin only)

**Files:**
- Create: `apps/api/src/routes/thirdPartyCatalog/operations.ts`
- Modify: `apps/api/src/routes/thirdPartyCatalog/index.ts` — mount operations
- Create: `apps/api/src/routes/thirdPartyCatalog/operations.test.ts`

- [ ] **Step 1: Write failing test for partner-admin gate**

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp, loginTestUser, loginPartnerAdmin } from '../../__tests__/helpers';

describe('Catalog mutations require partner admin', () => {
  it('rejects normal user create', async () => {
    const { app } = await createTestApp();
    const { token } = await loginTestUser(app);
    const res = await app.request('/third-party-catalog', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'third_party', packageId: 'X.Y', vendor: 'X', friendlyName: 'Y' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows partner admin to create', async () => {
    const { app } = await createTestApp();
    const { token } = await loginPartnerAdmin(app);
    const res = await app.request('/third-party-catalog', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'third_party',
        packageId: 'Test.Package',
        vendor: 'Test',
        friendlyName: 'Test Package',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.packageId).toBe('Test.Package');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Expected: 404 (route not mounted) or 200 — both fail the expectation.

- [ ] **Step 3: Write `operations.ts`**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { thirdPartyPackageCatalog } from '../../db/schema';
import { upsertCatalogSchema } from './schemas';
import { requirePartnerAdmin } from '../../middleware/requireRole'; // verify name in repo

export const operationsRoutes = new Hono();

operationsRoutes.use('*', requirePartnerAdmin);

operationsRoutes.post('/', zValidator('json', upsertCatalogSchema), async (c) => {
  const data = c.req.valid('json');
  const [row] = await db.insert(thirdPartyPackageCatalog).values({
    source: data.source,
    packageId: data.packageId,
    vendor: data.vendor,
    friendlyName: data.friendlyName,
    category: data.category ?? 'application',
    defaultSeverity: data.defaultSeverity ?? 'unknown',
    breezeTested: data.breezeTested ?? false,
    notes: data.notes ?? null,
    homepageUrl: data.homepageUrl ?? null,
  }).returning();
  return c.json(row, 201);
});

operationsRoutes.patch('/:id', zValidator('json', upsertCatalogSchema.partial()), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const [row] = await db.update(thirdPartyPackageCatalog)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(thirdPartyPackageCatalog.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

operationsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await db.delete(thirdPartyPackageCatalog)
    .where(eq(thirdPartyPackageCatalog.id, id))
    .returning({ id: thirdPartyPackageCatalog.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: true });
});
```

(Verify `requirePartnerAdmin` exists — grep `apps/api/src/middleware/` first. If a different name is used, use that. If none exists, implement inline with a check like `c.get('user')?.role !== 'partner_admin'`.)

- [ ] **Step 4: Mount in catalog index**

```ts
import { Hono } from 'hono';
import { listRoutes } from './list';
import { operationsRoutes } from './operations';

export const thirdPartyCatalogRoutes = new Hono();
thirdPartyCatalogRoutes.route('/', listRoutes);
thirdPartyCatalogRoutes.route('/', operationsRoutes);
```

- [ ] **Step 5: Run all catalog tests**

```bash
pnpm test --filter=@breeze/api -- thirdPartyCatalog
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/thirdPartyCatalog/
git commit -m "feat(api): add catalog create/update/delete with partner-admin gate"
```

---

# Phase 4 — Enrich inbound patch scans with catalog

### Task 14: Enrichment service

**Files:**
- Create: `apps/api/src/services/thirdPartyEnrichment.ts`
- Create: `apps/api/src/services/thirdPartyEnrichment.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { enrichFromCatalog, primeCatalogCache } from './thirdPartyEnrichment';

describe('enrichFromCatalog', () => {
  beforeEach(async () => {
    await primeCatalogCache(); // force refresh
  });

  it('overrides title + vendor + severity when catalog hit', async () => {
    const enriched = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      title: 'Mozilla Firefox',
      vendor: null,
      severity: null,
    });
    expect(enriched.title).toBe('Mozilla Firefox');
    expect(enriched.vendor).toBe('Mozilla');
    expect(enriched.severity).toBe('important');
    expect(enriched.matchedCatalogId).toBeTruthy();
  });

  it('passes through unchanged when no catalog hit', async () => {
    const enriched = await enrichFromCatalog({
      source: 'third_party',
      packageId: 'Unknown.Pkg',
      title: 'Unknown',
      vendor: 'X',
      severity: 'low',
    });
    expect(enriched.matchedCatalogId).toBeNull();
    expect(enriched.severity).toBe('low');
  });

  it('does not enrich non-third_party sources', async () => {
    const enriched = await enrichFromCatalog({
      source: 'microsoft',
      packageId: 'Mozilla.Firefox',
      title: 'Cumulative Update',
      vendor: null,
      severity: null,
    });
    expect(enriched.matchedCatalogId).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test --filter=@breeze/api -- thirdPartyEnrichment.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement service with in-memory cache (refreshed every 5 min)**

```ts
import { db } from '../db';
import { thirdPartyPackageCatalog } from '../db/schema';

type CatalogEntry = {
  id: string;
  source: string;
  packageId: string;
  vendor: string;
  friendlyName: string;
  category: string;
  defaultSeverity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: Map<string, CatalogEntry> | null = null;
let cacheLoadedAt = 0;

function cacheKey(source: string, packageId: string): string {
  return `${source}::${packageId}`;
}

async function loadCache(): Promise<Map<string, CatalogEntry>> {
  const rows = await db.select({
    id: thirdPartyPackageCatalog.id,
    source: thirdPartyPackageCatalog.source,
    packageId: thirdPartyPackageCatalog.packageId,
    vendor: thirdPartyPackageCatalog.vendor,
    friendlyName: thirdPartyPackageCatalog.friendlyName,
    category: thirdPartyPackageCatalog.category,
    defaultSeverity: thirdPartyPackageCatalog.defaultSeverity,
  }).from(thirdPartyPackageCatalog);
  const map = new Map<string, CatalogEntry>();
  for (const r of rows) map.set(cacheKey(r.source, r.packageId), r as CatalogEntry);
  return map;
}

export async function primeCatalogCache(): Promise<void> {
  cache = await loadCache();
  cacheLoadedAt = Date.now();
}

async function getCache(): Promise<Map<string, CatalogEntry>> {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    await primeCatalogCache();
  }
  return cache!;
}

export interface EnrichmentInput {
  source: string;
  packageId: string | null;
  title: string;
  vendor: string | null;
  severity: string | null;
  category?: string | null;
}

export interface EnrichmentOutput {
  title: string;
  vendor: string | null;
  severity: string | null;
  category: string | null;
  matchedCatalogId: string | null;
}

export async function enrichFromCatalog(input: EnrichmentInput): Promise<EnrichmentOutput> {
  if (input.source !== 'third_party' || !input.packageId) {
    return {
      title: input.title,
      vendor: input.vendor,
      severity: input.severity,
      category: input.category ?? null,
      matchedCatalogId: null,
    };
  }
  const map = await getCache();
  const hit = map.get(cacheKey(input.source, input.packageId));
  if (!hit) {
    return {
      title: input.title,
      vendor: input.vendor,
      severity: input.severity,
      category: input.category ?? null,
      matchedCatalogId: null,
    };
  }
  return {
    title: hit.friendlyName,
    vendor: hit.vendor,
    severity: input.severity && input.severity !== 'unknown' ? input.severity : hit.defaultSeverity,
    category: hit.category,
    matchedCatalogId: hit.id,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test --filter=@breeze/api -- thirdPartyEnrichment.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/thirdPartyEnrichment.ts apps/api/src/services/thirdPartyEnrichment.test.ts
git commit -m "feat(api): add third-party catalog enrichment service"
```

---

### Task 15: Apply enrichment in the agent patch submit handler

**Files:**
- Modify: `apps/api/src/routes/agents/patches.ts`
- Modify: `apps/api/src/routes/agents/patches.test.ts`

- [ ] **Step 1: Write failing test**

In `patches.test.ts`, add:

```ts
it('enriches title and severity from catalog on submit', async () => {
  const { app, agentId } = await seedAgentDevice({ osType: 'windows' });
  const res = await app.request(`/agents/${agentId}/patches`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patches: [{
        name: 'firefox',  // raw scan title
        version: '121.0',
        source: 'third_party',
        packageId: 'Mozilla.Firefox',
        externalId: 'Mozilla.Firefox',
      }],
    }),
  });
  expect(res.status).toBe(200);

  const [row] = await db.select().from(patches)
    .where(eq(patches.packageId, 'Mozilla.Firefox')).limit(1);
  expect(row.title).toBe('Mozilla Firefox'); // catalog friendly_name
  expect(row.vendor).toBe('Mozilla');
  expect(row.severity).toBe('important'); // catalog default
});
```

- [ ] **Step 2: Run, expect FAIL**

Expected: FAIL (title is 'firefox', severity is 'unknown').

- [ ] **Step 3: Wire enrichment into the loop**

In `patches.ts`, before the insert:

```ts
import { enrichFromCatalog } from '../../services/thirdPartyEnrichment';

// inside the for loop:
const enriched = await enrichFromCatalog({
  source: patchData.source,
  packageId: patchData.packageId ?? null,
  title: patchData.name,
  vendor: patchData.vendor ?? null,
  severity: patchData.severity ?? null,
  category: patchData.category ?? null,
});

const [patch] = await tx.insert(patches).values({
  source: patchData.source,
  externalId,
  vendor: enriched.vendor,
  packageId: patchData.packageId ?? null,
  title: enriched.title,
  description: patchData.description || null,
  severity: enriched.severity ?? 'unknown',
  category: enriched.category ?? null,
  releaseDate: sanitizeDate(patchData.releaseDate),
  requiresReboot: patchData.requiresRestart || false,
  downloadSizeMb: patchData.size ? Math.ceil(patchData.size / (1024 * 1024)) : null,
  ...(inferredOsType ? { osTypes: [inferredOsType] } : {}),
}).onConflictDoUpdate({
  target: [patches.source, patches.externalId],
  set: {
    title: enriched.title,
    vendor: enriched.vendor ?? sql`${patches.vendor}`,
    severity: enriched.severity ?? 'unknown',
    category: enriched.category ?? null,
    description: patchData.description || null,
    requiresReboot: patchData.requiresRestart || false,
    updatedAt: new Date(),
  },
});
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test --filter=@breeze/api -- patches.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/patches.ts apps/api/src/routes/agents/patches.test.ts
git commit -m "feat(api): enrich third-party patches from catalog at ingest"
```

---

# Phase 5 — Admin UI for catalog

### Task 16: Catalog list page (read-only)

**Files:**
- Create: `apps/web/src/pages/admin/third-party-catalog.astro`
- Create: `apps/web/src/components/admin/ThirdPartyCatalogPage.tsx`
- Create: `apps/web/src/components/admin/ThirdPartyCatalogPage.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThirdPartyCatalogPage } from './ThirdPartyCatalogPage';

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    items: [
      { id: '1', vendor: 'Mozilla', friendlyName: 'Mozilla Firefox', packageId: 'Mozilla.Firefox', breezeTested: true, defaultSeverity: 'important' },
      { id: '2', vendor: 'Google', friendlyName: 'Google Chrome', packageId: 'Google.Chrome', breezeTested: false, defaultSeverity: 'important' },
    ],
    total: 2,
  }),
}));

describe('ThirdPartyCatalogPage', () => {
  it('renders catalog entries grouped by vendor', async () => {
    render(<ThirdPartyCatalogPage />);
    await waitFor(() => expect(screen.getByText('Mozilla Firefox')).toBeInTheDocument());
    expect(screen.getByText('Google Chrome')).toBeInTheDocument();
  });

  it('shows breeze-tested badge', async () => {
    render(<ThirdPartyCatalogPage />);
    await waitFor(() => expect(screen.getByTestId('catalog-row-1-tested-badge')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-row-2-tested-badge')).toBeNull();
  });
});
```

- [ ] **Step 2: Write component**

```tsx
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface CatalogEntry {
  id: string;
  vendor: string;
  friendlyName: string;
  packageId: string;
  breezeTested: boolean;
  defaultSeverity: string;
}

export function ThirdPartyCatalogPage() {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    apiFetch<{ items: CatalogEntry[]; total: number }>(`/third-party-catalog${q}`)
      .then(r => setItems(r.items))
      .finally(() => setLoading(false));
  }, [search]);

  if (loading) return <div>Loading…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Third-Party Package Catalog</h1>
      <input
        data-testid="catalog-search"
        placeholder="Search by name, vendor, or package ID…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="border rounded px-3 py-2 w-full mb-4"
      />
      <table className="w-full">
        <thead>
          <tr className="text-left border-b">
            <th>Vendor</th><th>Package</th><th>Winget ID</th><th>Severity</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map(e => (
            <tr key={e.id} data-testid={`catalog-row-${e.id}`} className="border-b">
              <td>{e.vendor}</td>
              <td>{e.friendlyName}</td>
              <td className="font-mono text-sm">{e.packageId}</td>
              <td>{e.defaultSeverity}</td>
              <td>
                {e.breezeTested && (
                  <span data-testid={`catalog-row-${e.id}-tested-badge`} className="badge badge-green">
                    Breeze-tested
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Wrap in Astro page**

```astro
---
import Layout from '../../layouts/Admin.astro';
import { ThirdPartyCatalogPage } from '../../components/admin/ThirdPartyCatalogPage';
---
<Layout title="Third-Party Catalog">
  <ThirdPartyCatalogPage client:load />
</Layout>
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
pnpm test --filter=@breeze/web -- ThirdPartyCatalogPage
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/third-party-catalog.astro apps/web/src/components/admin/
git commit -m "feat(web): add third-party catalog admin page (read-only)"
```

---

### Task 17: Catalog editor (create / edit / delete)

**Files:**
- Create: `apps/web/src/components/admin/ThirdPartyCatalogEditor.tsx`
- Modify: `apps/web/src/components/admin/ThirdPartyCatalogPage.tsx`
- Modify: `apps/web/src/components/admin/ThirdPartyCatalogPage.test.tsx`

- [ ] **Step 1: Add failing tests**

```tsx
it('opens editor when "Add package" clicked', async () => {
  const user = userEvent.setup();
  render(<ThirdPartyCatalogPage />);
  await user.click(await screen.findByTestId('catalog-add-button'));
  expect(screen.getByTestId('catalog-editor-modal')).toBeInTheDocument();
});

it('submits new entry to POST /third-party-catalog', async () => {
  const user = userEvent.setup();
  const postMock = vi.fn().mockResolvedValue({ id: 'new', vendor: 'X', friendlyName: 'Y', packageId: 'X.Y' });
  (apiFetch as any).mockImplementation((url: string, opts?: any) =>
    opts?.method === 'POST' ? postMock(url, opts) : Promise.resolve({ items: [], total: 0 })
  );

  render(<ThirdPartyCatalogPage />);
  await user.click(await screen.findByTestId('catalog-add-button'));
  await user.type(screen.getByTestId('catalog-editor-packageId'), 'X.Y');
  await user.type(screen.getByTestId('catalog-editor-vendor'), 'X');
  await user.type(screen.getByTestId('catalog-editor-friendlyName'), 'Y');
  await user.click(screen.getByTestId('catalog-editor-submit'));

  await waitFor(() => expect(postMock).toHaveBeenCalled());
});
```

- [ ] **Step 2: Build the editor modal**

`ThirdPartyCatalogEditor.tsx`:

```tsx
import { useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Props {
  initial?: { id?: string; packageId?: string; vendor?: string; friendlyName?: string; defaultSeverity?: string; breezeTested?: boolean; notes?: string; homepageUrl?: string };
  onClose: () => void;
  onSaved: () => void;
}

export function ThirdPartyCatalogEditor({ initial, onClose, onSaved }: Props) {
  const [packageId, setPackageId] = useState(initial?.packageId ?? '');
  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [friendlyName, setFriendlyName] = useState(initial?.friendlyName ?? '');
  const [defaultSeverity, setDefaultSeverity] = useState(initial?.defaultSeverity ?? 'unknown');
  const [breezeTested, setBreezeTested] = useState(initial?.breezeTested ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [homepageUrl, setHomepageUrl] = useState(initial?.homepageUrl ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const body = { source: 'third_party', packageId, vendor, friendlyName, defaultSeverity, breezeTested, notes: notes || null, homepageUrl: homepageUrl || null };
      const url = initial?.id ? `/third-party-catalog/${initial.id}` : '/third-party-catalog';
      const method = initial?.id ? 'PATCH' : 'POST';
      await apiFetch(url, { method, body: JSON.stringify(body) });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="catalog-editor-modal" className="modal">
      <h2>{initial?.id ? 'Edit' : 'Add'} package</h2>
      <input data-testid="catalog-editor-packageId" placeholder="Winget ID (e.g. Mozilla.Firefox)" value={packageId} onChange={e => setPackageId(e.target.value)} />
      <input data-testid="catalog-editor-vendor" placeholder="Vendor" value={vendor} onChange={e => setVendor(e.target.value)} />
      <input data-testid="catalog-editor-friendlyName" placeholder="Friendly name" value={friendlyName} onChange={e => setFriendlyName(e.target.value)} />
      <select data-testid="catalog-editor-severity" value={defaultSeverity} onChange={e => setDefaultSeverity(e.target.value)}>
        {['critical','important','moderate','low','unknown'].map(s => <option key={s}>{s}</option>)}
      </select>
      <label><input type="checkbox" data-testid="catalog-editor-tested" checked={breezeTested} onChange={e => setBreezeTested(e.target.checked)} /> Breeze-tested</label>
      <input data-testid="catalog-editor-homepage" placeholder="Homepage URL" value={homepageUrl} onChange={e => setHomepageUrl(e.target.value)} />
      <textarea data-testid="catalog-editor-notes" placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} />
      <button data-testid="catalog-editor-submit" disabled={saving || !packageId || !vendor || !friendlyName} onClick={submit}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button data-testid="catalog-editor-cancel" onClick={onClose}>Cancel</button>
    </div>
  );
}
```

- [ ] **Step 3: Wire into the page**

In `ThirdPartyCatalogPage.tsx`, add an "Add package" button + Edit / Delete buttons per row, and render `ThirdPartyCatalogEditor` when an editor state is set. After save, re-fetch the list.

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test --filter=@breeze/web -- ThirdPartyCatalogPage
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/admin/
git commit -m "feat(web): add catalog editor (create/edit/delete)"
```

---

### Task 18: Playwright E2E for catalog admin

**Files:**
- Create: `e2e-tests/tests/third_party_catalog.yaml`

- [ ] **Step 1: Write the YAML test**

Following the convention in `e2e-tests/tests/dashboard_comprehensive.yaml`:

```yaml
name: third_party_catalog
description: Partner admin can view and edit the third-party package catalog.

steps:
  - name: Login as partner admin
    action: ui
    do:
      - goto: /
      - fill: { selector: '[data-testid=login-email]', value: '{{env.E2E_PARTNER_ADMIN_EMAIL}}' }
      - fill: { selector: '[data-testid=login-password]', value: '{{env.E2E_PARTNER_ADMIN_PASSWORD}}' }
      - click: '[data-testid=login-submit]'
      - waitFor: { url: /\/dashboard/ }

  - name: View catalog
    action: ui
    do:
      - goto: /admin/third-party-catalog
      - waitFor: { selector: '[data-testid^=catalog-row-]' }
    expect:
      domVisible: '[data-testid=catalog-add-button]'

  - name: List catalog via API
    action: api
    request:
      method: GET
      url: /third-party-catalog?search=firefox
    expect:
      status: 200
      body:
        total: ">= 1"
```

- [ ] **Step 2: Run in simulate then live**

```bash
cd e2e-tests && npx tsx run.ts --mode simulate -- third_party_catalog
cd e2e-tests && npx tsx run.ts --mode live -- third_party_catalog
```

Expected: pass in both modes (live requires `E2E_PARTNER_ADMIN_*` env vars).

- [ ] **Step 3: Commit**

```bash
git add e2e-tests/tests/third_party_catalog.yaml
git commit -m "test(e2e): catalog admin view + API list"
```

---

# Phase 6 — Patches UI: third-party filter + source counter

### Task 19: Source counter on `PatchesPage`

**Files:**
- Modify: `apps/web/src/components/patches/PatchesPage.tsx`
- Modify: `apps/web/src/components/patches/PatchesPage.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `PatchesPage.test.tsx`:

```tsx
it('shows source counts for microsoft/apple/linux/third_party', async () => {
  mockListResponse({
    items: [],
    counts: { microsoft: 12, apple: 3, linux: 5, third_party: 18, custom: 0 },
  });
  render(<PatchesPage />);
  await waitFor(() => expect(screen.getByTestId('patches-count-third_party')).toHaveTextContent('18'));
  expect(screen.getByTestId('patches-count-microsoft')).toHaveTextContent('12');
});
```

- [ ] **Step 2: Implement counts API + UI**

If the patches list endpoint doesn't already return source counts, extend `apps/api/src/routes/patches/list.ts` to return `counts: Record<PatchSource, number>` alongside `items`. (Tests for that go in `apps/api/src/routes/patches/index.test.ts`.)

Then in `PatchesPage.tsx`, render the counter chips:

```tsx
<div className="flex gap-2 mb-4">
  {(['microsoft','apple','linux','third_party'] as const).map(s => (
    <button
      key={s}
      data-testid={`patches-filter-${s}`}
      onClick={() => setSourceFilter(s)}
      className={sourceFilter === s ? 'chip chip-active' : 'chip'}
    >
      {labelFor(s)}{' '}
      <span data-testid={`patches-count-${s}`}>{counts[s] ?? 0}</span>
    </button>
  ))}
</div>
```

- [ ] **Step 3: Run tests**

```bash
pnpm test --filter=@breeze/web -- PatchesPage
pnpm test --filter=@breeze/api -- patches/index
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/patches/ apps/api/src/routes/patches/
git commit -m "feat(patches): show per-source counts and filter chips"
```

---

### Task 20: Render vendor inline in PatchList for third-party rows

**Files:**
- Modify: `apps/web/src/components/patches/PatchList.tsx`
- Modify: `apps/web/src/components/patches/PatchesPage.test.tsx` (or PatchList.test.tsx if exists)

- [ ] **Step 1: Failing test**

```tsx
it('renders vendor next to title for third-party patches', () => {
  render(<PatchList items={[
    { id: '1', source: 'third_party', vendor: 'Mozilla', title: 'Mozilla Firefox', severity: 'important' },
    { id: '2', source: 'microsoft', vendor: null, title: 'KB5034441', severity: 'critical' },
  ]} />);
  expect(screen.getByTestId('patch-row-1-vendor')).toHaveTextContent('Mozilla');
  expect(screen.queryByTestId('patch-row-2-vendor')).toBeNull();
});
```

- [ ] **Step 2: Implement**

In `PatchList.tsx`:

```tsx
{p.source === 'third_party' && p.vendor && (
  <span data-testid={`patch-row-${p.id}-vendor`} className="text-sm text-neutral-500 ml-2">
    by {p.vendor}
  </span>
)}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test --filter=@breeze/web -- PatchList
git add apps/web/src/components/patches/
git commit -m "feat(patches): render vendor for third-party rows"
```

---

# Phase 7 — CVE enrichment worker

### Task 21: Migration — CVE tracking columns on catalog

**Files:**
- Create: `apps/api/migrations/2026-05-13-d-third-party-cve-tracking.sql`
- Modify: `apps/api/src/db/schema/thirdPartyCatalog.ts`
- Modify: `apps/api/src/db/schema/patches.ts`

- [ ] **Step 1: Migration**

```sql
ALTER TABLE third_party_package_catalog
  ADD COLUMN IF NOT EXISTS last_cve_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS osv_ecosystem varchar(64);

-- patches.cve_ids: array of CVE IDs that affect this patch (only used for third_party)
ALTER TABLE patches
  ADD COLUMN IF NOT EXISTS cve_ids text[];

CREATE INDEX IF NOT EXISTS patches_cve_ids_gin_idx
  ON patches USING gin (cve_ids) WHERE cve_ids IS NOT NULL;
```

- [ ] **Step 2: Update schemas**

Add to `thirdPartyCatalog.ts`:

```ts
lastCveCheckAt: timestamp('last_cve_check_at', { withTimezone: true }),
osvEcosystem: varchar('osv_ecosystem', { length: 64 }),
```

Add to `patches.ts`:

```ts
cveIds: text('cve_ids').array(),
```

- [ ] **Step 3: Drift check + commit**

```bash
pnpm db:check-drift
git add apps/api/migrations/2026-05-13-d-third-party-cve-tracking.sql apps/api/src/db/schema/
git commit -m "feat(db): add CVE tracking columns for third-party patches"
```

---

### Task 22: OSV.dev client

**Files:**
- Create: `apps/api/src/services/osvClient.ts`
- Create: `apps/api/src/services/osvClient.test.ts`

- [ ] **Step 1: Failing test (with mocked fetch)**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOsvForPackage } from './osvClient';

beforeEach(() => { (global as any).fetch = vi.fn(); });

describe('osvClient', () => {
  it('queries OSV.dev for a package + version', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        vulns: [
          { id: 'CVE-2024-9999', summary: 'RCE', database_specific: { severity: 'CRITICAL' } },
        ],
      }),
    });

    const result = await queryOsvForPackage({ ecosystem: 'npm', name: 'lodash', version: '4.17.20' });
    expect(global.fetch).toHaveBeenCalledWith('https://api.osv.dev/v1/query', expect.objectContaining({ method: 'POST' }));
    expect(result.cveIds).toEqual(['CVE-2024-9999']);
    expect(result.maxSeverity).toBe('critical');
  });

  it('returns empty when no vulns', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    const r = await queryOsvForPackage({ ecosystem: 'npm', name: 'safe', version: '1.0.0' });
    expect(r.cveIds).toEqual([]);
    expect(r.maxSeverity).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

export interface OsvResult {
  cveIds: string[];
  maxSeverity: 'critical' | 'important' | 'moderate' | 'low' | null;
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1,
};

function mapSeverity(s: string | undefined): OsvResult['maxSeverity'] {
  if (!s) return null;
  switch (s.toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'important';
    case 'MEDIUM': return 'moderate';
    case 'LOW': return 'low';
    default: return null;
  }
}

export async function queryOsvForPackage(q: OsvQuery): Promise<OsvResult> {
  const res = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { ecosystem: q.ecosystem, name: q.name }, version: q.version }),
  });
  if (!res.ok) throw new Error(`OSV query failed (${res.status})`);
  const json = await res.json() as { vulns?: Array<{ id?: string; aliases?: string[]; database_specific?: { severity?: string } }> };
  const vulns = json.vulns ?? [];

  const cveIds = Array.from(new Set(
    vulns.flatMap(v => [v.id, ...(v.aliases ?? [])].filter((x): x is string => !!x && x.startsWith('CVE-')))
  ));

  let maxRank = 0;
  let maxSev: OsvResult['maxSeverity'] = null;
  for (const v of vulns) {
    const sev = v.database_specific?.severity;
    if (!sev) continue;
    const rank = SEVERITY_RANK[sev.toUpperCase()] ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
      maxSev = mapSeverity(sev);
    }
  }
  return { cveIds, maxSeverity: maxSev };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test --filter=@breeze/api -- osvClient
git add apps/api/src/services/osvClient.ts apps/api/src/services/osvClient.test.ts
git commit -m "feat(api): add OSV.dev client for CVE lookups"
```

---

### Task 23: CVE enrichment worker

**Files:**
- Create: `apps/api/src/jobs/cveEnrichmentWorker.ts`
- Create: `apps/api/src/jobs/cveEnrichmentWorker.test.ts`
- Modify: `apps/api/src/jobs/index.ts` (or wherever workers are registered)

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { runCveEnrichmentBatch } from './cveEnrichmentWorker';

vi.mock('../services/osvClient', () => ({
  queryOsvForPackage: vi.fn().mockResolvedValue({ cveIds: ['CVE-2024-1234'], maxSeverity: 'critical' }),
}));

describe('cveEnrichmentWorker', () => {
  it('updates patches with CVE IDs and bumps severity', async () => {
    // Seed: a third-party patch + matching catalog entry with osvEcosystem set
    // ... (use helper that inserts a row and returns the patch id)
    const summary = await runCveEnrichmentBatch({ limit: 10 });
    expect(summary.scanned).toBeGreaterThan(0);
    expect(summary.updated).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { db } from '../db';
import { patches, thirdPartyPackageCatalog } from '../db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { queryOsvForPackage } from '../services/osvClient';

const SEVERITY_RANK: Record<string, number> = {
  critical: 4, important: 3, moderate: 2, low: 1, unknown: 0,
};

export interface CveEnrichmentSummary { scanned: number; updated: number; errors: number }

export async function runCveEnrichmentBatch({ limit = 100 }: { limit?: number } = {}): Promise<CveEnrichmentSummary> {
  const summary = { scanned: 0, updated: 0, errors: 0 };

  const rows = await db.select({
    patchId: patches.id,
    title: patches.title,
    packageId: patches.packageId,
    version: sql<string>`COALESCE(${patches.metadata}->>'version', '')`,
    currentSeverity: patches.severity,
    ecosystem: thirdPartyPackageCatalog.osvEcosystem,
    catalogName: thirdPartyPackageCatalog.friendlyName,
  })
  .from(patches)
  .innerJoin(
    thirdPartyPackageCatalog,
    and(
      eq(thirdPartyPackageCatalog.source, patches.source),
      eq(thirdPartyPackageCatalog.packageId, patches.packageId)
    )
  )
  .where(and(
    eq(patches.source, 'third_party'),
    isNotNull(thirdPartyPackageCatalog.osvEcosystem)
  ))
  .limit(limit);

  for (const r of rows) {
    summary.scanned++;
    try {
      const osv = await queryOsvForPackage({
        ecosystem: r.ecosystem!,
        name: r.packageId!,
        version: r.version || '0.0.0',
      });
      if (osv.cveIds.length === 0) continue;
      const newSev = osv.maxSeverity && SEVERITY_RANK[osv.maxSeverity] > SEVERITY_RANK[r.currentSeverity ?? 'unknown']
        ? osv.maxSeverity : r.currentSeverity;
      await db.update(patches).set({
        cveIds: osv.cveIds,
        severity: newSev,
        updatedAt: new Date(),
      }).where(eq(patches.id, r.patchId));
      summary.updated++;
    } catch (e) {
      summary.errors++;
    }
  }
  return summary;
}
```

- [ ] **Step 3: Register as a BullMQ scheduled job**

Following existing patterns in `apps/api/src/jobs/`, add a queue + scheduler that runs `runCveEnrichmentBatch` every 6 hours.

- [ ] **Step 4: Run + commit**

```bash
pnpm test --filter=@breeze/api -- cveEnrichment
git add apps/api/src/jobs/cveEnrichmentWorker.ts apps/api/src/jobs/cveEnrichmentWorker.test.ts apps/api/src/jobs/index.ts
git commit -m "feat(jobs): CVE enrichment worker pulls OSV.dev for catalog packages"
```

---

### Task 24: Display CVE IDs in PatchList

**Files:**
- Modify: `apps/web/src/components/patches/PatchList.tsx`
- Modify: PatchList test file

- [ ] **Step 1: Failing test**

```tsx
it('shows CVE chips when patch has cveIds', () => {
  render(<PatchList items={[
    { id: '1', source: 'third_party', vendor: 'Mozilla', title: 'Firefox', severity: 'critical', cveIds: ['CVE-2024-1234'] },
  ]} />);
  expect(screen.getByTestId('patch-row-1-cve-CVE-2024-1234')).toBeInTheDocument();
});
```

- [ ] **Step 2: Render CVE chips**

```tsx
{p.cveIds?.slice(0, 3).map(cve => (
  <a
    key={cve}
    data-testid={`patch-row-${p.id}-cve-${cve}`}
    href={`https://nvd.nist.gov/vuln/detail/${cve}`}
    target="_blank" rel="noreferrer"
    className="chip chip-red ml-1 text-xs"
  >
    {cve}
  </a>
))}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/patches/
git commit -m "feat(patches): show CVE chips for third-party patches"
```

---

# Phase 8 — Auto-approve third-party criticals via existing ring config

The existing ring config already supports `autoApproveSeverities` and `sources` arrays in `configPolicyPatchSettings`. We just need to confirm `third_party` flows correctly and surface it in the ring config UI.

### Task 25: Surface "third_party" in ring source selector + auto-approve UI

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx`
- Modify: matching test file

- [ ] **Step 1: Find current options**

```bash
grep -n "microsoft\|apple\|linux\|sources" apps/web/src/components/patches/UpdateRingForm.tsx
```

- [ ] **Step 2: Failing test**

```tsx
it('includes third_party in the source options', () => {
  render(<UpdateRingForm />);
  expect(screen.getByTestId('ring-source-third_party')).toBeInTheDocument();
});

it('persists third_party in selected sources on submit', async () => {
  // user clicks third_party checkbox, submits, asserts POST body includes 'third_party'
});
```

- [ ] **Step 3: Add the option**

```tsx
{(['microsoft','apple','linux','third_party'] as const).map(s => (
  <label key={s}>
    <input
      type="checkbox"
      data-testid={`ring-source-${s}`}
      checked={sources.includes(s)}
      onChange={() => toggle(s)}
    />
    {labelFor(s)}
  </label>
))}
```

- [ ] **Step 4: Verify no regressions**

```bash
pnpm test --filter=@breeze/api -- configPolicyPatching
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/patches/
git commit -m "feat(rings): allow third_party in update ring source selector"
```

---

# Phase 9 — AI-driven release test routine (scaffold, opt-in)

When winget reports a new version of a Breeze-tested catalog package, queue an AI smoke test on the Windows test VM. Result writes to `third_party_package_catalog.last_tested_*`. Behind a feature flag (`ENABLE_AI_PATCH_TESTING=1`) — off by default.

### Task 26: Migration — release test scheduling state

**Files:**
- Create: `apps/api/migrations/2026-05-13-e-third-party-release-tests.sql`
- Modify: `apps/api/src/db/schema/thirdPartyCatalog.ts`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE IF NOT EXISTS third_party_release_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES third_party_package_catalog(id) ON DELETE CASCADE,
  version varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  result varchar(32),
  log text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT third_party_release_tests_catalog_version_unique UNIQUE (catalog_id, version)
);
```

Add a matching Drizzle table to `thirdPartyCatalog.ts`.

- [ ] **Step 2: Commit**

```bash
git add apps/api/migrations/2026-05-13-e-third-party-release-tests.sql apps/api/src/db/schema/
git commit -m "feat(db): add third_party_release_tests for AI smoke test results"
```

---

### Task 27: Detector — queue tests when new versions appear

**Files:**
- Modify: `apps/api/src/routes/agents/patches.ts` — after insert, enqueue a test for Breeze-tested catalog hits with a new version
- Create: `apps/api/src/jobs/wingetReleaseTestWorker.ts` — picks up queued tests

- [ ] **Step 1: Detection hook**

In `patches.ts`, after upserting a third-party patch:

```ts
if (enriched.matchedCatalogId && process.env.ENABLE_AI_PATCH_TESTING === '1') {
  await enqueueWingetReleaseTest({
    catalogId: enriched.matchedCatalogId,
    version: patchData.version ?? 'latest',
  });
}
```

`enqueueWingetReleaseTest` does an `INSERT ... ON CONFLICT DO NOTHING` against `third_party_release_tests`, then pushes a BullMQ job.

- [ ] **Step 2: Worker stub (records status transitions only)**

```ts
export async function executeWingetReleaseTest({ testId }: { testId: string }) {
  await db.update(thirdPartyReleaseTests)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(thirdPartyReleaseTests.id, testId));

  // PHASE 9 NEXT TASK: dispatch to AI test runner.
  // For now, mark as 'skipped' so the table exercises the schema.
  await db.update(thirdPartyReleaseTests)
    .set({ status: 'completed', result: 'skipped', log: 'AI runner not yet implemented', completedAt: new Date() })
    .where(eq(thirdPartyReleaseTests.id, testId));
}
```

- [ ] **Step 3: Tests**

Unit-test `enqueueWingetReleaseTest` (idempotency under conflict) and the stub worker.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/wingetReleaseTestWorker.ts apps/api/src/routes/agents/patches.ts
git commit -m "feat(jobs): scaffold AI release test queue (off by default)"
```

---

### Task 28: AI runner — orchestrate Windows test VM

**Files:**
- Modify: `apps/api/src/jobs/wingetReleaseTestWorker.ts`
- Create: `apps/api/src/services/aiPatchTestRunner.ts`

- [ ] **Step 1: Design notes (encode in a top-of-file comment, not external doc)**

```ts
/**
 * aiPatchTestRunner: drives an AI smoke test for a winget-installable package.
 *
 * Flow:
 *   1. SSH to Windows test VM (per windows_test_vm.md: 100.101.150.55,
 *      user 'administrator', key in ~/.ssh).
 *   2. Pre-step: `winget uninstall --id <packageId> --silent` (best-effort).
 *   3. Install previous version: `winget install --id <packageId> --version <prev>`.
 *   4. Capture installed version via `winget list --id <packageId>`.
 *   5. Run upgrade: `winget upgrade --id <packageId> --silent --accept-*`.
 *   6. Capture new version + exit code + log.
 *   7. Send the log + commands to Claude API (claude-opus-4-7) with a structured
 *      prompt: "Did the upgrade succeed? Any anomalies?" Expect strict JSON:
 *      {result: 'pass'|'fail'|'inconclusive', notes: string}.
 *   8. Write result to third_party_release_tests + last_tested_* on catalog row.
 *
 * Concurrency: one test at a time on the shared VM. Worker concurrency=1 +
 * 10-minute lock TTL.
 */
```

- [ ] **Step 2: Implement SSH using the repo's safe-execFile wrapper**

Use the existing safe-execFile helper rather than rolling new shell logic. Find it first:

```bash
grep -rn "execFileNoThrow\|execFile " apps/api/src/utils apps/api/src/services 2>/dev/null | head
```

Then wrap `ssh` calls with that helper so all package IDs and versions pass as separate argv entries (never interpolated into a shell string):

```ts
// Pseudocode — match the actual helper signature from your grep
import { execFileSafe } from '../utils/execFileNoThrow';

async function runOnTestVm(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const sshTarget = process.env.WIN_TEST_VM_TARGET!;   // e.g. "administrator@100.101.150.55"
  const sshKey = process.env.WIN_TEST_VM_SSH_KEY!;     // path
  return execFileSafe('ssh', ['-i', sshKey, '-o', 'StrictHostKeyChecking=yes', sshTarget, ...args]);
}
```

Validate `packageId` against `/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/` and `version` similarly before passing as argv. Reject anything else.

- [ ] **Step 3: Implement Claude analysis using `@anthropic-ai/sdk`**

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function analyzeUpgradeLog(input: { packageId: string; prevVersion: string; targetVersion: string; commands: string[]; output: string }) {
  const resp = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: 'You are a release test analyst. Given a winget upgrade log, decide if the upgrade succeeded. Respond ONLY with valid JSON: {"result":"pass"|"fail"|"inconclusive","notes":string}.',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Package: ${input.packageId}\nPrev: ${input.prevVersion}\nTarget: ${input.targetVersion}\nCommands run:\n${input.commands.join('\n')}\n\nOutput:\n${input.output.slice(0, 8000)}`,
    }],
  });
  const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '{}';
  return JSON.parse(text) as { result: 'pass' | 'fail' | 'inconclusive'; notes: string };
}
```

(Cache the system prompt per the `claude-api` skill — once volume grows, we save ~90% per call.)

- [ ] **Step 4: Wire into the worker**

In `wingetReleaseTestWorker.ts`, replace the `'skipped'` stub with the real flow. On success, also update catalog `last_tested_at`, `last_tested_version`, `last_tested_result`.

- [ ] **Step 5: Integration test (mocked SSH + Anthropic)**

Mock both `runOnTestVm` and `analyzeUpgradeLog` so we exercise the worker's status transitions and the catalog write-back without external calls.

- [ ] **Step 6: Manual smoke test**

With `ENABLE_AI_PATCH_TESTING=1`, manually enqueue a test for `7zip.7zip` (lightweight, fast install) and verify a row in `third_party_release_tests` and `last_tested_result` on the catalog row.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiPatchTestRunner.ts apps/api/src/jobs/wingetReleaseTestWorker.ts
git commit -m "feat(jobs): AI-driven winget release smoke test runner"
```

---

### Task 29: Surface last test result + "Re-test" button in catalog UI

**Files:**
- Modify: `apps/web/src/components/admin/ThirdPartyCatalogPage.tsx`
- Modify: matching test
- Modify: `apps/api/src/routes/thirdPartyCatalog/operations.ts` — add `POST /third-party-catalog/:id/test`

- [ ] **Step 1: Failing test**

```tsx
it('renders last_tested_result for breeze-tested entries', async () => {
  mockListResponse({ items: [
    { id: '1', vendor: 'Mozilla', friendlyName: 'Firefox', packageId: 'Mozilla.Firefox', breezeTested: true, lastTestedResult: 'pass', lastTestedAt: '2026-05-13T12:00:00Z' },
  ], total: 1 });
  render(<ThirdPartyCatalogPage />);
  await waitFor(() => expect(screen.getByTestId('catalog-row-1-test-status')).toHaveTextContent(/pass/i));
});
```

- [ ] **Step 2: Implement column + retest button**

In `ThirdPartyCatalogPage.tsx`, add a column showing pass/fail/inconclusive (color-coded) + a "Re-test" button that POSTs to `/third-party-catalog/:id/test`. The route enqueues a `wingetReleaseTestWorker` job with `manual=true`.

- [ ] **Step 3: Run + commit**

```bash
pnpm test --filter=@breeze/web -- ThirdPartyCatalogPage
git add apps/web/src/components/admin/ apps/api/src/routes/thirdPartyCatalog/
git commit -m "feat(catalog): show last test result + manual re-test trigger"
```

---

# Final acceptance

After all phases land:

- [ ] **End-to-end smoke**: deploy agent + API to dev, run `tools.CmdPatchScan` against the Windows test VM, observe (a) third-party rows in `patches`, (b) catalog enrichment applied (`patches.title = 'Mozilla Firefox'`, not `'firefox'`), (c) CVE worker populating `cve_ids` within 6h.
- [ ] **Approval flow**: create an update ring with `sources: ['third_party']` + `autoApproveSeverities: ['critical']`, verify a critical third-party patch auto-approves on the canary ring after the deferral window.
- [ ] **Install path**: trigger an install job from the existing patch UI on the test VM; verify winget runs through the user-helper IPC path (already in place) and the patch flips to `installed`.
- [ ] **Catalog UI**: add a new package, edit it, delete it; verify partner-admin gate (non-admin user gets 403).
- [ ] **AI test** (Phase 9, opt-in): set `ENABLE_AI_PATCH_TESTING=1` in dev, manually re-test `7zip.7zip`, see a pass/fail result land in the catalog.
- [ ] **Customer-facing summary**: update `apps/docs/` (via the `update-breeze-docs` skill) and `apps/web` marketing pages to note "Breeze now supports third-party Windows app patching via winget with a curated catalog of N apps."

---

# Risks & open questions

- **winget version detection accuracy**: winget sometimes reports the wrong installed version. Mitigation: the catalog has `osv_ecosystem` and friendly metadata so we can detect drift; if a customer reports a version-mismatch, log a ticket and add a `version_regex_override` column to the catalog. Don't preemptively build it.
- **User-helper IPC requirement**: winget runs in user context only. The existing implementation requires `sessionBroker.SessionCount() > 0` — on devices with no logged-in user, winget patches scan as empty. Acceptable for v1; document this in the customer-facing page. (Chocolatey covers headless servers.)
- **OSV.dev rate limits**: OSV is generous (no documented hard limit) but if we 429 we should back off. Build retry with exponential backoff in `osvClient.ts` only when we observe failures — not preemptively.
- **AI test cost**: each Claude call is ~$0.02. At 20 catalog entries × 1 upgrade per month × $0.02 = $0.40/month — negligible. Prompt-caching the system block makes this even cheaper once volume grows.
- **Test VM contention**: the Windows test VM is shared. Worker concurrency=1 + a Redis lock prevents conflicts. If we want parallelism, spin up additional VMs and route by catalog category.
- **Chocolatey parity**: same enrichment service could work for `source='third_party'` + Chocolatey provider. Out of scope for this plan but the catalog `source` enum already supports it — extension is a one-line provider mapping change.
- **Shell-injection avoidance in Phase 9**: all SSH/winget invocations route through the repo's safe-execFile helper (`apps/api/src/utils/execFileNoThrow.ts` per the security hook). No string interpolation into shells; `packageId` and `version` validated against a strict regex before passing as argv. If we ever need shell features (pipes, redirects), encapsulate the script on the VM side and call the wrapper by name.
