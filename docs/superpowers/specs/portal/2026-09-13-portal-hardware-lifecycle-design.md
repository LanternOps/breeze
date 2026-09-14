---
title: Portal Hardware Lifecycle page
issue: LanternOps/breeze#5719
tracking_issue: LanternOps/breeze#5728
status: draft
depends_on: LanternOps/breeze#5701
---

# Hardware Lifecycle in the customer portal: design

Status: draft, for review.
Tracking: LanternOps/breeze#5719, follow-up to #5701 (Hardware Lifecycle PDF report).
Depends on #5701 landing first. As of this writing #5701 is open with
`mergeStateStatus: BLOCKED` in the merge queue, so `packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`,
`packages/shared/src/utils/hardwareLifecycle.ts` and
`packages/shared/src/types/hardwareLifecycleReport.ts` do not exist on `main` yet.
Every file path and line reference below was read from
`origin/feature/hardware-lifecycle-report`, not from a worktree checked out to
`main`. Rebase this plan's waves onto #5701's merge commit before starting W01.

## 1. Problem and goal

The MSP already builds the Hardware Lifecycle plan as a PDF the customer downloads
by hand: at-a-glance counts, a replacement schedule, a workstation table and a
server table with a per-quarter timeline, other equipment, and a recommendations
list. The customer only sees it when someone remembers to generate and send it,
and the PDF is frozen the moment it renders. This feature puts the same plan on a
portal page that reads live off the org's device records through the existing
snapshot mechanism, adds two things a static PDF cannot do (hover a timeline cell
for its quarter, click a row through to the device it names), and inherits the
org's portal brand colours instead of the PDF's fixed palette. The numbers must
never diverge from the PDF: both read the identical persisted
`HardwareLifecycleSummary` snapshot and the same shared band and prose helpers, so
a customer comparing the page to a PDF they downloaded five minutes ago sees the
same counts by construction, not by re-implementation discipline.

## 2. Scope / non-scope

**In:**

- A portal page rendering the org's latest completed `hardware_lifecycle` report
  run's persisted `summary` snapshot: at a glance, replacement schedule,
  workstations/laptops table, servers table, other equipment, recommendations,
  closing contact line, in the PDF's section order with its exact copy.
- Hovering a timeline cell shows its quarter label (a native `title` attribute is
  enough; no tooltip library).
- A row's device name links to `/devices` with the row highlighted, wherever the
  portal can already resolve that link (see §5 and §6 for the gap this actually
  requires).
- Brand colours: the page uses the portal's existing design tokens
  (`bg-primary`, `text-success-on-tint`, etc. from `apps/portal/src/components/portal/ui.tsx`),
  already wired to the org's `portal_branding.primaryColor` / `secondaryColor` /
  `accentColor` through `PortalLayout.astro`'s `buildDocAccentCss`. This is not
  new work; it is a constraint on how the new components choose colour (only
  tokens and tones, never a literal hex), so brand colours arrive for free the
  same way they do on every other portal page.
- A "Refresh" action that generates a new run through the existing generic
  self-service mechanism (decided in scope, see below).

**Out:**

- Costs (tracked separately, #5720). No dollar figures appear anywhere on the
  page, matching the PDF's "no pricing claims" rule in
  `buildHardwareLifecycleRecommendations`.
- Editing options (replace-age years, included sites, manual-asset inclusion).
  These live in the report definition's `config` and stay MSP-only; the portal
  page is read-only end to end.
- **Generating a run is in scope, narrowly.** The page's Refresh button calls the
  same `POST /portal/reports/generate {type}` the Reports tab already uses for
  `security_compliance_posture` and `executive_summary`: no new generation
  mechanism, no new queue, no new rate-limit bucket, just one more value in
  `PORTAL_REPORT_TYPES` flowing through code that already exists. It has to be
  in scope because a page whose only path to freshness is "ask the MSP to click
  Generate on their own screen" does not meet the issue's "live" framing, and
  the marginal cost is one button and one union entry, not new plumbing.
- PDF download already exists. Once `hardware_lifecycle` is a
  `PORTAL_REPORT_TYPES` member, `GET /portal/reports/runs/:id/pdf` and `.../csv`
  work for it with no route changes, and `ReportRunList` picks it up as a third
  downloadable type automatically (W01).
- A device detail page. The issue's "rows link to the device where the portal
  already shows devices" assumes a per-device page exists; it does not (§6).

## 3. Data path

The summary the page renders is `report_runs.result.summary`, JSONB, on the row
selected by:

```ts
and(
  eq(reportRuns.status, 'completed'),
  eq(reports.type, 'hardware_lifecycle'),
  eq(reports.orgId, orgId),
  eq(reports.portalSelfService, true),
)
```

which is `portalRunListPredicate(orgId)` (`apps/api/src/services/portal/reportsSelfService.ts:182`)
narrowed by `type`, ordered `desc(reportRuns.completedAt), desc(reportRuns.id)`,
`limit(1)`. `portalRunPredicate(runId, orgId)` (same file, line 174) is reused
unchanged for the PDF/CSV download routes once the definition exists; no new
predicate helper is needed beyond the inline `eq(reports.type, ...)` above.

**`PORTAL_REPORT_TYPES` change.** Add `'hardware_lifecycle'` to the const array
(lines 119-122) and a matching entry to `PORTAL_DEFINITIONS` (lines 27-51):

```ts
{
  type: 'hardware_lifecycle',
  name: 'Customer portal — Hardware lifecycle' (the file's existing separator; the em-dash rule applies to rendered customer copy, and this string is an internal definition name shown only to technicians),
  config: {
    sites: [],
    replaceAgeYears: 4,
    serverReplaceAgeYears: 5,
    includeManualAssets: true,
    includeOtherEquipment: true,
  },
},
```

matching `hardwareLifecycleConfigSchema` defaults
(`apps/api/src/routes/reports/schemas.ts:88-94` on the #5701 branch, no
`dateRange` since this is a point-in-time inventory snapshot). This is a one-line
addition to a `const` array plus a `z.enum` that already reads from it
(`portalReportGenerateSchema`), so no migration for the type itself.
`provisionPortalReportDefinitions` already inserts every `PORTAL_DEFINITIONS`
row `ON CONFLICT DO NOTHING`, so an org that already has `enable_reports` on
before this ships needs the provisioning call re-run once, which is a one-time
script (W01), not a backfill migration.

**Decision B2: the provisioned definition's config inherits the MSP's
replace-age settings, rather than shipping the schema defaults.** An MSP that
has already tuned `replaceAgeYears` on its own `hardware_lifecycle` report
(say, to 6 years for a customer on longer refresh cycles) would otherwise see
the portal page silently disagree with the PDF it just handed the customer,
both claiming to be "the plan" for the same fleet. The static
`PORTAL_DEFINITIONS` config above stays as the fallback shape (and the value
used the first time an org is provisioned with no MSP-side report yet), but
`generatePortalReport` (`reportsSelfService.ts`) is extended: for
`args.type === 'hardware_lifecycle'`, before calling `generateReport`, look up
the org's most recent non-portal `hardware_lifecycle` definition,

```ts
and(
  eq(reports.orgId, args.orgId),
  eq(reports.type, 'hardware_lifecycle'),
  eq(reports.portalSelfService, false),
)
```

ordered `desc(reports.updatedAt)`, `limit(1)`, and copy `replaceAgeYears`,
`serverReplaceAgeYears`, `includeManualAssets`, `includeOtherEquipment` off its
`config` onto the config object passed to `generateReport`, leaving `sites`
alone (the portal definition's own `[]`, since site scoping for the portal
path is a `siteScope`/authority concern, not a copyable config field). When no
such MSP-side definition exists yet (a new org, or one that never generated a
lifecycle report as staff), the four fields fall back to the schema defaults
already on `PORTAL_DEFINITIONS`: 4 / 5 / true / true. This lookup is a plain
`orgId`-scoped `SELECT` against `reports`, which already carries RLS; it runs
inside the same org-scoped RLS transaction `generatePortalReport` is already
executing under (the portal auth path holds that transaction for the whole
request, per the existing comment on
`tightenPortalReportStatementTimeout`), so no `withSystemDbAccessContext` or
`runOutsideDbContext` escalation is introduced. `PORTAL_DEFINITIONS`' own
`config` object is never mutated in place; the merge produces a fresh object
per generation.

**No new table, no new RLS registration, for the data path above.**
`report_runs` and `reports` already carry RLS (the Wave-1 spec documents
`report_runs`'s parent-FK-join policy). Adding a value to a TypeScript union
and reading one more row off an already-RLS'd table does not touch the RLS
surface, so none of the six registration lists in CLAUDE.md's tenancy section
apply. `PORTAL_REPORT_TYPES`, `PORTAL_DEFINITIONS`, and the B2 config-lookup
above are the entire data-path change. (The `enable_lifecycle` visibility flag
in §4 does add one migration, but that is a new column on the already-RLS'd
`portal_branding` table, not a new tenancy shape.)

**No run exists yet** (new org, or `enable_reports` just turned on): the latest
endpoint (§7) returns 404 `PORTAL_REPORT_NOT_GENERATED`. The page renders an
empty state with a Refresh button (§5), same as `reports/index.astro` already
treats a 403 from the branding gate as data rather than a crash, not a 404 page.

**No recomputation, ever.** Every number, colour and sentence comes from
`HardwareLifecycleSummary` (`packages/shared/src/types/hardwareLifecycleReport.ts`)
or from calling the exact helpers the PDF calls (`buildAtAGlanceFacts`,
`buildReplacementSchedule`, `rowLabel`, `rowSecondary`, `rowMention`, `capNames`,
`quarterLabel`, `monthYear`, `REPLACEMENT_LABELS`, `REPLACEMENT_BAND_DESCRIPTIONS`,
`countByReplacement`, `sortLifecycleRows`, `displayPersonName`) from
`hardwareLifecycle.ts`. One exception: `summary.generatedAt` is not what drives
the page's "as of" label, since it is a raw ISO string with no timezone; use
`run.completedAt` formatted with `auth.timezone`, the same as `renderRunPdf`
already formats the PDF's meta line. `summary.replaceAgeYears` /
`serverReplaceAgeYears` default to 4 / 5 exactly as the PDF defaults them.
Every row's `ageYears`, `replaceBy`, `replacement`, `purchaseDate`,
`purchaseDateSource`, `warrantyEndDate`, `osSupport`, `deviceKind` and identity
fields (`name`, `hostname`, `user`, `model`, `manufacturer`) drive the timeline
grid and the identity/OS cells.

## 4. Entitlement and visibility

**Roles:** any authenticated portal user for the org, the same as every other
`enableReports`-gated route. The portal has no per-role permission model finer
than "logged in to this org" (`PortalAuthContext` carries no role field).

**Decision A2 (owner-decided): a dedicated `enableLifecycle` flag, default
off, required alongside `enableReports`.** The lifecycle plan names the
specific machines the customer is about to be asked to pay to replace; an MSP
may reasonably want generic report self-service on well before that
conversation has happened, or may want to gate the two independently for a
customer they are easing in gradually. The originally-recommended A1 (reuse
`enableReports` with no new flag) is rejected: it assumed no MSP would want
that split, but the replacement plan is a materially more sensitive surface
than a device inventory CSV, and the retrofit cost of adding the flag now
(before any org has W02's page reachable) is far cheaper than adding it after
some MSPs are already relying on `enableReports` alone gating it.

**Schema.** `portal_branding.enable_lifecycle boolean NOT NULL DEFAULT false`,
same fail-closed shape as the seven existing visibility columns. New
idempotent migration
`apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql`:

```sql
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_lifecycle boolean NOT NULL DEFAULT false;
```

Named to sort after every migration already claimed by open PRs: #5701 and
#5710 carry `2026-10-16-180000` through `180200`, so `180300` is the next
free same-day slot under `localeCompare`. Before the W01 commit, re-check
`gh pr list --json files` for any newer `2026-10-16-18xxxx` file and bump if
one has appeared; re-verify against `origin/main` before pushing, per
CLAUDE.md's pre-push naming guard.

**Export-policy classification.** `enable_lifecycle` is a new column on
`portal_branding`, which is already in `CORE_ORG_CASCADE_DELETE_ORDER` (it has
an `org_id` column), so CLAUDE.md's "export-policy row fires on a new column"
rule applies even though no new table is involved. Add `"enable_lifecycle"` to
the `included` bucket of the `"portal_branding"` entry in
`services/tenantExportPolicyRegistry.ts` (next to `enable_documents`, `included`
line ~430): it is an ordinary boolean feature flag, not a `SUSPICIOUS_NAME_PARTS`
match and not a `json`/`jsonb`/`bytea` column, so it does not qualify for
`reviewedIncluded` or `excludedOpen` the way `enable_password_reset` oddly does
on that same row.

**`PORTAL_VISIBILITY_FLAG_KEYS` and the rest of the `enableDocuments`
wiring.** Follow that flag's five call sites end to end:

1. Schema: `apps/api/src/db/schema/portal.ts`, add `enableLifecycle` next to
   `enableDocuments`.
2. Flag registry: `apps/api/src/services/portal/portalFlags.ts`, add
   `'enableLifecycle'` to `PORTAL_VISIBILITY_FLAG_KEYS`.
3. Feature gate: `apps/api/src/routes/portal/featureFlags.ts`, add an
   `enableLifecycle` entry to `STRICT_PORTAL_FEATURES` (it is
   `Record<PortalVisibilityFlag, ...>`, so this is required once step 2 lands,
   not optional), e.g. `{ error: 'Hardware lifecycle is not enabled for this
   portal', code: 'PORTAL_LIFECYCLE_DISABLED' }`.
4. MSP settings route: `apps/api/src/routes/orgPortalSettings.ts`, add
   `enableLifecycle: false` to `PORTAL_SETTINGS_DEFAULTS` and
   `enableLifecycle: row.enableLifecycle` to the `current` object passed to
   `onPortalFlagsChanged`.
5. Shared validator: `packages/shared/src/validators/portal.ts`, add
   `enableLifecycle` to `updatePortalSettingsSchema`.
6. Branding route response: `apps/api/src/routes/portal/branding.ts`, add
   `enableLifecycle: portalBranding.enableLifecycle` to the authenticated
   `GET /branding` select list (the one with the five W03 flags already on
   it). The public, pre-auth `GET /branding/:domain` projection does **not**
   get it, matching `enableReports`/`enableDocuments`/etc., which are also
   absent from that list; only account-scoped surfaces need visibility flags.
7. Portal type: `apps/portal/src/lib/api.ts`, add `enableLifecycle?: boolean`
   to `BrandingConfig`.
8. Web settings UI: `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`,
   add the toggle next to Documents; add the corresponding string to
   `apps/web/src/locales/en/settings.json` and the other locale files (the
   `translationCoverage.test.ts` guard requires every locale, not just `en`).
9. `buildPortalNavItems` (`apps/portal/src/lib/navItems.ts`) gets **no** new
   branch (see Nav, below): it is the one step of the `enableDocuments`
   pattern this flag deliberately skips.

**Gating: the lifecycle page, and its runs, both need to be gated
explicitly.** `portalReportRoutes` mounts under
`portalRoutes.use('/reports/*', createPortalFeatureGateStrict('enableReports'))`
(`apps/api/src/routes/portal/index.ts`), which is necessary but not
sufficient: `enableReports=true, enableLifecycle=false` must still hide the
lifecycle page and refuse its runs, and must not let hardware_lifecycle rows
leak through the *generic* run list/generate/download endpoints that every
report type shares.

- **The dedicated route.** `GET /portal/reports/lifecycle/latest` (§7) is
  mounted under a second, narrower gate on top of the existing one:
  ```ts
  portalRoutes.use('/reports/*', createPortalFeatureGateStrict('enableReports'));
  portalRoutes.use('/reports/lifecycle/*', createPortalFeatureGateStrict('enableLifecycle'));
  ```
  in `apps/api/src/routes/portal/index.ts`, immediately after the existing
  `enableReports` line. Both gates run in sequence (Hono middleware stacks by
  matched prefix), so a request to `/reports/lifecycle/latest` needs both
  flags true; every other `/reports/*` path is untouched.
- **The generic run endpoints (Codex-flagged leak).** `GET /reports/runs`,
  `POST /reports/generate`, `GET /reports/runs/:id/pdf` and `.../csv` serve
  all `PORTAL_REPORT_TYPES` and sit only behind `enableReports`, so an org with
  `enableLifecycle=false` could otherwise list, generate, and download
  `hardware_lifecycle` runs through these paths even though the dedicated page
  and route are gated. Close this by extending the two predicates that already
  join `reportRuns` to `reports.type`, `portalRunListPredicate(orgId)` and
  `portalRunPredicate(runId, orgId)` (`reportsSelfService.ts`), to take a
  `lifecycleEnabled: boolean` and, when false, additionally require
  `ne(reports.type, 'hardware_lifecycle')`. Each of `listPortalRuns`,
  `renderRunPdf`, and `renderRunCsv` (same file) reads the org's
  `enableLifecycle` value with one `portalBranding` select (the same table and
  pattern `createPortalFeatureGateStrict` already reads, inside the same
  org-scoped RLS transaction, no escalation) and passes it through, so a
  hardware_lifecycle run is invisible on these paths exactly as if it did not
  exist, once the flag is off. `generatePortalReport` gets the same check
  before dispatch: when `args.type === 'hardware_lifecycle'` and
  `enableLifecycle` is false, it throws the existing `PortalReportNotFoundError`
  (the same shape it already throws when no definition row exists), so the
  route's current catch block needs no new branch and the response does not
  distinguish "flag off" from "not provisioned yet." This is one consistent
  approach (predicate extension) rather than a second, parallel filter.

**Nav.** `buildPortalNavItems` gets no new top-level entry; the route stays
`/reports/lifecycle`, nested under Reports (§6, decision B). Instead,
`apps/portal/src/pages/reports/index.astro` calls the existing
`loadPortalBranding` helper (`apps/portal/src/lib/server.ts`, the same one
`PortalLayout.astro` already uses for the nav) and renders a "Hardware
lifecycle" card/link above `ReportRunList` only when
`branding.enableLifecycle === true`; when false, the page is unchanged from
today.

## 5. Page structure

Mirrors the PDF section for section (`renderHardwareLifecycleReport`,
`hardwareLifecyclePdf.ts:399-639`), with the portal-only affordances marked.

- **At a glance:** `LifecycleStatusBar` renders one status object: the four band
  counts (Replace now / Due soon / On track / Purchase date unknown) as big
  numbers, each over its own segment of one proportional bar
  (`countByReplacement`, `REPLACEMENT_LABELS`, `REPLACEMENT_BAND_DESCRIPTIONS`),
  tone-mapped `replace` to destructive, `due_soon` to warning, `supported` to
  success, `unknown` to neutral via `ui.tsx`'s `MarkTone`. One
  `buildAtAGlanceFacts(rows)` sentence sits directly under the bar; a fact
  appears once, never restated in the bar's own labels.
- **Replacement schedule:** `LifecycleSchedule` renders `buildReplacementSchedule`
  groups in order: Now, each upcoming quarter, `After <month year>`
  (`monthYear(horizon)`), Purchase date unknown, then a synthesized Servers line
  built the way `renderHardwareLifecycleReport` builds `serverLine`: server
  names with "past due" or their quarter label, capped via `capNames(names, 8)`.
  Non-server names cap at four (`capNames`'s default) with "and N more". A
  schedule with nothing due in the next year and no servers renders nothing.
- **Workstations and laptops, then Servers** (heading reads "Device replacement
  plan" when there are no servers): each section opens with the rule sentence
  ("We plan to replace a computer N years after purchase, or when its warranty
  ends if it is still covered past that point", plus an "outside your business
  hours" clause for servers), then a legend (one dot per non-zero band, counted
  from that table's own rows via `countByReplacement`, not the whole-fleet
  count), then `LifecyclePlanTable` with columns: Computer (`rowLabel` bold,
  `rowSecondary` muted subline), Operating system (plus risk tag "No security
  updates" / "Support ending" keyed on `osSupport`, reproduced locally since the
  PDF's own map is a private `const`), Age (`<1 yr` / `N yr`, floored),
  Purchased (month-year, `*` suffix when `purchaseDateSource === 'vendor'`),
  Warranty ("Expired \<month year\>" muted when past, else plain month-year),
  Status (the band word alone, coloured by tone; timing lives in the timeline
  column, per commit 867ddf292 on this branch), Replacement timeline
  (`TimelineCell`, next bullet). A footnote appears under a table only when it
  contains a vendor-sourced purchase date: "* Purchase date taken from the
  manufacturer's ship record."
- **Timeline cell rules**, copied exactly from `drawHandCell`'s `RUNWAY_COL`
  branch (`hardwareLifecyclePdf.ts:324-369`). Grid: `TIMELINE_QUARTERS_BEFORE =
  8` quarters before today, `TIMELINE_QUARTERS_AFTER = 12` after,
  `TIMELINE_QUARTERS = 20` cells total; `todayQ = TIMELINE_QUARTERS_BEFORE` is
  the fixed index every row shares, so the today rule sits at the same x
  position on every row. Portal-only improvement: this is computed against
  `new Date()` at render time, not `summary.generatedAt`, so a snapshot from
  three weeks ago still shows today as literally today. `dueQ = todayQ +
  quartersBetween(today, row.replaceBy)`, `boughtQ = todayQ +
  quartersBetween(today, row.purchaseDate)` (negative infinity with no
  purchase date). Fill: quarters in `[boughtQ, dueQ)` get the planned-life
  tint (a Tailwind opacity utility on the tone, replacing the PDF's `mix()`);
  the due quarter is solid tone; an overdue run (`dueQ < todayQ && q > dueQ &&
  q <= todayQ`) is solid tone through today, so an overdue row reads as a block
  of colour up to the line; every other quarter is the neutral rule colour.
  Label: "now" when overdue by under two weeks, else "N yr over" for overdue
  rows; "N yr out" only when the due date is off the drawn grid (`dueQ >=
  TIMELINE_QUARTERS`); otherwise no label, since the grid already shows the
  quarter. `yearsLabel` and `quartersBetween` are re-implemented in the
  component (PDF-file locals, not exported) with the same contract: months
  under a year, half-years above it. A row with no `replaceBy` draws no grid
  and no label; Status already reads "Purchase date unknown." **Hover**
  (portal-only): a native `title` attribute per quarter cell reading its
  quarter label, so a mouse user gets "Q3 2027" without a tooltip library,
  exposed through the existing accessible name rather than hidden from it.
- **Other equipment we manage:** lists `summary.other` names, capped at 8 with
  "and N more" via `humanJoin`, matching the PDF's fixed cap of 8, which differs
  from the table's cap of 4.
- **What we recommend:** renders `summary.recommendations` as a real `<ul>`; the
  PDF's `›` glyph becomes an HTML list marker, not a faked character.
- **Closing contact line:** "To approve or discuss this plan, contact \<name\>
  (\<email\>). We will send quotes for the "Now" group first," only when a
  partner contact email is configured, matching the PDF's guard on
  `opts.contactEmail`. Resolved: `loadReportBrandingForOrg`
  (`apps/api/src/services/reportBranding.ts`, on the #5701 branch) already
  returns `contactEmail`/`contactName` sourced from `partners.settings.contact`
  alongside the name/logo fields it already provides, and the PDF route
  already calls it for exactly this purpose. `LifecycleClosing` reuses that
  same function via the portal's own org-scoped call rather than deriving a
  second lookup; no new open question here.
- **Empty state:** no run exists yet. `EmptyState` (ui.tsx) with a Refresh
  button, copy "We have not generated your hardware lifecycle plan yet." No
  stale zero-row table renders.
- **All-green state:** every row `supported`. The schedule section renders
  nothing and `buildAtAGlanceFacts` returns an empty string when there is
  nothing beyond the counts, so the sentence line is simply absent, not a
  fabricated "everything is fine" sentence the shared helper does not produce.
- **Large-fleet state:** no pagination, matching the PDF (which paginates the
  physical page, with no portal equivalent). The plan table scrolls inside its
  own horizontally-scrolling wrapper like every other wide portal table; no row
  virtualization in W02/W03 (flagged as a risk in §10, since the generator has
  no row cap today).
- **Undated-fleet state:** every row `unknown`. `buildAtAGlanceFacts` produces
  its "we are still confirming purchase dates for all N computers" sentence,
  the schedule shows only the Purchase date unknown group, and every timeline
  cell is blank.
- **No em dashes anywhere in copy**, Todd's rule for this surface. New prose the
  components introduce (empty-state copy, hover labels) must avoid one too.
  Grepping the finished component files for the character is a W02/W03 review
  step.

## 6. Component split

New directory `apps/portal/src/components/lifecycle/`:

- `LifecycleStatusBar.tsx`: imports `countByReplacement`, `REPLACEMENT_LABELS`,
  `REPLACEMENT_BAND_DESCRIPTIONS`, `buildAtAGlanceFacts` from `@breeze/shared`.
- `LifecycleSchedule.tsx`: imports `buildReplacementSchedule`, `capNames`,
  `monthYear`, `quarterLabel` from `@breeze/shared`.
- `LifecyclePlanTable.tsx` (plus `TimelineCell.tsx` in the same directory):
  imports `rowLabel`, `rowSecondary`, `countByReplacement`, `REPLACEMENT_LABELS`
  from `@breeze/shared`; `TimelineCell` also needs `quarterLabel` for the hover
  title. `yearsLabel` and `quartersBetween` are private to the PDF file, not
  exported from `@breeze/shared`; reimplement them once in `TimelineCell.tsx`
  rather than exporting PDF-file internals across a jsPDF boundary. Promote
  them to `hardwareLifecycle.ts` only if a third consumer ever needs them.
- `LifecycleRecommendations.tsx`: renders `summary.recommendations` and
  `summary.other` (one file; both are simple list renders sharing `humanJoin`
  and `capNames`).
- `LifecycleClosing.tsx`: pure presentation of a contact string already
  resolved server-side, no shared imports.

**Must not duplicate** any date-formatting, band-labeling, schedule-grouping or
identity-naming logic that already exists in `hardwareLifecycle.ts`; import the
helper, never hand-roll an equivalent string template. The deliberate
exceptions are `yearsLabel`/`quartersBetween` above and the OS-risk-tag lookup,
a two-entry object literal in the PDF file not worth exporting for one caller.

Page: `apps/portal/src/pages/reports/lifecycle.astro` (server-fetches via
`portalApi.getHardwareLifecycleLatest()` plus `buildServerApiConfig`, the same
401/403 handling as `reports/index.astro`) mounts `LifecyclePage.tsx`, the
composition root laying out the six section components in order and owning the
Refresh button's request state, mirroring `ReportRunList`'s `generate()`.

**Decision C: route as `/reports/lifecycle`, or as a first-class `/hardware`
section?** (Renamed from this doc's earlier "Decision B" to avoid colliding
with the owner's Decision B2 in §3, an unrelated data-path decision.)

- **C1, `/reports/lifecycle`:** nested under the existing Reports nav item,
  reached by a link on `reports/index.astro`. No nav builder change.
- **C2, `/hardware`:** a first-class portal section with its own nav item,
  gated on the now-existing `enableLifecycle` flag directly. Matches the
  weight the issue's framing implies, but reads as a sibling of
  Dashboard/Security/Backups in the nav for a page whose data (§3) is still a
  `report_runs` row like every other report.
- **Resolved: C1.** Settled by §4's Nav paragraph: `buildPortalNavItems` gets
  no new branch even though `enableLifecycle` now exists as a flag it could
  key on. `buildPortalNavItems` has no concept of a nav item nested under
  another, so forcing this page into a top-level slot would place a
  same-domain page inconsistently relative to Reports in the nav for no
  stated customer benefit. `/reports/lifecycle` keeps the URL, the nav and the
  data model all telling the same story: this is a report, rendered live
  instead of only as a PDF, gated by its own flag in addition to Reports'.

## 7. API surface

One read endpoint, added to `apps/api/src/routes/portal/reports.ts`:

```
GET /portal/reports/lifecycle/latest
  -> 200 { run: { id: string, generatedAt: string }, summary: HardwareLifecycleSummary }
  -> 404 { error: 'Hardware lifecycle report has not been generated yet', code: 'PORTAL_REPORT_NOT_GENERATED' }
```

`generatedAt` in the response is `run.completedAt` formatted with
`auth.timezone`, the same `Intl.DateTimeFormat` call `renderRunPdf` already
makes, not `summary.generatedAt`, a raw ISO string with no timezone applied.

Backing service function `latestPortalHardwareLifecycleRun(orgId, timezone)` in
`reportsSelfService.ts`, sibling to `completedRun`: selects `reportRuns.result`,
`reportRuns.id`, `reportRuns.completedAt` from the query in §3, throws
`PortalReportNotFoundError` when no row matches, which the route maps to the
404 shape above, the same pattern the PDF route already uses for that exception.

**No response Zod schema.** Grepping the portal routes and
`packages/shared/src/validators` for a response-validation convention on portal
GETs found none: every existing portal GET DTO (`PortalRunDto`, `PortalRunsDto`,
the Wave-1 dashboard/security/backups DTOs) is a plain TypeScript type, not
re-validated with Zod on the way out. This endpoint follows the same
convention: a new `HardwareLifecyclePortalLatestDto` type is the schema, not a
`z.object`. This endpoint takes no params or query, so no request schema either.

**Rate limiting:** none on this GET; it is a plain read behind
`portalAuthMiddleware`, `createPortalFeatureGateStrict('enableReports')` (from
the `/reports/*` mount), and `createPortalFeatureGateStrict('enableLifecycle')`
(from the `/reports/lifecycle/*` mount, §4), the same ETag pattern as
`GET /reports/runs`. The existing 5-runs-per-hour bucket on
`POST /reports/generate` stays exactly where it is and applies to the Refresh
button automatically, since Refresh calls that same existing route with
`type: 'hardware_lifecycle'`; §4 covers why that shared route also needs the
predicate-level exclusion, since it is not under the `/reports/lifecycle/*`
gate.

**No list endpoint.** `GET /portal/reports/runs` already lists every completed
self-service run across all three types, newest first, and already powers
PDF/CSV download links per run once `hardware_lifecycle` is a
`PORTAL_REPORT_TYPES` member; that is what a customer uses for history or an
offline copy. The lifecycle page only ever needs the current one, so a second
list endpoint would duplicate `listPortalRuns` filtered to one type.

## 8. Testing

- **Route test** (`apps/api/src/routes/portal/reports.test.ts`, the file's
  existing mocked-Drizzle pattern): `GET /reports/lifecycle/latest` returns the
  mapped 200 shape on a completed run, 404 `PORTAL_REPORT_NOT_GENERATED` on no
  rows, and asserts the compiled `where` includes `reports.type =
  'hardware_lifecycle'` and `reports.orgId = <session org>` (the mocked test
  must assert the predicate shape, not just the response).
- **Live-DB integration test**, extending
  `apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts`
  with a `hardware_lifecycle` case: seed a completed run for org A under a
  `portalSelfService: true` definition, forge a portal session for org B, and
  assert `GET /reports/lifecycle/latest` 404s for org B, which has no id in the
  URL to substitute so the interesting forge is confirming org B's session
  simply cannot see org A's row at all. Also assert
  `provisionPortalReportDefinitions` is idempotent for the new third
  definition (re-run against an org that already has all three, assert exactly
  three rows).
- **Live-DB integration test, B2 config inheritance:** seed an MSP-side
  (`portalSelfService: false`) `hardware_lifecycle` definition with
  `config.replaceAgeYears: 6`, call `generatePortalReport({ type:
  'hardware_lifecycle' })` for that org, and assert the resulting run's
  `summary.replaceAgeYears === 6` (not the `PORTAL_DEFINITIONS` default of 4).
  A second case with no MSP-side definition present asserts the fallback
  still produces 4 / 5 / true / true.
- **Live-DB integration test, `enableLifecycle` gate leak:** with
  `enableReports: true, enableLifecycle: false`, assert `GET
  /reports/lifecycle/latest` 403s `PORTAL_LIFECYCLE_DISABLED`, `POST
  /reports/generate { type: 'hardware_lifecycle' }` 404s
  `PortalReportNotFoundError`'s shape, and (given a pre-existing
  hardware_lifecycle run from before the flag was turned off) `GET
  /reports/runs` excludes it while still listing the org's other report
  types, and `GET /reports/runs/:id/pdf` for that run's id 404s. This is the
  test that would have caught the Codex-flagged leak.
- **Component tests** for `TimelineCell`: reuse the three fixture rows from
  `packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` (SAM4:
  `replace`, purchased 2019-04-01, due 2023-04-01, overdue; LAW-SRV: `due_soon`
  server, purchased 2021-10-01 vendor-sourced, due 2026-11-30,
  warranty-extended; MacBook-Air: `unknown`, no dates) against a fixed today
  (`2026-06-10`, matching that fixture's `generatedAt`): SAM4 renders a solid
  overdue run through `todayQ` with an "N yr over" label; LAW-SRV renders a
  tinted planned-life run to a solid due quarter with no label; MacBook-Air
  renders no grid and no label. Add one synthetic purchased-and-due-this-week
  row for the "now" label threshold, which none of the three shipped rows
  exercises.
- **e2e** `e2e-tests/tests/portal-lifecycle.spec.ts` (new page object
  `e2e-tests/pages/PortalHardwareLifecyclePage.ts`, following
  `PortalVisibilityPage.ts`'s shape): enable `enableReports`, log in as a portal
  user, click Refresh, assert the status bar, schedule and both tables render
  with `data-testid`s, hover a timeline cell and assert its title attribute,
  and assert a device row link is present once §6's device-link mechanism
  exists (W03). DOM queried by `data-testid` only, per the e2e README
  convention.

### Portal contract tests the plans must satisfy

Two existing contract suites red on any new gated portal surface and are easy
to miss:

- `apps/portal/src/lib/visibilityGate.test.ts` asserts every `PORTAL_*_DISABLED`
  code in `apps/api/src/routes/portal/featureFlags.ts` is registered in
  `apps/portal/src/lib/visibilityGate.ts` (`PORTAL_DISABLED_CODES`). W01 adds
  `PORTAL_LIFECYCLE_DISABLED` on both sides in the same commit.
- `apps/portal/src/lib/disabledPageCoverage.test.ts` requires every portal page
  that calls a gated `portalApi` method to branch on that method's 403 code in
  its Astro frontmatter. W02 registers `getHardwareLifecycleLatest` in
  `GATED_API_METHODS` and gives `lifecycle.astro` the frontmatter branch.

## 9. Rollout

Three waves, each independently shippable once #5701 is on `main`.

- **W01, flag, API, and data path.**
  - Migration `apps/api/migrations/2026-10-16-181500-portal-lifecycle-flag.sql`
    (§4).
  - Flag wiring (§4, the `enableDocuments`-pattern sweep): `db/schema/portal.ts`
    (`enableLifecycle` column); `services/portal/portalFlags.ts`
    (`PORTAL_VISIBILITY_FLAG_KEYS`); `routes/portal/featureFlags.ts`
    (`STRICT_PORTAL_FEATURES` entry, `/reports/lifecycle/*` gate registration
    in `routes/portal/index.ts`); `routes/orgPortalSettings.ts`
    (`PORTAL_SETTINGS_DEFAULTS` + `onPortalFlagsChanged` current-flags object);
    `packages/shared/src/validators/portal.ts` (`updatePortalSettingsSchema`);
    `routes/portal/branding.ts` (authenticated `GET /branding` select);
    `apps/portal/src/lib/api.ts` (`BrandingConfig.enableLifecycle`);
    `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` plus every
    locale file under `apps/web/src/locales/*/settings.json`.
  - `services/tenantExportPolicyRegistry.ts`: add `enable_lifecycle` to the
    `portal_branding` row's `included` bucket.
  - `PORTAL_REPORT_TYPES` and `PORTAL_DEFINITIONS` third entry (§3);
    `generatePortalReport`'s B2 config-inheritance lookup (§3);
    `portalRunListPredicate`/`portalRunPredicate`'s `lifecycleEnabled` param
    plus their three call sites (§4); `latestPortalHardwareLifecycleRun`
    service function; `GET /portal/reports/lifecycle/latest` route;
    `HardwareLifecyclePortalLatestDto` type.
  - Tests: route test, B2 config-inheritance integration test, and
    `enableLifecycle` gate-leak integration test (§8); a one-time script (not
    a migration) to re-run `provisionPortalReportDefinitions` for orgs that
    already have `enable_reports = true`.
  - `ReportRunList`'s generic Generate/Download UI also gains the third type
    this wave (its `ReportType` union, a `GENERATING_COPY` entry, a third
    button), since it is the only way to produce the first run before the
    dedicated page can offer its own Refresh; this button itself still needs
    `enableLifecycle` true to succeed, per §4's predicate change.
- **W02, page island plus Reports-page card, no timeline hover yet.**
  `LifecycleStatusBar`, `LifecycleSchedule`, `LifecyclePlanTable` (fill and
  label render, no `title` hover yet), `LifecycleRecommendations`,
  `LifecycleClosing`; `reports/lifecycle.astro` plus `LifecyclePage.tsx` with
  Refresh wired to the existing generate endpoint; empty, all-green and
  undated states; component tests for everything except `TimelineCell`'s
  hover. `apps/portal/src/pages/reports/index.astro`: call `loadPortalBranding`
  and render the "Hardware lifecycle" card/link only when
  `branding.enableLifecycle === true` (§4 Nav, decision C1).
- **W03, timeline hover, device links, branding proof, e2e.** `TimelineCell`
  hover titles; the device-link mechanism; a manual check that the page picks
  up a non-default `portal_branding.primaryColor` with no code changes (the
  tokens are already proven elsewhere, so this is QA, not a new test);
  `portal-lifecycle.spec.ts`.

  **Device links need new portal work, not reuse.** `DeviceList.tsx` is a flat
  table with no per-row link, and no device detail route exists anywhere under
  `apps/portal/src/pages/devices/` (only `index.astro`). The issue's framing,
  "rows link to the device where the portal already shows devices," assumes a
  destination that does not exist. Minimal fix, consistent with CLAUDE.md's
  hash-based UI-state convention: link a row to `/devices#<deviceId>` and add
  an effect to `DeviceList.tsx` that scrolls to and highlights the row whose id
  matches `window.location.hash` on mount. New portal work, scoped to W03.

## 10. Open questions

1. Large-fleet performance: the report generator has no row cap and the plan
   table has no virtualization plan (§5). Is a few-hundred-row org common
   enough today to require it in W02/W03, or a "revisit if it happens" risk?
2. The one-time re-provisioning script (W01): run by hand once, or a logged
   backfill job, following the service-deliverables spec's precedent?
3. Should the Refresh button's 429 state reuse `ReportRunList`'s
   `Retry-After` copy, or does "Refresh" need its own wording?
4. `enableLifecycle` "required alongside `enableReports`" (§4) is a business
   rule, not a DB or schema constraint: nothing stops an MSP from turning on
   `enableLifecycle` while `enableReports` is off, which the route gates
   (§4) correctly refuse end to end, but the settings UI would show a Lifecycle
   toggle that silently does nothing until Reports is also on. Should
   `OrgPortalSettingsEditor.tsx` disable/gray out the Lifecycle toggle until
   Reports is checked, or just document the dependency in copy next to it?
