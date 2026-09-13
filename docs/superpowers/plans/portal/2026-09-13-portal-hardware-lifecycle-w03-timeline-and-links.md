---
tracking_issue: LanternOps/breeze#5728
---
# Portal Hardware Lifecycle W03: Timeline Hover and Device Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the timeline cell's hover title (quarter label), a working device row link from the lifecycle plan table to `/devices`, a manual brand-colour verification pass, and the e2e coverage spec. This closes out the feature.

**Architecture:** `TimelineCell.tsx` (W02) gains a native `title` attribute per quarter cell exposed through the existing accessible name, no tooltip library. `LifecyclePlanTable.tsx` rows gain a link to `/devices#<deviceId>`; `apps/portal/src/components/portal/DeviceList.tsx` gains a mount effect that reads `window.location.hash`, scrolls the matching row into view, and applies a temporary highlight class, following CLAUDE.md's hash-based UI-state convention (query params are reserved for something else; transient UI state goes in the hash).

**Tech Stack:** React, Playwright Test (TypeScript), `data-testid`-only DOM queries per `e2e-tests/README.md`.

**Spec:** `docs/superpowers/specs/portal/2026-09-13-portal-hardware-lifecycle-design.md` (approved). Section 5 (timeline cell rules, the hover paragraph specifically), section 8 (e2e), and the W03 row of section 9 (rollout, including the "device links need new portal work, not reuse" callout) are this wave.

**Precedent this wave copies, not reinvents:** `e2e-tests/pages/PortalVisibilityPage.ts` and `e2e-tests/tests/portal-visibility.spec.ts` for the page-object and seeded-org e2e pattern; CLAUDE.md's "URL State in Components" section (`window.location.hash`, see `DeviceDetails.tsx` and `OrganizationsPage.tsx`) for the device-link mechanism.

**Depends on:** W02 merged to `main` (`TimelineCell.tsx`, `LifecyclePlanTable.tsx`, `lifecycle.astro`, `LifecyclePage.tsx`, all `data-testid`s from that wave). Do not start until W02 is on `main` and this branch is rebased on it.

## Finding: the spec's file path for the device-link work is wrong

Spec section 9 (W03) names `apps/portal/src/components/DeviceList.tsx` as the file to modify. That path does not exist. The component actually lives at `apps/portal/src/components/portal/DeviceList.tsx` (confirmed by reading the repository; it is a 287-line file whose device rows are `<tr key={device.id} className={ROW} data-testid={`portal-device-${device.id}`}>`). There is also no separate `apps/portal/src/pages/devices/` detail route beyond `index.astro`, matching the spec's own statement elsewhere in section 9 that no per-device page exists. Task 2 below targets the real path.

## Global Constraints

- **Hash-based UI state, not query params**, per CLAUDE.md.
- **No em dashes or other dash-as-punctuation** in any new copy, including the hover title string (a quarter label like `Q3 2027` has none, but do not decorate it).
- **`data-testid` only** for anything the e2e spec or a Playwright page object queries, per `e2e-tests/README.md`'s convention; never text/role/CSS selectors in the new spec.
- **Contract tests that will fail if a step is skipped:**
  - `apps/portal/src/lib/noInlineStyles.test.ts`: the highlight effect on `DeviceList.tsx`'s row must be a Tailwind class toggle (e.g. adding/removing a class name via `className`), never `style={{...}}`.
  - `apps/portal/src/components/portal/DeviceList.test.tsx` already exists (287-line component's sibling test file); extending it is Task 2, not a new file.
- **Running one test file:** `cd apps/portal && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>`. E2E: `cd e2e-tests && pnpm test -- portal-lifecycle.spec.ts` (Playwright's own `--` passthrough is a different CLI and is not the vitest trap CLAUDE.md warns about, but confirm against `e2e-tests/playwright.config.ts` if the invocation looks off).
- **Branch:** `feature/5719-portal-hardware-lifecycle/wave-<W03 sub-issue#>`; PR body contains `Closes #<W03 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/portal/src/components/lifecycle/TimelineCell.tsx` (+ `.test.tsx`) | hover `title` per quarter cell |
| `apps/portal/src/components/lifecycle/LifecyclePlanTable.tsx` (+ `.test.tsx`) | device row link to `/devices#<deviceId>` |
| `apps/portal/src/components/portal/DeviceList.tsx` (+ `.test.tsx`) | scroll-to-hash and highlight effect |
| `e2e-tests/pages/PortalHardwareLifecyclePage.ts` | new e2e page object |
| `e2e-tests/tests/portal-lifecycle.spec.ts` | new e2e spec |

---

### Task 1: `TimelineCell` hover title

**Files:** modify `apps/portal/src/components/lifecycle/TimelineCell.tsx` (+ `.test.tsx`).

- [ ] **Step 1:** Write a failing test: each rendered quarter cell (the 20-cell grid, `TIMELINE_QUARTERS_BEFORE = 8` before today through `TIMELINE_QUARTERS_AFTER = 12` after) carries a `title` attribute equal to `quarterLabel` (imported from `@breeze/shared`) for that cell's calendar quarter, queryable via `getByTitle` in the test but identified by `data-testid="lifecycle-timeline-quarter-<index>"` for the e2e spec (title text is locale-sensitive presentation, not a stable selector). A row with no `replaceBy` (renders no grid, per W02) has no quarter cells and therefore no titles to assert on.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/TimelineCell.test.tsx`. Expect FAIL, no `title` attributes yet.
- [ ] **Step 3:** Implement: add `title={quarterLabel(quarterIso)}` to each quarter cell's element, where `quarterIso` is the same date value the cell's fill logic already computes for that grid position (do not add a second date computation; thread the existing per-cell iso value into the `title` prop). This exposes the label "through the existing accessible name rather than hidden from it" (spec section 5); a `title` attribute already is the accessible name contributor for a element with no other accessible text, so no additional `aria-label` is needed unless the cell has visible text content that would otherwise take precedence, in which case add `aria-label={quarterLabel(quarterIso)}` alongside `title` so screen readers and mouse users get the same string.
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/TimelineCell.test.tsx && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/components/lifecycle/TimelineCell.tsx apps/portal/src/components/lifecycle/TimelineCell.test.tsx
git commit -m "feat(portal): timeline cell hover title (W03)"
```

---

### Task 2: Device row link and scroll-and-highlight

**Files:** modify `apps/portal/src/components/lifecycle/LifecyclePlanTable.tsx` (+ `.test.tsx`), `apps/portal/src/components/portal/DeviceList.tsx` (+ `.test.tsx`).

- [ ] **Step 1:** Write failing tests:
  - `LifecyclePlanTable.test.tsx`: the Computer cell's label (`rowLabel`) is wrapped in an `<a href="/devices#<row.id>">` (device rows only; `row.kind === 'manual_asset'` rows, which have no `/devices` entry, render the same label as plain text, not a link, since a manual asset never appears in `DeviceList`). `data-testid="lifecycle-plan-row-link-<row.id>"` on the anchor.
  - `DeviceList.test.tsx` (existing file, extend it): on mount with `window.location.hash` set to `#<some device id in the list>`, the matching row's `data-testid="portal-device-<id>"` element gains a highlight class (assert the class name, not a style) and `scrollIntoView` is called on it (mock `Element.prototype.scrollIntoView`, matching whatever mocking convention the file's existing tests already use for jsdom gaps, if any; otherwise add the mock). With no hash, or a hash matching no row, no element is scrolled or highlighted, and no error is thrown.
- [ ] **Step 2:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePlanTable.test.tsx src/components/portal/DeviceList.test.tsx`. Expect FAIL.
- [ ] **Step 3:** Implement:
  - `LifecyclePlanTable.tsx`: wrap the Computer cell's label in an anchor for `row.kind === 'device'` rows only, `href={`/devices#${row.id}`}` (run through `withBase()` per `basePathCoverage.test.ts`, since this is a hand-authored internal link).
  - `DeviceList.tsx`: add a `useEffect` (the component currently has none; this is the first) that runs once on mount, reads `window.location.hash.slice(1)`, finds the device in `devices` with that id, and if found, sets local highlight state for that id and calls `scrollIntoView({ behavior: 'smooth', block: 'center' })` on the matching row ref. The highlight is a Tailwind class added conditionally via `className`, e.g. a temporary `ring-2 ring-primary` variant already used elsewhere in the portal's token system, removed after a few seconds via `setTimeout` (clear the timer on unmount) so the highlight does not persist indefinitely. Guard `window` access for SSR (the component itself is client-rendered inside an island, but keep the guard consistent with the rest of the file's conventions).
- [ ] **Step 4:** Run: `cd apps/portal && npx vitest run src/components/lifecycle/LifecyclePlanTable.test.tsx src/components/portal/DeviceList.test.tsx src/lib/noInlineStyles.test.ts src/lib/basePathCoverage.test.ts && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit:

```bash
git add apps/portal/src/components/lifecycle/LifecyclePlanTable.tsx apps/portal/src/components/lifecycle/LifecyclePlanTable.test.tsx \
  apps/portal/src/components/portal/DeviceList.tsx apps/portal/src/components/portal/DeviceList.test.tsx
git commit -m "feat(portal): device row links from the lifecycle plan table, with scroll-and-highlight (W03)"
```

---

### Task 3: Brand-colour manual verification

**Files:** none (QA step, not a code change; the spec explicitly frames this as manual verification since the token wiring is already proven elsewhere in the portal).

- [ ] **Step 1:** With a local or staging stack up (`pnpm wt-stack up` or `pnpm test-stack up` plus `pnpm dev`), set a non-default `portal_branding.primaryColor`/`secondaryColor`/`accentColor` for a seeded org (via the org portal-settings admin UI, or a direct SQL update against the local stack) and load `/reports/lifecycle` for that org.
- [ ] **Step 2:** Confirm the status bar segments, band tone colours, and any accent elements pick up the custom colours with no code change, the same way every other portal page's tokens already do through `PortalLayout.astro`'s `buildDocAccentCss`.
- [ ] **Step 3:** If a colour does not pick up the branding, that means a component used a literal Tailwind colour class instead of a token/tone from `ui.tsx`; file it as a defect against the specific component rather than patching it silently in this QA step, since it means an earlier task in W02 or W03 missed the "never a literal hex, only tokens and tones" rule (spec section 2).
- [ ] **Step 4:** Record the result (pass, or filed defect number) in the wave's PR description. No commit for this task unless a defect fix is needed.

---

### Task 4: e2e spec

**Files:** create `e2e-tests/pages/PortalHardwareLifecyclePage.ts`, `e2e-tests/tests/portal-lifecycle.spec.ts`.

- [ ] **Step 1:** Write the page object, following `PortalVisibilityPage.ts`'s shape: locators by `data-testid` only, for the lifecycle nav/card link, `lifecycle-refresh`, `lifecycle-status-bar`, `lifecycle-status-segment-<band>`, `lifecycle-schedule`, `lifecycle-plan-row-link-<id>` (device row link), `lifecycle-timeline-quarter-<index>` (hover target), and the reports-page card `reports-lifecycle-card`.
- [ ] **Step 2:** Write `portal-lifecycle.spec.ts` against a seeded org with `enableReports: true, enableLifecycle: true` and at least one seeded device with a lifecycle-plan-eligible row. If no such seed currently exists, this step includes extending whatever seed fixture `portal-visibility.spec.ts` already uses (confirm the seed source with `grep -rn "enable_reports\|enableReports" e2e-tests/` before assuming a location; do not invent a new seeding mechanism). Test flow, `test.describe.serial` per the visibility spec's pattern: log in, navigate to Reports, assert the Hardware lifecycle card is visible and click it; if no run exists yet, click Refresh and wait for the status bar to render (following `portal-visibility.spec.ts`'s generous timeout convention for first-run generation); assert the status bar, schedule, and at least one plan table render with their `data-testid`s; hover a timeline cell and assert its `title` attribute matches a `Q\d 20\d\d` pattern; click a device row link and assert navigation to `/devices#<id>` with the target row visible.
- [ ] **Step 3:** Run: `cd e2e-tests && pnpm test -- portal-lifecycle.spec.ts` against a running dev stack. Expect PASS. This is the one step in this plan that cannot be run headless-only in CI without the full stack; treat a first-run failure as a stack/seed issue before assuming a component defect, per CLAUDE.md's flaky-test memory entries for other portal e2e specs.
- [ ] **Step 4:** Commit:

```bash
git add e2e-tests/pages/PortalHardwareLifecyclePage.ts e2e-tests/tests/portal-lifecycle.spec.ts
git commit -m "test(e2e): portal hardware lifecycle page coverage (W03)"
```

---

### Task 5: Post-implementation feature-testing pass

- [ ] **Step 1:** Run the `feature-testing` skill against the full three-wave feature end to end (not just this wave's diff): toggle `enableReports`/`enableLifecycle` off and on in the web settings UI, confirm the portal nav/Reports card and the dedicated route both fail closed and open correctly, generate a run, verify the PDF and the live page agree on every number (spec's core promise, section 1), and walk the empty/all-green/undated/large-fleet states from W02 in a real browser.
- [ ] **Step 2:** File any defect found as its own issue rather than patching it inside this wave's PR, unless it is trivially scoped to a file this wave already touched.

## PR

- Body includes `Closes #<W03 sub-issue>`.
- One review round before enqueueing; re-review only if a fix touches tenancy/RLS (unlikely; this wave is presentation plus e2e).
- Merge with `gh pr merge <N>`, no strategy flag. Never `--admin`.
- After this PR lands, the feature is complete across all three waves; use `feature-lifecycle`'s `complete_wave` for this sub-issue and confirm whether the parent issue (#5719) should close or stay open pending the two open questions this plan set could not resolve (spec section 10, items 1 and 3, neither addressed by any of the three waves: large-fleet virtualization and the Refresh button's 429 copy).
