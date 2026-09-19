---
tracking_issue: LanternOps/breeze#5728
---
# Portal Hardware Lifecycle W01: Flag, API, and Data Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the fail-closed `enableLifecycle` portal visibility flag end to end, make `hardware_lifecycle` a third `PORTAL_REPORT_TYPES` member with MSP-config inheritance, close the leak where a hardware_lifecycle run would otherwise be visible through the generic report endpoints with the flag off, and add the one dedicated read route the W02 page needs.

**Architecture:** No new table, no new tenancy shape. `portal_branding` already carries seven visibility flags (`enableDashboard`, `enableSecurity`, `enableBackups`, `enableReports`, `enableSupportUsage`, `enableService`, `enableDocuments`, the last two shipped by the Service Deliverables W04 wave); `enableLifecycle` is the eighth, added the identical way. `reports`/`report_runs` already carry RLS and already support the self-service portal pattern (`apps/api/src/services/portal/reportsSelfService.ts`); this wave adds one union member and one predicate parameter, not a new data path.

**Tech Stack:** PostgreSQL + hand-written idempotent SQL migration, Drizzle ORM, Hono + Zod, Vitest (API unit with Drizzle mocks, API integration on real Postgres), Astro/React contract tests in `apps/portal`, react-i18next in `apps/web` (8 locales).

**Spec:** `docs/superpowers/specs/portal/2026-09-13-portal-hardware-lifecycle-design.md` (approved). Sections 3 (data path, decision B2), 4 (entitlement/visibility, decision A2), 7 (API surface), 8 (testing), and the W01 row of section 9 (rollout) are this wave.

**Precedent this wave copies, not reinvents:** `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md` (the `enableDashboard`-style flag pattern) and the Service Deliverables W04 plan (`docs/superpowers/plans/billing/2026-09-10-service-deliverables-w04-portal.md`, Tasks 1-2), the most recent wave to add flags to this table. `enableService`/`enableDocuments` are the live reference implementation for every step below.

**Depends on:** `LanternOps/breeze#5701` (Hardware Lifecycle PDF report) merged to `main`. As of 2026-09-13 #5701 is OPEN with `mergeStateStatus: BLOCKED`; `packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`, `packages/shared/src/utils/hardwareLifecycle.ts`, `packages/shared/src/types/hardwareLifecycleReport.ts`, and `hardwareLifecycleConfigSchema` in `apps/api/src/routes/reports/schemas.ts` do not exist on `main` yet. Do not start Task 6 or later until #5701 has merged and this branch is rebased on it. Tasks 1-5 (flag plumbing) have no dependency on #5701.

## Global Constraints

- **Tenancy:** every read runs inside the ambient portal org transaction set by `portalAuthMiddleware`. No `runOutsideDbContext`, no `withSystemDbAccessContext`, anywhere in this wave except the script in Task 9. `portal_branding` and `reports`/`report_runs` are shape 1 (direct `org_id`); `breeze_has_org_access(org_id)` is the only policy exercised.
- **Org id is server-derived** from `auth.user.orgId` on every function; no route accepts an org id as input.
- **Fail closed:** `enableLifecycle` defaults `false` for every org. `createPortalFeatureGateStrict` already 403s on a missing row or a non-`true` value; no change needed there.
- **Migration slot:** `apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql`. Newest committed migration at plan-writing time is `2026-10-16-170800-fleet-design-apply.sql`, so `181500` sorts last (moved off 180300 and 180500, claimed by #5736 and #5701). Confirm with `ls apps/api/migrations | sort | tail -3` right before committing Task 1, and again against `origin/main` before pushing.
- **Export-policy column rule:** `portal_branding` is in `CORE_ORG_CASCADE_DELETE_ORDER`; the new column needs an `included` entry in `tenantExportPolicyRegistry.ts` in the same PR.
- **Portal contract tests the spec does not mention (found by reading the actual test files, not the spec):**
  - `apps/portal/src/lib/visibilityGate.test.ts` greps `apps/api/src/routes/portal/featureFlags.ts` for every `PORTAL_*_DISABLED` string and asserts `PORTAL_DISABLED_CODES` covers it. Adding the new code to `featureFlags.ts` without updating this list reds the test.
  - `apps/portal/src/lib/disabledPageCoverage.test.ts` requires every page calling a gated `portalApi` method to branch on that gate's code. W02's `lifecycle.astro` calls `portalApi.getHardwareLifecycleLatest()`, so its map entry has to exist before W02 needs it, not after.
  - `apps/api/src/routes/portal/featureFlags.test.ts` (`it.each` table) and `apps/api/src/services/portal/portalFlags.test.ts` (exact-array assertion).
- **Running one test file:** `cd apps/api && npx vitest run <path>`, same pattern for `apps/portal`, `apps/web`, `packages/shared`. Never `pnpm --filter <pkg> test -- --run <path>`. Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, with `pnpm test-stack up` first and `pnpm test-stack down` after.
- **Migration RLS-scope guard does not apply here.** The migration is a single `ADD COLUMN IF NOT EXISTS` (DDL only, no rows written), so no `breeze.scope` election is required, same as the `enable_service`/`enable_documents` migration this one is modeled on.
- **Every user-visible `apps/web` string** needs a real translation in all 8 locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) under `apps/web/src/locales/*/settings.json`.
- **No dash-as-punctuation in any new prose this wave adds** (error messages, toggle descriptions, locale strings, code comments), per the spec's copy rule. The existing `PORTAL_DEFINITIONS` entries in `reportsSelfService.ts` use an em dash as their name separator; Task 6 copies that literal character from the file rather than typing a substitute, since it is existing runtime data, not new prose.
- **Branch:** `feature/5719-portal-hardware-lifecycle/wave-<W01 sub-issue#>`; PR body contains `Closes #<W01 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql` | `enable_lifecycle` column |
| `apps/api/src/db/schema/portal.ts` | `enableLifecycle` Drizzle column |
| `apps/api/src/services/portal/portalFlags.ts` (+ `.test.ts`) | `PORTAL_VISIBILITY_FLAG_KEYS` (8th entry) |
| `apps/api/src/routes/portal/featureFlags.ts` (+ `.test.ts`) | `STRICT_PORTAL_FEATURES` entry |
| `apps/api/src/routes/portal/index.ts` | `/reports/lifecycle/*` second gate |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `enable_lifecycle` in `portal_branding`'s `included` |
| `apps/portal/src/lib/visibilityGate.ts` (+ `.test.ts`) | `PORTAL_LIFECYCLE_DISABLED` code |
| `apps/portal/src/lib/disabledPageCoverage.test.ts` | `getHardwareLifecycleLatest` gate-method entry |
| `apps/api/src/routes/orgPortalSettings.ts` (+ `.test.ts`) | defaults, row type, projection, `current` map |
| `packages/shared/src/validators/portal.ts` (+ `.test.ts`) | `enableLifecycle` on `updatePortalSettingsSchema` |
| `apps/api/src/routes/portal/branding.ts` | authenticated `GET /branding` projection |
| `apps/portal/src/lib/api.ts` | `BrandingConfig.enableLifecycle` |
| `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` (+ `.test.tsx`) | eighth toggle |
| `apps/web/src/locales/*/settings.json` | eighth toggle label/description x 8 |
| `apps/api/src/services/portal/reportsSelfService.ts` (+ `.test.ts`) | `PORTAL_REPORT_TYPES`, `PORTAL_DEFINITIONS`, B2 inheritance, predicate `lifecycleEnabled` param, `latestPortalHardwareLifecycleRun` |
| `apps/api/src/routes/portal/reports.ts` (+ `.test.ts`) | `GET /reports/lifecycle/latest` |
| `apps/portal/src/components/portal/ReportRunList.tsx` (+ `.test.tsx`) | third `ReportType` union member, button, copy |
| `apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts` | gate-leak + B2 inheritance + provisioning idempotency cases |
| `apps/api/scripts/reprovisionPortalReportDefinitions.ts` | one-time re-provisioning script |

Note: `apps/portal/src/lib/navItems.ts` gets **no change** in this wave (spec section 4, Nav); deliberately not in this table.

---

### Task 1: Migration, schema column, export-policy classification

**Files:** create `apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql`; modify `apps/api/src/db/schema/portal.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`.

- [ ] **Step 1:** Confirm the slot: `ls apps/api/migrations | sort | tail -3`. Expect nothing after `2026-10-16-170800-fleet-design-apply.sql`; bump if something has landed since.
- [ ] **Step 2:** Write the migration:

```sql
-- Portal Hardware Lifecycle (#5719, spec sec 4, decision A2): a dedicated
-- fail-closed flag, required alongside enable_reports, gating the customer
-- portal's live replacement-plan page separately from generic report
-- self-service. Same shape as the seven existing visibility columns.
-- DDL only, no rows written, so no breeze.scope election.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_lifecycle boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3:** Add the Drizzle column in `portal.ts`, immediately after `enableDocuments`:

```ts
  // Portal Hardware Lifecycle (#5719): required alongside enableReports so an
  // MSP can turn on generic report self-service before exposing the
  // replacement plan, which names specific machines.
  enableLifecycle: boolean('enable_lifecycle').notNull().default(false),
```

- [ ] **Step 4:** In `tenantExportPolicyRegistry.ts`, append `"enable_lifecycle"` to the `portal_branding` row's `included` array. Ordinary boolean flag, not a suspicious-name match, not json/jsonb/bytea.
- [ ] **Step 5:** With the test stack up (`pnpm test-stack up`), run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`. Expect PASS; a failure naming `enable_lifecycle` means Step 4 was skipped. No RLS allowlist change needed (shape 1, auto-discovered).
- [ ] **Step 6:** Commit:

```bash
git add apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql \
  apps/api/src/db/schema/portal.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(portal): enable_lifecycle column on portal_branding (W01)"
```

---

### Task 2: Flag registry, strict gate, dedicated route mount

**Files:** modify `portalFlags.ts` (+ `.test.ts`), `featureFlags.ts` (+ `.test.ts`), `routes/portal/index.ts`.

- [ ] **Step 1:** Write failing tests: `portalFlags.test.ts`'s `PORTAL_VISIBILITY_FLAG_KEYS` exact-array assertion extended to end `..., 'enableService', 'enableDocuments', 'enableLifecycle'`; `featureFlags.test.ts`'s `it.each` table gains `['enableLifecycle', 'PORTAL_LIFECYCLE_DISABLED']`.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/portal/portalFlags.test.ts src/routes/portal/featureFlags.test.ts`. Expect FAIL.
- [ ] **Step 3:** Append `'enableLifecycle'` to `PORTAL_VISIBILITY_FLAG_KEYS` in `portalFlags.ts`. `onPortalFlagsChanged` is unchanged; this flag provisions nothing on its own (Task 6 gates provisioning on `enableReports`).
- [ ] **Step 4:** Add to `STRICT_PORTAL_FEATURES` in `featureFlags.ts`:

```ts
  enableLifecycle: {
    error: 'Hardware lifecycle is not enabled for this portal',
    code: 'PORTAL_LIFECYCLE_DISABLED',
  },
```

- [ ] **Step 5:** In `routes/portal/index.ts`, immediately after the existing `/reports/*` gate:

```ts
// A second, narrower gate. Hono stacks middleware by matched prefix, so a
// request to /reports/lifecycle/* needs both enableReports and
// enableLifecycle; every other /reports/* path is untouched.
portalRoutes.use('/reports/lifecycle/*', createPortalFeatureGateStrict('enableLifecycle'));
```

- [ ] **Step 6:** Run: `cd apps/api && npx vitest run src/services/portal/portalFlags.test.ts src/routes/portal/featureFlags.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 7:** Commit:

```bash
git add apps/api/src/services/portal/portalFlags.ts apps/api/src/services/portal/portalFlags.test.ts \
  apps/api/src/routes/portal/featureFlags.ts apps/api/src/routes/portal/featureFlags.test.ts \
  apps/api/src/routes/portal/index.ts
git commit -m "feat(portal): enableLifecycle strict gate plus dedicated /reports/lifecycle mount (W01)"
```

---

### Task 3: Portal contract tests the spec omits: `visibilityGate.ts` and `disabledPageCoverage.test.ts`

**Finding, not in the approved spec:** `visibilityGate.test.ts`'s "gate-code parity with the API" test greps `featureFlags.ts` for every `PORTAL_*_DISABLED` string and asserts `visibilityGate.ts`'s `PORTAL_DISABLED_CODES` is a superset. Task 2 adds a code that test scans for, so this test reds unless this task lands in the same PR. Separately, `disabledPageCoverage.test.ts` requires every page calling a gated `portalApi` method to branch on that gate's code in its frontmatter; W02's `lifecycle.astro` calls `portalApi.getHardwareLifecycleLatest()`, so the map entry belongs here, not deferred to W02.

**Files:** modify `apps/portal/src/lib/visibilityGate.ts` (+ `.test.ts`), `apps/portal/src/lib/disabledPageCoverage.test.ts`.

- [ ] **Step 1:** Add `'PORTAL_LIFECYCLE_DISABLED'` to `visibilityGate.test.ts`'s local mirror of `PORTAL_DISABLED_CODES`.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/lib/visibilityGate.test.ts`. Expect FAIL (parity test finds the API code missing from the portal list).
- [ ] **Step 3:** Append `'PORTAL_LIFECYCLE_DISABLED'` to `PORTAL_DISABLED_CODES` in `visibilityGate.ts`. Do not add `/reports/lifecycle` to `PORTAL_GATED_PAGES` yet, that list is for pages that exist; W02 adds it alongside creating the page.
- [ ] **Step 4:** Add to `disabledPageCoverage.test.ts`'s `GATED_API_METHODS`: `getHardwareLifecycleLatest: 'PORTAL_LIFECYCLE_DISABLED',`. Has no effect until W02 creates the method and the page, so the coverage loop is a correct no-op until then.
- [ ] **Step 5:** Run: `cd apps/portal && npx vitest run src/lib/visibilityGate.test.ts src/lib/disabledPageCoverage.test.ts`. Expect PASS.
- [ ] **Step 6:** Commit:

```bash
git add apps/portal/src/lib/visibilityGate.ts apps/portal/src/lib/visibilityGate.test.ts \
  apps/portal/src/lib/disabledPageCoverage.test.ts
git commit -m "feat(portal): register PORTAL_LIFECYCLE_DISABLED in the portal gate contracts (W01)"
```

---

### Task 4: MSP write surface: validator, `orgPortalSettings.ts`, `branding.ts`, portal type

**Files:** modify `packages/shared/src/validators/portal.ts` (+ `.test.ts`), `apps/api/src/routes/orgPortalSettings.ts` (+ `.test.ts`), `apps/api/src/routes/portal/branding.ts`, `apps/portal/src/lib/api.ts`.

- [ ] **Step 1:** Write failing tests: `portal.test.ts` gains a case asserting `updatePortalSettingsSchema.safeParse({ enableLifecycle: true }).success` is `true`. `orgPortalSettings.test.ts`'s visibility-flags persistence case sends `enableLifecycle: true` and expects `current` to carry all eight keys ending `enableService, enableDocuments, enableLifecycle: true`; add `enableLifecycle: true` to that case's `dbUpsertReturning` row and `enableLifecycle: false` to the shared `FULL_ROW` fixture.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts` and `cd packages/shared && npx vitest run src/validators/portal.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement: `validators/portal.ts` gains `enableLifecycle: z.boolean().optional(),` after `enableDocuments`. `orgPortalSettings.ts` gets five mechanical edits: `PORTAL_SETTINGS_DEFAULTS` (add `enableLifecycle: false`), `PortalSettingsRow` type, `portalSettingsColumns()`, `toResponse`, and the `current:` literal passed to `onPortalFlagsChanged`, each adding `enableLifecycle`. `branding.ts`'s authenticated `GET /branding` select gains `enableLifecycle: portalBranding.enableLifecycle` after `enableDocuments`; the public `GET /branding/:domain` projection in the same file does not get it, matching every other visibility flag. `apps/portal/src/lib/api.ts`'s `BrandingConfig` gains `enableLifecycle?: boolean;`.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts src/routes/portal/branding.test.ts && npx tsc --noEmit`; `cd packages/shared && npx vitest run src/validators/portal.test.ts && npx tsc --noEmit`; `cd apps/portal && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts \
  apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts \
  apps/api/src/routes/portal/branding.ts apps/portal/src/lib/api.ts
git commit -m "feat(portal): read and write the enableLifecycle flag (W01)"
```

---

### Task 5: MSP web toggle and eight translations

**Files:** modify `OrgPortalSettingsEditor.tsx` (+ `.test.tsx`), all eight `settings.json` locale files.

- [ ] **Step 1:** In `OrgPortalSettingsEditor.test.tsx`, add `enableLifecycle: false` to the settings fixture and extend the "enable all"/"save all" assertion lists with `'enableLifecycle'`.
- [ ] **Step 2:** Run: `cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement: `PortalSettings` type gains `enableLifecycle: boolean;`; `VisibilityToggleKey` union gains `| 'enableLifecycle'`; `VISIBILITY_TOGGLES` gets a ninth entry keyed `enableLifecycle`; `enableAllVisibility` and the `runAction` PATCH body both add `enableLifecycle`. No new markup.
- [ ] **Step 4:** Add real translations under `orgPortalSettingsEditor.visibility.toggles.enableLifecycle` in all 8 locales. English: label "Hardware lifecycle", description "Show the live replacement plan for your customer's machines." Translate for real in the other seven, do not paste English. Spec open question 4 (section 10, whether the UI should gray out this toggle until Reports is on) is left unresolved here; do not guess at that UX decision, flag it to the owner.
- [ ] **Step 5:** Run: `cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n`. Expect PASS, including the translation-duplicate cap.
- [ ] **Step 6:** Commit:

```bash
git add apps/web/src/components/settings apps/web/src/locales
git commit -m "feat(web): hardware lifecycle portal visibility toggle (W01)"
```

---

### Task 6: `PORTAL_REPORT_TYPES` third member and B2 config inheritance, requires #5701 merged

**Files:** modify `reportsSelfService.ts` (+ `.test.ts`).

- [ ] **Step 0:** Gate check: confirm `hardwareLifecycleConfigSchema` exists in `apps/api/src/routes/reports/schemas.ts` on `main`, and that this branch is rebased onto the #5701 merge commit. Do not proceed otherwise.
- [ ] **Step 1:** Write failing tests: `PORTAL_REPORT_TYPES` includes `'hardware_lifecycle'`; `provisionPortalReportDefinitions` inserts a third row; a B2 inheritance test (mocked Drizzle) where a mocked MSP-side (`portalSelfService: false`) `hardware_lifecycle` row has `config.replaceAgeYears: 6`, and `generatePortalReport({ type: 'hardware_lifecycle', ... })` is asserted to call `generateReport` with config carrying `replaceAgeYears: 6` and `sites: []` (never copied from the MSP row). A second case with no MSP-side row asserts the fallback still produces 4/5/true/true.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts`. Expect FAIL.
- [ ] **Step 3:** Append `'hardware_lifecycle'` to `PORTAL_REPORT_TYPES`, and to `PORTAL_DEFINITIONS`:

```ts
  {
    type: 'hardware_lifecycle',
    name: 'Customer portal <SEP> Hardware Lifecycle', // <SEP> is the exact separator character already used by the two entries above this one in this file (an em dash); copy it from the file, do not retype it, and do not substitute a plain hyphen
    config: {
      sites: [],
      replaceAgeYears: 4,
      serverReplaceAgeYears: 5,
      includeManualAssets: true,
      includeOtherEquipment: true,
    },
  },
```

- [ ] **Step 4:** Implement B2 inheritance. In `generatePortalReport`, after loading `definition` and before the in-flight/rate-limit block, add a lookup of the org's most recent MSP-side `hardware_lifecycle` definition (`portalSelfService: false`, `orderBy(desc(reports.updatedAt))`, `limit(1)`), and when found, merge `replaceAgeYears`, `serverReplaceAgeYears`, `includeManualAssets`, `includeOtherEquipment` from its `config` onto a fresh copy of the portal definition's config, leaving `sites: []` untouched. Pass this merged config, not `definition.config`, into the existing `generateReport(...)` call. This select runs inside the already-open org-scoped RLS transaction, no escalation, and never mutates `PORTAL_DEFINITIONS` in place.
- [ ] **Step 5:** Run: `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts
git commit -m "feat(portal): hardware_lifecycle portal report type with MSP config inheritance (W01)"
```

---

### Task 7: Close the generic-endpoint leak: `lifecycleEnabled` on the two predicates

**Files:** modify `reportsSelfService.ts` (+ `.test.ts`), `portalReportSelfService.integration.test.ts`.

- [ ] **Step 1:** Write failing tests: `portalRunListPredicate`/`portalRunPredicate` unit tests assert, via the compiled `SQL` object (`PgDialect().sqlToQuery`), that a `lifecycleEnabled: false` call adds a `reports.type <> 'hardware_lifecycle'` exclusion and a `true` call does not (assert on the bound predicate, never a deep-object search). A `generatePortalReport` test asserts `args.type === 'hardware_lifecycle'` with a mocked `enableLifecycle: false` branding row throws `PortalReportNotFoundError`, the same error the "no definition" branch already throws, no new distinct error type.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement: widen both predicate functions to take a third `lifecycleEnabled: boolean` argument, adding `ne(reports.type, 'hardware_lifecycle')` as an `and()` arm only when `lifecycleEnabled` is false (`and()` drops `undefined` arms; import `ne` from `drizzle-orm` alongside the existing imports). Update the three call sites (`listPortalRuns`, and the shared `completedRun` helper used by both `renderRunPdf` and `renderRunCsv`) to read `portalBranding.enableLifecycle` for the org first (same table/pattern the strict gate already reads, same org-scoped transaction) and pass it through. In `generatePortalReport`, add a check before the `generateReport` call: when `args.type === 'hardware_lifecycle'` and the org's `enableLifecycle` is not `true`, throw `PortalReportNotFoundError()`.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts src/routes/portal/reports.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Live-DB integration test (spec section 8, the gate-leak case). Extend `portalReportSelfService.integration.test.ts`: seed a completed `hardware_lifecycle` run for an org with `enableReports: true, enableLifecycle: false`; assert `GET /reports/lifecycle/latest` 403s `PORTAL_LIFECYCLE_DISABLED` (Task 8's route); `POST /reports/generate { type: 'hardware_lifecycle' }` 404s in `PortalReportNotFoundError`'s shape; `GET /reports/runs` excludes the run while listing the org's other report types; `GET /reports/runs/:id/pdf` for that run's id 404s. Run (with `pnpm test-stack up` first): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalReportSelfService.integration.test.ts`. Expect PASS.
- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts \
  apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts
git commit -m "fix(portal): exclude hardware_lifecycle from the generic report endpoints when the flag is off (W01)"
```

---

### Task 8: `latestPortalHardwareLifecycleRun` and `GET /reports/lifecycle/latest`

**Files:** modify `reportsSelfService.ts` (+ `.test.ts`), `routes/portal/reports.ts` (+ `.test.ts`).

- [ ] **Step 1:** Write failing tests: a route test asserting `GET /reports/lifecycle/latest` returns `200 { run: { id, generatedAt }, summary }` on a completed run and `404 { error, code: 'PORTAL_REPORT_NOT_GENERATED' }` on none, calling the service with the session's `orgId`/`timezone`. A service unit test asserting `latestPortalHardwareLifecycleRun`'s compiled `where` carries `reports.type = 'hardware_lifecycle'` and the org id (predicate-shape assertion, matching the pattern in `actionItemsReadModel.test.ts`), and that `generatedAt` is formatted from `run.completedAt`, not `summary.generatedAt`.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/routes/portal/reports.test.ts src/services/portal/reportsSelfService.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement `latestPortalHardwareLifecycleRun(orgId, timezone)`: select `reportRuns.id/result/completedAt` joined to `reports`, filtered to `orgId`, `type = 'hardware_lifecycle'`, `portalSelfService = true`, `status = 'completed'`, `orderBy(desc(completedAt), desc(id))`, `limit(1)`; throw `PortalReportNotFoundError` on no row; format `generatedAt` from `row.completedAt` with the same `Intl.DateTimeFormat` call `renderRunPdf` already uses. Export a `HardwareLifecyclePortalLatestDto` type (plain TypeScript, matching every other portal GET DTO in this file, no Zod response schema). Add `GET /reports/lifecycle/latest` to `reports.ts`, catching `PortalReportNotFoundError` into the 404 shape above. No rate limiting beyond the two existing gates.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/routes/portal/reports.test.ts src/services/portal/reportsSelfService.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/routes/portal/reports.ts \
  apps/api/src/services/portal/reportsSelfService.test.ts apps/api/src/routes/portal/reports.test.ts
git commit -m "feat(portal): GET /reports/lifecycle/latest (W01)"
```

---

### Task 9: `ReportRunList` third type, re-provisioning script, final pass

**Files:** modify `ReportRunList.tsx` (+ `.test.tsx`); create `apps/api/scripts/reprovisionPortalReportDefinitions.ts` (check `ls apps/api/scripts/*.ts` first for the existing one-off-script convention before naming it).

- [ ] **Step 1:** In `ReportRunList.test.tsx`, add a case asserting a `data-testid="portal-reports-generate-lifecycle"` button exists and calls `portalApi.generateReport('hardware_lifecycle')` on click.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Widen the local `ReportType` union to include `'hardware_lifecycle'`, add a `GENERATING_COPY` entry ("Generating your hardware lifecycle plan..."), add a third button matching the existing two exactly. This button still needs `enableLifecycle` true to succeed (Task 7's gate); a click with the flag off surfaces the existing `PortalReportNotFoundError` 404 path, indistinguishable from "not provisioned yet" by design (spec section 4).
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Write the one-time re-provisioning script (spec section 10, open question 2, left as a manual script rather than a migration or backfill job pending owner confirmation): select every org with `portal_branding.enable_reports = true`, call `provisionPortalReportDefinitions({ orgId, createdBy: '<system>' })` for each (idempotent via `onConflictDoNothing`), log counts. Run under `withSystemDbAccessContext` since this is a background script, not a request path. Confirm the run mode with the owner before executing against production.
- [ ] **Step 6:** Full pass and commit: `cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx src/lib/visibilityGate.test.ts src/lib/disabledPageCoverage.test.ts`; `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts src/routes/portal/reports.test.ts src/services/portal/portalFlags.test.ts src/routes/portal/featureFlags.test.ts src/routes/orgPortalSettings.test.ts src/routes/portal/branding.test.ts`. Expect PASS across the board.

```bash
git add apps/portal/src/components/portal/ReportRunList.tsx apps/portal/src/components/portal/ReportRunList.test.tsx \
  apps/api/scripts/reprovisionPortalReportDefinitions.ts
git commit -m "feat(portal): generate-lifecycle button plus one-time re-provisioning script (W01)"
```

---

## PR

- Body includes `Closes #<W01 sub-issue>`.
- One review round (`/pr-review-toolkit:review-pr` or Codex `medium`) before enqueueing; re-review only if a fix touches tenancy/RLS.
- Merge with `gh pr merge <N>`, no strategy flag. Never `--admin`: the queue reruns the full `CI Success` gate, including the export-policy and RLS-coverage integration suites and the portal `visibilityGate`/`disabledPageCoverage` suites this wave touches.
- If this branch is stacked on the #5701 rebase rather than targeting `main` directly, dispatch CI explicitly: `gh workflow run CI --ref feature/5719-portal-hardware-lifecycle/wave-<sub-issue#>`.
