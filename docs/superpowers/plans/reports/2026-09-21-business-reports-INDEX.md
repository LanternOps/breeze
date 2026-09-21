---
tracking_issue: LanternOps/breeze#3198
---

# Business Reports (PSA) Implementation Plan — Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec and this index before executing a wave; each wave has its own plan file below.

**Goal:** Give MSP owners three business reports on the existing reports engine — ticket SLA attainment, technician time and billability, and AR aging — at partner scope first (all my clients, grouped by org), with org scope as the drill-down; scheduled, emailed, branded PDF and CSV like every other report.

**Architecture:** Three waves, three PRs. W01 lands the partner-scope foundation the spec makes a hard prerequisite (`reports` becomes org XOR partner; a `partner_wide` execution-scope kind with live `org_access = 'all'` reauthorization; routes and worker branch on the owner axis). W02 replaces the generation `switch` with a declarative per-type registry that composes with the existing managed-evidence registry, adds the three generators and their PDF modules, and the one shared money-formatting helper. W03 exposes them as builder-opaque templates with options forms, the ownerScope selector, locales, docs and release notes. Nothing touches `/analytics`; nothing is portal-visible.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, Astro + React 19 islands + react-i18next, jsPDF/autoTable renderer in `@breeze/shared`, Vitest (unit, RLS-coverage, integration) + Playwright, the tenancy contract in `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` — approved 2026-09-02 (Gate A), refreshed against `main` on 2026-09-21 (§0 drift table, §3.1a partner authority, §11 quorum record). The 2026-07-01 partner-reports design (`docs/superpowers/plans/open/2026-07-01-partner-level-reports-design.md`) is the reference for the foundation; where it and the spec disagree, the spec wins.

## Global constraints

- **Every approved decision stands** (spec §9: foundation-first; SLA recomputed from timestamps + disclosed; utilization capacity is a config parameter; per-currency rows, no FX; template-only, builder untouched; Phase 1 trio = SLA + time/billability + AR). Do not reopen them in a PR.
- **Partner-owned reports are partner-private.** Org tokens, portal users and `selected`-access partner users never see them. `reports` is in `DUAL_AXIS_TENANT_TABLES` only and is named in the `XOR_OWNERSHIP_DUAL_AXIS_TABLES` exclusion; it must never gain a `breeze_current_partner_id()` SELECT branch. The `org_access = 'all'` gate has no DB backstop, so it is mechanical: `partnerOwnedReportVisibility(auth)` + a source-scan test (W01).
- **`partner_id` always comes from the token.** `ownerScope` is the only client input, create-only; ownership is immutable.
- **Money is `numeric` strings; never sum across currencies.** Every money aggregate is grouped by `currency_code`; CSV/XLSX emit raw numerics plus a currency column; PDF formats with `Intl.NumberFormat` through the shared `moneyFormat.ts`.
- **Partner-scope generators run under `runOutsideDbContext(() => withSystemDbAccessContext(...))` with explicit `partner_id = $1` (and org allowlist where the table is org-axis) in every query** (spec §3.2). Aggregates always cover all accessible orgs; only stored detail rows are capped (5,000, truncation surfaced in the summary).
- **Disclosed approximations are printed, not hidden**: SLA pause attribution (lifetime `sla_paused_minutes`), uniform 40h capacity, "current assignee" for the technician axis, recomputed-vs-stamped breach discrepancy count.
- **Registry migration is complete or not at all** (W02): all thirteen existing `switch` arms move into `REPORT_GENERATORS` in one PR; per-type config schemas stay loose; `supportedScopes` is checked before the preflight.
- **Migration naming:** `YYYY-MM-DD-HHMMSS-<slug>.sql`, sorting after the newest shipped file at commit time (`2026-10-26-100000` / `-100100` as written; bump both if `main` has moved past them). Enum labels in their own file. No `BEGIN`/`COMMIT`; no row writes in this feature's migrations.
- **Tests:** `cd apps/api && npx vitest run <path>` for units; `pnpm test-stack up` then the RLS-coverage (`DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`) and integration suites for anything touching tenancy; `pnpm test-stack down` after. Web: `cd apps/web && npx vitest run <path>`. E2E selectors are `data-testid` only.
- **Type ids are fixed:** `ticket_sla_attainment`, `technician_time_billability`, `ar_aging`. Cross-wave names (`ReportOwner`, `partner_wide`, `ReportScope`, `ReportTypeDef`, `REPORT_GENERATORS`, `REPORT_TYPES`, `moneyFormat`, the three `*Pdf.ts` modules, the three options forms) are spelled identically in every plan; a mismatch is a bug in the plan, not a choice.

## Three waves and tracking

| Lifecycle key | Wave and plan | Hard prerequisites | Deployable result |
| --- | --- | --- | --- |
| W01 | [Partner-scope reports foundation](2026-09-21-business-reports-w01-partner-scope-foundation.md) | Approved spec + 2026-09-21 quorum | `reports` org XOR partner with dual-axis RLS; `partner_wide` authority; `ownerScope` on create; worker runs partner-owned definitions. Three enum labels exist with no generator — generating one answers `unsupported_report_scope`. Existing org-owned reports byte-for-byte unchanged. |
| W02 | [Registry map, three generators, PDF modules](2026-09-21-business-reports-w02-registry-generators.md) | W01 merged | `REPORT_GENERATORS` registry (all 13 existing types migrated), `ReportScope`, R1/R2/R3 generators with unit + integration proofs, `moneyFormat.ts`, three PDF modules. API-complete; no template exposes the types yet. |
| W03 | [Web templates, options forms, locales, docs](2026-09-21-business-reports-w03-web-docs.md) | W02 merged | "Business" template group, three options forms, ownerScope selector + "All organizations" badge, CSV/XLSX numerics, 8 locales, docs page, release note, E2E. Feature visible to users. |

`promote_to_feature` converts roadmap item #3198 into the feature record with these three waves on 2026-09-21. At registration all waves are open and nothing is implemented; `get_feature_status` is authoritative for execution status. `next_wave` is ordering, not proof that a prerequisite merged — check the PR. A wave stays open until every task and gate in its plan is done; intermediate PRs use `Refs`, the completing PR uses `Closes`.

## File and ownership map

| Wave | New code domains | Existing seams touched |
| --- | --- | --- |
| W01 | `migrations/2026-10-26-100000-report-type-business.sql`, `…-100100-reports-partner-ownership.sql`; `services/siteScope.ts` (`partner_wide`, `ReportOwner`, partner authority); `routes/reports/helpers.ts` (`partnerOwnedReportVisibility`, owner-aware helpers) + `partnerOwnedVisibility.scan.test.ts`; `services/reportBranding.ts` (`loadReportBrandingForPartner`); `__tests__/integration/reportsPartnerRls.integration.test.ts`, `reportsPartnerOwned.integration.test.ts` | `db/schema/reports.ts`; `routes/reports/{schemas,core,generate,runs,recipients}.ts`; `jobs/reportScheduleWorker.ts`; `services/reportGenerationService.ts` (preflight owner axis, `UnsupportedReportScopeError`); `rls-coverage.integration.test.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `tenantCascade.ts`; `siteScope.projections.test.ts` |
| W02 | `packages/shared/src/reportTypes.ts`; `services/reportScope.ts`, `services/reportRegistry.ts`; `services/businessReports/{period,ticketSlaReport,technicianTimeReport,arAgingReport}.ts`; `packages/shared/src/types/businessReports.ts`; `packages/shared/src/reportPdf/{moneyFormat,ticketSlaPdf,technicianTimePdf,arAgingPdf}.ts` | `services/reportGenerationService.ts` (dispatch → registry), `routes/reports/schemas.ts` (config lookup, `PARTNER_SCOPE_REPORT_TYPES` retired), `routes/reports/{generate,runs}.ts` (`ReportScope`), `packages/shared/src/reportPdf/reportPdf.ts` (three arms, `BuildOpts.summary`), `db/schema/invoices.ts` (`sqlOpenForOverdue` exported), `managedEvidenceRegistry` parity test |
| W03 | `apps/web/src/components/reports/{TicketSlaOptionsForm,TechnicianTimeOptionsForm,ArAgingOptionsForm,ReportPeriodField}.tsx`; `e2e-tests/tests/business-reports.spec.ts`; docs page | `ReportTemplates.tsx`, `ReportBuilder.tsx`, `ReportEditPage.tsx`, `ReportPreview.tsx`, `ReportsList.tsx`, `reportExport.ts`, 8 × `reports.json`, `BillablesExportCard.tsx`, portal `ReportRunList.tsx` (negative test), release-notes data |

Waves are strictly serial: W02's registry edits the same dispatcher and schema files W01 touches, and W03's web types derive from W02's shared tuple. Do not start a wave on a sibling branch; base each on `main` after the previous wave merges.

## Cross-wave contracts (canonical spellings)

```ts
// W01 — apps/api/src/services/siteScope.ts
type SiteScopeV1 = … | { version: 1; kind: 'partner_wide'; partnerId: string };
type ReportOwner = { orgId: string; partnerId?: undefined } | { partnerId: string; orgId?: undefined };
function reportOwnerOf(row: { orgId: string | null; partnerId: string | null }): ReportOwner;
function decodeSiteScope(row: PersistedSiteScopeColumns, owner: string | ReportOwner): SiteScopeV1;
function resolveLivePartnerReportAuthority(userId, partnerId, action): Promise<LiveReportAuthorityResult>;
function resolveRequestPartnerReportAuthority(auth, partnerId, action): Promise<LiveReportAuthorityResult>;
// W01 — apps/api/src/routes/reports/helpers.ts
function partnerOwnedReportVisibility(auth): SQL;
function getReportWithOwnerCheck(reportId, auth);      // returns row + { owner }
function getReportRunWithOwnerCheck(runId, auth, action);
// W01 — apps/api/src/services/reportGenerationService.ts
class UnsupportedReportScopeError extends Error {}
function assertReportExecutionPreflight(owner: ReportOwner, config, authority): void;

// W02 — apps/api/src/services/reportScope.ts
type ReportScope = { kind: 'organization'; orgId: string } | { kind: 'partner'; partnerId: string; orgIds: string[] };
function reportScopeFromAuthority(owner: ReportOwner, authority: ReportGenerationAuthority): Promise<ReportScope>;
// W02 — apps/api/src/services/reportRegistry.ts
interface ReportTypeDef<C, S> { type; label; configSchema: ZodType<C> /* loose */; supportedScopes; execution: 'user' | 'managed_evidence'; requiredPermissions; detailRowCap; generate(scope, config, authority, evidence?) }
const REPORT_GENERATORS: Readonly<Record<ReportType, ReportTypeDef>>;
// W02 — packages/shared/src/reportTypes.ts
const REPORT_TYPES = [/* 13 existing in enum order */, 'ticket_sla_attainment', 'technician_time_billability', 'ar_aging'] as const;
// W02 — packages/shared/src/reportPdf/moneyFormat.ts
function formatMoney(value: string | number, currencyCode: string, locale?: string): string;
function formatPercent(value: number, digits?: number): string;
function formatMinutes(minutes: number): string;
```

## Follow-ups filed outside this feature (spec §7, §10)

- QueryBuilder dead metric options (12 of 16 have no `metricColumnMap` entry) — separate bug issue.
- Phase 2 reports: MRR / renewals (needs per-device/per-seat quantity resolution), quote win rate, ticket volume/backlog trend.
- Per-target immutable SLA outcome stamping (the accuracy fix if R1's disclosed approximation is disputed).
- Per-org `cost_basis` schema gap (client profitability).
- Billing profiles W04 (#4628) may add report/CSV dimensions on `listBillables`; R2 already consumes `work_type_id` / `coverage` directly and does not depend on it.
