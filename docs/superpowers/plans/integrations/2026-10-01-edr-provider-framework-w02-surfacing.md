---
tracking_issue: LanternOps/breeze#8164
---
# EDR W02 — Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the framework data W01 persists (`edr_endpoints`, `edr_detections`) visible everywhere the legacy S1/Huntress data is: incidents feed + promotion, read-only AI tools, events/alerts, retention, portal, readiness, reports, and the web UI.

**Architecture:** Two independently shippable PRs. **PR-A (API)** adds a fourth incidents-feed leg (folding the nested ternary into a leg list), `routes/edr/detections.ts`, a shared read service used by both the route and the AI tools, a "Phase 4" notifier after the detection sync commits (plus a stale-tenant check on the `sync-all` tick), a retention job, and the portal/readiness/report consumers. **PR-B (Web)** consumes only routes PR-A or W01 already ships. One migration (a portal visibility flag column), in PR-A. No new table, so no cascade/merge registration.

**Tech Stack:** Hono, Drizzle (queries only), PostgreSQL RLS, BullMQ, Vitest, Astro + React islands, `runAction`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` (§4.4, 4.7, 4.11, 4.12, D6, D10, D11, D14). **Read the index first** (`…-index.md`, corrections 5, 12) and the W01 results: W01a #8220 and W01b #8259 are both merged to main (verified 2026-10-12).

Epic: #8164 · Wave sub-issue: #8166. PR bodies: `Refs #8166` / `Part of #8164` until the last PR of the wave, which carries `Closes #8166` (orchestrator decides). Branches: `feature/8164-edr-provider-framework/wave-8166` (PR-A) and `…/wave-8166-web` (PR-B, branched from main after PR-A merges, or stacked — see the stacked-PR CI trap in the index).

## Global Constraints

- **Read-only.** No write/response action, no `edr_actions` writes, no new `requireMfa` mutation. Actions are W03. The only mutations in W02 are existing W01 routes called from the new UI.
- **Site restriction is an app-layer axis** RLS cannot defend (`routes/incidents.ts:258-266`): every new read path (feed leg, `/edr/detections`, AI tools, device panel) applies `allowedDeviceIds` **and** the D14 detached-finding rule via `allowedSiteIds`.
- **Vendor text is untrusted.** `title`, `threat_name`, `file_path`, `process_name`, `details` are attacker-influenced; AI tool output fences them (`aiToolOutput.ts` raw-text set) exactly as `get_huntress_incidents` does.
- **No `z.undefined()`** in any AI tool schema (model gets zero tools — known trap). Description budget 300/160 (`aiTools.descriptionBudget.contract.test.ts`, shrink-only baseline).
- **Portal** exposure is gated by a **new strict portal flag** (fails closed, `NOT NULL DEFAULT false`) per the #7730 pattern. Vendor names never reach the portal in W02.
- **Alerts must not flood on first sync.** The first detection sync back-fills 30 days; those rows are marked notified without publishing (see Task A6).
- Web: every mutation through `runAction` (`no-silent-mutations.test.ts`); new `en` keys in all 8 locale dirs (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`; `localeParity` lives in `src/lib/i18n`).
- Settings rule 9 (PR-B): EDR connections have **one home — Integrations → Security**; count before/after = 1 → 1 (S1/Huntress cards stay; they are a different concept until the D2 legacy migration).
- Public repo: no customer names, hostnames, IPs, session ids.
- Tests: API `cd apps/api && npx vitest run <files>` (no `--` before flags); web `cd apps/web && npx vitest run <files>`. Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code, never pipe to `tail`.

## Migration & tenancy statement

**One migration, PR-A only:** `apps/api/migrations/2026-12-22-140000-portal-edr-visibility-flag.sql` (slot after `2026-12-22-130000`, the highest slot claimed at planning time; **re-check** with `git fetch -q origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3` before committing and before pushing — at plan time the newest on this checkout is `2026-12-21-230000-…`, and the `2026-12-22-130000` slot is claimed by work not yet on this checkout).
- Content: `ALTER TABLE portal_branding ADD COLUMN IF NOT EXISTS enable_edr_visibility boolean NOT NULL DEFAULT false;` + `COMMENT ON COLUMN`. DDL only → **no** `set_config('breeze.scope','system',true)` (it writes no rows) and nothing added to the `migrationRlsScope.test.ts` baseline. Idempotent, no `BEGIN/COMMIT`. Copy the shape of `2026-12-21-230000-portal-software-inventory-flag.sql`.
- **No new table.** Not touched: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `REPOINT_TABLES`, `routes/devices/core.ts` cascade lists, `rls-coverage` lists, `encryptedColumnRegistry` (the W01a registrations already cover all `edr_*` tables).
- **One registration:** `portal_branding` is an existing org-cascade table, so the new column needs a `CORE_TENANT_EXPORT_POLICY` classification — add `enable_edr_visibility` to the `portal_branding` **included** list at `services/tenantExportPolicyRegistry.ts` (line ~666, next to `enable_software_inventory`). Boolean → `included`, not `excludedOpen`.
- No `edr_*` column is added in W02 (retention and notifier use columns W01a already created: `notified_severity`, `resolved_at`, `updated_at`). If an executor finds one is needed, stop — that is a new migration and an export-policy row; raise it.
- Because the migration + export policy touch the cascade surface: run the contract/integration suites on `pnpm test-stack up` before opening PR-A (Task A12), then `pnpm test-stack down`.

## Review Focus

1. **First-sync alert flood.** First detection sync of a tenant back-fills the adapter's lookback window (GravityZone: `firstSyncLookbackDays: 30`) of old detections; a naive "severity ≠ notified_severity" evaluator would fire hundreds of alerts/events and page the MSP. Expected: back-filled rows are stamped notified silently; only detections first seen within the notify horizon publish. Pinned in A6.
2. **A site-restricted technician must not see another site's findings** — including findings whose device link was cleared by an org move / device delete (D14), via the feed, `/edr/detections`, AI tools and the device panel. Pinned in A3, A4, A5.
3. **Partial coverage must not read as "no threats".** For partner/system callers, `get_edr_status` / `list_edr_detections` with a stale, failed, never-synced or unmapped tenant must say so; org-scoped callers cannot see tenant state under RLS and get an explicit "sync health visible to partner users only" note instead (Open Decision 9). Pinned in A5/A7.
4. **Promotion double-click / two tabs.** Promoting the same detection twice yields one incident and a 409, and a promote request naming another org's detection id is rejected (existing legs trust `sourceRef`; the EDR leg verifies it). Pinned in A4.
5. **Vendor strings in AI tool output are prompt-injection carriers** (`threat_name`, `file_path`). Pinned in A7 via the raw-text fencing test.
6. **Portal flag off ⇒ zero EDR influence**: protection tile, threat counts, `avProducts` and reports identical to today. Pinned in A9.

---

# PR-A — API

## File Structure (PR-A)

| File | Change |
|---|---|
| `packages/shared/src/types/edr.ts` | Add `EdrDetectionDto`, `EdrStatusSummary` (shared by route/tool/web) |
| `packages/shared/src/types/portalVisibility.ts` | `ThreatSourceCounts` gains `edr` (additive) |
| `apps/api/migrations/2026-12-22-140000-portal-edr-visibility-flag.sql` | Create |
| `apps/api/src/db/schema/portal.ts` | `enableEdrVisibility` column |
| `apps/api/src/routes/incidents.helpers.ts` | Leg list fold, EDR leg, `allowedSiteIds` param |
| `apps/api/src/routes/incidents.ts` | Pass `allowedSiteIds`; verify EDR `sourceRef` on create |
| `apps/api/src/routes/incidents.validation.ts` | `sourceType` enum += `'edr_detection'`; feed `source` filter |
| `apps/api/src/services/edrProviders/read.ts` | Create — `listEdrDetections`, `getEdrStatus` (single read model) |
| `apps/api/src/routes/edr/detections.ts` | Create — `GET /edr/detections`, `GET /edr/status` |
| `apps/api/src/routes/edr/endpoints.ts` | `deviceId` query filter (device panel) |
| `apps/api/src/routes/edr/index.ts` | Mount detections |
| `apps/api/src/services/aiToolsEdr.ts` | Create — 2 tier-1 read tools (thin; logic in `read.ts`) |
| `aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiAgentSdkTools.ts`, `aiToolOutput.ts`, `aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts`, `llm/toolEval/agentGoldenTasks.ts` | Register (Task A7) |
| `apps/api/src/services/eventBus.ts` | `edr.*` events |
| `apps/api/src/services/edrProviders/alerts.ts` | Create — Phase 4 notifier |
| `apps/api/src/jobs/edrProviderSync.ts`, `services/edrProviders/persist.ts` | Call notifier after Phase 3; stale-tenant check on `sync-all`; stamp first-sync rows |
| `apps/api/src/services/workerRegistry.ts` | Re-verify `edrProviderSyncWorker` placement |
| `apps/api/src/jobs/edrDetectionRetention.ts` | Create |
| `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts` | Register retention |
| Portal: `services/portal/{portalFlags,securityReadModel,protection}.ts`, `routes/portal/{featureFlags,branding}.ts`, `routes/orgPortalSettings.ts`, `packages/shared/src/validators/portal.ts`, `services/tenantExportPolicyRegistry.ts`, `apps/portal/src/lib/{api,visibilityGate}.ts` | Flag + read model |
| `services/orgAccountReadinessIntegrations.ts` | `edr` connector |
| `services/securityComplianceReport.ts`, `services/threatDetectionReport.ts` | EDR consumers |

---

### Task A1: Shared DTOs, incident source type, feed `source` type

**Files:**
- Modify: `packages/shared/src/types/edr.ts`
- Modify: `apps/api/src/routes/incidents.validation.ts:27`
- Test: `apps/api/src/routes/incidents.validation.test.ts`, `packages/shared/src/types/edr.test.ts`

**Interfaces:**
- Produces (used by A3–A7, PR-B):
```ts
export interface EdrDetectionDto {
  id: string; connectionId?: string /* omitted for org tokens */; orgId: string; provider: string; providerLabel: string;
  vendorDetectionId: string; vendorKind: EdrVendorKind; severity: EdrSeverity; status: EdrDetectionStatus;
  title: string | null; category: string | null; threatName: string | null;
  filePath: string | null; processName: string | null; mitreTechniques: string[];
  detectedAt: string; resolvedAt: string | null;
  endpointId: string | null; breezeDeviceId: string | null; deviceName: string | null;
  detached: boolean; promotedIncidentId: string | null;
}
export interface EdrStatusSummary {
  providers: Array<{ provider: string; label: string; connectionId?: string; connectionStatus?: EdrConnectionStatus; // partner/system only
    tenantsMapped?: number; tenantsUnmapped?: number; tenantsStale?: number; tenantsFailed?: number; // partner/system only

    endpoints: number; linkedEndpoints: number; unhealthyEndpoints: number; openDetections: number; lastDetectionSyncAt: string | null }>;
  coverage: { orgsWithEdr: number; partial: boolean; notes: string[] };
}
```

- [ ] **Step 1: Failing test** — in `incidents.validation.test.ts`:
```ts
it('accepts edr_detection as a promotion source type', () => {
  const r = createIncidentSchema.safeParse({ ...validBody, sourceType: 'edr_detection', sourceRef: crypto.randomUUID() });
  expect(r.success).toBe(true);
});
it('still rejects unknown source types', () => {
  expect(createIncidentSchema.safeParse({ ...validBody, sourceType: 'nope', sourceRef: 'x' }).success).toBe(false);
});
```
(Use the file's existing `validBody` fixture name; adapt to the real export name.)
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/incidents.validation.test.ts` → FAIL (enum rejects).
- [ ] **Step 3:** `sourceType: z.enum(['huntress_incident', 's1_threat', 'edr_detection']).optional()`; add the DTO interfaces to `edr.ts` (type-only, exported from the shared barrel).
- [ ] **Step 4:** rerun → PASS; `cd packages/shared && npx vitest run src/types/edr.test.ts`.
- [ ] **Step 5:** `git commit -m "feat(edr): W02 shared DTOs + edr_detection incident source type (#8166)"` (+ Co-Authored-By footer on every commit).

No DB CHECK exists on `incidents.source_type` (verified: `2026-06-29-incidents-edr-source-link.sql` adds a free `text` column + partial unique index), so no migration.

---

### Task A2: Fold the incidents-feed ternary into a leg list (pure refactor)

**Files:**
- Modify: `apps/api/src/routes/incidents.helpers.ts:328-351`
- Test: `apps/api/src/routes/incidents.helpers.test.ts`

**Interfaces:**
- Produces: `type FeedLeg = { key: 'tracked'|'huntress'|'s1'|'edr'; include: boolean; query: any }` and `foldLegs(legs: FeedLeg[], combine?: (a: any, b: any) => any): any | null` (exported for test; `combine` defaults to `unionAll`).

- [ ] **Step 1: Failing test** — enumerate all 2^4 include combinations:
```ts
import { foldLegs } from './incidents.helpers';
const KEYS = ['tracked','huntress','s1','edr'] as const;
it.each(Array.from({ length: 16 }, (_, m) => m))('combination %i', (mask) => {
  const legs = KEYS.map((key, i) => ({ key, include: !!(mask & (1 << i)), query: { __leg: key } }));
  const included = legs.filter((l) => l.include);
  const out = foldLegs(legs, (a: any, b: any) => ({ union: [a, b] }));
  if (included.length === 0) expect(out).toBeNull();
  else expect(flatten(out)).toEqual(included.map((l) => l.query)); // order preserved, none dropped
});
```
(`foldLegs` takes an injectable combiner so the unit test needs no Drizzle; production passes `unionAll`. `flatten` walks `{union:[a,b]}` left-to-right.)
- [ ] **Step 2:** run → FAIL (`foldLegs` not exported).
- [ ] **Step 3:** implement:
```ts
export function foldLegs(legs: FeedLeg[], combine: (a: any, b: any) => any = unionAll as any): any | null {
  const queries = legs.filter((l) => l.include).map((l) => l.query);
  if (queries.length === 0) return null;
  return queries.reduce((acc, q) => combine(acc, q));
}
```
Replace the ternary at `:337-351` with `const baseQ: any = foldLegs([{key:'tracked',…},{key:'huntress',…},{key:'s1',…}])`. The existing `buildIncidentFeedQueries` `null` return path is kept. **Existing tests must stay green with no edits** — that is the refactor's proof.
- [ ] **Step 4:** `npx vitest run src/routes/incidents.helpers.test.ts src/routes/incidents.test.ts` → PASS.
- [ ] **Step 5:** commit `refactor(incidents): fold feed legs through unionAll list (#8166)`.

---

### Task A3: EDR feed leg with the D14 site predicate

**Files:**
- Modify: `apps/api/src/routes/incidents.helpers.ts` (`IncidentFeedRow.source`, `IncidentFeedParams`, new `edrQ`, row mapper cast at ~398-410)
- Modify: `apps/api/src/routes/incidents.ts:258-280`
- Modify: `apps/api/src/routes/incidents.validation.ts` (feed `source` query enum)
- Test: `incidents.helpers.test.ts`, `incidents.test.ts`, `src/__tests__/integration/incidents-feed.integration.test.ts`

**Interfaces:**
- Consumes: `foldLegs`, `FeedLeg` (A2); `edrDetections`, `EDR_OPEN_DETECTION_STATUSES`.
- Produces: `IncidentFeedRow.source: 'breeze'|'huntress'|'s1'|string` (an `EdrProviderKey` — derive the filter enum from `listEdrProviders().map(p=>p.key)` plus the three legacy literals); `IncidentFeedParams.allowedSiteIds: string[] | null`.
- Leg shape: `source = edr_detections.provider`, `sourceId = edr_detections.id::text`, `deviceId = breeze_device_id`, `title = coalesce(title, threat_name, 'EDR detection')`, severity → rank via the same map the S1 leg uses (critical→p1, high→p2, medium→p3, low/info/unknown→p4), NOT EXISTS against `incidents` on `source_type='edr_detection' AND source_ref = edr_detections.id::text`, and `detached_at IS NULL` (tombstones from a tenant remap are never feed rows).

**Site predicate (D14).** `siteDevicePredicate` keys on device ids and lets null-device rows through (`:245`). The EDR leg uses its own predicate, because "never linked" and "detached" differ:
```ts
const edrSitePredicate = (p: IncidentFeedParams) => {
  if (p.allowedDeviceIds === null && p.allowedSiteIds === null) return undefined; // unrestricted
  return or(
    inArray(edrDetections.breezeDeviceId, p.allowedDeviceIds ?? []),
    and(isNull(edrDetections.breezeDeviceId), isNull(edrDetections.deviceDetachedAt)),            // never linked: visible
    and(isNull(edrDetections.breezeDeviceId), isNotNull(edrDetections.deviceDetachedAt),
        inArray(edrDetections.lastSiteId, p.allowedSiteIds ?? [])),                                 // detached: keep last site's restriction
  );
};
```
`inArray(col, [])` must not be emitted (Drizzle throws on empty arrays in some versions) — guard with a `sql\`false\`` branch; unit-test the empty-array case for both params.

- [ ] **Step 1: Failing tests** (helpers unit, with the existing mock-db harness): (a) `source: 'bitdefender'` includes only the EDR leg and excludes tracked; (b) `source: 'huntress'` excludes the EDR leg; (b2) `kind: 'tracked'` excludes the EDR leg; (c) unrestricted caller → no site predicate; (d) restricted caller with `allowedDeviceIds=[d1]`, `allowedSiteIds=[siteA]` → predicate SQL contains the three branches; (e) `allowedDeviceIds=[]`, `allowedSiteIds=[]` → never-linked rows only, no crash.
  Integration (`incidents-feed.integration.test.ts`, test stack): seed org + two sites + two devices + one connection/tenant/endpoint + three detections: on a site-A device, on a site-B device, and one detached from a site-B device (`breeze_device_id NULL, device_detached_at set, last_site_id = siteB`). Site-A-only caller sees the site-A row and none of the others; unrestricted caller sees all three; a tombstoned (`detached_at` set) row is invisible to everyone.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement `edrQ`, `includeEdrLeg = hasDevicesRead && params.kind !== 'tracked' && (params.source is undefined or an EDR provider key)` (the existing finding legs gate on `kind !== 'tracked'` at `incidents.helpers.ts:330`; note the existing `includeEdr` flag there means only `hasDevicesRead` — rename to avoid confusion). Also: `includeTracked` must additionally be false when `source` is an EDR provider key (today it excludes only `huntress`/`s1`, L329), and the `if (!includeTracked && !includeHuntress && !includeS1) return null` guard must count the EDR leg, widen the types, compute `allowedSiteIds` in `incidents.ts` as `perms?.allowedSiteIds ?? null` (scope `organization` only, same condition as `allowedDeviceIds`), and extend the row-mapper cast. `linkOut` for EDR rows is `null` in W02 (vendor console deep links are out of scope).
- [ ] **Step 4:** unit tests PASS; integration: `pnpm test-stack up` then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/incidents-feed.integration.test.ts` (confirm the config name in `docs/agents/testing.md`).
- [ ] **Step 5:** commit `feat(incidents): EDR detection feed leg with detached-finding site rule (#8166)`.

---

### Task A4: Promote an EDR detection to a tracked incident

**Files:**
- Modify: `apps/api/src/routes/incidents.ts:85-135` (create handler)
- Test: `apps/api/src/routes/incidents.test.ts` (next to the existing promotion test at `:222`)

Promotion is the normal create-incident POST with `sourceType`/`sourceRef` (there is no separate promote route). For `edr_detection` the handler must (1) require `sourceRef` to be a uuid, (2) load the detection **through the caller's RLS context** (`SELECT … FROM edr_detections WHERE id = $ref AND org_id = $incidentOrg AND detached_at IS NULL`) and 404/400 when absent, (3) apply the same site rule as A3 for a site-restricted caller (reuse an exported `canSeeEdrDetection(row, perms)` helper from `incidents.helpers.ts`), then insert with `.onConflictDoNothing()` → 409 as today.

- [ ] **Step 1: Failing tests:** (a) promotes a visible detection → 201, row has `source_type='edr_detection'`, `source_ref=<uuid>`; (b) second POST → 409 "already been promoted"; (c) `sourceRef` naming a detection in another org → 4xx and **no incident row**; (d) site-restricted caller promoting a site-B detection → 403; (e) non-uuid ref → 400. Run → FAIL.
- [ ] **Step 2–4:** implement; rerun `npx vitest run src/routes/incidents.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(incidents): promote EDR detections (#8166)`.

---

### Task A5: Read service + `GET /edr/detections` + `GET /edr/status` + endpoint `deviceId` filter

**Files:**
- Create: `apps/api/src/services/edrProviders/read.ts`, `read.test.ts`
- Create: `apps/api/src/routes/edr/detections.ts`, `detections.test.ts`
- Modify: `apps/api/src/routes/edr/index.ts`, `apps/api/src/routes/edr/endpoints.ts` (+ `endpoints.test.ts`)

**Interfaces:**
- Produces:
```ts
export interface EdrReadScope { auth: AuthContext; allowedDeviceIds: string[] | null; allowedSiteIds: string[] | null }
export function listEdrDetections(scope: EdrReadScope, q: { orgId?: string; deviceId?: string; severity?: EdrSeverity[]; status?: 'open'|'all'|EdrDetectionStatus; provider?: string; limit: number; offset: number }): Promise<{ rows: EdrDetectionDto[]; total: number; coverage: EdrStatusSummary['coverage'] }>
export function getEdrStatus(scope: EdrReadScope, q: { orgId?: string }): Promise<EdrStatusSummary>
export function resolveEdrReadScope(auth: AuthContext, perms: UserPermissions | undefined): Promise<EdrReadScope>
```
- Rules (all pinned by tests): rows are `detached_at IS NULL`; site predicate = A3's `edrSitePredicate` (extract it from `incidents.helpers.ts` into `read.ts` and import it back — one definition); `status: 'open'` = `EDR_OPEN_DETECTION_STATUSES`; **RLS reality (Codex review):** `edr_connections` and `edr_tenants` have partner-only SELECT policies and an organization token carries no partner id, so an org-scoped caller cannot read tenant/connection sync state. W02 default: **org-scope responses compute coverage from org-visible tables only** (`edr_endpoints`, `edr_detections`), always append the note "sync health is visible to partner users only", and set `partial: true` when the org has zero endpoint rows; partner/system scope gets the full tenant detail below. Widening org-scope visibility needs a scoped definer function (migration) — Open Decision 9. Integration test: an org token calling `getEdrStatus` returns no connection/tenant fields and does not error. `coverage.partial = true` and a human `notes[]` entry when any contributing tenant has `last_detection_sync_status ∈ {error,partial}`, `last_detection_sync_at` older than 2× `effective_detection_interval_minutes`, an unmapped tenant exists, a mapped tenant has **never** completed a detection sync (`last_detection_sync_at IS NULL` — a valid initial state, reported as `pending`, never as complete), or the connection is `reauth_required`; **a legacy S1/Huntress mapping for the same org adds a note pointing at `get_s1_threats` / `get_huntress_incidents`** (D6). Auth: scope `organization|partner|system`, `DEVICES_READ`; partner-token `orgId` filtered through `auth.canAccessOrg`; org-scope never sees connection-level detail (`connectionId` omitted from the DTO for org tokens — they cannot read connections).

- [ ] **Step 1: Failing tests** (`read.test.ts`, mock db per `breeze-testing` skill): partial-coverage notes for each of the 6 triggers (incl. never-synced); `status:'open'` filter; empty-list response still carries `coverage` (an empty list from a stale tenant must not read as clean); unrestricted vs restricted predicate. Route tests: 403 without `DEVICES_READ`; org token cannot pass a foreign `orgId`; `limit` clamped to 200; response never contains `details` (jsonb) or `vendor_raw`. Endpoint route: `GET /edr/endpoints?deviceId=<uuid>` returns only that device's linked rows, still org-scoped. Run → FAIL.
- [ ] **Step 2–4:** implement; `npx vitest run src/services/edrProviders/read.test.ts src/routes/edr` → PASS. `src/__tests__/mcp-coverage.test.ts` is **expected red until A7** (the new route file needs a tool-mapped `mcpCoverage.ts` entry and the tools do not exist yet) — do not add a temporary exemption; push A5 and A7 together.
- [ ] **Step 5:** commit `feat(edr): detections + status read routes and shared read service (#8166)`.

---

### Task A6: Phase 4 — events + alerts from persisted rows, with first-sync suppression

**Files:**
- Modify: `apps/api/src/services/eventBus.ts` (union ~lines 98-146 + `EVENT_TYPES` ~631-652)
- Create: `apps/api/src/services/edrProviders/alerts.ts`, `alerts.test.ts`
- Modify: `apps/api/src/services/edrProviders/persist.ts` (`persistDetections` stamps `notified_severity` on first-sync inserts; runs inside Phase 3) + `persist.test.ts`
- Modify: `apps/api/src/jobs/edrProviderSync.ts` (`syncEdrDetections`: call `evaluateEdrAlerts` after `runPhase3` returns — `runPhase3` is at ~L722, the block ends ~L762 — i.e. **outside** the Phase 3 transaction; plus `evaluateEdrStaleTenants` from the `sync-all` tick; no Phase 4 stub exists today)
- Modify: `apps/api/src/services/workerRegistry.ts:962-971`
- Test: `alerts.test.ts`, `src/__tests__/integration/edrProviderSync.integration.test.ts` (extend)

**Interfaces:**
- Events: `edr.detection_detected`, `edr.detection_escalated`, `edr.endpoint_unhealthy`, `edr.endpoint_recovered`, `edr.tenant_stale` (payload: `{ connectionId, tenantId?, orgId, detectionId?, endpointId?, deviceId?, provider, severity? }` — **no vendor strings in payloads beyond `provider` key**; alerts carry the title in the alert row, not the event).
- Produces: `export const EDR_ALERT_SOURCE = 'edr_provider'`; `evaluateEdrAlerts(connectionId: string, opts: { now: Date; notifyHorizonMs?: number }): Promise<{ published: number; suppressed: number }>`.
- **Back-fill is stamped at persist time, not in the evaluator** (Codex review: by evaluator time the tenant's sync timestamp is already overwritten): `persistDetections` (`services/edrProviders/persist.ts:392`) inserts rows of a tenant whose `detection_cursor IS NULL` (first sync) with `notified_severity = severity`; the `ON CONFLICT … set` list keeps omitting it (`persist.ts:517`; the existing `persist.test.ts:258` assertion stays true). Evaluator interface therefore drops any first-sync parameter. Algorithm: select persisted rows `WHERE connection_id = $1 AND detached_at IS NULL AND status IN open AND severity IN ('critical','high','medium') AND notified_severity IS DISTINCT FROM severity` ordered by `detected_at`. For each: the horizon applies **only to first publication** — if `notified_severity IS NULL AND detected_at < now - notifyHorizon` (default 24 h) → `UPDATE … SET notified_severity = severity` with **no publish** (counted `suppressed`). A row that already has a `notified_severity` and a higher `severity` (escalation) **always** publishes, however old. Otherwise publish `detected` (notified null) or `escalated` (notified lower than severity), `createSourcedAlert` **only when `breeze_device_id` is set** (alerts require a device; unlinked rows get the event only), then stamp `notified_severity = severity` **after** the publish succeeded, each row in its own try/catch (one failed publish leaves that row to retry next run; never throws out of the evaluator). Endpoint unhealthy/recovered: compare `edr_endpoints.health` to the last published state (kept in the alert dedupe: open alert with `context->>'source' = 'edr_provider'` and `context->>'endpointId'`; resolve via `resolveAlert(..., 'condition_cleared')` when healthy again) — mirror `backupProviders/alerts.ts:180` including its `pg_advisory_xact_lock` and 2-run hysteresis (`nextConditionState`). D10 stale-tenant check is a **separate step `evaluateEdrStaleTenants(now)`** invoked from the `sync-all` tick (`selectDueStreams` loop), not from `syncEdrDetections`: `throwIfAllFailed` (`edrProviderSync.ts:718`) exits before Phase 3, so a continuously failing single-tenant connection would never reach a post-Phase-3 hook. A mapped tenant with `last_detection_sync_at` (or `last_inventory_sync_at`) older than 24 h, or never synced 24 h after creation, raises one `edr.tenant_stale` event (deduped per tenant until it recovers); no device ⇒ event only, shown on the connection card.

- [ ] **Step 1: Failing tests** (unit, mocked `eventBus`/`createSourcedAlert`): (a) new critical linked detection → one event + one alert + `notified_severity` stamped; (b) same call twice → second publishes nothing (idempotent); (c) severity escalates high→critical → one `escalated`; (d) never-notified detection older than horizon → stamped, **zero** publishes (the flood test: 50 old rows ⇒ `published 0, suppressed 50`); (e) unlinked detection → event, no alert; (f) `createSourcedAlert` rejects for row 1 → row 1 not stamped, row 2 still processed; (g) resolved/dismissed rows never publish; (h) `detached_at` rows never publish; (i) **escalation of a 2-day-old high→critical publishes** (horizon must not swallow it); (j) first-sync insert path stamps `notified_severity` (persist test) while a re-sync update does not overwrite it; (k) `evaluateEdrStaleTenants` fires for a tenant whose every sync threw before Phase 3. Integration: run `syncEdrDetections` twice against fixtures; the second run publishes nothing.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; wire the call after Phase 3 with its own try/catch that logs and never fails the sync job (an alert-path outage must not mark the connection errored).
- [ ] **Step 4:** run `workerEntrypointClosure.contract.test.ts` (`cd apps/api && npx vitest run src/services/workerEntrypointClosure.contract.test.ts`). The `edrProviderSyncWorker` comment says placement `'global'` is valid only because the import closure reaches no socket-local dispatch; the notifier imports `eventBus`/`alertService`. If the contract reds, change placement to match the `m365SyncWorker` precedent (socket-owner) in the same commit and update the comment. **Do not weaken the contract.**
- [ ] **Step 5:** `npx vitest run src/services/edrProviders src/jobs/edrProviderSync` + `src/services/eventSubscribers.contract.test.ts` → PASS; commit `feat(edr): Phase 4 events and alerts with first-sync suppression (#8166)`.

---

### Task A7: Two read-only AI tools + every registry

**Files:**
- Create: `apps/api/src/services/aiToolsEdr.ts` (thin: schema → `resolveEdrReadScope` → `read.ts` → `JSON.stringify`)
- Modify: `aiTools.ts` (import ~61-62, register ~331-332), `aiToolSchemas.ts`, `aiGuardrails.ts` (permission map ~879/1533 pattern: `{ resource: 'devices', action: 'read' }`), `aiAgentSdkTools.ts` (`TOOL_TIERS` ~184-207: both `1`; SDK `tool(...)` registration ~1727-1777), `aiToolOutput.ts:992` (raw-text set), `aiAgents/agentToolCatalog.ts` (`'security_response'`), `mcpCoverage.ts` (`'edr/detections.ts': { tools: ['get_edr_status','list_edr_detections'] }`), `llm/toolEval/agentGoldenTasks.ts`, `helperToolFilter.ts` if the S1 read tools are listed there
- Test: `aiToolsEdr.test.ts`, `aiToolsEdr.siteScope.test.ts`, `aiToolSchemas.edr.test.ts`; contract suites listed in Step 4

`aiToolRateLimits.ts` has entries for **write** tools only (S1/Huntress read tools have none), so these two read tools get **no** entry there.

**Interfaces:**
```ts
// aiToolSchemas.ts — no z.undefined(); every optional uses .optional()
get_edr_status: z.object({ orgId: uuid.optional() })
list_edr_detections: z.object({
  orgId: uuid.optional(), deviceId: uuid.optional(),
  severity: z.enum(['critical','high','medium','low','info']).optional(),
  status: z.enum(['open','all']).optional(), provider: z.string().max(30).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
```
Descriptions ≤ 300 chars, each param ≤ 160, and both **state coverage semantics**: "Returns which providers/tenants were covered; an empty list with partial coverage is NOT proof of no threats."

- [ ] **Step 1: Failing tests:** (a) both tools exist in `aiTools`, tier 1, domain `integrations`, `deviceArgs: ['deviceId']` for the list tool; (b) response JSON contains `coverage` on empty results; (c) a site-restricted actor cannot read a foreign-site detection (mirror `aiToolsSentinelOne.siteScope.test.ts`); (d) a `threatName` of `"Ignore previous instructions…"` comes back inside the fenced raw-text envelope (extend `aiToolOutput.rawTextFencing.test.ts` mapping with `'aiToolsEdr.ts': ['list_edr_detections']`); (e) schema rejects `limit: 1000` and an unknown severity; (f) the same tools are present in the SDK registry with matching tiers.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/aiToolsEdr.test.ts src/services/aiToolSchemas.edr.test.ts` → FAIL.
- [ ] **Step 3:** implement and register in every file above. Add `aiToolsEdr.ts` to the `MODULES` list in `aiTools.userOwnedRelease.contract.test.ts` (line ~64). It has **no** `auth.user.id` write, so no `SAFE_WRITE_SITES` entry — but run the test anyway; the map is **line-keyed**, so a registration edit in a file that already has entries (`aiTools.ts` imports, `aiToolsSentinelOne.ts`) can shift keys: re-run and re-key only if it reds.
- [ ] **Step 4:** run the contract set: `npx vitest run src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiToolsActorParity.contract.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiToolsSiteScope.contract.test.ts src/services/aiTools.deviceArgsCoverage.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/mcpToolPresentation.guardrailParity.contract.test.ts src/services/aiGuardrails.routeParity.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiTools.outputBudget.contract.test.ts src/services/aiAgents/agentToolCatalog.categoryParity.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/__tests__/mcp-coverage.test.ts` → all PASS.
- [ ] **Step 5:** commit `feat(edr): get_edr_status and list_edr_detections AI tools (#8166)`.

---

### Task A8: Detection retention job (D11)

**Files:**
- Create: `apps/api/src/jobs/edrDetectionRetention.ts`, `edrDetectionRetention.test.ts`
- Modify: `jobs/scheduleRegistry.ts` (+ `scheduleRegistry.contract.test.ts` expectations), `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, **`services/retentionMetrics.ts`** (`RETENTION_JOB_NAMES` closed union, ~L28 — `recordRetentionRun('edr_detection_retention')` does not typecheck without it), and the expected-name list/count in `services/workerEntrypointClosure.contract.test.ts` (~L485)

Mirror `jobs/monitorEpisodeRetention.ts` (queue const, `parsePositiveIntEnv` batch size, `retentionBatch` helper, `recordRetentionRun('edr_detection_retention', …)`, `attachWorkerObservability`, `__testOnly`). Rule: delete `edr_detections WHERE status IN ('resolved','dismissed','false_positive','mitigated') AND COALESCE(resolved_at, last_vendor_update_at, updated_at) < now() - interval '180 days'`; **open / in_progress / unknown rows are never pruned**; tombstones (`detached_at NOT NULL`) follow the same status/age rule (an open tombstone is never pruned either). Runs under `withSystemDbAccessContext`. `edr_actions` untouched (W03; spec says actions are kept with detections). Promoted incidents keep their copy (no FK from `incidents.source_ref`).

- [ ] **Step 1: Failing tests:** `__testOnly.retentionPredicate` unit: open 400-day-old row kept; resolved 181 d pruned; resolved 179 d kept; `unknown` kept; batch loop stops at `MAX_BATCHES`. Integration (test stack): seeds the four classes, runs one pass, asserts surviving ids. Cron contract: new queue present in `scheduleRegistry` (`'edr-detection-retention': '17 20 * * *'` — pick a minute not already used; the contract test lists collisions) and `workerReadinessManifest` has `consumers('edrDetectionRetentionWorker')`.
- [ ] **Step 2–4:** implement; `npx vitest run src/jobs/edrDetectionRetention.test.ts src/jobs/scheduleRegistry.contract.test.ts src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(edr): prune resolved detections after 180 days (#8166)`.

---

### Task A9: Portal — visibility flag + read-model leg

**Files (follow the #8357 checklist exactly):**
- Create: `apps/api/migrations/2026-12-22-140000-portal-edr-visibility-flag.sql`
- Modify: `apps/api/src/db/schema/portal.ts:71` (`enableEdrVisibility: boolean('enable_edr_visibility').notNull().default(false)`), `services/portal/portalFlags.ts` (`PORTAL_VISIBILITY_FLAG_KEYS` += `'enableEdrVisibility'`), `routes/portal/featureFlags.ts` (`STRICT_PORTAL_FEATURES` entry, code `PORTAL_EDR_DISABLED`), `routes/orgPortalSettings.ts` (default ~56, type ~84, select ~120, mapper ~151, PATCH ~263), `packages/shared/src/validators/portal.ts:125`, `routes/portal/branding.ts:123`, `services/tenantExportPolicyRegistry.ts:~666`, `apps/portal/src/lib/{api,visibilityGate}.ts` (+ `visibilityGate.test.ts`, `disabledPageCoverage.test.ts`), `services/portal/protection.ts`, `services/portal/securityReadModel.ts`, `packages/shared/src/types/portalVisibility.ts`
- Test: `portalFlags.test.ts`, `featureFlags.test.ts`, `branding.test.ts`, `orgPortalSettings.test.ts`, `protection.test.ts`, `securityReadModel.test.ts`, `packages/shared/src/validators/portal.test.ts`, `src/__tests__/integration/portalEdrVisibility.integration.test.ts`

**Behaviour.** `enableEdrVisibility=false` (default) ⇒ the read model is byte-identical to today. When true: `classifyDeviceProtection` gains `hasEdrEndpoint: boolean` (an EDR endpoint linked to the device with `health='healthy' AND online` counts as protected, like `hasS1Agent`; `unhealthy`/`degraded` → falls through to the existing logic, **never** upgrades to protected); `securityOverview.threatEvents.weeks[].detectedBySource/resolvedBySource` gains `edr` (additive field, 0 when off); `avProducts` gains the generic label `"Managed endpoint protection"` — **never** the vendor name or provider key (no `portal_show_provider_name` analogue in W02; see Open Decision 3). `edr_detections` rows with `detached_at IS NOT NULL` are excluded from counts. `dataStatus` stays `ok` if any EDR rows exist.

`enableEdrVisibility` is **not** added to `PORTAL_SENSITIVE_FLAG_KEYS` (it exposes counts, not network alert content) — so "Enable all" turns it on; call that out in the PR.

- [ ] **Step 1: Failing tests:** `portalFlags` — `PORTAL_VISIBILITY_FLAG_KEYS` includes the key and the exhaustiveness tests (flags DTO ↔ columns) go red; `protection.test.ts` — table: `{hasEdrEndpoint:true, edrHealthy:true}` → protected; `{edr unhealthy}` + null securityStatus → unknown; flag off ⇒ param ignored; `securityReadModel.test.ts` — flag false: identical fixture output with and without EDR rows; flag true: `edr` count and generic label present, **string `bitdefender` and `GravityZone` appear nowhere in the serialized DTO**; integration — an org-A portal user never counts org-B EDR rows; a `PATCH` of the flag by a non-admin is refused.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement the migration, then the code. Migration test: `pnpm db:migrate` on a scratch DB twice (idempotent), then `pnpm db:check-drift`.
- [ ] **Step 4:** `npx vitest run` over the touched files plus `src/__tests__/migrationRlsScope.test.ts` (must remain green with no baseline edit) and `packages/shared`: `cd packages/shared && npx vitest run src/validators/portal.test.ts`; `cd apps/portal && npx vitest run src/lib/visibilityGate.test.ts src/lib/disabledPageCoverage.test.ts`.
- [ ] **Step 5:** commit `feat(portal): vendor-neutral EDR protection visibility flag (#8166)`.

---

### Task A10: Readiness connector

**Files:** Modify `apps/api/src/services/orgAccountReadinessIntegrations.ts` (`ConnectorSystem` L29 += `'edr'`, sort map ~L193, new `loadEdr(partnerId, orgIds)` beside `loadHuntress` L434, call site ~L510); Test `orgAccountReadinessIntegrations.loaders.test.ts`.

Semantics via the existing `parentMappingState`: per org, `connected` when ≥1 active `connected` connection has a mapped `edr_tenants` row for the org and its last detection sync succeeded; `needs_attention` for `reauth_required`/`error`/tenant `error`; `not_configured` when the partner has no active EDR connection; `unmapped` when connections exist but no tenant maps to the org. `provider` is the label only when exactly one provider is mapped (else omitted). Do not emit vendor secrets/ids.

- [ ] **Step 1: Failing tests** for the five states + "two connections, one failing ⇒ needs_attention". **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run src/services/orgAccountReadinessIntegrations` PASS (also run `orgAccountReadiness*.test.ts`). **Step 5:** commit `feat(readiness): EDR connector state (#8166)`.

---

### Task A11: Report consumers

**Files:** Modify `packages/shared/src/reportPdf/threatDetectionPdf.ts` (:203, :213 read Huntress-only coverage/metrics — render the EDR fields), `services/threatDetectionReport.ts` (the no-Huntress early return at ~L314 must not short-circuit an org that has EDR coverage; an EDR-only org gets a real report), `services/securityComplianceReport.ts` (`s1Devices`/`huntressDevices` sets ~L254-263 and the `managed` array ~L436-456), `services/threatDetectionReport.ts` (+ `packages/shared/src/types/threatDetectionReport.ts` additive fields); Tests alongside (`securityComplianceReport*.test.ts`, `threatDetectionReport*.test.ts`, `reportDelivery.threatDetection.test.ts`).

- Security posture: load linked healthy `edr_endpoints` device ids into an `edrDevices` set; add `'EDR'` generic evidence (provider label **is** shown here — this is the MSP's internal report; the customer-facing portal/delivered PDF vs internal distinction follows the existing `securityComplianceReportBackupProviders.ts` rule: use `portalShowProviderName`-style gating only if the existing report already has a customer-delivered mode — executor checks and mirrors `loadBackupProviderEvidence`, defaulting to the generic label when unsure).
- Threat detection: add `edrEndpoints` to `agentCoverage` and EDR detections (open count, by severity) to the summary; `emptySummary` leaves them `null` when no EDR connection exists, so existing snapshots are unchanged.

- [ ] **Step 1: Failing tests:** report with only EDR coverage no longer reports "no endpoint protection"; no-EDR org output identical to before (snapshot); detached/tombstoned rows excluded. **Step 2:** FAIL. **Step 3–4:** implement, PASS. **Step 5:** commit `feat(reports): include EDR endpoints and detections (#8166)`.

---

### Task A12: PR-A verification gate

- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` — exit code 0 (check `$?`); same for `packages/shared`.
- [ ] `pnpm db:check-drift`; migration-naming guard against `origin/main`.
- [ ] `pnpm test-stack up`; run the contract/integration suites per `docs/agents/testing.md`: `incidents-feed`, `edrProviderSync`, `edrProviderRls`, `portalEdrVisibility`, the export-policy suites (×2), `tenantCascade`, `orgMergeRegistry`, `test:rls-coverage`, `test:integration-suite-coverage`, `site-scope-coverage`. Then `pnpm test-stack down` and state in the PR what was left running (nothing).
- [ ] Full API unit run once (`orgMerge.test.ts` and several contracts only red in the full run).
- [ ] Open PR-A: title `feat(edr): W02 surfacing — API (#8166)`; body `Refs #8166` / `Part of #8164`; migration + export-policy statement copied from this plan; `/pr-review-toolkit:review-pr`; stop.

---

# PR-B — Web

Starts after PR-A merges (or stacked on it with `gh workflow run CI --ref <branch>`). Depends on PR-A for: `GET /edr/detections`, `GET /edr/status`, `GET /edr/endpoints?deviceId=`, EDR provider keys as feed `source` values, `enableEdrVisibility`.

## File Structure (PR-B)

| File | Change |
|---|---|
| `apps/web/src/lib/edrProviders.ts` | Create — typed client (queries + `runAction` mutations) |
| `apps/web/src/components/integrations/EdrProvidersIntegration.tsx` | Create — section, add flow, empty state |
| `…/EdrProviderConnectionCard.tsx`, `EdrTenantMapping.tsx`, `EdrUnlinkedEndpoints.tsx` | Create |
| `apps/web/src/components/integrations/IntegrationsPage.tsx` | `SecuritySubTab` += `'edr'`, hash `#edr`, render |
| `apps/web/src/components/security/OtherEdrDetectionList.tsx`, `EdrPage.tsx` | Third tab |
| `apps/web/src/components/devices/DeviceEdrPanel.tsx` (+ `DeviceEdrGenericSection.tsx`) | Generic read-only section |
| `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` | Toggle `enableEdrVisibility` |
| `apps/web/src/locales/*/{integrations,security,devices,settings}.json` | Keys, all 8 dirs |
| `apps/docs/src/content/docs/features/edr-integrations*` + `portal.mdx` visibility table | Docs |

### Task B1: Typed client

**Files:** Create `apps/web/src/lib/edrProviders.ts`, `lib/__tests__/edrProviders.test.ts`.
**Produces:** `fetchEdrProviders()`, `fetchEdrConnections()`, `createEdrConnection(body)`, `patchEdrConnection(id, body)`, `testEdrConnection(id)`, `syncEdrConnection(id)`, `deleteEdrConnection(id)`, `fetchEdrTenants(connectionId)`, `mapEdrTenant(tenantId, orgId|null)`, `fetchEdrEndpoints({connectionId?, state?, deviceId?, orgId?})`, `linkEdrEndpoint(id, deviceId|null)`, `fetchEdrDetections(q)`, `fetchEdrStatus()` — mutations all wrap `runAction` (`apps/web/src/lib/runAction.ts`), queries use the existing fetch helper; types re-exported from `@breeze/shared` (A1).
- [ ] Step 1: failing tests — each mutation sends the right method/path/body (mock `fetchWithAuth`); a 200 `{success:false}` throws `ActionError` (runAction contract); `mapEdrTenant(id, null)` sends `{orgId:null}` not `{}`; `linkEdrEndpoint(id,null)` sends `{deviceId:null}` (W01's `linkSchema` treats `{}` as invalid). Step 2: FAIL. Step 3: implement. Step 4: `cd apps/web && npx vitest run src/lib/__tests__/edrProviders.test.ts src/lib/__tests__/no-silent-mutations.test.ts` PASS. Step 5: commit.

### Task B2: Integrations → Security "EDR providers"

**Files:** the three components + `EdrProvidersIntegration.tsx`, `IntegrationsPage.tsx` (`SecuritySubTab` L68, `securitySubTabs` L102, hash parser ~L195, render ~L659-663), tests `EdrProviderConnectionCard.test.tsx`, `EdrTenantMapping.test.tsx`, `EdrProvidersIntegration.test.tsx`.

Pattern: `BackupProviderConnectionCard.tsx` / `BackupProvidersIntegration.tsx` / `BackupProviderCustomerMapping.tsx` (read them before starting). Behaviour:
- Add flow renders credential fields from `GET /edr/providers` (`credentialFields`, `baseUrlPolicy`), never hard-coded per vendor.
- Card shows status, **per-stream** last sync + effective cadence (`effective*IntervalMinutes`), counts, `capabilitiesSnapshot` badges, and a banner for `reauth_required`; Test/Sync/Edit/Delete via `runAction` (Delete confirms).
- **Partner-admin gating:** write controls hidden/disabled with reason for users failing `canManagePartnerWidePolicies` equivalent (the API 403s; the UI must not offer a button that always fails) — use the same capability flag the backup card uses.
- Tenant mapping table: org picker, "suggested" badge from name match (**suggestion only, never auto-applied**), `vendor_missing_since` shown as "missing since…", unmapped count.
- Unlinked/ambiguous endpoint list with device picker (`state=unlinked|ambiguous`), `linkEdrEndpoint`.
- Hash `#edr` selects the sub-tab. Empty state when no connection. Everything user-facing through `t()`.
- [ ] Step 1: failing component tests — (a) fields rendered from provider descriptors; (b) `reauth_required` banner; (c) non-admin sees no write buttons; (d) mapping row with suggestion does NOT call `mapEdrTenant` until the user clicks; (e) failed `runAction` toasts once (ActionError already toasted — no second toast); (f) `#edr` hash opens the tab. Step 2: FAIL. Step 3: implement. Step 4: `npx vitest run src/components/integrations` PASS. Step 5: commit.

### Task B3: Security → EDR "Other EDR" tab

**Files:** `OtherEdrDetectionList.tsx`, `EdrPage.tsx` (`EdrTab` union, `useHashState`, tab list), `components/incidents/IncidentsPage.tsx` (source labels/badges ~L45 and direct lookup ~L217 know only breeze/huntress/s1 — add a generic fallback badge using the row's provider label so framework findings never render blank), `lib/incidents.ts` (`promoteToIncident` L65 + its input union L15 gain an `edr_detection` variant that builds the required `title`/`classification`/`severity` from the detection; there is no `createIncident` helper), tests.
Tab label = provider label when exactly one framework provider is connected, else `Other EDR` (from `fetchEdrStatus()`); hidden entirely when there is no EDR connection. List: provider badge, severity, status, device link, detected-at, filters (severity, status, provider, org), a stale/partial **coverage banner** from `coverage.notes`, pagination, and a "Promote to incident" action (`promoteToIncident({ kind: 'edr_detection', … })` through `runAction` with `suppressErrorToast` for the quiet path; 409 → "already promoted" state, not an error toast). The legacy two tabs are untouched (`2026-06-25` per-vendor tab decision preserved).
- [ ] Step 1: failing tests — tab hidden without connections; label switches with one vs many providers; partial-coverage banner shows for an **empty** list; promote 409 handled; hash `#other-edr`. Step 2–4: FAIL → implement → `npx vitest run src/components/security` PASS. Step 5: commit.

### Task B4: Generic section on `DeviceEdrPanel`

**Files:** `DeviceEdrGenericSection.tsx` (new, rendered from `DeviceEdrPanel.tsx`, props `{deviceId, orgId}`), tests.
Calls `fetchEdrEndpoints({deviceId})` and `fetchEdrDetections({deviceId, status:'open'})`; renders per linked endpoint: provider label, health, isolation state, tamper, last seen, open-detection list. **Duplicate link** (two rows, same provider, different connections) is flagged "linked by two consoles". **No action buttons** (W03). Hidden when no linked row. Existing S1/Huntress sections unchanged.
- [ ] Step 1: failing tests (hidden when empty; two endpoints render two cards; duplicate-provider notice; no buttons rendered). Step 2–4. Step 5: commit.

### Task B5: Portal toggle + readiness registry + locales + docs

**Files:** also `apps/web/src/lib/orgReadiness.ts` (display-name and settings-link maps ~L419, `connectorRepairs` ~L488, expected-badge registry ~L449 all lack `edr` — without them A10's connector yields an undefined repair URL; link target `/integrations#edr`) + its test; `OrgPortalSettingsEditor.tsx` (draft type L32, key union L80, toggle list ~L150, save payload ~L260) + `.test.tsx`; locale JSON for `settings` (`orgPortalSettingsEditor.visibility.toggles.enableEdrVisibility.{label,description}`), `integrations`, `security`, `devices` in **all 8** dirs; docs.
- [ ] Step 1: failing tests — toggle appears, saves `enableEdrVisibility`, "Enable all" includes it; `localeParity` + `humanizedKeyRegression` suites. Step 2: FAIL. Step 3: implement (en first, then the other 7 — real translations, not copies of en; `TERMINOLOGY.md` for terms). Step 4: `cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n src/locales` PASS; `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` (web) exit 0. Step 5: commit.

### Task B6: PR-B gate

- [ ] `apps/web` typecheck (exit code), full `npx vitest run` for touched dirs, `settingsPageRegistry.test.ts`.
- [ ] Browser pass belongs to the next pre-release sweep (note in PR); if a worktree stack is available, one Playwright smoke: connect → map → endpoint link → detection appears → promote (use `data-testid`s only).
- [ ] PR title `feat(edr): W02 surfacing — web (#8166)`, body includes the Settings rule 9 statement; `/pr-review-toolkit:review-pr`; stop.

---

## Self-review

- **Spec coverage:** §4.7 feed leg/ternary fold/`source` type/promotion/D14 → A1–A4; §4.11 tools + coverage disclosure (D6) → A5, A7; §4.4 Phase 4 + D10 → A6; D11 → A8; §4.12 UI → B1–B5; portal (#7730) → A9 (+B5 toggle); readiness/reports → A10–A11. Deliberately not here: actions, webhooks (W03); vendor-name opt-in for portal (Open Decision 3); `EdrSummaryPanel` dashboard widget; vendor-console deep links.
- **Placeholders:** none intentional; the two spots that say "executor checks and mirrors" (A11 report-delivery mode, A3 integration config name) point at a named file to read, not a design gap.
- **Type consistency:** `EdrDetectionDto`/`EdrStatusSummary` (A1) are what A5, A7, B1, B3, B4 consume; `edrSitePredicate` is defined once in `read.ts` (A5) after being born in `incidents.helpers.ts` (A3) — A5 moves it and re-imports; `foldLegs` (A2) is used by A3.

## Open Decisions (for the owner)

1. **Portal flag: new `enableEdrVisibility`, or reuse `enableSecurity`?** (a) New strict flag, default off, one tiny migration (recommended by the #7730 "customer sees only what the MSP opted into" pattern; EDR counts would otherwise appear for every org that already has the security tab on); (b) reuse `enableSecurity` — no migration, but existing portals silently start showing EDR-derived numbers on the next sync. **Recommend (a).**
2. **First-sync / old-detection notification horizon** — (a) 24 h horizon, back-fill stamped silently (recommended); (b) notify everything open regardless of age (floods); (c) configurable per connection (a new setting/column — rule 9 says no until asked). **Recommend (a).**
3. **Vendor name in the portal** — (a) never in W02, generic "Managed endpoint protection" (recommended; zero new columns); (b) per-connection `portal_show_provider_name` as backup has (needs a column on `edr_connections` ⇒ second migration + export-policy row + UI toggle, the web has no such backup toggle today either). **Recommend (a); revisit when a partner asks.**
4. **Alerts without a linked device** — alerts require a device, so an unlinked critical detection raises an `edr.detection_detected` **event only** (visible in feed/UI, but no alert row, so alert-rule notifications don't fire). (a) accept for W02 and point partners at the unlinked-endpoint list (recommended); (b) add a device-less alert path (touches `alertService` — out of this wave's blast radius). **Recommend (a).**
5. **`edrProviderSyncWorker` placement** — the notifier imports `eventBus`/`alertService`; if `workerEntrypointClosure.contract.test.ts` reds, the worker must become socket-owner (as `m365SyncWorker`). Confirm that's acceptable operationally (socket-owner workers run only on the WS-owning container; relevant to the horizontal-scaling spec #8127). **Recommend: follow the contract; no exception.**
6. **Retention scope** — 180 days for resolved/dismissed/false-positive/mitigated, open never pruned (spec D11); `mitigated` is included here although D11 names only "resolved/dismissed". **Recommend include `mitigated`**; confirm.
7. **`threatDetectionReport` extension** is additive but widens a shared report type (customer-delivered PDFs). Ship in PR-A (recommended) or split to a follow-up if report snapshot churn is a concern.
8. **Partner-company tenants** (W01b's carry-over decision: partner companies are treated as tenants) mean MSP-own endpoints appear in the Other-EDR tab and portal counts for the org they map to — confirm that mapping an MSP's own company to an internal org is intended before PR-B exposes it.
9. **Org-scope sync-health visibility** (Codex review): `edr_connections`/`edr_tenants` are partner-only under RLS, so org-token AI/route callers cannot see tenant staleness. (a) org scope reports coverage from org-visible tables only, with an explicit "sync health visible to partner users only" note (plan default; no migration, but the AI tool is less able to flag stale tenants to org-scoped callers); (b) a narrow `SECURITY DEFINER` freshness function (second migration, security review, more capability). **Recommend (a)** for W02; revisit if org-scoped technicians are a real AI-tool audience.
