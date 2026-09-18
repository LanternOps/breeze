---
issue: LanternOps/breeze#5784
wave: W03
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
---
# Evidence Reports W03: `endpoint_management_review` (Intune) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `#5327` M365 sync tables into the artifact an "Intune
management" plan item promises: enrolment coverage, a compliance breakdown with a
real 30-day trend, the non-compliant device table, stale enrolments and licence
seats — with every unmeasured section saying so.

**Architecture:** A new `report_type` enum label plus a pure aggregator over
`m365_intune_devices`, `m365_posture_rollups` and `m365_license_skus`, left-joined
to `devices` on `breeze_device_id`. Zero new tables, zero new data, **no consent
change** — `DeviceManagementManagedDevices.Read.All` is already in
`customer-graph-read` v3. **This report is the first real consumer of those
tables**: today the only reader is `loadSyncSummary`
(`apps/api/src/services/m365Sync/summary.ts:69`), and there is no list or detail
API for any synced M365 entity.

**Tech Stack:** PostgreSQL + Drizzle, Hono + Zod, Vitest, jsPDF +
jspdf-autotable, Astro + React islands, react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
§3.3 (contents and the entity-history limit), §3.1 rule 2a (freshness), §5.3 (the
per-type wiring checklist), §6, §9.1.

**Plan index:** `docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports.md`

**Depends on:** **W01 only**. Independent of W02, W04, W05 and W06; may run in
parallel with any of them.

---

## Global Constraints

- **Freshness is `last_complete_snapshot_at`, never `last_success_at`.**
  `writeCompletion` (`apps/api/src/services/m365Sync/run.ts:368-387`) sets
  `lastSuccessAt` for a `partial` outcome as well as a `success` one, and sets
  `lastCompleteSnapshotAt` only when `persisted.complete`. `loadSyncSummary`
  already states the rule in as many words
  (`apps/api/src/services/m365Sync/summary.ts:60-62`): *"a partial run succeeds
  without enumerating the tenant, and its timestamp would claim a freshness the
  data does not have."* The artifact also prints `last_status`, `truncated` and
  `sources`.
- **Staleness is judged against the sync cadence, not the reporting period.**
  `intune_devices` syncs on a 6 h adaptive cadence
  (`packages/shared/src/m365/sync.ts:26`, bounds at `:41`). A 29-day-old inventory
  in a monthly report is **stale** even though it sits inside the period.
- **A `needs_consent`, `throttled` or unscheduled domain renders a data-gap
  banner, not zeros.** Unmeasured ≠ zero, following `pctOrNull`
  (`apps/api/src/services/securityComplianceReport.ts:48`) and `dataGap`
  (`apps/api/src/services/securityPosture.ts:265`).
- **Entity-level "changes since last period" is NOT available and must not be
  faked.** Two verified reasons: (a)
  `m365_intune_devices.last_changed_at` is **not** configuration-change history —
  the domain's `core_hash` projection deliberately includes `lastSyncDateTime`
  (`apps/api/src/services/m365Sync/domains/intuneDevices.ts:54-74`, comment: *"In
  the hash on purpose: an Intune device's last check-in is the single most useful
  freshness fact on the row"*), so the hash, and therefore `last_changed_at`,
  churns on every routine check-in; `first_seen_at` likewise means *first observed
  by Breeze*, not *newly enrolled*. (b) Upserts overwrite in place with no
  prior-value record, and `m365SyncRetentionWorker`
  (`apps/api/src/jobs/m365SyncRetentionWorker.ts:35,39-44`) deletes entities stale
  ≥ 30 days, so the population cannot be reconstructed backwards. **This report
  therefore ships current inventory plus rollup trend.** "Which three devices fell
  out of compliance this month" needs real change records — a separate feature.
- **The trend comes from `m365_posture_rollups`, a genuine daily time series** —
  never from entity columns.
- **Persisted data only. No Graph call inside a report run.**
- **The window comes from `EvidenceRunContext`, never from `now()`** (W01, OD-11).
- **Site scope:** `m365_intune_devices.breeze_device_id` site-attributes the
  linked subset. Under a restricted authority the report covers linked devices in
  permitted sites and reports the unlinked population as a **disclosed count only,
  never enumerated** — enumerating it would leak devices outside the technician's
  sites.
- **Not included:** Intune *compliance policy definitions*. They are not persisted
  and there is no action for them, even though
  `DeviceManagementConfiguration.Read.All` is consented. A follow-up sync domain,
  not this wave.
- `endpoint_management_review` stays out of `PORTAL_REPORT_TYPES` and out of the
  two duplicated portal-user allowlists in `reportGenerationService.ts`
  (`:248-254`, `:760-765`) — OD-10 = A.
- `PortalRunDto.type` and the portal `ReportRunList` union **must** be widened:
  `portalRunListPredicate` has no type filter, so an unwidened union is a type lie
  the compiler cannot see because the value comes from the database.
- A type with no `buildReportPdf` arm silently falls through to
  `renderGenericReport` (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`)
  and drops the whole designed summary — **no unit test catches that**, so this
  wave ships an explicit server-side PDF test.
- The eight locale files localize the **web UI only**; the PDF renderer is English.
- Migration filenames must sort after the newest on `origin/main` — re-check at
  the start of this wave.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never**
  `pnpm --filter <pkg> test -- --run <path>`.
- Branch `feature/<parent#>-service-plan-evidence-reports/wave-<W03 sub-issue#>`,
  **targeting `main`**. PR body contains `Closes #<W03 sub-issue>`.

### Rollout gate — `M365_TENANT_SYNC_ENABLED`

**This wave is inert unless `M365_TENANT_SYNC_ENABLED` is on.** It is read at call
time by `isM365TenantSyncEnabled()`
(`apps/api/src/config/env.ts:222-228`) and defaults to `false`. With it off,
`m365_sync_state` is never populated, the three source tables stay empty, and this
report correctly renders a data-gap page — which is honest but not a feature.

> Setting a value in `/opt/breeze/.env` is **necessary but not sufficient**.
> Compose interpolation only happens for variables listed in the service's
> `environment:` block, so `M365_TENANT_SYNC_ENABLED` must be present in
> `/opt/breeze/.env` **and** explicitly mapped in the `api` service's
> `environment:` block of `/opt/breeze/docker-compose.yml`. Confirm per region
> before this wave's first artifact is promised to a customer.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-092000-report-type-endpoint-management-review.sql` | enum add, **alone in the file** |
| `apps/api/src/db/schema/reports.ts` | the enum literal |
| `apps/api/src/services/reportGenerationService.ts` (+ `.test.ts`) | union + both exhaustive switches |
| `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`) | the wave's one registry entry |
| `packages/shared/src/validators/deliverableTemplates.ts` | `MANAGED_EVIDENCE_REPORT_TYPES` gains a member |
| `apps/api/src/routes/reports/schemas.ts` (+ `schemas.config.test.ts`) | config schema + parallel fields |
| `apps/api/src/services/endpointManagementReport.ts` (+ `.test.ts`) | the generator |
| `apps/api/src/services/m365Sync/summary.ts` | export a per-domain freshness reader |
| `packages/shared/src/types/endpointManagementReport.ts` | the summary type |
| `packages/shared/src/utils/endpointManagement.ts` (+ `.test.ts`) | shared arithmetic |
| `packages/shared/src/reportPdf/endpointManagementPdf.ts` | the renderer |
| `packages/shared/src/reportPdf/reportPdf.ts` (+ `reportPdf.endpointManagement.test.ts`) | arm + label |
| `apps/api/src/services/portal/reportsSelfService.ts` | `PORTAL_DEFINITIONS` entry |
| `packages/shared/src/types/portalVisibility.ts`, `apps/portal/src/components/portal/ReportRunList.tsx` | portal unions |
| `apps/web/src/components/reports/*` | six wiring points + options form |
| `apps/web/src/locales/*/reports.json` | key blocks × 8 locales |
| `apps/api/src/__tests__/integration/endpointManagementEvidence.integration.test.ts` | sweep → evidence |

---

### Task 1: Enum migration

**Files:**
- Create: `apps/api/migrations/2026-10-17-092000-report-type-endpoint-management-review.sql`

**Interfaces:**
- Produces: the `report_type` label `'endpoint_management_review'`.

**Alone in the file.** `autoMigrate` wraps each file in one transaction, and a
label added by `ALTER TYPE` cannot be *used* until that transaction commits.
Precedent: `apps/api/migrations/2026-10-16-180700-report-type-hardware-lifecycle.sql`.

- [ ] **Step 1: Re-check the newest migration on `origin/main`**

```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Rename this file upward if main gained something later than `2026-10-17-0920…`.
**W02, W04 and W06 claim adjacent slots and may land in any order** — the slots are
independent (nothing depends on another wave's file), so a fresh-DB replay in
filename order is safe whatever order they merge in.

- [ ] **Step 2: Write the migration**

```sql
-- Endpoint Management Review report: the report type (#5784 W03). Enum add ONLY,
-- in its own file: a label added by ALTER TYPE cannot be used until the
-- transaction that added it commits, and autoMigrate wraps each file in one
-- transaction (precedent: 2026-10-16-180700-report-type-hardware-lifecycle.sql).
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'endpoint_management_review';
```

- [ ] **Step 3: Run the guards and apply twice**

```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: guards PASS, second migrate a clean no-op. **Never** add this file to
`migrationRlsScope.test.ts`'s frozen baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-17-092000-report-type-endpoint-management-review.sql
git commit -m "feat(reports): endpoint_management_review report type enum label (#5784 W03)"
```

---

### Task 2: Type plumbing — enum literal, union, both switches, registry entry

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts` (`pgEnum('report_type', …)` at `:22-40`)
- Modify: `apps/api/src/services/reportGenerationService.ts` (`ReportType` at `:19-45`; the dispatch switch; `zeroSafeReport` at `:808-854`)
- Modify: `apps/api/src/services/reportGenerationService.test.ts` (`REPORT_TYPES` at `:27-36`)
- Modify: `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/validators/deliverableTemplates.ts`

**Interfaces:**
- Produces: `ReportType` gains `'endpoint_management_review'`;
  `MANAGED_EVIDENCE_REGISTRY.endpoint_management_review`;
  `MANAGED_EVIDENCE_REPORT_TYPES` gains a member.

- [ ] **Step 1: Add the pg enum literal ONLY, and watch the drift guard fail**

Add `'endpoint_management_review'` to the `pgEnum` in `reports.ts`, then run
`cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`.
Expected: FAIL on *"the API-local ReportType union covers exactly the DB enum"*
(`:269-275`) — proof the guard is live before you satisfy it.

- [ ] **Step 2: Add the union member and both switch arms**

In `reportGenerationService.ts`, append to the `ReportType` union:

```ts
  // #5784 W03. Service-plan evidence: Intune enrolment, compliance and licence
  // posture from the #5327 sync tables, with the freshness of each domain
  // printed. Current inventory plus rollup trend only — entity-level history is
  // not reconstructible (see services/endpointManagementReport.ts).
  | 'endpoint_management_review'
```

Dispatch arm, beside `hardware_lifecycle`:

```ts
    case 'endpoint_management_review': {
      const { generateEndpointManagementReport } = await import('./endpointManagementReport');
      return generateEndpointManagementReport(orgId, config, authority, evidence);
    }
```

The `await import(...)` keeps a heavy generator out of the hot path and avoids the
module cycle back to `assertReportExecutionPreflight`.

In `zeroSafeReport`, add `endpoint_management_review` to the `emptyRowsReport()`
group beside `hardware_lifecycle` — it is **not** a stored-artifact-only type.
In `reportGenerationService.test.ts`, add the literal to `REPORT_TYPES` (`:27-36`),
**not** to `STORED_ARTIFACT_ONLY_TYPES`.

- [ ] **Step 3: Add the registry entry and the shared tuple member**

In `managedEvidenceRegistry.ts`, replacing the `// W03 adds …` comment:

```ts
  endpoint_management_review: {
    type: 'endpoint_management_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Endpoint management review`,
    defaultConfig: { sites: [], staleEnrolmentDays: 14, trendDays: 30 },
  },
```

In `packages/shared/src/validators/deliverableTemplates.ts`, add
`'endpoint_management_review'` to `MANAGED_EVIDENCE_REPORT_TYPES`.

- [ ] **Step 4: Run the guards to verify they pass**

```bash
cd apps/api && npx vitest run src/services/reportGenerationService.test.ts src/services/managedEvidenceRegistry.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts
```
Expected: PASS, clean. If typecheck complains about a missing switch arm, **that
is the `never` default doing its job** — add the arm, do not cast.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/managedEvidenceRegistry.ts apps/api/src/services/managedEvidenceRegistry.test.ts packages/shared/src/validators/deliverableTemplates.ts
git commit -m "feat(reports): wire endpoint_management_review into the type system and managed registry (#5784 W03)"
```

---

### Task 3: Config schema and its test-pinned parallel field list

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts`, `schemas.config.test.ts`

**Interfaces:**
- Produces: `endpointManagementConfigSchema` (with `.default()`s) and
  `endpointManagementConfigFields` (without), spread into `reportConfigFields`
  and `generateReportSchema.config`.

`schemas.config.test.ts:91-101` asserts the two key sets are equal; a key added to
one and not the other fails there. The `…Fields` object must not apply defaults,
or a saved config would be silently rewritten on persistence.

- [ ] **Step 1: Write the failing parity test**

```ts
it('keeps the endpoint management persistence fields in sync with the generation schema', () => {
  expect(Object.keys(endpointManagementConfigFields).sort()).toEqual(
    Object.keys(endpointManagementConfigSchema.shape).sort(),
  );
});

it('defaults an endpoint management config', () => {
  expect(endpointManagementConfigSchema.parse({})).toEqual({
    sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true,
  });
});

it('rejects an out-of-range trendDays', () => {
  expect(() => endpointManagementConfigSchema.parse({ trendDays: 0 })).toThrow();
  expect(() => endpointManagementConfigSchema.parse({ trendDays: 400 })).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Add the enum literal, the schema and the fields**

Add `'endpoint_management_review'` to `reportTypeSchema` (`:13-31`) with a
one-line comment, then after the `hardwareLifecycle` pair (`:82-105`):

```ts
/**
 * Config for the Endpoint Management Review report (#5784 W03).
 * `staleEnrolmentDays` is judged against the 6 h Intune sync cadence, NOT
 * against the reporting period: a 29-day-old enrolment inside a monthly period
 * is stale. `trendDays` reads m365_posture_rollups, the only genuine time series
 * available — entity rows cannot supply history (see endpointManagementReport.ts).
 */
export const endpointManagementConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  staleEnrolmentDays: z.number().int().min(1).max(180).optional().default(14),
  trendDays: z.number().int().min(1).max(365).optional().default(30),
  includeLicences: z.boolean().optional().default(true),
});

/** Same keys as `endpointManagementConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel and
 *  test-pinned (schemas.config.test.ts). */
export const endpointManagementConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  staleEnrolmentDays: z.number().int().min(1).max(180).optional(),
  trendDays: z.number().int().min(1).max(365).optional(),
  includeLicences: z.boolean().optional(),
};
```

Spread `...endpointManagementConfigFields` into **both** `reportConfigFields`
(`:125-151`) **and** `generateReportSchema.config` (`:182-202`).

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.config.test.ts
git commit -m "feat(reports): endpoint_management_review config schema and parallel field list (#5784 W03)"
```

---

### Task 4: A per-domain freshness reader

**Files:**
- Modify: `apps/api/src/services/m365Sync/summary.ts` (+ its test)

**Interfaces:**
- Produces:
  `loadDomainFreshness(orgId, domains: readonly M365SyncDomain[]): Promise<Record<M365SyncDomain, DomainFreshness>>`
  where `DomainFreshness = { asOf: string | null; lastStatus: string | null; truncated: boolean; sources: Record<string, string> | null; unlicensed: boolean }`.
- Consumed by: Task 5 (this wave) and W06's generator.

**Why not reuse `loadSyncSummary`.** `loadSyncSummary` (`summary.ts:69-104`)
returns `null` outright when `isM365TenantSyncEnabled()` is false and shapes its
output for the UI summary card, iterating **all** `M365_SYNC_DOMAINS`. A report
generator needs the raw per-domain freshness for the two or three domains it
actually reads, **and** needs to distinguish "sync disabled" from "never ran" so
the data-gap line can say which. Extract the query, keep `loadSyncSummary`'s
behaviour identical.

- [ ] **Step 1: Write the failing test**

```ts
it('reads asOf from last_complete_snapshot_at, never last_success_at', async () => {
  stateRows.push({ domain: 'intune_devices', lastStatus: 'partial',
    lastSuccessAt: new Date('2026-09-30T04:00:00Z'),
    lastCompleteSnapshotAt: new Date('2026-09-02T04:00:00Z'),
    truncated: true, sources: { intuneDevices: 'ok' } });
  const got = await loadDomainFreshness(ORG, ['intune_devices']);
  // A partial run advances last_success_at without enumerating the tenant. Using
  // it would claim a freshness the data does not have (summary.ts:60-62).
  expect(got.intune_devices.asOf).toBe('2026-09-02T04:00:00.000Z');
  expect(got.intune_devices.lastStatus).toBe('partial');
  expect(got.intune_devices.truncated).toBe(true);
});

it('reports a never-scheduled domain as asOf null rather than omitting it', async () => {
  const got = await loadDomainFreshness(ORG, ['intune_devices']);
  expect(got.intune_devices).toEqual({ asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts`
Expected: FAIL.

Implement `loadDomainFreshness` over `m365SyncState`, selecting `domain`,
`lastStatus`, `lastCompleteSnapshotAt`, `truncated` and `sources`, filtered to the
requested domains. Return a **total** record: a domain with no state row gets
`asOf: null`, not a missing key. Reuse the existing `isUnlicensed(sources)` helper.
Refactor `loadSyncSummary` to call it so there is one query.

- [ ] **Step 3: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts`

```bash
git add apps/api/src/services/m365Sync/summary.ts apps/api/src/services/m365Sync/summary.test.ts
git commit -m "feat(m365): per-domain freshness reader for report generators (#5784 W03)"
```

---

### Task 5: The shared summary type and arithmetic

**Files:**
- Create: `packages/shared/src/types/endpointManagementReport.ts`
- Create: `packages/shared/src/utils/endpointManagement.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts`

**Interfaces:**
- Produces: `EndpointManagementSummary`, `IntuneDeviceRow`, `LicenceSeatRow`,
  `EndpointFreshness`, `COMPLIANCE_STATES`, `complianceBreakdown(rows)`,
  `trendDelta(series)`, `freshnessLine(freshness, cadenceHours)`.
- Consumed by: the API generator (Task 6, with `satisfies`), the PDF renderer
  (Task 7) and the web preview (Task 9) — all three must agree.

- [ ] **Step 1: Write the summary type**

```ts
// packages/shared/src/types/endpointManagementReport.ts
/**
 * Canonical shape of the Endpoint Management Review report's `summary` snapshot
 * (#5784 W03). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing. `enrolled: null` means UNMEASURED (the domain has
 * never completed a snapshot, or needs consent, or is throttled), never zero.
 * The rule the whole M365 posture program follows: m365_posture_rollups carries
 * `devices_unknown` for exactly this reason.
 */

/** Per-domain freshness, printed on the cover and machine-readable. */
export type EndpointFreshness = {
  /** m365_sync_state.last_complete_snapshot_at. NEVER last_success_at: a partial
   *  run succeeds without enumerating the tenant. */
  asOf?: string | null;
  lastStatus?: string | null;
  truncated?: boolean;
  /** Per-source outcome from m365_sync_state.sources, e.g. needs_consent. */
  sources?: Record<string, string> | null;
  /** True when asOf is older than the domain's sync cadence allows. Judged
   *  against the 6 h cadence, NOT against the reporting period. */
  stale?: boolean;
  /** One human sentence naming every gap. Rendered verbatim. */
  note?: string;
};

export type ComplianceState = 'compliant' | 'noncompliant' | 'inGracePeriod' | 'unknown';

export type IntuneDeviceRow = {
  id: string;
  deviceName: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  userPrincipalName: string | null;
  ownerType: string | null;
  lastIntuneSyncAt: string | null;
  complianceState: ComplianceState | null;
  jailBroken: string | null;
  /** True when the row is present in Breeze but gone from the tenant. */
  isStale?: boolean;
  /** Null when the Intune record has no breeze_device_id link. */
  breezeDeviceId?: string | null;
};

export type LicenceSeatRow = {
  skuPartNumber: string | null;
  consumedUnits: number | null;
  prepaidEnabled: number | null;
  prepaidWarning: number | null;
  prepaidSuspended: number | null;
  capabilityStatus: string | null;
};

export type EndpointManagementSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  /** Occurrence period, or the config date range for an ad-hoc run. */
  period?: { start?: string; end?: string };
  freshness?: Record<string, EndpointFreshness>;
  /** null = unmeasured. */
  enrolment?: {
    intuneDevices: number | null;
    breezeDevices: number | null;
    breezeWithoutIntune: number | null;
    /** Disclosed as a COUNT ONLY under a restricted authority — never enumerated,
     *  since those devices sit outside the technician's sites. */
    intuneWithoutBreezeLink: number | null;
  };
  compliance?: {
    byState: Record<ComplianceState, number> | null;
    /** Daily series from m365_posture_rollups — the ONLY genuine history
     *  available. Entity columns cannot supply it (see the report's doc note). */
    trend?: Array<{ date: string; compliant: number | null; noncompliant: number | null; inGrace: number | null; unknown: number | null }>;
  };
  staleEnrolments?: { count: number | null; thresholdDays?: number };
  licences?: LicenceSeatRow[] | null;
  rows?: IntuneDeviceRow[];
  dataGaps?: string[];
  /** Stated on the artifact so no reader infers device-level history exists. */
  historyCaveat?: string;
};
```

- [ ] **Step 2: Write the failing utils test**

```ts
describe('complianceBreakdown', () => {
  it('returns null for an empty population — unmeasured, not all-zero', () => {
    expect(complianceBreakdown([])).toBeNull();
  });

  it('buckets an unrecognised compliance_state as unknown, never as compliant', () => {
    const got = complianceBreakdown([{ complianceState: 'configManager' }, { complianceState: null }] as never);
    expect(got).toEqual({ compliant: 0, noncompliant: 0, inGracePeriod: 0, unknown: 2 });
  });
});

describe('freshnessLine', () => {
  it('is empty when the snapshot is inside the cadence', () => {
    expect(freshnessLine({ asOf: hoursAgo(3), lastStatus: 'success' }, 6)).toBe('');
  });

  it('calls a 29-day-old snapshot stale even inside a monthly period', () => {
    const line = freshnessLine({ asOf: hoursAgo(24 * 29), lastStatus: 'success' }, 6);
    expect(line).toMatch(/stale/i);
  });

  it('names needs_consent rather than reporting zeros', () => {
    const line = freshnessLine({ asOf: null, sources: { intuneDevices: 'needs_consent' } }, 6);
    expect(line).toMatch(/consent/i);
    expect(line).not.toMatch(/\b0 devices\b/);
  });
});
```

- [ ] **Step 3: Run to verify it fails, implement, run again**

Run: `cd packages/shared && npx vitest run src/utils/endpointManagement.test.ts`
Expected: FAIL, then PASS after implementing. `complianceBreakdown` returns `null`
for an empty input — **never** an all-zero record. `freshnessLine` returns `''`
only when the snapshot is complete and inside the cadence.

Export both modules from the `types` and `utils` barrels beside the
`hardwareLifecycle` lines.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/endpointManagementReport.ts packages/shared/src/types/index.ts packages/shared/src/utils/endpointManagement.ts packages/shared/src/utils/endpointManagement.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): endpoint management report summary type and shared arithmetic (#5784 W03)"
```

---

### Task 6: The generator

**Files:**
- Create: `apps/api/src/services/endpointManagementReport.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `endpointManagementConfigSchema` (Task 3); `loadDomainFreshness`
  (Task 4); `EndpointManagementSummary`, `complianceBreakdown`, `trendDelta`,
  `freshnessLine` (Task 5); `assertReportExecutionPreflight`,
  `ReportGenerationAuthority`, `EvidenceRunContext`, `ReportResult` (W01 Task 4);
  `m365IntuneDevices`, `m365PostureRollups`, `m365LicenseSkus`
  (`apps/api/src/db/schema/m365Sync.ts`), `devices`, `organizations`.
- Produces:
  `generateEndpointManagementReport(orgId, rawConfig, authority, evidence?): Promise<ReportResult>`.

**Reader discipline (spec §3.1 rule 4).** Model the loaders on
`apps/api/src/services/securityComplianceReportVulnerabilities.ts` — a pure
aggregator plus a thin loader on plain `db` that **throws** rather than silently
undercounting on a missing join. Do **not** reuse
`apps/api/src/services/aiAgents/sweepEvidence.ts`: it caps at 25 rows/kind and
12 KB, excludes every jsonb/text column, and requires a pre-held SYSTEM context —
a tenant-isolation hazard in a request path.

- [ ] **Step 1: Write the failing tests**

```ts
it('renders a data-gap page when the intune_devices domain has never completed a snapshot', async () => {
  freshness.intune_devices = { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false };
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED);
  const s = res.summary as EndpointManagementSummary;
  expect(s.enrolment?.intuneDevices).toBeNull();      // unmeasured, NOT zero
  expect(s.compliance?.byState).toBeNull();
  expect(s.dataGaps?.length).toBeGreaterThan(0);
});

it('reads freshness from last_complete_snapshot_at, never last_success_at', async () => {
  freshness.intune_devices = { asOf: '2026-09-02T04:00:00Z', lastStatus: 'partial', truncated: true, sources: {}, unlicensed: false };
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  const s = res.summary as EndpointManagementSummary;
  expect(s.freshness?.intune_devices?.asOf).toBe('2026-09-02T04:00:00Z');
  expect(s.freshness?.intune_devices?.stale).toBe(true);
  expect(s.freshness?.intune_devices?.note).toMatch(/stale/i);
});

it('discloses the unlinked Intune population as a COUNT under a restricted authority, never enumerating it', async () => {
  intuneRows.push({ id: 'a', breezeDeviceId: 'dev1', siteId: 's1' }, { id: 'b', breezeDeviceId: null });
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_RESTRICTED_S1);
  const s = res.summary as EndpointManagementSummary;
  expect(s.enrolment?.intuneWithoutBreezeLink).toBe(1);
  // The load-bearing assertion: the unlinked device must not appear in rows —
  // enumerating it leaks a device outside the technician's sites.
  expect((res.rows as IntuneDeviceRow[]).map((r) => r.id)).toEqual(['a']);
});

it('takes the trend from m365_posture_rollups, not from entity columns', async () => {
  rollupRows.push({ rollupDate: '2026-09-29', devicesCompliant: 40, devicesNoncompliant: 2, devicesInGrace: 1, devicesUnknown: 0 });
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
  expect((res.summary as EndpointManagementSummary).compliance?.trend?.[0]).toMatchObject({ date: '2026-09-29', compliant: 40 });
});

it('states the entity-history caveat on every artifact', async () => {
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_UNRESTRICTED);
  // last_changed_at churns on every check-in (intuneDevices.ts:54-74) and stale
  // entities are deleted after 30 days, so device-level history does not exist.
  // The artifact must say so rather than let a reader infer it.
  expect((res.summary as EndpointManagementSummary).historyCaveat).toBeTruthy();
});

it('returns an empty-but-shaped result for a restricted authority with zero sites', async () => {
  const res = await generateEndpointManagementReport(ORG, {}, AUTH_RESTRICTED_ZERO);
  expect(res.rows).toEqual([]);
  expect(res.rowCount).toBe(0);
  expect(res.summary).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/endpointManagementReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the generator**

Structure, following `hardwareLifecycleReport.ts:131-163` exactly: parse config,
`generatedAt` from `evidence?.generatedAt ?? new Date().toISOString()`,
`assertReportExecutionPreflight(orgId, cfg, authority, 'endpoint_management_review')`,
then the restricted-zero-site early return, then:

1. **Freshness first.** `loadDomainFreshness(orgId, ['intune_devices', 'skus'])`.
   A domain with `asOf === null`, `sources.*  === 'needs_consent'` or
   `'throttled'` renders its whole section as a data gap; **do not query its table
   and print zeros**.
2. **Enrolment coverage** — Intune devices vs Breeze devices; Breeze devices with
   no Intune record; Intune records with no `breeze_device_id`.
3. **Compliance breakdown** — `complianceBreakdown` over the linked population,
   plus the `cfg.trendDays` series from `m365_posture_rollups`.
4. **Non-compliant device table** — `device_name`, `operating_system`,
   `os_version`, `user_principal_name`, `owner_type`, `last_intune_sync_at`,
   `compliance_state`, `jail_broken`.
5. **Stale enrolments** — `last_intune_sync_at` older than
   `cfg.staleEnrolmentDays`, plus `is_stale` rows (present in Breeze, gone from
   the tenant).
6. **Licence seats** — `m365_license_skus` consumed vs prepaid-enabled per SKU,
   when `cfg.includeLicences`.
7. **`historyCaveat`** — one sentence, always present, saying the report shows
   current inventory plus rollup trend and that device-level change history is not
   available.

**The site filter goes in EVERY query branch independently.** The enrolment query,
the compliance query, the row query and the stale query each push their own
`inArray(devices.siteId, …)` conditions — once for `cfg.sites` and once for
`restrictedScope.siteIds`. Do not compute a device-id list once and reuse it: that
is how a branch silently loses its filter when someone edits one query later.

**Under a restricted authority the unlinked Intune population is counted, never
enumerated.** `m365_intune_devices` rows with `breeze_device_id IS NULL` have no
site, so including them in `rows` would serve devices outside the technician's
sites. Count them into `enrolment.intuneWithoutBreezeLink` and stop.

Return `summary` typed with `satisfies EndpointManagementSummary`.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `cd apps/api && npx vitest run src/services/endpointManagementReport.test.ts && npx tsc --noEmit -p tsconfig.json`

```bash
git add apps/api/src/services/endpointManagementReport.ts apps/api/src/services/endpointManagementReport.test.ts
git commit -m "feat(reports): endpoint management review generator over the #5327 sync tables (#5784 W03)"
```

---

### Task 7: The PDF renderer and its `buildReportPdf` arm

**Files:**
- Create: `packages/shared/src/reportPdf/endpointManagementPdf.ts`
- Create: `packages/shared/src/reportPdf/reportPdf.endpointManagement.test.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts`, `index.ts`

**Interfaces:**
- Consumes: `EndpointManagementSummary` (Task 5); the `PdfChrome` contract
  `hardwareLifecyclePdf.ts` declares — copy its shape, do **not** import
  `reportPdf.ts` back or you create a cycle.
- Produces: `renderEndpointManagementReport(doc, summary, opts, chrome)`;
  `REPORT_TYPE_LABELS.endpoint_management_review`; a `buildReportPdf` arm.

**The silent failure this task exists to prevent.** `buildReportPdf`'s final
`else` (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`) falls through to
`renderGenericReport`, which prints the rows as a plain table and **drops the
entire designed summary**. A type with no arm therefore produces a
plausible-looking, wrong PDF on the portal (server-side `renderRunPdf`) and the
scheduled-email path, and **no unit test catches it** unless one is written for
the arm specifically.

- [ ] **Step 1: Write the failing test**

```ts
it('routes to the endpoint management renderer, not renderGenericReport', () => {
  const spy = vi.spyOn(epm, 'renderEndpointManagementReport');
  buildReportPdf([], { reportType: 'endpoint_management_review', generatedAt: 'x', timezone: 'UTC', summary: SUMMARY });
  expect(spy).toHaveBeenCalledOnce();
});

it('prints the freshness note and the history caveat', () => {
  const doc = buildReportPdf([], { reportType: 'endpoint_management_review', generatedAt: 'x', timezone: 'UTC',
    summary: { ...SUMMARY, freshness: { intune_devices: { note: 'Intune inventory is 29 days old.' } }, historyCaveat: 'Shows current inventory and daily trend; device-level change history is not available.' } });
  const text = extractText(doc);
  expect(text).toMatch(/29 days old/);
  expect(text).toMatch(/change history is not available/);
});

it('renders an unmeasured section as N/A, never as zero', () => {
  const doc = buildReportPdf([], { reportType: 'endpoint_management_review', generatedAt: 'x', timezone: 'UTC',
    summary: { ...SUMMARY, enrolment: { intuneDevices: null, breezeDevices: null, breezeWithoutIntune: null, intuneWithoutBreezeLink: null }, compliance: { byState: null } } });
  const text = extractText(doc);
  expect(text).toMatch(/N\/A/);
  expect(text).not.toMatch(/\b0 devices enrolled\b/);
});

it('falls through to the generic renderer when the summary is absent', () => {
  const spy = vi.spyOn(epm, 'renderEndpointManagementReport');
  buildReportPdf([{ a: 1 }], { reportType: 'endpoint_management_review', generatedAt: 'x', timezone: 'UTC' });
  expect(spy).not.toHaveBeenCalled();
});
```

Copy `extractText` from
`packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` — do not
invent a second helper.

- [ ] **Step 2: Run to verify it fails, then write the renderer**

Run: `cd packages/shared && npx vitest run src/reportPdf/reportPdf.endpointManagement.test.ts`
Expected: FAIL.

Model the module on `packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`: a
doc-comment naming the reader, a `PdfChrome` parameter carrying
`{ C, PAGE, drawHeaderBand, drawFooter, drawTitleBlock, drawSectionHeading }`, and
no import back into `reportPdf.ts`. Sections in order: cover + freshness note;
enrolment coverage; compliance breakdown + trend; non-compliant device table
(autoTable, paginating via `didDrawPage`); stale enrolments; licence seats; the
history caveat; changes since last period from `opts.previous`. Every unmeasured
value prints `N/A` with its reason; every colour is paired with a word.

- [ ] **Step 3: Add the arm and the label**

`REPORT_TYPE_LABELS` (`:165-171`) gains
`endpoint_management_review: 'Endpoint Management Review',`. Add an arm
immediately before the final `else`, following the `hardware_lifecycle` shape
(`:1996-2017`): guard on the summary being present and shaped, draw the header
band and footer, then delegate. Widen `BuildOpts['summary']` and export the
renderer from `packages/shared/src/reportPdf/index.ts`.

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd packages/shared && npx vitest run src/reportPdf/ && npx tsc --noEmit`
Expected: PASS — check the reported file count includes both the new suite and the
existing `reportPdf.*` suites.

```bash
git add packages/shared/src/reportPdf
git commit -m "feat(shared): endpoint management review PDF renderer and buildReportPdf arm (#5784 W03)"
```

---

### Task 8: Portal provisioning and the two portal unions

**Files:**
- Modify: `apps/api/src/services/portal/reportsSelfService.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/portalVisibility.ts`
- Modify: `apps/portal/src/components/portal/ReportRunList.tsx` (+ `.test.tsx`)

**The type lie the compiler cannot see.** `portalRunListPredicate`
(`reportsSelfService.ts:267-277`) filters on org, `portal_self_service` and
`status` — **no type filter**. Its `toDto` (`:279-301`) declares the row's `type`
as the three-value `PortalReportType`. So a sweep-generated run of a new type
flows through as a value outside the declared union, and TypeScript cannot catch
it because the value comes from the database.

- [ ] **Step 1: Write the failing tests**

```ts
it('provisions an endpoint management definition for an org enabling portal reports', async () => {
  await provisionPortalReportDefinitions({ orgId: ORG, createdBy: USER });
  expect(inserted.map((r) => r.type)).toContain('endpoint_management_review');
});

it('keeps endpoint_management_review OUT of the portal generate allowlist', () => {
  expect(PORTAL_REPORT_TYPES).not.toContain('endpoint_management_review');
});
```

and in `ReportRunList.test.tsx`, a label-renders / no-generate-button pair.

- [ ] **Step 2: Run to verify they fail, then wire**

Append to `PORTAL_DEFINITIONS` (`:28-63`):

```ts
  {
    type: 'endpoint_management_review',
    name: 'Service evidence — Endpoint management review',
    config: { sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true },
  },
```

W02 added an assertion in `managedEvidenceRegistry.test.ts` that every registry
entry has a matching `PORTAL_DEFINITIONS` row with the same name and config — it
will fail until this entry exists and matches
`MANAGED_EVIDENCE_REGISTRY.endpoint_management_review`. Make them match rather
than loosening the assertion. **Note the config here must include
`includeLicences: true`, so add it to the registry `defaultConfig` in Task 2 too
if you left it out.**

Widen three unions: `PortalRunDto.type`
(`packages/shared/src/types/portalVisibility.ts:246-259`); `toDto`'s `type`
parameter (prefer widening it to `PortalRunDto['type']`, which removes the next
wave's edit); and `ReportRunList.tsx`'s `ReportType` union **and** its
`GENERATING_COPY` total `Record` (`:16-27`) — a missed entry there is a typecheck
failure.

Do **not** add the type to `PORTAL_REPORT_TYPES` (`:131-137`) or to the two
allowlist literals in `reportGenerationService.ts` (`:248-254`, `:760-765`).

- [ ] **Step 3: Run to verify they pass, then commit**

```bash
cd apps/api && npx vitest run src/services/portal/ src/services/managedEvidenceRegistry.test.ts
cd ../portal && npx vitest run && pnpm --filter @breeze/portal typecheck
```

```bash
git add apps/api/src/services/portal packages/shared/src/types/portalVisibility.ts apps/portal/src/components/portal
git commit -m "feat(portal): provision and label endpoint management review runs, no self-serve generate (#5784 W03)"
```

---

### Task 9: Web wiring — six points plus the options form

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx`, `ReportBuilder.tsx`,
  `ReportTemplates.tsx`, `ReportEditPage.tsx`, `ReportPreview.tsx`,
  `reportExport.ts`, `reportTypeSurvivesBuilder.test.ts`
- Create: `apps/web/src/components/reports/EndpointManagementOptionsForm.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/reports/ReportTemplates.endpointManagement.test.tsx`

**Interfaces:**
- Produces: `DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS`,
  `EndpointManagementOptionsFields`, `endpointManagementOptionsFromConfig`,
  `type EndpointManagementOptions` — the same four exports
  `HardwareLifecycleOptionsForm.tsx` provides, so `ReportEditPage.tsx` wires
  identically.

**`ReportBuilder.tsx` breaks the build until mapped.** Its
`Record<LegacyReportType, BuilderReportType>` (`:160-184`) is exhaustive.
`endpoint_management_review` is a curated type with its own options form and is
**not** representable by the freeform builder, so it maps to `'devices'` and
`reportTypeSurvivesBuilder` must return **false** for it.

- [ ] **Step 1: Write the failing tests**

Add to `reportTypeSurvivesBuilder.test.ts`:
`expect(reportTypeSurvivesBuilder('endpoint_management_review')).toBe(false);`

Mirror `ReportTemplates.hardwareLifecycle.test.tsx` for the card → options-form
path, and `HardwareLifecycleOptionsForm.test.tsx` for the form itself.

- [ ] **Step 2: Run to verify they fail, then wire the six points**

1. `ReportsList.tsx:36-42` — add the literal to the `ReportType` union. **No
   hardcoded label map**: `getReportTypeLabel` (`:225`) does a dynamic i18n lookup
   on `reports.reportsList.reportTypes.<type>`, so the label comes from Task 10.
2. `ReportBuilder.tsx:160-184` — `endpoint_management_review: 'devices',` with a
   comment saying it is curated and the builder never offers it.
3. `ReportTemplates.tsx` — add the literal to `reportTypeValues` (`:62-74`); add a
   template card (`:99-114` shape); add a `handleUseTemplate` branch (`:377-398`)
   that sets the options state and opens the options form, as `hardware_lifecycle`
   does.
4. `ReportEditPage.tsx` — import the four options-form exports, add
   `const isEndpointManagement = report.type === 'endpoint_management_review';`
   and a render branch beside `isLifecycle` (`:144-146`).
5. `ReportPreview.tsx` — a branch beside the `hardware_lifecycle` one (`:257-298`)
   rendering enrolment and compliance tiles, and add the literal to the
   `data.type !== 'hardware_lifecycle'` guard on the generic summary grid so the
   generic cards do not also render.
6. `reportExport.ts` — no branch needed (`exportReport` uses `reportType` only for
   the filename and hands it opaquely to `buildReportPdf`), but **widen its
   `summary` union** to include `EndpointManagementSummary` so the staff/browser
   path passes the designed summary through to Task 7's arm rather than dropping
   it.

- [ ] **Step 3: Write the options form**

`EndpointManagementOptionsForm.tsx`, modelled on
`HardwareLifecycleOptionsForm.tsx`: site multi-select, `staleEnrolmentDays`
number, `trendDays` number, `includeLicences` checkbox — each with a help line,
all i18n'd, all `data-testid`'d.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `cd apps/web && npx vitest run src/components/reports/ && pnpm --filter @breeze/web typecheck`
Expected: PASS, clean. A `ReportBuilder.tsx` `Record` complaint is the
exhaustiveness guard — add the mapping, do not cast.

```bash
git add apps/web/src/components/reports
git commit -m "feat(web): endpoint management review report wiring and options form (#5784 W03)"
```

---

### Task 10: Locale keys in all eight locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`

**The name string is duplicated in three separate maps** — the repo's existing
shape. Per locale:

- `reports.reportPreview.reportTypes.endpoint_management_review`
- `reports.reportsList.reportTypes.endpoint_management_review`
- `reports.reportTemplates.reportTypes.endpoint_management_review`
- `reports.reportTemplates.templates.endpoint_management_review` — `{ name, description }`
- `reports.endpointManagementOptions.*` — options-form labels and help text
- `reports.reportPreview.endpointManagement.*` — preview tile labels

- [ ] **Step 1: Add to `en` first, then write real translations in the other seven**

Not English copies. `apps/web/src/lib/i18n/translationCoverage.test.ts` fails a
locale when more than 20% of its flattened keys equal the English value verbatim,
**and** enforces a per-namespace exact-duplicate baseline that `reports.json`
already carries. English copies push the namespace over its baseline.

- [ ] **Step 2: Run both locale guards**

```bash
cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts src/lib/i18n/localeParity.test.ts src/components/reports/reportsPtBR.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(web): endpoint management review locale keys in eight locales (#5784 W03)"
```

---

### Task 11: Integration test — the sweep produces the artifact

**Files:**
- Create: `apps/api/src/__tests__/integration/endpointManagementEvidence.integration.test.ts`

**Placement matters.** An integration test outside
`apps/api/src/__tests__/integration/` is picked up by **no** config and runs
**zero** tests while reporting success.

- [ ] **Case 1 — partner-wide template → artifact, never wired by hand.** Seed an
  org with `m365_sync_state` rows for `intune_devices` (a **complete** snapshot),
  `m365_intune_devices`, `m365_posture_rollups` and `m365_license_skus`. Create a
  partner-wide template set with one monthly item carrying
  `autoEvidenceReportType: 'endpoint_management_review'`, apply it, run
  `runDeliverableSweep` on the due date, and assert a
  `service_deliverable_evidence` row of `kind='report_run'` points at a
  `completed` run of the new type.

- [ ] **Case 2 — a partial snapshot is not treated as fresh.** Set
  `last_success_at = now()` but `last_complete_snapshot_at = now() - 29 days` on
  the `intune_devices` state row. Assert `summary.freshness.intune_devices.asOf`
  equals the **complete-snapshot** timestamp and `.stale` is `true`. **If `asOf`
  comes back as the success timestamp, the generator is reading the wrong column
  — stop.**

- [ ] **Case 3 — no sync state produces a data-gap artifact, not zeros.** Delete
  the state rows. Assert a run is produced, `summary.enrolment.intuneDevices` is
  **null**, and `summary.dataGaps` is non-empty. If it reads `0`, stop.

- [ ] **Case 4 — the unlinked population is counted, never enumerated, under a
  restricted authority.** Assert `summary.enrolment.intuneWithoutBreezeLink` is
  the right count and that no row in `result.rows` has a null `breezeDeviceId`.

- [ ] **Case 5 — OD-12 end to end.** Immediately after the sweep, assert the run
  is absent from the portal run list and that `renderRunPdf` refuses it. Deliver
  the occurrence, then assert the run is listed, downloadable, and that
  `renderRunPdf` produces a buffer **whose text contains the history caveat** —
  proving the server-side path reaches Task 7's arm, not `renderGenericReport`.

- [ ] **Step 2: Run the suite**

```bash
pnpm test-stack up
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/endpointManagementEvidence.integration.test.ts
```
Expected: green with a **non-zero reported test count**.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/endpointManagementEvidence.integration.test.ts
git commit -m "test(reports): endpoint management evidence produced by the sweep, end to end (#5784 W03)"
```

---

### Task 12: Wave verification and PR

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run`;
  `cd packages/shared && npx vitest run`; `cd apps/web && npx vitest run`;
  `cd apps/portal && npx vitest run` → all green.

- [ ] **Step 2: Typecheck and lint** — `pnpm --filter @breeze/web typecheck`,
  `pnpm --filter @breeze/portal typecheck`,
  `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `pnpm lint` → clean.

- [ ] **Step 3: Contract suites on a live database**

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/portalReportSelfService.integration.test.ts \
  src/__tests__/integration/endpointManagementEvidence.integration.test.ts
```
→ green, each with a non-zero test count. **`pnpm test` does not run these.** This
wave adds no table and no column, so cascade/RLS/export-policy must be unchanged —
if any moves, something unintended was added.

- [ ] **Step 4: Prove all three render paths from one stored result** — portal /
  server (`renderRunPdf`, asserted in Case 5), staff / browser (`exportReport` in
  a component test), and the scheduled-email path (same `buildReportPdf` opts). A
  type with no arm degrades silently on the first and third.

- [ ] **Step 5: Manual smoke** (`pnpm wt-stack up`, with
  `M365_TENANT_SYNC_ENABLED=true` in the stack's env — **the wave is inert
  without it**). Seed a connected tenant, create the template item, apply it,
  trigger the sweep, and confirm the artifact shows the freshness line and the
  history caveat. Confirm a portal user cannot see it until the occurrence is
  delivered, and that there is no generate button afterwards.

- [ ] **Step 6: Tear down**

```bash
pnpm test-stack down && pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 7: PR**

Against **`main`**, `Closes #<W03 sub-issue>`, linking the spec and the plan index,
with sections:

- **What the artifact shows, and what it deliberately does not** — current
  inventory plus rollup trend; **no device-level change history**, because
  `last_changed_at` churns on every check-in (`intuneDevices.ts:54-74`), upserts
  overwrite in place, and stale entities are deleted after 30 days. Intune
  *compliance policy definitions* are not persisted and are out of scope.
- **Freshness** — `last_complete_snapshot_at`, never `last_success_at`; staleness
  judged against the 6 h cadence, not the period.
- **Restricted scope** — the unlinked Intune population is a disclosed count, never
  enumerated.
- **Portal** — label only, no generate button; type kept out of
  `PORTAL_REPORT_TYPES` and both allowlist literals; OD-12 gates visibility on
  delivery.
- **Rollout** — **`M365_TENANT_SYNC_ENABLED` must be on for this wave to do
  anything**, and a value in `/opt/breeze/.env` is necessary but not sufficient:
  it must also be mapped in the `api` service's `environment:` block of
  `/opt/breeze/docker-compose.yml`. Confirm per region. **This release must run
  `pnpm --filter @breeze/api reports:reprovision-portal-definitions`** (dry run,
  then `--apply`), or orgs that enabled portal reports earlier will lack the new
  definition. No consent change: `DeviceManagementManagedDevices.Read.All` is
  already in `customer-graph-read` v3.
- **Localization caveat** — the eight locale files localize the web UI only; the
  PDF renderer is English.

Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings.
Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets
`main`, so CI already ran; do not hand-dispatch.

---

## Self-review

**Spec coverage.** §3.3 source tables and "first real consumer" → Task 6; §3.3
freshness incl. rule 2a and the needs_consent/throttled banner → Tasks 4, 5, 6 and
integration Cases 2 and 3; §3.3 contents 1–6 → Task 6 Step 3 and Task 7 Step 2;
§3.3 the entity-history limit, stated on the artifact → `historyCaveat` in Tasks 5,
6, 7 and integration Case 5; §3.3 "not included: compliance policy definitions" →
Global Constraints and the PR body; §3.3 site scope with the count-only disclosure
→ Task 6 Step 3 and integration Case 4. §3.1 rules 1, 2, 2a, 3, 4, 5, 6 → Global
Constraints and Tasks 5, 6, 7. §5.3 steps 1–11 → Tasks 1, 2, 2, 2, 3, 6, 5+7, 9,
10, 8 (step 10's reprovision run is in the PR rollout section, where it can
actually happen). §6 portal impact incl. the `PortalRunDto` type lie → Task 8.
§9.1 contract tests → Tasks 2, 3, 10, 12 Step 3; new integration tests → Task 11;
all-three-render-paths → Task 12 Step 4. OD-8 = A (restricted behaviour for this
type: serve the site-attributable subset, disclose the rest as a count) → Task 6.
OD-10 = A → Task 8, stated twice.

**Placeholders.** Four places deliberately instruct a lookup rather than guessing,
each naming the file to copy from: the chainable db-mock dialect (Task 6 Step 1 →
`hardwareLifecycleReport.test.ts`), the PDF text-extraction helper (Task 7 Step 1 →
`reportPdf.hardwareLifecycle.test.ts`), the options-form shape (Task 9 Step 3 →
`HardwareLifecycleOptionsForm.tsx`) and the template-card tone/icon (Task 9 Step 2
→ `ReportTemplates.tsx:99-114`). Task 6 Step 3's numbered block specifies each
query's source table and filter; it is a specification, not a TODO.

**Type consistency.** `EndpointManagementSummary`, `IntuneDeviceRow`,
`LicenceSeatRow`, `EndpointFreshness`, `ComplianceState`, `complianceBreakdown`,
`trendDelta`, `freshnessLine`, `loadDomainFreshness`, `DomainFreshness`,
`endpointManagementConfigSchema`, `endpointManagementConfigFields`,
`generateEndpointManagementReport`, `renderEndpointManagementReport`,
`DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS`, `EndpointManagementOptionsFields`,
`endpointManagementOptionsFromConfig` and `EndpointManagementOptions` are spelled
identically in every task that mentions them. The enum literal
`'endpoint_management_review'` is identical in the migration, the pg enum, the
`ReportType` union, both switches, `reportTypeSchema`, the registry key,
`MANAGED_EVIDENCE_REPORT_TYPES`, `PORTAL_DEFINITIONS`, `PortalRunDto`, the portal
component union, `REPORT_TYPE_LABELS`, all six web wiring points and every locale
key. `EvidenceRunContext`'s four fields match W01's definition exactly. One
cross-task consistency note is called out inline: the registry `defaultConfig` and
the `PORTAL_DEFINITIONS` config must both carry `includeLicences`, and W02's
registry/portal parity assertion enforces it.

**Cross-wave contracts consumed, not re-implemented.** The registry (W01 Task 3) —
one entry added. The publication gate (W01 Task 10) — only asserted, in Case 5.
The period/baseline contract (W01 Tasks 4, 7, 8) — the generator reads
`EvidenceRunContext` and `opts.previous`; it never derives a window from `now()`
and never calls `previousBaselineFor`. The template column (W01) — used, not
changed. Task 4 adds one export to `m365Sync/summary.ts` and refactors
`loadSyncSummary` onto it; that is additive and must leave the existing summary
tests green.
