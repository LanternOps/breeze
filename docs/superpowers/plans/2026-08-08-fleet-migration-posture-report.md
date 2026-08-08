# Fleet Migration / Decommission Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the competing-management-tool detection Breeze already collects as a fleet-level report, so an MSP can answer "which endpoints still run the RMM we're migrating off, and is it safe to uninstall there?" in one request instead of one per device.

**Architecture:** Two aggregate SQL queries over the existing `devices.management_posture` jsonb — detections, and coverage denominators — behind two read endpoints and a fleet page. **No new table**; the jsonb stays the single source of truth.

**Tech Stack:** PostgreSQL (jsonb aggregation), Drizzle/raw SQL, Hono routes, React (web), Vitest.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-08-08-fleet-migration-posture-report-design.md`
**Issue:** #3244 · **Epic:** #3249

> **✅ SHIPPED** — merged to main as `bf505f83a` (PR #3264): the two-query service, both routes, the mixed-fixture unit + integration suites, the fleet page (`/devices/posture` + sidebar entry) with per-org migration progress, posture-age counters, the orphaned remote-access callout, and CSV export; docs updated (Recipe 5 + `features/management-posture.mdx`). **Deferred:** Task 5's performance measurement against a 10k-device seeded fleet (numbers still to be recorded on #3244 from an environment with a DB) and Task 4's site filter (the spec's endpoint contract has no site param; site-restricted users are already auto-narrowed via `allowedSiteIds` — can follow as a small increment).

---

## Critical implementation note — read before starting

**Do not compute detections and coverage in one `GROUP BY`.** A single grouped query with a `LEFT JOIN LATERAL` collapses three populations that mean different things — never-scanned, scanned-with-category-absent, scanned-with-empty-array — into one identical `(product NULL, status NULL)` row. A never-scanned device then reads as verified-clean, which is precisely the failure this feature exists to prevent. This was a real defect in an earlier draft of the spec.

Two queries. Detections use `CROSS JOIN LATERAL`; coverage is computed separately without any lateral join.

No agent changes. Detection already ships in `agent/internal/mgmtdetect/`.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/api/src/services/managementPostureReport.ts` | The two queries + assembly |
| `apps/api/src/services/managementPostureReport.test.ts` | Unit tests |
| `apps/web/src/components/devices/FleetPostureReport.tsx` | Fleet view |
| `apps/web/src/pages/devices/posture.astro` | Page mount |

### Modified files
| File | Change |
|---|---|
| `apps/api/src/routes/devices/core.ts` | Two summary/drill-down routes |
| `apps/docs/src/content/docs/migration/toolkit.mdx` | Replace Recipe 5's N+1 loop |
| `apps/docs/src/content/docs/features/management-posture.mdx` | Document the fleet view |

---

## Task 1: Aggregation service — the two queries

- [x] `getPostureDetections({ orgId?, category = 'rmm', stalenessDays = 7 })`:
  ```sql
  SELECT d.org_id,
         e.value->>'name'   AS product,
         e.value->>'status' AS status,
         count(DISTINCT d.id) AS device_count,
         count(DISTINCT d.id) FILTER (
           WHERE (d.management_posture->>'collectedAt')::timestamptz > now() - $3::interval
         ) AS fresh_device_count
  FROM devices d
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(d.management_posture->'categories'->$1, '[]'::jsonb)
  ) e
  WHERE d.deleted_at IS NULL AND ($2::uuid IS NULL OR d.org_id = $2)
  GROUP BY 1, 2, 3;
  ```
  `count(DISTINCT d.id)`, never `count(*)` — a posture array listing the same product twice would otherwise double-count the device.
- [x] `getPostureCoverage({ orgId?, category, stalenessDays })` — per org, **no lateral join**:
  ```sql
  SELECT d.org_id,
         count(*) AS total_devices,
         count(*) FILTER (WHERE d.management_posture IS NULL) AS never_scanned,
         count(*) FILTER (WHERE d.management_posture IS NOT NULL
           AND (d.management_posture->>'collectedAt')::timestamptz <= now() - $3::interval) AS stale,
         count(*) FILTER (WHERE d.management_posture IS NOT NULL
           AND COALESCE(jsonb_array_length(
                 COALESCE(d.management_posture->'categories'->$1, '[]'::jsonb)), 0) = 0) AS scanned_none_detected
  FROM devices d
  WHERE d.deleted_at IS NULL AND ($2::uuid IS NULL OR d.org_id = $2)
  GROUP BY 1;
  ```
- [x] Assemble both into one response; never emit a detection count without its coverage denominators.
- [x] Validate `category` against the ingest enum (`mdm`, `rmm`, `remoteAccess`, `endpointSecurity`, `policyEngine`, `backup`, `identityMfa`, `siem`, `dnsFiltering`, `zeroTrustVpn`, `patchManagement`) — never interpolate it into SQL unvalidated.

## Task 2: Routes

- [x] `GET /devices/management-posture/summary` — query `orgId?`, `category?` (default `rmm`), `stalenessDays?` (default 7). Returns per-org, per-product, per-status counts plus `total`, `neverScanned`, `stale`, `scannedNoneDetected`.
- [x] `GET /devices/management-posture/devices` — query `product`, `category?`, `orgId?`, `status?`, standard pagination. The drill-down behind a count.
- [x] Both read-only, `authMiddleware`, org-scoped by the caller's access context — a partner-scoped caller gets their estate, an org-scoped caller one org.
- [x] Mount **before** any `/devices/:id` route so `management-posture` is not captured as an id parameter.

## Task 3: Tests — the mixed fixture is the test

- [x] Build one fixture org containing all four populations simultaneously: never scanned (`management_posture` NULL), scanned-stale, scanned-clean, scanned-with-a-detection. A single-population fixture passes against the collapsed one-query form this design had to correct, so the mixed fixture is what actually guards it.
- [x] Assert the buckets partition the fleet: `never_scanned + stale + fresh-clean + fresh-detected == total_devices`, nothing double-counted or dropped.
- [x] A device with an empty category array, and one with the category key absent, both land in `scanned_none_detected` — **not** `never_scanned`.
- [x] A posture array listing the same product twice counts the device once.
- [x] `active` vs `installed` reported separately; `unknown` neither dropped nor merged.
- [x] Staleness boundary: `freshDeviceCount <= deviceCount` always.
- [x] Org scoping: an org-scoped token sees only its own devices; a partner roll-up never includes an org that partner does not own.
- [x] No new table — assert the contract suites are **unchanged** (no RLS/cascade/export registration needed; `devices` is already registered and `management_posture` is already `excludedOpen`).

## Task 4: Web fleet view

- [ ] `FleetPostureReport.tsx`: devices grouped by detected product, filterable by organization and site, with the device list behind each count.
- [x] Per-org migration progress: enrolled, still carrying a competing RMM, carrying **both** (the healthy mid-migration state), and Breeze-only.
- [x] **Show posture age next to every count.** Never render a bare zero — zero-with-12-stale is a different fact from zero-with-everything-fresh, and only one means "safe to uninstall". This is a requirement, not polish.
- [x] **Call out orphaned remote-access agents as a security finding.** ScreenConnect survives a ConnectWise Automate uninstall; Splashtop survives Atera and Syncro uninstalls; `mgmtdetect` fingerprints these independently under `CategoryRemoteAccess`. Present them as an exposure, not as migration housekeeping.
- [x] CSV export, so the report can go to the customer as evidence of a completed migration.

## Task 5: Performance check

- [ ] Measure both queries against a seeded fleet of 10,000+ devices with realistic posture payloads. Record the numbers on #3244.
- [ ] Per-org filtering should ride the `org_id` index; the partner-wide roll-up is a full scan with jsonb detoast — acceptable for an on-demand report.
- [ ] If it is too slow, prefer a **materialised view refreshed from the jsonb** over a hand-maintained denormalized table. A hand-maintained copy can drift out of sync and report a competing agent as removed while it is still installed — the failure that strands endpoints. Do not introduce one.

## Task 6: Docs

- [x] Replace Recipe 5 in `apps/docs/src/content/docs/migration/toolkit.mdx` — the per-device loop becomes a single call to the summary endpoint.
- [x] Update the "Known Rough Edges" table: remove the Management Posture row.
- [x] Add the fleet view to `apps/docs/src/content/docs/features/management-posture.mdx`.

---

## Verification

- [x] `pnpm --filter @breeze/api test -- managementPosture` green.
- [ ] End-to-end against a seeded fleet: counts reconcile with the raw jsonb, and a device with NULL posture appears as unknown in the UI rather than clean.

## Out of scope

- **Automated uninstall of a competing RMM.** Detection informs; the operator drives removal through their own tooling. No competitor-uninstall logic exists in the repo today and adding it is a separate product and security decision.
- Filter-DSL integration, posture history/trend (the jsonb is overwritten each scan), and non-RMM category reports — all deferred in the spec.
