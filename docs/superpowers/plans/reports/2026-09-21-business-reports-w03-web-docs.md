---
tracking_issue: LanternOps/breeze#3198
spec: docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md
wave: W03 — Web templates, options forms, locales, docs (one PR)
blast_radius: medium (web-only surface over an already-shipped tenancy foundation; no migration, no RLS, no generator — but it is the first UI that lets a partner-scope user create a cross-org report, so the ownerScope gate and the contact-recipient refusal are the two places a mistake becomes a data-exposure paper cut)
---

# Business Reports W03: Web Templates, Options Forms, Locales and Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put W02's three business report types in front of a human — three curated templates in a new "Business" group of the templates gallery, three options forms, the create-only `ownerScope` selector that W01's routes already accept, the summary blocks in the preview, raw-numeric CSV/XLSX export, eight locales, the `apps/docs` reports page, and one Playwright spec that creates a partner-owned AR aging report end to end.

**Architecture:** Nothing here invents a mechanism. The gallery already merges saved reports onto curated cards (`mergeTemplates`); this wave adds a `group` discriminator to `ReportTemplate` and renders two labelled sections over the *same* merged array, so merge semantics are untouched. The three types are **builder-opaque** — `reportTypeSurvivesBuilder` returns false for all three, so `handleUseTemplate` routes them to their own options form and `handleCreateDirect` POSTs the true type, exactly as `identity_access_review` does (`ReportTemplates.tsx:531-535`). The options forms follow `IdentityAccessOptionsForm.tsx`'s four-export shape (`Options` type, `DEFAULT_*`, `*Fields`, `*Form` + `*OptionsFromConfig`) so `ReportEditPage` wires them identically. The one genuinely new affordance is the `ownerScope` selector, gated on the JWT scope claim, and the "All organizations" badge on the list — both copied from the config-policy/software-policy precedent rather than invented.

**Tech Stack:** Astro + React islands, Tailwind design tokens only (`bg-card`, `text-muted-foreground`, `bg-primary/10 text-primary` — **no new colours**), `react-i18next` with the `reports` / `settings` / `common` namespaces, Vitest + jsdom + Testing Library, Playwright (`data-testid` selectors only), Starlight MDX for `apps/docs`.

**Spec:** `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` — §2 (users: partner-scope first; portal exposure is out of scope), §3.2 (aggregate-always / detail-rows-capped), §3.3 (the three reports and their disclosed approximations), §3.4 (`moneyFormat.ts`, CSV emits raw numerics + `currency_code`, never formatted strings), §3.5 (builder-opaque, "Business" template group, never portal-visible), §7 (placement under `/reports`; the Settings billables card gains a link and is **not** removed), §10 (rollout: W03 = web templates + options forms + 8 locales + docs + release notes).

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Three type ids, verbatim, everywhere:** `ticket_sla_attainment`, `technician_time_billability`, `ar_aging`. Labels: "Ticket SLA attainment", "Technician time & billability", "AR aging". The spec calls R2 `technician_utilization` in one place (§3.3 heading); the id is `technician_time_billability`.
2. **Builder-opaque.** The 5-value builder vocabulary (`devices | alerts | patches | compliance | activity`) is untouched (spec §3.5, Open Decision 5 = A). All three map into `legacyToBuilderType` only to keep that `Record` exhaustive.
3. **Never portal-visible.** The three types are not added to `PortalRunDto['type']`, not to the portal's local `ReportType` union, not to `PORTAL_REPORT_TYPES`, and not to `GENERATING_COPY`. Task 9 makes that a test, not a convention.
4. **No new colours.** Reuse the existing tone palette in `ReportTemplates.tsx:120-215` (`bg-indigo-500/15 text-indigo-600`, `bg-emerald-500/15 text-emerald-600`, `bg-cyan-500/15 text-cyan-600`, `bg-sky-500/15 text-sky-600`, `bg-rose-500/15 text-rose-600`) and the existing badge idiom (`ScopeBadge`, `apps/web/src/components/shared/ScopeBadge.tsx`).
5. **Every mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`). `ReportTemplates.tsx`'s create POST already does (`:468-489`); Task 4 adds the file to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` so it cannot regress. `ReportsList.tsx` stays in `RUN_ACTION_MIGRATION_BACKLOG` (`apps/web/src/lib/runActionAllowlist.ts:45-51`) — W03 adds no mutation to it, and moving it would flag the untouched `handleDelete`.
6. **`data-testid` on everything a test asserts** (`e2e-tests/README.md`: "`data-testid`-based selectors only — this is a hard rule, not a guideline"), named `<domain>-<element>[-<modifier>]`, lowercase kebab-case.
7. **Eight locale files, every key, in all of them.** `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. `apps/web/src/lib/i18n/localeParity.test.ts` fails on a key present in one catalog and missing in another, and on mismatched interpolation tokens; `translationCoverage.test.ts` caps exact-English duplicates per namespace, so a non-English file **must** carry a real translation, not the English string.
8. **Money is `numeric` — strings in JS.** Never `Number()` a money value for display; hand the string to `formatMoney`. CSV/XLSX emit the **raw** numeric string plus a `currency_code` column (spec §3.4); a formatted string in an export is a bug.
9. **Percent values are fractions (0–1) in the summary**, formatted by `formatPercent`. Minutes are integers, formatted by `formatMinutes`.
10. **`null` ≠ 0.** An unmeasured figure renders as the locale's "not measured" string, never a zero — the rule every existing preview arm follows (`ReportPreview.tsx:311-312`, `:424-425`, `:478-479`).
11. **Test commands are exact.** Web unit: `cd apps/web && npx vitest run <path>`. Portal: `cd apps/portal && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into argv, vitest swallows `--run` as a positional filter, and the full suite runs in watch mode (CLAUDE.md, verified repro: 1,470 files).
12. **One commit per task**, message in the repo's conventional-commit style, ending with the attribution line.

---

## Consumed from W01 and W02 (names are binding — this wave does not guess them)

W03 assumes W01 and W02 are merged. Every symbol below is fixed by the shared brief and by W02's plan; if an implementer finds a mismatch, **W02 wins** and this plan is amended, not worked around.

```ts
// packages/shared/src/reportTypes.ts                                    (W02)
export const REPORT_TYPES = [
  'device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance',
  'executive_summary', 'security_compliance_posture', 'ai_org_narrative', 'ai_fleet_design',
  'hardware_lifecycle', 'threat_detection_review', 'endpoint_management_review',
  'vulnerability_management', 'identity_access_review',
  'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

// packages/shared/src/reportPdf/moneyFormat.ts                          (W02)
export function formatMoney(value: string | number, currencyCode: string, locale?: string): string;
export function formatPercent(value: number, digits?: number): string;   // takes a FRACTION (0.87 → "87%")
export function formatMinutes(minutes: number): string;                  // 5405 → "90h 5m"

// packages/shared/src/types/businessReports.ts                          (W02)
export type ReportPeriodKind = 'last_full_month' | 'last_30_days' | 'last_quarter' | 'custom';
export type ReportPeriodConfig = { kind: ReportPeriodKind; start?: string; end?: string };
export type ResolvedReportPeriod = { start: string; end: string; label: string };
export type ReportTruncation = { detailRows: number; cap: number };

export type TicketSlaGroupRow = {
  key: string; label: string;
  ticketsConsidered: number;
  responseMet: number; responseTotal: number; responseAttainment: number | null;
  resolutionMet: number; resolutionTotal: number; resolutionAttainment: number | null;
  breaches: number;
};
export type TicketSlaSummary = {
  period?: ResolvedReportPeriod;
  scope?: 'organization' | 'partner';
  groupBy?: 'organization' | 'priority' | 'technician' | 'category';
  ticketsConsidered?: number | null;
  noSlaSet?: number | null;
  responseAttainment?: number | null;
  resolutionAttainment?: number | null;
  breachCount?: number | null;
  stampedBreachCount?: number | null;
  recomputedVsStampedDelta?: number | null;
  worst?: { label: string; attainment: number } | null;
  groups?: TicketSlaGroupRow[];
  truncated?: ReportTruncation | null;
  footnotes?: string[];
};

export type TechnicianTimeGroupRow = {
  key: string; label: string;
  loggedMinutes: number; capacityMinutes: number; utilization: number | null;
  billableMinutes: number; includedMinutes: number; nonBillableMinutes: number;
  billablePercent: number | null;
  convertedMinutes: number; billingConversion: number | null;
};
export type BillableValueRow = {
  currencyCode: string; billableValue: string; billableMinutes: number; averageHourlyRate: string | null;
};
export type TechnicianTimeSummary = {
  period?: ResolvedReportPeriod;
  scope?: 'organization' | 'partner';
  groupBy?: 'technician' | 'organization' | 'work_type';
  weeklyCapacityHours?: number; workingDays?: number;
  techniciansConsidered?: number | null; zeroTimeTechnicians?: number | null;
  loggedMinutes?: number | null; capacityMinutes?: number | null; utilization?: number | null;
  billableMinutes?: number | null; includedMinutes?: number | null; nonBillableMinutes?: number | null;
  billablePercent?: number | null; billingConversion?: number | null;
  billableValueByCurrency?: BillableValueRow[];
  coverageFallbackRows?: number | null;
  groups?: TechnicianTimeGroupRow[];
  truncated?: ReportTruncation | null;
  footnotes?: string[];
};

export type ArAgingBucketKey =
  'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'no_due_date' | 'other_open';
export type ArAgingBuckets = Record<ArAgingBucketKey, string>;          // numeric STRINGS
export type ArAgingCurrencyRow = {
  currencyCode: string; total: string; buckets: ArAgingBuckets; invoiceCount: number;
};
export type ArAgingGroupRow = {
  key: string; label: string; currencyCode: string; total: string;
  buckets: ArAgingBuckets; invoiceCount: number;
};
export type ArAgingSummary = {
  asOf?: string; timeZone?: string;
  scope?: 'organization' | 'partner';
  groupBy?: 'organization' | 'currency';
  includePaidInPeriod?: boolean;
  byCurrency?: ArAgingCurrencyRow[];
  groups?: ArAgingGroupRow[];
  truncated?: ReportTruncation | null;
  footnotes?: string[];
};
```

Every field is optional because the summary is **persisted** in `report_runs.result` and a legacy snapshot must still render — the rule `packages/shared/src/types/identityAccessReport.ts:1-20` states for `IdentityAccessSummary` and every arm of `ReportPreview.tsx` already honours.

**Config schemas (W02, enforced server-side; the forms must not emit anything outside them):**

| Type | Config |
|---|---|
| `ticket_sla_attainment` | `{ period: ReportPeriodConfig; groupBy: 'organization'\|'priority'\|'technician'\|'category'; includeNoSla: boolean }` — `groupBy` defaults `'organization'` at partner scope, `'priority'` at org scope; `includeNoSla` defaults `true` |
| `technician_time_billability` | `{ period; groupBy: 'technician'\|'organization'\|'work_type'; weeklyCapacityHours: number 1..80 }` — defaults `'technician'`, `40` |
| `ar_aging` | `{ asOf?: ISO date; groupBy: 'organization'\|'currency'; includePaidInPeriod: boolean }` — defaults: `asOf` absent (run time), `'organization'`, `false` |

**From W01 (routes):** `POST /reports` accepts `ownerScope: 'organization' | 'partner'` (default `'organization'`), create-only; the update schema omits it. `GET /reports` rows carry `orgId: string | null` and `partnerId: string | null`. The partner id is **always** derived server-side from `auth.partnerId` — the client never sends one (2026-07-01 design §7.2).

---

## Plan amendments (decisions this plan makes, recorded because the spec does not pin them)

1. **`useJwtClaims()`, not `getJwtClaims()`, for the render-time gate.** The 2026-07-01 design §6 and the wave brief both say `getJwtClaims().scope === 'partner'`. `apps/web/src/lib/authScope.ts:78-91` documents why that is wrong *in render*: the access token is never persisted, so on a cold load the one-shot read returns all-null claims and freezes that answer for the life of the mount — the selector would simply never appear for a partner admin who hard-refreshed `/reports/templates`. This plan uses the reactive `useJwtClaims()` (`authScope.ts:92-98`) and narrows on `status === 'resolved'`, which is the same decision, correctly sourced. The one-shot `getJwtClaims()` is still used inside the POST body builder, where a stale answer cannot outlive the call. **The gate is the JWT scope claim, never `useOrgStore().partners.length`** — that part of the design doc is binding.
2. **`BillablesExportCard.tsx` lives in `apps/web/src/components/billing/`, not `settings/`** (verified: `apps/web/src/components/billing/BillablesExportCard.tsx`, rendered at `InvoicesPage.tsx:916`). Its i18n namespace is nonetheless `settings` (`useTranslation('settings')`, `:20`), so the new link key goes in `settings.json`, not `reports.json`.
3. **There is no run-detail page.** `ReportPreview.tsx` is mounted only by `ReportBuilderPage.tsx:108` (verified by grep across `apps/web/src`). A completed run is opened through `ReportsList.handleDownload` (`ReportsList.tsx:254-...`), which for a PDF fetches the stored snapshot and re-renders it client-side via `exportReport`. So Task 5 does two things: the three preview arms in `ReportPreview.tsx` (ad-hoc generate path), **and** widening the `summary` union in `reportExport.ts` and at the `ReportsList` call site. That second half is the one that actually matters: if the union is not widened, the designed summary is dropped at the call site and `buildReportPdf` silently falls through to the generic row table — the exact silent failure #5784 W03/W04/W06 each had to close by hand.
4. **Release notes: `CHANGELOG.md` in-repo, plus a drafted entry in the PR body.** The `update-breeze-release-notes` skill (`~/.claude/skills/update-breeze-release-notes/SKILL.md`) writes to `src/content/releases/YYYY-MM-DD-vX-Y-Z.md` in the **marketing website repo** (`/Users/toddhebebrand/breezermm.com website`), which is not this repo's tree, and its own rule is that content comes from merged PRs at release time. W03 therefore writes the in-repo `CHANGELOG.md` `[Unreleased] → Added` entry (committable, Task 10) and includes a ready-to-paste `added:` block in the PR body in the skill's exact schema, so the release cut can lift it verbatim.
5. **"Business" renders as the first labelled section.** Spec §2: "the default lens for every business report is *all my clients*" and the MSP owner is the primary user. The existing curated order is preserved *within* the general group, so no existing card moves relative to another.
6. **`ReportPeriodField.tsx` is a shared component, not three copies.** All three config schemas take the same `ReportPeriodConfig`; three hand-rolled pickers would drift. It ships with the SLA form (Task 3) and is imported by the other two.
7. **The partner-owned recipient refusal is enforced in `ReportBuilder.tsx`, because that is where the contact picker lives** (`ReportBuilder.tsx:814-842` fetch, `:2205-2227` render). `ReportEditPage` passes the loaded report's ownership down; a partner-owned definition skips the contacts fetch entirely and renders the free-text email list with an explanatory note. This mirrors the server, which answers `409 partner_owned_report` on the recipient writer (spec §3.1a).

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/web/src/components/reports/ReportPeriodField.tsx` | The shared period picker (`kind` select + custom start/end), `DEFAULT_REPORT_PERIOD`, `reportPeriodFromConfig` |
| `apps/web/src/components/reports/ReportPeriodField.test.tsx` | Period picker unit tests |
| `apps/web/src/components/reports/TicketSlaOptionsForm.tsx` | R1 options (period, group-by, include-no-SLA) |
| `apps/web/src/components/reports/TicketSlaOptionsForm.test.tsx` | R1 options unit tests |
| `apps/web/src/components/reports/TechnicianTimeOptionsForm.tsx` | R2 options (period, group-by, weekly capacity hours) |
| `apps/web/src/components/reports/TechnicianTimeOptionsForm.test.tsx` | R2 options unit tests |
| `apps/web/src/components/reports/ArAgingOptionsForm.tsx` | R3 options (as-of, group-by, include-paid) |
| `apps/web/src/components/reports/ArAgingOptionsForm.test.tsx` | R3 options unit tests |
| `apps/web/src/components/reports/ReportOwnerScopeField.tsx` | Create-only Organization / All-organizations selector |
| `apps/web/src/components/reports/ReportOwnerScopeField.test.tsx` | Owner-scope gate unit tests |
| `apps/web/src/components/reports/ReportTemplates.business.test.tsx` | Gallery grouping + the three cards + ownerScope in the POST body |
| `apps/web/src/components/reports/ReportPreview.business.test.tsx` | The three summary blocks |
| `apps/web/src/components/reports/reportExport.business.test.tsx` | Raw numerics + `currency_code` in CSV/XLSX; summary reaches the PDF |
| `apps/web/src/components/reports/businessReportRows.ts` | `businessReportExportRows(type, summary, rows)` — flattens a business summary to export rows |
| `apps/web/src/components/reports/businessReportRows.test.ts` | Export-row shaping tests |
| `e2e-tests/pages/ReportsPage.ts` | Page object: templates gallery, owner scope, reports list, run open |
| `e2e-tests/tests/business-reports.spec.ts` | Partner-owned AR aging: create from template → generate → open |

**Modified**

| File | Change |
|---|---|
| `apps/web/src/components/reports/ReportsList.tsx` | `ReportType` derived from `REPORT_TYPES`; `Report` gains `orgId`/`partnerId`; `ScopeBadge` on partner-owned rows; `report-row-<id>` testid; the three summary types in the `handleDownload` summary cast |
| `apps/web/src/components/reports/ReportBuilder.tsx` | Three entries in `legacyToBuilderType`; `partnerOwned` prop gating the contacts fetch + picker |
| `apps/web/src/components/reports/reportTypeSurvivesBuilder.test.ts` | Three new false expectations |
| `apps/web/src/components/reports/ReportTemplates.tsx` | `group` on `ReportTemplate`; three curated templates; two labelled sections; three options-form modals; `ownerScope` in the create POST; card/use testids |
| `apps/web/src/components/reports/ReportTemplates.savedReportMerge.test.tsx` | "Use template" count 10 → 13 |
| `apps/web/src/components/reports/ReportEditPage.tsx` | Three `*OptionsFields` panels + `baseConfig` arms; `partnerOwned` passthrough |
| `apps/web/src/components/reports/ReportPreview.tsx` | Three summary arms; suppress the generic cards for them |
| `apps/web/src/components/reports/reportExport.ts` | Summary union +3; business rows path |
| `apps/web/src/components/billing/BillablesExportCard.tsx` | "See business reports" link |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | `ReportTemplates.tsx` into `TARGET_GLOBS` |
| `apps/web/src/locales/*/reports.json` (×8) | All new report keys |
| `apps/web/src/locales/*/settings.json` (×8) | `billablesExport.seeBusinessReports` |
| `apps/portal/src/components/portal/ReportRunList.test.tsx` | Negative test: the three types never render |
| `packages/shared/src/types/portalVisibility.test.ts` | Type-level assertion that `PortalRunDto['type']` excludes the three |
| `apps/docs/src/content/docs/features/reports.mdx` | Report-types table rows + a "Business Reports" section |
| `CHANGELOG.md` | `[Unreleased] → Added` |

---

## Task 1: Derive the web `ReportType` from `REPORT_TYPES` and make the three types builder-opaque

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx:35-74`
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx:159-205`
- Test: `apps/web/src/components/reports/reportTypeSurvivesBuilder.test.ts:27-52`

**Interfaces:**
- Consumes: `REPORT_TYPES`, `ReportType` from `@breeze/shared` (W02).
- Produces: `ReportType` re-exported from `ReportsList.tsx` (every reports component imports it from there today — `ReportBuilder.tsx:27`, `ReportPreview.tsx:14`, `ReportEditPage.tsx:4`); `reportTypeSurvivesBuilder(type) === false` for the three business types.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/reports/reportTypeSurvivesBuilder.test.ts`, inside the existing `it('returns false for types the builder would downgrade', …)` block (`:27-52`), before its closing brace:

```ts
    // #3198 W03 — the three business types are curated, template-only, and
    // carry config the freeform builder has no vocabulary for (a period, a
    // group-by axis, a capacity assumption). Mapping them into
    // `legacyToBuilderType` keeps that Record exhaustive; this assertion is
    // what stops the builder from claiming it can author them.
    expect(reportTypeSurvivesBuilder('ticket_sla_attainment')).toBe(false);
    expect(reportTypeSurvivesBuilder('technician_time_billability')).toBe(false);
    expect(reportTypeSurvivesBuilder('ar_aging')).toBe(false);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/reports/reportTypeSurvivesBuilder.test.ts`
Expected: FAIL — TypeScript rejects the three string literals because they are not members of `ReportBuilderType`.

- [ ] **Step 3: Derive the union from the shared tuple**

In `apps/web/src/components/reports/ReportsList.tsx`, replace the hand-written union at `:35-74` with:

```ts
import { type ReportType as SharedReportType } from '@breeze/shared';

/**
 * The web's report-type union is DERIVED from the shared canonical tuple
 * (`packages/shared/src/reportTypes.ts`, #3198 W02) rather than hand-listed.
 * The previous hand-list was the third copy of the same closed set (PG enum,
 * zod, TS ×2); every new type meant editing all of them and the compiler
 * checked none of the copies against each other. Labels still come from the
 * dynamic i18n lookup in `getReportTypeLabel`, so there is no map to extend
 * here — only the locale files (Task 7).
 */
export type ReportType = SharedReportType;
```

Keep `SYSTEM_MANAGED_REPORT_TYPES` and `isSystemManagedReportType` exactly as they are (`:66-74`) — the business types are **not** system-managed (a user authority always runs them, spec §3.5).

In the same file, widen `Report` (`:80-91`) with the two ownership columns W01's routes now return:

```ts
export type Report = {
  id: string;
  name: string;
  type: ReportType;
  /** Exactly one of `orgId` / `partnerId` is set (#3198 W01,
   *  `reports_one_owner_chk`). A partner-owned row aggregates across every
   *  organization of the partner and is badged accordingly in the list. */
  orgId: string | null;
  partnerId: string | null;
  schedule: ReportSchedule;
  format: ReportFormat;
  config: Record<string, unknown>;
  portalSelfService: boolean;
  lastGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 4: Map the three into the builder's Record**

In `apps/web/src/components/reports/ReportBuilder.tsx`, append to `legacyToBuilderType` (after `identity_access_review: 'devices'`, `:204`):

```ts
  // #3198 W03 — the three business types are curated, template-only, and the
  // freeform builder has no vocabulary for a reporting period, a group-by axis
  // or a capacity assumption. These entries exist ONLY to keep this Record
  // exhaustive over `ReportType` and to make
  // `reportTypeSurvivesBuilder('<type>')` false, so a code path that somehow
  // reached the builder degrades to a data source instead of crashing.
  ticket_sla_attainment: 'compliance',
  technician_time_billability: 'activity',
  ar_aging: 'activity'
```

- [ ] **Step 5: Run the test and the builder suite**

Run: `cd apps/web && npx vitest run src/components/reports/reportTypeSurvivesBuilder.test.ts src/components/reports/ReportBuilder.test.tsx`
Expected: PASS, both files.

- [ ] **Step 6: Typecheck the package**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: clean. If `ReportPreview.tsx`'s type-narrowing chain (`:519`) or the portal type complains, stop — that is Task 5 / Task 9 work and must not be papered over here.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/reports/ReportsList.tsx \
        apps/web/src/components/reports/ReportBuilder.tsx \
        apps/web/src/components/reports/reportTypeSurvivesBuilder.test.ts
git commit -m "feat(reports): derive the web ReportType from REPORT_TYPES and make the three business types builder-opaque (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: A "Business" group in the templates gallery, with the three curated cards

**Files:**
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx:56-102` (types + type list), `:107-268` (`defaultTemplates`), `:304-348` (`normalizeTemplate`), `:350-385` (`mergeTemplates`), `:612-672` (the grid)
- Modify: `apps/web/src/components/reports/ReportTemplates.savedReportMerge.test.tsx:79`
- Test: `apps/web/src/components/reports/ReportTemplates.business.test.tsx` (new)

**Interfaces:**
- Consumes: `ReportType` (Task 1).
- Produces: `ReportTemplate.group: 'business' | 'general'`; testids `report-template-group-business`, `report-template-group-general`, `report-template-card-<id>`, `report-template-use-<id>`, `reports-templates-heading`; i18n keys `reports.reportTemplates.groups.business`, `.groups.general`, `.groups.businessDescription`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/ReportTemplates.business.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// Org-scope token: the owner-scope selector must NOT appear (Task 4 asserts the
// partner case). Declared here so this file's assertions are about grouping.
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } }),
  getJwtClaims: () => ({ scope: 'organization', orgId: 'org-1', partnerId: 'p-1' }),
}));

import ReportTemplates from './ReportTemplates';

function mockTemplatesFetch(onPost: () => Promise<unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    if (url === '/reports' && init?.method === 'POST') return onPost();
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

describe('ReportTemplates — Business group (#3198 W03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the three business templates inside a labelled Business section', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    const business = await screen.findByTestId('report-template-group-business');
    for (const id of ['ticket_sla_attainment', 'technician_time_billability', 'ar_aging']) {
      expect(within(business).getByTestId(`report-template-card-${id}`)).toBeInTheDocument();
    }
    // …and they are NOT duplicated into the general section.
    const general = screen.getByTestId('report-template-group-general');
    expect(within(general).queryByTestId('report-template-card-ar_aging')).toBeNull();
    // The existing curated cards keep their home.
    expect(within(general).getByTestId('report-template-card-identity_access_review')).toBeInTheDocument();
  });

  it('opens the AR aging options form rather than the freeform builder, and posts the schema defaults', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await userEvent.setup().click(await screen.findByTestId('report-template-use-ar_aging'));
    // The curated options form, not the builder — the builder would downgrade
    // the type to a plain activity report.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({
      type: 'ar_aging',
      orgId: 'org-1',
      format: 'pdf',
      config: { groupBy: 'organization', includePaidInPeriod: false },
    });
    // `asOf` is deliberately ABSENT by default: the server evaluates "as of" at
    // run time in the owner's timezone (spec §3.3 R3). Sending today's date
    // would freeze a scheduled monthly report to its creation date.
    expect(postBody().config.asOf).toBeUndefined();
  });

  it('posts the SLA attainment defaults from its own options form', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-2' } }) }));
    render(<ReportTemplates />);

    await userEvent.setup().click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await userEvent.setup().click(screen.getByTestId('ticket-sla-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toMatchObject({
      period: { kind: 'last_full_month' },
      groupBy: 'priority',
      includeNoSla: true,
    });
  });

  it('posts the technician time defaults, capacity included', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-3' } }) }));
    render(<ReportTemplates />);

    await userEvent.setup().click(await screen.findByTestId('report-template-use-technician_time_billability'));
    await userEvent.setup().click(screen.getByTestId('technician-time-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toMatchObject({
      period: { kind: 'last_full_month' },
      groupBy: 'technician',
      weeklyCapacityHours: 40,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.business.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="report-template-group-business"]`.

- [ ] **Step 3: Add the group discriminator and the three templates**

In `apps/web/src/components/reports/ReportTemplates.tsx`:

Add `Banknote`, `Gauge`, `Timer` to the `lucide-react` import (`:2-15`) — all three already ship with the installed lucide version; no new dependency.

Extend the `ReportTemplate` type (`:61-69`):

```ts
/** Which labelled section of the gallery a card sits in. Curated business
 *  reports (#3198) are the MSP's own numbers — SLA, utilisation, money — and
 *  read differently from the customer-facing evidence artifacts, so they get
 *  their own section rather than a fourteenth card in one flat grid. A saved
 *  report inherits its curated fallback's group; an unmatched saved report is
 *  'general'. */
type TemplateGroup = 'business' | 'general';

type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  defaults: Partial<ReportBuilderFormValues>;
  icon: ElementType;
  tone: TemplateTone;
  group: TemplateGroup;
  previewImage?: string;
};
```

Add the three ids to `reportTypeValues` (`:85-102`), after `'identity_access_review'`:

```ts
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
```

Prepend the three curated entries to `defaultTemplates` (`:107`), and add `group: 'general'` to each of the nine existing entries:

```ts
const defaultTemplates: ReportTemplate[] = [
  {
    id: 'ticket_sla_attainment',
    name: 'Ticket SLA attainment',
    description:
      'Response and resolution attainment for the period, recomputed from the ticket timestamps rather than read off the breach stamps — so a ticket answered late but eventually answered still counts as a miss. Grouped by organization, priority, technician or category.',
    defaults: {
      name: 'Ticket SLA attainment',
      type: 'ticket_sla_attainment',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Gauge,
    tone: { iconBg: 'bg-indigo-500/15', iconColor: 'text-indigo-600' },
    group: 'business'
  },
  {
    id: 'technician_time_billability',
    name: 'Technician time & billability',
    description:
      'Logged time against an assumed weekly capacity, the billable / included / non-billable split, and how much of the billable time has actually been approved and billed. Technicians with no time in the period are listed at zero rather than dropped.',
    defaults: {
      name: 'Technician time & billability',
      type: 'technician_time_billability',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Timer,
    tone: { iconBg: 'bg-emerald-500/15', iconColor: 'text-emerald-600' },
    group: 'business'
  },
  {
    id: 'ar_aging',
    name: 'AR aging',
    description:
      'Unpaid invoice balances bucketed current / 1–30 / 31–60 / 61–90 / 90+ days past due, one set of totals per currency with no conversion. Invoices with no due date get their own bucket, never "current".',
    defaults: {
      name: 'AR aging',
      type: 'ar_aging',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Banknote,
    tone: { iconBg: 'bg-cyan-500/15', iconColor: 'text-cyan-600' },
    group: 'business'
  },
  // … the nine existing entries, each gaining `group: 'general'`
];
```

In `normalizeTemplate` (`:327-347`), carry the group through from the fallback:

```ts
    icon: fallback?.icon ?? FileText,
    tone: fallback?.tone ?? {
      iconBg: 'bg-slate-500/15',
      iconColor: 'text-slate-600'
    },
    // A saved report that matched a curated card sits in that card's section;
    // an unmatched one is a user's own report and belongs in General.
    group: fallback?.group ?? 'general',
    previewImage
```

`mergeTemplates` (`:350-385`) is **unchanged** — it still returns one flat, ordered array (curated slots in `defaultTemplates` order, then extras). Grouping is a render-time partition of that array, so every merge property the existing suite pins (one card per saved report, curated slot replacement, id dedupe, extras last) still holds.

- [ ] **Step 4: Render two labelled sections over the merged array**

Replace the grid at `:612-672` with a partition plus a small section component. Above `export default function ReportTemplates()`, add:

```tsx
/** One labelled section of the gallery. The grid classes are lifted verbatim
 *  from the previous flat grid so card layout is unchanged. */
const TemplateSection = ({
  group,
  title,
  description,
  children,
}: {
  group: TemplateGroup;
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <section data-testid={`report-template-group-${group}`} className="space-y-4">
    <div>
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  </section>
);
```

Inside the component, after `templates` is in scope:

```tsx
  const businessTemplates = useMemo(() => templates.filter(t => t.group === 'business'), [templates]);
  const generalTemplates = useMemo(() => templates.filter(t => t.group !== 'business'), [templates]);
```

Extract the existing per-card JSX into a local `renderCard(template: ReportTemplate)` (the body of the old `templates.map` callback, unchanged except for the two testids below), then render:

```tsx
      <div className="space-y-8">
        {businessTemplates.length > 0 && (
          <TemplateSection
            group="business"
            title={t('reports.reportTemplates.groups.business')}
            description={t('reports.reportTemplates.groups.businessDescription')}
          >
            {businessTemplates.map(renderCard)}
          </TemplateSection>
        )}
        <TemplateSection group="general" title={t('reports.reportTemplates.groups.general')}>
          {generalTemplates.map(renderCard)}
        </TemplateSection>
      </div>
```

In `renderCard`, add the two testids — the card wrapper (`:624-627`) gains `data-testid={`report-template-card-${template.id}`}` (keep `className="group …"`, the identity-access test matches on `div.group`), and the "Use template" button (`:659-667`) gains `data-testid={`report-template-use-${template.id}`}`. Add `data-testid="reports-templates-heading"` to the `h1` at `:583`.

- [ ] **Step 5: Update the merge-count assertion**

`ReportTemplates.savedReportMerge.test.tsx:79` asserts 10 "Use template" buttons (9 curated + the expanded hardware-lifecycle slot). Three curated cards land, so:

```ts
    // #3198 W03 added the three business cards (Ticket SLA attainment,
    // Technician time & billability, AR aging), so the curated count is 12
    // with the hardware-lifecycle slot expanded from 1 card to 2.
    expect(screen.getAllByRole('button', { name: 'Use template' })).toHaveLength(13);
```

- [ ] **Step 6: Run the gallery suite**

The options forms do not exist yet, so the last three cases of the new file still fail. Run the grouping case alone plus the existing gallery suites:

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.business.test.tsx -t 'labelled Business section'`
Expected: PASS.

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.savedReportMerge.test.tsx src/components/reports/ReportTemplates.identityAccess.test.tsx src/components/reports/ReportTemplates.posture.test.tsx src/components/reports/ReportTemplates.hardwareLifecycle.test.tsx src/components/reports/ReportTemplates.threatDetection.test.tsx src/components/reports/ReportTemplates.endpointManagement.test.tsx src/components/reports/ReportTemplates.vulnerabilityManagement.test.tsx`
Expected: PASS, 7 files — the merge semantics and every existing curated card survive the partition.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/reports/ReportTemplates.tsx \
        apps/web/src/components/reports/ReportTemplates.business.test.tsx \
        apps/web/src/components/reports/ReportTemplates.savedReportMerge.test.tsx
git commit -m "feat(reports): Business group in the templates gallery with the three curated business cards (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The shared period field and the three options forms

**Files:**
- Create: `apps/web/src/components/reports/ReportPeriodField.tsx`, `ReportPeriodField.test.tsx`
- Create: `apps/web/src/components/reports/TicketSlaOptionsForm.tsx`, `TicketSlaOptionsForm.test.tsx`
- Create: `apps/web/src/components/reports/TechnicianTimeOptionsForm.tsx`, `TechnicianTimeOptionsForm.test.tsx`
- Create: `apps/web/src/components/reports/ArAgingOptionsForm.tsx`, `ArAgingOptionsForm.test.tsx`
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx` (three modals + three state pairs)
- Modify: `apps/web/src/components/reports/ReportEditPage.tsx` (three `*Fields` panels + `baseConfig` arms)

**Interfaces:**
- Consumes: `ReportPeriodConfig`, `ReportPeriodKind` from `@breeze/shared` (W02).
- Produces, per form, the four-export shape `IdentityAccessOptionsForm.tsx` established (`:18-199`):
```ts
export type TicketSlaOptions = { period: ReportPeriodConfig; groupBy: 'organization'|'priority'|'technician'|'category'; includeNoSla: boolean };
export const DEFAULT_TICKET_SLA_OPTIONS: TicketSlaOptions;
export function ticketSlaOptionsFromConfig(config: Record<string, unknown>): TicketSlaOptions;
export function TicketSlaOptionsFields(props: { value: TicketSlaOptions; onChange: (v: TicketSlaOptions) => void }): JSX.Element;
export function TicketSlaOptionsForm(props: { value; onChange; busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void }): JSX.Element;

export type TechnicianTimeOptions = { period: ReportPeriodConfig; groupBy: 'technician'|'organization'|'work_type'; weeklyCapacityHours: number };
export const DEFAULT_TECHNICIAN_TIME_OPTIONS: TechnicianTimeOptions;
export function technicianTimeOptionsFromConfig(config: Record<string, unknown>): TechnicianTimeOptions;
export function TechnicianTimeOptionsFields(props): JSX.Element;
export function TechnicianTimeOptionsForm(props): JSX.Element;

export type ArAgingOptions = { asOf: string | null; groupBy: 'organization'|'currency'; includePaidInPeriod: boolean };
export const DEFAULT_AR_AGING_OPTIONS: ArAgingOptions;
export function arAgingOptionsFromConfig(config: Record<string, unknown>): ArAgingOptions;
export function ArAgingOptionsFields(props): JSX.Element;
export function ArAgingOptionsForm(props): JSX.Element;

// ReportPeriodField.tsx
export const DEFAULT_REPORT_PERIOD: ReportPeriodConfig;                       // { kind: 'last_full_month' }
export function reportPeriodFromConfig(raw: unknown): ReportPeriodConfig;
export function ReportPeriodField(props: { value: ReportPeriodConfig; onChange: (v: ReportPeriodConfig) => void; idPrefix?: string }): JSX.Element;
```
- **`toConfig` rule, shared by all three:** the object spread into the create POST is the options object *minus* keys the server schema does not accept. `ArAgingOptions.asOf` is `string | null` in the form but must be **omitted** (not `null`) from the config when unset, because W02's schema types it `asOf?: ISO date` — hence each form exports the fields as a plain object and `ReportTemplates` uses the per-type `toConfig` helper below rather than a blind spread.

- [ ] **Step 1: Write the failing period-field test**

Create `apps/web/src/components/reports/ReportPeriodField.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_REPORT_PERIOD, ReportPeriodField, reportPeriodFromConfig } from './ReportPeriodField';

describe('ReportPeriodField (#3198 W03)', () => {
  it('defaults to the last full month — the period an MSP actually reports on', () => {
    expect(DEFAULT_REPORT_PERIOD).toEqual({ kind: 'last_full_month' });
  });

  it('hides the custom date inputs until the custom kind is chosen', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ReportPeriodField value={DEFAULT_REPORT_PERIOD} onChange={onChange} />);
    expect(screen.queryByTestId('report-period-start')).toBeNull();

    await userEvent.setup().selectOptions(screen.getByTestId('report-period-kind'), 'custom');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'custom' }));

    rerender(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }} onChange={onChange} />);
    expect(screen.getByTestId('report-period-start')).toHaveValue('2026-08-01');
    expect(screen.getByTestId('report-period-end')).toHaveValue('2026-08-31');
  });

  it('drops start/end when switching away from custom, so the API never sees a stale window', async () => {
    const onChange = vi.fn();
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('report-period-kind'), 'last_quarter');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'last_quarter' });
  });

  it('reads a persisted config back, and falls back to the default for junk', () => {
    expect(reportPeriodFromConfig({ kind: 'last_30_days' })).toEqual({ kind: 'last_30_days' });
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }))
      .toEqual({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' });
    expect(reportPeriodFromConfig({ kind: 'since_forever' })).toEqual(DEFAULT_REPORT_PERIOD);
    expect(reportPeriodFromConfig(undefined)).toEqual(DEFAULT_REPORT_PERIOD);
    // A custom window missing a boundary is not a valid custom window; the
    // server would 400 on it, so the form must not seed it.
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-08-01' })).toEqual(DEFAULT_REPORT_PERIOD);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/reports/ReportPeriodField.test.tsx`
Expected: FAIL — `Failed to resolve import "./ReportPeriodField"`.

- [ ] **Step 3: Implement the period field**

Create `apps/web/src/components/reports/ReportPeriodField.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { ReportPeriodConfig, ReportPeriodKind } from '@breeze/shared';

/**
 * The reporting period, shared by all three business report types (#3198 W03).
 * One component rather than three copies: all three server config schemas take
 * the same `PeriodSchema`, and three hand-rolled pickers would drift the moment
 * one of them gained a kind.
 *
 * `last_full_month` is the default because that is the period an MSP owner
 * actually reports on — "last 30 days" straddles two invoices and two SLA
 * windows, which makes every month-over-month comparison meaningless.
 */
const PERIOD_KINDS: readonly ReportPeriodKind[] = ['last_full_month', 'last_30_days', 'last_quarter', 'custom'];

export const DEFAULT_REPORT_PERIOD: ReportPeriodConfig = { kind: 'last_full_month' };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Read a persisted `config.period` back into form state. A custom window
 *  missing either boundary is NOT a valid custom window — the server rejects
 *  it — so it degrades to the default rather than seeding a value that 400s. */
export function reportPeriodFromConfig(raw: unknown): ReportPeriodConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_REPORT_PERIOD;
  const period = raw as Record<string, unknown>;
  const kind = period.kind;
  if (typeof kind !== 'string' || !PERIOD_KINDS.includes(kind as ReportPeriodKind)) {
    return DEFAULT_REPORT_PERIOD;
  }
  if (kind !== 'custom') return { kind: kind as ReportPeriodKind };
  const start = typeof period.start === 'string' && ISO_DATE.test(period.start) ? period.start : null;
  const end = typeof period.end === 'string' && ISO_DATE.test(period.end) ? period.end : null;
  if (!start || !end) return DEFAULT_REPORT_PERIOD;
  return { kind: 'custom', start, end };
}

export function ReportPeriodField({
  value,
  onChange,
  idPrefix = 'report',
}: {
  value: ReportPeriodConfig;
  onChange: (value: ReportPeriodConfig) => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation('reports');
  return (
    <div className="rounded-md border p-4">
      <label className="block">
        <span className="block text-sm font-medium">{t('reports.reportPeriod.label')}</span>
        <select
          id={`${idPrefix}-period-kind`}
          data-testid="report-period-kind"
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as ReportPeriodKind;
            // Switching away from custom DROPS the boundaries rather than
            // carrying them: a stale start/end riding along on a preset period
            // is exactly the kind of ignored-but-present field that later reads
            // as "the report covered August" when it covered last quarter.
            onChange(kind === 'custom' ? { kind, start: value.start, end: value.end } : { kind });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {PERIOD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(/* i18n-dynamic */ `reports.reportPeriod.kinds.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {value.kind === 'custom' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs text-muted-foreground">{t('reports.reportPeriod.start')}</span>
            <input
              type="date"
              data-testid="report-period-start"
              value={value.start ?? ''}
              onChange={(event) => onChange({ ...value, kind: 'custom', start: event.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-muted-foreground">{t('reports.reportPeriod.end')}</span>
            <input
              type="date"
              data-testid="report-period-end"
              value={value.end ?? ''}
              onChange={(event) => onChange({ ...value, kind: 'custom', end: event.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('reports.reportPeriod.help')}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run the period test**

Run: `cd apps/web && npx vitest run src/components/reports/ReportPeriodField.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the three failing options-form tests**

Create `apps/web/src/components/reports/TicketSlaOptionsForm.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_TICKET_SLA_OPTIONS,
  TicketSlaOptionsFields,
  ticketSlaOptionsFromConfig,
} from './TicketSlaOptionsForm';

describe('TicketSlaOptionsFields (#3198 W03)', () => {
  it('states the pause-attribution approximation on the face of the form', () => {
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={() => {}} />);
    // Spec §3.3 R1: paused minutes are a lifetime total, so pause time after
    // first response slightly flatters response attainment. The reader is told
    // BEFORE they create the report, not only in the PDF footer.
    expect(screen.getByTestId('ticket-sla-approximation-note')).toBeInTheDocument();
  });

  it('reports a changed group-by axis', async () => {
    const onChange = vi.fn();
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('ticket-sla-group-by'), 'technician');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'technician' }));
  });

  it('labels the technician axis as the CURRENT assignee', async () => {
    render(<TicketSlaOptionsFields value={{ ...DEFAULT_TICKET_SLA_OPTIONS, groupBy: 'technician' }} onChange={() => {}} />);
    // `assigned_to` is the current assignee; reassignment history is not
    // tracked (spec §3.3 R1), so the axis must not read as "who answered it".
    expect(screen.getByTestId('ticket-sla-technician-note')).toBeInTheDocument();
  });

  it('toggles the no-SLA denominator', async () => {
    const onChange = vi.fn();
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={onChange} />);
    await userEvent.setup().click(screen.getByTestId('ticket-sla-include-no-sla'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ includeNoSla: false }));
  });
});

describe('ticketSlaOptionsFromConfig', () => {
  it('falls back to the schema defaults for an empty config', () => {
    expect(ticketSlaOptionsFromConfig({})).toEqual(DEFAULT_TICKET_SLA_OPTIONS);
  });

  it('keeps includeNoSla on unless it is explicitly false', () => {
    expect(ticketSlaOptionsFromConfig({ includeNoSla: false }).includeNoSla).toBe(false);
    expect(ticketSlaOptionsFromConfig({ includeNoSla: 'yes' as never }).includeNoSla).toBe(true);
  });

  it('rejects a group-by the server schema does not accept', () => {
    expect(ticketSlaOptionsFromConfig({ groupBy: 'site' }).groupBy).toBe(DEFAULT_TICKET_SLA_OPTIONS.groupBy);
    expect(ticketSlaOptionsFromConfig({ groupBy: 'category' }).groupBy).toBe('category');
  });
});
```

Create `apps/web/src/components/reports/TechnicianTimeOptionsForm.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_TECHNICIAN_TIME_OPTIONS,
  TechnicianTimeOptionsFields,
  technicianTimeOptionsFromConfig,
} from './TechnicianTimeOptionsForm';

describe('TechnicianTimeOptionsFields (#3198 W03)', () => {
  it('defaults to 40 hours and says the capacity figure is an assumption', () => {
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('technician-time-capacity-hours')).toHaveValue(40);
    // Spec §3.3 R2 / Open Decision 3 = A: uniform capacity, no per-tech table.
    // The words "assumes uniform capacity; PTO and part-time are not modelled"
    // are the condition on which that decision was accepted.
    expect(screen.getByTestId('technician-time-capacity-help')).toHaveTextContent(/uniform capacity/i);
    expect(screen.getByTestId('technician-time-capacity-help')).toHaveTextContent(/part-time/i);
  });

  it('clamps the capacity input to the server bounds', async () => {
    const onChange = vi.fn();
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={onChange} />);
    const input = screen.getByTestId('technician-time-capacity-hours');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, '999');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyCapacityHours: 80 }));
  });

  it('offers the work-type axis and reports it', async () => {
    const onChange = vi.fn();
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('technician-time-group-by'), 'work_type');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'work_type' }));
  });

  it('warns that the organization axis drops org-less time entries', () => {
    render(<TechnicianTimeOptionsFields value={{ ...DEFAULT_TECHNICIAN_TIME_OPTIONS, groupBy: 'organization' }} onChange={() => {}} />);
    // time_entries.org_id is nullable; an org-grouped view necessarily has a
    // "no organization" row (spec §3.3 R2), and an org-SCOPED instance sees
    // ticket-linked time only.
    expect(screen.getByTestId('technician-time-org-axis-note')).toBeInTheDocument();
  });
});

describe('technicianTimeOptionsFromConfig', () => {
  it('falls back to the schema defaults for an empty config', () => {
    expect(technicianTimeOptionsFromConfig({})).toEqual(DEFAULT_TECHNICIAN_TIME_OPTIONS);
  });

  it('clamps an out-of-range capacity to the server schema bounds', () => {
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 9999 }).weeklyCapacityHours).toBe(80);
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 0 }).weeklyCapacityHours).toBe(1);
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 37.5 }).weeklyCapacityHours).toBe(38);
  });
});
```

Create `apps/web/src/components/reports/ArAgingOptionsForm.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_AR_AGING_OPTIONS,
  ArAgingOptionsFields,
  arAgingOptionsFromConfig,
  arAgingConfigFromOptions,
} from './ArAgingOptionsForm';

describe('ArAgingOptionsFields (#3198 W03)', () => {
  it('leaves "as of" empty by default and says it means run time', () => {
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ar-aging-as-of')).toHaveValue('');
    expect(screen.getByTestId('ar-aging-as-of-help')).toHaveTextContent(/run/i);
  });

  it('reports a chosen as-of date', async () => {
    const onChange = vi.fn();
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={onChange} />);
    await userEvent.setup().type(screen.getByTestId('ar-aging-as-of'), '2026-08-31');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ asOf: '2026-08-31' }));
  });

  it('states the no-FX rule where the currency axis is chosen', async () => {
    const onChange = vi.fn();
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('ar-aging-group-by'), 'currency');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'currency' }));
    // Open Decision 4 = A: one set of totals per currency, never converted.
    expect(screen.getByTestId('ar-aging-currency-note')).toHaveTextContent(/not converted/i);
  });
});

describe('arAgingConfigFromOptions', () => {
  it('OMITS asOf when unset rather than sending null', () => {
    // The server schema types asOf as an optional ISO date. A null would 400,
    // and today's date would freeze a monthly schedule to its creation day.
    expect(arAgingConfigFromOptions(DEFAULT_AR_AGING_OPTIONS)).toEqual({
      groupBy: 'organization',
      includePaidInPeriod: false,
    });
  });

  it('includes asOf when the user picked one', () => {
    expect(arAgingConfigFromOptions({ ...DEFAULT_AR_AGING_OPTIONS, asOf: '2026-08-31' }))
      .toEqual({ asOf: '2026-08-31', groupBy: 'organization', includePaidInPeriod: false });
  });
});

describe('arAgingOptionsFromConfig', () => {
  it('falls back to the schema defaults for an empty config', () => {
    expect(arAgingOptionsFromConfig({})).toEqual(DEFAULT_AR_AGING_OPTIONS);
  });

  it('drops a malformed as-of rather than seeding a value the API would reject', () => {
    expect(arAgingOptionsFromConfig({ asOf: 'last tuesday' }).asOf).toBeNull();
    expect(arAgingOptionsFromConfig({ asOf: '2026-08-31' }).asOf).toBe('2026-08-31');
  });
});
```

- [ ] **Step 6: Run the three and watch them fail**

Run: `cd apps/web && npx vitest run src/components/reports/TicketSlaOptionsForm.test.tsx src/components/reports/TechnicianTimeOptionsForm.test.tsx src/components/reports/ArAgingOptionsForm.test.tsx`
Expected: FAIL, 3 files — `Failed to resolve import`.

- [ ] **Step 7: Implement `TicketSlaOptionsForm.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import type { ReportPeriodConfig } from '@breeze/shared';
import { DEFAULT_REPORT_PERIOD, ReportPeriodField, reportPeriodFromConfig } from './ReportPeriodField';

/**
 * Options for Ticket SLA attainment (#3198 R1). Four exports in the same shape
 * as `IdentityAccessOptionsForm.tsx`, so `ReportTemplates` and `ReportEditPage`
 * wire it identically.
 *
 * Two honesty notes are rendered, not buried in the PDF footer: attainment is
 * RECOMPUTED from timestamps (so a ticket answered late but eventually answered
 * still counts as a miss, which the breach stamps alone would never show), and
 * `sla_paused_minutes` is a lifetime total, so pause time that occurred after
 * first response slightly flatters response attainment (spec §3.3 R1, Open
 * Decision 2 = A). A reader who is going to defend these numbers to a customer
 * should meet the caveat before they create the report.
 */
export type TicketSlaGroupBy = 'organization' | 'priority' | 'technician' | 'category';

export type TicketSlaOptions = {
  period: ReportPeriodConfig;
  groupBy: TicketSlaGroupBy;
  includeNoSla: boolean;
};

const GROUP_BY_VALUES: readonly TicketSlaGroupBy[] = ['organization', 'priority', 'technician', 'category'];

/** Org scope defaults to `priority` (one customer, so an org axis is a single
 *  row); a partner-owned report defaults to `organization` (spec §3.3 R1). The
 *  partner default is applied by `ReportTemplates` when the owner scope flips,
 *  so this constant is the ORG default. */
export const DEFAULT_TICKET_SLA_OPTIONS: TicketSlaOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: 'priority',
  includeNoSla: true,
};

export const PARTNER_TICKET_SLA_GROUP_BY: TicketSlaGroupBy = 'organization';

export function ticketSlaOptionsFromConfig(config: Record<string, unknown>): TicketSlaOptions {
  const groupBy = config.groupBy;
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: typeof groupBy === 'string' && GROUP_BY_VALUES.includes(groupBy as TicketSlaGroupBy)
      ? (groupBy as TicketSlaGroupBy)
      : DEFAULT_TICKET_SLA_OPTIONS.groupBy,
    // "On unless explicitly false" — a legacy non-boolean reads as on rather
    // than silently dropping the no-SLA count a reader relies on.
    includeNoSla: config.includeNoSla !== false,
  };
}

type FieldProps = { value: TicketSlaOptions; onChange: (value: TicketSlaOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function TicketSlaOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <p
        data-testid="ticket-sla-approximation-note"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t('reports.ticketSlaOptions.approximationNote')}
      </p>

      <ReportPeriodField
        idPrefix="ticket-sla"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.ticketSlaOptions.groupBy')}</span>
        <select
          data-testid="ticket-sla-group-by"
          value={value.groupBy}
          onChange={(event) => onChange({ ...value, groupBy: event.target.value as TicketSlaGroupBy })}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.ticketSlaOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
        {value.groupBy === 'technician' && (
          <span data-testid="ticket-sla-technician-note" className="mt-2 block text-xs text-muted-foreground">
            {t('reports.ticketSlaOptions.technicianNote')}
          </span>
        )}
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="ticket-sla-include-no-sla"
          type="checkbox"
          checked={value.includeNoSla}
          onChange={(event) => onChange({ ...value, includeNoSla: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.ticketSlaOptions.includeNoSla')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.ticketSlaOptions.includeNoSlaHelp')}</span>
        </span>
      </label>
    </div>
  );
}

export function TicketSlaOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <TicketSlaOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.ticketSlaOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="ticket-sla-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Implement `TechnicianTimeOptionsForm.tsx`**

Same four-export shape. The distinctive parts:

```tsx
export type TechnicianTimeGroupBy = 'technician' | 'organization' | 'work_type';

export type TechnicianTimeOptions = {
  period: ReportPeriodConfig;
  groupBy: TechnicianTimeGroupBy;
  weeklyCapacityHours: number;
};

const GROUP_BY_VALUES: readonly TechnicianTimeGroupBy[] = ['technician', 'organization', 'work_type'];
const MIN_CAPACITY_HOURS = 1;
const MAX_CAPACITY_HOURS = 80;

export const DEFAULT_TECHNICIAN_TIME_OPTIONS: TechnicianTimeOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: 'technician',
  weeklyCapacityHours: 40,
};

/** Mirrors the server's `weeklyCapacityHours: z.number().int().min(1).max(80)`,
 *  so a hand-edited or legacy config can never seed an input the API rejects. */
function clampCapacity(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TECHNICIAN_TIME_OPTIONS.weeklyCapacityHours;
  return Math.min(MAX_CAPACITY_HOURS, Math.max(MIN_CAPACITY_HOURS, Math.round(raw)));
}

export function technicianTimeOptionsFromConfig(config: Record<string, unknown>): TechnicianTimeOptions {
  const groupBy = config.groupBy;
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: typeof groupBy === 'string' && GROUP_BY_VALUES.includes(groupBy as TechnicianTimeGroupBy)
      ? (groupBy as TechnicianTimeGroupBy)
      : DEFAULT_TECHNICIAN_TIME_OPTIONS.groupBy,
    weeklyCapacityHours: 'weeklyCapacityHours' in config
      ? clampCapacity(config.weeklyCapacityHours)
      : DEFAULT_TECHNICIAN_TIME_OPTIONS.weeklyCapacityHours,
  };
}
```

The capacity input follows `IdentityAccessOptionsForm.tsx:97-127`'s draft-text pattern exactly (local `useState` draft so the field can be cleared, `onChange` clamping before it reaches the parent, `onBlur` resyncing the draft), with `data-testid="technician-time-capacity-hours"` and a sibling help span `data-testid="technician-time-capacity-help"` carrying `reports.technicianTimeOptions.capacityHoursHelp`. The group-by select is `data-testid="technician-time-group-by"`; when `groupBy === 'organization'` it renders a note `data-testid="technician-time-org-axis-note"` (key `reports.technicianTimeOptions.orgAxisNote`). The submit button is `data-testid="technician-time-create-report"`.

- [ ] **Step 9: Implement `ArAgingOptionsForm.tsx`**

Five exports here — the extra one is the config mapper, because `asOf` must be omitted rather than nulled:

```tsx
export type ArAgingGroupBy = 'organization' | 'currency';

export type ArAgingOptions = {
  /** null = "as of the moment the report runs", evaluated server-side in the
   *  owner's resolved timezone (spec §3.3 R3). Deliberately NOT pre-filled with
   *  today: a monthly schedule pre-filled at creation would report the same
   *  frozen day every month for the rest of its life. */
  asOf: string | null;
  groupBy: ArAgingGroupBy;
  includePaidInPeriod: boolean;
};

const GROUP_BY_VALUES: readonly ArAgingGroupBy[] = ['organization', 'currency'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_AR_AGING_OPTIONS: ArAgingOptions = {
  asOf: null,
  groupBy: 'organization',
  includePaidInPeriod: false,
};

/** The object spread into the create/update `config`. `asOf` is OMITTED when
 *  unset — the server schema types it `asOf?: string`, so a `null` is a 400. */
export function arAgingConfigFromOptions(options: ArAgingOptions): Record<string, unknown> {
  return {
    ...(options.asOf ? { asOf: options.asOf } : {}),
    groupBy: options.groupBy,
    includePaidInPeriod: options.includePaidInPeriod,
  };
}

export function arAgingOptionsFromConfig(config: Record<string, unknown>): ArAgingOptions {
  const asOf = config.asOf;
  const groupBy = config.groupBy;
  return {
    asOf: typeof asOf === 'string' && ISO_DATE.test(asOf) ? asOf : null,
    groupBy: typeof groupBy === 'string' && GROUP_BY_VALUES.includes(groupBy as ArAgingGroupBy)
      ? (groupBy as ArAgingGroupBy)
      : DEFAULT_AR_AGING_OPTIONS.groupBy,
    includePaidInPeriod: config.includePaidInPeriod === true,
  };
}
```

AR aging takes **no** period field — its window is "open balances as of a moment", not a range (spec §3.3 R3). Testids: `ar-aging-as-of`, `ar-aging-as-of-help`, `ar-aging-group-by`, `ar-aging-currency-note` (rendered whenever `groupBy === 'currency'`, key `reports.arAgingOptions.currencyNote`), `ar-aging-include-paid`, `ar-aging-create-report`.

The other two forms get the parallel `ticketSlaConfigFromOptions` / `technicianTimeConfigFromOptions` helpers, which are plain identity spreads (`{ period, groupBy, includeNoSla }` / `{ period, groupBy, weeklyCapacityHours }`) — written out rather than spread blindly so the create POST can never carry a field the server schema does not accept.

- [ ] **Step 10: Run the three suites**

Run: `cd apps/web && npx vitest run src/components/reports/TicketSlaOptionsForm.test.tsx src/components/reports/TechnicianTimeOptionsForm.test.tsx src/components/reports/ArAgingOptionsForm.test.tsx`
Expected: PASS, 3 files.

- [ ] **Step 11: Wire the three modals into `ReportTemplates.tsx`**

Import the three forms and their defaults/config mappers alongside the existing six imports (`:18-43`). Add three state pairs beside the existing ones (`:418-429`):

```tsx
  const [ticketSlaTemplate, setTicketSlaTemplate] = useState<ReportTemplate | null>(null);
  const [ticketSlaOptions, setTicketSlaOptions] = useState<TicketSlaOptions>(DEFAULT_TICKET_SLA_OPTIONS);
  const [technicianTimeTemplate, setTechnicianTimeTemplate] = useState<ReportTemplate | null>(null);
  const [technicianTimeOptions, setTechnicianTimeOptions] = useState<TechnicianTimeOptions>(DEFAULT_TECHNICIAN_TIME_OPTIONS);
  const [arAgingTemplate, setArAgingTemplate] = useState<ReportTemplate | null>(null);
  const [arAgingOptions, setArAgingOptions] = useState<ArAgingOptions>(DEFAULT_AR_AGING_OPTIONS);
```

Add three branches to `handleUseTemplate` (`:500-543`), before the `reportTypeSurvivesBuilder` fallback:

```tsx
      if (type === 'ticket_sla_attainment') {
        setTicketSlaOptions({
          ...DEFAULT_TICKET_SLA_OPTIONS,
          // Spec §3.3 R1: a partner-owned report groups by organization by
          // default (a per-customer breakdown is the headline); an org-owned
          // one groups by priority, because its organization axis is one row.
          groupBy: defaultOwnerScope === 'partner' ? PARTNER_TICKET_SLA_GROUP_BY : DEFAULT_TICKET_SLA_OPTIONS.groupBy,
        });
        setTicketSlaTemplate(template);
        return;
      }
      if (type === 'technician_time_billability') {
        setTechnicianTimeOptions(DEFAULT_TECHNICIAN_TIME_OPTIONS);
        setTechnicianTimeTemplate(template);
        return;
      }
      if (type === 'ar_aging') {
        setArAgingOptions(DEFAULT_AR_AGING_OPTIONS);
        setArAgingTemplate(template);
        return;
      }
```

(`defaultOwnerScope` arrives in Task 4; until then substitute `'organization'` and the Task 4 step replaces it. Add `defaultOwnerScope` to the callback's dependency array when Task 4 lands.)

Add three modals after the identity modal (`:830`), each a verbatim copy of the identity modal's shell (`:808-830`) with the form swapped and the submit wired to the matching config mapper:

```tsx
      {arAgingTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', { name: getTemplateDisplayName(arAgingTemplate) })}
            </h2>
            <div className="mt-5">
              <ArAgingOptionsForm
                value={arAgingOptions}
                onChange={setArAgingOptions}
                busy={creatingId === arAgingTemplate.id}
                submitLabel={t('reports.arAgingOptions.createReport')}
                onCancel={() => setArAgingTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(arAgingTemplate, arAgingConfigFromOptions(arAgingOptions));
                }}
              />
            </div>
          </div>
        </div>
      )}
```

…and the same for `ticketSlaTemplate` (`ticketSlaConfigFromOptions(ticketSlaOptions)`) and `technicianTimeTemplate` (`technicianTimeConfigFromOptions(technicianTimeOptions)`).

- [ ] **Step 12: Wire the three `*Fields` panels into `ReportEditPage.tsx`**

Import the three `*Fields` + `*OptionsFromConfig` + `DEFAULT_*` triples (beside `:33-38`). Add three state hooks (beside `:59`), three `setXOptions(xOptionsFromConfig(config))` calls in `fetchReport` (beside `:77`), three `const isX = report.type === '<type>'` flags (beside `:142`), three panels (beside `:211-215`):

```tsx
      {isArAging && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <ArAgingOptionsFields value={arAgingOptions} onChange={setArAgingOptions} />
        </div>
      )}
```

The `baseConfig` ternary chain (`:221-235`) is at six levels and unreadable at nine. Replace it with a lookup, which is the same behaviour and survives the next type:

```tsx
  /**
   * PUT /reports/:id replaces `config` wholesale, so anything the edit page
   * does not reconstruct is dropped on save (`ReportBuilder.tsx:103-109`).
   * Each curated type folds its own options over the stored config; every other
   * type passes it through untouched.
   */
  const curatedConfigOverlay: Partial<Record<ReportType, Record<string, unknown>>> = {
    security_compliance_posture: { backupRequired },
    hardware_lifecycle: { ...lifecycleOptions },
    threat_detection_review: { ...threatOptions },
    endpoint_management_review: { ...endpointManagementOptions },
    vulnerability_management: { ...vulnerabilityOptions },
    identity_access_review: { ...identityOptions },
    ticket_sla_attainment: ticketSlaConfigFromOptions(ticketSlaOptions),
    technician_time_billability: technicianTimeConfigFromOptions(technicianTimeOptions),
    ar_aging: arAgingConfigFromOptions(arAgingOptions),
  };
  const baseConfig = { ...config, ...(curatedConfigOverlay[report.type] ?? {}) };
```

…and pass `baseConfig={baseConfig}` to `<ReportBuilder mode="edit" …>`.

- [ ] **Step 13: Run the gallery, edit-page and options suites**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.business.test.tsx src/components/reports/ReportEditPage.posture.test.tsx src/components/reports/ReportTemplates.savedReportMerge.test.tsx`
Expected: PASS — including the three POST-body cases of the business file, which were red after Task 2.

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/components/reports/ReportPeriodField.tsx \
        apps/web/src/components/reports/ReportPeriodField.test.tsx \
        apps/web/src/components/reports/TicketSlaOptionsForm.tsx \
        apps/web/src/components/reports/TicketSlaOptionsForm.test.tsx \
        apps/web/src/components/reports/TechnicianTimeOptionsForm.tsx \
        apps/web/src/components/reports/TechnicianTimeOptionsForm.test.tsx \
        apps/web/src/components/reports/ArAgingOptionsForm.tsx \
        apps/web/src/components/reports/ArAgingOptionsForm.test.tsx \
        apps/web/src/components/reports/ReportTemplates.tsx \
        apps/web/src/components/reports/ReportEditPage.tsx
git commit -m "feat(reports): options forms for the three business report types, over a shared period field (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The `ownerScope` selector, the "All organizations" badge, and the partner-owned recipient refusal

**Files:**
- Create: `apps/web/src/components/reports/ReportOwnerScopeField.tsx`, `ReportOwnerScopeField.test.tsx`
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx` (selector in each business modal; `ownerScope` in the POST)
- Modify: `apps/web/src/components/reports/ReportsList.tsx` (`ScopeBadge`, `report-row-<id>`)
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx` (`partnerOwned` prop), `ReportEditPage.tsx` (passthrough)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`)
- Test: extends `ReportTemplates.business.test.tsx`

**Interfaces:**
- Produces: `ReportOwnerScope = 'organization' | 'partner'`; `ReportOwnerScopeField({ value, onChange })`; `useDefaultReportOwnerScope(): { canChoose: boolean; defaultScope: ReportOwnerScope }`.
- Testids: `report-owner-scope`, `report-owner-scope-partner`, `report-owner-scope-org`, `report-scope-badge-<id>`, `report-row-<id>`, `report-partner-recipients-note`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/reports/ReportOwnerScopeField.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const claims = vi.hoisted(() => ({ value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));

import { ReportOwnerScopeField, useDefaultReportOwnerScope } from './ReportOwnerScopeField';

function Harness() {
  const { canChoose, defaultScope } = useDefaultReportOwnerScope();
  return <div data-testid="harness" data-can-choose={String(canChoose)} data-default={defaultScope} />;
}

describe('report owner scope (#3198 W03)', () => {
  beforeEach(() => {
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
  });

  it('offers the choice to a partner-scope token and defaults to partner-wide on the All-orgs view', () => {
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('true');
    expect(screen.getByTestId('harness').dataset.default).toBe('partner');
  });

  it('defaults to the focused organization when one is selected', () => {
    org.currentOrgId = 'org-1';
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.default).toBe('organization');
  });

  it('never offers the choice to an organization-scope token', () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    render(<Harness />);
    // An org token carries a partnerId but never passes breeze_has_partner_access.
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
  });

  it('fails closed while the token is still unresolved', () => {
    // Cold load: the access token is not in the store yet. "Unknown" must not
    // read as "partner" — #4010 is exactly that conflation.
    claims.value = { status: 'unresolved' };
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
    expect(screen.getByTestId('harness').dataset.default).toBe('organization');
  });

  it('reports the chosen scope', async () => {
    const onChange = vi.fn();
    render(<ReportOwnerScopeField value="organization" onChange={onChange} />);
    await userEvent.setup().click(screen.getByTestId('report-owner-scope-partner'));
    expect(onChange).toHaveBeenLastCalledWith('partner');
  });

  it('renders nothing at all for an organization-scope token', () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    const { container } = render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

Append to `ReportTemplates.business.test.tsx` a partner-scope describe block (re-mocking `@/lib/authScope` with `scope: 'partner'`, `currentOrgId: null`) asserting:

```tsx
  it('posts ownerScope partner and NO orgId when the partner-wide option is chosen', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    await user.click(screen.getByTestId('report-owner-scope-partner'));
    await user.click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().ownerScope).toBe('partner');
    // The partner id is derived server-side from auth.partnerId; the client
    // never sends one, and an orgId alongside ownerScope:'partner' would be a
    // contradictory create (2026-07-01 design §7.2).
    expect(postBody().orgId).toBeUndefined();
    expect(postBody().partnerId).toBeUndefined();
  });

  it('posts ownerScope organization with the focused orgId otherwise', async () => { /* same shape, clicks report-owner-scope-org */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run src/components/reports/ReportOwnerScopeField.test.tsx`
Expected: FAIL — `Failed to resolve import "./ReportOwnerScopeField"`.

- [ ] **Step 3: Implement the field**

```tsx
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { useOrgStore } from '../../stores/orgStore';

export type ReportOwnerScope = 'organization' | 'partner';

/**
 * Who owns a new report: one organization, or the partner (every organization
 * of the MSP, resolved live at each run — #3198 W01's `partner_wide` scope).
 *
 * Gated on the JWT **scope claim**, never on `useOrgStore().partners.length` —
 * a partners-length gate is a known broken idiom, and an organization token
 * carries a partnerId it can never use (`breeze_has_partner_access` is false
 * for it, and every partner-owned route branch sits behind
 * `auth.scope === 'partner'`). `useJwtClaims` rather than `getJwtClaims`
 * because the access token is absent on every cold load and the one-shot read
 * would freeze that empty answer for the life of the mount
 * (`lib/authScope.ts:78-98`). Unresolved fails CLOSED: unknown is not partner.
 *
 * Create-only. An update must never flip an org report into a partner rollup
 * (2026-07-01 design §7.2), so there is no edit-page counterpart to this file.
 */
export function useDefaultReportOwnerScope(): { canChoose: boolean; defaultScope: ReportOwnerScope } {
  const state = useJwtClaims();
  const { currentOrgId } = useOrgStore();
  const canChoose = state.status === 'resolved' && state.claims.scope === 'partner' && !!state.claims.partnerId;
  // Same defaulting as ConfigPolicyCreatePage: partner-wide when the user is on
  // the All-organizations view, the focused org otherwise.
  return { canChoose, defaultScope: canChoose && !currentOrgId ? 'partner' : 'organization' };
}

export function ReportOwnerScopeField({
  value,
  onChange,
}: {
  value: ReportOwnerScope;
  onChange: (value: ReportOwnerScope) => void;
}) {
  const { t } = useTranslation('reports');
  const { canChoose } = useDefaultReportOwnerScope();
  if (!canChoose) return null;

  return (
    <fieldset className="space-y-2 rounded-md border p-4" data-testid="report-owner-scope">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('reports.ownerScope.legend')}
      </legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="report-owner-scope"
          data-testid="report-owner-scope-partner"
          checked={value === 'partner'}
          onChange={() => onChange('partner')}
        />
        {t('reports.ownerScope.allOrganizations')}
        <span className="text-muted-foreground">{t('reports.ownerScope.allOrganizationsHint')}</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="report-owner-scope"
          data-testid="report-owner-scope-org"
          checked={value === 'organization'}
          onChange={() => onChange('organization')}
        />
        {t('reports.ownerScope.thisOrganization')}
      </label>
      {value === 'partner' && (
        <p data-testid="report-partner-recipients-note" className="text-xs text-muted-foreground">
          {t('reports.ownerScope.partnerRecipientsNote')}
        </p>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 4: Wire it into the three business modals and the create POST**

In `ReportTemplates.tsx`, add `const { canChoose: canChooseOwnerScope, defaultScope: defaultOwnerScope } = useDefaultReportOwnerScope();` and `const [ownerScope, setOwnerScope] = useState<ReportOwnerScope>('organization');`. Each business branch of `handleUseTemplate` sets `setOwnerScope(defaultOwnerScope)` before opening its modal (and the SLA branch reads `defaultOwnerScope` for its group-by default, Task 3 Step 11). Render `<ReportOwnerScopeField value={ownerScope} onChange={setOwnerScope} />` above the form inside each of the three business modals only — the six existing curated types are org-only and must not grow the control.

`handleCreateDirect` takes the scope and swaps the body's ownership fields:

```tsx
  const handleCreateDirect = useCallback(
    async (
      template: ReportTemplate,
      extraConfig: Record<string, unknown> = {},
      owner: ReportOwnerScope = 'organization',
    ) => {
      setCreatingId(template.id);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/reports', {
              method: 'POST',
              body: JSON.stringify({
                name: template.defaults.name ?? template.name,
                type: template.defaults.type,
                schedule: template.defaults.schedule ?? 'one_time',
                format: template.defaults.format ?? 'pdf',
                // ownerScope is the ONLY ownership input the client sends: the
                // partner id is derived server-side from auth.partnerId, and a
                // partner-owned report has no orgId by construction
                // (reports_one_owner_chk).
                ...(owner === 'partner'
                  ? { ownerScope: 'partner' as const }
                  : { ownerScope: 'organization' as const, ...(currentOrgId ? { orgId: currentOrgId } : {}) }),
                config: { dateRange: template.defaults.dateRange ?? { preset: 'last_30_days' }, ...extraConfig }
              })
            }),
          errorFallback: t('reports.reportTemplates.errors.createReport'),
          successMessage: t('reports.reportTemplates.success.created', { name: template.defaults.name ?? template.name }),
          onUnauthorized: () => { void navigateTo('/login', { replace: true }); }
        });
        void navigateTo('/reports');
      } catch {
        // runAction already surfaced the failure (toast, or redirect on 401).
      } finally {
        setCreatingId(null);
      }
    },
    [currentOrgId, t]
  );
```

The three business modals call `handleCreateDirect(template, <configMapper>(options), ownerScope)`; the six existing callers are unchanged and default to `'organization'` — which is the behaviour they already had, now stated explicitly.

- [ ] **Step 5: Badge partner-owned rows in the list**

In `ReportsList.tsx`, import `ScopeBadge` from `../shared/ScopeBadge` and render it beside the portal badge (`:497-501` in the name cell), plus a row testid:

```tsx
                    <tr key={report.id} data-testid={`report-row-${report.id}`} className="hover:bg-muted/30">
                      …
                          {report.partnerId && !report.orgId && (
                            <ScopeBadge
                              orgId={null}
                              partnerId={report.partnerId}
                              isSystem={false}
                              className="shrink-0"
                            />
                          )}
```

`ScopeBadge` already renders the `Layers` icon with `bg-primary/10 text-primary` and the `common:shared.scope.partnerWide` label ("Partner-wide") for exactly this shape (`ScopeBadge.tsx:30-37`) — no new colour, no new component, and it carries `data-testid="scope-badge"` for the e2e spec.

- [ ] **Step 6: Refuse contact recipients on a partner-owned definition**

`ReportBuilder.tsx` gains an optional prop:

```tsx
  /**
   * True when the report being edited is partner-owned (#3198 W01). Contact
   * recipients hang off `report_schedule_recipients (report_id, org_id) →
   * reports(id, org_id)`, an org-only composite FK, so a partner-owned
   * definition cannot hold them at all — the server answers
   * `409 partner_owned_report`. Delivery uses the free-text
   * `config.emailRecipients` list instead, which the worker already unions with
   * the contact list (spec §3.1a). Offering a picker that can only 409 is the
   * silent-failure shape this prop exists to prevent.
   */
  partnerOwned?: boolean;
```

The recipients effect (`:814-842`) gains `partnerOwned` to its guard and deps — `if (!currentOrgId || !reportId || schedule === 'one_time' || partnerOwned) return;` — so no contacts request is made. The contacts block (`:2202-2227`) renders only `{!partnerOwned && ( … )}`, and when `partnerOwned` a note takes its place:

```tsx
                {partnerOwned && (
                  <p data-testid="report-partner-recipients-note" className="text-xs text-muted-foreground">
                    {t('reports.reportBuilder.recipients.partnerOwned')}
                  </p>
                )}
```

The free-text email list and its add/remove controls (`:2229-2275`) stay exactly as they are — that is the delivery mechanism a partner-owned report uses.

`ReportEditPage.tsx` passes it: `partnerOwned={!!report.partnerId && !report.orgId}`.

- [ ] **Step 7: Guard the create path against silent regression**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS` (beside the existing `'src/components/reports/ReportBuilder.tsx'` entry at `:274`):

```ts
  // Business reports (#3198 W03): the curated-template create POST is the only
  // mutation in this file and it is runAction-wrapped. Adding it to the
  // targeted set now — a create that 403s on the orgAccess !== 'all' gate must
  // never look identical to one that succeeded, and a partner-wide report is
  // exactly the create a technician is least able to verify by eye.
  'src/components/reports/ReportTemplates.tsx',
```

- [ ] **Step 8: Run the affected suites**

Run: `cd apps/web && npx vitest run src/components/reports/ReportOwnerScopeField.test.tsx src/components/reports/ReportTemplates.business.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/components/reports/ReportsList.generate.test.tsx src/components/reports/ReportsList.download.test.tsx src/components/reports/ReportsList.aiFleetDesign.test.tsx src/components/reports/ReportsList.aiNarrative.test.tsx`
Expected: PASS, 7 files.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/reports/ReportOwnerScopeField.tsx \
        apps/web/src/components/reports/ReportOwnerScopeField.test.tsx \
        apps/web/src/components/reports/ReportTemplates.tsx \
        apps/web/src/components/reports/ReportTemplates.business.test.tsx \
        apps/web/src/components/reports/ReportsList.tsx \
        apps/web/src/components/reports/ReportBuilder.tsx \
        apps/web/src/components/reports/ReportEditPage.tsx \
        apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(reports): create-only ownerScope selector, partner-wide badge, and the partner-owned recipient refusal (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The three summary blocks in the preview — and the summary that must reach the PDF

**Files:**
- Modify: `apps/web/src/components/reports/ReportPreview.tsx` (three arms + the suppression list at `:519`)
- Modify: `apps/web/src/components/reports/reportExport.ts:54` (summary union), `ReportsList.tsx:~370` (the `handleDownload` cast)
- Test: `apps/web/src/components/reports/ReportPreview.business.test.tsx` (new)

**Interfaces:**
- Consumes: `TicketSlaSummary`, `TechnicianTimeSummary`, `ArAgingSummary`, `formatMoney`, `formatPercent`, `formatMinutes` (W02).
- Produces: testids `ticket-sla-summary`, `technician-time-summary`, `ar-aging-summary`, `report-summary-truncated`, `report-summary-footnotes`, `ar-aging-currency-row-<code>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/ReportPreview.business.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ReportPreview from './ReportPreview';

const base = { format: 'pdf', generatedAt: '2026-09-01T00:00:00.000Z' } as const;

describe('ReportPreview — business summaries (#3198 W03)', () => {
  it('renders SLA attainment as percentages and never as a bare fraction', () => {
    render(<ReportPreview data={{
      ...base, type: 'ticket_sla_attainment',
      data: { rows: [], summary: {
        ticketsConsidered: 120, noSlaSet: 8, responseAttainment: 0.875,
        resolutionAttainment: 0.5, breachCount: 15, stampedBreachCount: 9,
        recomputedVsStampedDelta: 6,
        footnotes: ['Paused minutes are a lifetime total.'],
      } },
    }} />);
    const block = screen.getByTestId('ticket-sla-summary');
    expect(within(block).getByTestId('ticket-sla-response-attainment')).toHaveTextContent('87.5%');
    expect(within(block).getByTestId('ticket-sla-resolution-attainment')).toHaveTextContent('50%');
    expect(within(block).queryByText('0.875')).toBeNull();
    // The recomputed-vs-stamped gap is SURFACED, not hidden (Open Decision 2).
    expect(within(block).getByTestId('ticket-sla-stamp-delta')).toHaveTextContent('6');
    expect(screen.getByTestId('report-summary-footnotes')).toHaveTextContent(/lifetime total/);
  });

  it('renders an unmeasured attainment as not-measured, never as 0%', () => {
    render(<ReportPreview data={{
      ...base, type: 'ticket_sla_attainment',
      data: { rows: [], summary: { ticketsConsidered: 0, responseAttainment: null, resolutionAttainment: null } },
    }} />);
    expect(screen.getByTestId('ticket-sla-response-attainment')).not.toHaveTextContent('0%');
    expect(screen.getByTestId('ticket-sla-response-attainment')).toHaveTextContent(/N\/A/i);
  });

  it('renders technician time as hours-and-minutes with the included-minutes column', () => {
    render(<ReportPreview data={{
      ...base, type: 'technician_time_billability',
      data: { rows: [], summary: {
        techniciansConsidered: 6, zeroTimeTechnicians: 1,
        loggedMinutes: 5405, capacityMinutes: 9600, utilization: 0.563,
        billableMinutes: 3000, includedMinutes: 900, nonBillableMinutes: 1505,
        billablePercent: 0.555, billingConversion: 0.8,
        billableValueByCurrency: [
          { currencyCode: 'USD', billableValue: '4500.00', billableMinutes: 1800, averageHourlyRate: '150.00' },
          { currencyCode: 'EUR', billableValue: '2000.00', billableMinutes: 1200, averageHourlyRate: '100.00' },
        ],
      } },
    }} />);
    const block = screen.getByTestId('technician-time-summary');
    expect(within(block).getByTestId('technician-time-logged')).toHaveTextContent('90h 5m');
    expect(within(block).getByTestId('technician-time-included')).toHaveTextContent('15h 0m');
    // One row per currency, never one summed headline (Open Decision 4 = A).
    expect(within(block).getByTestId('technician-time-currency-USD')).toHaveTextContent('$4,500.00');
    expect(within(block).getByTestId('technician-time-currency-EUR')).toHaveTextContent('€2,000.00');
  });

  it('renders AR aging buckets per currency, with the no-due-date bucket distinct from current', () => {
    render(<ReportPreview data={{
      ...base, type: 'ar_aging',
      data: { rows: [], summary: {
        asOf: '2026-08-31T23:59:59.000Z',
        byCurrency: [{
          currencyCode: 'USD', total: '12000.00', invoiceCount: 9,
          buckets: { current: '5000.00', d1_30: '3000.00', d31_60: '2000.00', d61_90: '1000.00', d90_plus: '500.00', no_due_date: '400.00', other_open: '100.00' },
        }],
      } },
    }} />);
    const row = screen.getByTestId('ar-aging-currency-row-USD');
    expect(within(row).getByTestId('ar-aging-bucket-USD-no_due_date')).toHaveTextContent('$400.00');
    expect(within(row).getByTestId('ar-aging-bucket-USD-current')).toHaveTextContent('$5,000.00');
    expect(within(row).getByTestId('ar-aging-bucket-USD-other_open')).toHaveTextContent('$100.00');
  });

  it('shows the truncation notice when detail rows were capped', () => {
    render(<ReportPreview data={{
      ...base, type: 'ar_aging',
      data: { rows: [], summary: { byCurrency: [], truncated: { detailRows: 5000, cap: 5000 } } },
    }} />);
    // Aggregates always cover every row; only the stored DETAIL rows are capped
    // (spec §3.2/§4), and the reader has to be told which of the two they are
    // looking at.
    expect(screen.getByTestId('report-summary-truncated')).toBeInTheDocument();
  });

  it('suppresses the generic summary cards for the business types', () => {
    render(<ReportPreview data={{
      ...base, type: 'ar_aging', data: { rows: [], summary: { byCurrency: [] } },
    }} />);
    // The generic card grid stringifies nested objects into "[object Object]".
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/reports/ReportPreview.business.test.tsx`
Expected: FAIL — no `ticket-sla-summary` element.

- [ ] **Step 3: Add the three arms**

In `ReportPreview.tsx`, import `formatMoney, formatPercent, formatMinutes` from `@breeze/shared/reportPdf` and the three summary types from `@breeze/shared`. Add a small shared tail component above the component body:

```tsx
/** The two things every business summary must state on its face: that the
 *  DETAIL rows were capped (the aggregates never are — spec §3.2), and the
 *  approximations the generator disclosed (spec §3.3: SLA pause attribution,
 *  uniform capacity, "current assignee"). Rendered verbatim from the snapshot
 *  so the preview and the delivered PDF cannot disagree. */
const BusinessSummaryTail = ({
  truncated,
  footnotes,
}: {
  truncated?: { detailRows: number; cap: number } | null;
  footnotes?: string[];
}) => {
  const { t } = useTranslation('reports');
  const lines = Array.isArray(footnotes) ? footnotes.filter(Boolean) : [];
  return (
    <>
      {truncated && (
        <p data-testid="report-summary-truncated" className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t('reports.reportPreview.business.truncated', { shown: truncated.detailRows, cap: truncated.cap })}
        </p>
      )}
      {lines.length > 0 && (
        <ul data-testid="report-summary-footnotes" className="space-y-1 text-xs text-muted-foreground">
          {lines.map((line, i) => (<li key={i}>{line}</li>))}
        </ul>
      )}
    </>
  );
};
```

Then three arms, each in the shape the existing arms use (`:301-516`) — an IIFE that casts the snapshot to its summary type, builds a tile list, and renders `bg-card` tiles in a `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`. The SLA arm:

```tsx
      {data.type === 'ticket_sla_attainment' && data.data.summary && previewMode === 'table' && (() => {
        const s = data.data.summary as TicketSlaSummary;
        const na = t('reports.reportPreview.business.notMeasured');
        const pct = (v: number | null | undefined) => (v === null || v === undefined ? na : formatPercent(v, 1));
        const num = (v: number | null | undefined) => (v === null || v === undefined ? na : String(v));
        const tiles = [
          { key: 'responseAttainment', testId: 'ticket-sla-response-attainment', value: pct(s.responseAttainment) },
          { key: 'resolutionAttainment', testId: 'ticket-sla-resolution-attainment', value: pct(s.resolutionAttainment) },
          { key: 'breachCount', testId: 'ticket-sla-breaches', value: num(s.breachCount) },
          { key: 'noSlaSet', testId: 'ticket-sla-no-sla', value: num(s.noSlaSet) },
          // Recomputed attainment finds breaches the periodic sweep never
          // stamped. The gap is PUBLISHED as a count rather than reconciled
          // away, because an unexplained difference from the in-app SLA chips
          // is what makes an owner distrust the whole report (Open Decision 2).
          { key: 'stampDelta', testId: 'ticket-sla-stamp-delta', value: num(s.recomputedVsStampedDelta) },
        ];
        return (
          <div className="space-y-4" data-testid="ticket-sla-summary">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {tiles.map((tile) => (
                <div key={tile.key} className="rounded-lg border bg-card p-4">
                  <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `reports.reportPreview.ticketSla.${tile.key}`)}</p>
                  <p data-testid={tile.testId} className={cn('text-2xl font-bold mt-1', tile.value === na && 'text-muted-foreground')}>
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>
            {s.worst && (
              <p className="text-xs text-muted-foreground">
                {t('reports.reportPreview.ticketSla.worst', { label: s.worst.label, value: formatPercent(s.worst.attainment, 1) })}
              </p>
            )}
            <BusinessSummaryTail truncated={s.truncated} footnotes={s.footnotes} />
          </div>
        );
      })()}
```

The technician-time arm renders five tiles (`technician-time-logged` = `formatMinutes(loggedMinutes)`, `technician-time-included` = `formatMinutes(includedMinutes)`, utilisation and billable % through `formatPercent`, billing conversion likewise) plus a per-currency list, each row `data-testid={`technician-time-currency-${row.currencyCode}`}` rendering `formatMoney(row.billableValue, row.currencyCode)` and `formatMinutes(row.billableMinutes)`. The AR arm renders one block per `byCurrency` row, `data-testid={`ar-aging-currency-row-${row.currencyCode}`}`, with a seven-cell bucket grid keyed `data-testid={`ar-aging-bucket-${row.currencyCode}-${bucketKey}`}`, values `formatMoney(row.buckets[bucketKey], row.currencyCode)`, in the fixed order `current, d1_30, d31_60, d61_90, d90_plus, no_due_date, other_open`. Both arms end with `<BusinessSummaryTail …/>`.

Extend the generic-card suppression at `:519`:

```tsx
      {data.type !== 'hardware_lifecycle' && data.type !== 'threat_detection_review'
        && data.type !== 'endpoint_management_review' && data.type !== 'vulnerability_management'
        && data.type !== 'identity_access_review'
        // #3198 W03 — all three business summaries carry nested objects and
        // arrays; the generic card grid would render "[object Object]" tiles
        // beside the designed ones.
        && data.type !== 'ticket_sla_attainment' && data.type !== 'technician_time_billability'
        && data.type !== 'ar_aging'
        && data.data.summary && previewMode === 'table' && (
```

- [ ] **Step 4: Widen the export summary union so the PDF arm is reachable**

`reportExport.ts:54` — add the three types to the `summary?:` union, with the comment that says why:

```ts
    // #3198 W03. The staff/browser download path re-renders a stored snapshot
    // client-side. If the summary does not typecheck HERE, it is dropped at the
    // ReportsList call site and `buildReportPdf` falls through to
    // `renderGenericReport` — which keeps the rows and silently loses every
    // disclosed approximation printed beside them. That is the exact silent
    // failure #5784 W03/W04/W06 each had to close by hand; three more members
    // is the whole fix.
    summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary
      | EndpointManagementSummary | VulnerabilityManagementSummary | IdentityAccessSummary
      | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary;
```

…and the same three members at the `ReportsList.handleDownload` cast (the union listed at `ReportsList.tsx:~372-385`), with a one-line comment pointing back here.

- [ ] **Step 5: Run the preview and export suites**

Run: `cd apps/web && npx vitest run src/components/reports/ReportPreview.business.test.tsx src/components/reports/ReportPreview.threatDetection.test.tsx src/components/reports/ReportsList.download.test.tsx`
Expected: PASS, 3 files.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/ReportPreview.tsx \
        apps/web/src/components/reports/ReportPreview.business.test.tsx \
        apps/web/src/components/reports/reportExport.ts \
        apps/web/src/components/reports/ReportsList.tsx
git commit -m "feat(reports): business summary blocks in the preview, and the summary union that keeps them in the PDF (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CSV / XLSX export — raw numerics and a `currency_code` column, never formatted strings

**Files:**
- Create: `apps/web/src/components/reports/businessReportRows.ts`, `businessReportRows.test.ts`
- Create: `apps/web/src/components/reports/reportExport.business.test.tsx`
- Modify: `apps/web/src/components/reports/reportExport.ts:66-78`

**Interfaces:**
- Produces: `export function businessReportExportRows(reportType: string, summary: unknown, rows: unknown[]): unknown[]`.

- [ ] **Step 1: Write the failing tests**

`businessReportRows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { businessReportExportRows } from './businessReportRows';

describe('businessReportExportRows (#3198 W03)', () => {
  it('passes non-business report types straight through', () => {
    const rows = [{ hostname: 'pc-1' }];
    expect(businessReportExportRows('device_inventory', undefined, rows)).toBe(rows);
  });

  it('emits AR aging bucket totals as RAW numeric strings with a currency_code column', () => {
    const out = businessReportExportRows('ar_aging', {
      byCurrency: [{
        currencyCode: 'USD', total: '12000.00', invoiceCount: 9,
        buckets: { current: '5000.00', d1_30: '3000.00', d31_60: '2000.00', d61_90: '1000.00', d90_plus: '500.00', no_due_date: '400.00', other_open: '100.00' },
      }],
    }, []) as Record<string, unknown>[];

    expect(out[0]).toMatchObject({
      currency_code: 'USD', total: '12000.00', current: '5000.00', no_due_date: '400.00', invoice_count: 9,
    });
    // A spreadsheet must be able to SUM this column. "$12,000.00" cannot be
    // summed, cannot be re-imported, and silently changes meaning with locale
    // (spec §3.4).
    for (const value of Object.values(out[0])) {
      expect(String(value)).not.toMatch(/[$€£,]/);
    }
  });

  it('keeps detail rows and appends currency_code to each, when the summary has one', () => {
    const out = businessReportExportRows('ar_aging',
      { byCurrency: [{ currencyCode: 'USD', total: '1.00', invoiceCount: 1, buckets: {} }] },
      [{ invoice_number: 'INV-1', balance: '250.00', currency_code: 'EUR' }],
    ) as Record<string, unknown>[];
    const detail = out.find((r) => r.invoice_number === 'INV-1');
    // The ROW's own currency wins — an invoice's currency is a property of the
    // invoice, never of the summary block it happens to sit under.
    expect(detail).toMatchObject({ balance: '250.00', currency_code: 'EUR' });
  });

  it('emits technician time as raw minutes and raw rates, never formatted', () => {
    const out = businessReportExportRows('technician_time_billability', {
      groups: [{
        key: 'u-1', label: 'Dana', loggedMinutes: 5405, capacityMinutes: 9600, utilization: 0.563,
        billableMinutes: 3000, includedMinutes: 900, nonBillableMinutes: 1505,
        billablePercent: 0.555, convertedMinutes: 2400, billingConversion: 0.8,
      }],
      billableValueByCurrency: [{ currencyCode: 'USD', billableValue: '4500.00', billableMinutes: 1800, averageHourlyRate: '150.00' }],
    }, []) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ label: 'Dana', logged_minutes: 5405, utilization: 0.563 });
    expect(out.some((r) => r.currency_code === 'USD' && r.billable_value === '4500.00')).toBe(true);
    for (const row of out) for (const value of Object.values(row)) {
      expect(String(value)).not.toMatch(/%|h \d+m/);
    }
  });

  it('emits SLA attainment as fractions, not percent strings', () => {
    const out = businessReportExportRows('ticket_sla_attainment', {
      groups: [{ key: 'p1', label: 'Critical', ticketsConsidered: 10, responseMet: 9, responseTotal: 10, responseAttainment: 0.9, resolutionMet: 5, resolutionTotal: 10, resolutionAttainment: 0.5, breaches: 1 }],
    }, []) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ label: 'Critical', response_attainment: 0.9, resolution_attainment: 0.5 });
  });
});
```

`reportExport.business.test.tsx` asserts the wiring: mock `@/lib/downloadBlob`, call `exportReport([], { format: 'csv', reportType: 'ar_aging', timezone: 'UTC', summary: <the USD summary above> })`, read the blob text and assert the header row contains `currency_code` and the body contains `5000.00` and no `$`. A second case does the same for `format: 'excel'` and asserts tab separation.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run src/components/reports/businessReportRows.test.ts src/components/reports/reportExport.business.test.tsx`
Expected: FAIL — `Failed to resolve import "./businessReportRows"`.

- [ ] **Step 3: Implement the row shaper**

`businessReportRows.ts` exports one function with three private shapers. Rules, stated in the file header and enforced by the tests: every money value is the **raw `numeric` string** exactly as the generator produced it; every percentage is the **fraction**; every duration is **integer minutes**; every money-bearing row carries `currency_code`; a detail row's own `currency_code` is never overwritten. Summary rows come first, then the detail rows, so a spreadsheet opens on the totals. For a non-business type the input array is returned **by reference** (the `toBe` assertion above pins that — no defensive copy, no behaviour change for the other fourteen types).

- [ ] **Step 4: Wire it into `exportReport`**

`reportExport.ts`, replacing `:66-78`:

```ts
  // #3198 W03. Business reports carry their numbers in the SUMMARY, not in the
  // detail rows, so a CSV built from `rows` alone would export an empty file
  // for a report whose aggregates are the entire point. The shaper flattens the
  // summary into rows and leaves every other report type untouched.
  const exportRows = businessReportExportRows(reportType, summary, rows);

  if (format === 'csv') {
    if (exportRows.length === 0) throw new Error('No data to export');
    const csvContent = rowsToCsv(exportRows);
    downloadBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `${baseFilename}.csv`);
    return;
  }

  if (format === 'excel') {
    if (exportRows.length === 0) throw new Error('No data to export');
    const tsvContent = rowsToTsv(exportRows);
    downloadBlob(new Blob([tsvContent], { type: 'application/vnd.ms-excel' }), `${baseFilename}.xls`);
    return;
  }
```

The PDF branch keeps passing the untouched `rows` — `buildReportPdf`'s business arms (W02) read the summary themselves and render their own tables.

- [ ] **Step 5: Run the export suites**

Run: `cd apps/web && npx vitest run src/components/reports/businessReportRows.test.ts src/components/reports/reportExport.business.test.tsx src/components/reports/reportExport.posture.test.tsx src/components/reports/reportExport.endpointManagement.test.tsx src/components/reports/reportExport.threatDetection.test.tsx src/components/reports/reportExport.vulnerabilityManagement.test.tsx src/components/reports/reportExport.test.ts`
Expected: PASS, 7 files — the four existing per-type export suites prove the pass-through path is byte-identical.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/businessReportRows.ts \
        apps/web/src/components/reports/businessReportRows.test.ts \
        apps/web/src/components/reports/reportExport.business.test.tsx \
        apps/web/src/components/reports/reportExport.ts
git commit -m "feat(reports): business CSV/XLSX export emits raw numerics with a currency_code column (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Eight locale catalogs

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`
- Modify: the same eight `settings.json` (one key, Task 8 uses it)
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `translationCoverage.test.ts`, `terminologyQuality.test.ts` (all existing; none is edited)

**Interfaces:** Produces every key the previous tasks referenced. No key is added that no component reads — `apps/web/src/lib/i18n/keyUsage.test.ts` is in the suite.

- [ ] **Step 1: Run the parity suite and watch it fail**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: FAIL — `keyUsage` reports the keys the components reference and no catalog defines. (If it passes, the earlier tasks were not implemented — stop and check.)

- [ ] **Step 2: Write the English catalog**

Insert into `apps/web/src/locales/en/reports.json`, under `reports`, keeping the file's existing alphabetical-within-block convention. Existing blocks that gain three entries each: `reportsList.reportTypes` and `reportTemplates.reportTypes` both get

```json
"ticket_sla_attainment": "Ticket SLA attainment",
"technician_time_billability": "Technician time & billability",
"ar_aging": "AR aging"
```

`reportTemplates.templates` gets three entries whose `name`/`description` match `defaultTemplates` verbatim (Task 2 Step 3), and `reportTemplates` gains:

```json
"groups": {
  "business": "Business",
  "businessDescription": "Your own numbers: service performance, technician time, and money owed. Internal — these never appear in a customer's portal.",
  "general": "Fleet and evidence"
}
```

Then five new top-level blocks under `reports`:

```json
"reportPeriod": {
  "label": "Reporting period",
  "help": "Evaluated in the report owner's timezone. A month-end report is normally run on the last full month, not the last 30 days.",
  "start": "From",
  "end": "To",
  "kinds": {
    "last_full_month": "Last full month",
    "last_30_days": "Last 30 days",
    "last_quarter": "Last quarter",
    "custom": "Custom dates"
  }
},
"ownerScope": {
  "legend": "Who this report covers",
  "allOrganizations": "All organizations",
  "allOrganizationsHint": "(one report across every customer you manage)",
  "thisOrganization": "This organization only",
  "partnerRecipientsNote": "A report covering all organizations is delivered to email addresses you type in, not to customer contacts — a contact belongs to one organization.",
  "createOnlyNote": "This cannot be changed later. Create a second report if you need the other view."
},
"ticketSlaOptions": {
  "cancel": "Cancel",
  "createReport": "Create report",
  "approximationNote": "Attainment is recalculated from each ticket's own timestamps rather than read off the breach flags, so a ticket answered late but eventually answered still counts as a miss. Paused time is recorded as a lifetime total, so pauses that happened after the first reply flatter response attainment slightly; the report says so on its face.",
  "groupBy": "Break the figures down by",
  "groupByValues": {
    "organization": "Organization",
    "priority": "Priority",
    "technician": "Technician",
    "category": "Category"
  },
  "technicianNote": "Counted against the ticket's current assignee. Reassignment history is not kept, so a ticket that changed hands is credited to whoever holds it now.",
  "includeNoSla": "Count tickets with no SLA target separately",
  "includeNoSlaHelp": "Tickets with no response or resolution target are never counted as met or missed. With this on they are reported as their own figure instead of disappearing from the total."
},
"technicianTimeOptions": {
  "cancel": "Cancel",
  "createReport": "Create report",
  "groupBy": "Break the figures down by",
  "groupByValues": {
    "technician": "Technician",
    "organization": "Organization",
    "work_type": "Work type"
  },
  "orgAxisNote": "Time logged without an organization — internal work, for example — is reported in its own row. A report scoped to a single organization covers ticket-linked time only.",
  "capacityHours": "Assumed weekly capacity (hours)",
  "capacityHoursHelp": "Used as every technician's available hours, prorated by the working days in the period. This assumes uniform capacity; PTO and part-time schedules are not modelled, so an individual figure can be misleading even when the team figure is sound.",
  "approximationNote": "Utilisation and the billable share are measured on time worked. Billing conversion is measured on billable minutes after minimums and rounding, so it reconciles with what an invoice will carry."
},
"arAgingOptions": {
  "cancel": "Cancel",
  "createReport": "Create report",
  "asOf": "As of (optional)",
  "asOfHelp": "Leave empty and balances are aged as of the moment the report runs, in the report owner's timezone — which is what a scheduled monthly report wants. Set a date to reproduce an earlier statement.",
  "groupBy": "Break the figures down by",
  "groupByValues": {
    "organization": "Organization",
    "currency": "Currency"
  },
  "currencyNote": "Totals are reported once per currency and are not converted. There is deliberately no combined figure across currencies.",
  "includePaidInPeriod": "Include invoices paid during the period",
  "includePaidInPeriodHelp": "Off by default: the report is about what is still owed. Turn it on to show what was collected alongside what is outstanding."
},
"reportPreview": {
  "business": {
    "notMeasured": "N/A",
    "truncated": "Showing the first {{shown}} detail rows of more than {{cap}}. Every total above is calculated over all rows, not just these.",
    "asOf": "Balances as of {{asOf}}"
  },
  "ticketSla": {
    "responseAttainment": "Response attainment",
    "resolutionAttainment": "Resolution attainment",
    "breachCount": "Missed targets",
    "noSlaSet": "No SLA set",
    "stampDelta": "Found by recalculation",
    "worst": "Weakest: {{label}} at {{value}}"
  },
  "technicianTime": {
    "logged": "Time logged",
    "utilization": "Utilisation",
    "billablePercent": "Billable share",
    "included": "Included in plan",
    "billingConversion": "Billed of billable",
    "zeroTimeTechnicians": "Technicians with no time",
    "billableValue": "Billable value"
  },
  "arAging": {
    "total": "Total outstanding",
    "invoiceCount": "Open invoices",
    "buckets": {
      "current": "Current",
      "d1_30": "1–30 days",
      "d31_60": "31–60 days",
      "d61_90": "61–90 days",
      "d90_plus": "90+ days",
      "no_due_date": "No due date",
      "other_open": "Other open balance"
    }
  }
}
```

…plus one key in the existing `reportBuilder.recipients` block:

```json
"partnerOwned": "This report covers every organization, so it is delivered to the email addresses listed below. Customer contacts belong to a single organization and cannot receive it."
```

And in `apps/web/src/locales/en/settings.json`, inside `billablesExport`:

```json
"seeBusinessReports": "See business reports"
```

- [ ] **Step 3: Translate into the seven other catalogs**

Every key above goes into all seven with a **real translation** — `translationCoverage.test.ts` caps exact-English duplicates per namespace and a wholesale copy blows every cap. Translate the prose; keep interpolation tokens (`{{shown}}`, `{{cap}}`, `{{label}}`, `{{value}}`, `{{asOf}}`) byte-identical, which `localeParity.test.ts` checks explicitly.

Three values are **intentionally identical** in several catalogs and need their duplicate baselines bumped in `translationCoverage.test.ts` if the run reports it: `"N/A"` (a locale-invariant abbreviation already used by the four existing evidence arms), the bucket labels `"1–30 days"`-style numerals in locales where only the noun changes, and `"Business"` in it-IT. Bump the `reports.json` baseline for the affected locale by the reported count with a one-line comment naming these keys — do not translate `N/A` into something a technician has to decode.

Domain terms, pinned so the seven catalogs agree with each other and with the existing `billing.json` / `tickets.json` vocabulary (check each against the neighbouring catalog before writing — `terminologyQuality.test.ts` exists because machine translation gets these wrong):

| English | de-DE | es-419 | fr-FR / fr-CA | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| SLA attainment | SLA-Erfüllung | Cumplimiento del SLA | Respect des SLA | Rispetto degli SLA | Cumprimento de SLA | SLA uyumu |
| Response / Resolution | Reaktion / Lösung | Respuesta / Resolución | Réponse / Résolution | Risposta / Risoluzione | Resposta / Resolução | Yanıt / Çözüm |
| Billable | abrechenbar | facturable | facturable | fatturabile | faturável | faturalandırılabilir |
| Utilisation | Auslastung | Utilización | Taux d'occupation | Utilizzo | Utilização | Kullanım oranı |
| Work type | Arbeitsart | Tipo de trabajo | Type de travail | Tipo di lavoro | Tipo de trabalho | İş türü |
| AR aging | Offene-Posten-Liste | Antigüedad de saldos | Balance âgée | Scadenzario clienti | Contas a receber por idade | Alacak yaşlandırma |
| Outstanding / balance | offener Betrag | saldo pendiente | solde dû | saldo aperto | saldo em aberto | bakiye |
| Due date | Fälligkeitsdatum | Fecha de vencimiento | Date d'échéance | Data di scadenza | Data de vencimento | Vade tarihi |
| All organizations | Alle Organisationen | Todas las organizaciones | Toutes les organisations | Tutte le organizzazioni | Todas as organizações | Tüm kuruluşlar |
| Reporting period | Berichtszeitraum | Período del informe | Période du rapport | Periodo del report | Período do relatório | Rapor dönemi |
| Last full month | Letzter voller Monat | Último mes completo | Dernier mois complet | Ultimo mese completo | Último mês completo | Son tam ay |

`All organizations` and `Organization` must match the values already in `common.json` (`labels.organization`, `shared.scope.partnerWide`) and `settings.json` (`billablesExport.allOrganizations`, quoted verbatim in this plan's research notes) — reuse those strings rather than inventing a second rendering of the same word.

- [ ] **Step 4: Run the whole i18n suite**

Run: `cd apps/web && npx vitest run src/lib/i18n/`
Expected: PASS — `localeParity` (key sets, leaf types, interpolation tokens), `translationCoverage` (duplicate caps), `terminologyQuality`, `keyUsage`, `extractionQuality`, `titleKeyUsage`.

Run: `cd apps/web && npx vitest run src/components/reports/reportsPtBR.test.ts`
Expected: PASS — the accent regression guard on this namespace.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales
git commit -m "i18n(reports): business report types, options forms and summaries in eight locales (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: The billables card points at the business reports

**Files:**
- Modify: `apps/web/src/components/billing/BillablesExportCard.tsx:60-84`
- Test: `apps/web/src/components/billing/BillablesExportCard.test.tsx`

The card is **not** removed (spec §7). It answers a different question — "give me the raw billable lines for this window" — and an MSP mid-invoice-run should not have it moved out from under them. It gains one link.

- [ ] **Step 1: Write the failing test**

Append to `BillablesExportCard.test.tsx`:

```tsx
  it('links to the business reports without removing the CSV export', () => {
    render(<BillablesExportCard />);
    // The raw-lines export stays: it answers "give me the billable lines",
    // which no report replaces (spec §7).
    expect(screen.getByTestId('billables-export-download')).toBeInTheDocument();
    const link = screen.getByTestId('billables-see-business-reports');
    expect(link).toHaveAttribute('href', '/reports/templates');
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/billing/BillablesExportCard.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="billables-see-business-reports"]`.

- [ ] **Step 3: Add the link**

In the card's header block, after the description `<p>` (`:63`):

```tsx
      <p className="mb-3 text-xs">
        <a
          href="/reports/templates"
          data-testid="billables-see-business-reports"
          className="font-medium text-primary hover:underline"
        >
          {t('billablesExport.seeBusinessReports')}
        </a>
      </p>
```

A plain anchor, not `navigateTo` — this is navigation, not a mutation, and every other cross-page link in the settings surfaces is an anchor.

- [ ] **Step 4: Run it**

Run: `cd apps/web && npx vitest run src/components/billing/BillablesExportCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/billing/BillablesExportCard.tsx \
        apps/web/src/components/billing/BillablesExportCard.test.tsx
git commit -m "feat(billing): point the billables export card at the business reports (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Prove the three types never reach the portal

**Files:**
- Modify: `apps/portal/src/components/portal/ReportRunList.test.tsx`
- Modify: `packages/shared/src/types/portalVisibility.test.ts`

Spec §2: "Not in scope: end-client portal visibility of any business report. Margin, utilization, and AR data are internal to the MSP." §3.5 adds that they are never `portal_self_service` and are absent from `PORTAL_REPORT_TYPES`. Nothing in W01/W02 adds them to the portal — this task makes that a **test**, because the one thing an evidence-type precedent teaches (`ReportRunList.tsx:16-44`) is that the listable union drifts by hand.

- [ ] **Step 1: Write the failing type assertion**

Append to `packages/shared/src/types/portalVisibility.test.ts`:

```ts
  it('excludes the #3198 business report types from the portal run union', () => {
    // A portal run row's type comes from the database, so this union is the
    // only place the compiler can be told what may appear. SLA attainment,
    // technician time and AR aging are the MSP's OWN numbers — technician
    // utilisation and money owed are not a customer's business — so they must
    // never become assignable here (spec §2, §3.5).
    expectTypeOf<PortalRunDto['type']>().not.toEqualTypeOf<'ticket_sla_attainment'>();
    type Listable = PortalRunDto['type'];
    type BusinessTypes = 'ticket_sla_attainment' | 'technician_time_billability' | 'ar_aging';
    type Leak = Extract<Listable, BusinessTypes>;
    expectTypeOf<Leak>().toEqualTypeOf<never>();
  });
```

- [ ] **Step 2: Write the failing portal render assertion**

Append to `apps/portal/src/components/portal/ReportRunList.test.tsx`:

```tsx
  // #3198 W03. These three types are internal by construction: they are absent
  // from PORTAL_REPORT_TYPES, never portal_self_service, and their definitions
  // are org- or partner-owned MSP reports. If a row of one ever reaches this
  // component, something upstream has leaked — so the component must not be the
  // thing that renders it, and must certainly never offer to generate one.
  it('renders no row and no generate button for a business report type', () => {
    const leaked = {
      ...run, id: 'run-ar', name: 'AR aging', type: 'ar_aging',
    } as unknown as PortalRunDto;

    render(<ReportRunList initialRuns={[leaked]} timezone="America/Denver" />);

    expect(screen.queryByTestId('portal-report-run-row-run-ar')).toBeNull();
    expect(screen.queryByTestId('portal-reports-generate-ar-aging')).toBeNull();
    expect(screen.queryByText(/AR aging/i)).toBeNull();
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx`
Expected: FAIL — the row renders, because the list maps every run it is handed.

Run: `cd packages/shared && npx vitest run src/types/portalVisibility.test.ts`
Expected: PASS already (the union genuinely excludes them) — this assertion is a **ratchet**, not a red. Record that in the PR: it is the one test here that is green on first write, and it earns its place by failing the day someone widens the union.

- [ ] **Step 4: Make the portal fail closed**

In `apps/portal/src/components/portal/ReportRunList.tsx`, filter before rendering:

```tsx
/**
 * Types that must never render in a customer's portal even if a row for one
 * reaches this component (#3198 W03). `portalRunListPredicate` filters on org,
 * portal_self_service and status — it has NO type filter — so "it cannot
 * happen" is a property of the data, not of this code. These three carry the
 * MSP's own service performance, per-technician time and receivables; a single
 * mis-provisioned definition would put all three in front of the customer.
 * Fail closed here as well as upstream.
 */
const NEVER_PORTAL_VISIBLE = new Set<string>([
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
]);

const visibleRuns = runs.filter((r) => !NEVER_PORTAL_VISIBLE.has(r.type as string));
```

…and map `visibleRuns` wherever `runs` was mapped for rows and counts.

- [ ] **Step 5: Run both suites**

Run: `cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx`
Expected: PASS, including the six existing cases (delivered evidence runs still list).

Run: `cd packages/shared && npx vitest run src/types/portalVisibility.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/portal/src/components/portal/ReportRunList.tsx \
        apps/portal/src/components/portal/ReportRunList.test.tsx \
        packages/shared/src/types/portalVisibility.test.ts
git commit -m "test(portal): business report types can never render in a customer portal (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Documentation and the release-note entry

**Files:**
- Modify: `apps/docs/src/content/docs/features/reports.mdx` (the report-types table at `:21-39`; a new `## Business Reports` section after `## Executive Summary Report`, `:265`)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Add the three rows to the report-types table**

After the `threat_detection_review` row (`:39`), matching the existing column shape (`| Type | Description | Key columns / metrics |`):

```mdx
| `ticket_sla_attainment` | Response and resolution SLA attainment for a period, recalculated from each ticket's own timestamps rather than read off the breach flags, grouped by organization, priority, technician or category | response/resolution attainment %, missed targets, tickets with no SLA target, weakest group |
| `technician_time_billability` | Logged time against an assumed weekly capacity, the billable / included / non-billable split, and how much billable time has been approved and billed — with billable value reported per currency | utilisation %, billable %, billing conversion %, logged/billable/included minutes, billable value per currency |
| `ar_aging` | Unpaid invoice balances bucketed current / 1–30 / 31–60 / 61–90 / 90+ days past due, one set of totals per currency | outstanding balance per bucket, open invoice count, no-due-date balance, other open balance |
```

- [ ] **Step 2: Write the section**

Insert after `## Executive Summary Report` (`:265-270`):

```mdx
## Business Reports

Three report types cover the PSA side of the business — service performance, technician time, and money owed. Unlike the evidence reviews above, they are **internal**: they are never visible in a customer's portal, never self-service, and never attached to a service deliverable.

### Ownership: one organization, or all of them

A business report can be owned by a single organization or by the partner. A **partner-owned** report covers every organization the MSP manages, resolved live at each run — so an organization onboarded after the report was created is included automatically, and one that is offboarded drops out. The ownership is chosen when the report is created and cannot be changed afterwards; create a second report if you need both views.

Creating or running a partner-owned report requires a partner-scope login with access to **all** organizations. A user restricted to selected organizations is refused: aggregating customers they cannot open individually would be an escalation, not a convenience. Because a customer contact belongs to one organization, a partner-owned report is delivered to email addresses entered on the report itself rather than to contacts.

### Ticket SLA attainment (`ticket_sla_attainment`)

Measures the share of support tickets created in the period that met their response and resolution targets. Attainment is **recalculated** from each ticket's `created_at`, `first_response_at`, `resolved_at` and recorded paused minutes against its own targets, rather than read off the stored breach flags. The stored flags are written by a periodic sweep that only marks tickets still open and unanswered at sweep time, so a ticket answered late — but eventually answered — never gets flagged. The report shows how many additional misses the recalculation found, so the figure can be reconciled against the SLA badges shown in the ticket list.

Two limits are printed on the report itself:

- **Paused time is a lifetime total.** A ticket paused *after* its first reply has that pause counted against the response clock too, which flatters response attainment slightly. Resolution attainment is unaffected.
- **The technician axis is the current assignee.** Reassignment history is not kept, so a ticket that changed hands is credited to whoever holds it now.

Tickets with no target set are never counted as met or missed; they are reported as their own figure. Only support work is measured — planned work is excluded, matching the SLA engine itself.

### Technician time & billability (`technician_time_billability`)

Measures logged time against capacity, and how much of it converts to revenue.

- **Utilisation** is logged minutes ÷ capacity minutes. Capacity is a report setting — an assumed weekly hours figure (40 by default), prorated by the working days in the period. **This assumes uniform capacity: PTO and part-time schedules are not modelled**, so an individual technician's figure can mislead even when the team figure is sound.
- **Billable share** is billable minutes ÷ logged minutes, split three ways — billable, included in plan, and non-billable.
- **Billing conversion** is approved-and-billed minutes ÷ billable minutes. It is measured on billable minutes *after* minimums and rounding, so it reconciles with what an invoice will actually carry. It is deliberately not called "realization": there is no fee-schedule baseline to compute financial realization against.

Technicians with no time in the period are listed at zero rather than omitted — dropping them would inflate the team average. Billable value is reported **once per currency**, never summed across currencies. A report scoped to a single organization covers ticket-linked time only, because time logged without an organization has no organization to be scoped to.

### AR aging (`ar_aging`)

Buckets unpaid invoice balances by how far past due they are: current, 1–30, 31–60, 61–90 and 90+ days, plus two buckets that exist so the totals always reconcile:

- **No due date** — an open balance on an invoice with no due date is aged into its own bucket, never silently into "current".
- **Other open balance** — any invoice carrying a balance in an unexpected status appears here rather than vanishing.

Aging is measured as of the moment the report runs, in the report owner's timezone, unless an explicit as-of date is set. Totals are reported **once per currency with no conversion** — there is deliberately no combined figure, because an FX-converted headline would be wrong the day after it was produced.

### What gets stored, and what gets capped

Every total is computed in SQL over **all** matching rows. The stored detail rows — the per-ticket, per-technician or per-invoice lines behind the totals — are capped at 5,000 per run, and the report states when that cap was hit. A truncated detail list therefore never implies a truncated total.

CSV and Excel exports carry **raw numbers**: balances and rates as plain decimals, durations as minutes, percentages as fractions, each money row tagged with a `currency_code` column. A spreadsheet can sum them; a formatted string could not.
```

- [ ] **Step 3: Update the aside about evidence types**

The existing `<Aside type="note">` (`:41`) opens "The four evidence-review report types above…". Three non-evidence rows now sit under it, so re-anchor its first sentence: "The four evidence-review report types — `identity_access_review`, `vulnerability_management`, `endpoint_management_review` and `threat_detection_review` — are built from previously synced data only…". The rest of the aside is unchanged. The three business types are covered by their own section instead; add one sentence to the end of the aside: "The three business report types below read only Breeze's own ticket, time and invoice data and depend on no integration."

- [ ] **Step 4: Build the docs**

Run: `cd apps/docs && npx astro check && npx astro build`
Expected: no errors; page count unchanged (the section is inside an existing page).

- [ ] **Step 5: Write the CHANGELOG entry**

Under `## [Unreleased]`, in an `### Added` block (create it if absent — the current `[Unreleased]` carries `Removed`, `Security` and `Critical for self-hosters upgrading to this release`):

```markdown
### Added
- Three business report types under **Reports → Templates → Business**: **Ticket SLA attainment** (response and resolution attainment, recalculated from each ticket's own timestamps so a late-but-answered ticket still counts as a miss), **Technician time & billability** (utilisation against an assumed weekly capacity, the billable / included / non-billable split, and how much billable time has actually been billed), and **AR aging** (unpaid balances bucketed current / 1–30 / 31–60 / 61–90 / 90+ days past due, one set of totals per currency, no conversion). Each can be owned by one organization or by the partner — a partner-owned report covers every organization the MSP manages, resolved live at each run, and requires a partner login with access to all organizations. All three are internal: they never appear in a customer portal. Both approximations are printed on the report itself (paused time is a lifetime total, so post-response pauses flatter response attainment; capacity is uniform, so PTO and part-time are not modelled). No new environment variables; no action needed by self-hosters (#3198).
```

- [ ] **Step 6: Draft the marketing release note for the PR body**

The `update-breeze-release-notes` skill writes to `src/content/releases/YYYY-MM-DD-vX-Y-Z.md` in the **marketing website repo**, which is not in this tree, and sources content from merged PRs at release time. Put the ready-to-lift block in the PR description under a `### Release note (for the next cut)` heading, in the skill's schema, user-facing language, no internal names:

```yaml
added:
  - "Three business reports: Ticket SLA attainment, Technician time & billability, and AR aging — create them from Reports → Templates → Business."
  - "Business reports can cover one customer or every customer you manage in a single report, with the customer list resolved fresh on each run."
improved:
  - "Business report exports carry plain numbers and a currency column, so a spreadsheet can total them."
```

- [ ] **Step 7: Commit**

```bash
git add apps/docs/src/content/docs/features/reports.mdx CHANGELOG.md
git commit -m "docs(reports): business report types, ownership and the approximations they disclose (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: One Playwright spec — a partner-owned AR aging report, end to end

**Files:**
- Create: `e2e-tests/pages/ReportsPage.ts`, `e2e-tests/tests/business-reports.spec.ts`

Every selector is a `data-testid` (`e2e-tests/README.md`: "no text, role, label, or CSS selectors — a hard rule"). Every testid this spec uses was added by Tasks 2, 4 and 5 or already exists (`report-generate-<id>`, `report-open-latest-<id>`, `scope-badge`).

- [ ] **Step 1: Write the page object**

`e2e-tests/pages/ReportsPage.ts`:

```ts
import { BasePage } from './BasePage';

export class ReportsPage extends BasePage {
  url = '/reports';
  templatesUrl = '/reports/templates';

  // Templates gallery
  templatesHeading = () => this.page.getByTestId('reports-templates-heading');
  businessGroup = () => this.page.getByTestId('report-template-group-business');
  templateCard = (id: string) => this.page.getByTestId(`report-template-card-${id}`);
  useTemplate = (id: string) => this.page.getByTestId(`report-template-use-${id}`);

  // Owner scope (partner-scope logins only)
  ownerScope = () => this.page.getByTestId('report-owner-scope');
  ownerScopePartner = () => this.page.getByTestId('report-owner-scope-partner');

  // AR aging options form
  arAgingGroupBy = () => this.page.getByTestId('ar-aging-group-by');
  arAgingCreate = () => this.page.getByTestId('ar-aging-create-report');

  // Reports list
  reportRow = (id: string) => this.page.getByTestId(`report-row-${id}`);
  generate = (id: string) => this.page.getByTestId(`report-generate-${id}`);
  openLatest = (id: string) => this.page.getByTestId(`report-open-latest-${id}`);

  async gotoTemplates() {
    await this.page.goto(this.templatesUrl);
    await this.templatesHeading().waitFor();
  }

  async gotoList() {
    await this.page.goto(this.url);
  }
}
```

- [ ] **Step 2: Write the spec**

`e2e-tests/tests/business-reports.spec.ts`:

```ts
import { test, expect } from '../fixtures';
import { ReportsPage } from '../pages/ReportsPage';

// The seeded admin is a partner-scope login with access to all organizations
// (global-setup logs in as BREEZE_BOOTSTRAP_ADMIN_EMAIL), which is exactly the
// authority a partner-owned report requires — org_access = 'all'. If the owner
// scope selector is absent, the login is org-scoped and the run is invalid;
// the spec asserts its presence rather than skipping past it.
test.describe('Business reports — partner-owned AR aging', () => {
  test('create from the Business template, generate, and open the run', async ({ authedPage }) => {
    const reports = new ReportsPage(authedPage);
    await reports.gotoTemplates();

    // 1. The Business group exists and carries the AR aging card.
    await expect(reports.businessGroup()).toBeVisible();
    await expect(reports.templateCard('ar_aging')).toBeVisible();

    // 2. Its options form opens — NOT the freeform builder.
    await reports.useTemplate('ar_aging').click();
    await expect(reports.arAgingCreate()).toBeVisible();

    // 3. Choose partner-wide ownership and the currency axis.
    await expect(reports.ownerScope()).toBeVisible();
    await reports.ownerScopePartner().click();
    await reports.arAgingGroupBy().selectOption('currency');

    // 4. Create. The page redirects to the reports list on success.
    await reports.arAgingCreate().click();
    await authedPage.waitForURL('**/reports');

    // 5. The new row carries the partner-wide badge — the one visual difference
    //    between "this customer" and "every customer" in the list.
    const row = authedPage.locator('[data-testid^="report-row-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('scope-badge')).toBeVisible();

    const reportId = (await row.getAttribute('data-testid'))!.replace('report-row-', '');

    // 6. Generate it. A partner-owned generate exercises the whole W01 path:
    //    partner authority resolution, the live organization fan-out, and the
    //    partner branch of the report_runs RLS policy.
    await reports.generate(reportId).click();

    // 7. The run completes and can be opened. `report-open-latest-<id>` resolves
    //    the newest completed run, so its enabled state is the completion signal.
    const open = reports.openLatest(reportId);
    await expect(open).toBeEnabled({ timeout: 60_000 });
    await open.click();

    // 8. A PDF download is what "open" produces for a completed run.
    const download = await authedPage.waitForEvent('download', { timeout: 30_000 });
    expect(download.suggestedFilename()).toContain('ar_aging');
  });
});
```

- [ ] **Step 3: Run it against a live stack**

```bash
pnpm wt-stack up          # this worktree's own pg+redis+api+web+portal
cd e2e-tests && pnpm test tests/business-reports.spec.ts
```
Expected: PASS. "Don't merge a spec that hasn't been verified against a running stack" (`e2e-tests/README.md` step 5).

Two known stack traps: `MFA_FORCE_FOR_PARTNER_ADMIN` must be `false` or `global-setup` lands on `/auth/mfa/setup` and every spec fails before it starts — `pnpm wt-stack up` pins it. And if step 7 times out with the run stuck `pending`, the BullMQ worker is not registered in this stack; check `/ready` before blaming the spec.

- [ ] **Step 4: Tear the stack down**

```bash
pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing reaps a local stack; leave the engine clean.

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/pages/ReportsPage.ts e2e-tests/tests/business-reports.spec.ts
git commit -m "test(e2e): partner-owned AR aging report from template to run (#3198 W03)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Full typecheck, the whole reports suite, and the PR

**Files:** none created; this task is the gate.

- [ ] **Step 1: Typecheck every package this wave touched**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
cd apps/portal && npx tsc --noEmit -p tsconfig.json
cd packages/shared && npx tsc --noEmit -p tsconfig.json
```
Expected: clean. There is no root `typecheck` script — it runs via turbo/CI only.

- [ ] **Step 2: Run every touched web suite, by explicit path**

```bash
cd apps/web && npx vitest run \
  src/components/reports/reportTypeSurvivesBuilder.test.ts \
  src/components/reports/ReportBuilder.test.tsx \
  src/components/reports/ReportTemplates.business.test.tsx \
  src/components/reports/ReportTemplates.savedReportMerge.test.tsx \
  src/components/reports/ReportTemplates.identityAccess.test.tsx \
  src/components/reports/ReportTemplates.posture.test.tsx \
  src/components/reports/ReportTemplates.hardwareLifecycle.test.tsx \
  src/components/reports/ReportTemplates.threatDetection.test.tsx \
  src/components/reports/ReportTemplates.endpointManagement.test.tsx \
  src/components/reports/ReportTemplates.vulnerabilityManagement.test.tsx \
  src/components/reports/ReportPeriodField.test.tsx \
  src/components/reports/TicketSlaOptionsForm.test.tsx \
  src/components/reports/TechnicianTimeOptionsForm.test.tsx \
  src/components/reports/ArAgingOptionsForm.test.tsx \
  src/components/reports/ReportOwnerScopeField.test.tsx \
  src/components/reports/ReportPreview.business.test.tsx \
  src/components/reports/ReportPreview.threatDetection.test.tsx \
  src/components/reports/ReportEditPage.posture.test.tsx \
  src/components/reports/ReportsList.generate.test.tsx \
  src/components/reports/ReportsList.download.test.tsx \
  src/components/reports/ReportsList.schedule.test.tsx \
  src/components/reports/ReportsList.templates.test.tsx \
  src/components/reports/ReportsList.aiFleetDesign.test.tsx \
  src/components/reports/ReportsList.aiNarrative.test.tsx \
  src/components/reports/businessReportRows.test.ts \
  src/components/reports/reportExport.business.test.tsx \
  src/components/reports/reportExport.posture.test.tsx \
  src/components/reports/reportExport.endpointManagement.test.tsx \
  src/components/reports/reportExport.threatDetection.test.tsx \
  src/components/reports/reportExport.vulnerabilityManagement.test.tsx \
  src/components/reports/reportExport.test.ts \
  src/components/reports/reportsPtBR.test.ts \
  src/components/reports/noHardcodedComplianceReports.test.ts \
  src/components/billing/BillablesExportCard.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/
```

Paths are listed **explicitly**, not as a `src/components/reports/` prefix: vitest's filter is a plain substring match, and a directory-shaped filter silently skips nothing here but a prefix like `src/components/reports/Report` would quietly drop `businessReportRows.test.ts` and `reportExport*`. Check the reported file count — it must be 36.

Expected: all PASS.

- [ ] **Step 3: Run the portal and shared suites**

```bash
cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx
cd packages/shared && npx vitest run src/types/portalVisibility.test.ts src/reportPdf/
```
Expected: PASS. The `reportPdf/` run is a regression check on W02's modules — this wave changed no renderer code, so any red there is a merge problem, not a W03 defect.

- [ ] **Step 4: Lint**

```bash
pnpm lint
```
Expected: clean.

- [ ] **Step 5: Open the PR**

Branch `feature/3198-business-reports/wave-<W03 sub-issue>` (per `feature-lifecycle`; `get_feature_status` first, then `start_wave`). Target `main`. Body:

```markdown
## W03 — the three business reports, in front of a human

Closes #<W03 sub-issue> (wave W03 of #3198).

Plan: `docs/superpowers/plans/reports/2026-09-21-business-reports-w03-web-docs.md`
Spec: `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` §3.3, §3.4, §3.5, §7

W01 gave `reports` a partner owner and a `partner_wide` execution authority; W02
gave the registry three generators, three PDF modules and a money formatter.
Nothing yet let anyone create one. This wave does: a **Business** group in the
templates gallery with three curated cards, an options form per type, the
create-only `ownerScope` selector, the summary blocks, raw-numeric exports,
eight locales, docs, and one Playwright spec that creates a partner-owned AR
aging report and opens its run.

### The two places a mistake here would matter

1. **The `ownerScope` gate is the JWT scope claim, reactively read.** An
   organization token carries a `partnerId` it can never use, and on a cold load
   there is no token at all for up to 90 seconds. The selector uses
   `useJwtClaims()` and fails **closed** while unresolved — unknown is not
   partner (#4010's exact conflation). The partner id is never sent by the
   client; `ownerScope` is the only ownership input, and the server derives the
   rest from `auth.partnerId`.
2. **A partner-owned report cannot hold contact recipients**, because
   `report_schedule_recipients` keys on `(report_id, org_id)`. The builder now
   skips the contacts fetch entirely for one and renders the free-text email
   list with an explanation, instead of offering a picker whose every click can
   only 409.

### The silent failure this closes before it ships

`buildReportPdf`'s final `else` renders a plain row table and drops the entire
designed summary. For a business report that means the numbers survive and every
disclosed approximation printed beside them disappears. The summary type union in
`reportExport.ts` and at the `ReportsList` download call site is what makes the
designed arm reachable — the same fix #5784 W03, W04 and W06 each had to make by
hand, done here in the same PR as the types themselves.

### Honesty, rendered

Both approximations the spec accepted are on screen before the report is created
and in the run's own footnotes afterwards: paused time is a lifetime total, so
post-response pauses flatter response attainment; capacity is uniform, so PTO and
part-time are not modelled. The recomputed-vs-stamped breach gap is published as
a count rather than reconciled away, so the report can be squared against the SLA
badges in the ticket list. Truncation says *detail rows* were capped and that the
totals were not.

### Never portal-visible

The three types are absent from `PORTAL_REPORT_TYPES`, from `PortalRunDto['type']`
and from the portal's generatable union — and `ReportRunList` now filters them out
even if a row reaches it, with a type-level assertion in `@breeze/shared` that
ratchets the union shut.

### Release note (for the next cut)

<the `added:` / `improved:` block from Task 10 Step 6>

### Verification

- 36 web test files, `apps/portal` `ReportRunList`, `@breeze/shared`
  `portalVisibility` + `reportPdf`: all green.
- `tsc --noEmit` clean in `apps/web`, `apps/portal`, `packages/shared`.
- `astro check && astro build` clean in `apps/docs`.
- `e2e-tests/tests/business-reports.spec.ts` verified against a live
  `pnpm wt-stack` stack (partner-owned create → generate → run download).
- No migration, no RLS change, no cascade or export-policy registration — this
  wave adds no table and no column.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 6: Watch CI, then enqueue**

`gh pr checks` must show `CI Success` green on the PR's own head before `gh pr merge <N>` (no strategy flag, no `--admin` — the queue owns the strategy and re-runs the full suite on the merge ref). This PR targets `main`, so the integration shards already ran; do **not** hand-dispatch CI for it.

---

## Self-Review

**1. Spec coverage.**

| Spec requirement | Task |
|---|---|
| §3.3 three types surfaced with their options (period, group-by, capacity, as-of) | 2, 3 |
| §3.3 R1 disclosed approximations (pause attribution, "current assignee") | 3 (form), 5 (footnotes), 10 (docs) |
| §3.3 R2 uniform-capacity disclosure, zero-time technicians, per-currency value | 3, 5, 10 |
| §3.3 R3 as-of = run time, no-due-date bucket distinct, per-currency, no FX | 3, 5, 10 |
| §3.2 / §4 aggregates uncapped, detail rows capped, truncation surfaced | 5 |
| §3.4 CSV/XLSX raw numerics + `currency_code`, never formatted | 6 |
| §3.5 builder-opaque, curated templates, "Business" group | 1, 2 |
| §3.5 never portal-visible, never self-service | 9 |
| §2 / 2026-07-01 §6 `ownerScope` create-only, JWT-scope gate, "All organizations" badge | 4 |
| §3.1a partner-owned reports cannot hold contact recipients | 4 |
| §7 Settings billables card gains a link and is not removed | 8 |
| §10 eight locales, docs, release notes | 7, 10 |
| §10 one end-to-end proof | 11 |

No spec requirement in W03's row of the wave split is unassigned.

**2. Placeholder scan.** No "TBD", no "similar to Task N", no "add tests". Task 3's second and third forms are described as deltas from the first *with every distinct symbol, testid and bound written out* rather than repeated verbatim — the shared four-export contract is stated in the Interfaces block, and the three tests that pin them are written in full. Task 7's seven non-English catalogs are the one place the plan hands over prose rather than literals; the key list, the interpolation tokens and an eleven-term domain glossary across all seven locales are all pinned, which is what the parity and terminology suites actually check.

**3. Type consistency.** `ReportOwnerScope` is spelled the same in Task 4's component, `ReportTemplates`'s state and `handleCreateDirect`'s parameter. `ticketSlaConfigFromOptions` / `technicianTimeConfigFromOptions` / `arAgingConfigFromOptions` are named identically in Task 3 (definition), Task 3 Step 11 (templates), Task 3 Step 12 (edit page) and Task 6's sibling shaper. `businessReportExportRows` is the same name in Task 6's three files. `BusinessSummaryTail` is defined once and used by all three arms. The summary field names in Task 5's tests match the Consumed-contracts block field for field.
