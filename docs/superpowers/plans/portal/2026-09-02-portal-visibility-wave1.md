---
tracking_issue: LanternOps/breeze#4562
---

# Customer Portal Visibility — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the org security score, per-device protection, patching, backup verification, ticket SLA, support usage and self-service reports into the customer portal (`apps/portal`), behind five fail-closed `portal_branding` toggles, using only data Breeze already collects.

**Architecture:** Thin Hono routes under `/api/v1/portal/*` call pure read-model functions in `apps/api/src/services/portal/` that run inside the portal session's existing org-scoped RLS transaction. Exactly two aggregators (`supportUsageForOrg`, `vulnerabilitySeverityForFindings`) exit to a system context with a server-derived org id because their tables are partner-axis or system-only. Report self-service reuses the existing report engine and shared jsPDF renderer server-side; scheduled recipients move to a new org-scoped `report_schedule_recipients` table. Portal pages keep the repo pattern: Astro page SSR-fetches through `portalApi`, React component renders props.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL forced RLS (`breeze_app`), Zod, Vitest (unit + integration configs), Astro + React islands (portal has no i18n and no charting dependency — inline SVG only), Playwright (`data-testid` only), `@breeze/shared/reportPdf` (jsPDF).

**Spec:** `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md` — read §2 (decisions), §4 (tenancy), §7 (read-model definitions) and §8 (reports) before any task.

**Tracking:** roadmap item LanternOps/breeze#4562 (promoted to a feature with one sub-issue per wave below). Branch per wave: `feature/4562-portal-visibility/wave-<subissue#>`; PR body must contain `Closes #<subissue>`.

## Global Constraints

- **Tenancy:** ordinary reads run in the ambient portal org transaction (`portalAuthMiddleware` sets `scope: 'organization'`, `accessibleOrgIds: [orgId]`, `accessiblePartnerIds: []`, `userId: null`). `breeze_has_org_access` is never widened. Only `supportUsageForOrg` and `vulnerabilitySeverityForFindings` use `runOutsideDbContext` + `withSystemDbAccessContext`, and both take the org id from the session, never from request input.
- **Every new portal read-model function has a unit test asserting the compiled SQL contains the org predicate** (`security_status.org_id = $1` style or the join to `devices.org_id`). A test that only checks the mocked return value is vacuous.
- **Fail closed:** new feature gates return 403 when the `portal_branding` row is missing or the flag is `false`. Defaults are `false` for every existing org (spec decision 1).
- **Never invent zeros:** every tile returns `{ status: TileStatus, ... }` with `status ∈ 'ok' | 'no_data' | 'not_configured' | 'stale'`; a missing source yields `null` values and a non-`ok` status.
- **Org timezone** for month/day boundaries: org → partner → `'UTC'`, via `resolveOrgTimezone` (wrapping the schedule worker's `timezoneFor` logic and the shared `resolveEffectiveTimezone` / `canonicalizeTimezone` helpers). It is resolved **once per request inside `portalAuthMiddleware`'s existing system-context hydration** and exposed as `auth.timezone`; read models take `timezone` as a parameter and never resolve it themselves. Responses that depend on it include `timezone`.
- **Score band strings** in DTOs are lowercase: `'strong' | 'good' | 'fair' | 'at_risk'`.
- **Route modules and mounts** are created once in W03 (`portalDashboardRoutes`, `portalSecurityRoutes`, `portalBackupRoutes`, `portalReportRoutes`), each mounted with `portalAuthMiddleware` **and** its strict gate in `routes/portal/index.ts`. Later waves add handlers to those modules and never re-mount.
- **Protection rule** (`classifyDeviceProtection`) is a faithful extraction of the posture report's rule; `'unknown'` (no fresh `security_status` and no managed EDR agent) maps to the report's existing unprotected bucket so report output is unchanged, proven by a parity test.
- **Score bands:** STRONG ≥ 80, GOOD ≥ 60, FAIR ≥ 40, AT RISK < 40, shared with `packages/shared/src/reportPdf`.
- **Ticket scope:** aggregates (counts, minutes) are org-wide; ticket titles are exposed only for tickets submitted by the current portal user; the ticket list query is unchanged.
- **Migrations:** names must sort after the newest committed migration at PR time (as of 2026-09-02: `2026-09-27-technician-ticket-write-permissions.sql`, so `2026-09-28-…` or later; never the closed `2026-08-06` block). Idempotent; no inner `BEGIN;`/`COMMIT;`; `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO breeze_app;` for every new table; policies in the same file as the table.
- **Registration in the same PR as the schema change:** `report_schedule_recipients` → `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`, `localeCompare` order, before `reports` and `contacts` because it references both) and `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`); new columns on `portal_branding` and `reports` → `CORE_TENANT_EXPORT_POLICY` (`included`); `report_runs` is not an `org_id` table (no entry). Shape-1 tables need no RLS allowlist entry.
- **Reports self-service:** allowlist is exactly `security_compliance_posture` and `executive_summary`; only runs whose parent report has `portal_self_service = true` are listed; generation is synchronous, 5 runs per org per hour, one in flight per type; portal runs store `requested_by_kind = 'portal_user'` and an execution authority `{ principalKind: 'portal_user', scope: { kind: 'unrestricted', orgId } }`.
- **Web (apps/web) mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); every user-visible string added to `apps/web` gets a key in **every** `apps/web/src/locales/*/` file (the tr-TR parity test fails otherwise). The portal has no i18n; strings are English.
- **Tests:** run one file with `cd apps/api && npx vitest run <path>` (never `pnpm test -- --run`); integration suites with `-c vitest.integration.config.ts` against a live DB; Playwright specs select by `data-testid` only.
- **Commits:** one per task step as written; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` on every commit.

## File Structure

New, by responsibility:

| Path | Responsibility |
|---|---|
| `packages/shared/src/types/portalVisibility.ts` | DTO types shared by API and portal: `TileStatus`, `DashboardDto`, `SecurityOverviewDto`, `SecurityDeviceRow`, `BackupOverviewDto`, `BackupDeviceRow`, `SupportUsageDto`, `SlaDto`, `PortalRunDto`, `EnrichedPortalDevice` |
| `apps/api/src/services/portal/protection.ts` | `classifyDeviceProtection` — the single protected/unprotected/unknown rule, extracted from the posture report |
| `apps/api/src/services/portal/timezone.ts` | `resolveOrgTimezone` |
| `apps/api/src/services/portal/supportUsage.ts` | `supportUsageForOrg` (system context, grouped minutes only) |
| `apps/api/src/services/portal/vulnerabilityCatalog.ts` | `vulnerabilitySeverityForFindings` (system context, catalog lookup by id) |
| `apps/api/src/services/portal/securityReadModel.ts` | score tile, protected tile, security overview, security device page |
| `apps/api/src/services/portal/patchReadModel.ts` | patches-applied tile |
| `apps/api/src/services/portal/backupReadModel.ts` | backup tile, overview, device page |
| `apps/api/src/services/portal/ticketReadModel.ts` | support tile, `ticketSla` |
| `apps/api/src/services/portal/actionItemsReadModel.ts` | action-items tile |
| `apps/api/src/services/portal/dashboard.ts` | `dashboardForOrg` (parallel tiles) |
| `apps/api/src/services/portal/deviceReadModel.ts` | enriched device projection + CSV row iterator |
| `apps/api/src/services/portal/reportsSelfService.ts` | canonical definitions, list/generate/render, limiter |
| `apps/api/src/routes/portal/{dashboard,security,backups,reports}.ts` | thin routes + zod query schemas |
| `apps/api/src/db/schema/reportScheduleRecipients.ts` | Drizzle table for contact-bound recipients |
| `apps/api/migrations/2026-09-28-a-portal-visibility-indexes.sql` | W02 indexes |
| `apps/api/migrations/2026-09-28-b-portal-visibility-flags.sql` | W03 five `portal_branding` columns |
| `apps/api/migrations/2026-09-28-c-portal-report-self-service.sql` | W09 `reports.portal_self_service`, run provenance, recipients table + RLS |
| `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts` | cross-org proof under a portal-shaped context |
| `apps/portal/src/pages/{dashboard,security,backups,reports}/index.astro` | SSR fetch + redirect-on-401, render component |
| `apps/portal/src/components/portal/{DashboardTiles,SecurityOverview,SecurityDeviceTable,BackupOverview,BackupDeviceTable,ReportRunList,SupportUsagePanel,Sparkline,WeeklyBars}.tsx` | presentational components, `data-testid` on every tile/row/action |
| `e2e-tests/tests/portal-visibility.spec.ts` | dashboard, report generation, nav gating |

Modified: `apps/api/src/routes/portal/{featureFlags,index,tickets,devices,branding}.ts`, `apps/api/src/db/schema/{portal,reports}.ts`, `apps/api/src/services/{securityComplianceReport,siteScope,invoiceService,tenantExportPolicyRegistry,tenantCascade}.ts`, `apps/api/src/jobs/reportScheduleWorker.ts`, `apps/api/src/routes/orgPortalSettings.ts`, `apps/api/src/routes/reports/*`, `apps/portal/src/lib/{api,navItems}.ts`, `apps/portal/src/pages/index.astro`, `apps/portal/src/middleware.ts`, `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`, `apps/web/src/components/reports/{ReportTemplates,…}.tsx`, `apps/web/src/components/software/{SoftwareComplianceReport.tsx,index.ts}`, `apps/web/src/locales/*/`.

## Waves and dependency order

| Wave | Deliverable | Depends on | Migration |
|---|---|---|---|
| W01 | Trust hazards removed (template cards, mock compliance components) | — | none |
| W02 | Read-model foundation, two system-context aggregators, DTO types, RLS integration test, indexes | — | `…-a-…-indexes.sql` |
| W03 | Five toggles, fail-closed gates, mounts, nav (incl. Devices fix), landing, settings editor | W02 | `…-b-…-flags.sql` |
| W04 | Dashboard API + page | W03 | none |
| W05 | Security overview/devices API + page | W03 | none |
| W06 | Backups overview/devices API + page | W03 | none |
| W07 | Devices enrichment + CSV export | W03 | none |
| W08 | Ticket `sla`, support usage, invoice `ticketNumber` | W03 | none |
| W09 | Reports foundation: marker, provenance, `portal_user` authority, recipients table, worker union, builder recipients, provisioning on flag enable | W03 | `…-c-…-self-service.sql` |
| W10 | Portal reports API + Reports tab + badge + integration/e2e | W09 | none |

W04–W08 are independent of each other and may run in parallel once W03 has merged.

---

## Task documents

The step-by-step tasks live in three part files (one executor reads the part for their wave):

- **Part A — W01–W03:** `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1-part-a.md`
- **Part B — W04–W08:** `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1-part-b.md`
- **Part C — W09–W10:** `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1-part-c.md`

Each task's **Interfaces** block names the exact functions it consumes from earlier waves and produces for later ones; the names match the File Structure table above.
