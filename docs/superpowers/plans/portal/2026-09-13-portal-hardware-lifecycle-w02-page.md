---
tracking_issue: LanternOps/breeze#5728
---
# Portal Hardware Lifecycle W02: Page and Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only portal page that renders the org's latest `hardware_lifecycle` run summary through six section components (status bar, schedule, plan tables, other equipment, recommendations, closing line), plus the Reports-page card that links to it. No timeline hover yet (that is W03); the timeline cell renders its fill and label only.

**Architecture:** `apps/portal/src/pages/reports/lifecycle.astro` server-fetches via `portalApi.getHardwareLifecycleLatest()` (calling `GET /portal/reports/lifecycle/latest` from W01) and mounts `LifecyclePage.tsx`, a composition root owning the Refresh button's request state (mirroring `ReportRunList`'s `generate()`) and laying out the section components in the PDF's exact order. Every number, colour and sentence comes from `HardwareLifecycleSummary` or from calling the shared helpers in `packages/shared/src/utils/hardwareLifecycle.ts`; no component recomputes anything the shared module already derives.

**Tech Stack:** Astro + React islands, Vitest + Testing Library (`apps/portal` has no i18n; strings are English), `apps/portal`'s existing Tailwind token system (`bg-primary`, `text-success-on-tint`, etc. via `ui.tsx`'s `MarkTone`).

**Spec:** `docs/superpowers/specs/portal/2026-09-13-portal-hardware-lifecycle-design.md` (approved). Sections 5 (page structure, read in full before Task 3), 6 (component split), and the W02 row of section 9 (rollout) are this wave.

**Precedent this wave copies, not reinvents:** `apps/portal/src/pages/reports/index.astro` (the 401/403 frontmatter pattern), `apps/portal/src/components/portal/ReportRunList.tsx` (the generate/refresh request-state shape), `apps/portal/src/components/portal/ui.tsx` (`MarkTone`, `EmptyState`, `PageHeader`, `ROW`/`CELL`/`TH` table primitives), and `packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` (the three fixture rows this wave's component tests reuse).

**Depends on:** W01 merged to `main` (the `enableLifecycle` flag, `GET /reports/lifecycle/latest`, `PORTAL_LIFECYCLE_DISABLED` registered in `apps/portal/src/lib/visibilityGate.ts` and `disabledPageCoverage.test.ts`'s `GATED_API_METHODS`). Do not start until W01 is on `main` and this branch is rebased on it.

## Global Constraints

- **No recomputation.** Import `buildAtAGlanceFacts`, `buildReplacementSchedule`, `rowLabel`, `rowSecondary`, `rowMention`, `capNames`, `quarterLabel`, `monthYear`, `REPLACEMENT_LABELS`, `REPLACEMENT_BAND_DESCRIPTIONS`, `countByReplacement`, `sortLifecycleRows`, `displayPersonName`, `humanJoin` from `@breeze/shared`; never hand-roll an equivalent string template. `yearsLabel`/`quartersBetween` (private to the PDF file) and the OS-risk-tag two-entry map are the only deliberate exceptions, both reimplemented locally per spec section 6.
- **`summary.generatedAt` is not the "as of" label.** Use `run.completedAt` (from the W01 route's `run.generatedAt`, already formatted server-side with `auth.timezone`), matching how `renderRunPdf` formats the PDF's meta line.
- **No em dashes or other dash-as-punctuation in any new copy**, including empty-state text, hover-adjacent labels, and code comments. Todd's rule for this whole feature.
- **`data-testid` on every interactive element and every element a test asserts against**, per the e2e README convention (W03 depends on these ids existing).
- **Contract tests that will fail if a step is skipped:**
  - `apps/portal/src/lib/disabledPageCoverage.test.ts`: `lifecycle.astro`'s frontmatter must check `PORTAL_LIFECYCLE_DISABLED` or call `redirectToPortalHomeAfterDisabled(Astro)`, matching the pattern `reports/index.astro` already uses for `PORTAL_REPORTS_DISABLED`.
  - `apps/portal/src/lib/visibilityGate.ts`'s `PORTAL_GATED_PAGES` array needs `/reports/lifecycle` added in this wave (W01 deliberately deferred it since the page did not exist yet); `disabledPageCoverage.test.ts`'s "never redirects a disabled page onto another gated page" check reads that array.
  - `apps/portal/src/lib/noInlineStyles.test.ts`: no `style={{...}}` anywhere in the new components (production CSP sets `style-src-attr 'none'`); use Tailwind classes and CSS custom properties already wired through `PortalLayout.astro`, never inline styles, even for the proportional status bar segments.
  - `apps/portal/src/lib/basePathCoverage.test.ts`: any hand-authored internal link (the Reports-page card) goes through `withBase()`.
- **Running one test file:** `cd apps/portal && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>`.
- **Branch:** `feature/5719-portal-hardware-lifecycle/wave-<W02 sub-issue#>`; PR body contains `Closes #<W02 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/portal/src/lib/api.ts` | `getHardwareLifecycleLatest()` client method |
| `apps/portal/src/lib/visibilityGate.ts` | `/reports/lifecycle` added to `PORTAL_GATED_PAGES` |
| `apps/portal/src/pages/reports/lifecycle.astro` (+ `.test.ts`) | server fetch, 401/403 handling, mounts `LifecyclePage` |
| `apps/portal/src/components/lifecycle/LifecyclePage.tsx` (+ `.test.tsx`) | composition root, Refresh state |
| `apps/portal/src/components/lifecycle/LifecycleStatusBar.tsx` (+ `.test.tsx`) | at-a-glance bar and sentence |
| `apps/portal/src/components/lifecycle/LifecycleSchedule.tsx` (+ `.test.tsx`) | replacement schedule groups |
| `apps/portal/src/components/lifecycle/LifecyclePlanTable.tsx` (+ `.test.tsx`) | workstation/server tables |
| `apps/portal/src/components/lifecycle/TimelineCell.tsx` (+ `.test.tsx`) | fill + label only this wave, no hover |
| `apps/portal/src/components/lifecycle/LifecycleRecommendations.tsx` (+ `.test.tsx`) | other-equipment list and recommendations |
| `apps/portal/src/components/lifecycle/LifecycleClosing.tsx` (+ `.test.tsx`) | contact line |
| `apps/portal/src/pages/reports/index.astro` (+ `.test.ts`) | "Hardware lifecycle" card gated on `enableLifecycle` |

---

### Task 1: Portal API client method and gated-page registration

**Files:** modify `apps/portal/src/lib/api.ts`, `apps/portal/src/lib/visibilityGate.ts`.

- [ ] **Step 1:** Write a failing test in `apps/portal/src/lib/api.test.ts` (or the file's existing test suite for portal report methods): `portalApi.getHardwareLifecycleLatest()` calls `GET /portal/reports/lifecycle/latest` and returns the typed `{ run, summary }` shape.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/lib/api.test.ts`. Expect FAIL, method does not exist.
- [ ] **Step 3:** Implement `getHardwareLifecycleLatest` in `api.ts` following the existing `getReportRuns`/`generateReport` call shape (`apiGet`/`apiRequest` helpers already in the file). Import `HardwareLifecycleSummary` and the new `HardwareLifecyclePortalLatestDto` type from `@breeze/shared` (both land on `main` once W01 and #5701 are merged).
- [ ] **Step 4:** Append `'/reports/lifecycle'` to `PORTAL_GATED_PAGES` in `visibilityGate.ts`.
- [ ] **Step 5:** Run: `cd apps/portal && npx vitest run src/lib/api.test.ts src/lib/visibilityGate.test.ts src/lib/disabledPageCoverage.test.ts && npx tsc --noEmit`. Expect PASS (the coverage test still finds nothing calling the new method until Task 3 creates the page; that is expected).
- [ ] **Step 6:** Commit:

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/lib/visibilityGate.ts
git commit -m "feat(portal): getHardwareLifecycleLatest client method and gated-page registration (W02)"
```

---

### Task 2: `LifecycleStatusBar`, `LifecycleSchedule`, `LifecycleRecommendations`, `LifecycleClosing`

**Files:** create the four components and their tests under `apps/portal/src/components/lifecycle/`.

- [ ] **Step 1:** Write failing component tests using the three fixture rows from `packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` (SAM4: `replace`; LAW-SRV: `due_soon` server; MacBook-Air: `unknown`) plus the all-green and undated variants described in spec section 5:
  - `LifecycleStatusBar.test.tsx`: renders four band segments with counts from `countByReplacement`, tone-mapped `replace` to destructive, `due_soon` to warning, `supported` to success, `unknown` to neutral; the `buildAtAGlanceFacts` sentence renders once under the bar and is absent entirely (not an empty paragraph) when the helper returns `''` (all-green case).
  - `LifecycleSchedule.test.tsx`: with the three-row fixture, renders a "Now" group (SAM4) and a quarter group for LAW-SRV's `due_soon` date; renders nothing when `buildReplacementSchedule` returns an empty array (undated/all-future-supported edge case).
  - `LifecycleRecommendations.test.tsx`: renders `summary.recommendations` as a real `<ul>` (not a manually inserted glyph character); renders `summary.other` capped at 8 via `humanJoin`/`capNames(names, 8)`.
  - `LifecycleClosing.test.tsx`: renders the contact line only when `contactEmail` is present; renders nothing otherwise.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/`. Expect FAIL, files do not exist. (Substring match: confirm the reported file count matches the four files above, since a bare directory path can also pick up unrelated matches.)
- [ ] **Step 3:** Implement each component per spec section 5. Every count, label, and sentence is a direct call into the imported shared helpers, no local recomputation. `data-testid` values: `lifecycle-status-bar`, `lifecycle-status-segment-<band>`, `lifecycle-status-fact`, `lifecycle-schedule`, `lifecycle-schedule-group-<index>`, `lifecycle-other-equipment`, `lifecycle-recommendations`, `lifecycle-closing`.
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/ && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/components/lifecycle/LifecycleStatusBar.tsx apps/portal/src/components/lifecycle/LifecycleStatusBar.test.tsx \
  apps/portal/src/components/lifecycle/LifecycleSchedule.tsx apps/portal/src/components/lifecycle/LifecycleSchedule.test.tsx \
  apps/portal/src/components/lifecycle/LifecycleRecommendations.tsx apps/portal/src/components/lifecycle/LifecycleRecommendations.test.tsx \
  apps/portal/src/components/lifecycle/LifecycleClosing.tsx apps/portal/src/components/lifecycle/LifecycleClosing.test.tsx
git commit -m "feat(portal): lifecycle status bar, schedule, recommendations, closing components (W02)"
```

---

### Task 3: `LifecyclePlanTable` and `TimelineCell` (fill and label, no hover)

**Files:** create `LifecyclePlanTable.tsx` (+ `.test.tsx`), `TimelineCell.tsx` (+ `.test.tsx`).

- [ ] **Step 1:** Write failing tests reusing the three fixture rows plus a synthetic purchased-and-due-this-week row (needed later for W03's "now" label threshold; add it now so the fixture set is complete for both waves), fixed today `2026-06-10` matching the fixture's `generatedAt`:
  - `LifecyclePlanTable.test.tsx`: renders Computer (`rowLabel` bold, `rowSecondary` muted subline), Operating system (plus risk tag "No security updates"/"Support ending" keyed on `osSupport`, a local two-entry map, not imported from the PDF file), Age (`<1 yr`/`N yr`, floored), Purchased (month-year, `*` suffix when `purchaseDateSource === 'vendor'`), Warranty ("Expired \<month year\>" muted when past, else plain), Status (the band word alone, coloured by tone), Replacement timeline (delegates to `TimelineCell`). Asserts a legend renders one dot per non-zero band counted from that table's own rows (`countByReplacement` on the table's rows, not the whole fleet). Asserts the vendor-sourced footnote appears only when at least one row in that table has `purchaseDateSource === 'vendor'`.
  - `TimelineCell.test.tsx`: SAM4 (`replace`, purchased 2019-04-01, due 2023-04-01) renders a solid overdue run through `todayQ` with an "N yr over" label; LAW-SRV (`due_soon`, purchased 2021-10-01 vendor, due 2026-11-30) renders a tinted planned-life run to a solid due quarter with no label; MacBook-Air (`unknown`, no dates) renders no grid and no label; the synthetic row (purchased and due this week) renders the "now" label. Grid constants: `TIMELINE_QUARTERS_BEFORE = 8`, `TIMELINE_QUARTERS_AFTER = 12`, `TIMELINE_QUARTERS = 20`, `todayQ = TIMELINE_QUARTERS_BEFORE`.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePlanTable.test.tsx src/components/lifecycle/TimelineCell.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement `TimelineCell.tsx` first, porting the `RUNWAY_COL` branch logic from `drawHandCell` (`packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`) to Tailwind opacity utilities instead of the PDF's `mix()` colour blend: `dueQ = todayQ + quartersBetween(today, row.replaceBy)`; `boughtQ = row.purchaseDate ? todayQ + quartersBetween(today, row.purchaseDate) : -Infinity`; quarters in `[boughtQ, dueQ)` get a planned-life tint, the due quarter is solid tone, an overdue run (`dueQ < todayQ && q > dueQ && q <= todayQ`) is solid tone through today, every other quarter is the neutral rule colour. Label "now" when overdue under two weeks, else "N yr over"; "N yr out" only when `dueQ >= TIMELINE_QUARTERS`; otherwise no label. Reimplement `yearsLabel`/`quartersBetween` locally (private to the PDF file, not exported) with the identical contract: months under a year, half-years above it. Compute `today` as `new Date()` at render time, not `summary.generatedAt` (portal-only improvement over the PDF, per spec section 5, so a snapshot from weeks ago still shows today as literally today). A row with no `replaceBy` draws nothing. Then implement `LifecyclePlanTable.tsx` around it, using `ROW`/`CELL`/`TH` from `ui.tsx` for the same hairline-ruled table treatment every other portal table uses.
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePlanTable.test.tsx src/components/lifecycle/TimelineCell.test.tsx && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/components/lifecycle/LifecyclePlanTable.tsx apps/portal/src/components/lifecycle/LifecyclePlanTable.test.tsx \
  apps/portal/src/components/lifecycle/TimelineCell.tsx apps/portal/src/components/lifecycle/TimelineCell.test.tsx
git commit -m "feat(portal): lifecycle plan table and timeline cell (fill and label, no hover) (W02)"
```

---

### Task 4: `LifecyclePage`, `lifecycle.astro`, empty/all-green/undated/large-fleet states

**Files:** create `LifecyclePage.tsx` (+ `.test.tsx`), `apps/portal/src/pages/reports/lifecycle.astro` (+ `.test.ts`).

- [ ] **Step 1:** Write failing tests:
  - `LifecyclePage.test.tsx`: lays out the six section components in PDF order (status bar, schedule, workstations table, servers table [heading "Device replacement plan" when there are no servers], other equipment, recommendations, closing); a Refresh button (`data-testid="lifecycle-refresh"`) calls `portalApi.generateReport('hardware_lifecycle')` then re-fetches via `getHardwareLifecycleLatest()`, mirroring `ReportRunList.generate()`'s success/failure/429 handling including `retryHintFrom`; empty summary (`rows: []`, no run) renders `EmptyState` with copy "We have not generated your hardware lifecycle plan yet." and the Refresh button; all-`supported` rows render the bar and no schedule section and no fabricated all-clear sentence (`buildAtAGlanceFacts` returns `''`); all-`unknown` rows render the bar, `buildAtAGlanceFacts`'s confirming-dates sentence, only the "Purchase date unknown" schedule group, and every `TimelineCell` blank; a large synthetic row count (100+) renders the plan table inside its own `overflow-x-auto` wrapper with no pagination and no row virtualization (spec section 5, a stated risk, not a requirement this wave).
  - `lifecycle.astro.test.ts` (server-render test, following `reports/index.test.ts`'s shape): a 401 from `getHardwareLifecycleLatest` redirects via `redirectToLoginAfter401`; a `PORTAL_LIFECYCLE_DISABLED` 403 redirects via `redirectToPortalHomeAfterDisabled` (the `disabledPageCoverage.test.ts` contract from the Global Constraints); a `PORTAL_REPORT_NOT_GENERATED` 404 falls through to render the page in its empty state (data, not a crash), matching how `reports/index.astro` already treats its own generic report 403 as data.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePage.test.tsx src/pages/reports/lifecycle.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement `LifecyclePage.tsx` and `lifecycle.astro`, following `reports/index.astro`'s frontmatter shape exactly (`buildServerApiConfig(Astro.request)`, `isPortalPageDisabled(response)` check before `PortalLayout` renders). `client:load` the island (matching `ReportRunList`'s hydration mode, since Refresh needs interactivity on first paint).
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePage.test.tsx src/pages/reports/lifecycle.test.ts src/lib/disabledPageCoverage.test.ts && npx tsc --noEmit`. Expect PASS; `disabledPageCoverage.test.ts` now finds `lifecycle.astro` calling the gated method and confirms the frontmatter branch.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/components/lifecycle/LifecyclePage.tsx apps/portal/src/components/lifecycle/LifecyclePage.test.tsx \
  apps/portal/src/pages/reports/lifecycle.astro apps/portal/src/pages/reports/lifecycle.test.ts
git commit -m "feat(portal): lifecycle page composition root and Astro route (W02)"
```

---

### Task 5: Reports-page card

**Files:** modify `apps/portal/src/pages/reports/index.astro` (+ `.test.ts`).

- [ ] **Step 1:** Write a failing test: with `branding.enableLifecycle === true`, the rendered page includes a "Hardware lifecycle" card/link (`data-testid="reports-lifecycle-card"`) pointing at `withBase('/reports/lifecycle')`, positioned above `ReportRunList` per spec section 4's Nav decision (C1: nested under Reports, no new top-level nav item); with the flag `false` or absent, the page is byte-for-byte unchanged from today (no card).
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/pages/reports/index.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement: call the existing `loadPortalBranding(Astro.request)` helper (`apps/portal/src/lib/server.ts`, already used by `PortalLayout.astro` for the nav) in `index.astro`'s frontmatter, and conditionally render the card before `<ReportRunList ... />`. Use `withBase()` for the link (the `basePathCoverage.test.ts` contract).
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/pages/reports/index.test.ts src/lib/basePathCoverage.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/pages/reports/index.astro apps/portal/src/pages/reports/index.test.ts
git commit -m "feat(portal): Hardware lifecycle card on the Reports page (W02)"
```

---

### Task 6: Full-wave verification

- [ ] **Step 1:** Run every file this wave touched: `cd apps/portal && npx vitest run src/lib/api.test.ts src/lib/visibilityGate.test.ts src/lib/disabledPageCoverage.test.ts src/lib/noInlineStyles.test.ts src/lib/basePathCoverage.test.ts src/components/lifecycle/ src/pages/reports/`. Expect PASS.
- [ ] **Step 2:** Grep the new component files for dash-as-punctuation characters before opening the PR: `grep -rn '\xe2\x80\x94\|\xe2\x80\x93' apps/portal/src/components/lifecycle/ apps/portal/src/pages/reports/lifecycle.astro`. Expect no matches.
- [ ] **Step 3:** `cd apps/portal && npx tsc --noEmit`. Expect PASS.

## PR

- Body includes `Closes #<W02 sub-issue>`.
- One review round before enqueueing; re-review only if a fix touches tenancy/RLS (unlikely in this wave, which is read-only presentation).
- Merge with `gh pr merge <N>`, no strategy flag. Never `--admin`.
