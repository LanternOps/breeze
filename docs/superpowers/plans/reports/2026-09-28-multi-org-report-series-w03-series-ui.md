---
tracking_issue: see the INDEX frontmatter (registered with the feature)
spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md
index: docs/superpowers/plans/reports/2026-09-28-multi-org-report-series-INDEX.md
wave: W03 — Series UI (one PR)
blast_radius: medium (web only; every mutation reaches W02 routes that already enforce tenancy)
written_against: main 92764125ed + spec commit e9ac8b6e22, cross-checked against the W01 plan (org-visibility) and the W02 plan draft (series-backend, Tasks 1-2 + its contract concerns) as they stood when this plan was finished; see "Contract concerns"
---

# Multi-org Report Series W03: Series UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read [`2026-09-28-multi-org-report-series-INDEX.md`](2026-09-28-multi-org-report-series-INDEX.md) (same directory) first.** It holds the global constraints and the fixed cross-wave contract: route paths, response shapes, error codes and component names. This plan uses those names exactly.

**Goal:** Make multi-org report series usable from the web. This wave adds:
- the Covers control's "One report per organization" mode in the builder and in two template modals;
- a debounced recipient preview;
- a grouped Saved Reports list with a per-org drill-down (Run now, Edit recipients, Exclude, Include, Detach), filter chips and transfer-owner;
- a locked child view where only the org's recipient overrides are editable;
- an edit page for the series itself;
- eight locales, a docs section, and one Playwright spec (create series → drill-down → exclude → delete).

**Architecture:**
- Everything new lives in `apps/web/src/components/reports/series/`.
- One typed client, `seriesApi.ts`, owns every series HTTP call. Every mutation in it is lexically wrapped in `runAction`, and the file joins the `no-silent-mutations` guard.
- Pure logic lives in two modules: `seriesConfig.ts` (type eligibility, org-agnostic config, Covers modes) and `listModel.ts` (list grouping, filter chips, hash grammar, delivery summary). Both are unit-tested without React.
- The existing big files (`ReportBuilder.tsx`, `ReportsList.tsx`, `ReportEditPage.tsx`, `ReportTemplates.tsx`) gain only small branches that delegate to these components.

**Tech Stack:** Astro + React islands, react-i18next, Vitest + Testing Library (jsdom), Playwright (testid-only Page Objects).

**Spec:** `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md`: §2 (D1, D2, D3, D5), §3.4 (transfer owner, blocked no authority), §3.5 (recipients), §3.6 (routes), §3.7 (web UI, all of it), §5 (W03 tests).

**Depends on:** W01 and W02 merged to main. W01 supplies `CoversCell.tsx`, `OrgPickerField.tsx`, the Covers column and `orgName`. W02 supplies every `/reports/series` route and the new `GET /reports` and `GET /reports/runs` fields.

---

## Contract concerns

The INDEX fixes route paths and a few shapes. It does not fix the items below. This plan assumes the values given here. **Task 1 Step 1 checks each assumption against the merged W01 and W02 code.** A mismatch is fixed in exactly one place, named for each item, and never by changing a W02 route.

1. **Detach in `all` mode could produce a duplicate copy. Resolved by W02 (its contract concern 7).**
   - What would happen: W02's reconciler creates a child for every targeted org that has no active child (spec §3.3). Detach clears the child's `series_id`, so on the next reconcile an `all`-mode series would mint a *second* copy for that org.
   - What W02's plan does: `POST /reports/:id/detach` also un-targets the org (an exclusion in `all` mode, deleting the inclusion in `selected` mode). It also materialises the rule's current matches as `add` overrides, so the standalone report keeps mailing the same customers.
   - What the UI copy promises: "It … stops following this multi-org report."
   - Task 1 Step 1 re-checks the merged code. If the un-target is missing, block W03 on the W02 fix. Never add a second client-side PUT: a partial failure would leave exactly the duplicate this avoids.
2. **Recipient override wire shape.** W02's plan confirms `mode` on `addReportRecipientSchema`, and that `mode:'remove'` is accepted only on series children (400 `recipient_mode_requires_series` elsewhere).
   - `POST /reports/:id/recipients` takes `{ contactId, mode: 'add' | 'remove' }`.
   - `GET /reports/:id/recipients` rows carry `mode`.
   - W03 switches add↔remove as DELETE then POST, so it does not rely on W02 upserting `mode` on conflict (today's insert is `onConflictDoNothing`).
   - Fix location: `seriesApi.ts` (`fetchChildOverrides`, `setChildRecipientOverride`).
3. **Response envelopes not fixed by the INDEX.** This plan assumes:
   - `GET /reports/series` returns `{ data: SeriesDetail[] }`;
   - `POST /reports/series` returns 201 with a bare `SeriesDetail`;
   - `PATCH /:id` and `PUT /:id/targets` return 200 with a bare `SeriesDetail`;
   - the bodies of transfer-owner, DELETE and detach are unused (W03 refetches after each).

   `SeriesDetail` is the INDEX's `GET /:id` shape: `{ series, targets, orgs }`. Fix location: `seriesApi.ts` parse lines and `seriesApi.test.ts` fixtures.
4. **Field names on `series`.** Assumed to be the Drizzle camelCase names from the INDEX table:
   - `id`, `name`, `type`, `format`, `schedule`, `config`;
   - `targetMode`, `recipientRule`, `internalCc`;
   - `revision`, `enabled`, `ownerUserId`, `createdAt`, `updatedAt`.

   Fix location: `series/types.ts` (`SeriesDefinition`).
5. **Request body shapes.**
   - `POST /reports/series` body is assumed to be `{ name, type, format, schedule, config, targetMode, orgIds, recipientRule, internalCc }`. In `all` mode, `orgIds` holds the exclusions; in `selected` mode it holds the inclusions, matching the `report_series_org_targets` row meaning.
   - `PATCH` takes the same keys minus `type`, `targetMode` and `orgIds`. `type` is immutable in the UI, mirroring `PUT /reports/:id`.
   - `internalCc` travels as its own key. The series `config` never carries `emailRecipients`.

   Fix location: `series/types.ts` (`SeriesCreateBody`, `SeriesUpdateBody`).
6. **W01 components, as the W01 plan defines them.** This plan uses them unchanged.
   - `CoversCell({ testId, orgId, orgName?, series?: CoversSeriesSummary | null })`, where `CoversSeriesSummary = { seriesId, targetMode, orgCount }`. The series kind renders when `series.seriesId` is set.
   - `OrgPickerField({ value, onChange, options, testId?, id? })`, plus the hook `useReportTargetOrg(defaultOrgId?)` returning `{ orgId, pickedOrgId, setPickedOrgId, pickerVisible, missing, options }`.
   - `ReportBuilder` locals `orgTarget`, `orgPickerApplies`, `targetOrgId` and `orgMissing`.
   - `ReportTemplates`: a **page-level** `orgTarget` picker. `handleUseTemplate` refuses a non-business template while `orgTarget.missing`.
   - `DeliveryStatusChip.tsx`, which exports `ReportDeliveryStatus` (W03's `series/types.ts` re-exports it) and renders only the warning states.
   - The Saved Reports columns: Name | Covers | Type | Schedule | Format | Last generated | Actions (7). The column count is one constant, `SAVED_REPORTS_COLUMN_COUNT`.
   - Every place this plan edits W01 code names W01's identifiers. If the merged W01 renamed any of them, apply the same edit to the renamed identifier.
   - **Decision on W01's note "W03 replaces the business modal's `ReportOwnerScopeField`": not replaced.** For a business type, the Covers control offers exactly Organization | Combined, which is what `ReportOwnerScopeField` already renders. Its fail-closed gate, its `needsOrganization` hint and its testids are also already pinned by `ReportTemplates.business.test.tsx` and `business-reports.spec.ts`. Swapping it would change no behaviour and would churn both suites. The business modal stays as W01 leaves it.
7. **Series-eligible report types. Consistent with W02 (its contract concern 3).** W02 refuses business, system-authored and managed-evidence types.
   - The web cannot import `assertSeriesTypeSupported`, so `seriesConfig.ts` lists the same set: business types, `MANAGED_EVIDENCE_REPORT_TYPES`, `ai_org_narrative` and `ai_fleet_design`.
   - If the merged W02 exports the set from `@breeze/shared`, import it instead of the local list.
7a. **Error tokens beyond the INDEX (W02 contract concern 4).** W02 adds five:
   - `series_write_denied` (403);
   - `series_target_org_inaccessible` (400);
   - `report_not_series_child` (409);
   - `recipient_mode_requires_series` (400);
   - `recipients_need_export_and_mfa` (403, returned when a series write widens delivery for a caller without export+MFA).

   `seriesFriendlyError` maps all five plus the five INDEX codes.
7b. **The preview body.** W02 accepts an optional `internalCc` in the preview body (W02 contract concern 5). W03 sends it, so "no recipients at all" matches the saved series.
7c. **Series schedules are recurring-only (coordinator ruling; INDEX: the series zod schema rejects `one_time`).** A schedule is never chosen for the user:
   - In the builder, the schedule select already offers daily/weekly/monthly only (`scheduleOptions`; `normalizeSchedule`, `ReportBuilder.tsx:741`, maps a stored `one_time` to `weekly` for every report type, series or not). The user sees and can change the value before saving.
   - In the template modals (Task 11), series mode shows `SeriesScheduleField`, a **required** daily/weekly/monthly select. It is pre-filled only when the template's own schedule is already recurring; a one-time template (posture) leaves it **empty**, the field explains why, and Create is refused client-side until the user picks one. A one-time template never silently becomes monthly.
8. **`GET /reports/:id` carries `seriesId` and `archivedAt`.** W02 Task 10 adds them to the helpers projection. The child view keys off `report.seriesId`. W02 adds `seriesName` to the list only. If the single GET lacks it, the banner falls back to "Part of a multi-org report" (`partOfUnnamed`), and nothing else depends on it.
9. **Partner users with `org_access='selected'`.** W02 gates series reads like writes (its "Decisions" list). W03 therefore fetches `/reports/series` only for users who pass the partner-wide gate. Everyone else sees children as ordinary rows with a Multi-org badge and no series controls.

---

## Global Constraints

- **Rebase first.**
  - Run `git fetch origin main && git rebase origin/main` and confirm that W01 and W02 are on main: `git log --oneline origin/main | grep -Ei "multi-org|report series|org visibility" | head`.
  - W03 builds against their code. If either is missing, stop.
- **Web-only wave.** Nothing under `apps/api/` changes. Everything the UI does is re-checked server-side by W02; the client gates are UX only. That covers `canManagePartnerWidePolicies`, `series_managed`, the type refusal and the org-agnostic config check.
- **The series gate.**
  - The series option and all series controls appear only when `useDefaultReportOwnerScope().canChoose` is true (`ReportOwnerScopeField.tsx:32`). That means a resolved JWT with `scope === 'partner'` AND `user.canManagePartnerWide !== false`: the client counterpart of `canManagePartnerWidePolicies`.
  - An unresolved token fails closed.
  - Do not add a second gate hook.
- **Every mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`), lexically, inside `series/seriesApi.ts`.
  - `seriesApi.ts` joins `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (Task 13).
  - The recipient preview is a read over POST and carries a `// runaction-exempt:` marker with its reason.
  - Callers catch with the repo pattern: `if (err instanceof ActionError && err.status === 401) return;`, and toast only non-`ActionError`s (`handleActionError`).
- **Series calls are cross-org.** Every `/reports/series*` request passes `{ skipOrgIdInjection: true }`: the switcher's org must never narrow a partner-level definition. Contacts for a child's org pass `{ orgIdOverride: orgId }`.
- **UI state lives in the hash** through `useHashState` (`apps/web/src/lib/useHashState.ts`). Never use `useState(() => location.hash)`, which `no-hash-in-usestate.test.ts` fails.
  - Hash grammar for `/reports`: `''` | `<filter>` | `series/<uuid>` | `<filter>/series/<uuid>`.
  - `<filter>` is one of `multi-org`, `single-org`, `combined`. `all` is the empty hash.
- **E2E selectors are `data-testid` only.** Every testid this plan introduces is listed in the task that renders it.
- **Locales.**
  - Every new string lives under `reports.series.*` in `apps/web/src/locales/<locale>/reports.json`, plus one title key in `pages.json`.
  - Task 1 writes the full English copy deck. Task 12 writes the seven translations.
  - Between Task 1 and Task 12, `localeParity.test.ts` is **expected red** (keys present only in `en`). Every intermediate task runs targeted tests only. Task 12 turns it green, and Task 13 runs the full web suite.
- **Test commands.**
  - Web: `cd apps/web && npx vitest run <path>`. Never `pnpm … test -- --run`, which runs the whole suite in watch mode.
  - Typecheck: `cd apps/web && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec astro check`.
  - E2E: `cd e2e-tests && npx playwright test tests/report-series.spec.ts`, against a stack from the `worktree-stack` skill.
- **Existing tests that must keep passing unchanged, except the edits this plan names:**
  - `ReportsList.*.test.tsx`, `ReportBuilder.*.test.tsx`, `ReportTemplates.*.test.tsx`, `ReportEditPage.*.test.tsx`;
  - `e2e-tests/tests/business-reports.spec.ts`.
- **Commits.** Commit after every task. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body states "Refs #<W03 sub-issue>" until the last commit, then "Closes #<W03 sub-issue>".

---

## Review Focus

These are the failure modes most likely to bite a real user that no spec line pins. Each is pinned by a test in the owning task.

1. **Excluding the last organization of a "Chosen organizations" series.**
   - Expected: the action is disabled and says why. An empty `selected` set would archive every copy, or be refused, and neither is what "exclude one org" means.
   - Pinned in Task 8 (`SeriesDrilldown.test.tsx`: "disables Exclude on the only chosen organization") and in Task 7 (`listModel.test.ts`: `canExcludeOrg`).
2. **A slow preview response lands after a newer one.**
   - Rapid rule and target edits must show the numbers for the *current* form, never a stale answer.
   - Pinned in Task 2 (`SeriesRecipientsSection.test.tsx`: "keeps the newest preview when an older response lands last").
3. **Changing the Covers mode or the report type mid-form must not leak series state.**
   - Switching series → org must POST `/reports` without series keys.
   - Switching all → selected must not turn exclusions into inclusions.
   - Changing to a series-ineligible type must drop back to org mode.
   - Pinned in Task 3 ("switching the mode clears the org list"), Task 4 ("falls back to org when the type stops being series-eligible") and Task 5 ("switching back to one organization posts /reports").
4. **A series edit that half-succeeds.**
   - If `PATCH` saves but `PUT /targets` fails, the user must see the failure and stay on the page. A navigation would read as "saved".
   - Pinned in Task 6 (`SeriesEditPage.test.tsx`: "stays on the page when the targets update fails after the settings saved").
5. **An org-scoped user opening a child.**
   - Expected: "Managed by your MSP", recipient editing, no series controls, and no request to `/reports/series`, which would 403 and flash an error.
   - Pinned in Task 10 (`SeriesChildLockBanner.test.tsx`: "an organization user sees Managed by your MSP and never asks for the series").

---

## File map

| File | Change | Task |
|---|---|---|
| `apps/web/src/components/reports/series/types.ts` | create (web mirror of the INDEX types) | 1 |
| `apps/web/src/components/reports/series/seriesConfig.ts` (+ `.test.ts`) | create | 1 |
| `apps/web/src/components/reports/series/seriesApi.ts` (+ `.test.ts`) | create | 1 |
| `apps/web/src/locales/en/reports.json` | `reports.series` block | 1 |
| `apps/web/src/lib/contactRoles.ts` (+ `.test.ts`) | create (moved out of `ContactsCard.tsx`) | 2 |
| `apps/web/src/components/settings/ContactsCard.tsx` | import the moved constants | 2 |
| `apps/web/src/components/reports/series/SeriesRecipientsSection.tsx` (+ test) | create | 2 |
| `apps/web/src/components/reports/series/SeriesTargetingFields.tsx` (+ test) | create | 3 |
| `apps/web/src/components/reports/series/CoversControl.tsx` (+ test) | create | 4 |
| `apps/web/src/components/reports/ReportBuilder.tsx` | Covers control, series mode, series submit | 5, 6 |
| `apps/web/src/components/reports/ReportBuilder.series.test.tsx` | create | 5 |
| `ReportBuilder.test.tsx`, `ReportBuilder.aiFleetDesign.test.tsx`, `ReportBuilder.aiNarrative.test.tsx`, `ReportBuilder.responsiveLayout.test.tsx` | add `useAuthStore` to the auth mock | 5 |
| `apps/web/src/components/reports/series/SeriesEditPage.tsx` (+ test) | create | 6 |
| `apps/web/src/pages/reports/series/[id].astro` | create | 6 |
| `apps/web/src/locales/en/pages.json` | `titles.reportsSeriesEdit` | 6 |
| `apps/web/src/components/reports/series/listModel.ts` (+ test) | create | 7 |
| `apps/web/src/components/reports/series/ReportsFilterChips.tsx` | create | 7 |
| `apps/web/src/components/reports/series/SeriesListRow.tsx` | create | 7, 9 |
| `apps/web/src/components/reports/ReportsList.tsx` | grouping, chips, hash, child badge, runs Series column | 7 |
| `apps/web/src/components/reports/ReportsList.series.test.tsx` | create | 7 |
| `apps/web/src/components/reports/ReportsList.scope.test.tsx` | list URL matcher | 7 |
| `apps/web/src/components/reports/series/SeriesDrilldown.tsx` (+ test) | create | 8 |
| `apps/web/src/components/reports/series/TransferOwnerDialog.tsx` (+ test) | create | 9 |
| `apps/web/src/components/reports/series/SeriesPauseButton.tsx` (+ test) | create (Pause/Resume + Paused badge) | 9 |
| `apps/web/src/components/reports/series/SeriesScheduleField.tsx` (+ test) | create (required recurring schedule) | 11 |
| `apps/web/src/components/reports/series/SeriesListRow.test.tsx` | create | 9 |
| `apps/web/src/components/reports/series/SeriesChildLockBanner.tsx` (+ test) | create | 10 |
| `apps/web/src/components/reports/series/SeriesChildRecipients.tsx` (+ test) | create | 10 |
| `apps/web/src/components/reports/ReportEditPage.tsx` | child branch | 10 |
| `apps/web/src/components/reports/ReportTemplates.tsx` (+ `ReportTemplates.series.test.tsx`) | Covers control in the posture and lifecycle modals | 11 |
| `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{reports,pages}.json` | translations | 12 |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | guard `seriesApi.ts` | 13 |
| `e2e-tests/pages/ReportsPage.ts`, `e2e-tests/tests/report-series.spec.ts` | Page Object + spec | 14 |
| `apps/docs/src/content/docs/features/reports.mdx` | "Multi-org reports" section | 15 |

---

### Task 1: Contract check, types, pure config helpers, the typed client, and the English copy deck

**Files:**
- Create: `apps/web/src/components/reports/series/types.ts`
- Create: `apps/web/src/components/reports/series/seriesConfig.ts`, `seriesConfig.test.ts`
- Create: `apps/web/src/components/reports/series/seriesApi.ts`, `seriesApi.test.ts`
- Modify: `apps/web/src/locales/en/reports.json` (add `reports.series`)

**Interfaces:**
- Consumes: the W02 routes (INDEX "Routes" table); `runAction` / `ActionError` (`apps/web/src/lib/runAction.ts`); `fetchWithAuth` (`apps/web/src/stores/auth.ts:1335`, options `skipOrgIdInjection` / `orgIdOverride`); `i18n` (`apps/web/src/lib/i18n`); `BUSINESS_REPORT_TYPES`, `MANAGED_EVIDENCE_REPORT_TYPES` (`@breeze/shared`); `isBusinessReportType` (`../businessReportAccess`).
- Produces (every later task uses these names):
  - `types.ts`:
    - the INDEX types: `ReportDeliveryStatus`, `SeriesTargetMode`, `SeriesRecipientRule`, `SeriesOrgState`, `SeriesOrgStatus`;
    - definition and payload types: `SeriesDefinition`, `SeriesDetail`, `SeriesRecipientPreview`, `SeriesTargets`, `SeriesCreateBody`, `SeriesUpdateBody`;
    - Covers types: `CoversMode`, `SeriesCoversFields`, `CoversValue`, `SeriesSchedule`;
    - recipient override types: `RecipientOverrideMode`, `RecipientChoice`, `ChildRecipientOverride`, `OrgContact`, `PartnerUserOption`.
  - `seriesConfig.ts`:
    - `DEFAULT_RECIPIENT_RULE`, `ORG_SPECIFIC_CONDITION_FIELDS`, `SERIES_SCHEDULES`, `isSeriesSchedule(value)`;
    - `isSeriesEligibleReportType(type)`, `availableCoversModes(type, partnerWide)`;
    - `stripSeriesConfig(config)`, `configNamesOrgEntities(config)`;
    - `isReportRecipientEmail(value)`, `matchesRecipientRule(contact, rule)`;
    - `sameTargets(a, b)`, `firstCoveredOrgId(targets, orgs)`, `coversFromSeries(detail)`, `seriesBuilderDefaults(series)`.
  - `seriesApi.ts` reads:
    - `fetchSeriesList(): Promise<SeriesDetail[] | null>`
    - `fetchSeriesDetail(id): Promise<SeriesDetail | null>`
    - `previewSeriesRecipients(body): Promise<SeriesRecipientPreview>`
    - `fetchSeriesOwnerCandidates(): Promise<PartnerUserOption[] | 'forbidden'>`
    - `fetchOrgContacts(orgId): Promise<OrgContact[]>`
    - `fetchChildOverrides(reportId): Promise<ChildRecipientOverride[]>`
  - `seriesApi.ts` mutations, all taking `ActionMessages`:
    - `createSeries(body, msgs): Promise<SeriesDetail>`
    - `updateSeries(id, body, msgs): Promise<SeriesDetail>` (also Pause/Resume via `{ enabled }`)
    - `replaceSeriesTargets(id, targets, msgs): Promise<SeriesDetail>`
    - `transferSeriesOwner(id, ownerUserId, msgs): Promise<void>`
    - `deleteSeries(id, msgs): Promise<void>`
    - `detachSeriesChild(reportId, msgs): Promise<void>`
    - `generateSeriesChild(reportId, msgs): Promise<void>`
    - `setChildRecipientOverride(reportId, contactId, current, next, msgs): Promise<void>`
  - `seriesApi.ts` helper: `seriesFriendlyError(code): string | undefined`.

- [ ] **Step 1: Verify the contract against merged W01/W02 (read-only)**

Run:

```bash
cd /path/to/worktree
grep -n "c.json(" apps/api/src/routes/reports/series.ts | head -40
grep -n "export const .*Schema" apps/api/src/routes/reports/seriesSchemas.ts
grep -n "mode" apps/api/src/routes/reports/recipients.ts | head
grep -n "detach" -A30 apps/api/src/routes/reports/core.ts | grep -n "target\|exclu\|series_id" | head
grep -n "export" apps/web/src/components/reports/CoversCell.tsx apps/web/src/components/reports/OrgPickerField.tsx apps/web/src/components/reports/DeliveryStatusChip.tsx
grep -n "orgTarget\|orgPickerApplies\|targetOrgId\|orgMissing" apps/web/src/components/reports/ReportBuilder.tsx apps/web/src/components/reports/ReportTemplates.tsx | head -30
grep -n "SERIES_UNSUPPORTED_REPORT_TYPES\|series_write_denied\|recipients_need_export_and_mfa" -r packages/shared/src apps/api/src/routes/reports apps/api/src/services/reportSeries | head
```

Expected:
- `series.ts` answers `c.json({ data: … })` on `GET /`, a bare detail object on `GET /:id`, 201 on `POST /`, and 200 on `PATCH`/`PUT /targets`.
- `seriesSchemas.ts` has create/update/targets/preview/transfer schemas whose keys match Contract concerns 3–5.
- `recipients.ts` accepts `mode`.
- The detach handler touches the target set (Contract concern 1).
- `CoversCell`, `OrgPickerField`, `useReportTargetOrg` and `DeliveryStatusChip` are named exports with the props in Contract concern 6.
- `ReportBuilder` has `orgTarget`, `orgPickerApplies`, `targetOrgId` and `orgMissing`.
- `ReportTemplates` has a page-level `orgTarget`.

For every line that differs, change only the fix location named in the concern and record the difference in the PR description. Contract concern 1 is not fixed here: a missing un-target blocks W03 on a W02 fix.

- [ ] **Step 2: Write the web types**

Create `apps/web/src/components/reports/series/types.ts`:

```ts
import type { ReportFormat, ReportSchedule, ReportType } from '../ReportsList';

/**
 * Web mirror of the multi-org report series contract (INDEX
 * "Cross-wave contract"; API: apps/api/src/services/reportSeries/types.ts and
 * apps/api/src/services/reportDelivery.ts). Type-only; nothing here runs.
 */
// W01 owns the web declaration (DeliveryStatusChip.tsx); re-exported, never redeclared.
export type { ReportDeliveryStatus } from '../DeliveryStatusChip';
import type { ReportDeliveryStatus } from '../DeliveryStatusChip';
export type SeriesTargetMode = 'all' | 'selected';
export interface SeriesRecipientRule { primaryContact: boolean; roles: string[] }
export type SeriesOrgState = 'active' | 'excluded' | 'ineligible' | 'blocked_no_authority' | 'blocked_no_recipients';
export interface SeriesOrgStatus {
  orgId: string;
  orgName: string;
  state: SeriesOrgState;
  childReportId: string | null;
  lastRun: {
    status: string;
    deliveryStatus: ReportDeliveryStatus | null;
    recipientCount: number | null;
    completedAt: string | null;
  } | null;
}

/** `report_series` as the API serialises it (Drizzle camelCase). */
export interface SeriesDefinition {
  id: string;
  name: string;
  type: ReportType;
  format: ReportFormat;
  schedule: ReportSchedule;
  config: Record<string, unknown>;
  targetMode: SeriesTargetMode;
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
  revision: number;
  enabled: boolean;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /reports/series/:id` (INDEX) — also each element of `GET /reports/series`'s `data`. */
export interface SeriesDetail {
  series: SeriesDefinition;
  /** Exclusions in 'all' mode, inclusions in 'selected' mode. */
  targets: string[];
  orgs: SeriesOrgStatus[];
}

export interface SeriesRecipientPreview {
  totalCustomerRecipients: number;
  orgCount: number;
  orgsWithoutCustomerRecipient: { orgId: string; orgName: string }[];
}

export interface SeriesTargets { targetMode: SeriesTargetMode; orgIds: string[] }

export interface SeriesCreateBody extends SeriesTargets {
  name: string;
  type: string;
  format: ReportFormat;
  schedule: SeriesSchedule;
  config: Record<string, unknown>;
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
}

/** PATCH /reports/series/:id — shared fields and `enabled` (Pause/Resume); targets go through PUT /targets. */
export type SeriesUpdateBody = Partial<
  Pick<SeriesCreateBody, 'name' | 'format' | 'schedule' | 'config' | 'recipientRule' | 'internalCc'>
> & { enabled?: boolean };

/** A series is recurring-only (INDEX: the series zod schema rejects one_time). */
export type SeriesSchedule = Exclude<ReportSchedule, 'one_time'>;

export type CoversMode = 'org' | 'series' | 'combined';
export interface SeriesCoversFields extends SeriesTargets {
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
}
/**
 * The org itself is not part of the Covers value: W01's `useReportTargetOrg`
 * (in the host) owns which org a single-org report targets, and CoversControl
 * renders the host's picker in its org slot.
 */
export type CoversValue =
  | { mode: 'org' }
  | { mode: 'combined' }
  | ({ mode: 'series' } & SeriesCoversFields);

export type RecipientOverrideMode = 'add' | 'remove';
/** 'default' = no override row: the series rule decides. */
export type RecipientChoice = 'default' | RecipientOverrideMode;
export interface ChildRecipientOverride { contactId: string; mode: RecipientOverrideMode }

/** The fields of `GET /orgs/organizations/:id/contacts` rows this wave reads. */
export interface OrgContact {
  id: string;
  name: string | null;
  email: string | null;
  roles: string[];
  isPrimary: boolean;
  siteId: string | null;
}

export interface PartnerUserOption { id: string; name: string; email: string }
```

- [ ] **Step 3: Write the failing config tests**

Create `apps/web/src/components/reports/series/seriesConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REPORT_TYPES } from '@breeze/shared';
import { isSystemManagedReportType } from '../ReportsList';
import {
  availableCoversModes,
  configNamesOrgEntities,
  coversFromSeries,
  firstCoveredOrgId,
  isReportRecipientEmail,
  isSeriesSchedule,
  isSeriesEligibleReportType,
  matchesRecipientRule,
  sameTargets,
  seriesBuilderDefaults,
  stripSeriesConfig,
} from './seriesConfig';
import type { SeriesDetail } from './types';

describe('isSeriesEligibleReportType', () => {
  it('accepts org-executable builder and curated types', () => {
    for (const t of ['device_inventory', 'alert_summary', 'executive_summary', 'security_compliance_posture', 'hardware_lifecycle']) {
      expect(isSeriesEligibleReportType(t), t).toBe(true);
    }
  });
  it('refuses business, managed-evidence and system-managed types', () => {
    for (const t of ['ar_aging', 'ticket_sla_attainment', 'technician_time_billability', 'threat_detection_review',
      'endpoint_management_review', 'vulnerability_management', 'identity_access_review', 'ai_org_narrative', 'ai_fleet_design']) {
      expect(isSeriesEligibleReportType(t), t).toBe(false);
    }
  });
  it('never offers a system-managed type (parity with ReportsList)', () => {
    for (const t of REPORT_TYPES) {
      if (isSystemManagedReportType(t)) expect(isSeriesEligibleReportType(t), t).toBe(false);
    }
  });
  it('refuses a missing type', () => expect(isSeriesEligibleReportType(undefined)).toBe(false));
});

describe('availableCoversModes', () => {
  it('offers only one organization without the partner-wide gate', () => {
    expect(availableCoversModes('device_inventory', false)).toEqual(['org']);
    expect(availableCoversModes('ar_aging', false)).toEqual(['org']);
  });
  it('offers series for an eligible type and combined for a business type, never both', () => {
    expect(availableCoversModes('device_inventory', true)).toEqual(['org', 'series']);
    expect(availableCoversModes('ar_aging', true)).toEqual(['org', 'combined']);
    expect(availableCoversModes('threat_detection_review', true)).toEqual(['org']);
  });
});

describe('stripSeriesConfig', () => {
  it('drops every org-specific selector and the email list, keeps the rest', () => {
    const out = stripSeriesConfig({
      dateRange: { preset: 'last_30_days' },
      sites: ['s1'],
      siteIds: ['s1'],
      deviceIds: ['d1'],
      groupIds: ['g1'],
      deviceGroupIds: ['g2'],
      orgId: 'o1',
      orgIds: ['o1'],
      emailRecipients: ['a@x.io'],
      filters: { siteIds: ['s1'], deviceIds: ['d1'], osTypes: ['windows'] },
      legacyFilters: { siteIds: ['s1'] },
      filterConditions: [
        { id: 'c1', logic: 'and', field: 'site', operator: 'equals', value: 'HQ' },
        { id: 'c2', logic: 'and', field: 'os', operator: 'equals', value: 'windows' },
      ],
      columns: ['hostname'],
    });
    expect(out).toEqual({
      dateRange: { preset: 'last_30_days' },
      filters: { osTypes: ['windows'] },
      filterConditions: [{ id: 'c2', logic: 'and', field: 'os', operator: 'equals', value: 'windows' }],
      columns: ['hostname'],
    });
  });
  it('does not mutate its input', () => {
    const input = { filters: { siteIds: ['s1'] } };
    stripSeriesConfig(input);
    expect(input).toEqual({ filters: { siteIds: ['s1'] } });
  });
});

describe('configNamesOrgEntities', () => {
  it('is true for any non-empty org selector, false for empty ones', () => {
    expect(configNamesOrgEntities({ filters: { siteIds: ['s1'] } })).toBe(true);
    expect(configNamesOrgEntities({ sites: [] , filters: { siteIds: [] } })).toBe(false);
    expect(configNamesOrgEntities({ filterConditions: [{ field: 'site', value: 'HQ' }] })).toBe(true);
    expect(configNamesOrgEntities({ columns: ['site'] })).toBe(false);
  });
});

describe('recipient helpers', () => {
  it('accepts the same loose shape as the builder and the API', () => {
    expect(isReportRecipientEmail('ops@msp.example')).toBe(true);
    expect(isReportRecipientEmail(' ops@msp.example ')).toBe(true);
    expect(isReportRecipientEmail('ops@msp')).toBe(false);
  });
  it('matches the org-level primary contact and role overlap', () => {
    const rule = { primaryContact: true, roles: ['billing'] };
    expect(matchesRecipientRule({ isPrimary: true, siteId: null, roles: [] }, rule)).toBe(true);
    expect(matchesRecipientRule({ isPrimary: true, siteId: 'site-1', roles: [] }, rule)).toBe(false);
    expect(matchesRecipientRule({ isPrimary: false, siteId: null, roles: ['billing'] }, rule)).toBe(true);
    expect(matchesRecipientRule({ isPrimary: false, siteId: null, roles: ['technical'] }, rule)).toBe(false);
  });
});

describe('targets and defaults', () => {
  const detail: SeriesDetail = {
    series: {
      id: 's-1', name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly',
      config: { schedule: { time: '07:30', day: 'monday', date: '3' }, dateRange: { preset: 'last_7_days' } },
      targetMode: 'all', recipientRule: { primaryContact: true, roles: ['technical'] }, internalCc: ['ops@msp.example'],
      revision: 2, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '',
    },
    targets: ['o-2'],
    orgs: [],
  };
  it('compares targets ignoring order', () => {
    expect(sameTargets({ targetMode: 'all', orgIds: ['a', 'b'] }, { targetMode: 'all', orgIds: ['b', 'a'] })).toBe(true);
    expect(sameTargets({ targetMode: 'all', orgIds: ['a'] }, { targetMode: 'selected', orgIds: ['a'] })).toBe(false);
  });
  it('accepts only recurring schedules', () => {
    expect(['daily', 'weekly', 'monthly'].every((v) => isSeriesSchedule(v))).toBe(true);
    expect(isSeriesSchedule('one_time')).toBe(false);
    expect(isSeriesSchedule(undefined)).toBe(false);
  });
  it('picks the first covered org for the live preview', () => {
    const orgs = [{ id: 'a' }, { id: 'b' }];
    expect(firstCoveredOrgId({ targetMode: 'all', orgIds: ['a'] }, orgs)).toBe('b');
    expect(firstCoveredOrgId({ targetMode: 'selected', orgIds: ['b'] }, orgs)).toBe('b');
    expect(firstCoveredOrgId({ targetMode: 'selected', orgIds: [] }, orgs)).toBeNull();
  });
  it('rebuilds the Covers value and the builder defaults from a stored series', () => {
    expect(coversFromSeries(detail)).toEqual({
      mode: 'series', targetMode: 'all', orgIds: ['o-2'],
      recipientRule: { primaryContact: true, roles: ['technical'] }, internalCc: ['ops@msp.example'],
    });
    expect(seriesBuilderDefaults(detail.series)).toMatchObject({
      name: 'Monthly health', type: 'device_inventory', schedule: 'monthly', format: 'pdf',
      scheduleTime: '07:30', scheduleDay: 'monday', scheduleDate: '3', dateRange: { preset: 'last_7_days' },
    });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/reports/series/seriesConfig.test.ts`
Expected: FAIL. The error is `Failed to resolve import "./seriesConfig"`.

- [ ] **Step 5: Implement `seriesConfig.ts`**

```ts
import { BUSINESS_REPORT_TYPES, MANAGED_EVIDENCE_REPORT_TYPES } from '@breeze/shared';
import { isBusinessReportType } from '../businessReportAccess';
import type { ReportBuilderFormValues } from '../ReportBuilder';
import type { CoversMode, CoversValue, SeriesDefinition, SeriesDetail, SeriesRecipientRule, SeriesSchedule, SeriesTargets } from './types';

/** Spec §3.2: the org's primary contact by default. */
export const DEFAULT_RECIPIENT_RULE: SeriesRecipientRule = { primaryContact: true, roles: [] };

/** Recurring-only (INDEX: the series zod schema rejects one_time). */
export const SERIES_SCHEDULES: readonly SeriesSchedule[] = ['daily', 'weekly', 'monthly'];
export function isSeriesSchedule(value: string | undefined): value is SeriesSchedule {
  return !!value && (SERIES_SCHEDULES as readonly string[]).includes(value);
}

/**
 * Types a series refuses (spec §3.2, INDEX "Series types"). A SUPERSET of the
 * server's `assertSeriesTypeSupported` on purpose: over-refusing here only hides
 * an option; under-refusing is a 400 the user could not have avoided.
 * `ai_org_narrative` / `ai_fleet_design` mirror SYSTEM_MANAGED_REPORT_TYPES in
 * ../ReportsList.tsx (listed here, not imported, so ReportsList can import this
 * module without a cycle; seriesConfig.test.ts pins the parity).
 * If W02 exported SERIES_UNSUPPORTED_REPORT_TYPES from @breeze/shared, import
 * it here instead (Contract concern 7).
 */
const SERIES_REFUSED_TYPES: ReadonlySet<string> = new Set<string>([
  ...BUSINESS_REPORT_TYPES,
  ...MANAGED_EVIDENCE_REPORT_TYPES,
  'ai_org_narrative',
  'ai_fleet_design',
]);

export function isSeriesEligibleReportType(type: string | undefined): boolean {
  return !!type && !SERIES_REFUSED_TYPES.has(type);
}

/**
 * The Covers choices for a report type. `partnerWide` is
 * `useDefaultReportOwnerScope().canChoose`. Series and Combined are disjoint by
 * type: Combined is the partner-owned aggregate, whose only types are the
 * business trio (the registry's `supportedScopes` 'partner'); a series refuses
 * exactly those.
 */
export function availableCoversModes(type: string | undefined, partnerWide: boolean): CoversMode[] {
  if (!partnerWide) return ['org'];
  if (isBusinessReportType(type)) return ['org', 'combined'];
  if (isSeriesEligibleReportType(type)) return ['org', 'series'];
  return ['org'];
}

/** Builder filter fields that name an org's own entities (ReportBuilder fieldDefinitionsByType). */
export const ORG_SPECIFIC_CONDITION_FIELDS: ReadonlySet<string> = new Set(['site']);

// Top-level keys that name sites/devices/groups/orgs (reportConfigSchemas.ts:
// `sites` on the posture-family schemas, the refused business selectors).
const ORG_SPECIFIC_TOP_LEVEL_KEYS = ['sites', 'siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds', 'orgId', 'orgIds'] as const;
// Keys inside `filters` (legacyReportConfigSchema) and the builder's `legacyFilters` round-trip.
const ORG_SPECIFIC_FILTER_KEYS = ['siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds'] as const;
const NESTED_FILTER_OBJECTS = ['filters', 'legacyFilters'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The config a series may store (spec §3.2 "No org-specific references"; the
 * server answers 400 `series_config_org_specific` otherwise). Also drops
 * `emailRecipients`: a series carries its internal CC as `internalCc`, and
 * W02 writes it into each child's `config.emailRecipients`.
 */
export function stripSeriesConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(config ?? {}) };
  for (const key of ORG_SPECIFIC_TOP_LEVEL_KEYS) delete out[key];
  delete out.emailRecipients;
  for (const nestedKey of NESTED_FILTER_OBJECTS) {
    const nested = out[nestedKey];
    if (!isRecord(nested)) continue;
    const kept = { ...nested };
    for (const key of ORG_SPECIFIC_FILTER_KEYS) delete kept[key];
    if (Object.keys(kept).length === 0) delete out[nestedKey];
    else out[nestedKey] = kept;
  }
  if (Array.isArray(out.filterConditions)) {
    out.filterConditions = out.filterConditions.filter(
      (c) => !(isRecord(c) && typeof c.field === 'string' && ORG_SPECIFIC_CONDITION_FIELDS.has(c.field)),
    );
  }
  return out;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True when the config names at least one site/device/group/org. */
export function configNamesOrgEntities(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  if (ORG_SPECIFIC_TOP_LEVEL_KEYS.some((k) => nonEmptyArray(config[k]) || (k === 'orgId' && typeof config[k] === 'string'))) return true;
  for (const nestedKey of NESTED_FILTER_OBJECTS) {
    const nested = config[nestedKey];
    if (isRecord(nested) && ORG_SPECIFIC_FILTER_KEYS.some((k) => nonEmptyArray(nested[k]))) return true;
  }
  return Array.isArray(config.filterConditions)
    && config.filterConditions.some((c) => isRecord(c) && typeof c.field === 'string' && ORG_SPECIFIC_CONDITION_FIELDS.has(c.field));
}

/** Same loose regex as ReportBuilder's addEmailRecipient and the API's
 *  legacyReportConfigSchema.emailRecipients — never stricter than either. */
const REPORT_RECIPIENT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isReportRecipientEmail(value: string): boolean {
  return REPORT_RECIPIENT_EMAIL.test(value.trim());
}

/** Spec §3.5 rule match: org-level primary contact, or any role overlap. */
export function matchesRecipientRule(
  contact: { isPrimary: boolean; siteId: string | null; roles: string[] },
  rule: SeriesRecipientRule,
): boolean {
  if (rule.primaryContact && contact.isPrimary && contact.siteId === null) return true;
  return rule.roles.some((role) => contact.roles.includes(role));
}

export function sameTargets(a: SeriesTargets, b: SeriesTargets): boolean {
  if (a.targetMode !== b.targetMode || a.orgIds.length !== b.orgIds.length) return false;
  const bs = new Set(b.orgIds);
  return a.orgIds.every((id) => bs.has(id));
}

/** The first org a series covers, in the given (sorted) org order. The
 *  builder's live preview needs one concrete org; a series has none of its own. */
export function firstCoveredOrgId(targets: SeriesTargets, orgs: readonly { id: string }[]): string | null {
  const ids = new Set(targets.orgIds);
  const hit = orgs.find((org) => (targets.targetMode === 'all' ? !ids.has(org.id) : ids.has(org.id)));
  return hit?.id ?? null;
}

export function coversFromSeries(detail: SeriesDetail): CoversValue {
  return {
    mode: 'series',
    targetMode: detail.series.targetMode,
    orgIds: [...detail.targets],
    recipientRule: detail.series.recipientRule,
    internalCc: [...detail.series.internalCc],
  };
}

/** The builder's defaultValues for editing a series (mirrors ReportEditPage's
 *  mapping, plus the schedule detail so a save doesn't reset the time to 09:00). */
export function seriesBuilderDefaults(series: SeriesDefinition): Partial<ReportBuilderFormValues> {
  const config = series.config ?? {};
  const schedule = isRecord(config.schedule) ? config.schedule : {};
  return {
    name: series.name,
    type: series.type,
    schedule: series.schedule,
    format: series.format,
    dateRange: (config.dateRange as ReportBuilderFormValues['dateRange']) ?? { preset: 'last_30_days' },
    filters: (config.filters as ReportBuilderFormValues['filters']) ?? {},
    ...(typeof schedule.time === 'string' ? { scheduleTime: schedule.time } : {}),
    ...(typeof schedule.day === 'string' ? { scheduleDay: schedule.day } : {}),
    ...(typeof schedule.date === 'string' ? { scheduleDate: schedule.date } : {}),
  };
}
```

- [ ] **Step 6: Run the config tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/seriesConfig.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 7: Write the failing client tests**

Create `apps/web/src/components/reports/series/seriesApi.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import {
  createSeries,
  fetchSeriesList,
  fetchSeriesOwnerCandidates,
  previewSeriesRecipients,
  seriesFriendlyError,
  setChildRecipientOverride,
} from './seriesApi';

const json = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(payload) });

describe('seriesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists series cross-org and treats 403 as "not available"', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ data: [{ series: { id: 's-1' }, targets: [], orgs: [] }] }));
    expect(await fetchSeriesList()).toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/reports/series', { skipOrgIdInjection: true });
    fetchWithAuth.mockReturnValueOnce(json({ error: 'forbidden' }, 403));
    expect(await fetchSeriesList()).toBeNull();
  });

  it('creates through runAction with a success toast and returns the detail', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ series: { id: 's-9' }, targets: [], orgs: [] }, 201));
    const detail = await createSeries(
      { name: 'N', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] },
      { errorFallback: 'fail', successMessage: 'ok' },
    );
    expect(detail.series.id).toBe('s-9');
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/reports/series');
    expect(init).toMatchObject({ method: 'POST', skipOrgIdInjection: true });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'ok' }));
  });

  it('maps series error tokens to friendly copy', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ error: 'series_config_org_specific' }, 400));
    await expect(createSeries(
      { name: 'N', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] },
      { errorFallback: 'fail' },
    )).rejects.toMatchObject({ status: 400 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: seriesFriendlyError('series_config_org_specific'),
    }));
    expect(seriesFriendlyError('unrelated_code')).toBeUndefined();
  });

  it('previews without a toast and throws on failure', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ totalCustomerRecipients: 3, orgCount: 2, orgsWithoutCustomerRecipient: [] }));
    const body = { targetMode: 'all' as const, orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: ['ops@msp.example'] };
    expect((await previewSeriesRecipients(body)).totalCustomerRecipients).toBe(3);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/reports/series/recipients/preview', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
    fetchWithAuth.mockReturnValueOnce(json({}, 500));
    await expect(previewSeriesRecipients(body)).rejects.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('switches an add override to remove as DELETE then POST', async () => {
    fetchWithAuth.mockReturnValue(json({}));
    await setChildRecipientOverride('rep-1', 'c-1', 'add', 'remove', { errorFallback: 'fail', successMessage: 'ok' });
    expect(fetchWithAuth.mock.calls.map(([u, i]) => [u, (i as { method?: string }).method])).toEqual([
      ['/reports/rep-1/recipients/c-1', 'DELETE'],
      ['/reports/rep-1/recipients', 'POST'],
    ]);
    expect(JSON.parse((fetchWithAuth.mock.calls[1]![1] as { body: string }).body)).toEqual({ contactId: 'c-1', mode: 'remove' });
  });

  it('returns to the rule with a single DELETE', async () => {
    fetchWithAuth.mockReturnValue(json({}));
    await setChildRecipientOverride('rep-1', 'c-1', 'remove', 'default', { errorFallback: 'fail' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('offers only active users with access to every organization as owners', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ data: [
      { id: 'u-1', name: 'Ada', email: 'ada@x.io', status: 'active', orgAccess: 'all' },
      { id: 'u-2', name: 'Bo', email: 'bo@x.io', status: 'active', orgAccess: 'selected' },
      { id: 'u-3', name: 'Cy', email: 'cy@x.io', status: 'disabled', orgAccess: 'all' },
    ] }));
    expect(await fetchSeriesOwnerCandidates()).toEqual([{ id: 'u-1', name: 'Ada', email: 'ada@x.io' }]);
    fetchWithAuth.mockReturnValueOnce(json({}, 403));
    expect(await fetchSeriesOwnerCandidates()).toBe('forbidden');
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/reports/series/seriesApi.test.ts`
Expected: FAIL. The error is `Failed to resolve import "./seriesApi"`.

- [ ] **Step 9: Implement `seriesApi.ts`**

```ts
import { fetchWithAuth } from '../../../stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import type {
  ChildRecipientOverride,
  OrgContact,
  PartnerUserOption,
  RecipientChoice,
  SeriesCreateBody,
  SeriesDetail,
  SeriesRecipientPreview,
  SeriesRecipientRule,
  SeriesTargets,
  SeriesUpdateBody,
} from './types';

/**
 * The one client for multi-org report series (#<parent> W03). Every mutation
 * is lexically wrapped in runAction — this file is in the no-silent-mutations
 * TARGET_GLOBS. Series are partner-level: every /reports/series request skips
 * the switcher's ambient ?orgId=.
 */
const SERIES_ROOT = '/reports/series';
const CROSS_ORG = { skipOrgIdInjection: true } as const;

export interface ActionMessages { errorFallback: string; successMessage?: string }

// Literal keys (not a template) so keyUsage can resolve each one.
const FRIENDLY_ERROR_KEYS: Readonly<Record<string, string>> = {
  series_type_unsupported: 'reports:reports.series.errors.seriesTypeUnsupported',
  series_config_org_specific: 'reports:reports.series.errors.seriesConfigOrgSpecific',
  series_managed: 'reports:reports.series.errors.seriesManaged',
  series_owner_ineligible: 'reports:reports.series.errors.seriesOwnerIneligible',
  series_not_found: 'reports:reports.series.errors.seriesNotFound',
  // W02 contract concern 4: tokens beyond the INDEX list.
  series_write_denied: 'reports:reports.series.errors.seriesWriteDenied',
  series_target_org_inaccessible: 'reports:reports.series.errors.seriesTargetOrgInaccessible',
  report_not_series_child: 'reports:reports.series.errors.reportNotSeriesChild',
  recipient_mode_requires_series: 'reports:reports.series.errors.recipientModeRequiresSeries',
  recipients_need_export_and_mfa: 'reports:reports.series.errors.recipientsNeedExportAndMfa',
};

export function seriesFriendlyError(code: string): string | undefined {
  const key = FRIENDLY_ERROR_KEYS[code];
  return key ? i18n.t(/* i18n-dynamic */ key) : undefined;
}
const friendly = (code: string) => seriesFriendlyError(code);

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

// ---------- reads ----------

/** null = the caller may not read series (403/404): the list simply has none. */
export async function fetchSeriesList(): Promise<SeriesDetail[] | null> {
  const res = await fetchWithAuth(SERIES_ROOT, CROSS_ORG);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${SERIES_ROOT} answered ${res.status}`);
  const body = (await readJson(res)) as { data?: unknown } | null;
  return Array.isArray(body?.data) ? (body!.data as SeriesDetail[]) : [];
}

/** null = the series does not exist (or is not visible). */
export async function fetchSeriesDetail(id: string): Promise<SeriesDetail | null> {
  const res = await fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, CROSS_ORG);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${SERIES_ROOT}/${id} answered ${res.status}`);
  return (await readJson(res)) as SeriesDetail;
}

export async function previewSeriesRecipients(
  // `internalCc` is W02's optional extension (its contract concern 5).
  body: SeriesTargets & { recipientRule: SeriesRecipientRule; internalCc: string[] },
): Promise<SeriesRecipientPreview> {
  // runaction-exempt: a read over POST (the body is the unsaved form). Failure renders inline under the form; a toast per debounced keystroke would be noise.
  const res = await fetchWithAuth(`${SERIES_ROOT}/recipients/preview`, {
    ...CROSS_ORG,
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`recipient preview answered ${res.status}`);
  return (await readJson(res)) as SeriesRecipientPreview;
}

/** Partner users who could own a series (spec §3.4): active, org_access 'all'.
 *  The server re-checks site scope (400 series_owner_ineligible). */
export async function fetchSeriesOwnerCandidates(): Promise<PartnerUserOption[] | 'forbidden'> {
  const res = await fetchWithAuth('/users', CROSS_ORG);
  if (res.status === 403) return 'forbidden';
  if (!res.ok) throw new Error(`GET /users answered ${res.status}`);
  const body = (await readJson(res)) as { data?: Record<string, unknown>[] } | null;
  return (body?.data ?? [])
    .filter((u) => u.status === 'active' && u.orgAccess === 'all')
    .map((u) => ({ id: String(u.id), name: String(u.name ?? ''), email: String(u.email ?? '') }));
}

/** A child's own org contacts (max page — getPagination caps limit at 100). */
export async function fetchOrgContacts(orgId: string): Promise<OrgContact[]> {
  const res = await fetchWithAuth(`/orgs/organizations/${encodeURIComponent(orgId)}/contacts?limit=100`, { orgIdOverride: orgId });
  if (!res.ok) throw new Error(`contacts answered ${res.status}`);
  const body = (await readJson(res)) as { data?: OrgContact[] } | null;
  return (body?.data ?? []).filter((c) => Boolean(c.email));
}

export async function fetchChildOverrides(reportId: string): Promise<ChildRecipientOverride[]> {
  const res = await fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/recipients`);
  if (!res.ok) throw new Error(`recipients answered ${res.status}`);
  const body = (await readJson(res)) as { data?: { contactId: string; mode?: string }[] } | null;
  return (body?.data ?? []).map((r) => ({ contactId: r.contactId, mode: r.mode === 'remove' ? 'remove' : 'add' }));
}

// ---------- mutations (every one runAction-wrapped) ----------

export function createSeries(body: SeriesCreateBody, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(SERIES_ROOT, { ...CROSS_ORG, method: 'POST', body: JSON.stringify(body) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export function updateSeries(id: string, body: SeriesUpdateBody, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, { ...CROSS_ORG, method: 'PATCH', body: JSON.stringify(body) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export function replaceSeriesTargets(id: string, targets: SeriesTargets, msgs: ActionMessages): Promise<SeriesDetail> {
  return runAction<SeriesDetail>({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}/targets`, { ...CROSS_ORG, method: 'PUT', body: JSON.stringify(targets) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function transferSeriesOwner(id: string, ownerUserId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}/transfer-owner`, { ...CROSS_ORG, method: 'POST', body: JSON.stringify({ ownerUserId }) }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function deleteSeries(id: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${SERIES_ROOT}/${encodeURIComponent(id)}`, { ...CROSS_ORG, method: 'DELETE' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

export async function detachSeriesChild(reportId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/detach`, { method: 'POST' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

/** Run now (this org): the child is an ordinary org report, so the existing generate route. */
export async function generateSeriesChild(reportId: string, msgs: ActionMessages): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/reports/${encodeURIComponent(reportId)}/generate`, { method: 'POST' }),
    errorFallback: msgs.errorFallback,
    successMessage: msgs.successMessage,
    friendly,
  });
}

/**
 * Move one contact between Follow rule / Always send / Never send on a child.
 * The uniqueness key is (report_id, contact_id), so a switch between add and
 * remove deletes the old row first (no reliance on an upsert). A failure after
 * the DELETE leaves the contact on "Follow rule"; the caller reloads.
 */
export async function setChildRecipientOverride(
  reportId: string,
  contactId: string,
  current: RecipientChoice,
  next: RecipientChoice,
  msgs: ActionMessages,
): Promise<void> {
  if (current === next) return;
  const base = `/reports/${encodeURIComponent(reportId)}/recipients`;
  if (current !== 'default') {
    await runAction({
      request: () => fetchWithAuth(`${base}/${encodeURIComponent(contactId)}`, { method: 'DELETE' }),
      errorFallback: msgs.errorFallback,
      successMessage: next === 'default' ? msgs.successMessage : undefined,
      friendly,
    });
  }
  if (next !== 'default') {
    await runAction({
      request: () => fetchWithAuth(base, { method: 'POST', body: JSON.stringify({ contactId, mode: next }) }),
      errorFallback: msgs.errorFallback,
      successMessage: msgs.successMessage,
      friendly,
    });
  }
}
```

- [ ] **Step 10: Add the English copy deck**

In `apps/web/src/locales/en/reports.json`, add this block as the last key inside the top-level `"reports"` object, after `ownerScope`:

```json
    "series": {
      "covers": {
        "legend": "Covers",
        "org": "One organization",
        "orgHint": "A report for one customer, sent to that organization's contacts.",
        "series": "One report per organization",
        "seriesHint": "One definition, with a separate copy for every organization it covers, each sent to that organization's contacts.",
        "combined": "All organizations combined",
        "combinedHint": "One combined report across all your organizations, for your own team.",
        "seriesUnavailableType": "This report type can't be sent as one report per organization."
      },
      "schedule": {
        "label": "How often each organization's copy is sent",
        "placeholder": "Choose a schedule",
        "hint": "A report sent to many organizations runs on a schedule, so it can't be one-time. Choose how often each organization's copy is sent.",
        "required": "Choose how often the report is sent."
      },
      "targeting": {
        "legend": "Which organizations",
        "all": "All organizations",
        "allHint": "Includes every current and future organization. Untick any you want to skip.",
        "selected": "Chosen organizations",
        "selectedHint": "Includes exactly the organizations you tick.",
        "search": "Search organizations",
        "summary": "Covers {{covered}} of {{total}} organizations",
        "noneSelected": "Choose at least one organization.",
        "empty": "No organizations match."
      },
      "recipients": {
        "legend": "Who receives each organization's copy",
        "primaryContact": "The organization's primary contact",
        "roles": "Contacts with these roles",
        "noRuleWarning": "No rule is selected, so an organization receives its copy only when you add contacts on that organization's copy.",
        "internalCc": "Internal copies",
        "internalCcHint": "Every organization's copy is also sent to these addresses on your team.",
        "ccPlaceholder": "name@example.com",
        "ccAdd": "Add",
        "ccInvalid": "Enter a valid email address.",
        "ccRemove": "Remove {{email}}",
        "previewLoading": "Checking recipients…",
        "previewContacts_one": "Resolves to {{count}} contact",
        "previewContacts_other": "Resolves to {{count}} contacts",
        "previewOrgs_one": "across {{count}} organization",
        "previewOrgs_other": "across {{count}} organizations",
        "previewMissing_one": "{{count}} organization has no customer recipient: {{names}}",
        "previewMissing_other": "{{count}} organizations have no customer recipient: {{names}}",
        "previewMore": "and {{count}} more",
        "previewFailed": "Couldn't check recipients. They are still worked out for each organization when its report runs.",
        "previewNoTargets": "Choose organizations to see who receives the report."
      },
      "builder": {
        "filtersDisabled": "Site, device and group filters aren't available here: each organization's copy covers the whole organization.",
        "created": "Created multi-org report “{{name}}”",
        "saved": "Saved multi-org report “{{name}}”",
        "saveFailed": "Couldn't save the multi-org report.",
        "targetsFailed": "The settings were saved, but the organizations covered were not updated. Try saving again."
      },
      "list": {
        "filtersLabel": "Show",
        "filters": {
          "all": "All",
          "multi": "Multi-org",
          "single": "Single-org",
          "combined": "Combined"
        },
        "noMatches": "No reports match this filter.",
        "loadFailed": "Couldn't load multi-org reports. Other reports are shown.",
        "multiOrgBadge": "Multi-org",
        "multiOrgBadgeTitle": "Part of the multi-org report “{{name}}”",
        "expand": "Show organizations",
        "collapse": "Hide organizations",
        "summary": "{{date}} · {{delivered}}/{{total}} delivered",
        "summaryNoRecipient_one": "{{count}} no recipient",
        "summaryNoRecipient_other": "{{count}} no recipients",
        "summaryBlocked_one": "{{count}} blocked",
        "summaryBlocked_other": "{{count}} blocked",
        "summaryNever": "Not run yet",
        "runsSeriesColumn": "Multi-org report",
        "actions": {
          "edit": "Edit multi-org report",
          "transferOwner": "Transfer owner",
          "delete": "Delete multi-org report",
          "pause": "Pause",
          "resume": "Resume"
        },
        "pausedBadge": "Paused",
        "pausedTitle": "Paused: no organization's copy runs until you resume it.",
        "paused": "Paused “{{name}}”",
        "resumed": "Resumed “{{name}}”",
        "pauseFailed": "Couldn't pause or resume the multi-org report.",
        "deleteTitle": "Delete multi-org report?",
        "deleteMessage": "“{{name}}” stops running. Each organization's copy is archived with its run history.",
        "deleteConfirm": "Delete",
        "deleted": "Deleted multi-org report “{{name}}”",
        "deleteFailed": "Couldn't delete the multi-org report."
      },
      "drilldown": {
        "columns": {
          "org": "Organization",
          "state": "State",
          "lastRun": "Last run",
          "delivery": "Delivery",
          "recipients": "Recipients",
          "actions": "Actions"
        },
        "states": {
          "active": "Active",
          "excluded": "Excluded",
          "ineligible": "Not eligible",
          "blocked_no_authority": "Blocked: owner has no access",
          "blocked_no_recipients": "No customer recipient"
        },
        "delivery": {
          "sent": "Sent",
          "not_scheduled": "Not emailed"
        },
        "neverRun": "Not run yet",
        "actions": {
          "runNow": "Run now",
          "editRecipients": "Edit recipients",
          "exclude": "Exclude",
          "include": "Include",
          "detach": "Detach"
        },
        "lastOrgHint": "A multi-org report with chosen organizations needs at least one. Delete it instead.",
        "noAuthorityHint": "The owner can't reach this organization, so its copy doesn't run. Transfer the owner to fix it.",
        "excludeTitle": "Exclude {{org}}?",
        "excludeMessage": "{{org}} stops receiving this report. Its copy is archived with its run history, and including it again restores the same copy.",
        "excludeConfirm": "Exclude",
        "detachTitle": "Detach {{org}}?",
        "detachMessage": "{{org}}'s copy becomes a standalone report you can edit freely. It keeps its run history and stops following this multi-org report.",
        "detachConfirm": "Detach",
        "excluded": "Excluded {{org}}",
        "included": "Included {{org}}",
        "detached": "Detached {{org}}",
        "generated": "Report generated for {{org}}",
        "updateFailed": "Couldn't update the multi-org report.",
        "detachFailed": "Couldn't detach the report.",
        "generateFailed": "Couldn't generate the report."
      },
      "transferOwner": {
        "title": "Transfer owner",
        "description": "Each organization's copy runs with the owner's access. Choose a partner user with access to every organization.",
        "label": "New owner",
        "placeholder": "Choose a user",
        "current": "{{name}} (current owner)",
        "confirm": "Transfer",
        "loadFailed": "Couldn't load users.",
        "forbidden": "You need permission to view users to transfer the owner.",
        "noCandidates": "No other user has access to every organization.",
        "transferred": "Owner transferred to {{name}}",
        "failed": "Couldn't transfer the owner."
      },
      "child": {
        "partOf": "Part of the multi-org report “{{name}}”",
        "partOfUnnamed": "Part of a multi-org report",
        "lockedExplanation": "Shared settings are edited on the multi-org report. Only this organization's recipients can be changed here.",
        "managedByMsp": "Managed by your MSP",
        "managedExplanation": "Your MSP manages this report. You can change who in your organization receives it.",
        "editSeries": "Edit multi-org report",
        "detach": "Detach",
        "archived": "This copy is archived: the organization is no longer covered by the multi-org report.",
        "summary": {
          "type": "Type",
          "schedule": "Schedule",
          "format": "Format"
        },
        "recipients": {
          "title": "Recipients for this organization",
          "description": "Choose who receives this organization's copy, on top of the multi-org report's rule.",
          "default": "Follow rule",
          "add": "Always send",
          "remove": "Never send",
          "byRule": "Included by rule",
          "loadFailed": "Couldn't load recipients.",
          "updated": "Recipients updated",
          "updateFailed": "Couldn't update recipients.",
          "empty": "This organization has no contacts with an email address."
        }
      },
      "editPage": {
        "title": "Edit multi-org report",
        "description": "Changes apply to every organization's copy of “{{name}}”.",
        "breadcrumb": "Reports",
        "back": "Back to Reports",
        "loading": "Loading multi-org report…",
        "notFound": "This multi-org report no longer exists.",
        "loadFailed": "Couldn't load the multi-org report."
      },
      "errors": {
        "seriesTypeUnsupported": "This report type can't be sent as one report per organization.",
        "seriesConfigOrgSpecific": "Remove the site, device and group filters: a multi-org report covers whole organizations.",
        "seriesManaged": "This report belongs to a multi-org report. Edit the multi-org report, or detach this copy first.",
        "seriesOwnerIneligible": "That user can't own a multi-org report: they need access to every organization and every site.",
        "seriesNotFound": "This multi-org report no longer exists.",
        "seriesWriteDenied": "Only partner users with access to every organization can change multi-org reports.",
        "seriesTargetOrgInaccessible": "One of the chosen organizations isn't available to you.",
        "reportNotSeriesChild": "This report is no longer part of a multi-org report.",
        "recipientModeRequiresSeries": "\"Never send\" only applies to a copy of a multi-org report.",
        "recipientsNeedExportAndMfa": "Sending reports to recipients needs the export permission and multi-factor sign-in."
      }
    }
```

- [ ] **Step 11: Run both suites and the key checks**

Run: `cd apps/web && npx vitest run src/components/reports/series/ src/lib/i18n/keyUsage.test.ts`
Expected:
- `seriesConfig.test.ts` and `seriesApi.test.ts` PASS.
- `keyUsage.test.ts` PASS.

`localeParity` is not in this run; it stays red until Task 12, as stated in Global Constraints.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/components/reports/series apps/web/src/locales/en/reports.json
git commit -m "feat(reports): series web types, config helpers and typed client (W03 Task 1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Contact roles module and `SeriesRecipientsSection`

**Files:**
- Create: `apps/web/src/lib/contactRoles.ts`, `apps/web/src/lib/contactRoles.test.ts`
- Modify: `apps/web/src/components/settings/ContactsCard.tsx:22-45` (import instead of declare)
- Create: `apps/web/src/components/reports/series/SeriesRecipientsSection.tsx`, `SeriesRecipientsSection.test.tsx`

**Interfaces:**
- Consumes: `previewSeriesRecipients`, `isReportRecipientEmail` (Task 1).
- Produces:
  - `CONTACT_ROLES`, `ContactRole`, `CONTACT_ROLE_LABEL_KEYS` (settings-namespace keys) from `@/lib/contactRoles`;
  - `SeriesRecipientsValue = { recipientRule: SeriesRecipientRule; internalCc: string[] }`;
  - `SeriesRecipientsSection({ value, onChange, targets })`;
  - `PREVIEW_DEBOUNCE_MS = 400`.
- Testids:
  - `series-recipients`, `series-rule-primary`, `series-rule-role-<role>`, `series-rule-none-warning`;
  - `series-cc-input`, `series-cc-add`, `series-cc-error`, `series-cc-chip-<email>`;
  - `series-recipient-preview` (with `data-state` = `idle | loading | ready | failed`), `series-recipient-preview-missing`.

- [ ] **Step 1: Write the failing contact-roles test**

`apps/web/src/lib/contactRoles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { CONTACT_ROLES, CONTACT_ROLE_LABEL_KEYS } from './contactRoles';

describe('contact roles', () => {
  it('lists the API vocabulary (apps/api/src/services/contacts/types.ts CONTACT_ROLES)', () => {
    expect(CONTACT_ROLES).toEqual(['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal']);
  });
  it('has an English label for every role in the settings namespace', () => {
    for (const role of CONTACT_ROLES) {
      expect(i18n.exists(`settings:${CONTACT_ROLE_LABEL_KEYS[role]}`), role).toBe(true);
    }
  });
});
```

Run: `cd apps/web && npx vitest run src/lib/contactRoles.test.ts`
Expected: FAIL. The error is `Failed to resolve import "./contactRoles"`.

- [ ] **Step 2: Move the constants out of `ContactsCard.tsx`**

Create `apps/web/src/lib/contactRoles.ts`:

```ts
/**
 * The contact role vocabulary. Mirrors CONTACT_ROLES in
 * apps/api/src/services/contacts/types.ts (the API validates it). Shared by the
 * org contacts card and the multi-org report recipient rule.
 */
export const CONTACT_ROLES = [
  'billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

/** Role → label key in the `settings` namespace. Full literal keys, so a
 *  non-camelCase token (`after_hours`) needs no transformation at call sites. */
export const CONTACT_ROLE_LABEL_KEYS: Record<ContactRole, string> = {
  billing: 'contactsCard.roles.billing',
  technical: 'contactsCard.roles.technical',
  escalation: 'contactsCard.roles.escalation',
  admin: 'contactsCard.roles.admin',
  site: 'contactsCard.roles.site',
  after_hours: 'contactsCard.roles.afterHours',
  portal: 'contactsCard.roles.portal',
};

export function isKnownContactRole(role: string): role is ContactRole {
  return (CONTACT_ROLES as readonly string[]).includes(role);
}
```

In `apps/web/src/components/settings/ContactsCard.tsx`:
- delete lines 22–45: the `CONTACT_ROLES` const, the `ContactRole` type, `ROLE_LABEL_KEYS` and `isKnownRole`;
- add the import `import { CONTACT_ROLES, CONTACT_ROLE_LABEL_KEYS as ROLE_LABEL_KEYS, isKnownContactRole as isKnownRole, type ContactRole } from '@/lib/contactRoles';` next to the other imports.

The local names stay, so no call site in the file changes.

- [ ] **Step 3: Run the moved-constant checks**

Run: `cd apps/web && npx vitest run src/lib/contactRoles.test.ts src/components/settings/ContactsCard`
Expected: PASS. This covers the new test and every existing `ContactsCard*` test.

- [ ] **Step 4: Write the failing section test**

`apps/web/src/components/reports/series/SeriesRecipientsSection.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previewSeriesRecipients = vi.fn();
vi.mock('./seriesApi', () => ({ previewSeriesRecipients: (...a: unknown[]) => previewSeriesRecipients(...a) }));

import { PREVIEW_DEBOUNCE_MS, SeriesRecipientsSection, type SeriesRecipientsValue } from './SeriesRecipientsSection';

const base: SeriesRecipientsValue = { recipientRule: { primaryContact: true, roles: [] }, internalCc: [] };
const all = { targetMode: 'all' as const, orgIds: [] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flushDebounce() {
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS); });
}

describe('SeriesRecipientsSection', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it('emits rule changes for the primary contact and a role', () => {
    previewSeriesRecipients.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    render(<SeriesRecipientsSection value={base} onChange={onChange} targets={all} />);
    fireEvent.click(screen.getByTestId('series-rule-primary'));
    expect(onChange).toHaveBeenLastCalledWith({ ...base, recipientRule: { primaryContact: false, roles: [] } });
    fireEvent.click(screen.getByTestId('series-rule-role-billing'));
    expect(onChange).toHaveBeenLastCalledWith({ ...base, recipientRule: { primaryContact: true, roles: ['billing'] } });
  });

  it('previews after the debounce and names the orgs with no customer recipient', async () => {
    previewSeriesRecipients.mockResolvedValue({
      totalCustomerRecipients: 23, orgCount: 17,
      orgsWithoutCustomerRecipient: [{ orgId: 'o-9', orgName: 'Acme Dental' }],
    });
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    expect(previewSeriesRecipients).not.toHaveBeenCalled();
    await flushDebounce();
    expect(previewSeriesRecipients).toHaveBeenCalledWith({ targetMode: 'all', orgIds: [], recipientRule: base.recipientRule, internalCc: [] });
    const preview = screen.getByTestId('series-recipient-preview');
    expect(preview).toHaveAttribute('data-state', 'ready');
    expect(preview).toHaveTextContent('Resolves to 23 contacts across 17 organizations');
    expect(screen.getByTestId('series-recipient-preview-missing')).toHaveTextContent('1 organization has no customer recipient: Acme Dental');
  });

  // Review Focus 2.
  it('keeps the newest preview when an older response lands last', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    previewSeriesRecipients.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    rerender(<SeriesRecipientsSection value={{ ...base, recipientRule: { primaryContact: true, roles: ['billing'] } }} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    await act(async () => { second.resolve({ totalCustomerRecipients: 40, orgCount: 18, orgsWithoutCustomerRecipient: [] }); });
    await act(async () => { first.resolve({ totalCustomerRecipients: 5, orgCount: 18, orgsWithoutCustomerRecipient: [] }); });
    expect(screen.getByTestId('series-recipient-preview')).toHaveTextContent('Resolves to 40 contacts');
  });

  it('does not preview a Chosen-organizations series with nothing chosen', async () => {
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={{ targetMode: 'selected', orgIds: [] }} />);
    await flushDebounce();
    expect(previewSeriesRecipients).not.toHaveBeenCalled();
    expect(screen.getByTestId('series-recipient-preview')).toHaveAttribute('data-state', 'idle');
  });

  it('shows an inline failure without throwing', async () => {
    previewSeriesRecipients.mockRejectedValue(new Error('boom'));
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    expect(screen.getByTestId('series-recipient-preview')).toHaveAttribute('data-state', 'failed');
  });

  it('validates and adds an internal CC, and warns when no rule is selected', () => {
    previewSeriesRecipients.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    render(<SeriesRecipientsSection value={{ recipientRule: { primaryContact: false, roles: [] }, internalCc: [] }} onChange={onChange} targets={all} />);
    expect(screen.getByTestId('series-rule-none-warning')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('series-cc-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('series-cc-add'));
    expect(screen.getByTestId('series-cc-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('series-cc-input'), { target: { value: 'ops@msp.example' } });
    fireEvent.click(screen.getByTestId('series-cc-add'));
    expect(onChange).toHaveBeenCalledWith({ recipientRule: { primaryContact: false, roles: [] }, internalCc: ['ops@msp.example'] });
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesRecipientsSection.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesRecipientsSection"`.

- [ ] **Step 5: Implement `SeriesRecipientsSection.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Mail, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_ROLES, CONTACT_ROLE_LABEL_KEYS } from '@/lib/contactRoles';
import { previewSeriesRecipients } from './seriesApi';
import { isReportRecipientEmail } from './seriesConfig';
import type { SeriesRecipientPreview, SeriesRecipientRule, SeriesTargets } from './types';

export interface SeriesRecipientsValue { recipientRule: SeriesRecipientRule; internalCc: string[] }
export const PREVIEW_DEBOUNCE_MS = 400;
const MISSING_NAMES_SHOWN = 5;

type PreviewState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Series-mode recipients (spec §3.5, §3.7): the rule resolved in each org, the
 * fixed internal CC, and a live preview from POST /reports/series/recipients/
 * preview. Controlled; the host owns the value.
 */
export function SeriesRecipientsSection({
  value,
  onChange,
  targets,
}: {
  value: SeriesRecipientsValue;
  onChange: (next: SeriesRecipientsValue) => void;
  targets: SeriesTargets;
}) {
  const { t } = useTranslation('reports');
  const { t: tSettings } = useTranslation('settings');
  const [ccInput, setCcInput] = useState('');
  const [ccError, setCcError] = useState(false);
  const [preview, setPreview] = useState<SeriesRecipientPreview | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const requestSeq = useRef(0);
  const { recipientRule, internalCc } = value;

  const orgIdsKey = targets.orgIds.join(',');
  const rolesKey = recipientRule.roles.join(',');
  const ccKey = internalCc.join(',');
  const noTargets = targets.targetMode === 'selected' && targets.orgIds.length === 0;

  useEffect(() => {
    // Every run invalidates older in-flight answers, so only the newest form
    // state can ever reach the screen (Review Focus 2).
    const mine = ++requestSeq.current;
    if (noTargets) {
      setPreview(null);
      setPreviewState('idle');
      return;
    }
    setPreviewState('loading');
    const body = { targetMode: targets.targetMode, orgIds: targets.orgIds, recipientRule, internalCc };
    const timer = setTimeout(() => {
      previewSeriesRecipients(body)
        .then((result) => {
          if (mine !== requestSeq.current) return;
          setPreview(result);
          setPreviewState('ready');
        })
        .catch((err: unknown) => {
          if (mine !== requestSeq.current) return;
          console.warn('[SeriesRecipientsSection] recipient preview failed', err);
          setPreview(null);
          setPreviewState('failed');
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Keyed on the joined ids/roles: the arrays are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.targetMode, orgIdsKey, recipientRule.primaryContact, rolesKey, ccKey, noTargets]);

  const setRule = (rule: SeriesRecipientRule) => onChange({ ...value, recipientRule: rule });
  const toggleRole = (role: string) =>
    setRule({
      ...recipientRule,
      roles: recipientRule.roles.includes(role)
        ? recipientRule.roles.filter((r) => r !== role)
        : [...recipientRule.roles, role],
    });

  const addCc = () => {
    const trimmed = ccInput.trim();
    if (!trimmed) return;
    if (!isReportRecipientEmail(trimmed)) {
      setCcError(true);
      return;
    }
    setCcError(false);
    setCcInput('');
    if (!internalCc.includes(trimmed)) onChange({ ...value, internalCc: [...internalCc, trimmed] });
  };

  const missing = preview?.orgsWithoutCustomerRecipient ?? [];
  const shownNames = missing.slice(0, MISSING_NAMES_SHOWN).map((o) => o.orgName).join(', ');
  const moreCount = missing.length - MISSING_NAMES_SHOWN;
  const noRule = !recipientRule.primaryContact && recipientRule.roles.length === 0;

  return (
    <fieldset data-testid="series-recipients" className="space-y-4 rounded-md border p-4">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('reports.series.recipients.legend')}</legend>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="series-rule-primary"
          checked={recipientRule.primaryContact}
          onChange={() => setRule({ ...recipientRule, primaryContact: !recipientRule.primaryContact })}
        />
        {t('reports.series.recipients.primaryContact')}
      </label>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('reports.series.recipients.roles')}</p>
        <div className="flex flex-wrap gap-2">
          {CONTACT_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
              <input
                type="checkbox"
                data-testid={`series-rule-role-${role}`}
                checked={recipientRule.roles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {tSettings(/* i18n-dynamic */ CONTACT_ROLE_LABEL_KEYS[role])}
            </label>
          ))}
        </div>
      </div>

      {noRule && (
        <p data-testid="series-rule-none-warning" role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          {t('reports.series.recipients.noRuleWarning')}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground">{t('reports.series.recipients.internalCc')}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t('reports.series.recipients.internalCcHint')}</p>
        {internalCc.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {internalCc.map((email) => (
              <span key={email} data-testid={`series-cc-chip-${email}`} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                {email}
                <button
                  type="button"
                  aria-label={t('reports.series.recipients.ccRemove', { email })}
                  onClick={() => onChange({ ...value, internalCc: internalCc.filter((e) => e !== email) })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="email"
            data-testid="series-cc-input"
            value={ccInput}
            placeholder={t('reports.series.recipients.ccPlaceholder')}
            onChange={(e) => setCcInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCc();
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <button type="button" data-testid="series-cc-add" onClick={addCc} className="h-9 rounded-md border px-3 text-sm hover:bg-muted">
            {t('reports.series.recipients.ccAdd')}
          </button>
        </div>
        {ccError && <p data-testid="series-cc-error" className="text-xs text-destructive">{t('reports.series.recipients.ccInvalid')}</p>}
      </div>

      <div data-testid="series-recipient-preview" data-state={previewState} aria-live="polite" className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        {previewState === 'idle' && t('reports.series.recipients.previewNoTargets')}
        {previewState === 'loading' && (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('reports.series.recipients.previewLoading')}
          </span>
        )}
        {previewState === 'failed' && t('reports.series.recipients.previewFailed')}
        {previewState === 'ready' && preview && (
          <>
            <span>
              {t('reports.series.recipients.previewContacts', { count: preview.totalCustomerRecipients })}{' '}
              {t('reports.series.recipients.previewOrgs', { count: preview.orgCount })}
            </span>
            {missing.length > 0 && (
              <p data-testid="series-recipient-preview-missing" className="mt-1 flex items-start gap-1 text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {t('reports.series.recipients.previewMissing', { count: missing.length, names: shownNames })}
                  {moreCount > 0 && <> {t('reports.series.recipients.previewMore', { count: moreCount })}</>}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 6: Run the section tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesRecipientsSection.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/contactRoles.ts apps/web/src/lib/contactRoles.test.ts apps/web/src/components/settings/ContactsCard.tsx apps/web/src/components/reports/series/SeriesRecipientsSection.tsx apps/web/src/components/reports/series/SeriesRecipientsSection.test.tsx
git commit -m "feat(reports): series recipient rule, internal CC and debounced preview (W03 Task 2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `SeriesTargetingFields`

**Files:**
- Create: `apps/web/src/components/reports/series/SeriesTargetingFields.tsx`, `SeriesTargetingFields.test.tsx`

**Interfaces:**
- Consumes: `useOrgStore().organizations` (`apps/web/src/stores/orgStore.ts:78`, `Organization.status`); `SeriesTargets` (Task 1).
- Produces:
  - `SeriesTargetingFields({ value, onChange })`;
  - `eligibleOrganizations(orgs): Organization[]`, which returns active or trial orgs sorted by name. This mirrors the reconciler's eligibility in spec §3.3.
  - `coveredOrgCount(targets, eligible): number`.
- Testids:
  - `series-targeting`, `series-target-mode-all`, `series-target-mode-selected`;
  - `series-target-search`, `series-target-org-<orgId>` (checkbox, checked = covered);
  - `series-target-summary`, `series-target-none-selected`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORGS = vi.hoisted(() => [
  { id: 'o-1', partnerId: 'p', name: 'Acme Dental', status: 'active', createdAt: '' },
  { id: 'o-2', partnerId: 'p', name: 'Birch Law', status: 'trial', createdAt: '' },
  { id: 'o-3', partnerId: 'p', name: 'Cedar Ltd', status: 'suspended', createdAt: '' },
]);
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: () => ({ organizations: ORGS, currentOrgId: null }) }));

import { SeriesTargetingFields } from './SeriesTargetingFields';

describe('SeriesTargetingFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only eligible orgs; in All mode unticking adds an exclusion', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: [] }} onChange={onChange} />);
    expect(screen.queryByTestId('series-target-org-o-3')).toBeNull();
    expect(screen.getByTestId('series-target-org-o-1')).toBeChecked();
    expect(screen.getByTestId('series-target-summary')).toHaveTextContent('Covers 2 of 2 organizations');
    fireEvent.click(screen.getByTestId('series-target-org-o-1'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'all', orgIds: ['o-1'] });
  });

  it('in Chosen mode ticking adds an inclusion and nothing chosen is flagged', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'selected', orgIds: [] }} onChange={onChange} />);
    expect(screen.getByTestId('series-target-none-selected')).toBeInTheDocument();
    expect(screen.getByTestId('series-target-org-o-2')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('series-target-org-o-2'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'selected', orgIds: ['o-2'] });
  });

  // Review Focus 3: an exclusion list must never become an inclusion list.
  it('switching the mode clears the org list', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: ['o-2'] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('series-target-mode-selected'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'selected', orgIds: [] });
  });

  it('filters by search and keeps ids it cannot show', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: ['o-3'] }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('series-target-search'), { target: { value: 'birch' } });
    expect(screen.queryByTestId('series-target-org-o-1')).toBeNull();
    fireEvent.click(screen.getByTestId('series-target-org-o-2'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'all', orgIds: ['o-3', 'o-2'] });
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesTargetingFields.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesTargetingFields"`.

- [ ] **Step 2: Implement**

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore, type Organization } from '../../../stores/orgStore';
import type { SeriesTargetMode, SeriesTargets } from './types';

/** Mirrors the reconciler's eligibility (spec §3.3): active or trial. */
export function eligibleOrganizations(orgs: Organization[] | undefined): Organization[] {
  return (orgs ?? [])
    .filter((o) => o.status === 'active' || o.status === 'trial')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function coveredOrgCount(targets: SeriesTargets, eligible: Organization[]): number {
  const ids = new Set(targets.orgIds);
  return targets.targetMode === 'all'
    ? eligible.filter((o) => !ids.has(o.id)).length
    : eligible.filter((o) => ids.has(o.id)).length;
}

/**
 * All orgs (live) + exclusions, or Chosen orgs (spec D2). One checkbox list in
 * both modes, where "ticked" always means "covered"; `orgIds` keeps the stored
 * meaning (exclusions in 'all', inclusions in 'selected'). Ids of orgs not in
 * the eligible list (suspended, not loaded) are preserved untouched.
 */
export function SeriesTargetingFields({
  value,
  onChange,
}: {
  value: SeriesTargets;
  onChange: (next: SeriesTargets) => void;
}) {
  const { t } = useTranslation('reports');
  const { organizations } = useOrgStore();
  const eligible = useMemo(() => eligibleOrganizations(organizations), [organizations]);
  const [query, setQuery] = useState('');
  const ids = new Set(value.orgIds);
  const isCovered = (orgId: string) => (value.targetMode === 'all' ? !ids.has(orgId) : ids.has(orgId));
  const needle = query.trim().toLowerCase();
  const shown = needle ? eligible.filter((o) => o.name.toLowerCase().includes(needle)) : eligible;

  const setMode = (mode: SeriesTargetMode) => {
    if (mode === value.targetMode) return;
    onChange({ targetMode: mode, orgIds: [] });
  };
  const toggle = (orgId: string) =>
    onChange({
      targetMode: value.targetMode,
      orgIds: ids.has(orgId) ? value.orgIds.filter((id) => id !== orgId) : [...value.orgIds, orgId],
    });

  return (
    <fieldset data-testid="series-targeting" className="space-y-3">
      <legend className="text-xs font-medium uppercase text-muted-foreground">{t('reports.series.targeting.legend')}</legend>
      {(['all', 'selected'] as const).map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="series-target-mode"
            className="mt-1"
            data-testid={`series-target-mode-${mode}`}
            checked={value.targetMode === mode}
            onChange={() => setMode(mode)}
          />
          <span>
            <span className="font-medium">{t(/* i18n-dynamic */ `reports.series.targeting.${mode}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `reports.series.targeting.${mode}Hint`)}</span>
          </span>
        </label>
      ))}
      <input
        type="search"
        data-testid="series-target-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('reports.series.targeting.search')}
        aria-label={t('reports.series.targeting.search')}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      />
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
        {shown.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t('reports.series.targeting.empty')}</p>
        ) : (
          shown.map((org) => (
            <label key={org.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/40">
              <input type="checkbox" data-testid={`series-target-org-${org.id}`} checked={isCovered(org.id)} onChange={() => toggle(org.id)} />
              {org.name}
            </label>
          ))
        )}
      </div>
      <p data-testid="series-target-summary" className="text-xs text-muted-foreground">
        {t('reports.series.targeting.summary', { covered: coveredOrgCount(value, eligible), total: eligible.length })}
      </p>
      {value.targetMode === 'selected' && value.orgIds.length === 0 && (
        <p data-testid="series-target-none-selected" role="status" className="text-xs text-destructive">
          {t('reports.series.targeting.noneSelected')}
        </p>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 3: Run the targeting tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesTargetingFields.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/reports/series/SeriesTargetingFields.tsx apps/web/src/components/reports/series/SeriesTargetingFields.test.tsx
git commit -m "feat(reports): series targeting fields (all + exclusions / chosen orgs) (W03 Task 3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `CoversControl`

**Files:**
- Create: `apps/web/src/components/reports/series/CoversControl.tsx`, `CoversControl.test.tsx`

**Interfaces:**
- Consumes:
  - `useDefaultReportOwnerScope` (`../ReportOwnerScopeField`);
  - `availableCoversModes`, `DEFAULT_RECIPIENT_RULE`, `isSeriesEligibleReportType` (Task 1);
  - `isBusinessReportType` (`../businessReportAccess`);
  - `SeriesTargetingFields` (Task 3), `SeriesRecipientsSection` (Task 2).
- Does **not** own the org choice. W01's `useReportTargetOrg` in the host does, and the host passes its `<OrgPickerField>` in through `orgField`. One org source, never two.
- Produces: `CoversControl(props)`, where the props are:
  - `reportType: string | undefined`;
  - `value: CoversValue`;
  - `onChange(next: CoversValue): void`;
  - `orgField?: ReactNode`, rendered in org mode;
  - `lockMode?: boolean`, default false;
  - `withSeriesRecipients?: boolean`, default false;
  - `seriesExtra?: ReactNode`, rendered at the top of the series fields (the template modals pass `SeriesScheduleField`).
- Testids: `covers-control` (with `data-mode`), `covers-mode-org`, `covers-mode-series`, `covers-mode-combined`, `covers-series-unavailable`, `covers-series-extra`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ canChoose: true }));
vi.mock('../ReportOwnerScopeField', () => ({
  useDefaultReportOwnerScope: () => ({ canChoose: gate.canChoose, defaultScope: 'organization', needsOrganization: false }),
}));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null, organizations: [] }) }));
vi.mock('./seriesApi', () => ({ previewSeriesRecipients: () => new Promise(() => {}) }));

import { CoversControl } from './CoversControl';
import type { CoversValue } from './types';

const ORG: CoversValue = { mode: 'org' };
const PICKER = <div data-testid="org-picker-stub" />;
const SERIES: CoversValue = { mode: 'series', targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] };

describe('CoversControl', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.canChoose = true; });

  it('without the partner-wide gate renders only the host org field', () => {
    gate.canChoose = false;
    render(<CoversControl reportType="device_inventory" value={ORG} onChange={vi.fn()} orgField={PICKER} />);
    expect(screen.getByTestId('org-picker-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-series')).toBeNull();
  });

  it('offers series for an eligible type and combined for a business type', () => {
    const { rerender } = render(<CoversControl reportType="device_inventory" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-mode-series')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-combined')).toBeNull();
    rerender(<CoversControl reportType="ar_aging" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-mode-combined')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-series')).toBeNull();
  });

  it('switches to series with the default rule, back to org, and restores the series fields', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CoversControl reportType="device_inventory" value={ORG} onChange={onChange} orgField={PICKER} />);
    fireEvent.click(screen.getByTestId('covers-mode-series'));
    expect(onChange).toHaveBeenLastCalledWith(SERIES);
    const edited = { ...SERIES, targetMode: 'selected', orgIds: ['org-2'] } as CoversValue;
    rerender(<CoversControl reportType="device_inventory" value={edited} onChange={onChange} orgField={PICKER} />);
    expect(screen.queryByTestId('org-picker-stub')).toBeNull();
    fireEvent.click(screen.getByTestId('covers-mode-org'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'org' });
    rerender(<CoversControl reportType="device_inventory" value={ORG} onChange={onChange} orgField={PICKER} />);
    expect(screen.getByTestId('org-picker-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('covers-mode-series'));
    expect(onChange).toHaveBeenLastCalledWith(edited);
  });

  // Review Focus 3.
  it('falls back to org when the type stops being series-eligible', () => {
    const onChange = vi.fn();
    render(<CoversControl reportType="threat_detection_review" value={SERIES} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith({ mode: 'org' });
  });

  it('says when a partner-wide user picked a type that cannot fan out', () => {
    render(<CoversControl reportType="threat_detection_review" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-series-unavailable')).toBeInTheDocument();
  });

  it('locked (series edit) shows no mode choice, only targeting', () => {
    render(<CoversControl reportType="device_inventory" value={SERIES} onChange={vi.fn()} lockMode />);
    expect(screen.queryByTestId('covers-mode-org')).toBeNull();
    expect(screen.getByTestId('series-targeting')).toBeInTheDocument();
    expect(screen.queryByTestId('series-recipients')).toBeNull();
  });

  it('renders the recipients section and the extra slot in series mode only (template modals)', () => {
    const extra = <span data-testid="extra-stub" />;
    const { rerender } = render(<CoversControl reportType="hardware_lifecycle" value={SERIES} onChange={vi.fn()} withSeriesRecipients seriesExtra={extra} />);
    expect(screen.getByTestId('series-recipients')).toBeInTheDocument();
    expect(screen.getByTestId('covers-series-extra')).toContainElement(screen.getByTestId('extra-stub'));
    rerender(<CoversControl reportType="hardware_lifecycle" value={ORG} onChange={vi.fn()} withSeriesRecipients seriesExtra={extra} />);
    expect(screen.queryByTestId('extra-stub')).toBeNull();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/CoversControl.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./CoversControl"`.

- [ ] **Step 2: Implement**

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDefaultReportOwnerScope } from '../ReportOwnerScopeField';
import { isBusinessReportType } from '../businessReportAccess';
import { SeriesRecipientsSection } from './SeriesRecipientsSection';
import { SeriesTargetingFields } from './SeriesTargetingFields';
import { availableCoversModes, DEFAULT_RECIPIENT_RULE, isSeriesEligibleReportType } from './seriesConfig';
import type { CoversMode, CoversValue, SeriesCoversFields } from './types';

const DEFAULT_SERIES_FIELDS: SeriesCoversFields = {
  targetMode: 'all',
  orgIds: [],
  recipientRule: DEFAULT_RECIPIENT_RULE,
  internalCc: [],
};

function seriesFieldsOf(value: CoversValue): SeriesCoversFields | null {
  if (value.mode !== 'series') return null;
  return { targetMode: value.targetMode, orgIds: value.orgIds, recipientRule: value.recipientRule, internalCc: value.internalCc };
}

/**
 * "Covers" — the first field of every create surface (spec §3.7): one org, one
 * report per org (series), or all orgs combined (the partner-owned aggregate).
 * The series and combined choices appear only for users past the partner-wide
 * gate, and only for types that support them (`availableCoversModes`).
 * Controlled. Which org a single-org report targets stays with W01's
 * `useReportTargetOrg` in the host; its picker arrives through `orgField`.
 */
export function CoversControl({
  reportType,
  value,
  onChange,
  orgField,
  lockMode = false,
  withSeriesRecipients = false,
  seriesExtra,
}: {
  reportType: string | undefined;
  value: CoversValue;
  onChange: (next: CoversValue) => void;
  orgField?: ReactNode;
  lockMode?: boolean;
  withSeriesRecipients?: boolean;
  seriesExtra?: ReactNode;
}) {
  const { t } = useTranslation('reports');
  const { canChoose } = useDefaultReportOwnerScope();
  const modes: CoversMode[] = lockMode ? [value.mode] : availableCoversModes(reportType, canChoose);
  const lastSeries = useRef<SeriesCoversFields>(DEFAULT_SERIES_FIELDS);
  const modeAllowed = modes.includes(value.mode);

  // The type (or the gate) changed under a chosen mode: fall back to one org
  // rather than submit a mode the type can't use (Review Focus 3).
  useEffect(() => {
    if (!modeAllowed) onChange({ mode: 'org' });
  }, [modeAllowed, onChange]);

  const select = (mode: CoversMode) => {
    if (mode === value.mode) return;
    const current = seriesFieldsOf(value);
    if (current) lastSeries.current = current;
    if (mode === 'series') onChange({ mode: 'series', ...lastSeries.current });
    else if (mode === 'combined') onChange({ mode: 'combined' });
    else onChange({ mode: 'org' });
  };

  const seriesFields = value.mode === 'series' && (
    <div className="space-y-4">
      {seriesExtra && <div data-testid="covers-series-extra">{seriesExtra}</div>}
      <SeriesTargetingFields
        value={{ targetMode: value.targetMode, orgIds: value.orgIds }}
        onChange={(targets) => onChange({ ...value, ...targets })}
      />
      {withSeriesRecipients && (
        <SeriesRecipientsSection
          value={{ recipientRule: value.recipientRule, internalCc: value.internalCc }}
          onChange={(recipients) => onChange({ ...value, ...recipients })}
          targets={{ targetMode: value.targetMode, orgIds: value.orgIds }}
        />
      )}
    </div>
  );
  const orgSlot = value.mode === 'org' ? orgField : null;
  // Past the gate but this type can't fan out: say so instead of silently
  // offering one org only (business types show Combined instead).
  const seriesUnavailable =
    !lockMode && canChoose && !isBusinessReportType(reportType) && !isSeriesEligibleReportType(reportType);

  if (modes.length === 1) {
    return (
      <div data-testid="covers-control" data-mode={value.mode} className="space-y-3">
        {orgSlot}
        {seriesFields}
        {seriesUnavailable && (
          <p data-testid="covers-series-unavailable" className="text-xs text-muted-foreground">
            {t('reports.series.covers.seriesUnavailableType')}
          </p>
        )}
      </div>
    );
  }

  return (
    <fieldset data-testid="covers-control" data-mode={value.mode} className="space-y-3">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('reports.series.covers.legend')}</legend>
      {modes.map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="report-covers-mode"
            className="mt-1"
            data-testid={`covers-mode-${mode}`}
            checked={value.mode === mode}
            onChange={() => select(mode)}
          />
          <span>
            <span className="font-medium">{t(/* i18n-dynamic */ `reports.series.covers.${mode}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `reports.series.covers.${mode}Hint`)}</span>
          </span>
        </label>
      ))}
      <div className="pl-6">
        {orgSlot}
        {seriesFields}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 3: Run the control tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/CoversControl.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/reports/series/CoversControl.tsx apps/web/src/components/reports/series/CoversControl.test.tsx
git commit -m "feat(reports): Covers control with org / one-per-org / combined modes (W03 Task 4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ReportBuilder` create in series mode

**Files:**
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx`
- Modify: the `vi.mock('../../stores/auth', …)` factory in:
  - `ReportBuilder.test.tsx:11-14`;
  - `ReportBuilder.aiFleetDesign.test.tsx:7-10`;
  - `ReportBuilder.aiNarrative.test.tsx:7-10`;
  - `ReportBuilder.responsiveLayout.test.tsx:28-31`.
- Create: `apps/web/src/components/reports/ReportBuilder.series.test.tsx`

**Interfaces:**
- Consumes:
  - `CoversControl` (Task 4), `SeriesRecipientsSection` (Task 2);
  - `stripSeriesConfig`, `ORG_SPECIFIC_CONDITION_FIELDS`, `coversFromSeries`, `sameTargets`, `firstCoveredOrgId` (Task 1);
  - W01's builder wiring (W01 plan Task 7 Step 4): `orgTarget = useReportTargetOrg(defaultOrgId ?? null)`, `orgPickerApplies`, `targetOrgId`, `orgMissing`, the `<OrgPickerField>` in the Report details card, and the `reports.orgPicker.required` submit guard;
  - `createSeries`, `updateSeries`, `replaceSeriesTargets` (Task 1);
  - `formatReportsListHash` (Task 7). **Order note:** Task 5 needs `formatReportsListHash`. Write `listModel.ts` Steps 1–4 of Task 7 first if executing strictly in order, or have Task 5 build the hash inline as `` `/reports#series/${id}` ``. This plan does the latter to keep the tasks independent, and Task 7's test pins that `formatReportsListHash({ filter: 'all', seriesId })` equals that same string.
- Produces:
  - a new `ReportBuilder` prop, `series?: SeriesDetail`, which Task 6 uses;
  - `covers` state in create mode;
  - testids `report-builder-covers`, `report-builder-name` (on the existing name input), `report-builder-filter-mode-advanced` (on the existing device-filter tab button) and `series-filters-disabled-note`.

- [ ] **Step 1: Give the four existing builder suites a token-less auth store**

In each of the four files, replace the auth mock factory with:

```ts
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  // W03: the builder's Covers control reads the partner-wide gate
  // (useJwtClaims → useAuthStore). No token here, so the gate fails closed and
  // the builder offers one organization only — every existing assertion holds.
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
```

Keep each file's existing `fetchWithAuth: vi.fn()` form. `ReportBuilder.test.tsx` reads it through `vi.mocked(fetchWithAuth)`, so keep that shape.

- [ ] **Step 2: Write the failing series test**

`apps/web/src/components/reports/ReportBuilder.series.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ user: { canManagePartnerWide: true } }),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

// W01's real OrgPickerField / useReportTargetOrg run here: with two orgs and no
// focused org, its picker is visible and its org-required guard is armed.
import ReportBuilder from './ReportBuilder';
import { useOrgStore } from '../../stores/orgStore';

const ok = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });

function calls(url: string, method: string) {
  return fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string } | undefined)?.method === method);
}

describe('ReportBuilder — one report per organization (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: null,
      organizations: [
        { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
        { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
      ],
    });
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/reports/series' && init?.method === 'POST') {
        return ok({ series: { id: 's-new' }, targets: [], orgs: [] }, 201);
      }
      if (url === '/reports/series/recipients/preview') {
        return ok({ totalCustomerRecipients: 2, orgCount: 2, orgsWithoutCustomerRecipient: [] });
      }
      if (url === '/reports' && init?.method === 'POST') return ok({ data: { id: 'rep-1' } }, 201);
      return ok({ data: { rows: [] } });
    });
  });

  it('creates a series: POST /reports/series with org-agnostic config, then opens its drill-down', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" defaultValues={{ filters: { siteIds: ['site-1'] } }} />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.type(screen.getByTestId('report-builder-name'), 'Monthly health');
    await user.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => expect(calls('/reports/series', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls('/reports/series', 'POST')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      name: 'Monthly health',
      type: 'device_inventory',
      targetMode: 'all',
      orgIds: [],
      recipientRule: { primaryContact: true, roles: [] },
      internalCc: [],
    });
    expect(body.config).not.toHaveProperty('emailRecipients');
    expect(body.config).not.toHaveProperty('legacyFilters');
    expect(body).not.toHaveProperty('orgId');
    expect(calls('/reports', 'POST')).toHaveLength(0);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-new'));
  });

  it('puts W01\'s org picker inside the Covers card in org mode, and hides it in series mode', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    const covers = await screen.findByTestId('report-builder-covers');
    expect(within(covers).getByTestId('report-org-picker')).toBeInTheDocument();
    expect(screen.getAllByTestId('report-org-picker')).toHaveLength(1);
    await user.click(screen.getByTestId('covers-mode-series'));
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });

  it('disables site/device/group filtering in series mode and says why', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    expect(screen.getByTestId('series-filters-disabled-note')).toBeInTheDocument();
    expect(screen.getByTestId('report-builder-filter-mode-advanced')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    const field = screen.getByRole('combobox', { name: 'Filter field' });
    expect(within(field).queryByRole('option', { name: 'Site' })).toBeNull();
  });

  it('swaps the contact picker for the series recipients section', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    expect(screen.getByTestId('series-recipients')).toBeInTheDocument();
  });

  it('refuses Chosen organizations with nothing chosen, client-side', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.click(screen.getByTestId('series-target-mode-selected'));
    await user.type(screen.getByTestId('report-builder-name'), 'X');
    await user.click(screen.getByTestId('report-builder-submit'));
    expect(await screen.findByText('Choose at least one organization.', { selector: 'div' })).toBeInTheDocument();
    expect(calls('/reports/series', 'POST')).toHaveLength(0);
  });

  // Review Focus 3.
  it('switching back to one organization posts /reports, never /reports/series', async () => {
    useOrgStore.setState({ currentOrgId: 'o-1' });
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.click(screen.getByTestId('covers-mode-org'));
    await user.type(screen.getByTestId('report-builder-name'), 'Single');
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(calls('/reports', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls('/reports', 'POST')[0]![1] as { body: string }).body);
    expect(body).not.toHaveProperty('targetMode');
    expect(body).not.toHaveProperty('recipientRule');
    expect(body.orgId).toBe('o-1');
    expect(calls('/reports/series', 'POST')).toHaveLength(0);
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/ReportBuilder.series.test.tsx`
Expected: FAIL. The error is `Unable to find an element by: [data-testid="covers-mode-series"]`.

- [ ] **Step 3: Wire `ReportBuilder.tsx`**

**3a. Imports.** Add them after the existing `businessReportConfig` import:

```ts
import { CoversControl } from './series/CoversControl';
import { SeriesRecipientsSection } from './series/SeriesRecipientsSection';
import { ORG_SPECIFIC_CONDITION_FIELDS, coversFromSeries, firstCoveredOrgId, sameTargets, stripSeriesConfig } from './series/seriesConfig';
import { createSeries, replaceSeriesTargets, updateSeries } from './series/seriesApi';
import type { CoversValue, SeriesDetail } from './series/types';
```

**3b. Props.** Add to `ReportBuilderProps`, after `partnerOwned`:

```ts
  /**
   * Edit an existing multi-org report series (W03). The builder renders the
   * Covers control locked to series mode and saves through
   * PATCH /reports/series/:id (+ PUT /targets when the targets changed).
   * Mutually exclusive with `reportId`.
   */
  series?: SeriesDetail;
```

Destructure `series` in the component signature, after `partnerOwned = false,`.

**3c. Covers state, and W01's target-org block.**

Insert the Covers state directly **above** W01's `const orgTarget = useReportTargetOrg(defaultOrgId ?? null);` line (W01 put that line right after `const { currentOrgId } = useOrgStore();`):

```ts
  // Covers (W03): one org / one per org / combined. Create mode, and the locked
  // series edit; ownership is immutable once a report exists. Which org a
  // single-org report targets stays with W01's useReportTargetOrg below.
  const [covers, setCovers] = useState<CoversValue>(() => (series ? coversFromSeries(series) : { mode: 'org' }));
  const seriesMode = covers.mode === 'series';
  const showCovers = mode === 'create' || Boolean(series);
```

Then replace W01's two derived lines:

```ts
  const targetOrgId = orgPickerApplies ? orgTarget.orgId : currentOrgId;
  const orgMissing = orgPickerApplies && orgTarget.missing;
```

with:

```ts
  // W03: a series has no single org. Its live preview reads the first org it
  // covers; its create/edit never sends an orgId (submitSeries returns before
  // the org payload is used). The org-required guard applies to org mode only.
  const targetOrgId =
    covers.mode === 'series'
      ? firstCoveredOrgId(covers, orgTarget.options)
      : orgPickerApplies ? orgTarget.orgId : currentOrgId;
  const orgMissing = orgPickerApplies && covers.mode === 'org' && orgTarget.missing;
```

For every non-series report, `covers.mode` is `'org'`, so both expressions reduce to W01's exactly. The payload line `...(targetOrgId && !partnerOwned ? { orgId: targetOrgId } : {})` and W01's `orgMissing` submit guard need no change.

**3d. Filters in series mode.**

Add this directly after `const fieldDefinitions = fieldDefinitionsByType[builderType];`:

```ts
  // Series mode (spec §3.7): nothing that names one org's sites/devices/groups.
  const conditionFieldDefinitions = seriesMode
    ? fieldDefinitions.filter((field) => !ORG_SPECIFIC_CONDITION_FIELDS.has(field.id))
    : fieldDefinitions;
  useEffect(() => {
    if (seriesMode) setFilterMode('simple');
  }, [seriesMode]);
```

Then make three changes in the filters section:
- In the condition-field `<FilterSelect>` (`label={t('reports.reportBuilder.filterLabels.field')}`), change `{fieldDefinitions.map(field => (` to `{conditionFieldDefinitions.map(field => (`.
- On the second filter-mode button (the one whose `onClick={() => setFilterMode('advanced')}`), add `data-testid="report-builder-filter-mode-advanced"` and `disabled={seriesMode}`, and append `disabled:opacity-50` to its class list.
- Directly under the filters header `<div className="flex items-center justify-between">…</div>`, insert:

```tsx
          {seriesMode && (
            <p data-testid="series-filters-disabled-note" role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('reports.series.builder.filtersDisabled')}
            </p>
          )}
```

**3e. Name input testid.** On `<input id="report-name" …>`, add `data-testid="report-builder-name"`.

**3f. Covers card.** Insert this as the first child of `<div className="min-w-0 space-y-6">`, right after the `{error && (…)}` block:

```tsx
        {showCovers && (
          <div data-testid="report-builder-covers" className="rounded-lg border bg-card p-6 shadow-xs">
            <CoversControl
              reportType={series ? series.series.type : builderToLegacyType[builderType]}
              value={covers}
              onChange={setCovers}
              lockMode={Boolean(series)}
              orgField={
                orgPickerApplies && orgTarget.pickerVisible ? (
                  <OrgPickerField
                    value={orgTarget.pickedOrgId}
                    onChange={(orgId) => {
                      orgTarget.setPickedOrgId(orgId);
                      setError(undefined);
                    }}
                    options={orgTarget.options}
                  />
                ) : null
              }
            />
          </div>
        )}
```

In the Report details card, W01 renders the same picker under `{orgPickerApplies && orgTarget.pickerVisible && (`. Change that condition to `{orgPickerApplies && orgTarget.pickerVisible && !showCovers && (`, so the picker lives in the Covers card on the create page. The ad-hoc and `/reports/builder` modes (no Covers card) keep it where W01 put it. One picker is rendered, never two (pinned by the "puts W01's org picker inside the Covers card" test).

**3g. Recipients swap.**

The delivery section holds one block with the Mail icon and `emailDistributionList`, followed by `<div className="space-y-3">{contactRecipientsRefused ? (…`. Wrap that whole inner `<div className="space-y-3">…</div>`, up to and including the email add input and `emailError` line, as follows:

```tsx
              {seriesMode && covers.mode === 'series' ? (
                <SeriesRecipientsSection
                  value={{ recipientRule: covers.recipientRule, internalCc: covers.internalCc }}
                  onChange={(recipients) => setCovers({ ...covers, ...recipients })}
                  targets={{ targetMode: covers.targetMode, orgIds: covers.orgIds }}
                />
              ) : (
                <div className="space-y-3">
                  {/* …the existing contacts / email list block, unchanged… */}
                </div>
              )}
```

The comment above stands in for the existing JSX, which moves inside the `else` branch byte-for-byte.

**3h. Series submit.** Add this function after `buildFormValues`:

```ts
  type SeriesSubmitPayload = {
    name: string;
    type: string;
    schedule: ReportSchedule;
    format: ReportFormat;
    config: Record<string, unknown>;
  };

  /** Create or edit a series. Owns its navigation: a saved series lands on its
   *  drill-down (`/reports#series/<id>`), not on the host's onSubmit. */
  const submitSeries = async (payload: SeriesSubmitPayload) => {
    if (covers.mode !== 'series') return;
    if (covers.targetMode === 'selected' && covers.orgIds.length === 0) {
      setError(t('reports.series.targeting.noneSelected'));
      return;
    }
    // Recurring-only. The builder's schedule select never offers one_time, so
    // this only narrows the type; it is never a silent substitution.
    if (payload.schedule === 'one_time') {
      setError(t('reports.series.schedule.required'));
      return;
    }
    const config = stripSeriesConfig(payload.config);
    const targets = { targetMode: covers.targetMode, orgIds: covers.orgIds };
    setSaving(true);
    try {
      if (series) {
        const id = series.series.id;
        await updateSeries(
          id,
          { name: payload.name, format: payload.format, schedule: payload.schedule, config, recipientRule: covers.recipientRule, internalCc: covers.internalCc },
          { errorFallback: t('reports.series.builder.saveFailed'), successMessage: t('reports.series.builder.saved', { name: payload.name }) },
        );
        // Only when changed: PUT /targets bumps the revision and reconciles.
        // A failure here throws past the navigation (Review Focus 4).
        if (!sameTargets(targets, { targetMode: series.series.targetMode, orgIds: series.targets })) {
          await replaceSeriesTargets(id, targets, { errorFallback: t('reports.series.builder.targetsFailed') });
        }
        void navigateTo(`/reports#series/${id}`);
        return;
      }
      const created = await createSeries(
        { name: payload.name, type: payload.type, format: payload.format, schedule: payload.schedule, config, ...targets, recipientRule: covers.recipientRule, internalCc: covers.internalCc },
        { errorFallback: t('reports.series.builder.saveFailed'), successMessage: t('reports.series.builder.created', { name: payload.name }) },
      );
      const id = created?.series?.id;
      void navigateTo(id ? `/reports#series/${id}` : '/reports');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : t('reports.series.builder.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };
```

**3i. Branch in `handleFormSubmit`.** Immediately after `const payload = { … };`, before `setSaving(true);`, insert:

```ts
    if (covers.mode === 'series') {
      await submitSeries(payload);
      return;
    }
```

W01's `orgMissing` guard runs earlier in `handleFormSubmit`. It is false in series mode (3c), so it never blocks a series save.

- [ ] **Step 4: Run the new and existing builder suites**

Run: `cd apps/web && npx vitest run src/components/reports/ReportBuilder src/components/reports/OrgPickerField.test.tsx src/components/reports/reportTypeSurvivesBuilder.test.ts`
Expected: PASS. That is `ReportBuilder.series.test.tsx` (6 tests) plus every existing `ReportBuilder.*` suite and W01's `OrgPickerField.test.tsx`, unchanged apart from the Step 1 mock edit.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reports/ReportBuilder.tsx apps/web/src/components/reports/ReportBuilder*.test.tsx
git commit -m "feat(reports): builder Covers control and one-report-per-org create (W03 Task 5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Series edit page

**Files:**
- Create: `apps/web/src/components/reports/series/SeriesEditPage.tsx`, `SeriesEditPage.test.tsx`
- Create: `apps/web/src/pages/reports/series/[id].astro`
- Modify: `apps/web/src/locales/en/pages.json` (`titles.reportsSeriesEdit`)

**Interfaces:**
- Consumes:
  - `ReportBuilder`'s `series` prop (Task 5);
  - `fetchSeriesDetail`, `seriesBuilderDefaults` (Task 1);
  - `PostureBackupRequiredField` (`../PostureReportOptionsForm`);
  - `HardwareLifecycleOptionsFields`, `hardwareLifecycleOptionsFromConfig`, `DEFAULT_HARDWARE_LIFECYCLE_OPTIONS` (`../HardwareLifecycleOptionsForm`).
- Produces:
  - the route `/reports/series/<id>`, which Tasks 7, 9 and 10 link to;
  - testids `series-edit-page`, `series-edit-not-found`, `series-edit-error`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ user: { canManagePartnerWide: true } }),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } }),
}));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

import SeriesEditPage from './SeriesEditPage';
import { useOrgStore } from '../../../stores/orgStore';

const DETAIL = {
  series: {
    id: 's-1', name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly',
    config: { schedule: { time: '07:30', day: 'monday', date: '1' } }, targetMode: 'all',
    recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 3, enabled: true,
    ownerUserId: 'u-1', createdAt: '', updatedAt: '',
  },
  targets: [],
  orgs: [],
};
const res = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(payload) });
const callsTo = (url: string, method: string) =>
  fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string } | undefined)?.method === method);

function routes(overrides: Record<string, () => Promise<unknown>> = {}) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (overrides[key]) return overrides[key]!();
    if (key === 'GET /reports/series/s-1') return res(DETAIL);
    if (key === 'PATCH /reports/series/s-1') return res(DETAIL);
    if (key === 'PUT /reports/series/s-1/targets') return res(DETAIL);
    if (url === '/reports/series/recipients/preview') return res({ totalCustomerRecipients: 0, orgCount: 0, orgsWithoutCustomerRecipient: [] });
    return res({ data: { rows: [] } });
  });
}

describe('SeriesEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: null,
      organizations: [
        { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
        { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
      ],
    });
  });

  it('saves shared fields with PATCH only when the targets did not change', async () => {
    routes();
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    expect(await screen.findByDisplayValue('Monthly health')).toBeInTheDocument();
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(callsTo('/reports/series/s-1', 'PATCH')).toHaveLength(1));
    const body = JSON.parse((callsTo('/reports/series/s-1', 'PATCH')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ name: 'Monthly health', format: 'pdf', schedule: 'monthly' });
    expect(body).not.toHaveProperty('type');
    expect(body.config.schedule).toMatchObject({ time: '07:30' });
    expect(callsTo('/reports/series/s-1/targets', 'PUT')).toHaveLength(0);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-1'));
  });

  it('replaces the targets after the PATCH when an org is excluded', async () => {
    routes();
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    await user.click(await screen.findByTestId('series-target-org-o-2'));
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(callsTo('/reports/series/s-1/targets', 'PUT')).toHaveLength(1));
    expect(JSON.parse((callsTo('/reports/series/s-1/targets', 'PUT')[0]![1] as { body: string }).body))
      .toEqual({ targetMode: 'all', orgIds: ['o-2'] });
  });

  // Review Focus 4.
  it('stays on the page when the targets update fails after the settings saved', async () => {
    routes({ 'PUT /reports/series/s-1/targets': () => res({ error: 'boom' }, 500) });
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    await user.click(await screen.findByTestId('series-target-org-o-2'));
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('report-builder-submit')).not.toBeDisabled();
  });

  it('shows not-found for a deleted series', async () => {
    routes({ 'GET /reports/series/s-1': () => res({ error: 'series_not_found' }, 404) });
    render(<SeriesEditPage seriesId="s-1" />);
    expect(await screen.findByTestId('series-edit-not-found')).toBeInTheDocument();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesEditPage.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesEditPage"`.

- [ ] **Step 2: Implement `SeriesEditPage.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// Islands hydrate independently; initialise i18n here (as ReportEditPage does).
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../../layout/Breadcrumbs';
import { usePageItemName } from '../../layout/usePageItemName';
import ReportBuilder from '../ReportBuilder';
import { PostureBackupRequiredField } from '../PostureReportOptionsForm';
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsFields,
  hardwareLifecycleOptionsFromConfig,
  type HardwareLifecycleOptions,
} from '../HardwareLifecycleOptionsForm';
import { fetchSeriesDetail } from './seriesApi';
import { seriesBuilderDefaults } from './seriesConfig';
import type { SeriesDetail } from './types';

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

/** /reports/series/:id — edit a multi-org report's shared definition. */
export default function SeriesEditPage({ seriesId }: { seriesId: string }) {
  const { t } = useTranslation('reports');
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [backupRequired, setBackupRequired] = useState(true);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);

  useEffect(() => {
    let live = true;
    setState('loading');
    fetchSeriesDetail(seriesId)
      .then((loaded) => {
        if (!live) return;
        if (!loaded) {
          setState('not_found');
          return;
        }
        const config = loaded.series.config ?? {};
        setBackupRequired(config.backupRequired !== false);
        setLifecycleOptions(hardwareLifecycleOptionsFromConfig(config));
        setDetail(loaded);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (!live) return;
        console.error('[SeriesEditPage] load failed', err);
        setState('error');
      });
    return () => {
      live = false;
    };
  }, [seriesId]);

  usePageItemName(detail?.series.name);
  const defaultValues = useMemo(() => (detail ? seriesBuilderDefaults(detail.series) : undefined), [detail]);

  const back = (
    <a href="/reports" className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted" aria-label={t('reports.series.editPage.back')}>
      <ArrowLeft className="h-4 w-4" />
    </a>
  );

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-3 text-sm text-muted-foreground">{t('reports.series.editPage.loading')}</p>
      </div>
    );
  }
  if (state !== 'ready' || !detail) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">{back}<h1 className="text-xl font-semibold tracking-tight">{t('reports.series.editPage.title')}</h1></div>
        <p
          data-testid={state === 'not_found' ? 'series-edit-not-found' : 'series-edit-error'}
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
        >
          {state === 'not_found' ? t('reports.series.editPage.notFound') : t('reports.series.editPage.loadFailed')}
        </p>
      </div>
    );
  }

  const { series } = detail;
  const config = series.config ?? {};
  // Same fold as ReportEditPage's curatedConfig for the two curated types a
  // series can carry; every other type passes its config through.
  const baseConfig =
    series.type === 'security_compliance_posture'
      ? { ...config, backupRequired }
      : series.type === 'hardware_lifecycle'
        ? { ...config, ...lifecycleOptions }
        : config;

  return (
    <div data-testid="series-edit-page" className="space-y-6">
      <Breadcrumbs items={[{ label: t('reports.series.editPage.breadcrumb'), href: '/reports' }, { label: series.name }]} />
      <div className="flex items-center gap-4">
        {back}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.series.editPage.title')}</h1>
          <p className="text-muted-foreground">{t('reports.series.editPage.description', { name: series.name })}</p>
        </div>
      </div>
      {series.type === 'security_compliance_posture' && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <PostureBackupRequiredField backupRequired={backupRequired} onBackupRequiredChange={setBackupRequired} />
        </div>
      )}
      {series.type === 'hardware_lifecycle' && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <HardwareLifecycleOptionsFields value={lifecycleOptions} onChange={setLifecycleOptions} />
        </div>
      )}
      <ReportBuilder
        mode="edit"
        series={detail}
        defaultValues={defaultValues}
        baseConfig={baseConfig}
        onCancel={() => void navigateTo('/reports')}
      />
    </div>
  );
}
```

- [ ] **Step 3: Add the route and its title**

Create `apps/web/src/pages/reports/series/[id].astro`:

```astro
---
import DashboardLayout from '../../../layouts/DashboardLayout.astro';
import SeriesEditPage from '../../../components/reports/series/SeriesEditPage';

const { id } = Astro.params;

if (!id) {
  return Astro.redirect('/reports');
}
---

<DashboardLayout titleKey="titles.reportsSeriesEdit">
  <SeriesEditPage client:load seriesId={id} />
</DashboardLayout>
```

In `apps/web/src/locales/en/pages.json`, add `"reportsSeriesEdit": "Edit Multi-org Report",` under `titles`, directly after `"reportsNew"`. `/reports/series/*` is already covered by `routeScope.ts:150` (`/^\/reports(\/.*)?$/`, org-or-all), so nothing else changes.

- [ ] **Step 4: Run the edit-page and title checks**

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesEditPage.test.tsx src/lib/i18n/titleKeyUsage.test.ts`
Expected: PASS (4 tests + titleKeyUsage).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reports/series/SeriesEditPage.tsx apps/web/src/components/reports/series/SeriesEditPage.test.tsx "apps/web/src/pages/reports/series/[id].astro" apps/web/src/locales/en/pages.json
git commit -m "feat(reports): edit a multi-org report (PATCH + PUT targets) (W03 Task 6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Grouped Saved Reports list, filter chips, hash state, child badge, runs Series column

**Files:**
- Create: `apps/web/src/components/reports/series/listModel.ts`, `listModel.test.ts`
- Create: `apps/web/src/components/reports/series/ReportsFilterChips.tsx`
- Create: `apps/web/src/components/reports/series/SeriesListRow.tsx` (row and toggle here; Task 9 adds the row actions)
- Modify: `apps/web/src/components/reports/ReportsList.tsx`
- Modify: `apps/web/src/components/reports/ReportsList.scope.test.tsx` and W01's `ReportsList.covers.test.tsx` (list URL matcher; see Step 8)
- Create: `apps/web/src/components/reports/ReportsList.series.test.tsx`

**Interfaces:**
- Consumes:
  - `fetchSeriesList` (Task 1), `SeriesDrilldown` (Task 8, rendered when expanded);
  - `useHashState` (`apps/web/src/lib/useHashState.ts:52`);
  - `CoversCell` (W01), `formatDate` (`apps/web/src/lib/dateTimeFormat.ts:132`).
- Produces:
  - list model types: `ReportsListFilter`, `REPORTS_LIST_FILTERS`, `ReportsListEntry`, `ReportsListView`, `DEFAULT_REPORTS_LIST_VIEW`;
  - list model functions: `buildListEntries`, `filterListEntries`, `entryCoverKind`, `parseReportsListHash`, `formatReportsListHash`;
  - series helpers: `summarizeSeriesDelivery`, `seriesCoveredOrgCount`, `targetsAfterExclude`, `targetsAfterInclude`, `canExcludeOrg`;
  - `SAVED_REPORTS_COLUMN_COUNT`;
  - new optional fields: `Report.seriesId`, `Report.seriesName` and `Report.archivedAt` on the report type, and `ReportRun.seriesId` and `ReportRun.seriesName` on the run type.
- Testids:
  - `reports-filter-chips`, `reports-filter-<all|multi|single|combined>`, `reports-filter-no-matches`;
  - `reports-series-load-failed`;
  - `report-series-row-<seriesId>`, `report-series-toggle-<seriesId>`, `report-series-summary-<seriesId>`, `series-drilldown-<seriesId>`;
  - `report-series-badge-<reportId>`, `report-run-series-<runId>`.

- [ ] **Step 1: Write the failing list-model test**

```ts
import { describe, expect, it } from 'vitest';
import type { Report } from '../ReportsList';
import type { SeriesDetail, SeriesOrgStatus } from './types';
import {
  buildListEntries,
  canExcludeOrg,
  filterListEntries,
  formatReportsListHash,
  parseReportsListHash,
  seriesCoveredOrgCount,
  summarizeSeriesDelivery,
  targetsAfterExclude,
  targetsAfterInclude,
} from './listModel';

const SID = '6f1c1b1e-3b8a-4c52-9a47-0c1d2e3f4a5b';
const rep = (over: Partial<Report>): Report => ({
  id: 'r', name: 'n', type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {},
  orgId: 'o-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '', ...over,
});
const org = (over: Partial<SeriesOrgStatus>): SeriesOrgStatus => ({
  orgId: 'o', orgName: 'O', state: 'active', childReportId: 'c', lastRun: null, ...over,
});
const detail = (over: Partial<SeriesDetail> = {}): SeriesDetail => ({
  series: { id: SID, targetMode: 'all' } as SeriesDetail['series'], targets: [], orgs: [], ...over,
});

describe('hash grammar', () => {
  it('round-trips every view', () => {
    for (const view of [
      { filter: 'all', seriesId: null },
      { filter: 'multi', seriesId: null },
      { filter: 'combined', seriesId: SID },
      { filter: 'all', seriesId: SID },
    ] as const) {
      expect(parseReportsListHash(formatReportsListHash(view))).toEqual(view);
    }
  });
  it('matches the builder\'s post-save redirect', () => {
    expect(formatReportsListHash({ filter: 'all', seriesId: SID })).toBe(`series/${SID}`);
  });
  it('ignores hashes it does not own', () => {
    expect(parseReportsListHash('')).toBeUndefined();
    expect(parseReportsListHash('runs')).toBeUndefined();
    expect(parseReportsListHash('series/not-a-uuid')).toBeUndefined();
  });
});

describe('entries and filters', () => {
  const partnerOwned = rep({ id: 'p', orgId: null, partnerId: 'p-1' });
  const single = rep({ id: 's' });
  const child = rep({ id: 'c', seriesId: SID, seriesName: 'Monthly' });
  it('grouped: series first, children folded into their series', () => {
    const entries = buildListEntries([single, child, partnerOwned], [detail()], true);
    expect(entries.map((e) => (e.kind === 'series' ? `series:${e.detail.series.id}` : e.report.id))).toEqual([`series:${SID}`, 's', 'p']);
  });
  it('org view: children are ordinary rows', () => {
    expect(buildListEntries([single, child], [], false).map((e) => e.kind)).toEqual(['report', 'report']);
  });
  it('filters by what each entry covers', () => {
    const grouped = buildListEntries([single, partnerOwned], [detail()], true);
    expect(filterListEntries(grouped, 'multi').map((e) => e.kind)).toEqual(['series']);
    expect(filterListEntries(grouped, 'single')).toHaveLength(1);
    expect(filterListEntries(grouped, 'combined')).toHaveLength(1);
    const orgView = buildListEntries([single, child], [], false);
    expect(filterListEntries(orgView, 'multi').map((e) => e.kind === 'report' && e.report.id)).toEqual(['c']);
  });
});

describe('delivery summary', () => {
  it('reads "17/18 delivered · 1 no recipient"', () => {
    const orgs = [
      ...Array.from({ length: 17 }, (_, i) => org({ orgId: `o${i}`, lastRun: { status: 'completed', deliveryStatus: 'sent', recipientCount: 1, completedAt: '2026-10-01T09:00:00Z' } })),
      org({ orgId: 'o17', state: 'blocked_no_recipients', lastRun: { status: 'completed', deliveryStatus: 'no_recipients', recipientCount: 0, completedAt: '2026-10-01T09:05:00Z' } }),
      org({ orgId: 'x', state: 'excluded' }),
    ];
    expect(summarizeSeriesDelivery(orgs)).toEqual({ lastRunAt: '2026-10-01T09:05:00Z', delivered: 17, total: 18, noRecipient: 1, blocked: 0 });
    expect(seriesCoveredOrgCount(detail({ orgs }))).toBe(18);
  });
  it('has no date before any run', () => {
    expect(summarizeSeriesDelivery([org({})]).lastRunAt).toBeNull();
  });
});

describe('target edits', () => {
  it('excludes and includes per mode', () => {
    const all = detail({ targets: ['o-9'] });
    expect(targetsAfterExclude(all, 'o-1')).toEqual({ targetMode: 'all', orgIds: ['o-9', 'o-1'] });
    expect(targetsAfterInclude(all, 'o-9')).toEqual({ targetMode: 'all', orgIds: [] });
    const chosen = detail({ series: { id: SID, targetMode: 'selected' } as SeriesDetail['series'], targets: ['o-1', 'o-2'] });
    expect(targetsAfterExclude(chosen, 'o-1')).toEqual({ targetMode: 'selected', orgIds: ['o-2'] });
    expect(targetsAfterInclude(chosen, 'o-3')).toEqual({ targetMode: 'selected', orgIds: ['o-1', 'o-2', 'o-3'] });
  });
  // Review Focus 1.
  it('never lets a Chosen-organizations series drop its last org', () => {
    const one = detail({ series: { id: SID, targetMode: 'selected' } as SeriesDetail['series'], targets: ['o-1'] });
    expect(canExcludeOrg(one, 'o-1')).toBe(false);
    expect(canExcludeOrg(detail(), 'o-1')).toBe(true);
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/listModel.test.ts`
Expected: FAIL. The error is `Failed to resolve import "./listModel"`.

- [ ] **Step 2: Implement `listModel.ts`**

```ts
import type { Report } from '../ReportsList';
import type { SeriesDetail, SeriesOrgStatus, SeriesTargets } from './types';

/** Name | Covers | Type | Schedule | Format | Last generated | Actions (W01's table). */
export const SAVED_REPORTS_COLUMN_COUNT = 7;

export type ReportsListFilter = 'all' | 'multi' | 'single' | 'combined';
export const REPORTS_LIST_FILTERS: readonly ReportsListFilter[] = ['all', 'multi', 'single', 'combined'];

export type ReportsListEntry =
  | { kind: 'report'; report: Report }
  | { kind: 'series'; detail: SeriesDetail };

export interface ReportsListView { filter: ReportsListFilter; seriesId: string | null }
export const DEFAULT_REPORTS_LIST_VIEW: ReportsListView = { filter: 'all', seriesId: null };

/** What an entry covers, for the filter chips. A child row is "multi". */
export function entryCoverKind(entry: ReportsListEntry): Exclude<ReportsListFilter, 'all'> {
  if (entry.kind === 'series') return 'multi';
  const { report } = entry;
  if (report.seriesId) return 'multi';
  if (!report.orgId && report.partnerId) return 'combined';
  return 'single';
}

/**
 * Grouped (All organizations, partner-wide user): one entry per series, then
 * the standalone rows (children never appear twice). Org view: the list API's
 * rows as-is — children are ordinary rows with a Multi-org badge (spec §3.7).
 */
export function buildListEntries(reports: Report[], series: SeriesDetail[], grouped: boolean): ReportsListEntry[] {
  const reportEntries: ReportsListEntry[] = reports
    .filter((report) => !(grouped && report.seriesId))
    .map((report) => ({ kind: 'report', report }));
  if (!grouped) return reportEntries;
  return [...series.map((detail): ReportsListEntry => ({ kind: 'series', detail })), ...reportEntries];
}

export function filterListEntries(entries: ReportsListEntry[], filter: ReportsListFilter): ReportsListEntry[] {
  return filter === 'all' ? entries : entries.filter((entry) => entryCoverKind(entry) === filter);
}

// ---- hash: '' | <filter> | series/<uuid> | <filter>/series/<uuid> ----
const FILTER_TO_HASH: Record<ReportsListFilter, string> = { all: '', multi: 'multi-org', single: 'single-org', combined: 'combined' };
const HASH_TO_FILTER: Record<string, ReportsListFilter> = { 'multi-org': 'multi', 'single-org': 'single', combined: 'combined' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatReportsListHash(view: ReportsListView): string {
  const parts = [FILTER_TO_HASH[view.filter], view.seriesId ? `series/${view.seriesId}` : ''].filter(Boolean);
  return parts.join('/');
}

export function parseReportsListHash(hash: string): ReportsListView | undefined {
  if (!hash) return undefined;
  const segments = hash.split('/');
  let filter: ReportsListFilter = 'all';
  if (HASH_TO_FILTER[segments[0]!]) filter = HASH_TO_FILTER[segments.shift()!]!;
  if (segments.length === 0) return { filter, seriesId: null };
  if (segments.length === 2 && segments[0] === 'series' && UUID.test(segments[1]!)) {
    return { filter, seriesId: segments[1]! };
  }
  return undefined;
}

// ---- delivery summary (spec §3.7 "Oct 1 · 17/18 delivered · 1 no recipient ⚠") ----
const COVERED_STATES = new Set<SeriesOrgStatus['state']>(['active', 'blocked_no_authority', 'blocked_no_recipients']);

export interface SeriesDeliverySummary {
  lastRunAt: string | null;
  delivered: number;
  total: number;
  noRecipient: number;
  blocked: number;
}

/** "Delivered" counts `sent` only — a partial send is not reported as delivered. */
export function summarizeSeriesDelivery(orgs: SeriesOrgStatus[]): SeriesDeliverySummary {
  const covered = orgs.filter((o) => COVERED_STATES.has(o.state));
  let lastRunAt: string | null = null;
  for (const o of covered) {
    const at = o.lastRun?.completedAt ?? null;
    if (at && (!lastRunAt || at > lastRunAt)) lastRunAt = at;
  }
  return {
    lastRunAt,
    delivered: covered.filter((o) => o.lastRun?.deliveryStatus === 'sent').length,
    total: covered.length,
    noRecipient: covered.filter((o) => o.state === 'blocked_no_recipients' || o.lastRun?.deliveryStatus === 'no_recipients').length,
    blocked: covered.filter((o) => o.state === 'blocked_no_authority').length,
  };
}

export function seriesCoveredOrgCount(detail: SeriesDetail): number {
  return detail.orgs.filter((o) => COVERED_STATES.has(o.state)).length;
}

// ---- per-org target edits (drill-down Exclude / Include) ----
export function targetsAfterExclude(detail: SeriesDetail, orgId: string): SeriesTargets {
  const { targetMode } = detail.series;
  return targetMode === 'all'
    ? { targetMode, orgIds: detail.targets.includes(orgId) ? detail.targets : [...detail.targets, orgId] }
    : { targetMode, orgIds: detail.targets.filter((id) => id !== orgId) };
}

export function targetsAfterInclude(detail: SeriesDetail, orgId: string): SeriesTargets {
  const { targetMode } = detail.series;
  return targetMode === 'all'
    ? { targetMode, orgIds: detail.targets.filter((id) => id !== orgId) }
    : { targetMode, orgIds: detail.targets.includes(orgId) ? detail.targets : [...detail.targets, orgId] };
}

/** A Chosen-organizations series keeps at least one org (Review Focus 1). */
export function canExcludeOrg(detail: SeriesDetail, orgId: string): boolean {
  return detail.series.targetMode === 'all' || detail.targets.some((id) => id !== orgId);
}
```

Run: `cd apps/web && npx vitest run src/components/reports/series/listModel.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 3: Confirm W01's series kind of `CoversCell`**

Run: `grep -n "series?.seriesId\|seriesAll\|seriesSelected" apps/web/src/components/reports/CoversCell.tsx`

Expected: the `series` branch and both label keys (`reports.reportsList.covers.seriesAll`, `…seriesSelected_one/_other`), which W01 ships (W01 plan Task 6 Step 5). The series kind renders when `series.seriesId` is set, so `SeriesListRow` (Step 5) passes `orgId={null}` plus a `series` summary. There is no W03 edit to `CoversCell`.

- [ ] **Step 4: Write `ReportsFilterChips.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { REPORTS_LIST_FILTERS, type ReportsListFilter } from './listModel';

/** All · Multi-org · Single-org · Combined (spec §3.7). Combines with the org switcher. */
export function ReportsFilterChips({ value, onChange }: { value: ReportsListFilter; onChange: (next: ReportsListFilter) => void }) {
  const { t } = useTranslation('reports');
  return (
    <div role="group" aria-label={t('reports.series.list.filtersLabel')} data-testid="reports-filter-chips" className="flex flex-wrap gap-2">
      {REPORTS_LIST_FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          data-testid={`reports-filter-${filter}`}
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition',
            value === filter ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
          )}
        >
          {t(/* i18n-dynamic */ `reports.series.list.filters.${filter}`)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Write `SeriesListRow.tsx` (row + toggle + drill-down slot)**

```tsx
import { AlertTriangle, ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dateTimeFormat';
import { CoversCell } from '../CoversCell';
import { SeriesDrilldown } from './SeriesDrilldown';
import { SAVED_REPORTS_COLUMN_COUNT, seriesCoveredOrgCount, summarizeSeriesDelivery } from './listModel';
import type { SeriesDetail } from './types';

export interface SeriesListRowProps {
  detail: SeriesDetail;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  timezone: string;
}

/** One series as one expandable row of the Saved Reports table (spec §3.7). */
export function SeriesListRow({ detail, expanded, onToggle, onChanged, timezone }: SeriesListRowProps) {
  const { t } = useTranslation('reports');
  const { series } = detail;
  const summary = summarizeSeriesDelivery(detail.orgs);
  const warn = summary.noRecipient > 0 || summary.blocked > 0;

  return (
    <>
      <tr data-testid={`report-series-row-${series.id}`} className="hover:bg-muted/30">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={`report-series-toggle-${series.id}`}
              aria-expanded={expanded}
              aria-controls={`series-drilldown-${series.id}`}
              aria-label={expanded ? t('reports.series.list.collapse') : t('reports.series.list.expand')}
              onClick={onToggle}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{series.name}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-sm">
          <CoversCell
            testId={`report-series-covers-${series.id}`}
            orgId={null}
            series={{ seriesId: series.id, targetMode: series.targetMode, orgCount: seriesCoveredOrgCount(detail) }}
          />
        </td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${series.type}`)}</td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.schedules.${series.schedule}`)}</td>
        <td className="px-4 py-3 text-sm">{t(/* i18n-dynamic */ `reports.reportsList.formats.${series.format}`)}</td>
        <td data-testid={`report-series-summary-${series.id}`} className="px-4 py-3 text-sm text-muted-foreground">
          {summary.lastRunAt ? (
            <span className="inline-flex items-center gap-1">
              {[
                t('reports.series.list.summary', {
                  date: formatDate(summary.lastRunAt, { timeZone: timezone, month: 'short', day: 'numeric' }),
                  delivered: summary.delivered,
                  total: summary.total,
                }),
                ...(summary.noRecipient > 0 ? [t('reports.series.list.summaryNoRecipient', { count: summary.noRecipient })] : []),
                ...(summary.blocked > 0 ? [t('reports.series.list.summaryBlocked', { count: summary.blocked })] : []),
              ].join(' · ')}
              {warn && <AlertTriangle className="h-3 w-3 text-warning" aria-hidden="true" />}
            </span>
          ) : (
            t('reports.series.list.summaryNever')
          )}
        </td>
        <td className="px-4 py-3">
          {/* Task 9 renders the series actions here. */}
          <div className="flex items-center justify-end gap-1" data-testid={`report-series-actions-${series.id}`} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td id={`series-drilldown-${series.id}`} colSpan={SAVED_REPORTS_COLUMN_COUNT} className="bg-muted/20 px-4 py-3">
            <SeriesDrilldown detail={detail} onChanged={onChanged} timezone={timezone} />
          </td>
        </tr>
      )}
    </>
  );
}
```

Task 8 creates `SeriesDrilldown`. If executing strictly in order, create `SeriesDrilldown.tsx` now as `export function SeriesDrilldown(_: { detail: SeriesDetail; onChanged: () => void; timezone: string }) { return <div data-testid={\`series-drilldown-${_.detail.series.id}\`} />; }` and replace its body in Task 8.

- [ ] **Step 6: Write the failing list test**

`apps/web/src/components/reports/ReportsList.series.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const authUser = vi.hoisted(() => ({ canManagePartnerWide: true as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));
vi.mock('./reportExport', () => ({ exportReport: vi.fn(), downloadBlob: vi.fn(), getBrowserTimezone: () => 'UTC' }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const claims = vi.hoisted(() => ({ value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId, organizations: [] }) }));
vi.mock('./series/SeriesDrilldown', () => ({
  SeriesDrilldown: ({ detail }: { detail: { series: { id: string } } }) => <div data-testid={`series-drilldown-${detail.series.id}`} />,
}));

import ReportsList from './ReportsList';

const SID = '6f1c1b1e-3b8a-4c52-9a47-0c1d2e3f4a5b';
const base = { type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {}, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '' };
const single = { ...base, id: 'rep-s', name: 'Acme inventory', orgId: 'org-1', partnerId: null, orgName: 'Acme' };
const combined = { ...base, type: 'ar_aging', id: 'rep-c', name: 'All AR', orgId: null, partnerId: 'p-1' };
const child = { ...base, id: 'rep-child', name: 'Monthly health', orgId: 'org-1', partnerId: null, orgName: 'Acme', seriesId: SID, seriesName: 'Monthly health' };
const sent = { status: 'completed', deliveryStatus: 'sent', recipientCount: 2, completedAt: '2026-10-01T09:00:00Z' };
const SERIES = {
  series: { id: SID, name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 1, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '' },
  targets: [],
  orgs: [
    ...Array.from({ length: 17 }, (_, i) => ({ orgId: `o${i}`, orgName: `Org ${i}`, state: 'active', childReportId: `c${i}`, lastRun: sent })),
    { orgId: 'o17', orgName: 'Acme Dental', state: 'blocked_no_recipients', childReportId: 'c17', lastRun: { ...sent, deliveryStatus: 'no_recipients', recipientCount: 0 } },
  ],
};

function mockApi({ list = [single, combined], series = [SERIES] as unknown[] } = {}) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports' || url === '/reports?series=exclude') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: list }) });
    if (url === '/reports/series') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: series }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList — multi-org series (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = true;
    window.location.hash = '';
  });

  it('All organizations: one row per series with its delivery summary; children are not listed', async () => {
    mockApi();
    render(<ReportsList />);
    const row = await screen.findByTestId(`report-series-row-${SID}`);
    expect(within(row).getByText('Monthly health')).toBeInTheDocument();
    const summary = screen.getByTestId(`report-series-summary-${SID}`);
    expect(summary).toHaveTextContent('17/18 delivered');
    expect(summary).toHaveTextContent('1 no recipient');
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports?series=exclude')).toBe(true);
    const seriesCall = fetchWithAuth.mock.calls.find(([u]) => u === '/reports/series');
    expect((seriesCall?.[1] as { skipOrgIdInjection?: boolean }).skipOrgIdInjection).toBe(true);
    expect(screen.queryByTestId('report-row-rep-child')).toBeNull();
  });

  it('expands from the hash and ignores a hash naming a deleted series', async () => {
    window.location.hash = `series/${SID}`;
    mockApi();
    render(<ReportsList />);
    expect(await screen.findByTestId(`series-drilldown-${SID}`)).toBeInTheDocument();
    window.location.hash = 'series/00000000-0000-4000-8000-000000000000';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(screen.queryByTestId(`series-drilldown-${SID}`)).toBeNull());
    expect(screen.getByTestId(`report-series-row-${SID}`)).toBeInTheDocument();
  });

  it('toggling a series writes the hash', async () => {
    mockApi();
    render(<ReportsList />);
    fireEvent.click(await screen.findByTestId(`report-series-toggle-${SID}`));
    expect(window.location.hash).toBe(`#series/${SID}`);
  });

  it('filter chips narrow the list and live in the hash', async () => {
    mockApi();
    render(<ReportsList />);
    await screen.findByTestId(`report-series-row-${SID}`);
    fireEvent.click(screen.getByTestId('reports-filter-combined'));
    expect(window.location.hash).toBe('#combined');
    expect(screen.getByTestId('report-row-rep-c')).toBeInTheDocument();
    expect(screen.queryByTestId('report-row-rep-s')).toBeNull();
    expect(screen.queryByTestId(`report-series-row-${SID}`)).toBeNull();
    fireEvent.click(screen.getByTestId('reports-filter-multi'));
    expect(screen.getByTestId(`report-series-row-${SID}`)).toBeInTheDocument();
    expect(screen.queryByTestId('report-row-rep-c')).toBeNull();
  });

  it('one org selected: children are ordinary rows with a Multi-org badge linking to the series, and no Delete', async () => {
    org.currentOrgId = 'org-1';
    mockApi({ list: [single, child] });
    render(<ReportsList />);
    const row = await screen.findByTestId('report-row-rep-child');
    const badge = within(row).getByTestId('report-series-badge-rep-child');
    expect(badge.closest('a')).toHaveAttribute('href', `/reports/series/${SID}`);
    expect(within(row).queryByTestId('report-delete-rep-child')).toBeNull();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports/series')).toBe(false);
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports')).toBe(true);
  });

  it('an organization token never asks for series and shows the badge without a link', async () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    mockApi({ list: [child] });
    render(<ReportsList />);
    const row = await screen.findByTestId('report-row-rep-child');
    expect(within(row).getByTestId('report-series-badge-rep-child').closest('a')).toBeNull();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === '/reports/series')).toBe(false);
  });

  it('keeps the other rows when the series listing fails', async () => {
    mockApi();
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/series') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      if (url === '/reports?series=exclude') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [single] }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
    render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-s')).toBeInTheDocument();
    expect(screen.getByTestId('reports-series-load-failed')).toBeInTheDocument();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/ReportsList.series.test.tsx`
Expected: FAIL. The error is `Unable to find an element by: [data-testid="report-series-row-…"]`.

- [ ] **Step 7: Wire `ReportsList.tsx`**

**7a. Types.**
- On `Report`, add after `partnerId`:
  ```ts
    /** W02: set on a series child (an org-owned row a multi-org report manages). */
    seriesId?: string | null;
    seriesName?: string | null;
    archivedAt?: string | null;
  ```
- On `ReportRun`, add `seriesId?: string | null; seriesName?: string | null;`.

**7b. Imports.**

```ts
import { Layers } from 'lucide-react'; // merge into the existing lucide import list
import { useHashState } from '@/lib/useHashState';
import { fetchSeriesList } from './series/seriesApi';
import { ReportsFilterChips } from './series/ReportsFilterChips';
import { SeriesListRow } from './series/SeriesListRow';
import {
  buildListEntries,
  DEFAULT_REPORTS_LIST_VIEW,
  filterListEntries,
  formatReportsListHash,
  parseReportsListHash,
  type ReportsListView,
} from './series/listModel';
import type { SeriesDetail } from './series/types';
```

**7c. Gates, state and hash.** Add these after `const mergePartnerWide = …;`:

```ts
  // Multi-org series (W03). Same fail-closed gate as mergePartnerWide: only a
  // partner-scope user who may administer partner-wide state sees series. On
  // the All-organizations view the list groups children under their series; with
  // one org focused, children are ordinary rows with a Multi-org badge.
  const seriesGate =
    jwtClaims.status === 'resolved' && jwtClaims.claims.scope === 'partner' && canManagePartnerWide;
  const grouped = seriesGate && !currentOrgId;
  const [seriesDetails, setSeriesDetails] = useState<SeriesDetail[]>([]);
  const [seriesLoadFailed, setSeriesLoadFailed] = useState(false);
  const [view, setView] = useHashState<ReportsListView>(DEFAULT_REPORTS_LIST_VIEW, parseReportsListHash);
  const updateView = useCallback((next: ReportsListView) => {
    setView(next);
    const hash = formatReportsListHash(next);
    if (hash) window.location.hash = hash;
    else window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, [setView]);
```

**7d. Fetch.** In `fetchReports`, change the `Promise.all` to fetch three things:

```ts
      const [response, partnerWide, seriesResult] = await Promise.all([
        // Grouped: children are represented by their series row, so they must
        // not consume the (50-row) first page.
        fetchWithAuth(grouped ? '/reports?series=exclude' : '/reports'),
        mergePartnerWide
          ? fetchPartnerWideReports()
          : Promise.resolve<PartnerWideFetch>({ rows: [], complete: true }),
        grouped
          ? fetchSeriesList().then(
              (rows) => ({ rows: rows ?? [], failed: false }),
              (err: unknown) => {
                // The rest of the list still renders; the banner says what is missing.
                console.warn('Failed to fetch multi-org reports:', err);
                return { rows: [] as SeriesDetail[], failed: true };
              },
            )
          : Promise.resolve({ rows: [] as SeriesDetail[], failed: false }),
      ]);
```

After `setPartnerWideIncomplete(!partnerWide.complete);`, add `setSeriesDetails(seriesResult.rows); setSeriesLoadFailed(seriesResult.failed);`. Add `grouped` to the `useCallback` dependency list.

**7e. Entries.**

Add this before `if (loading) {`:

```ts
  const entries = buildListEntries(reports, seriesDetails, grouped);
  const visibleEntries = filterListEntries(entries, view.filter);
  // A hash naming a series that isn't listed (deleted, other partner) expands nothing.
  const expandedSeriesId = seriesDetails.some((d) => d.series.id === view.seriesId) ? view.seriesId : null;
```

**7f. Render.** Make these changes inside `activeTab === 'reports'`:
- Directly after the `partnerWideIncomplete` notice, add:

  ```tsx
            {seriesLoadFailed && (
              <p data-testid="reports-series-load-failed" role="status" className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm">
                {t('reports.series.list.loadFailed')}
              </p>
            )}
            {entries.length > 0 && (
              <ReportsFilterChips value={view.filter} onChange={(filter) => updateView({ ...view, filter })} />
            )}
  ```

- Change the empty-state condition from `reports.length === 0` to `entries.length === 0`.
- Move the existing `reports.map(report => ( <tr …> … </tr> ))` body into a local `const renderReportRow = (report: Report) => ( <tr …> … </tr> );`, declared above the `return`. Its JSX stays byte-for-byte, except for the two edits in 7g.
- Replace the `<tbody>` contents with:

  ```tsx
                  {visibleEntries.map((entry) =>
                    entry.kind === 'series' ? (
                      <SeriesListRow
                        key={`series-${entry.detail.series.id}`}
                        detail={entry.detail}
                        expanded={expandedSeriesId === entry.detail.series.id}
                        onToggle={() =>
                          updateView({ ...view, seriesId: expandedSeriesId === entry.detail.series.id ? null : entry.detail.series.id })
                        }
                        onChanged={fetchReports}
                        timezone={effectiveTimezone}
                      />
                    ) : (
                      renderReportRow(entry.report)
                    ),
                  )}
  ```

- Directly after the `</table>`'s wrapping `</div>` (still inside the non-empty branch), add:

  ```tsx
              {visibleEntries.length === 0 && (
                <p data-testid="reports-filter-no-matches" className="p-6 text-center text-sm text-muted-foreground">
                  {t('reports.series.list.noMatches')}
                </p>
              )}
  ```

**7g. Child rows.** Two edits inside `renderReportRow`:
- In the name cell's badge row, after the portal badge, add:

  ```tsx
                            {report.seriesId && (
                              seriesGate ? (
                                <a
                                  href={`/reports/series/${report.seriesId}`}
                                  title={t('reports.series.list.multiOrgBadgeTitle', { name: report.seriesName ?? '' })}
                                  className="shrink-0"
                                >
                                  <span data-testid={`report-series-badge-${report.id}`} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                    <Layers className="h-3 w-3" />
                                    {t('reports.series.list.multiOrgBadge')}
                                  </span>
                                </a>
                              ) : (
                                <span data-testid={`report-series-badge-${report.id}`} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                                  <Layers className="h-3 w-3" />
                                  {t('reports.series.list.multiOrgBadge')}
                                </span>
                              )
                            )}
  ```

- Wrap the Delete `<button data-testid={`report-delete-${report.id}`} …>` in `{!report.seriesId && ( … )}`. A child is removed by Exclude or Detach, and a DELETE on it would only answer 409 `series_managed`.

**7h. Recent Runs.** Add a Series column to the runs table:
- a header `<th className="px-4 py-3">{t('reports.series.list.runsSeriesColumn')}</th>` directly after W01's Org column header (`reports.reportsList.runsTable.organization`);
- the matching cell in each run row:

  ```tsx
                      <td data-testid={`report-run-series-${run.id}`} className="px-4 py-3 text-sm text-muted-foreground">
                        {run.seriesName ?? ''}
                      </td>
  ```

- [ ] **Step 8: Point the existing partner-wide list suites at the grouped URL**

A ReportsList suite whose fixture is a resolved partner-scope, partner-wide user on All organizations now lists `/reports?series=exclude`. Find them with:

`grep -ln "scope: 'partner'" apps/web/src/components/reports/ReportsList.*.test.tsx`

Expected hits: `ReportsList.scope.test.tsx`, W01's `ReportsList.covers.test.tsx`, and this task's own `ReportsList.series.test.tsx`, which is already correct. Make three edits in each of the other files:
- in its list mock, `url === '/reports'` becomes `(url === '/reports' || url === '/reports?series=exclude')`;
- add a branch to the same mock: `if (url === '/reports/series') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });`;
- in `ReportsList.scope.test.tsx`'s "keeps the ambient org injection on the list request" case, find the call by `url === '/reports?series=exclude'`, and keep its `expect(listCall?.[1]).toBeUndefined();` assertion unchanged. The grouped URL still takes the ambient injection.

The other `ReportsList.*` suites mock `useJwtClaims` as `unresolved`. The gate fails closed there, so they keep listing `/reports` and need no edit.

- [ ] **Step 9: Run every list suite**

Run: `cd apps/web && npx vitest run src/components/reports/ReportsList src/components/reports/series/listModel.test.ts src/lib/__tests__/no-hash-in-usestate.test.ts`
Expected: PASS. That covers `ReportsList.series.test.tsx` (7 tests), every existing `ReportsList.*` suite, `listModel` and the hash guard.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/reports/series/listModel.ts apps/web/src/components/reports/series/listModel.test.ts apps/web/src/components/reports/series/ReportsFilterChips.tsx apps/web/src/components/reports/series/SeriesListRow.tsx apps/web/src/components/reports/series/SeriesDrilldown.tsx apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportsList.series.test.tsx apps/web/src/components/reports/ReportsList.scope.test.tsx apps/web/src/components/reports/ReportsList.covers.test.tsx
git commit -m "feat(reports): group series in the saved list with filter chips and hash state (W03 Task 7)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `SeriesDrilldown` with per-org actions

**Files:**
- Create or replace: `apps/web/src/components/reports/series/SeriesDrilldown.tsx`, `SeriesDrilldown.test.tsx`

**Interfaces:**
- Consumes:
  - `replaceSeriesTargets`, `detachSeriesChild`, `generateSeriesChild` (Task 1);
  - `targetsAfterExclude`, `targetsAfterInclude`, `canExcludeOrg` (Task 7);
  - `ConfirmDialog` (`../../shared/ConfirmDialog`), `handleActionError` (`@/lib/runAction`);
  - W01's `DeliveryStatusChip` (`../DeliveryStatusChip`) for the warning delivery states.
- Produces: `SeriesDrilldown({ detail, onChanged, timezone })`.
- Testids:
  - `series-drilldown-<seriesId>`;
  - per org: `series-org-row-<orgId>` (with `data-state`), `series-org-delivery-<orgId>` (the W01 chip), `series-org-run-<orgId>`, `series-org-recipients-<orgId>`, `series-org-exclude-<orgId>`, `series-org-include-<orgId>`, `series-org-detach-<orgId>`, `series-org-hint-<orgId>`;
  - confirm buttons: `series-confirm-exclude`, `series-confirm-detach`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  replaceSeriesTargets: vi.fn(() => Promise.resolve({})),
  detachSeriesChild: vi.fn(() => Promise.resolve()),
  generateSeriesChild: vi.fn(() => Promise.resolve()),
}));
vi.mock('./seriesApi', () => api);

import { SeriesDrilldown } from './SeriesDrilldown';
import type { SeriesDetail } from './types';

const series = (targetMode: 'all' | 'selected') => ({
  id: 's-1', name: 'Monthly', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode,
  recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 1, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '',
}) as SeriesDetail['series'];

const ALL: SeriesDetail = {
  series: series('all'),
  targets: ['o-x'],
  orgs: [
    { orgId: 'o-b', orgName: 'Birch Law', state: 'blocked_no_authority', childReportId: 'c-b', lastRun: null },
    { orgId: 'o-a', orgName: 'Acme Dental', state: 'active', childReportId: 'c-a', lastRun: { status: 'completed', deliveryStatus: 'sent', recipientCount: 2, completedAt: '2026-10-01T09:00:00Z' } },
    { orgId: 'o-x', orgName: 'Xeno', state: 'excluded', childReportId: 'c-x', lastRun: null },
  ],
};

describe('SeriesDrilldown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists orgs by name with state, delivery and recipient count', () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    const rows = screen.getAllByTestId(/^series-org-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['series-org-row-o-a', 'series-org-row-o-b', 'series-org-row-o-x']);
    expect(rows[0]).toHaveAttribute('data-state', 'active');
    expect(rows[0]).toHaveTextContent('Sent');
    expect(rows[0]).toHaveTextContent('2');
    expect(screen.getByTestId('series-org-recipients-o-a')).toHaveAttribute('href', '/reports/c-a/edit');
  });

  it('never runs a child the owner cannot reach', () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    expect(screen.getByTestId('series-org-run-o-b')).toBeDisabled();
    expect(screen.getByTestId('series-org-hint-o-b')).toHaveTextContent("The owner can't reach this organization");
  });

  it('Run now generates that org\'s copy', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-run-o-a'));
    await waitFor(() => expect(api.generateSeriesChild).toHaveBeenCalledWith('c-a', expect.objectContaining({ errorFallback: expect.any(String) })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Exclude (All orgs) confirms, then adds an exclusion', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-exclude-o-a'));
    expect(api.replaceSeriesTargets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('series-confirm-exclude'));
    await waitFor(() => expect(api.replaceSeriesTargets).toHaveBeenCalledWith('s-1', { targetMode: 'all', orgIds: ['o-x', 'o-a'] }, expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Include removes the exclusion without a confirm', async () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-include-o-x'));
    await waitFor(() => expect(api.replaceSeriesTargets).toHaveBeenCalledWith('s-1', { targetMode: 'all', orgIds: [] }, expect.anything()));
  });

  // Review Focus 1.
  it('disables Exclude on the only chosen organization', () => {
    const one: SeriesDetail = { series: series('selected'), targets: ['o-a'], orgs: [ALL.orgs[1]!] };
    render(<SeriesDrilldown detail={one} onChanged={vi.fn()} timezone="UTC" />);
    expect(screen.getByTestId('series-org-exclude-o-a')).toBeDisabled();
    expect(screen.getByTestId('series-org-hint-o-a')).toHaveTextContent('needs at least one');
  });

  it('Detach confirms, then detaches the child', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-detach-o-a'));
    fireEvent.click(screen.getByTestId('series-confirm-detach'));
    await waitFor(() => expect(api.detachSeriesChild).toHaveBeenCalledWith('c-a', expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('refreshes nothing when an action fails', async () => {
    api.generateSeriesChild.mockRejectedValueOnce(new Error('network'));
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-run-o-a'));
    await waitFor(() => expect(api.generateSeriesChild).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesDrilldown.test.tsx`
Expected: FAIL. The rows or actions are not found.

- [ ] **Step 2: Implement**

```tsx
import { useMemo, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { DeliveryStatusChip } from '../DeliveryStatusChip';
import { detachSeriesChild, generateSeriesChild, replaceSeriesTargets } from './seriesApi';
import { canExcludeOrg, targetsAfterExclude, targetsAfterInclude } from './listModel';
import type { SeriesDetail, SeriesOrgStatus } from './types';

type Pending = { kind: 'exclude' | 'detach'; org: SeriesOrgStatus } | null;
const HAS_CHILD_STATES = new Set<SeriesOrgStatus['state']>(['active', 'blocked_no_authority', 'blocked_no_recipients']);

/** The per-org lines of one series (spec §3.7): Run now / Edit recipients / Exclude / Include / Detach. */
export function SeriesDrilldown({ detail, onChanged, timezone }: { detail: SeriesDetail; onChanged: () => void; timezone: string }) {
  const { t } = useTranslation('reports');
  const [pending, setPending] = useState<Pending>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const seriesId = detail.series.id;
  const orgs = useMemo(() => [...detail.orgs].sort((a, b) => a.orgName.localeCompare(b.orgName)), [detail.orgs]);

  const act = async (org: SeriesOrgStatus, action: () => Promise<unknown>, fallback: string) => {
    setBusyOrgId(org.orgId);
    try {
      await action();
      onChanged();
    } catch (err) {
      handleActionError(err, fallback);
    } finally {
      setBusyOrgId(null);
    }
  };

  const exclude = (org: SeriesOrgStatus) =>
    act(org, () => replaceSeriesTargets(seriesId, targetsAfterExclude(detail, org.orgId), {
      errorFallback: t('reports.series.drilldown.updateFailed'),
      successMessage: t('reports.series.drilldown.excluded', { org: org.orgName }),
    }), t('reports.series.drilldown.updateFailed'));
  const include = (org: SeriesOrgStatus) =>
    act(org, () => replaceSeriesTargets(seriesId, targetsAfterInclude(detail, org.orgId), {
      errorFallback: t('reports.series.drilldown.updateFailed'),
      successMessage: t('reports.series.drilldown.included', { org: org.orgName }),
    }), t('reports.series.drilldown.updateFailed'));
  const detach = (org: SeriesOrgStatus) =>
    act(org, () => detachSeriesChild(org.childReportId!, {
      errorFallback: t('reports.series.drilldown.detachFailed'),
      successMessage: t('reports.series.drilldown.detached', { org: org.orgName }),
    }), t('reports.series.drilldown.detachFailed'));
  const runNow = (org: SeriesOrgStatus) =>
    act(org, () => generateSeriesChild(org.childReportId!, {
      errorFallback: t('reports.series.drilldown.generateFailed'),
      successMessage: t('reports.series.drilldown.generated', { org: org.orgName }),
    }), t('reports.series.drilldown.generateFailed'));

  return (
    <div data-testid={`series-drilldown-${seriesId}`} className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.org')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.state')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.lastRun')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.delivery')}</th>
            <th className="px-3 py-2">{t('reports.series.drilldown.columns.recipients')}</th>
            <th className="px-3 py-2 text-right">{t('reports.series.drilldown.columns.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {orgs.map((org) => {
            const hasChild = Boolean(org.childReportId) && HAS_CHILD_STATES.has(org.state);
            const busy = busyOrgId === org.orgId;
            const excludable = canExcludeOrg(detail, org.orgId);
            const hint =
              org.state === 'blocked_no_authority'
                ? t('reports.series.drilldown.noAuthorityHint')
                : org.state !== 'excluded' && !excludable
                  ? t('reports.series.drilldown.lastOrgHint')
                  : null;
            return (
              <tr key={org.orgId} data-testid={`series-org-row-${org.orgId}`} data-state={org.state}>
                <td className="px-3 py-2 font-medium">{org.orgName}</td>
                <td className="px-3 py-2">
                  {t(/* i18n-dynamic */ `reports.series.drilldown.states.${org.state}`)}
                  {hint && <p data-testid={`series-org-hint-${org.orgId}`} className="text-xs text-muted-foreground">{hint}</p>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {org.lastRun?.completedAt ? formatDateTime(org.lastRun.completedAt, { timeZone: timezone }) : t('reports.series.drilldown.neverRun')}
                </td>
                <td className="px-3 py-2">
                  {/* W01's chip owns the warning states (no_recipients / partial / failed) and
                      renders nothing for the others, which get a plain label here. */}
                  {org.lastRun?.deliveryStatus === 'sent' || org.lastRun?.deliveryStatus === 'not_scheduled'
                    ? t(/* i18n-dynamic */ `reports.series.drilldown.delivery.${org.lastRun.deliveryStatus}`)
                    : org.lastRun?.deliveryStatus
                      ? <DeliveryStatusChip status={org.lastRun.deliveryStatus} testId={`series-org-delivery-${org.orgId}`} />
                      : '—'}
                </td>
                <td className="px-3 py-2">{org.lastRun?.recipientCount ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {hasChild && (
                      <button
                        type="button"
                        data-testid={`series-org-run-${org.orgId}`}
                        disabled={busy || org.state === 'blocked_no_authority'}
                        onClick={() => void runNow(org)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        {t('reports.series.drilldown.actions.runNow')}
                      </button>
                    )}
                    {hasChild && (
                      <a
                        data-testid={`series-org-recipients-${org.orgId}`}
                        href={`/reports/${org.childReportId}/edit`}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted"
                      >
                        {t('reports.series.drilldown.actions.editRecipients')}
                      </a>
                    )}
                    {org.state === 'excluded' ? (
                      <button
                        type="button"
                        data-testid={`series-org-include-${org.orgId}`}
                        disabled={busy}
                        onClick={() => void include(org)}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.include')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`series-org-exclude-${org.orgId}`}
                        disabled={busy || !excludable}
                        onClick={() => setPending({ kind: 'exclude', org })}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.exclude')}
                      </button>
                    )}
                    {hasChild && (
                      <button
                        type="button"
                        data-testid={`series-org-detach-${org.orgId}`}
                        disabled={busy}
                        onClick={() => setPending({ kind: 'detach', org })}
                        className="inline-flex h-8 items-center rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        {t('reports.series.drilldown.actions.detach')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const current = pending;
          setPending(null);
          if (!current) return;
          void (current.kind === 'exclude' ? exclude(current.org) : detach(current.org));
        }}
        title={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Title`, { org: pending.org.orgName }) : ''}
        message={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Message`, { org: pending.org.orgName }) : ''}
        confirmLabel={pending ? t(/* i18n-dynamic */ `reports.series.drilldown.${pending.kind}Confirm`) : undefined}
        variant={pending?.kind === 'detach' ? 'warning' : 'destructive'}
        confirmTestId={pending?.kind === 'detach' ? 'series-confirm-detach' : 'series-confirm-exclude'}
      />
    </div>
  );
}
```

- [ ] **Step 3: Run the drill-down tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesDrilldown.test.tsx src/components/reports/ReportsList.series.test.tsx`
Expected: PASS (8 tests + 7 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/reports/series/SeriesDrilldown.tsx apps/web/src/components/reports/series/SeriesDrilldown.test.tsx
git commit -m "feat(reports): per-org drill-down with run, recipients, exclude, include and detach (W03 Task 8)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Series row actions — Edit, Pause/Resume, Transfer owner, Delete

**Files:**
- Create: `apps/web/src/components/reports/series/TransferOwnerDialog.tsx`, `TransferOwnerDialog.test.tsx`
- Create: `apps/web/src/components/reports/series/SeriesPauseButton.tsx`, `SeriesPauseButton.test.tsx`
- Modify: `apps/web/src/components/reports/series/SeriesListRow.tsx` (actions cell; Paused badge in the Covers and Last-run cells)
- Modify: `apps/web/src/components/reports/series/SeriesDrilldown.tsx` and `SeriesDrilldown.test.tsx` (header with Pause/Resume)
- Create: `apps/web/src/components/reports/series/SeriesListRow.test.tsx`

**Interfaces:**
- Consumes: `fetchSeriesOwnerCandidates`, `transferSeriesOwner`, `deleteSeries`, `updateSeries` (Task 1); `Dialog` (`../../shared/Dialog`); `ConfirmDialog`.
- Pause/Resume (coordinator ruling) is `PATCH /reports/series/:id` with body `{ enabled: false | true }`, through `updateSeries` (runAction-wrapped). W02 reconciles on enable/disable (spec §3.3 trigger 1), and its worker gate skips a disabled series' children.
- Produces:
  - `TransferOwnerDialog({ open, onClose, seriesId, currentOwnerId, onTransferred })`;
  - `SeriesPauseButton({ detail, onChanged, testId })` and `SeriesPausedBadge({ testId })`.
- Testids:
  - row actions: `report-series-edit-<id>`, `report-series-pause-<id>` (with `data-enabled`), `report-series-transfer-<id>`, `report-series-delete-<id>`, `series-confirm-delete`;
  - paused badges: `report-series-paused-covers-<id>`, `report-series-paused-lastrun-<id>`, `series-drilldown-paused-<id>`;
  - drill-down header: `series-drilldown-pause-<id>`;
  - dialog: `series-transfer-owner-dialog`, `series-transfer-owner-select`, `series-transfer-owner-confirm`, `series-transfer-owner-message`.

- [ ] **Step 1: Write the failing dialog test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchSeriesOwnerCandidates: vi.fn(),
  transferSeriesOwner: vi.fn(() => Promise.resolve()),
}));
vi.mock('./seriesApi', () => api);

import { TransferOwnerDialog } from './TransferOwnerDialog';

describe('TransferOwnerDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists eligible users, marks the current owner, and transfers to the chosen one', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue([
      { id: 'u-1', name: 'Ada', email: 'ada@x.io' },
      { id: 'u-2', name: 'Bo', email: 'bo@x.io' },
    ]);
    const onTransferred = vi.fn();
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={onTransferred} />);
    const select = await screen.findByTestId('series-transfer-owner-select');
    expect(screen.getByRole('option', { name: 'Ada (current owner)' })).toBeDisabled();
    expect(screen.getByTestId('series-transfer-owner-confirm')).toBeDisabled();
    fireEvent.change(select, { target: { value: 'u-2' } });
    fireEvent.click(screen.getByTestId('series-transfer-owner-confirm'));
    await waitFor(() => expect(api.transferSeriesOwner).toHaveBeenCalledWith('s-1', 'u-2', expect.objectContaining({ successMessage: 'Owner transferred to Bo' })));
    await waitFor(() => expect(onTransferred).toHaveBeenCalled());
  });

  it('explains a missing users:read permission', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue('forbidden');
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={vi.fn()} />);
    expect(await screen.findByTestId('series-transfer-owner-message')).toHaveTextContent('permission to view users');
  });

  it('says when nobody else qualifies', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue([{ id: 'u-1', name: 'Ada', email: 'ada@x.io' }]);
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={vi.fn()} />);
    expect(await screen.findByTestId('series-transfer-owner-message')).toHaveTextContent('No other user');
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/TransferOwnerDialog.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./TransferOwnerDialog"`.

- [ ] **Step 2: Implement `TransferOwnerDialog.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { Dialog } from '../../shared/Dialog';
import { fetchSeriesOwnerCandidates, transferSeriesOwner } from './seriesApi';
import type { PartnerUserOption } from './types';

type Load = { state: 'loading' } | { state: 'ready'; users: PartnerUserOption[] } | { state: 'forbidden' } | { state: 'failed' };

/** Spec §3.4 transfer-owner: every child's execution scope is re-captured server-side. */
export function TransferOwnerDialog({
  open,
  onClose,
  seriesId,
  currentOwnerId,
  onTransferred,
}: {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  currentOwnerId: string | null;
  onTransferred: () => void;
}) {
  const { t } = useTranslation('reports');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [chosen, setChosen] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ state: 'loading' });
    setChosen('');
    fetchSeriesOwnerCandidates()
      .then((result) => {
        if (!live) return;
        setLoad(result === 'forbidden' ? { state: 'forbidden' } : { state: 'ready', users: result });
      })
      .catch((err: unknown) => {
        if (!live) return;
        console.error('[TransferOwnerDialog] users load failed', err);
        setLoad({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [open]);

  const users = load.state === 'ready' ? load.users : [];
  const others = users.filter((u) => u.id !== currentOwnerId);
  const chosenUser = users.find((u) => u.id === chosen);

  const confirm = async () => {
    if (!chosenUser) return;
    setSaving(true);
    try {
      await transferSeriesOwner(seriesId, chosenUser.id, {
        errorFallback: t('reports.series.transferOwner.failed'),
        successMessage: t('reports.series.transferOwner.transferred', { name: chosenUser.name || chosenUser.email }),
      });
      onTransferred();
      onClose();
    } catch (err) {
      handleActionError(err, t('reports.series.transferOwner.failed'));
    } finally {
      setSaving(false);
    }
  };

  const message =
    load.state === 'forbidden' ? t('reports.series.transferOwner.forbidden')
      : load.state === 'failed' ? t('reports.series.transferOwner.loadFailed')
        : load.state === 'ready' && others.length === 0 ? t('reports.series.transferOwner.noCandidates')
          : null;

  return (
    <Dialog open={open} onClose={onClose} title={t('reports.series.transferOwner.title')} maxWidth="md" className="p-6">
      <div data-testid="series-transfer-owner-dialog" className="space-y-4">
        <h2 className="text-lg font-semibold">{t('reports.series.transferOwner.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('reports.series.transferOwner.description')}</p>
        {load.state === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
        {message && <p data-testid="series-transfer-owner-message" role="status" className="text-sm">{message}</p>}
        {load.state === 'ready' && others.length > 0 && (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{t('reports.series.transferOwner.label')}</span>
            <select
              data-testid="series-transfer-owner-select"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('reports.series.transferOwner.placeholder')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id} disabled={u.id === currentOwnerId}>
                  {u.id === currentOwnerId
                    ? t('reports.series.transferOwner.current', { name: u.name || u.email })
                    : u.name || u.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md border px-4 text-sm hover:bg-muted">
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="series-transfer-owner-confirm"
            disabled={!chosenUser || saving}
            onClick={() => void confirm()}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('reports.series.transferOwner.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 3: Write the failing row-action test**

`SeriesListRow.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  deleteSeries: vi.fn(() => Promise.resolve()),
  fetchSeriesOwnerCandidates: vi.fn(() => Promise.resolve([])),
  transferSeriesOwner: vi.fn(),
  updateSeries: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./seriesApi', () => api);
vi.mock('./SeriesDrilldown', () => ({ SeriesDrilldown: () => null }));
vi.mock('../CoversCell', () => ({ CoversCell: () => <span data-testid="covers-cell-stub" /> }));

import { SeriesListRow } from './SeriesListRow';
import type { SeriesDetail } from './types';

const DETAIL = {
  series: { id: 's-1', name: 'Monthly', type: 'device_inventory', format: 'pdf', schedule: 'monthly', targetMode: 'all', ownerUserId: 'u-1', enabled: true },
  targets: [],
  orgs: [],
} as unknown as SeriesDetail;
const PAUSED = { ...DETAIL, series: { ...DETAIL.series, enabled: false } } as SeriesDetail;

const renderRow = (onChanged = vi.fn(), detail: SeriesDetail = DETAIL) =>
  render(<table><tbody><SeriesListRow detail={detail} expanded={false} onToggle={vi.fn()} onChanged={onChanged} timezone="UTC" /></tbody></table>);

describe('SeriesListRow actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links Edit to the series page', () => {
    renderRow();
    expect(screen.getByTestId('report-series-edit-s-1')).toHaveAttribute('href', '/reports/series/s-1');
  });

  it('deletes only after the confirm and then refreshes', async () => {
    const onChanged = vi.fn();
    renderRow(onChanged);
    fireEvent.click(screen.getByTestId('report-series-delete-s-1'));
    expect(api.deleteSeries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('series-confirm-delete'));
    await waitFor(() => expect(api.deleteSeries).toHaveBeenCalledWith('s-1', expect.objectContaining({ successMessage: 'Deleted multi-org report “Monthly”' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('opens the transfer-owner dialog', async () => {
    renderRow();
    fireEvent.click(screen.getByTestId('report-series-transfer-s-1'));
    expect(await screen.findByTestId('series-transfer-owner-dialog')).toBeInTheDocument();
  });

  it('pauses an active series with PATCH { enabled: false } and refreshes; no Paused badge while active', async () => {
    const onChanged = vi.fn();
    renderRow(onChanged);
    expect(screen.queryByTestId('report-series-paused-covers-s-1')).toBeNull();
    const pause = screen.getByTestId('report-series-pause-s-1');
    expect(pause).toHaveAttribute('data-enabled', 'true');
    expect(pause).toHaveTextContent('Pause');
    fireEvent.click(pause);
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: false }, expect.objectContaining({ successMessage: 'Paused “Monthly”' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a paused series shows Paused in the Covers and Last-run cells and offers Resume', async () => {
    renderRow(vi.fn(), PAUSED);
    expect(screen.getByTestId('report-series-paused-covers-s-1')).toHaveTextContent('Paused');
    expect(screen.getByTestId('report-series-paused-lastrun-s-1')).toHaveTextContent('Paused');
    const resume = screen.getByTestId('report-series-pause-s-1');
    expect(resume).toHaveTextContent('Resume');
    fireEvent.click(resume);
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: true }, expect.objectContaining({ successMessage: 'Resumed “Monthly”' })));
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesListRow.test.tsx`
Expected: FAIL. The error is `Unable to find an element by: [data-testid="report-series-edit-s-1"]`.

- [ ] **Step 4: Fill the actions cell in `SeriesListRow.tsx`**

**4a. Imports.** Add:

```ts
import { useState } from 'react';
import { ArrowRightLeft, Pencil, Trash2 } from 'lucide-react';
import { handleActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { TransferOwnerDialog } from './TransferOwnerDialog';
import { deleteSeries } from './seriesApi';
```

**4b. State and handler.** Inside the component, after `const warn = …`:

```ts
  const [transferOpen, setTransferOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSeries(series.id, {
        errorFallback: t('reports.series.list.deleteFailed'),
        successMessage: t('reports.series.list.deleted', { name: series.name }),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('reports.series.list.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };
```

**4c. Actions cell.** Replace the empty actions `<div … data-testid={`report-series-actions-${series.id}`} />` with:

```tsx
          <div className="flex items-center justify-end gap-1" data-testid={`report-series-actions-${series.id}`}>
            <a
              data-testid={`report-series-edit-${series.id}`}
              href={`/reports/series/${series.id}`}
              title={t('reports.series.list.actions.edit')}
              aria-label={t('reports.series.list.actions.edit')}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <Pencil className="h-4 w-4" />
            </a>
            <button
              type="button"
              data-testid={`report-series-transfer-${series.id}`}
              title={t('reports.series.list.actions.transferOwner')}
              aria-label={t('reports.series.list.actions.transferOwner')}
              onClick={() => setTransferOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <ArrowRightLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`report-series-delete-${series.id}`}
              title={t('reports.series.list.actions.delete')}
              aria-label={t('reports.series.list.actions.delete')}
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
```

**4d. Dialogs.** After the drill-down `{expanded && (…)}` block, still inside the fragment, add:

```tsx
      <TransferOwnerDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        seriesId={series.id}
        currentOwnerId={series.ownerUserId}
        onTransferred={onChanged}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void handleDelete();
        }}
        title={t('reports.series.list.deleteTitle')}
        message={t('reports.series.list.deleteMessage', { name: series.name })}
        confirmLabel={t('reports.series.list.deleteConfirm')}
        confirmTestId="series-confirm-delete"
      />
```

Both dialogs render through a portal. Closed, they render nothing inside the `<tbody>`.

- [ ] **Step 4e: Pause/Resume — the shared button and badge**

Create `apps/web/src/components/reports/series/SeriesPauseButton.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateSeries: vi.fn(() => Promise.resolve({})) }));
vi.mock('./seriesApi', () => api);

import { SeriesPauseButton } from './SeriesPauseButton';
import type { SeriesDetail } from './types';

const detail = (enabled: boolean) =>
  ({ series: { id: 's-1', name: 'Monthly', enabled }, targets: [], orgs: [] }) as unknown as SeriesDetail;

describe('SeriesPauseButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not refresh when the PATCH fails', async () => {
    api.updateSeries.mockRejectedValueOnce(new Error('network'));
    const onChanged = vi.fn();
    render(<SeriesPauseButton detail={detail(true)} onChanged={onChanged} testId="btn" />);
    fireEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId('btn')).not.toBeDisabled();
  });
});
```

(The success paths for both directions are pinned in `SeriesListRow.test.tsx` above and in the drill-down header test below.)

Create `apps/web/src/components/reports/series/SeriesPauseButton.tsx`:

```tsx
import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { updateSeries } from './seriesApi';
import type { SeriesDetail } from './types';

/**
 * Pause / Resume a whole series (coordinator ruling): PATCH { enabled }. W02
 * reconciles on the change and its worker gate skips every child of a disabled
 * series. Used on the list row and in the drill-down header.
 */
export function SeriesPauseButton({ detail, onChanged, testId }: { detail: SeriesDetail; onChanged: () => void; testId: string }) {
  const { t } = useTranslation('reports');
  const [busy, setBusy] = useState(false);
  const { series } = detail;
  const enabled = series.enabled !== false;

  const toggle = async () => {
    setBusy(true);
    try {
      await updateSeries(series.id, { enabled: !enabled }, {
        errorFallback: t('reports.series.list.pauseFailed'),
        successMessage: enabled
          ? t('reports.series.list.paused', { name: series.name })
          : t('reports.series.list.resumed', { name: series.name }),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('reports.series.list.pauseFailed'));
    } finally {
      setBusy(false);
    }
  };

  const label = enabled ? t('reports.series.list.actions.pause') : t('reports.series.list.actions.resume');
  return (
    <button
      type="button"
      data-testid={testId}
      data-enabled={String(enabled)}
      disabled={busy}
      onClick={() => void toggle()}
      title={label}
      className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
    >
      {enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      {label}
    </button>
  );
}

export function SeriesPausedBadge({ testId }: { testId: string }) {
  const { t } = useTranslation('reports');
  return (
    <span
      data-testid={testId}
      title={t('reports.series.list.pausedTitle')}
      className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium"
    >
      {t('reports.series.list.pausedBadge')}
    </span>
  );
}
```

**Row cells.** In `SeriesListRow.tsx`:
- import `import { SeriesPauseButton, SeriesPausedBadge } from './SeriesPauseButton';`;
- add `const paused = series.enabled === false;` after `const warn = …`;
- in the Covers cell, wrap the existing `<CoversCell … />` as:

```tsx
          <div className="flex flex-wrap items-center gap-2">
            <CoversCell
              testId={`report-series-covers-${series.id}`}
              orgId={null}
              series={{ seriesId: series.id, targetMode: series.targetMode, orgCount: seriesCoveredOrgCount(detail) }}
            />
            {paused && <SeriesPausedBadge testId={`report-series-paused-covers-${series.id}`} />}
          </div>
```

- in the Last-run cell (`report-series-summary-…`), add as its first child:

```tsx
          {paused && (
            <span className="mr-2">
              <SeriesPausedBadge testId={`report-series-paused-lastrun-${series.id}`} />
            </span>
          )}
```

- in the actions cell, insert directly after the Edit `<a …>`:

```tsx
            <SeriesPauseButton detail={detail} onChanged={onChanged} testId={`report-series-pause-${series.id}`} />
```

**Drill-down header.** In `SeriesDrilldown.tsx`, add the import `import { SeriesPauseButton, SeriesPausedBadge } from './SeriesPauseButton';`. Directly inside `<div data-testid={`series-drilldown-${seriesId}`} …>`, before `<table>`, insert:

```tsx
      <div className="mb-2 flex items-center justify-end gap-2">
        {detail.series.enabled === false && <SeriesPausedBadge testId={`series-drilldown-paused-${seriesId}`} />}
        <SeriesPauseButton detail={detail} onChanged={onChanged} testId={`series-drilldown-pause-${seriesId}`} />
      </div>
```

In `SeriesDrilldown.test.tsx`, add `updateSeries: vi.fn(() => Promise.resolve({})),` to its hoisted `api` mock (its `series()` factory already sets `enabled: true`), and append:

```tsx
  it('pauses the series from the drill-down header, and shows Paused when disabled', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    expect(screen.queryByTestId('series-drilldown-paused-s-1')).toBeNull();
    fireEvent.click(screen.getByTestId('series-drilldown-pause-s-1'));
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: false }, expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    rerender(<SeriesDrilldown detail={{ ...ALL, series: { ...ALL.series, enabled: false } }} onChanged={onChanged} timezone="UTC" />);
    expect(screen.getByTestId('series-drilldown-paused-s-1')).toHaveTextContent('Paused');
    expect(screen.getByTestId('series-drilldown-pause-s-1')).toHaveTextContent('Resume');
  });
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesPauseButton.test.tsx src/components/reports/series/SeriesDrilldown.test.tsx`
Expected: PASS (1 + 9 tests).

- [ ] **Step 5: Run the dialog and row-action tests**

Run: `cd apps/web && npx vitest run src/components/reports/series/TransferOwnerDialog.test.tsx src/components/reports/series/SeriesListRow.test.tsx src/components/reports/series/SeriesPauseButton.test.tsx src/components/reports/series/SeriesDrilldown.test.tsx src/components/reports/ReportsList.series.test.tsx`
Expected: PASS (3 + 5 + 1 + 9 + 7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/series/TransferOwnerDialog.tsx apps/web/src/components/reports/series/TransferOwnerDialog.test.tsx apps/web/src/components/reports/series/SeriesListRow.tsx apps/web/src/components/reports/series/SeriesListRow.test.tsx apps/web/src/components/reports/series/SeriesPauseButton.tsx apps/web/src/components/reports/series/SeriesPauseButton.test.tsx apps/web/src/components/reports/series/SeriesDrilldown.tsx apps/web/src/components/reports/series/SeriesDrilldown.test.tsx
git commit -m "feat(reports): series edit, transfer-owner and delete actions (W03 Task 9)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Locked child view

**Files:**
- Create: `apps/web/src/components/reports/series/SeriesChildRecipients.tsx`, `SeriesChildRecipients.test.tsx`
- Create: `apps/web/src/components/reports/series/SeriesChildLockBanner.tsx`, `SeriesChildLockBanner.test.tsx`
- Modify: `apps/web/src/components/reports/ReportEditPage.tsx` (child branch before the builder render)

**Interfaces:**
- Consumes:
  - `fetchOrgContacts`, `fetchChildOverrides`, `setChildRecipientOverride`, `fetchSeriesDetail`, `detachSeriesChild` (Task 1);
  - `matchesRecipientRule` (Task 1);
  - `useDefaultReportOwnerScope`, `useJwtClaims`.
- Produces:
  - `SeriesChildRecipients({ reportId, orgId, rule })`;
  - `SeriesChildLockBanner({ report, access, onDetached })`;
  - `SeriesChildView({ report, onChanged })`;
  - `useSeriesChildAccess(): 'msp' | 'readonly' | 'managed'`.
- Testids:
  - banner: `series-child-lock-banner` (with `data-variant`), `series-child-managed-badge`, `series-child-edit-series`, `series-child-detach`, `series-child-archived`, `series-confirm-child-detach`;
  - summary and recipients: `series-child-summary`, `series-child-recipients`, `series-child-recipient-<contactId>` (a select), `series-child-by-rule-<contactId>`.

- [ ] **Step 1: Write the failing recipients test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchOrgContacts: vi.fn(),
  fetchChildOverrides: vi.fn(),
  setChildRecipientOverride: vi.fn(() => Promise.resolve()),
}));
vi.mock('./seriesApi', () => api);

import { SeriesChildRecipients } from './SeriesChildRecipients';

const CONTACTS = [
  { id: 'c-1', name: 'Pat Primary', email: 'pat@acme.io', roles: [], isPrimary: true, siteId: null },
  { id: 'c-2', name: 'Bill Billing', email: 'bill@acme.io', roles: ['billing'], isPrimary: false, siteId: null },
];

describe('SeriesChildRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchOrgContacts.mockResolvedValue(CONTACTS);
    api.fetchChildOverrides.mockResolvedValue([{ contactId: 'c-2', mode: 'add' }]);
  });

  it('shows each contact\'s override and who the rule already includes', async () => {
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={{ primaryContact: true, roles: [] }} />);
    expect(await screen.findByTestId('series-child-recipient-c-1')).toHaveValue('default');
    expect(screen.getByTestId('series-child-recipient-c-2')).toHaveValue('add');
    expect(screen.getByTestId('series-child-by-rule-c-1')).toHaveTextContent('Included by rule');
    expect(screen.queryByTestId('series-child-by-rule-c-2')).toBeNull();
    expect(api.fetchOrgContacts).toHaveBeenCalledWith('org-1');
  });

  it('writes an override and keeps the new choice', async () => {
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={null} />);
    const select = await screen.findByTestId('series-child-recipient-c-1');
    fireEvent.change(select, { target: { value: 'remove' } });
    await waitFor(() => expect(api.setChildRecipientOverride).toHaveBeenCalledWith('rep-1', 'c-1', 'default', 'remove', expect.anything()));
    await waitFor(() => expect(screen.getByTestId('series-child-recipient-c-1')).toHaveValue('remove'));
  });

  it('reloads the truth when a write fails', async () => {
    api.setChildRecipientOverride.mockRejectedValueOnce(new Error('network'));
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={null} />);
    fireEvent.change(await screen.findByTestId('series-child-recipient-c-2'), { target: { value: 'remove' } });
    await waitFor(() => expect(api.fetchChildOverrides).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('series-child-recipient-c-2')).toHaveValue('add');
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesChildRecipients.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesChildRecipients"`.

- [ ] **Step 2: Implement `SeriesChildRecipients.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { fetchChildOverrides, fetchOrgContacts, setChildRecipientOverride } from './seriesApi';
import { matchesRecipientRule } from './seriesConfig';
import type { OrgContact, RecipientChoice, SeriesRecipientRule } from './types';

const CHOICES: RecipientChoice[] = ['default', 'add', 'remove'];

/**
 * A series child's only editable surface (spec D5, §3.5): per-contact add /
 * remove overrides on top of the series rule. `rule` is null when the viewer
 * cannot read the series (org users) — then no "Included by rule" hint.
 */
export function SeriesChildRecipients({ reportId, orgId, rule }: { reportId: string; orgId: string; rule: SeriesRecipientRule | null }) {
  const { t } = useTranslation('reports');
  const [contacts, setContacts] = useState<OrgContact[]>([]);
  const [choices, setChoices] = useState<Map<string, RecipientChoice>>(new Map());
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedContacts, overrides] = await Promise.all([fetchOrgContacts(orgId), fetchChildOverrides(reportId)]);
      setContacts(loadedContacts);
      setChoices(new Map(overrides.map((o) => [o.contactId, o.mode])));
      setState('ready');
    } catch (err) {
      console.error('[SeriesChildRecipients] load failed', err);
      setState('failed');
    }
  }, [orgId, reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (contact: OrgContact, next: RecipientChoice) => {
    const current = choices.get(contact.id) ?? 'default';
    if (next === current) return;
    setBusyId(contact.id);
    try {
      await setChildRecipientOverride(reportId, contact.id, current, next, {
        errorFallback: t('reports.series.child.recipients.updateFailed'),
        successMessage: t('reports.series.child.recipients.updated'),
      });
      setChoices((prev) => new Map(prev).set(contact.id, next));
    } catch (err) {
      handleActionError(err, t('reports.series.child.recipients.updateFailed'));
      // A switch is DELETE-then-POST; after a partial failure only the server knows.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section data-testid="series-child-recipients" className="space-y-3 rounded-lg border bg-card p-6 shadow-xs">
      <div>
        <h2 className="text-sm font-semibold">{t('reports.series.child.recipients.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('reports.series.child.recipients.description')}</p>
      </div>
      {state === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
      {state === 'failed' && <p role="status" className="text-sm text-destructive">{t('reports.series.child.recipients.loadFailed')}</p>}
      {state === 'ready' && contacts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('reports.series.child.recipients.empty')}</p>
      )}
      {state === 'ready' && contacts.length > 0 && (
        <ul className="divide-y">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm">
                {contact.name || contact.email}
                {contact.name && <span className="block text-xs text-muted-foreground">{contact.email}</span>}
                {rule && matchesRecipientRule(contact, rule) && (
                  <span data-testid={`series-child-by-rule-${contact.id}`} className="block text-xs text-primary">
                    {t('reports.series.child.recipients.byRule')}
                  </span>
                )}
              </span>
              <select
                data-testid={`series-child-recipient-${contact.id}`}
                aria-label={contact.name || contact.email || contact.id}
                value={choices.get(contact.id) ?? 'default'}
                disabled={busyId === contact.id}
                onChange={(e) => void change(contact, e.target.value as RecipientChoice)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t(/* i18n-dynamic */ `reports.series.child.recipients.${choice}`)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Write the failing banner/view test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ canChoose: true }));
vi.mock('../ReportOwnerScopeField', () => ({ useDefaultReportOwnerScope: () => ({ canChoose: gate.canChoose }) }));
const claims = vi.hoisted(() => ({ value: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const api = vi.hoisted(() => ({
  fetchSeriesDetail: vi.fn(),
  detachSeriesChild: vi.fn(() => Promise.resolve()),
  fetchOrgContacts: vi.fn(() => Promise.resolve([])),
  fetchChildOverrides: vi.fn(() => Promise.resolve([])),
  setChildRecipientOverride: vi.fn(),
}));
vi.mock('./seriesApi', () => api);

import { SeriesChildView } from './SeriesChildLockBanner';
import type { Report } from '../ReportsList';

const CHILD = {
  id: 'rep-child', name: 'Monthly health', type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {},
  orgId: 'org-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '',
  seriesId: 's-1', seriesName: 'Monthly health', archivedAt: null,
} as Report;

describe('SeriesChildView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.canChoose = true;
    claims.value = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    api.fetchSeriesDetail.mockResolvedValue({ series: { recipientRule: { primaryContact: true, roles: [] } }, targets: [], orgs: [] });
  });

  it('an MSP user sees the series name, Edit multi-org report and Detach, plus recipients', async () => {
    render(<SeriesChildView report={CHILD} onChanged={vi.fn()} />);
    const banner = screen.getByTestId('series-child-lock-banner');
    expect(banner).toHaveAttribute('data-variant', 'msp');
    expect(banner).toHaveTextContent('Part of the multi-org report “Monthly health”');
    expect(screen.getByTestId('series-child-edit-series')).toHaveAttribute('href', '/reports/series/s-1');
    expect(screen.getByTestId('series-child-detach')).toBeInTheDocument();
    expect(screen.getByTestId('series-child-summary')).toBeInTheDocument();
    expect(await screen.findByTestId('series-child-recipients')).toBeInTheDocument();
    await waitFor(() => expect(api.fetchSeriesDetail).toHaveBeenCalledWith('s-1'));
  });

  // Review Focus 5.
  it('an organization user sees Managed by your MSP and never asks for the series', async () => {
    gate.canChoose = false;
    claims.value = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    render(<SeriesChildView report={CHILD} onChanged={vi.fn()} />);
    expect(screen.getByTestId('series-child-lock-banner')).toHaveAttribute('data-variant', 'managed');
    expect(screen.getByTestId('series-child-managed-badge')).toHaveTextContent('Managed by your MSP');
    expect(screen.queryByTestId('series-child-edit-series')).toBeNull();
    expect(screen.queryByTestId('series-child-detach')).toBeNull();
    expect(await screen.findByTestId('series-child-recipients')).toBeInTheDocument();
    expect(api.fetchSeriesDetail).not.toHaveBeenCalled();
  });

  it('Detach confirms, detaches, and reloads the page state', async () => {
    const onChanged = vi.fn();
    render(<SeriesChildView report={CHILD} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('series-child-detach'));
    fireEvent.click(screen.getByTestId('series-confirm-child-detach'));
    await waitFor(() => expect(api.detachSeriesChild).toHaveBeenCalledWith('rep-child', expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('an archived copy says so and offers no recipient editing or Detach', () => {
    render(<SeriesChildView report={{ ...CHILD, archivedAt: '2026-10-02T00:00:00Z' }} onChanged={vi.fn()} />);
    expect(screen.getByTestId('series-child-archived')).toBeInTheDocument();
    expect(screen.queryByTestId('series-child-detach')).toBeNull();
    expect(screen.queryByTestId('series-child-recipients')).toBeNull();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesChildLockBanner.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesChildLockBanner"`.

- [ ] **Step 4: Implement `SeriesChildLockBanner.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Layers, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { handleActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useDefaultReportOwnerScope } from '../ReportOwnerScopeField';
import type { Report } from '../ReportsList';
import { SeriesChildRecipients } from './SeriesChildRecipients';
import { detachSeriesChild, fetchSeriesDetail } from './seriesApi';
import type { SeriesRecipientRule } from './types';

export type SeriesChildAccess = 'msp' | 'readonly' | 'managed';

/** msp = may administer the series; readonly = MSP staff without partner-wide
 *  rights; managed = an organization user. Unresolved fails closed (managed). */
export function useSeriesChildAccess(): SeriesChildAccess {
  const { canChoose } = useDefaultReportOwnerScope();
  const claims = useJwtClaims();
  if (canChoose) return 'msp';
  if (claims.status === 'resolved' && claims.claims.scope === 'partner') return 'readonly';
  return 'managed';
}

export function SeriesChildLockBanner({ report, access, onDetached }: { report: Report; access: SeriesChildAccess; onDetached: () => void }) {
  const { t } = useTranslation('reports');
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const archived = Boolean(report.archivedAt);

  const detach = async () => {
    setDetaching(true);
    try {
      await detachSeriesChild(report.id, {
        errorFallback: t('reports.series.drilldown.detachFailed'),
        successMessage: t('reports.series.drilldown.detached', { org: report.name }),
      });
      onDetached();
    } catch (err) {
      handleActionError(err, t('reports.series.drilldown.detachFailed'));
    } finally {
      setDetaching(false);
    }
  };

  return (
    <div data-testid="series-child-lock-banner" data-variant={access} className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {access === 'managed' ? (
          <span data-testid="series-child-managed-badge" className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <Lock className="h-3 w-3" />
            {t('reports.series.child.managedByMsp')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm font-medium">
            <Layers className="h-4 w-4" />
            {report.seriesName
              ? t('reports.series.child.partOf', { name: report.seriesName })
              : t('reports.series.child.partOfUnnamed')}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {access === 'managed' ? t('reports.series.child.managedExplanation') : t('reports.series.child.lockedExplanation')}
      </p>
      {archived && (
        <p data-testid="series-child-archived" role="status" className="text-sm text-warning">{t('reports.series.child.archived')}</p>
      )}
      {access === 'msp' && (
        <div className="flex flex-wrap gap-2">
          <a
            data-testid="series-child-edit-series"
            href={`/reports/series/${report.seriesId}`}
            className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-sm hover:bg-muted"
          >
            {t('reports.series.child.editSeries')}
          </a>
          {!archived && (
            <button
              type="button"
              data-testid="series-child-detach"
              disabled={detaching}
              onClick={() => setConfirmDetach(true)}
              className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              {t('reports.series.child.detach')}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDetach}
        onClose={() => setConfirmDetach(false)}
        onConfirm={() => {
          setConfirmDetach(false);
          void detach();
        }}
        title={t('reports.series.drilldown.detachTitle', { org: report.name })}
        message={t('reports.series.drilldown.detachMessage', { org: report.name })}
        confirmLabel={t('reports.series.drilldown.detachConfirm')}
        variant="warning"
        confirmTestId="series-confirm-child-detach"
      />
    </div>
  );
}

/** Read-only view of the series-owned fields (spec §3.7 "shown locked"). */
export function SeriesChildSummary({ report }: { report: Report }) {
  const { t } = useTranslation('reports');
  const rows: [string, string][] = [
    [t('reports.series.child.summary.type'), t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${report.type}`)],
    [t('reports.series.child.summary.schedule'), t(/* i18n-dynamic */ `reports.reportsList.schedules.${report.schedule}`)],
    [t('reports.series.child.summary.format'), t(/* i18n-dynamic */ `reports.reportsList.formats.${report.format}`)],
  ];
  return (
    <dl data-testid="series-child-summary" className="grid gap-3 rounded-lg border bg-card p-6 text-sm shadow-xs sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
          <dd className="mt-1">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The whole edit page body for a series child: banner, locked summary, and the
 * per-org recipient overrides. Never renders ReportBuilder — every other write
 * would answer 409 series_managed.
 */
export function SeriesChildView({ report, onChanged }: { report: Report; onChanged: () => void }) {
  const access = useSeriesChildAccess();
  const [rule, setRule] = useState<SeriesRecipientRule | null>(null);

  useEffect(() => {
    // Only a user who may read report_series asks for it (Review Focus 5).
    if (access !== 'msp' || !report.seriesId) return;
    let live = true;
    fetchSeriesDetail(report.seriesId)
      .then((detail) => {
        if (live && detail) setRule(detail.series.recipientRule);
      })
      .catch((err: unknown) => {
        // The rule only powers the "Included by rule" hint; editing still works.
        console.warn('[SeriesChildView] series rule unavailable', err);
      });
    return () => {
      live = false;
    };
  }, [access, report.seriesId]);

  return (
    <div className="space-y-6">
      <SeriesChildLockBanner report={report} access={access} onDetached={onChanged} />
      <SeriesChildSummary report={report} />
      {!report.archivedAt && report.orgId && (
        <SeriesChildRecipients reportId={report.id} orgId={report.orgId} rule={rule} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Branch in `ReportEditPage.tsx`**

**5a. Import.** Add `import { SeriesChildView } from './series/SeriesChildLockBanner';` next to the other imports.

**5b. Branch.** Directly after the `if (error || !report) { … }` block, before `// Convert report config to form values`, insert:

```tsx
  // A multi-org series child (W02 `seriesId`): shared fields are locked; only
  // the org's recipient overrides and (for the MSP) Detach are offered.
  if (report.seriesId) {
    return (
      <div className="space-y-6">
        <Breadcrumbs items={[
          { label: t('reports.reportEditPage.reportsBreadcrumb'), href: '/reports' },
          { label: report.name || t('reports.reportEditPage.title') }
        ]} />
        <div className="flex items-center gap-4">
          <a
            href="/reports"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
            aria-label={t('reports.reportEditPage.backToReports')}
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportEditPage.title')}</h1>
            <p className="text-muted-foreground">{report.name}</p>
          </div>
        </div>
        <SeriesChildView report={report} onChanged={fetchReport} />
      </div>
    );
  }
```

All hooks in `ReportEditPage` are declared above both early returns, so the hook order is unchanged.

- [ ] **Step 6: Run the child-view and edit-page suites**

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesChildRecipients.test.tsx src/components/reports/series/SeriesChildLockBanner.test.tsx src/components/reports/ReportEditPage`
Expected: PASS (3 + 4 tests, plus every existing `ReportEditPage.*` suite unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/reports/series/SeriesChildRecipients.tsx apps/web/src/components/reports/series/SeriesChildRecipients.test.tsx apps/web/src/components/reports/series/SeriesChildLockBanner.tsx apps/web/src/components/reports/series/SeriesChildLockBanner.test.tsx apps/web/src/components/reports/ReportEditPage.tsx
git commit -m "feat(reports): locked series child view with per-org recipient overrides (W03 Task 10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Templates — the Covers control in the posture and lifecycle modals

**Files:**
- Create: `apps/web/src/components/reports/series/SeriesScheduleField.tsx`, `SeriesScheduleField.test.tsx`
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx`
- Create: `apps/web/src/components/reports/ReportTemplates.series.test.tsx`

**Scope:**
- Builder-routed templates already get the Covers control through `ReportBuilder` (Task 5).
- The business modal keeps `ReportOwnerScopeField` (Contract concern 6, decision). It is untouched here, and so is `business-reports.spec.ts`.
- The four managed-evidence modals cannot fan out (Contract concern 7). They keep W01's page-level org picker.
- That leaves posture and lifecycle, the two direct-create curated types a series supports.
- W01 makes the Templates page pick its org **once, at page level** (`orgTarget = useReportTargetOrg()`), and refuses to open a non-business template while `orgTarget.missing`. A series has no single org, so W03 relaxes that guard for a partner-wide user and a series-eligible type. Everyone else keeps W01's behaviour exactly; W01's `ReportTemplates.orgPicker.test.tsx` fixture is token-less, so its "does not open until an org is chosen" case still holds.

**Interfaces:**
- Consumes:
  - `CoversControl` (Task 4), `createSeries`, `stripSeriesConfig`, `isSeriesEligibleReportType` (Task 1);
  - W01's `orgTarget` and `reports.orgPicker.chooseFirst` (W01 plan Task 8);
  - the file's existing `canChooseOwnerScope` (from `useDefaultReportOwnerScope`, `ReportTemplates.tsx:609-613`).
- Produces:
  - `SeriesScheduleField({ value, onChange, showRequired })`, where `value: SeriesSchedule | ''`;
  - `covers` and `seriesSchedule` arguments on `handleCreateDirect`;
  - testids `template-covers-<templateType>`, `template-covers-org-hint`, `series-schedule-field`, `series-schedule-select`, `series-schedule-hint`, `series-schedule-required`.
- **Schedule rule (coordinator ruling, Contract concern 7c):** a series is recurring-only. In series mode the modal shows a required schedule select. It is pre-filled only from a template whose own schedule is already recurring (lifecycle: `monthly`); a one-time template (posture) leaves it empty, the hint says why, and Create is refused client-side until the user picks one. Nothing is ever substituted silently.

- [ ] **Step 0: `SeriesScheduleField` (red, then green)**

Create `apps/web/src/components/reports/series/SeriesScheduleField.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SeriesScheduleField } from './SeriesScheduleField';

describe('SeriesScheduleField', () => {
  it('starts empty, offers only recurring schedules, and explains why', () => {
    render(<SeriesScheduleField value="" onChange={vi.fn()} showRequired={false} />);
    const select = screen.getByTestId('series-schedule-select');
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'daily', 'weekly', 'monthly']);
    expect(screen.getByTestId('series-schedule-hint')).toHaveTextContent("can't be one-time");
    expect(screen.queryByTestId('series-schedule-required')).toBeNull();
  });

  it('emits the chosen schedule and shows the required message when asked', () => {
    const onChange = vi.fn();
    render(<SeriesScheduleField value="" onChange={onChange} showRequired />);
    expect(screen.getByTestId('series-schedule-required')).toHaveTextContent('Choose how often the report is sent.');
    fireEvent.change(screen.getByTestId('series-schedule-select'), { target: { value: 'weekly' } });
    expect(onChange).toHaveBeenCalledWith('weekly');
  });
});
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesScheduleField.test.tsx`
Expected: FAIL. The error is `Failed to resolve import "./SeriesScheduleField"`.

Create `apps/web/src/components/reports/series/SeriesScheduleField.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { SERIES_SCHEDULES, isSeriesSchedule } from './seriesConfig';
import type { SeriesSchedule } from './types';

/**
 * The recurring schedule a template-created series needs (INDEX: the series
 * schema rejects one_time). Required, and never defaulted from a one-time
 * template: the user picks it.
 */
export function SeriesScheduleField({
  value,
  onChange,
  showRequired,
}: {
  value: SeriesSchedule | '';
  onChange: (next: SeriesSchedule | '') => void;
  showRequired: boolean;
}) {
  const { t } = useTranslation('reports');
  return (
    <div data-testid="series-schedule-field" className="space-y-1">
      <label htmlFor="series-schedule" className="text-sm font-medium">{t('reports.series.schedule.label')}</label>
      <select
        id="series-schedule"
        data-testid="series-schedule-select"
        required
        aria-invalid={showRequired}
        value={value}
        onChange={(e) => onChange(isSeriesSchedule(e.target.value) ? e.target.value : '')}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
      >
        <option value="">{t('reports.series.schedule.placeholder')}</option>
        {SERIES_SCHEDULES.map((schedule) => (
          <option key={schedule} value={schedule}>
            {t(/* i18n-dynamic */ `reports.reportsList.schedules.${schedule}`)}
          </option>
        ))}
      </select>
      <p data-testid="series-schedule-hint" className="text-xs text-muted-foreground">{t('reports.series.schedule.hint')}</p>
      {showRequired && (
        <p data-testid="series-schedule-required" role="alert" className="text-xs text-destructive">
          {t('reports.series.schedule.required')}
        </p>
      )}
    </div>
  );
}
```

Run: `cd apps/web && npx vitest run src/components/reports/series/SeriesScheduleField.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ user: { canManagePartnerWide: true } }),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } }),
}));
// Two orgs, none focused: W01's page picker is visible and nothing is picked.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({
    currentOrgId: null,
    organizations: [
      { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
      { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
    ],
  }),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

const ok = (payload: unknown, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });
const posts = (url: string) => fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string })?.method === 'POST');

async function useTemplate(name: string) {
  const heading = await screen.findByText(name);
  await userEvent.setup().click(within(heading.closest('div.group') as HTMLElement).getByRole('button', { name: /use template/i }));
}

describe('ReportTemplates — one report per organization (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/reports/series' && init?.method === 'POST') return ok({ series: { id: 's-t' }, targets: [], orgs: [] }, 201);
      if (url === '/reports/series/recipients/preview') return ok({ totalCustomerRecipients: 1, orgCount: 2, orgsWithoutCustomerRecipient: [] });
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  it('a partner-wide user opens a lifecycle template with no org picked and creates a series', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Hardware Lifecycle Report');
    const covers = screen.getByTestId('template-covers-hardware_lifecycle');
    await user.click(within(covers).getByTestId('covers-mode-series'));
    // A recurring template pre-fills its own schedule.
    expect(within(covers).getByTestId('series-schedule-select')).toHaveValue('monthly');
    await user.click(screen.getByTestId('lifecycle-create-report'));
    await waitFor(() => expect(posts('/reports/series')).toHaveLength(1));
    const body = JSON.parse((posts('/reports/series')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      type: 'hardware_lifecycle', schedule: 'monthly', targetMode: 'all', orgIds: [],
      recipientRule: { primaryContact: true, roles: [] },
      config: { replaceAgeYears: 4 },
    });
    expect(body).not.toHaveProperty('orgId');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-t'));
  });

  it('staying on one organization with none picked still sends nothing (W01 guard)', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Hardware Lifecycle Report');
    expect(within(screen.getByTestId('template-covers-hardware_lifecycle')).getByTestId('template-covers-org-hint')).toBeInTheDocument();
    await user.click(screen.getByTestId('lifecycle-create-report'));
    expect(posts('/reports')).toHaveLength(0);
    expect(posts('/reports/series')).toHaveLength(0);
  });

  it('a one-time posture template leaves the series schedule empty and refuses to create until one is picked', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Security & Compliance Posture (Insurance)');
    const covers = screen.getByTestId('template-covers-security_compliance_posture');
    await user.click(within(covers).getByTestId('covers-mode-series'));
    const select = within(covers).getByTestId('series-schedule-select');
    expect(select).toHaveValue('');
    expect(within(covers).getByTestId('series-schedule-hint')).toHaveTextContent("can't be one-time");
    await user.click(screen.getByTestId('posture-options-submit'));
    expect(posts('/reports/series')).toHaveLength(0);
    expect(within(covers).getByTestId('series-schedule-required')).toBeInTheDocument();
    await user.selectOptions(select, 'weekly');
    expect(within(covers).queryByTestId('series-schedule-required')).toBeNull();
    await user.click(screen.getByTestId('posture-options-submit'));
    await waitFor(() => expect(posts('/reports/series')).toHaveLength(1));
    expect(JSON.parse((posts('/reports/series')[0]![1] as { body: string }).body).schedule).toBe('weekly');
  });
});
```

The posture card's display name (`Security & Compliance Posture (Insurance)`) and its submit testid (`posture-options-submit`) are the ones `ReportTemplates.posture.test.tsx:66-67` already uses at 92764125ed.

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.series.test.tsx`
Expected: FAIL. The lifecycle cases fail with `Unable to find an element by: [data-testid="template-covers-hardware_lifecycle"]`, because W01's guard keeps the modal closed; the posture case fails on `template-covers-security_compliance_posture`.

- [ ] **Step 2: Implement in `ReportTemplates.tsx`**

**2a. Imports.**

```ts
import { CoversControl } from './series/CoversControl';
import { createSeries } from './series/seriesApi';
import { SeriesScheduleField } from './series/SeriesScheduleField';
import { isSeriesEligibleReportType, isSeriesSchedule, stripSeriesConfig } from './series/seriesConfig';
import type { CoversValue, SeriesSchedule } from './series/types';
```

**2b. State.** Next to the other modal state:

```ts
  // W03: Covers for the posture / lifecycle modals (the two curated
  // direct-create types a series supports). Reset on every modal open. The
  // single-org target stays W01's page-level orgTarget.
  const [templateCovers, setTemplateCovers] = useState<CoversValue>({ mode: 'org' });
  // Recurring-only (Contract concern 7c): pre-filled from a recurring template,
  // empty for a one-time one; never substituted.
  const [templateSeriesSchedule, setTemplateSeriesSchedule] = useState<SeriesSchedule | ''>('');
  const [seriesScheduleMissing, setSeriesScheduleMissing] = useState(false);
```

**2c. Relax W01's open guard in `handleUseTemplate`.** W01's guard reads:

```ts
      if (!isBusinessReportType(type) && orgTarget.missing) {
```

Replace it with:

```ts
      // W03: a partner-wide user may open a series-eligible template with no
      // org picked — it can be sent as one report per organization. The org
      // is still required (handleCreateDirect, and the builder's own guard)
      // if they keep it to one organization.
      const mayFanOut = canChooseOwnerScope && isSeriesEligibleReportType(type);
      if (!isBusinessReportType(type) && orgTarget.missing && !mayFanOut) {
```

In the posture and lifecycle branches of the same function, add these three lines just before `setPostureTemplate(template);` and before `setLifecycleTemplate(template);`:

```ts
        setTemplateCovers({ mode: 'org' });
        setTemplateSeriesSchedule(isSeriesSchedule(template.defaults.schedule) ? template.defaults.schedule : '');
        setSeriesScheduleMissing(false);
```

Add `canChooseOwnerScope` to its dependency list.

**2d. The series branch in `handleCreateDirect`.**

Add a fourth and a fifth parameter, `covers?: CoversValue` and `seriesSchedule?: SeriesSchedule | ''`. Change W01's first-statement guard:

```ts
      if (owner === 'organization' && orgTarget.missing) {
```

to:

```ts
      if (owner === 'organization' && covers?.mode !== 'series' && orgTarget.missing) {
```

At the top of the `try` block, insert:

```ts
        if (covers?.mode === 'series') {
          if (covers.targetMode === 'selected' && covers.orgIds.length === 0) {
            showToast({ type: 'error', message: t('reports.series.targeting.noneSelected') });
            return;
          }
          // Recurring-only: the user must have picked a schedule (never defaulted
          // from a one-time template). The field shows the required message.
          if (!seriesSchedule) {
            setSeriesScheduleMissing(true);
            return;
          }
          const name = template.defaults.name ?? template.name;
          const created = await createSeries(
            {
              name,
              type: template.defaults.type as string,
              format: template.defaults.format ?? 'pdf',
              schedule: seriesSchedule,
              config: stripSeriesConfig({ dateRange: template.defaults.dateRange ?? { preset: 'last_30_days' }, ...postureConfig }),
              targetMode: covers.targetMode,
              orgIds: covers.orgIds,
              recipientRule: covers.recipientRule,
              internalCc: covers.internalCc,
            },
            {
              errorFallback: t('reports.series.builder.saveFailed'),
              successMessage: t('reports.series.builder.created', { name }),
            },
          );
          void navigateTo(created?.series?.id ? `/reports#series/${created.series.id}` : '/reports');
          return;
        }
```

The rest of the function is unchanged:
- the existing `catch {}` treats every thrown error as already surfaced by `runAction`, and `finally` clears `creatingId`;
- the org body keeps W01's `...(orgTarget.orgId ? { orgId: orgTarget.orgId } : {})`.

Import `showToast` from `'../shared/Toast'` if the file does not already. It is a module import, so it stays out of the dependency list.

**2e. Render.** In the lifecycle modal, replace `<div className="mt-5">` with:

```tsx
            <div className="mt-5 space-y-4">
              <div data-testid={`template-covers-${lifecycleTemplate.defaults.type}`}>
                <CoversControl
                  reportType="hardware_lifecycle"
                  value={templateCovers}
                  onChange={setTemplateCovers}
                  withSeriesRecipients
                  seriesExtra={
                    <SeriesScheduleField
                      value={templateSeriesSchedule}
                      onChange={(next) => {
                        setTemplateSeriesSchedule(next);
                        setSeriesScheduleMissing(false);
                      }}
                      showRequired={seriesScheduleMissing}
                    />
                  }
                  orgField={
                    orgTarget.missing ? (
                      <p data-testid="template-covers-org-hint" role="status" className="text-xs text-muted-foreground">
                        {t('reports.orgPicker.chooseFirst')}
                      </p>
                    ) : null
                  }
                />
              </div>
```

Then change its `onSubmit` to `void handleCreateDirect(lifecycleTemplate, { ...lifecycleOptions }, 'organization', templateCovers, templateSeriesSchedule);`.

Make the same change in the posture modal:
- wrapper testid `template-covers-${postureTemplate.defaults.type}`;
- `reportType="security_compliance_posture"`;
- the same `seriesExtra` and `orgField`;
- `onSubmit` becomes `void handleCreateDirect(postureTemplate, { backupRequired }, 'organization', templateCovers, templateSeriesSchedule);`.

- [ ] **Step 3: Run the new and existing template suites**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates src/components/reports/series/SeriesScheduleField.test.tsx`
Expected: PASS. This covers:
- `ReportTemplates.series.test.tsx` (3 tests) and `SeriesScheduleField.test.tsx` (2 tests);
- W01's `ReportTemplates.orgPicker.test.tsx`;
- every existing `ReportTemplates.*` suite.

Their fixtures carry no token, so `canChooseOwnerScope` is false: W01's guard is unrelaxed, and `CoversControl` renders org mode only, with the same request body as before.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/reports/ReportTemplates.tsx apps/web/src/components/reports/ReportTemplates.series.test.tsx apps/web/src/components/reports/series/SeriesScheduleField.tsx apps/web/src/components/reports/series/SeriesScheduleField.test.tsx
git commit -m "feat(reports): one-report-per-org from the posture and lifecycle templates (W03 Task 11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Seven locale catalogs

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`, which get the whole `reports.series` block.
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/pages.json`, which get `titles.reportsSeriesEdit`.
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `translationCoverage.test.ts`, `terminologyQuality.test.ts`, `keyUsage.test.ts`. All exist already, and none is edited unless Step 3 applies.

- [ ] **Step 1: Confirm the red**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`
Expected: FAIL, listing the `reports.series.*` keys and `titles.reportsSeriesEdit` as missing in seven catalogs.

- [ ] **Step 2: Translate**

Put every key of the English `reports.series` block (Task 1 Step 10) into each of the seven `reports.json` files, in the same position (the last key of `reports`), with a **real translation**. The rules:
- Keep every interpolation token byte-identical: `{{covered}}`, `{{total}}`, `{{count}}`, `{{names}}`, `{{email}}`, `{{name}}`, `{{date}}`, `{{delivered}}`, `{{org}}`.
- Keep every `_one` / `_other` pair.
- Keep the typographic quotes and the ellipsis (`…`) as characters.

Add `titles.reportsSeriesEdit` to each `pages.json` after `reportsNew`. Pinned terms, checked against the neighbouring `reports.json` vocabulary (`reportEditPage`, `ownerScope`) of each catalog:

| English | de-DE | es-419 | fr-FR / fr-CA | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| multi-org report | Multi-Organisations-Bericht | informe multiorganización | rapport multi-organisation | report multi-organizzazione | relatório multiorganização | çok kuruluşlu rapor |
| organization | Organisation | organización | organisation | organizzazione | organização | kuruluş |
| copy (one org's report) | Kopie | copia | copie | copia | cópia | kopya |
| Exclude / Include | Ausschließen / Einschließen | Excluir / Incluir | Exclure / Inclure | Escludi / Includi | Excluir / Incluir | Hariç tut / Dahil et |
| Detach | Abkoppeln | Desvincular | Détacher | Scollega | Desvincular | Ayır |
| owner | Eigentümer | propietario | propriétaire | proprietario | proprietário | sahip |
| Managed by your MSP | Von Ihrem MSP verwaltet | Administrado por su MSP | Géré par votre MSP | Gestito dal tuo MSP | Gerenciado pelo seu MSP | MSP'niz tarafından yönetiliyor |
| Internal copies | Interne Kopien | Copias internas | Copies internes | Copie interne | Cópias internas | Dahili kopyalar |

`titles.reportsSeriesEdit` in each locale is "Edit" plus the multi-org report term from this table, in the casing that catalog uses for its other `titles.*` entries.

- [ ] **Step 3: Run the locale suites**

Run: `cd apps/web && npx vitest run src/lib/i18n/ src/components/reports/reportsPtBR.test.ts`
Expected: PASS. That covers `localeParity`, `translationCoverage`, `terminologyQuality`, `keyUsage`, `extractionQuality` and `titleKeyUsage`.

If `translationCoverage` reports new exact-English duplicates, bump that locale's `reports.json` baseline by the reported count, with a one-line comment naming the keys. Expected duplicates: "MSP" inside "Managed by your MSP" is a proper noun and not a whole-string duplicate, but `ccPlaceholder` (`name@example.com`) is locale-invariant. Do not bump for anything else: translate it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "i18n(reports): multi-org report series in eight locales (W03 Task 12)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Guard registration and whole-wave verification

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` and the count assertion)

- [ ] **Step 1: Guard the client**

In `TARGET_GLOBS`, after the `'src/components/reports/ReportTemplates.tsx',` entry, add:

```ts
  // Multi-org report series (W03): the one client for every series mutation
  // (create/edit/targets/transfer/delete/detach, per-org run, recipient
  // overrides). A silent failure here reads as "this org was excluded" or
  // "this customer will receive it" when neither is true.
  'src/components/reports/series/seriesApi.ts',
```

In the count test, bump the literal by one from whatever it reads after the rebase (`expect(absoluteFiles.length).toBe(N)` becomes `N + 1`). Append the history line `// Multi-org report series W03 adds reports/series/seriesApi.ts: N → N+1.`.

- [ ] **Step 2: Run the guard**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS. If it names `previewSeriesRecipients`, the `// runaction-exempt:` comment is not on the statement directly enclosing the `fetchWithAuth` call; move it there.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec astro check`
Expected: `0 errors`.

- [ ] **Step 4: Full web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS, with no failed files. Compare the file count with a `main` run. It should be higher by exactly the new test files: 14 under `series/`, plus `contactRoles.test.ts`, `ReportBuilder.series.test.tsx`, `ReportsList.series.test.tsx` and `ReportTemplates.series.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "test(web): guard the series client with no-silent-mutations (W03 Task 13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: E2E — create series → drill-down → exclude → delete

**Files:**
- Modify: `e2e-tests/pages/ReportsPage.ts`
- Create: `e2e-tests/tests/report-series.spec.ts`

**Interfaces:**
- Consumes: the testids from Tasks 4, 5, 7, 8 and 9; the `authedPage` fixture (a Partner Admin with `org_access='all'`, the same login as `business-reports.spec.ts`).

- [ ] **Step 1: Extend the Page Object**

Add to the `ReportsPage` class:

```ts
  newReportUrl = '/reports/new';

  // Covers + series form (/reports/new)
  coversControl = () => this.page.getByTestId('covers-control');
  coversModeSeries = () => this.page.getByTestId('covers-mode-series');
  seriesTargetModeAll = () => this.page.getByTestId('series-target-mode-all');
  seriesRulePrimary = () => this.page.getByTestId('series-rule-primary');
  seriesRecipientPreview = () => this.page.getByTestId('series-recipient-preview');
  builderName = () => this.page.getByTestId('report-builder-name');
  builderSubmit = () => this.page.getByTestId('report-builder-submit');

  // Saved list — series rows and drill-down
  seriesRow = (seriesId: string) => this.page.getByTestId(`report-series-row-${seriesId}`);
  seriesDrilldown = (seriesId: string) => this.page.getByTestId(`series-drilldown-${seriesId}`);
  seriesOrgRow = (orgId: string) => this.page.getByTestId(`series-org-row-${orgId}`);
  seriesOrgExclude = (orgId: string) => this.page.getByTestId(`series-org-exclude-${orgId}`);
  confirmExclude = () => this.page.getByTestId('series-confirm-exclude');
  seriesDelete = (seriesId: string) => this.page.getByTestId(`report-series-delete-${seriesId}`);
  confirmDelete = () => this.page.getByTestId('series-confirm-delete');

  /** Series are grouped only on the All-organizations view: select it in the
   *  persisted org store (key `breeze-org`) before the app boots. */
  async useAllOrganizationsView() {
    await this.page.addInitScript(() => {
      let stored: { state?: Record<string, unknown>; version?: number } = {};
      try { stored = JSON.parse(localStorage.getItem('breeze-org') ?? '{}'); } catch { /* fresh */ }
      localStorage.setItem('breeze-org', JSON.stringify({ state: { ...stored.state, currentOrgId: null, allOrgs: true }, version: stored.version ?? 0 }));
    });
  }

  async gotoNewReport() {
    await this.page.goto(this.newReportUrl);
    await waitForAppReady(this.page, 'report-builder-covers');
  }
```

- [ ] **Step 2: Write the spec**

`e2e-tests/tests/report-series.spec.ts`:

```ts
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { ReportsPage } from '../pages/ReportsPage';

/**
 * Multi-org report series (W03), end to end on a real stack:
 * create "One report per organization" (All organizations) from /reports/new →
 * the saved list opens the new series' drill-down → exclude one organization →
 * its line reads Excluded → delete the series (cleanup, and the delete path).
 *
 * Login: E2E_ADMIN_EMAIL, a partner-scope Partner Admin with org_access 'all'
 * — the authority a series owner needs (spec §3.4).
 */
test.beforeEach(clearRefreshState);

test.describe('Multi-org report series', () => {
  test('create, drill down, exclude an organization, delete', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const reports = new ReportsPage(page);
    await reports.useAllOrganizationsView();
    const name = `E2E series ${Date.now()}`;

    await test.step('fill the series form', async () => {
      await reports.gotoNewReport();
      await expect(reports.orgSwitcherTrigger()).not.toHaveAttribute('data-scope', 'org');
      await reports.coversModeSeries().click();
      await expect(reports.seriesTargetModeAll()).toBeChecked();
      await reports.builderName().fill(name);
      // W02 makes a new child due immediately (its "Decisions" list), so the
      // worker's next tick could mail this series before the spec deletes it.
      // With the rule off and no internal CC it resolves to nobody: every run
      // records no_recipients and nothing is sent, even on a stack wired to a
      // live mail key. It also keeps the create outside W02's export+MFA
      // delivery gate (its contract concern 4b).
      await reports.seriesRulePrimary().uncheck();
      // The debounced preview resolves against the real reconciler inputs.
      await expect(reports.seriesRecipientPreview()).toHaveAttribute('data-state', /ready|failed/, { timeout: 15_000 });
    });

    const createResponse = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/v1/reports/series'),
    );
    await reports.builderSubmit().click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    const detail = (await created.json()) as { series: { id: string }; orgs: { orgId: string; state: string }[] };
    const seriesId = detail.series.id;
    const target = detail.orgs.find((o) => o.state === 'active');
    expect(target, `the reconciler created at least one active child: ${JSON.stringify(detail.orgs)}`).toBeTruthy();

    await test.step('the list lands on the new series, expanded', async () => {
      await page.waitForURL(`**/reports#series/${seriesId}`);
      await expect(reports.seriesRow(seriesId)).toBeVisible({ timeout: 15_000 });
      await expect(reports.seriesDrilldown(seriesId)).toBeVisible();
      await expect(reports.seriesOrgRow(target!.orgId)).toHaveAttribute('data-state', 'active');
    });

    await test.step('exclude one organization', async () => {
      const putResponse = page.waitForResponse(
        (res) => res.request().method() === 'PUT' && new URL(res.url()).pathname.endsWith(`/reports/series/${seriesId}/targets`),
      );
      await reports.seriesOrgExclude(target!.orgId).click();
      await reports.confirmExclude().click();
      const put = await putResponse;
      expect(put.status(), await put.text()).toBe(200);
      await expect(reports.seriesOrgRow(target!.orgId)).toHaveAttribute('data-state', 'excluded', { timeout: 15_000 });
    });

    await test.step('delete the series', async () => {
      const deleteResponse = page.waitForResponse(
        (res) => res.request().method() === 'DELETE' && new URL(res.url()).pathname.endsWith(`/reports/series/${seriesId}`),
      );
      await reports.seriesDelete(seriesId).click();
      await reports.confirmDelete().click();
      const deleted = await deleteResponse;
      expect(deleted.ok(), await deleted.text()).toBeTruthy();
      await expect(reports.seriesRow(seriesId)).toHaveCount(0, { timeout: 15_000 });
    });
  });
});
```

- [ ] **Step 3: Typecheck and run the spec against a stack**

Run:

```bash
cd e2e-tests && npx tsc --noEmit
# bring up this worktree's stack (worktree-stack skill), export E2E_BASE_URL/E2E_ADMIN_* from its descriptor, then:
cd e2e-tests && npx playwright test tests/report-series.spec.ts
```

Expected: `tsc` reports no errors, and the spec passes (`1 passed`). Tear the stack down afterwards (`pnpm wt-stack down`) and say so in the PR.

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/pages/ReportsPage.ts e2e-tests/tests/report-series.spec.ts
git commit -m "test(e2e): multi-org report series create, drill-down, exclude, delete (W03 Task 14)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Docs — "Multi-org reports"

**Files:**
- Modify: `apps/docs/src/content/docs/features/reports.mdx`. The new section goes after `## Business Reports` and before `## Downloading and Exporting`. If W02 already added a series API section, put this UI section directly before that section, and link the two with anchors.

- [ ] **Step 1: Add the section**

```mdx
## Multi-org reports (one per organization)

A multi-org report is one definition that produces a **separate copy for every organization it covers**. Each copy is sent to that organization's own contacts. It is not a combined report: combined, cross-organization reports are the partner-owned reports described under [Business Reports](#business-reports).

Only partner users with access to every organization can create or change one.

### Creating one

On **New Report** (or a Hardware Lifecycle / Security & Compliance Posture template), set **Covers** to **One report per organization**, then choose which organizations it covers:

- **All organizations** (default): every current *and future* organization is included automatically. Untick any organization to exclude it. A new organization starts receiving the report within about five minutes of being created.
- **Chosen organizations**: exactly the organizations you tick.

Only active and trial organizations receive a copy. A suspended or offboarding organization's copy is archived, and it comes back automatically if the organization is reactivated.

Site, device and group filters are unavailable here, because each organization's copy covers the whole organization.

A multi-org report always runs on a schedule (daily, weekly or monthly); it can't be one-time. When you start from a one-time template, choose how often it is sent before creating it.

### Who receives each copy

- **The organization's primary contact** and/or **contacts with these roles**. This rule is worked out separately in every organization.
- **Internal copies**: fixed addresses on your team, sent every organization's copy.
- The form previews the result, for example "Resolves to 23 contacts across 17 organizations · 1 organization has no customer recipient: Acme Dental". An organization with no customer recipient is always flagged, never silently skipped.

To change who receives one organization's copy, open that copy (**Edit recipients**). For each contact, choose **Follow rule**, **Always send** or **Never send**.

### The Saved Reports list

On the **All organizations** view, each multi-org report is one row. Its last-run column reads, for example, *Oct 1 · 17/18 delivered · 1 no recipient*. Expand the row to see one line per organization, with these actions:

- **Run now** generates that organization's copy immediately.
- **Edit recipients** opens that organization's copy.
- **Exclude** / **Include** stops or restarts that organization's copy. An excluded copy is archived with its run history, and including it again restores the same copy.
- **Detach** turns that organization's copy into a standalone report you can edit freely. It keeps its run history and stops following the multi-org report.

**Pause** (on the row, or at the top of the expanded list) stops every organization's copy from running until you **Resume** it. A paused report is marked **Paused** in the list.

The **All · Multi-org · Single-org · Combined** chips filter the list. With one organization selected in the switcher, its copy appears as an ordinary row with a **Multi-org** badge that links to the multi-org report.

An organization's copy is locked: only its recipients can be changed there. Organization users see it marked **Managed by your MSP**.

### Owner

Scheduled copies run with the **owner's** access (the creator, by default). If the owner loses access to an organization, that organization's copy shows **Blocked: owner has no access** and does not run. It is never run with anyone else's access. Use **Transfer owner** on the row to hand the report to another partner user with access to every organization.
```

- [ ] **Step 2: Build-check the docs**

Run: `cd apps/docs && pnpm exec astro check`
Expected: `0 errors`.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/features/reports.mdx
git commit -m "docs(reports): multi-org reports (one per organization) (W03 Task 15)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## PR checklist (W03)

- **Body:**
  - state every Contract concern difference found in Task 1 Step 1;
  - confirm that Contract concern 1 (detach excludes) is satisfied by W02;
  - state the settings rule 9 line: no setting added; `pages/settings/**` untouched;
  - end with `Closes #<W03 sub-issue>`.
- **Before enqueueing:**
  - the full web suite (Task 13 Step 4) is green;
  - `astro check` is clean;
  - the E2E spec passes on a stack;
  - one review round (`/pr-review-toolkit:review-pr`), per blast radius "medium".

---

## Self-review

**1. Spec coverage (§3.7, §5 W03)**

| Requirement | Task |
|---|---|
| Covers control: three kinds, series gated on `canManagePartnerWidePolicies` | 4 (control), 5 (builder), 11 (templates) |
| Series recipients: rule checkboxes, role picker from contact roles, internal CC, live preview | 2 |
| All orgs + exclusions / Chosen orgs | 3 |
| Site / device / group filters disabled with an explanation | 5 (+ `stripSeriesConfig`, Task 1) |
| Create → `POST /reports/series`; edit → `PATCH` + `PUT /targets` | 5, 6 |
| Series as one expandable row, drill-down columns and actions (Run now, Edit recipients, Exclude, Detach) | 7, 8 |
| Last-run summary "Oct 1 · 17/18 delivered · 1 no recipient ⚠" | 7 (`summarizeSeriesDelivery`, `SeriesListRow`) |
| Filter chips All · Multi-org · Single-org · Combined, combined with the switcher | 7 |
| One org selected: children as rows with a Multi-org badge linking to the series | 7 |
| Recent Runs Series column (Org column is W01) | 7 |
| Transfer owner (§3.4) | 9 |
| Pause/Resume a series (`PATCH {enabled}`), Paused badge in Covers and Last-run cells and the drill-down header (coordinator ruling) | 9 |
| Recurring-only series schedule; a one-time template never silently becomes monthly (coordinator ruling) | 5 (guard), 11 (`SeriesScheduleField`) |
| Locked child view, recipients only, "Edit multi-org report" + Detach, "Managed by your MSP" | 10 |
| Templates: the same Covers control | 5 (builder-routed), 11 (direct-create posture and lifecycle) |
| `runAction` on every mutation | 1 (client), 13 (guard) |
| Component tests: series form, drill-down actions, locked child view | 5, 8, 10 |
| Hash state, testids, locales, E2E | 7, all, 1 + 12, 14 |

**Not mapped:**
- **Combine (§3.8).** This is W04.

**2. Placeholder scan.** Every edit to W01 code quotes W01's identifiers from the W01 plan:
- Task 5 Step 3c/3f edits the `orgTarget` / `targetOrgId` / `orgMissing` block and the details-card picker.
- Task 11 Step 2 edits the page-level `orgTarget` guard.

Task 1 Step 1 re-greps each identifier against the merged code. Everything else is literal code.

**3. Type consistency.** Names are used identically across tasks:
- `CoversValue` / `SeriesCoversFields` / `SeriesTargets` (Task 1) are used in Tasks 3, 4, 5, 6, 11.
- `SeriesDetail` has the same `{ series, targets, orgs }` shape everywhere.
- `formatReportsListHash({ filter: 'all', seriesId })` equals `` `series/${id}` ``, the literal that Tasks 5, 6 and 11 navigate to; `listModel.test.ts` pins this.
- `RecipientChoice` is shared by `seriesApi.setChildRecipientOverride` and `SeriesChildRecipients`.

**4. Review Focus.** All five items are pinned by named tests: Task 7/8 (1), Task 2 (2), Tasks 3/4/5 (3), Task 6 (4) and Task 10 (5).
